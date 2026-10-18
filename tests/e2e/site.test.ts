import { strict as assert } from "node:assert";
import { test } from "vite-plus/test";
import { baseUrl, createHook } from "../helpers/hook";

test("browsers get the homepage and curl gets usage text", async () => {
  const page = await fetch(baseUrl, { headers: { Accept: "text/html" } });
  assert.match(page.headers.get("content-type") ?? "", /text\/html/);
  const html = await page.text();
  assert.match(html, /<h1>Catch a webhook\. Replay it\.<\/h1>/);
  assert.match(html, /<p hidden id="automation">Agents and automation:/);
  assert.ok(html.indexOf("hook --to 3000") < html.indexOf("<details>"), "everyday commands come before the hidden details");
  assert.ok(html.indexOf("curl -i -X POST") > html.indexOf("<details>"), "the curl API sits inside More options");

  const text = await (await fetch(baseUrl)).text();
  assert.match(text, /^hook: webhooks, caught and replayed\.\n\nAgents and automation:/);
  assert.match(text, /hook replay stripe --to 3000/);
});

test("a hook's watch link opens a live viewer page", async () => {
  const hook = await createHook();
  const page = await fetch(`${baseUrl}/${hook.name}`, { headers: { Accept: "text/html" } });
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.match(html, new RegExp(`https://${hook.name}\\.hook\\.test`));
  assert.match(html, /new WebSocket/);
});
