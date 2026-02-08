// Centralized configuration for the FHIR Subscriptions Broker demo.
// All service URLs are derived from these settings.
//
// Modes:
//   "subdomain" — routes by Host header (e.g., broker.localhost:3000)
//   "path"      — routes by URL path prefix (e.g., localhost:3000/broker)
//   "static"    — client-side only; all services run in a Service Worker
//
// Environment variables (server modes only):
//   BASE_URL       — public base URL (default: http://localhost:3000)
//   ROUTING_MODE   — "subdomain" | "path" | "static" (default: subdomain)
//   PORT           — server listen port (default: 3000)

// In a Service Worker context, process.env won't exist.
// The static build injects __STATIC_MODE__ = true and __BASE_PATH__ at bundle time.
declare var __STATIC_MODE__: boolean | undefined;
declare var __BASE_PATH__: string | undefined;

const isStaticBuild = typeof __STATIC_MODE__ !== "undefined" && __STATIC_MODE__;
const staticBasePath = typeof __BASE_PATH__ !== "undefined" ? __BASE_PATH__ : "";

const mode: "subdomain" | "path" | "static" = isStaticBuild
  ? "static"
  : ((typeof process !== "undefined" && process.env?.ROUTING_MODE) || "subdomain") as any;
const port = (!isStaticBuild && typeof process !== "undefined" && process.env?.PORT)
  ? parseInt(process.env.PORT)
  : 3000;
const baseUrl = isStaticBuild
  ? ""  // same-origin, relative paths
  : ((typeof process !== "undefined" && process.env?.BASE_URL) || `http://localhost:${port}`);

export const config = {
  port,
  mode,
  baseUrl,
  services: {
    client:     { subdomain: "ias-client", pathPrefix: "/client" },
    broker:     { subdomain: "broker",     pathPrefix: "/broker" },
    dataSource: { subdomain: "mercy-ehr",  pathPrefix: "/mercy-ehr" },
  },
} as const;

export const isStatic = mode === "static";

export type ServiceName = keyof typeof config.services;

/** URL for browser / external access to a service */
export function serviceUrl(service: ServiceName): string {
  const s = config.services[service];
  if (config.mode === "subdomain") {
    return `http://${s.subdomain}.localhost:${config.port}`;
  }
  // Both "path" and "static" use path prefixes
  return `${config.baseUrl}${s.pathPrefix}`;
}

/** URL for server-to-server calls (loopback — never leaves the host) */
export function internalUrl(service: ServiceName): string {
  const s = config.services[service];
  if (config.mode === "subdomain") {
    return `http://${s.subdomain}.localhost:${config.port}`;
  }
  if (config.mode === "static") {
    // In static mode, inter-service calls go through the routedFetch
    // which matches on path prefix including the base path
    return `${staticBasePath}${s.pathPrefix}`;
  }
  return `http://localhost:${config.port}${s.pathPrefix}`;
}

/** Path prefix for a service (empty string in subdomain mode) */
export function servicePath(service: ServiceName): string {
  if (config.mode === "subdomain") return "";
  return config.services[service].pathPrefix;
}

/** Inject config variables into an HTML string (adds script before </head>) */
export function injectHtmlConfig(html: string, selfService?: ServiceName): string {
  const vars = [
    `var __BROKER__ = ${JSON.stringify(serviceUrl("broker"))};`,
    `var __CLIENT__ = ${JSON.stringify(serviceUrl("client"))};`,
    `var __EHR__ = ${JSON.stringify(serviceUrl("dataSource"))};`,
    `var __DASHBOARD__ = ${JSON.stringify(config.baseUrl || "/")};`,
  ];
  if (selfService !== undefined) {
    vars.push(`var __BASE__ = ${JSON.stringify(servicePath(selfService))};`);
  }
  const script = `<script>${vars.join("\n")}</script>`;
  return html.replace("</head>", script + "\n</head>");
}
