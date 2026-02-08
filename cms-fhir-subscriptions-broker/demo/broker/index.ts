// Broker (:3002)
import { makeSubscription, makeNotificationBundle } from "../shared/types";
import { createMockToken } from "../shared/auth";

const PORT = 3002;
const CLIENT_WEBHOOK = "http://localhost:3001/notifications";

// Pre-seeded patient mapping: data-source patient → broker patient
const patientMap: Map<string, string> = new Map([
  ["mercy-pat-5678", "broker-123"],
]);

// Subscriptions store
const subscriptions: Map<string, object> = new Map();
let subCounter = 0;

// Event log
const eventLog: any[] = [];

// SSE connections
const sseClients: Set<ReadableStreamDefaultController> = new Set();

function pushEvent(data: any) {
  data.timestamp = Date.now();
  eventLog.push(data);
  if (eventLog.length > 200) eventLog.shift();
  const msg = `data: ${JSON.stringify(data)}\n\n`;
  for (const c of sseClients) {
    try { c.enqueue(new TextEncoder().encode(msg)); } catch { sseClients.delete(c); }
  }
}

// Admin UI HTML
const adminHtml = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Subscriptions Broker — Admin</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    background: #1a1000;
    color: #e0e0e0;
    min-height: 100vh;
  }
  header {
    background: #4a2f10;
    padding: 16px 24px;
    border-bottom: 2px solid #e67e22;
    display: flex;
    align-items: center;
    gap: 16px;
  }
  header h1 { font-size: 1.3rem; color: #f0b27a; }
  header .subtitle { font-size: 0.85rem; color: #e67e22; }
  .container {
    max-width: 900px;
    margin: 24px auto;
    padding: 0 16px;
  }
  .grid2 { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
  .card {
    background: rgba(255,255,255,0.05);
    border: 1px solid rgba(230,126,34,0.3);
    border-radius: 8px;
    padding: 16px;
    margin-bottom: 16px;
  }
  .card h2 { font-size: 1rem; margin-bottom: 12px; color: #f0b27a; text-transform: uppercase; letter-spacing: 0.5px; font-size: 0.85rem; }
  table { width: 100%; border-collapse: collapse; font-size: 0.85rem; }
  th { text-align: left; color: #8899aa; font-size: 0.75rem; text-transform: uppercase; padding: 6px 8px; border-bottom: 1px solid rgba(255,255,255,0.1); }
  td { padding: 6px 8px; border-bottom: 1px solid rgba(255,255,255,0.05); }
  .tag { padding: 2px 8px; border-radius: 10px; font-size: 0.7rem; font-weight: 600; }
  .tag-active { background: rgba(39,174,96,0.2); color: #2ecc71; }
  .tag-amber { background: rgba(230,126,34,0.2); color: #f0b27a; }
  .log-entry {
    padding: 6px 8px;
    border-bottom: 1px solid rgba(255,255,255,0.05);
    font-size: 0.82rem;
    animation: fadeIn 0.3s;
  }
  @keyframes fadeIn { from { opacity: 0; } to { opacity: 1; } }
  .log-time { color: #666; font-size: 0.72rem; float: right; }
  .log-type { font-weight: 600; color: #f0b27a; font-size: 0.75rem; text-transform: uppercase; }
  .log-detail { color: #bbb; }
  #log-container { max-height: 500px; overflow-y: auto; }
  .stat { font-size: 2rem; font-weight: 700; color: #f0b27a; }
  .stat-label { font-size: 0.8rem; color: #889; }
  details summary { cursor: pointer; font-size: 0.8rem; color: #e67e22; }
  details pre {
    background: rgba(0,0,0,0.4); padding: 8px; border-radius: 4px;
    font-size: 0.72rem; overflow-x: auto; margin-top: 4px; color: #ddb;
    max-height: 200px; overflow-y: auto;
  }
</style>
</head>
<body>
<header>
  <h1>Subscriptions Broker</h1>
  <span class="subtitle">Admin Dashboard</span>
</header>
<div class="container">
  <div class="grid2">
    <div class="card">
      <h2>Stats</h2>
      <div style="display:flex; gap:24px;">
        <div><div class="stat" id="stat-subs">0</div><div class="stat-label">Subscriptions</div></div>
        <div><div class="stat" id="stat-events">0</div><div class="stat-label">Events Processed</div></div>
        <div><div class="stat" id="stat-mappings">0</div><div class="stat-label">Patient Mappings</div></div>
      </div>
    </div>
    <div class="card">
      <h2>Patient Mappings</h2>
      <table>
        <tr><th>Data Source ID</th><th>Broker ID</th></tr>
        <tbody id="mappings-body"></tbody>
      </table>
    </div>
  </div>
  <div class="card">
    <h2>Active Subscriptions</h2>
    <table>
      <tr><th>ID</th><th>Patient</th><th>Channel</th><th>Status</th></tr>
      <tbody id="subs-body"><tr><td colspan="4" style="color:#666;">None yet</td></tr></tbody>
    </table>
  </div>
  <div class="card">
    <h2>Event Log (live tail)</h2>
    <div id="log-container"></div>
  </div>
</div>
<script>
async function loadState() {
  const resp = await fetch("/admin/state");
  const s = await resp.json();
  document.getElementById("stat-subs").textContent = s.subscriptions.length;
  document.getElementById("stat-events").textContent = s.eventCount;
  document.getElementById("stat-mappings").textContent = s.mappings.length;
  document.getElementById("mappings-body").innerHTML = s.mappings.map(m =>
    "<tr><td>" + m.source + "</td><td>" + m.broker + "</td></tr>"
  ).join("");
  if (s.subscriptions.length) {
    document.getElementById("subs-body").innerHTML = s.subscriptions.map(sub =>
      "<tr><td>" + sub.id + "</td><td>" + (sub.criteria || "").split("Patient/")[1] +
      "</td><td>rest-hook</td><td><span class='tag tag-active'>active</span></td></tr>"
    ).join("");
  }
}
loadState();

const es = new EventSource("/events");
let eventCount = 0;
es.onmessage = (e) => {
  try {
    const data = JSON.parse(e.data);
    if (data.type === "state-sync") {
      // Initial sync handled by loadState
      return;
    }
    eventCount++;
    document.getElementById("stat-events").textContent = eventCount;
    const container = document.getElementById("log-container");
    const div = document.createElement("div");
    div.className = "log-entry";
    const time = new Date(data.timestamp || Date.now()).toLocaleTimeString();
    div.innerHTML = '<span class="log-time">' + time + '</span>' +
      '<div class="log-type">' + (data.type || "event") + '</div>' +
      '<div class="log-detail">' + (data.detail || "") + '</div>' +
      (data.resource ? '<details><summary>FHIR JSON</summary><pre>' + JSON.stringify(data.resource, null, 2) + '</pre></details>' : '');
    container.prepend(div);
    // Update subs count
    if (data.type === "subscription-created") loadState();
  } catch {}
};
</script>
</body>
</html>`;

const server = Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);
    const method = req.method;

    // Serve admin UI
    if (url.pathname === "/" && method === "GET") {
      return new Response(adminHtml, { headers: { "Content-Type": "text/html; charset=utf-8" } });
    }

    // Admin state endpoint
    if (url.pathname === "/admin/state" && method === "GET") {
      return Response.json({
        subscriptions: [...subscriptions.values()],
        mappings: [...patientMap.entries()].map(([src, broker]) => ({ source: src, broker })),
        eventCount: eventLog.length,
        recentEvents: eventLog.slice(-50),
      });
    }

    // SSE stream
    if (url.pathname === "/events" && method === "GET") {
      const stream = new ReadableStream({
        start(controller) {
          sseClients.add(controller);
          const stateMsg = `data: ${JSON.stringify({ type: "state-sync", subscriptions: [...subscriptions.values()], mappings: [...patientMap.entries()].map(([s,b])=>({source:s,broker:b})) })}\n\n`;
          controller.enqueue(new TextEncoder().encode(": connected\n\n" + stateMsg));
        },
        cancel(controller) {
          sseClients.delete(controller);
        },
      });
      return new Response(stream, {
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        },
      });
    }

    // Token endpoint
    if (url.pathname === "/auth/token" && method === "POST") {
      const token = createMockToken({ sub: "ias-client", patient: "broker-123", scope: "patient/Encounter.read" });
      const body = { access_token: token, token_type: "bearer", expires_in: 3600, patient: "broker-123" };
      pushEvent({ type: "token-issued", detail: "Token issued to IAS client — patient: broker-123", response: body });
      return Response.json(body);
    }

    // Create Subscription
    if (url.pathname === "/fhir/Subscription" && method === "POST") {
      const reqBody = await req.json() as any;
      subCounter++;
      const id = `sub-${subCounter}`;
      const sub = makeSubscription(id, {
        criteria: reqBody.criteria || "Encounter?patient=Patient/broker-123",
        channelEndpoint: CLIENT_WEBHOOK,
        patient: "broker-123",
      });
      subscriptions.set(id, sub);

      pushEvent({
        type: "subscription-created",
        detail: `Subscription/${id} created — monitoring encounters for broker-123`,
        resource: sub,
      });

      return Response.json(sub, { status: 201 });
    }

    // Read Subscription
    if (url.pathname.startsWith("/fhir/Subscription/") && method === "GET") {
      const id = url.pathname.split("/").pop()!;
      const sub = subscriptions.get(id);
      if (!sub) return Response.json({ error: "not found" }, { status: 404 });
      return Response.json(sub);
    }

    // List Subscriptions
    if (url.pathname === "/fhir/Subscription" && method === "GET") {
      const entries = [...subscriptions.values()].map((s) => ({ resource: s }));
      return Response.json({
        resourceType: "Bundle",
        type: "searchset",
        total: entries.length,
        entry: entries,
      });
    }

    // Internal event from Data Source
    if (url.pathname === "/internal/event" && method === "POST") {
      const event = await req.json() as any;
      pushEvent({ type: "event-received", detail: `Event from Data Source: ${event.eventType} for patient ${event.patient}` });

      // Map patient
      const brokerPatient = patientMap.get(event.patient);
      if (!brokerPatient) {
        pushEvent({ type: "patient-no-match", detail: `No mapping for patient ${event.patient}` });
        return Response.json({ matched: false });
      }
      pushEvent({ type: "patient-matched", detail: `Mapped ${event.patient} → ${brokerPatient}` });

      // Find matching subscriptions
      const matched: { id: string; sub: any }[] = [];
      for (const [id, sub] of subscriptions) {
        if ((sub as any).criteria?.includes(brokerPatient)) {
          matched.push({ id, sub });
        }
      }

      if (matched.length === 0) {
        pushEvent({ type: "no-subscriptions", detail: `No active subscriptions for ${brokerPatient}` });
        return Response.json({ matched: false });
      }

      // Deliver notification to each matching subscription
      for (const { id } of matched) {
        const bundle = makeNotificationBundle(id, event.encounter);
        pushEvent({
          type: "notification-sending",
          detail: `Delivering notification for Subscription/${id} → ${CLIENT_WEBHOOK}`,
          resource: bundle,
        });

        try {
          const resp = await fetch(CLIENT_WEBHOOK, {
            method: "POST",
            headers: { "Content-Type": "application/fhir+json" },
            body: JSON.stringify({ ...bundle, _dataSourceBase: event.dataSourceBase }),
          });
          pushEvent({
            type: "notification-delivered",
            detail: `Notification delivered — status ${resp.status}`,
          });
        } catch (e: any) {
          pushEvent({ type: "notification-error", detail: `Delivery failed: ${e.message}` });
        }
      }

      return Response.json({ matched: true, count: matched.length });
    }

    // Patient mappings (for dashboard)
    if (url.pathname === "/patient-mappings" && method === "GET") {
      const mappings = [...patientMap.entries()].map(([src, broker]) => ({ source: src, broker }));
      return Response.json(mappings);
    }

    return Response.json({ error: "not found" }, { status: 404 });
  },
});

console.log(`[Broker] running on :${PORT}`);
