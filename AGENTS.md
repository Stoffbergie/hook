Contract notes for this repo:

- hook is one Cloudflare Worker, one Durable Object per hook, and a Rust CLI. Keep it that way: no accounts, no database beyond each Durable Object's SQLite.
- hook.stoff.dev serves the homepage, the API and the live viewer. Every `<name>.hook.stoff.dev` URL is routed to the Durable Object named after it. The managed certificate for the hook.stoff.dev custom domain also covers `*.hook.stoff.dev`; removing that custom domain would remove the wildcard certificate too.
- Hook URLs record the request and reply `ok`, nothing else, so anyone can create one. Choosing a name needs the owner token (`HOOK_TOKEN` secret).
- Reading or deleting a hook needs its key or the owner token. Browsers carry the key in the URL fragment and the WebSocket subprotocol, never in a query string.
- Watchers get one JSON `request` event per new request. The CLI fetches the full request over HTTP and delivers it to localhost itself; after a reconnect it lists what it missed with `?after=`.
- Each hook keeps its latest 100 requests with bodies up to 1 MB and deletes itself with an alarm 7 days after its last use.
- The usage rows in `src/pages.ts` are the documentation: the homepage, its hidden descriptions for agents and the text that curl gets come from them.
- Pages are monospace, monotone and framework-free, with system fonts only, matching keep.stoff.dev and reach.stoff.dev.
- Tests are end-to-end in `tests/e2e` against the real Worker with the real CLI and real local servers. Cover user workflows, not internals.
