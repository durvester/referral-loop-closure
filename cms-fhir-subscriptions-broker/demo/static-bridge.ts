// Static bridge — loaded by sub-page tabs (broker admin, client UI, EHR admin)
// in static mode. Routes fetch() and EventSource through BroadcastChannel to the
// main dashboard page, which hosts the actual handler runtime.
//
// Provides transparent overrides: sub-page code uses normal fetch() and
// new EventSource() and they "just work" via the bridge.

declare var __STATIC__: boolean | undefined;
declare var __BASE_PATH__: string;

const IS_STATIC = typeof __STATIC__ !== "undefined" && __STATIC__;

if (IS_STATIC) {
  const bc = new BroadcastChannel("static-runtime");
  const pendingRequests = new Map<string, { resolve: (v: Response) => void; reject: (e: Error) => void }>();
  const sseListeners = new Map<string, {
    onopen?: () => void;
    onmessage?: (e: MessageEvent) => void;
    onerror?: (e: Event) => void;
  }>();

  bc.onmessage = (event: MessageEvent) => {
    const msg = event.data;

    if (msg.type === "api-response" && pendingRequests.has(msg.id)) {
      const { resolve, reject } = pendingRequests.get(msg.id)!;
      pendingRequests.delete(msg.id);
      if (msg.error) {
        reject(new Error(msg.error));
      } else {
        resolve(new Response(msg.body, {
          status: msg.status,
          statusText: msg.statusText,
          headers: msg.headers,
        }));
      }
    }

    if (msg.type === "sse-open" && sseListeners.has(msg.channelId)) {
      sseListeners.get(msg.channelId)!.onopen?.();
    }
    if (msg.type === "sse-event" && sseListeners.has(msg.channelId)) {
      sseListeners.get(msg.channelId)!.onmessage?.({ data: msg.data } as MessageEvent);
    }
    if (msg.type === "sse-error" && sseListeners.has(msg.channelId)) {
      sseListeners.get(msg.channelId)!.onerror?.(new Event("error"));
    }
  };

  // Path prefixes that should be routed to the main page's handlers
  const bp = typeof __BASE_PATH__ !== "undefined" ? __BASE_PATH__ : "";
  const routePrefixes = [`${bp}/client/`, `${bp}/broker/`, `${bp}/mercy-ehr/`];

  function shouldRoute(pathname: string): boolean {
    return routePrefixes.some(p => pathname.startsWith(p)) ||
      routePrefixes.some(p => pathname === p.slice(0, -1));
  }

  // Override fetch for API paths
  const originalFetch = window.fetch.bind(window);

  window.fetch = function bridgedFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const urlStr = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const url = new URL(urlStr, location.origin);

    if (!shouldRoute(url.pathname)) return originalFetch(input, init);

    const id = Math.random().toString(36).slice(2) + Date.now().toString(36);
    return new Promise<Response>((resolve, reject) => {
      pendingRequests.set(id, { resolve, reject });

      // Serialize init — only pass serializable fields
      const serializableInit = init ? {
        method: init.method,
        headers: init.headers instanceof Headers
          ? Object.fromEntries((init.headers as Headers).entries())
          : init.headers,
        body: typeof init.body === "string" ? init.body : undefined,
      } : undefined;

      bc.postMessage({
        type: "api-request",
        id,
        url: url.pathname + url.search,
        init: serializableInit,
      });
    });
  } as typeof window.fetch;

  // Override EventSource for routed paths
  const OriginalEventSource = window.EventSource;

  class BridgedEventSource extends EventTarget {
    onopen: ((this: EventSource, ev: Event) => any) | null = null;
    onmessage: ((this: EventSource, ev: MessageEvent) => any) | null = null;
    onerror: ((this: EventSource, ev: Event) => any) | null = null;
    readyState = 0; // CONNECTING
    url: string;
    withCredentials = false;
    private channelId: string;

    static readonly CONNECTING = 0;
    static readonly OPEN = 1;
    static readonly CLOSED = 2;
    readonly CONNECTING = 0;
    readonly OPEN = 1;
    readonly CLOSED = 2;

    constructor(url: string | URL, _eventSourceInitDict?: EventSourceInit) {
      super();
      this.url = typeof url === "string" ? url : url.href;
      this.channelId = Math.random().toString(36).slice(2) + Date.now().toString(36);

      sseListeners.set(this.channelId, {
        onopen: () => {
          this.readyState = 1;
          const ev = new Event("open");
          this.onopen?.call(this as any, ev);
          this.dispatchEvent(ev);
        },
        onmessage: (e: MessageEvent) => {
          this.onmessage?.call(this as any, e);
          this.dispatchEvent(new MessageEvent("message", { data: e.data }));
        },
        onerror: (e: Event) => {
          this.readyState = 2;
          this.onerror?.call(this as any, e);
          this.dispatchEvent(e);
        },
      });

      bc.postMessage({ type: "sse-subscribe", url: this.url, channelId: this.channelId });
    }

    close() {
      this.readyState = 2;
      sseListeners.delete(this.channelId);
    }
  }

  // Replace EventSource constructor — route matching URLs through bridge
  (window as any).EventSource = function(url: string | URL, opts?: EventSourceInit) {
    const urlStr = typeof url === "string" ? url : url.href;
    const parsedUrl = new URL(urlStr, location.origin);

    if (shouldRoute(parsedUrl.pathname)) {
      return new BridgedEventSource(url, opts);
    }
    return new OriginalEventSource(url, opts);
  };

  console.log("[static-bridge] BroadcastChannel bridge active — fetch/EventSource routed to main page");
}
