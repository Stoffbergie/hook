import { app } from "./app";
import type { Env } from "./env";
import { hookName, validName } from "./names";

export { Hook } from "./hook";

export default {
  async fetch(request, env, ctx) {
    const name = hookName(new URL(request.url).hostname, env.HOOK_DOMAIN);
    if (name === null) return app.fetch(request, env, ctx);
    if (!validName(name)) return new Response("No hook here\n", { status: 404, headers: { "Content-Type": "text/plain; charset=utf-8" } });
    return env.HOOKS.getByName(name).fetch(request);
  }
} satisfies ExportedHandler<Env>;
