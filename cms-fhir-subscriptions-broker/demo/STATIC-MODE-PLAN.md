# Static GitHub Pages Demo — In-Page Runtime

## What we built

A "static" mode for the FHIR Subscriptions Broker demo that runs entirely client-side. All three "servers" (IAS Client, Broker, Mercy EHR) execute as handler modules directly in the browser page — no backend, no Service Worker.

## Architecture

```
GitHub Pages serves:
  index.html           — dashboard (loads static-runtime.js)
  static-runtime.js    — bundled handlers + routing (~50KB)
  client/index.html    — client UI
  broker/index.html    — broker UI
  mercy-ehr/index.html — data-source UI

In the browser:
  Dashboard calls apiFetch("/broker/register-patient", ...)
    → routedFetch() matches /broker/ prefix
    → strips prefix, creates Request with path "/"
    → calls brokerHandler(request, { fetch: routedFetch })
    → handler processes request, returns Response
    → dashboard reads Response as normal

  Inter-service calls (e.g., EHR → Broker → Client):
    Handler calls ctx.fetch("/broker/internal/event", ...)
    → routedFetch dispatches to broker handler in-page
    → broker calls ctx.fetch("/client/notifications", ...)
    → routedFetch dispatches to client handler in-page

  SSE streams:
    __sseSubscribe("/broker/events", callbacks)
    → routedFetch returns streaming Response from handler
    → sseSubscribe reads ReadableStream, parses SSE frames
    → calls onmessage() for each event
```

## Why not a Service Worker?

We initially planned a SW approach, but realized the handlers can be invoked directly as functions — no interception needed. This avoids:
- SW registration/activation lifecycle
- SW update synchronization
- SW idle timeout killing SSE streams
- Cross-context communication complexity
- Debugging difficulty (SW is a separate thread)

The handlers already use the WinterCG `(Request) → Response` pattern. They just need a `fetch` override for inter-service calls, which is a simple function argument.

## Key changes from server mode

1. **`config.ts`** — Added `"static"` mode where `internalUrl()` returns same-origin path prefixes
2. **All handlers** — Accept optional `ctx: { fetch }` parameter; use `ctx.fetch` for inter-service calls
3. **`Bun.file()` calls** — Guarded by `isStatic` check (returns null → 404 in static mode; HTML served by GitHub Pages instead)
4. **`dashboard.html`** — Uses `apiFetch()` wrapper and `__sseSubscribe()` instead of raw `fetch`/`EventSource`
5. **`static-runtime.ts`** — New module that imports all handlers, provides `routedFetch` and SSE subscription

## Build

```bash
bun run demo/build-static.ts
# produces docs/ directory ready for GitHub Pages
```

## Serve locally

```bash
npx serve docs
# or: python -m http.server -d docs
```

## Known limitations

- All services share one origin (no CORS demonstration)
- State is in-memory; lost on page reload
- No real network traffic in DevTools (all in-page function calls)
- The bundled JS includes dead code paths for `Bun.file()` (guarded, never executes)
