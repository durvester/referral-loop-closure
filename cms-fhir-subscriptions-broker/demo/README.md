# FHIR Subscriptions Broker Demo

Interactive demo of the FHIR Subscriptions Broker architecture for CMS-aligned networks. Three services run in a single Bun process:

- **IAS Client** — Identity-Assured Subscriber application
- **Broker** — Subscriptions broker with demographic matching
- **Mercy EHR** — Data source (Electronic Health Record)

## Quick Start

```bash
bun run server.ts
```

Open http://localhost:3000 for the dashboard.

## Configuration

All configuration is via environment variables:

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3000` | Port the server binds to |
| `ROUTING_MODE` | `subdomain` | `subdomain` or `path` — how services are addressed |
| `BASE_URL` | `http://localhost:$PORT` | Public URL (used for browser-facing links and JWT audiences) |

### Subdomain mode (default)

Each service gets its own subdomain on localhost:

```
http://localhost:3000          → Dashboard
http://ias-client.localhost:3000 → IAS Client
http://broker.localhost:3000     → Broker
http://mercy-ehr.localhost:3000  → Mercy EHR
```

### Path-prefix mode

All services share one domain, differentiated by path prefix. Use this for external hosting behind a reverse proxy:

```
https://example.com/          → Dashboard
https://example.com/client/   → IAS Client
https://example.com/broker/   → Broker
https://example.com/mercy-ehr/ → Mercy EHR
```

## Sample Configurations

### Local development (subdomain)

```bash
bun run server.ts
```

### Local development (path mode)

```bash
ROUTING_MODE=path bun run server.ts
```

### External hosting behind reverse proxy

```bash
BASE_URL=https://fhir-subscriptions-demo.joshuamandel.com \
ROUTING_MODE=path \
PORT=3000 \
bun run server.ts
```

The reverse proxy (nginx, Caddy, etc.) routes `https://fhir-subscriptions-demo.joshuamandel.com` to `localhost:3000`. The server binds to `PORT` locally but generates browser-facing URLs using `BASE_URL`.

### Custom port

```bash
PORT=8080 bun run server.ts
```

## Architecture

Services communicate via HTTP — there is no in-process function-call wiring. Each handler makes real `fetch()` calls to the other services through the server's routing layer.

- **`serviceUrl()`** — public URL for browser-facing links (uses `BASE_URL`)
- **`internalUrl()`** — loopback URL for server-to-server calls (always `http://localhost:$PORT`)

This separation means the server works correctly even when it can't reach its own public URL from inside the host (common in Docker or firewall setups).
