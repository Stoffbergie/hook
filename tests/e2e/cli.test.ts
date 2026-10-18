import { strict as assert } from "node:assert";
import { test } from "vite-plus/test";
import { createHook, freePort, newHome, ownerToken, printed, runCli, send, startCatching, startLocal, startWatching, uniqueName } from "../helpers/hook";

test("hook on its own gives a URL and prints each request as it arrives", async () => {
  const cli = await startCatching([]);
  try {
    const reply = await send(cli.name, "/github", { method: "POST", body: "{}" });
    assert.equal(reply.text, "ok\n");
    await printed(cli, /POST\s+\/github\s+2 B/);
  } finally {
    cli.stop();
  }
});

test("hook --to delivers each webhook to localhost as it arrives", async () => {
  const local = await startLocal();
  const cli = await startCatching(["--to", String(local.port)]);
  try {
    assert.match(cli.output(), new RegExp(`→ localhost:${local.port}`));
    await send(cli.name, "/stripe?attempt=1", { method: "POST", headers: { "stripe-signature": "t=1,v1=abc", "content-type": "application/json" }, body: '{"id":"evt_1"}' });
    await send(cli.name, "/fail", { method: "POST", body: "second" });
    await printed(cli, /POST\s+200\s+\/stripe\?attempt=1/);
    await printed(cli, /POST\s+500\s+\/fail/);

    const [first, second] = local.received;
    assert.equal(first.url, "/stripe?attempt=1");
    assert.equal(first.body, '{"id":"evt_1"}');
    assert.equal(first.headers["stripe-signature"], "t=1,v1=abc");
    assert.equal(first.headers["content-type"], "application/json");
    assert.equal(second.body, "second");
  } finally {
    cli.stop();
    await local.close();
  }
});

test("a webhook missed while the local server was down can be replayed", async () => {
  const port = await freePort();
  const home = newHome();
  const cli = await startCatching(["--to", String(port)], { home });
  try {
    await send(cli.name, "/missed", { method: "POST", body: "late" });
    await printed(cli, /nothing answered on localhost/);
    assert.equal(cli.process.exitCode, null, "hook keeps catching after a failed delivery");

    const local = await startLocal(port);
    try {
      await send(cli.name, "/next", { method: "POST", body: "on time" });
      await printed(cli, /POST\s+200\s+\/next/);
      const replay = await runCli(["replay", cli.name, "1", "--to", String(port)], { home });
      assert.equal(replay.code, 0, replay.output);
      assert.deepEqual(
        local.received.map((request) => request.body),
        ["on time", "late"]
      );
    } finally {
      await local.close();
    }
  } finally {
    cli.stop();
  }
});

test("replay sends the latest captured webhook to a local server again", async () => {
  const hook = await createHook();
  await send(hook.name, "/old", { method: "POST", body: "old" });
  await send(hook.name, "/stripe", { method: "POST", headers: { "stripe-signature": "t=2,v1=def" }, body: '{"id":"evt_2"}' });
  const local = await startLocal();
  try {
    const result = await runCli(["replay", hook.watch, "--to", String(local.port)]);
    assert.equal(result.code, 0, result.output);
    assert.match(result.output, /POST\s+200\s+\/stripe/);
    assert.equal(local.received.length, 1);
    assert.equal(local.received[0].body, '{"id":"evt_2"}');
    assert.equal(local.received[0].headers["stripe-signature"], "t=2,v1=def");
  } finally {
    await local.close();
  }
});

test("hook watch picks up an existing hook and delivers only new webhooks", async () => {
  const hook = await createHook();
  await send(hook.name, "/before", { method: "POST", body: "before" });
  const local = await startLocal();
  const cli = await startWatching(["watch", hook.watch, "--to", String(local.port)]);
  try {
    await send(hook.name, "/after", { method: "POST", body: "after" });
    await printed(cli, /POST\s+200\s+\/after/);
    assert.deepEqual(
      local.received.map((request) => request.url),
      ["/after"]
    );
  } finally {
    cli.stop();
    await local.close();
  }
});

test("hook remembers its hooks so ls and rm work by name", async () => {
  const home = newHome();
  const name = uniqueName("stripe");
  const cli = await startCatching(["--name", name], { token: ownerToken, home });
  cli.stop();

  const listed = await runCli(["ls"], { home });
  assert.match(listed.output, new RegExp(`${name}\\s+https://${name}\\.`));

  const removed = await runCli(["rm", name], { home });
  assert.equal(removed.code, 0, removed.output);
  assert.equal((await send(name, "/")).status, 404);
  assert.doesNotMatch((await runCli(["ls"], { home })).output, new RegExp(name));
});

test("choosing a name without the owner token is refused with a hint", async () => {
  const result = await runCli(["--name", "mine"]);
  assert.equal(result.code, 1);
  assert.match(result.output, /owner token/);
});
