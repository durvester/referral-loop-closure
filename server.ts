import { config, brokerUrl, ehrUrl } from "./config";
import { handlePatientRequest } from "./portal/handler";
import { handlePhysicianRequest } from "./physician/handler";
import { triggerEncounterAtEhr, fetchEncounterFromEhr } from "./portal/broker-client";
import { processEncounter } from "./portal/routing";
import { seedDemoData } from "./shared/seed";
import { seedDemoReferral } from "./shared/seed";
import { clearAllStores, onboardingStates, encounters } from "./store";

// Track the last cardiology encounter ID so "Start Encounter" updates
// the same encounter created by "Schedule Appointment" instead of creating a new one.
let lastCardioEncounterId: string | null = null;

// Landing page HTML (inline)
function landingPageHtml(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Referral Loop Closure - Demo</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif; background: #f8fafc; color: #1e293b; line-height: 1.6; }
    .container { max-width: 800px; margin: 0 auto; padding: 2rem; }
    h1 { font-size: 1.875rem; font-weight: 700; margin-bottom: 0.5rem; }
    .subtitle { color: #64748b; margin-bottom: 2rem; }
    .card { background: white; border-radius: 12px; padding: 1.5rem; margin-bottom: 1rem; box-shadow: 0 1px 3px rgba(0,0,0,0.1); }
    .card h2 { font-size: 1.25rem; margin-bottom: 0.75rem; }
    .links { display: flex; gap: 1rem; margin-bottom: 2rem; }
    .links a { display: block; flex: 1; text-align: center; padding: 1rem; background: white; border-radius: 12px; text-decoration: none; color: #1e293b; box-shadow: 0 1px 3px rgba(0,0,0,0.1); transition: box-shadow 0.2s; font-weight: 600; }
    .links a:hover { box-shadow: 0 4px 12px rgba(0,0,0,0.15); }
    .links a.physician { border-top: 4px solid #3b82f6; }
    .links a.patient { border-top: 4px solid #10b981; }
    button { padding: 0.75rem 1.5rem; border: none; border-radius: 8px; font-size: 0.875rem; font-weight: 600; cursor: pointer; margin: 0.25rem; transition: background 0.2s; }
    .btn-blue { background: #3b82f6; color: white; }
    .btn-blue:hover { background: #2563eb; }
    .btn-green { background: #10b981; color: white; }
    .btn-green:hover { background: #059669; }
    .btn-amber { background: #f59e0b; color: white; }
    .btn-amber:hover { background: #d97706; }
    .btn-red { background: #ef4444; color: white; }
    .btn-red:hover { background: #dc2626; }
    .btn-gray { background: #6b7280; color: white; }
    .btn-gray:hover { background: #4b5563; }
    #log { background: #1e293b; color: #e2e8f0; padding: 1rem; border-radius: 8px; font-family: monospace; font-size: 0.8rem; max-height: 300px; overflow-y: auto; margin-top: 1rem; }
    .log-entry { padding: 0.25rem 0; border-bottom: 1px solid #334155; }
    .log-time { color: #64748b; }
    .log-ok { color: #34d399; }
    .log-err { color: #f87171; }
  </style>
</head>
<body>
<div class="container">
  <h1>Referral Loop Closure POC</h1>
  <p class="subtitle">FHIR Subscriptions-based referral tracking with patient consent</p>

  <div class="links">
    <a href="/physician/ui" class="physician">Physician EHR Dashboard</a>
    <a href="/patient/ui" class="patient">Patient Portal</a>
  </div>

  <div class="card">
    <h2>Demo Setup</h2>
    <p>Initialize seed data (patient, providers, and cardiology referral). Then open the Patient Portal to complete onboarding.</p>
    <div style="margin-top: 1rem">
      <button class="btn-blue" onclick="setupDemo()">Seed Data</button>
      <button class="btn-gray" onclick="resetDemo()">Reset</button>
    </div>
  </div>

  <div class="card">
    <h2>Simulate Encounters at Mercy General</h2>
    <p style="margin-bottom: 0.75rem">These buttons simulate real events at Josh's EHR. The broker delivers notifications to both the Patient Portal and the Physician Dashboard.</p>
    <div style="background:#f0fdf4;border:1px solid #dcfce7;border-radius:8px;padding:1rem;margin-bottom:0.75rem">
      <div style="font-weight:700;font-size:0.8rem;color:#15803d;margin-bottom:0.5rem">Referral: Cardiology Consultation for Chest Pain</div>
      <p style="font-size:0.8rem;color:#475569;margin-bottom:0.75rem">Alice's open referral to Mercy General &mdash; Dr. Sarah Johnson, Cardiovascular Disease. These encounters will match the referral and update the tracking task.</p>
      <button class="btn-green" onclick="triggerEvent('schedule-appointment')">1. Schedule Cardiology Appointment</button>
      <button class="btn-amber" onclick="triggerEvent('start-encounter')">2. Begin Cardiology Encounter</button>
    </div>
    <div style="background:#eff6ff;border:1px solid #dbeafe;border-radius:8px;padding:1rem">
      <div style="font-weight:700;font-size:0.8rem;color:#1d4ed8;margin-bottom:0.5rem">Ad-hoc: Unrelated Visit</div>
      <p style="font-size:0.8rem;color:#475569;margin-bottom:0.75rem">Alice visits a psychiatrist at Mercy General &mdash; Dr. Maria Chen. This encounter does <strong>not</strong> match any open referral, so it appears in the Patient Portal only (unless sharing is set to "all encounters").</p>
      <button class="btn-blue" onclick="triggerEvent('psychiatrist-visit')">Psychiatrist Visit (Dr. Chen)</button>
    </div>
  </div>

  <div class="card">
    <h2>Event Log</h2>
    <div id="log"><div class="log-entry"><span class="log-time">[ready]</span> Click "Setup Demo" to begin</div></div>
  </div>
</div>

<script>
const BASE = "";
function log(msg, type) {
  const el = document.getElementById("log");
  const time = new Date().toLocaleTimeString();
  const cls = type === "ok" ? "log-ok" : type === "err" ? "log-err" : "";
  el.innerHTML += '<div class="log-entry"><span class="log-time">[' + time + ']</span> <span class="' + cls + '">' + msg + '</span></div>';
  el.scrollTop = el.scrollHeight;
}

async function setupDemo() {
  log("Seeding demo data...");
  try {
    let r = await fetch(BASE + "/api/seed", { method: "POST" });
    let d = await r.json();
    log("Seed complete: " + JSON.stringify(d), "ok");
    log("Now open the Patient Portal to complete onboarding.", "ok");
  } catch(e) { log("Setup failed: " + e.message, "err"); }
}

async function resetDemo() {
  const r = await fetch(BASE + "/api/reset", { method: "POST" });
  log("Demo reset", "ok");
}

async function triggerEvent(type) {
  log("Triggering: " + type + "...");
  try {
    const r = await fetch(BASE + "/api/trigger", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type }),
    });
    const d = await r.json();
    if (d.error) { log("Trigger failed: " + d.error, "err"); return; }
    log("Event triggered: " + JSON.stringify(d), "ok");
  } catch(e) { log("Trigger failed: " + e.message, "err"); }
}
</script>
</body>
</html>`;
}

const server = Bun.serve({
  port: config.port,
  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname;
    const method = req.method;

    // CORS headers
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
    };

    if (method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    try {
      let response: Response;

      // Landing page
      if (path === "/" || path === "/index.html") {
        response = new Response(landingPageHtml(), { headers: { "Content-Type": "text/html" } });
      }
      // Patient portal routes
      else if (path.startsWith("/patient/")) {
        const subPath = path.replace("/patient", "");
        if (subPath === "/ui" || subPath === "/ui.html") {
          try {
            const file = Bun.file(import.meta.dir + "/portal/ui.html");
            response = new Response(file, { headers: { "Content-Type": "text/html" } });
          } catch {
            response = new Response("<h1>Patient Portal UI</h1><p>UI file not yet created.</p>", { headers: { "Content-Type": "text/html" } });
          }
        } else {
          response = await handlePatientRequest(req, subPath);
        }
      }
      // Physician dashboard routes
      else if (path.startsWith("/physician/")) {
        const subPath = path.replace("/physician", "");
        if (subPath === "/ui" || subPath === "/ui.html") {
          try {
            const file = Bun.file(import.meta.dir + "/physician/ui.html");
            response = new Response(file, { headers: { "Content-Type": "text/html" } });
          } catch {
            response = new Response("<h1>Physician Dashboard</h1><p>UI file not yet created.</p>", { headers: { "Content-Type": "text/html" } });
          }
        } else {
          response = await handlePhysicianRequest(req, subPath);
        }
      }
      // Notification webhook (from broker)
      // The broker delivers encounter notifications here. We fetch the full
      // encounter from Josh's EHR, then process it through our matching/routing
      // pipeline. Patient ID cross-referencing happens inside processEncounter.
      else if (path === "/notifications" && method === "POST") {
        const bundle = await req.json() as any;
        const statusEntry = bundle?.entry?.[0]?.resource;
        const events = statusEntry?.notificationEvent || [];

        console.log(`[notifications] Received ${events.length} event(s) from broker`);

        const results = [];
        for (const evt of events) {
          const focusRef = evt.focus?.reference;
          if (!focusRef) continue;

          try {
            // Fetch full encounter from Josh's EHR
            const encounter = await fetchEncounterFromEhr(focusRef);
            console.log(`[notifications] Fetched ${focusRef}: status=${encounter.status}, ` +
              `subject=${encounter.subject?.reference}, ` +
              `serviceProvider=${encounter.serviceProvider?.display}`);

            // Process through matching/routing pipeline
            // (processEncounter handles patient ID cross-referencing via brokerSessions)
            const result = processEncounter(encounter);
            console.log(`[notifications] Processed ${focusRef}: ` +
              `patientId=${result.patientId}, matched=${!!result.bestMatch}, ` +
              `score=${result.bestMatch?.score?.toFixed(2) || 'n/a'}, routed=${result.routed}, ` +
              `reason="${result.reason}"`);
            results.push(result);
          } catch (e: any) {
            console.error(`[notifications] Failed to fetch ${focusRef}:`, e.message);
          }
        }

        response = Response.json({ ok: true, processed: results.length, results });
      }
      // API: seed demo data
      else if (path === "/api/seed" && method === "POST") {
        seedDemoData();
        seedDemoReferral();
        response = Response.json({ ok: true, message: "Demo data seeded (patient, providers, referral)" });
      }
      // API: reset — clears local state AND broker/EHR state
      else if (path === "/api/reset" && method === "POST") {
        clearAllStores();
        lastCardioEncounterId = null;
        // Also reset broker and EHR so subscriptions/patients don't linger
        const brokerReset = fetch(brokerUrl("/admin/reset"), { method: "POST" }).catch(() => null);
        const ehrReset = fetch(ehrUrl("/admin/reset"), { method: "POST" }).catch(() => null);
        await Promise.all([brokerReset, ehrReset]);
        response = Response.json({ ok: true, message: "All stores cleared (app + broker + EHR)" });
      }
      // API: trigger events for demo
      //
      // Triggers encounters at Josh's EHR (Mercy General Hospital).
      // The EHR creates the encounter → notifies the broker → broker delivers
      // to our /notifications webhook (using the subscription's channel.endpoint).
      else if (path === "/api/trigger" && method === "POST") {
        const body = await req.json() as any;
        const patient = { name: "Alice M Rodriguez", birthDate: "1987-04-12" };

        const triggerOptions: Record<string, { classCode: string; typeCode: string; reasonCode?: string; status: string; practitionerNpi?: string; practitionerDisplay?: string; label: string }> = {
          "schedule-appointment": { classCode: "AMB", typeCode: "281036007", reasonCode: "29857009", status: "planned",
            practitionerNpi: "9876543210", practitionerDisplay: "Dr. Sarah Johnson",
            label: "Cardiology appointment scheduled at Mercy General" },
          "start-encounter": { classCode: "AMB", typeCode: "281036007", reasonCode: "29857009", status: "in-progress",
            practitionerNpi: "9876543210", practitionerDisplay: "Dr. Sarah Johnson",
            label: "Cardiology encounter started at Mercy General" },
          "psychiatrist-visit": { classCode: "AMB", typeCode: "281036007", reasonCode: "25064002", status: "planned",
            practitionerNpi: "5555555555", practitionerDisplay: "Dr. Maria Chen",
            label: "Psychiatrist visit at Mercy General" },
        };

        const opts = triggerOptions[body.type];
        if (!opts) {
          response = Response.json({ error: "Unknown trigger type" }, { status: 400 });
        } else {
          try {
            // For "start-encounter", update the existing encounter instead of creating a new one
            const encounterId = body.type === "start-encounter" ? lastCardioEncounterId ?? undefined : undefined;

            const result = await triggerEncounterAtEhr(patient, {
              classCode: opts.classCode,
              typeCode: opts.typeCode,
              reasonCode: opts.reasonCode,
              status: opts.status,
              practitionerNpi: opts.practitionerNpi,
              practitionerDisplay: opts.practitionerDisplay,
              encounterId,
            });

            // Track cardiology encounter ID for subsequent "start-encounter" updates
            if (body.type === "schedule-appointment") {
              lastCardioEncounterId = result.encounterId;
            }

            const action = encounterId ? "Updated" : "Created";
            console.log(`[trigger] ${action} ${result.encounterId} at EHR (${opts.label})`);
            console.log(`[trigger] Broker will deliver notification to our /notifications webhook`);
            response = Response.json({ ok: true, ...result, type: opts.label });
          } catch (e: any) {
            response = Response.json({ error: e.message }, { status: 500 });
          }
        }
      }
      // 404
      else {
        response = Response.json({ error: "Not found" }, { status: 404 });
      }

      // Add CORS headers to response
      for (const [key, value] of Object.entries(corsHeaders)) {
        response.headers.set(key, value);
      }
      return response;
    } catch (e: any) {
      console.error("[server] Error:", e);
      return Response.json({ error: e.message }, { status: 500 });
    }
  },
});

console.log(`Referral Loop Closure app running at http://localhost:${config.port}`);
console.log(`  Landing page: http://localhost:${config.port}/`);
console.log(`  Patient portal: http://localhost:${config.port}/patient/ui`);
console.log(`  Physician dashboard: http://localhost:${config.port}/physician/ui`);
