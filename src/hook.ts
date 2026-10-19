import { DurableObject } from "cloudflare:workers";
import type { Env } from "./env";

export type HookMeta = {
  name: string;
  key: string;
  owned: boolean;
  createdAt: number;
};

export type RequestSummary = {
  id: number;
  at: string;
  method: string;
  path: string;
  size: number;
};

export type RequestDetail = RequestSummary & {
  headers: Record<string, string>;
  truncated: boolean;
  body: string;
  bodyEncoding: "utf8" | "base64";
};

type Row = {
  id: number;
  at: number;
  method: string;
  path: string;
  headers: string;
  body: ArrayBuffer | null;
  size: number;
  truncated: number;
};

const ttlMs = 7 * 24 * 60 * 60 * 1000;
const keepRequests = 100;
const maxStoredBody = 1024 * 1024;
const textDecoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

export class Hook extends DurableObject<Env> {
  private lastBump = 0;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS requests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      at INTEGER NOT NULL,
      method TEXT NOT NULL,
      path TEXT NOT NULL,
      headers TEXT NOT NULL,
      body BLOB,
      size INTEGER NOT NULL,
      truncated INTEGER NOT NULL
    )`);
  }

  async create(name: string, owned: boolean): Promise<HookMeta | null> {
    const existing = await this.meta();
    if (existing) return owned && existing.owned ? existing : null;
    const meta: HookMeta = { name, key: randomKey(), owned, createdAt: Date.now() };
    await this.ctx.storage.put("meta", meta);
    await this.bump(true);
    return meta;
  }

  async meta(): Promise<HookMeta | undefined> {
    return this.ctx.storage.get<HookMeta>("meta");
  }

  async overview(): Promise<{ expiresAt: number | null; requests: RequestSummary[] }> {
    const expiresAt = await this.ctx.storage.getAlarm();
    return { expiresAt, requests: this.list(0, 50) };
  }

  list(after: number, limit: number): RequestSummary[] {
    const rows = this.ctx.storage.sql.exec<Row>("SELECT id, at, method, path, size FROM requests WHERE id > ? ORDER BY id DESC LIMIT ?", after, limit).toArray();
    return rows.map(summary);
  }

  detail(id: number): RequestDetail | null {
    const row = this.ctx.storage.sql.exec<Row>("SELECT * FROM requests WHERE id = ?", id).toArray()[0];
    if (!row) return null;
    let body: string;
    let bodyEncoding: "utf8" | "base64" = "utf8";
    try {
      body = textDecoder.decode(row.body ?? undefined);
    } catch {
      body = new Uint8Array(row.body ?? new ArrayBuffer(0)).toBase64();
      bodyEncoding = "base64";
    }
    return { ...summary(row), headers: JSON.parse(row.headers) as Record<string, string>, truncated: row.truncated === 1, body, bodyEncoding };
  }

  async remove(): Promise<void> {
    this.closeWatchers();
    await this.ctx.storage.deleteAll();
  }

  async alarm(): Promise<void> {
    this.closeWatchers();
    await this.ctx.storage.deleteAll();
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.hostname === "hook.internal") return this.watch(request);
    return this.catch(request, url);
  }

  async webSocketMessage(): Promise<void> {}

  async webSocketClose(socket: WebSocket, code: number): Promise<void> {
    socket.close(code === 1005 ? 1000 : code);
  }

  private async watch(request: Request): Promise<Response> {
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    const protocols = (request.headers.get("sec-websocket-protocol") ?? "").split(",").map((value) => value.trim());
    const headers = protocols.includes("hook") ? { "Sec-WebSocket-Protocol": "hook" } : undefined;
    this.ctx.acceptWebSocket(server, ["watch"]);
    await this.bump(true);
    return new Response(null, { status: 101, webSocket: client, headers });
  }

  private async catch(request: Request, url: URL): Promise<Response> {
    if (!(await this.meta())) return text("No hook here\n", 404);
    await this.bump(false);
    const path = url.pathname + url.search;
    const headers = Object.create(null) as Record<string, string>;
    for (const [name, value] of request.headers) {
      if (name.startsWith("cf-") || name.startsWith("x-forwarded-") || name === "x-real-ip") continue;
      headers[name] = value;
    }
    const captured = await capture(request.body);
    const at = Date.now();
    const id = this.ctx.storage.sql
      .exec<{ id: number }>(
        "INSERT INTO requests (at, method, path, headers, body, size, truncated) VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id",
        at,
        request.method,
        path,
        JSON.stringify(headers),
        captured.body,
        captured.size,
        captured.truncated ? 1 : 0
      )
      .one().id;
    if (id > keepRequests) this.ctx.storage.sql.exec("DELETE FROM requests WHERE id <= ?", id - keepRequests);
    this.broadcast({ t: "request", request: { id, at: new Date(at).toISOString(), method: request.method, path, size: captured.size } satisfies RequestSummary });
    return text("ok\n");
  }

  private closeWatchers(): void {
    for (const socket of this.ctx.getWebSockets("watch")) socket.close(1000, "Hook deleted");
  }

  private broadcast(message: unknown): void {
    const sockets = this.ctx.getWebSockets("watch");
    if (sockets.length === 0) return;
    const payload = JSON.stringify(message);
    for (const socket of sockets) {
      try {
        socket.send(payload);
      } catch {
        socket.close(1011, "Send failed");
      }
    }
  }

  private async bump(force: boolean): Promise<void> {
    const now = Date.now();
    if (!force && now - this.lastBump < 60 * 60 * 1000) return;
    this.lastBump = now;
    await this.ctx.storage.setAlarm(now + ttlMs);
  }
}

async function capture(body: ReadableStream<Uint8Array> | null): Promise<{ body: Uint8Array; size: number; truncated: boolean }> {
  if (!body) return { body: new Uint8Array(0), size: 0, truncated: false };
  const chunks: Uint8Array[] = [];
  let stored = 0;
  let size = 0;
  for await (const chunk of body) {
    size += chunk.byteLength;
    if (stored < maxStoredBody) {
      const remaining = maxStoredBody - stored;
      const part = chunk.byteLength > remaining ? chunk.subarray(0, remaining) : chunk;
      chunks.push(part);
      stored += part.byteLength;
    }
  }
  if (chunks.length === 1) return { body: chunks[0], size, truncated: size > stored };
  const bytes = new Uint8Array(stored);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { body: bytes, size, truncated: size > stored };
}

function summary(row: Row): RequestSummary {
  return { id: row.id, at: new Date(row.at).toISOString(), method: row.method, path: row.path, size: row.size };
}

function text(body: string, status = 200): Response {
  return new Response(body, { status, headers: { "Content-Type": "text/plain; charset=utf-8" } });
}

function randomKey(): string {
  return crypto.getRandomValues(new Uint8Array(18)).toBase64({ alphabet: "base64url", omitPadding: true });
}
