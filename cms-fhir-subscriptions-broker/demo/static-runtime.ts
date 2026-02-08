// Static runtime — runs all three handlers in-page (no Service Worker).
// Bundled into a single JS file and loaded by the dashboard via <script type="module">.
//
// Provides:
//   window.__apiFetch(url, init)  — routed fetch that dispatches to handlers
//   window.__sseSubscribe(url, callback) — subscribe to handler SSE streams

import { handle as clientHandle } from "./client/handler";
import { handle as brokerHandle } from "./broker/handler";
import { handle as dataSourceHandle } from "./data-source/handler";
import type { HandlerContext } from "./shared/handler-context";

type Handler = (req: Request, ctx?: HandlerContext) => Promise<Response>;

declare var __BASE_PATH__: string;
const basePath = typeof __BASE_PATH__ !== "undefined" ? __BASE_PATH__ : "";

const routes: Array<{ prefix: string; handler: Handler }> = [
  { prefix: `${basePath}/client/`,    handler: clientHandle },
  { prefix: `${basePath}/broker/`,    handler: brokerHandle },
  { prefix: `${basePath}/mercy-ehr/`, handler: dataSourceHandle },
];

/**
 * Try to dispatch a URL + RequestInit to one of the in-page handlers.
 * Returns null if no route matches (caller should fall through to real fetch).
 *
 * We construct the Request here with the stripped URL so the handler sees clean
 * paths. We pass `init` through directly to avoid the Chrome `duplex` issue
 * with re-wrapping ReadableStream bodies.
 */
function dispatch(url: URL, init?: RequestInit): Promise<Response> | null {
  for (const r of routes) {
    let strippedPath: string | null = null;
    if (url.pathname.startsWith(r.prefix)) {
      strippedPath = "/" + url.pathname.slice(r.prefix.length);
    } else if (url.pathname === r.prefix.slice(0, -1)) {
      // bare prefix without trailing slash (e.g., /broker)
      strippedPath = "/";
    }
    if (strippedPath !== null) {
      const newUrl = new URL(strippedPath + url.search, url.origin);
      const newReq = new Request(newUrl.toString(), init);
      console.debug(`[static-runtime] ${init?.method || "GET"} ${url.pathname} → ${r.prefix.slice(1, -1)} handler ${strippedPath}`);
      return r.handler(newReq, ctx);
    }
  }
  return null;
}

/**
 * Routed fetch — drop-in replacement for fetch().
 * Routes matching API paths to in-page handlers.
 * Everything else passes through to the real network.
 */
function routedFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const urlStr = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  const url = new URL(urlStr, location.origin);
  const result = dispatch(url, init);
  if (result) return result;
  return fetch(input, init);
}

const ctx: HandlerContext = { fetch: routedFetch as typeof globalThis.fetch };

// --- Public API exposed on window ---

(window as any).__apiFetch = routedFetch;

/**
 * sseSubscribe — connects to a handler's SSE endpoint and calls back on each event.
 * Returns an object with .close() to stop listening.
 */
(window as any).__sseSubscribe = function sseSubscribe(
  url: string,
  callbacks: {
    onopen?: () => void;
    onmessage?: (data: string) => void;
    onerror?: (err: any) => void;
  },
): { close: () => void } {
  let cancelled = false;

  (async () => {
    try {
      const resp = await routedFetch(url);
      if (!resp.body) {
        callbacks.onerror?.(new Error("No response body"));
        return;
      }
      callbacks.onopen?.();
      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (!cancelled) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        // Parse SSE frames: lines starting with "data: " separated by blank lines
        const parts = buffer.split("\n\n");
        buffer = parts.pop()!; // keep incomplete frame
        for (const part of parts) {
          for (const line of part.split("\n")) {
            if (line.startsWith("data: ")) {
              callbacks.onmessage?.(line.slice(6));
            }
          }
        }
      }
    } catch (e) {
      if (!cancelled) {
        console.error("[static-runtime] SSE error for", url, e);
        callbacks.onerror?.(e);
      }
    }
  })();

  return {
    close() {
      cancelled = true;
    },
  };
};

// --- BroadcastChannel relay for sub-page tabs ---
// Sub-pages (broker admin, client UI, EHR admin) open in separate tabs without
// the handler runtime. They send fetch/SSE requests over BroadcastChannel and
// this relay dispatches them to the in-page handlers.

const bc = new BroadcastChannel("static-runtime");

bc.onmessage = async (event: MessageEvent) => {
  const msg = event.data;

  if (msg.type === "api-request") {
    try {
      const resp = await routedFetch(msg.url, msg.init);
      const body = await resp.text();
      const headers: Record<string, string> = {};
      resp.headers.forEach((v, k) => { headers[k] = v; });
      bc.postMessage({
        type: "api-response",
        id: msg.id,
        status: resp.status,
        statusText: resp.statusText,
        headers,
        body,
      });
    } catch (e: any) {
      bc.postMessage({
        type: "api-response",
        id: msg.id,
        error: e.message || String(e),
      });
    }
  }

  if (msg.type === "sse-subscribe") {
    (window as any).__sseSubscribe(msg.url, {
      onopen: () => bc.postMessage({ type: "sse-open", channelId: msg.channelId }),
      onmessage: (data: string) => bc.postMessage({ type: "sse-event", channelId: msg.channelId, data }),
      onerror: (err: any) => bc.postMessage({ type: "sse-error", channelId: msg.channelId, error: String(err) }),
    });
  }
};

console.log("[static-runtime] BroadcastChannel relay active for sub-page tabs");

// Signal that the runtime is ready
(window as any).__staticReady = true;
window.dispatchEvent(new Event("static-runtime-ready"));
console.log("[static-runtime] Handlers loaded — all API calls will be served in-page");
