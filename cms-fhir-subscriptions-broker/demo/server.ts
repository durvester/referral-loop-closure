// Unified server — routes by Host header (subdomain mode) or path prefix (path mode).
// No in-process wiring: handlers communicate via HTTP through this server.
import { handle as clientHandle } from "./client/handler";
import { handle as brokerHandle } from "./broker/handler";
import { handle as dataSourceHandle } from "./data-source/handler";
import { config, serviceUrl, injectHtmlConfig } from "./config";

type Handler = (req: Request) => Promise<Response>;

const dashboardPath = import.meta.dir + "/dashboard.html";

const services: Array<{
  name: string;
  handler: Handler;
  subdomain: string;
  pathPrefix: string;
}> = [
  { name: "client",     handler: clientHandle,     ...config.services.client },
  { name: "broker",     handler: brokerHandle,     ...config.services.broker },
  { name: "dataSource", handler: dataSourceHandle, ...config.services.dataSource },
];

const server = Bun.serve({
  port: config.port,
  async fetch(req) {
    const url = new URL(req.url);
    const host = req.headers.get("host");

    let handler: Handler | null = null;
    let strippedPath = url.pathname;

    if (config.mode === "subdomain") {
      // Route by Host header
      const hostname = host?.split(":")[0] || "";
      for (const svc of services) {
        if (hostname === `${svc.subdomain}.localhost`) {
          handler = svc.handler;
          break;
        }
      }
    } else {
      // Route by path prefix
      for (const svc of services) {
        if (url.pathname === svc.pathPrefix) {
          // Redirect to add trailing slash so relative URLs resolve correctly
          return Response.redirect(`${url.origin}${svc.pathPrefix}/${url.search}`, 301);
        }
        if (url.pathname.startsWith(svc.pathPrefix + "/")) {
          handler = svc.handler;
          strippedPath = url.pathname.slice(svc.pathPrefix.length) || "/";
          break;
        }
      }
    }

    // CORS — in path mode everything is same-origin so CORS is mostly a no-op
    const origin = req.headers.get("origin") || "";
    const allowedOrigin =
      config.mode === "subdomain"
        ? /^http:\/\/([\w-]+\.)?localhost:\d+$/.test(origin)
          ? origin
          : config.baseUrl
        : config.baseUrl;

    if (req.method === "OPTIONS" && handler) {
      return new Response(null, {
        status: 204,
        headers: {
          "Access-Control-Allow-Origin": allowedOrigin,
          "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type, Authorization",
          "Access-Control-Max-Age": "86400",
        },
      });
    }

    // Serve dashboard for bare host (no matching service)
    if (!handler) {
      const raw = await Bun.file(dashboardPath).text();
      const html = injectHtmlConfig(raw);
      return new Response(html, {
        headers: { "Content-Type": "text/html; charset=utf-8" },
      });
    }

    // Build a new Request with the stripped path so the handler sees clean routes
    const newUrl = new URL(strippedPath + url.search, req.url);
    const newReq = new Request(newUrl.toString(), {
      method: req.method,
      headers: req.headers,
      body: req.body,
    });

    const resp = await handler(newReq);

    // Add CORS headers for cross-origin (subdomain mode)
    if (config.mode === "subdomain") {
      const respHeaders = new Headers(resp.headers);
      respHeaders.set("Access-Control-Allow-Origin", allowedOrigin);
      respHeaders.set("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
      respHeaders.set("Access-Control-Allow-Headers", "Content-Type, Authorization");
      return new Response(resp.body, { status: resp.status, headers: respHeaders });
    }

    return resp;
  },
});

console.log(`[Server] ${config.mode} mode on :${config.port}`);
if (config.mode === "subdomain") {
  console.log(`  ${config.baseUrl}              → Dashboard`);
  for (const svc of services) {
    console.log(`  ${serviceUrl(svc.name as any).padEnd(38)} → ${svc.name}`);
  }
} else {
  console.log(`  ${config.baseUrl}/              → Dashboard`);
  for (const svc of services) {
    console.log(`  ${config.baseUrl}${svc.pathPrefix}/  → ${svc.name}`);
  }
}
