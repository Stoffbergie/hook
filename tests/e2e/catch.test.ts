import { strict as assert } from "node:assert";
import { test } from "vite-plus/test";
import { WebSocket } from "ws";
import { baseUrl, createHook, detail, hookDomain, ownerToken, requests, send, textOf, uniqueName, waitFor } from "../helpers/hook";

test("anyone can create a URL that records webhooks and read them back with its key", async () => {
  const hook = await createHook();
  assert.equal(hook.url, `https://${hook.name}.${hookDomain}`);
  assert.equal(hook.owned, false);

  const reply = await send(hook.name, "/stripe/events?live=1", { method: "POST", headers: { "content-type": "application/json", "stripe-signature": "t=1,v1=abc" }, body: '{"paid":true}' });
  assert.equal(reply.status, 200);
  assert.equal(reply.text, "ok\n");

  const [latest] = await requests(hook.name, hook.key);
  assert.equal(latest.method, "POST");
  assert.equal(latest.path, "/stripe/events?live=1");
  assert.equal(latest.size, 13);

  const full = await detail(hook.name, hook.key, latest.id);
  assert.equal(full.body, '{"paid":true}');
  assert.equal(full.headers["stripe-signature"], "t=1,v1=abc");
});

test("reading a hook needs its key", async () => {
  const hook = await createHook();
  const other = await createHook();
  assert.equal((await fetch(`${baseUrl}/${hook.name}`)).status, 401);
  assert.equal((await fetch(`${baseUrl}/${hook.name}`, { headers: { Authorization: `Bearer ${other.key}` } })).status, 401);
  assert.equal((await fetch(`${baseUrl}/${hook.name}`, { headers: { Authorization: `Bearer ${hook.key}` } })).status, 200);
  assert.equal((await fetch(`${baseUrl}/zzzzzzzz`, { headers: { Authorization: `Bearer ${hook.key}` } })).status, 404);
  assert.equal((await send("zzzzzzzz", "/")).status, 404);
});

test("choosing a name is for the owner only", async () => {
  const named = await fetch(`${baseUrl}/?name=${uniqueName("mine")}`, { method: "POST" });
  assert.equal(named.status, 403);

  const name = uniqueName("owned");
  const owned = await createHook({ token: ownerToken, name });
  assert.equal(owned.name, name);
  assert.equal(owned.owned, true);
  const again = await createHook({ token: ownerToken, name });
  assert.equal(again.key, owned.key);
});

test("watchers see requests live over a WebSocket", async () => {
  const hook = await createHook();
  const socket = new WebSocket(`${baseUrl.replace("http", "ws")}/${hook.name}/connect`, ["hook", hook.key]);
  const events: { t: string; request?: { path: string; size: number } }[] = [];
  socket.on("message", (data) => events.push(JSON.parse(textOf(data))));
  await new Promise((resolve) => socket.on("open", resolve));
  assert.equal(socket.protocol, "hook");

  await send(hook.name, "/live", { method: "PUT", body: "x" });
  const event = await waitFor(
    () => events.find((candidate) => candidate.t === "request"),
    () => "no request event arrived"
  );
  socket.close();
  assert.equal(event.request?.path, "/live");
  assert.equal(event.request?.size, 1);
});

test("deleting a hook removes the URL and what it recorded", async () => {
  const hook = await createHook();
  await send(hook.name, "/gone");
  const deleted = await fetch(`${baseUrl}/${hook.name}`, { method: "DELETE", headers: { Authorization: `Bearer ${hook.key}` } });
  assert.equal(deleted.status, 200);
  assert.equal((await send(hook.name, "/gone")).status, 404);
});

test("creating too many hooks from one address is refused", async () => {
  const statuses: number[] = [];
  for (let index = 0; index < 35; index += 1) {
    statuses.push((await fetch(baseUrl, { method: "POST", headers: { "cf-connecting-ip": "203.0.113.7" } })).status);
  }
  assert.equal(statuses[0], 201);
  assert.equal(statuses.at(-1), 429);
});
