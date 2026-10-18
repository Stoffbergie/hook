import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { createServer, request as httpRequest, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inject } from "vite-plus/test";
import type { RawData } from "ws";

export const baseUrl = inject("baseUrl");
export const hookDomain = inject("hookDomain");
export const ownerToken = inject("ownerToken");
const cliPath = inject("cli");
const serverPort = new URL(baseUrl).port;

export type Created = { name: string; url: string; key: string; watch: string; owned: boolean };
export type Reply = { status: number; headers: IncomingHttpHeaders; text: string };
export type Summary = { id: number; method: string; path: string; size: number };
export type Detail = Summary & { headers: Record<string, string>; body: string; bodyEncoding: string; truncated: boolean };

export async function createHook(options: { token?: string; name?: string } = {}): Promise<Created> {
  const query = options.name ? `?name=${options.name}` : "";
  const headers: Record<string, string> = { Accept: "application/json" };
  if (options.token) headers.Authorization = `Bearer ${options.token}`;
  const response = await fetch(`${baseUrl}/${query}`, { method: "POST", headers });
  if (response.status !== 201) throw new Error(`create failed: ${response.status} ${await response.text()}`);
  return (await response.json()) as Created;
}

export function send(name: string, path: string, init: { method?: string; headers?: Record<string, string>; body?: string } = {}): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const length = init.body === undefined ? {} : { "content-length": String(Buffer.byteLength(init.body)) };
    const headers = { ...length, ...init.headers, host: `${name}.${hookDomain}` };
    const request = httpRequest({ host: "127.0.0.1", port: serverPort, path, method: init.method ?? "GET", headers }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("end", () => resolve({ status: response.statusCode ?? 0, headers: response.headers, text: Buffer.concat(chunks).toString("utf8") }));
    });
    request.on("error", reject);
    if (init.body) request.write(init.body);
    request.end();
  });
}

export async function requests(name: string, credential: string): Promise<Summary[]> {
  const response = await fetch(`${baseUrl}/${name}/requests`, { headers: { Authorization: `Bearer ${credential}` } });
  return (await response.json()) as Summary[];
}

export async function detail(name: string, credential: string, id: number): Promise<Detail> {
  const response = await fetch(`${baseUrl}/${name}/requests/${id}`, { headers: { Authorization: `Bearer ${credential}` } });
  return (await response.json()) as Detail;
}

export type Cli = { process: ChildProcess; output: () => string; stop: () => void };

function spawnCli(args: string[], options: { token?: string; home?: string }): Cli {
  const home = options.home ?? newHome();
  const env: Record<string, string> = { ...(process.env as Record<string, string>), HOOK_URL: baseUrl, HOME: home, XDG_CONFIG_HOME: home, NO_COLOR: "1" };
  if (options.token) env.HOOK_TOKEN = options.token;
  else delete env.HOOK_TOKEN;
  const child = spawn(cliPath, args, { env });
  let text = "";
  child.stdout.on("data", (chunk: Buffer) => (text += chunk.toString()));
  child.stderr.on("data", (chunk: Buffer) => (text += chunk.toString()));
  const stop = () => {
    if (child.exitCode === null) child.kill("SIGINT");
  };
  return { process: child, output: () => text, stop };
}

export function newHome(): string {
  return mkdtempSync(join(tmpdir(), "hook-cli-"));
}

export async function startCatching(args: string[], options: { token?: string; home?: string } = {}): Promise<Cli & { name: string }> {
  const cli = spawnCli(args, options);
  const url = await waitFor(
    () => cli.output().match(new RegExp(`https://[a-z0-9-]+\\.${hookDomain.replace(".", "\\.")}`))?.[0],
    () => `CLI did not print a URL\n${cli.output()}`,
    20_000
  );
  return { ...cli, name: new URL(url).hostname.split(".")[0] };
}

export async function startWatching(args: string[], options: { token?: string; home?: string } = {}): Promise<Cli> {
  const cli = spawnCli(args, options);
  await waitFor(
    () => (cli.output().includes("Watching") ? true : undefined),
    () => `CLI did not start watching\n${cli.output()}`
  );
  await sleep(1000);
  return cli;
}

export async function runCli(args: string[], options: { token?: string; home?: string } = {}): Promise<{ code: number | null; output: string }> {
  const cli = spawnCli(args, options);
  const code = await new Promise<number | null>((resolve) => cli.process.on("exit", resolve));
  return { code, output: cli.output() };
}

export type Local = { port: number; server: Server; received: { method: string; url: string; headers: IncomingHttpHeaders; body: string }[]; close: () => Promise<void> };

export async function startLocal(port = 0): Promise<Local> {
  const received: Local["received"] = [];
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      received.push({ method: request.method ?? "", url: request.url ?? "", headers: request.headers, body: Buffer.concat(chunks).toString("utf8") });
      response.statusCode = request.url?.startsWith("/fail") ? 500 : 200;
      response.end("handled");
    });
  });
  await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
  return {
    port: (server.address() as AddressInfo).port,
    server,
    received,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      })
  };
}

export async function freePort(): Promise<number> {
  const probe = await startLocal();
  await probe.close();
  return probe.port;
}

export async function waitFor<T>(check: () => T | undefined | Promise<T | undefined>, message: () => string, timeoutMs = 10_000): Promise<T> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const value = await check();
    if (value !== undefined) return value;
    await sleep(50);
  }
  throw new Error(message());
}

export async function printed(cli: Cli, pattern: RegExp): Promise<void> {
  await waitFor(
    () => (pattern.test(cli.output()) ? true : undefined),
    () => `CLI did not print ${pattern}\n${cli.output()}`
  );
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function uniqueName(prefix: string): string {
  return `${prefix}-${Math.random().toString(36).slice(2, 8)}`;
}

export function textOf(data: RawData): string {
  if (Array.isArray(data)) return Buffer.concat(data).toString("utf8");
  return Buffer.from(data as ArrayBuffer).toString("utf8");
}
