// Data Source — Mercy EHR (:3003)
import { makeEncounter, makePatient } from "../shared/types";
import { createMockToken } from "../shared/auth";

const PORT = 3003;
const BROKER_INTERNAL = "http://localhost:3002";

// Pre-seeded data
const patient = makePatient("mercy-pat-5678", "Jane Doe");
const encounters: Map<string, object> = new Map();
let encounterCounter = 0;

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

// EHR Admin UI
const ehrHtml = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Mercy General EHR</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    background: #0a1a10;
    color: #e0e0e0;
    min-height: 100vh;
  }
  header {
    background: #1a3c2a;
    padding: 16px 24px;
    border-bottom: 2px solid #27ae60;
    display: flex;
    align-items: center;
    gap: 16px;
  }
  header h1 { font-size: 1.3rem; color: #82e0aa; }
  header .subtitle { font-size: 0.85rem; color: #27ae60; }
  .container {
    max-width: 900px;
    margin: 24px auto;
    padding: 0 16px;
  }
  .grid2 { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
  .card {
    background: rgba(255,255,255,0.05);
    border: 1px solid rgba(39,174,96,0.3);
    border-radius: 8px;
    padding: 16px;
    margin-bottom: 16px;
  }
  .card h2 { font-size: 0.85rem; margin-bottom: 12px; color: #82e0aa; text-transform: uppercase; letter-spacing: 0.5px; }
  .patient-banner {
    background: rgba(39,174,96,0.1);
    border: 1px solid rgba(39,174,96,0.3);
    border-radius: 8px;
    padding: 16px;
    margin-bottom: 16px;
    display: flex;
    align-items: center;
    gap: 16px;
  }
  .patient-avatar {
    width: 48px; height: 48px;
    border-radius: 50%;
    background: #27ae60;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 1.5rem;
    font-weight: 700;
    color: #fff;
  }
  .patient-info .name { font-size: 1.2rem; font-weight: 600; }
  .patient-info .detail { font-size: 0.85rem; color: #82e0aa; }
  table { width: 100%; border-collapse: collapse; font-size: 0.85rem; }
  th { text-align: left; color: #8899aa; font-size: 0.75rem; text-transform: uppercase; padding: 6px 8px; border-bottom: 1px solid rgba(255,255,255,0.1); }
  td { padding: 6px 8px; border-bottom: 1px solid rgba(255,255,255,0.05); }
  .tag { padding: 2px 8px; border-radius: 10px; font-size: 0.7rem; font-weight: 600; }
  .tag-active { background: rgba(39,174,96,0.2); color: #2ecc71; }
  .tag-emer { background: rgba(231,76,60,0.2); color: #e74c3c; }
  button {
    border: none;
    padding: 10px 20px;
    border-radius: 6px;
    cursor: pointer;
    font-size: 0.9rem;
    font-weight: 600;
    transition: all 0.2s;
  }
  button:hover { opacity: 0.9; }
  .btn-green { background: #27ae60; color: #fff; }
  .btn-red { background: #e74c3c; color: #fff; }
  .log-entry {
    padding: 6px 8px;
    border-bottom: 1px solid rgba(255,255,255,0.05);
    font-size: 0.82rem;
    animation: fadeIn 0.3s;
  }
  @keyframes fadeIn { from { opacity: 0; } to { opacity: 1; } }
  .log-time { color: #666; font-size: 0.72rem; float: right; }
  .log-type { font-weight: 600; color: #82e0aa; font-size: 0.75rem; text-transform: uppercase; }
  .log-detail { color: #bbb; }
  #log-container { max-height: 400px; overflow-y: auto; }
  .stat { font-size: 2rem; font-weight: 700; color: #82e0aa; }
  .stat-label { font-size: 0.8rem; color: #889; }
  details summary { cursor: pointer; font-size: 0.8rem; color: #27ae60; }
  details pre {
    background: rgba(0,0,0,0.4); padding: 8px; border-radius: 4px;
    font-size: 0.72rem; overflow-x: auto; margin-top: 4px; color: #bdb;
    max-height: 200px; overflow-y: auto;
  }
</style>
</head>
<body>
<header>
  <h1>Mercy General EHR</h1>
  <span class="subtitle">Electronic Health Record System</span>
</header>
<div class="container">
  <div class="patient-banner">
    <div class="patient-avatar">JD</div>
    <div class="patient-info">
      <div class="name">Jane Doe</div>
      <div class="detail">MRN: mercy-pat-5678 | DOB: 1985-03-15 | Female</div>
    </div>
  </div>

  <div class="grid2">
    <div class="card">
      <h2>Quick Actions</h2>
      <div style="display:flex; gap:8px; flex-wrap:wrap;">
        <button class="btn-red" onclick="admitToED()">Admit to ED</button>
        <button class="btn-green" onclick="admitToED()">Create Encounter</button>
      </div>
    </div>
    <div class="card">
      <h2>Stats</h2>
      <div style="display:flex; gap:24px;">
        <div><div class="stat" id="stat-encounters">0</div><div class="stat-label">Encounters</div></div>
        <div><div class="stat" id="stat-reads">0</div><div class="stat-label">API Reads</div></div>
      </div>
    </div>
  </div>

  <div class="card">
    <h2>Encounters</h2>
    <table>
      <tr><th>ID</th><th>Type</th><th>Status</th><th>Created</th></tr>
      <tbody id="enc-body"><tr><td colspan="4" style="color:#666;">No encounters yet</td></tr></tbody>
    </table>
  </div>

  <div class="card">
    <h2>Event Log (live tail)</h2>
    <div id="log-container"></div>
  </div>
</div>
<script>
let encounterCount = 0;
let readCount = 0;

async function admitToED() {
  const resp = await fetch("/trigger-event", { method: "POST" });
  const data = await resp.json();
}

const es = new EventSource("/events");
es.onmessage = (e) => {
  try {
    const data = JSON.parse(e.data);
    if (data.type === "state-sync") return;
    const container = document.getElementById("log-container");
    const div = document.createElement("div");
    div.className = "log-entry";
    const time = new Date(data.timestamp || Date.now()).toLocaleTimeString();
    div.innerHTML = '<span class="log-time">' + time + '</span>' +
      '<div class="log-type">' + (data.type || "event") + '</div>' +
      '<div class="log-detail">' + (data.detail || "") + '</div>' +
      (data.resource ? '<details><summary>FHIR JSON</summary><pre>' + JSON.stringify(data.resource, null, 2) + '</pre></details>' : '');
    container.prepend(div);

    if (data.type === "encounter-created") {
      encounterCount++;
      document.getElementById("stat-encounters").textContent = encounterCount;
      updateEncounterTable(data.resource);
    }
    if (data.type === "encounter-read") {
      readCount++;
      document.getElementById("stat-reads").textContent = readCount;
    }
  } catch {}
};

function updateEncounterTable(enc) {
  const tbody = document.getElementById("enc-body");
  if (tbody.querySelector("td[colspan]")) tbody.innerHTML = "";
  const tr = document.createElement("tr");
  tr.innerHTML = "<td>" + enc.id + "</td><td><span class='tag tag-emer'>EMER</span> ED Visit</td><td><span class='tag tag-active'>in-progress</span></td><td>" + new Date().toLocaleTimeString() + "</td>";
  tbody.prepend(tr);
}
</script>
</body>
</html>`;

const server = Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);
    const method = req.method;

    // Serve EHR UI
    if (url.pathname === "/" && method === "GET") {
      return new Response(ehrHtml, { headers: { "Content-Type": "text/html; charset=utf-8" } });
    }

    // State endpoint
    if (url.pathname === "/admin/state" && method === "GET") {
      return Response.json({
        patient,
        encounters: [...encounters.values()],
        eventCount: eventLog.length,
      });
    }

    // SSE stream
    if (url.pathname === "/events" && method === "GET") {
      const stream = new ReadableStream({
        start(controller) {
          sseClients.add(controller);
          const stateMsg = `data: ${JSON.stringify({ type: "state-sync", encounters: [...encounters.values()] })}\n\n`;
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

    // Mock token endpoint
    if (url.pathname === "/auth/token" && method === "POST") {
      const token = createMockToken({ sub: "data-source", scope: "system/*.read" });
      const body = { access_token: token, token_type: "bearer", expires_in: 3600 };
      pushEvent({ type: "token-issued", detail: "Access token issued to client" });
      return Response.json(body);
    }

    // Read encounter
    if (url.pathname.startsWith("/fhir/Encounter/") && method === "GET") {
      const id = url.pathname.split("/").pop()!;
      const enc = encounters.get(id);
      if (!enc) return Response.json({ error: "not found" }, { status: 404 });
      pushEvent({ type: "encounter-read", detail: `Encounter/${id} read by client` });
      return Response.json(enc);
    }

    // Patient read
    if (url.pathname === "/fhir/Patient/mercy-pat-5678" && method === "GET") {
      return Response.json(patient);
    }

    // Trigger event — creates Encounter, pushes to Broker
    if (url.pathname === "/trigger-event" && method === "POST") {
      encounterCounter++;
      const id = `enc-${encounterCounter}`;
      const encounter = makeEncounter(id, "mercy-pat-5678");
      encounters.set(id, encounter);

      pushEvent({
        type: "encounter-created",
        detail: `Encounter/${id} created — ED visit for Jane Doe`,
        resource: encounter,
      });

      // Push to Broker's internal endpoint
      try {
        const resp = await fetch(`${BROKER_INTERNAL}/internal/event`, {
          method: "POST",
          headers: { "Content-Type": "application/fhir+json" },
          body: JSON.stringify({
            eventType: "encounter-start",
            patient: "mercy-pat-5678",
            encounter: `Encounter/${id}`,
            dataSourceBase: "http://localhost:3003",
          }),
        });
        pushEvent({
          type: "event-sent",
          detail: `Event sent to Broker — status ${resp.status}`,
        });
      } catch (e: any) {
        pushEvent({ type: "event-error", detail: `Failed to reach Broker: ${e.message}` });
      }

      return Response.json({ ok: true, encounterId: id });
    }

    return Response.json({ error: "not found" }, { status: 404 });
  },
});

console.log(`[Data Source] Mercy EHR running on :${PORT}`);
