// IAS Client handler — no server, just exports handle()
import { createPermissionTicket, createClientAssertion } from "../shared/auth";
import { serviceUrl, internalUrl, injectHtmlConfig, isStatic } from "../config";
import type { HandlerContext } from "../shared/handler-context";

const CLIENT_ID = "https://ias-client.example.com";

// --- Per-patient session state (keyed by patient identity: "name|birthDate") ---
interface SessionState {
  patientKey: string;      // "name|birthDate" — the stable identity
  patient: { name: string; birthDate: string };
  permissionTicket: string | null;
  clientAssertion: string | null;
  identity: null | { verified: boolean; name: string; steps: string[] };
  token: null | { access_token: string; patient: string };
  subscriptions: any[];
  notifications: any[];
  encounters: any[];
  events: any[];
}

const sessions: Map<string, SessionState> = new Map();

function getOrCreateSession(patient: { name: string; birthDate: string }): SessionState {
  const key = `${patient.name}|${patient.birthDate}`;
  let s = sessions.get(key);
  if (!s) {
    s = {
      patientKey: key,
      patient,
      permissionTicket: null,
      clientAssertion: null,
      identity: null,
      token: null,
      subscriptions: [],
      notifications: [],
      encounters: [],
      events: [],
    };
    sessions.set(key, s);
  }
  return s;
}

// SSE connections — broadcast all events, dashboard filters client-side
const sseClients: Set<ReadableStreamDefaultController> = new Set();

function pushEvent(session: SessionState | null, data: any) {
  data.timestamp = Date.now();
  if (session) {
    data._patientKey = session.patientKey;
    data._patientName = session.patient.name;
    session.events.push(data);
    if (session.events.length > 200) session.events.shift();
  }
  const msg = `data: ${JSON.stringify(data)}\n\n`;
  for (const c of sseClients) {
    try { c.enqueue(new TextEncoder().encode(msg)); } catch { sseClients.delete(c); }
  }
}

async function readUiHtml(): Promise<string | null> {
  if (isStatic) return null;
  // Dynamic import to avoid referencing Bun/path in browser builds
  const { resolve } = await import("path");
  const uiPath = resolve(import.meta.dir, "ui.html");
  return Bun.file(uiPath).text();
}

export async function handle(req: Request, ctx?: HandlerContext): Promise<Response> {
  const f = ctx?.fetch ?? globalThis.fetch;
  const url = new URL(req.url);
  const method = req.method;

  // Serve UI
  if (url.pathname === "/" && method === "GET") {
    const raw = await readUiHtml();
    if (!raw) return new Response("Not found", { status: 404 });
    return new Response(injectHtmlConfig(raw, "client"), {
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
  }

  // State endpoint — returns state for a specific patient
  if (url.pathname === "/state" && method === "GET") {
    const name = url.searchParams.get("name");
    const birthDate = url.searchParams.get("birthDate");
    if (name && birthDate) {
      const key = `${name}|${birthDate}`;
      const s = sessions.get(key);
      if (s) return Response.json(s);
    }
    // Return all sessions summary
    return Response.json({ sessions: [...sessions.values()].map(s => ({ patientKey: s.patientKey, patient: s.patient, hasToken: !!s.token, subscriptionCount: s.subscriptions.length, encounterCount: s.encounters.length })) });
  }

  // SSE stream — broadcasts all events
  if (url.pathname === "/events" && method === "GET") {
    const stream = new ReadableStream({
      start(controller) {
        sseClients.add(controller);
        // Send current state for all sessions
        const stateMsg = `data: ${JSON.stringify({ type: "state-sync", sessions: [...sessions.values()].map(s => ({ patientKey: s.patientKey, patient: s.patient, identity: s.identity, token: s.token, subscriptions: s.subscriptions, encounters: s.encounters })) })}\n\n`;
        controller.enqueue(new TextEncoder().encode(": connected\n\n" + stateMsg));
      },
      cancel(controller) {
        sseClients.delete(controller);
      },
    });
    return new Response(stream, {
      headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" },
    });
  }

  // ID proofing step events
  if (url.pathname === "/id-proofing/step" && method === "POST") {
    const body = await req.json() as any;
    const session = body.patient ? getOrCreateSession(body.patient) : null;
    const stepNames: Record<string, string> = {
      "phone-sent": "Phone verification code sent",
      "phone-verified": "Phone number verified",
      "license-scanning": "Scanning driver's license...",
      "license-captured": `Driver's license captured — ${body.patient?.name || "Patient"}`,
      "selfie-capturing": "Capturing selfie...",
      "selfie-captured": "Selfie captured — face match 98.7%",
      "verifying": "Cross-referencing identity documents...",
    };
    pushEvent(session, { type: "id-proofing", detail: stepNames[body.step] || body.step, step: body.step });
    return Response.json({ ok: true });
  }

  // ID proofing complete — creates permission ticket, then authenticates
  if (url.pathname === "/id-proofing/complete" && method === "POST") {
    const body = await req.json() as any;
    if (!body.patient?.name || !body.patient?.birthDate) {
      return Response.json({ error: "patient demographics required" }, { status: 400 });
    }
    const session = getOrCreateSession(body.patient);
    session.identity = { verified: true, name: body.patient.name, steps: ["phone", "license", "selfie"] };
    pushEvent(session, { type: "identity-verified", detail: `Identity verified via IAL2 proofing — ${body.patient.name}` });

    // Identity provider issues permission ticket
    const ticket = createPermissionTicket(body.patient, CLIENT_ID);
    session.permissionTicket = ticket;
    pushEvent(session, { type: "permission-ticket-issued", detail: `Permission ticket issued for ${body.patient.name}`, permissionTicket: ticket });

    await doAuthAndSubscribe(session, f);
    return Response.json({ ok: true });
  }

  // Quick auth — dashboard sends patient demographics, we do instant ID proof + auth
  if (url.pathname === "/quick-auth" && method === "POST") {
    const body = await req.json() as any;
    if (!body.patient?.name || !body.patient?.birthDate) {
      return Response.json({ error: "patient demographics required" }, { status: 400 });
    }
    const session = getOrCreateSession(body.patient);
    session.identity = { verified: true, name: body.patient.name, steps: ["auto"] };
    pushEvent(session, { type: "identity-verified", detail: `Identity verified (quick mode) — ${body.patient.name}` });

    // Identity provider issues permission ticket
    const ticket = createPermissionTicket(body.patient, CLIENT_ID);
    session.permissionTicket = ticket;
    pushEvent(session, { type: "permission-ticket-issued", detail: `Permission ticket issued for ${body.patient.name}`, permissionTicket: ticket });

    await doAuthAndSubscribe(session, f);
    return Response.json({
      patient: session.patient,
      identity: session.identity,
      token: session.token,
      subscriptions: session.subscriptions,
      permissionTicket: session.permissionTicket,
    });
  }

  // ID proofing start — auto-advances all steps with delays (for wizard UI)
  if (url.pathname === "/id-proofing/start" && method === "POST") {
    const body = await req.json() as any;
    if (!body.patient?.name || !body.patient?.birthDate) {
      return Response.json({ error: "patient demographics required" }, { status: 400 });
    }
    const session = getOrCreateSession(body.patient);

    // Auto-advance through steps with delays
    const steps = [
      { step: "phone-sent", delay: 0 },
      { step: "phone-verified", delay: 500 },
      { step: "license-scanning", delay: 1000 },
      { step: "license-captured", delay: 1500 },
      { step: "selfie-capturing", delay: 2000 },
      { step: "selfie-captured", delay: 2500 },
      { step: "verifying", delay: 3000 },
    ];

    const stepNames: Record<string, string> = {
      "phone-sent": "Phone verification code sent",
      "phone-verified": "Phone number verified",
      "license-scanning": "Scanning driver's license...",
      "license-captured": `Driver's license captured — ${body.patient.name}`,
      "selfie-capturing": "Capturing selfie...",
      "selfie-captured": "Selfie captured — face match 98.7%",
      "verifying": "Cross-referencing identity documents...",
    };

    for (const { step, delay } of steps) {
      setTimeout(() => {
        pushEvent(session, { type: "id-proofing", detail: stepNames[step], step });
      }, delay);
    }

    // After all steps, complete
    setTimeout(async () => {
      session.identity = { verified: true, name: body.patient.name, steps: ["phone", "license", "selfie"] };
      pushEvent(session, { type: "identity-verified", detail: `Identity verified via IAL2 proofing — ${body.patient.name}` });

      const ticket = createPermissionTicket(body.patient, CLIENT_ID);
      session.permissionTicket = ticket;
      pushEvent(session, { type: "permission-ticket-issued", detail: `Permission ticket issued for ${body.patient.name}`, permissionTicket: ticket });

      await doAuthAndSubscribe(session, f);
    }, 3500);

    return Response.json({ ok: true, status: "auto-advancing" });
  }

  // Webhook — Broker delivers notification bundles here
  if (url.pathname === "/notifications" && method === "POST") {
    const bundle = await req.json() as any;

    // Find which session this notification belongs to by matching subscription
    const statusEntry = bundle.entry?.[0]?.resource;
    const subRef = statusEntry?.subscription?.reference; // "Subscription/sub-1"
    let session: SessionState | null = null;

    // Find the session that owns this subscription
    for (const s of sessions.values()) {
      for (const sub of s.subscriptions) {
        if (subRef && subRef === `Subscription/${sub.id}`) {
          session = s;
          break;
        }
      }
      if (session) break;
    }

    if (session) {
      session.notifications.push({ receivedAt: Date.now(), bundle });
    }
    pushEvent(session, { type: "notification-received", detail: "Notification bundle received from Broker", resource: bundle });

    const events = statusEntry?.notificationEvent || [];

    for (const evt of events) {
      const focusRef = evt.focus?.reference;
      if (!focusRef) continue;
      const fetchUrl = `${internalUrl("dataSource")}/fhir/${focusRef}`;
      pushEvent(session, { type: "fetching-encounter", detail: `Fetching ${focusRef} from Data Source...`, requestUrl: fetchUrl });

      try {
        const tokenResp = await f(`${internalUrl("dataSource")}/auth/token`, { method: "POST" });
        const tokenData = await tokenResp.json() as any;
        const encResp = await f(`${internalUrl("dataSource")}/fhir/${focusRef}`, {
          headers: { Authorization: `Bearer ${tokenData.access_token}` },
        });
        const encounter = await encResp.json() as any;
        if (session) session.encounters.push(encounter);
        pushEvent(session, {
          type: "encounter-fetched",
          detail: `Retrieved ${focusRef} — ${encounter.type?.[0]?.coding?.[0]?.display || "Encounter"} at ${encounter.serviceProvider?.display || "Unknown"}`,
          resource: encounter,
        });
      } catch (e: any) {
        pushEvent(session, { type: "fetch-error", detail: `Failed to fetch ${focusRef}: ${e.message}` });
      }
    }
    return Response.json({ ok: true });
  }

  return Response.json({ error: "not found" }, { status: 404 });
}

async function doAuthAndSubscribe(session: SessionState, f: typeof globalThis.fetch) {
  try {
    if (!session.permissionTicket) {
      pushEvent(session, { type: "error", detail: "No permission ticket available" });
      return;
    }

    // Create client assertion with embedded permission ticket
    const assertion = createClientAssertion(CLIENT_ID, serviceUrl("broker"), session.permissionTicket);
    session.clientAssertion = assertion;
    pushEvent(session, { type: "client-assertion-created", detail: "Client assertion created with embedded permission ticket", clientAssertion: assertion });

    // Authenticate with broker using SMART Backend Services flow
    const tokenResp = await f(`${internalUrl("broker")}/auth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "client_credentials",
        client_assertion_type: "urn:ietf:params:oauth:client-assertion-type:jwt-bearer",
        client_assertion: assertion,
      }).toString(),
    });

    if (!tokenResp.ok) {
      const errorText = await tokenResp.text();
      // Truncate error text to avoid overly long error messages in UI
      pushEvent(session, { type: "error", detail: `Auth failed: HTTP ${tokenResp.status} - ${errorText.slice(0, 100)}` });
      return;
    }

    const tokenData = await tokenResp.json() as any;

    if (tokenData.error) {
      pushEvent(session, { type: "error", detail: `Auth failed: ${tokenData.error_description || tokenData.error}` });
      return;
    }

    // Client learns brokerId from the token response — this is how it discovers the broker's identifier
    session.token = { access_token: tokenData.access_token, patient: tokenData.patient };
    pushEvent(session, { type: "authenticated", detail: `Authenticated to Broker — patient context: ${tokenData.patient}`, response: tokenData });

    // Subscribe using the brokerId learned from token response
    const subResp = await f(`${internalUrl("broker")}/fhir/Subscription`, {
      method: "POST",
      headers: { "Content-Type": "application/fhir+json", Authorization: `Bearer ${tokenData.access_token}` },
      body: JSON.stringify({
        resourceType: "Subscription",
        criteria: "Encounter?patient=Patient/" + tokenData.patient,
        channel: { type: "rest-hook", endpoint: "ias-client://notifications", payload: "application/fhir+json" },
      }),
    });
    const sub = await subResp.json() as any;
    session.subscriptions.push(sub);
    pushEvent(session, { type: "subscribed", detail: `Subscription ${sub.id} created — monitoring encounters for ${tokenData.patient}`, resource: sub });
  } catch (e: any) {
    pushEvent(session, { type: "error", detail: `Auth/subscribe failed: ${e.message}` });
  }
}
