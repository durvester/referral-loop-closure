// Broker handler — no server, just exports handle()
import { makeSubscription, makeNotificationBundle } from "../shared/types";
import { createMockToken, extractPermissionTicket, matchDemographics, decodeMockToken } from "../shared/auth";
import { serviceUrl, internalUrl, injectHtmlConfig, isStatic } from "../config";
import type { HandlerContext } from "../shared/handler-context";

// Dynamic patient registry: brokerId → { name, birthDate, sourceIds: Map<sourceSystem, sourceId> }
const patients: Map<string, { brokerId: string; name: string; birthDate: string }> = new Map();
// Reverse: sourceId → brokerId
const sourceToBroker: Map<string, string> = new Map();

// Subscriptions store
const subscriptions: Map<string, any> = new Map();
let subCounter = 0;

// Event log
const eventLog: any[] = [];

// SSE connections (system-wide broadcast)
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

function randomHex(len: number): string {
  const chars = "0123456789abcdef";
  let out = "";
  for (let i = 0; i < len; i++) out += chars[Math.floor(Math.random() * 16)];
  return out;
}

/** Find patient by demographic match */
function findPatientByDemographics(traits: any): { brokerId: string; name: string; birthDate: string } | null {
  for (const [, p] of patients) {
    if (matchDemographics(traits, p.name, p.birthDate)) return p;
  }
  return null;
}

async function readUiHtml(): Promise<string | null> {
  if (isStatic) return null;
  const { resolve } = await import("path");
  const uiPath = resolve(import.meta.dir, "ui.html");
  return Bun.file(uiPath).text();
}

export async function handle(req: Request, ctx?: HandlerContext): Promise<Response> {
  const f = ctx?.fetch ?? globalThis.fetch;
  const url = new URL(req.url);
  const method = req.method;

  if (url.pathname === "/" && method === "GET") {
    const raw = await readUiHtml();
    if (!raw) return new Response("Not found", { status: 404 });
    return new Response(injectHtmlConfig(raw, "broker"), {
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
  }

  // Admin reset — clear all state
  if (url.pathname === "/admin/reset" && method === "POST") {
    patients.clear();
    sourceToBroker.clear();
    subscriptions.clear();
    subCounter = 0;
    eventLog.length = 0;
    pushEvent({ type: "admin-reset", detail: "All broker state cleared" });
    return Response.json({ ok: true, message: "Broker state cleared" });
  }

  // Admin state — system-wide
  if (url.pathname === "/admin/state" && method === "GET") {
    return Response.json({
      patients: [...patients.values()],
      subscriptions: [...subscriptions.values()],
      mappings: [...sourceToBroker.entries()].map(([src, broker]) => ({ source: src, broker })),
      eventCount: eventLog.length,
      recentEvents: eventLog.slice(-50),
    });
  }

  // SSE — system-wide broadcast
  if (url.pathname === "/events" && method === "GET") {
    const stream = new ReadableStream({
      start(controller) {
        sseClients.add(controller);
        const stateMsg = `data: ${JSON.stringify({
          type: "state-sync",
          patients: [...patients.values()],
          subscriptions: [...subscriptions.values()],
          mappings: [...sourceToBroker.entries()].map(([s, b]) => ({ source: s, broker: b })),
        })}\n\n`;
        controller.enqueue(new TextEncoder().encode(": connected\n\n" + stateMsg));
      },
      cancel(controller) { sseClients.delete(controller); },
    });
    return new Response(stream, {
      headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" },
    });
  }

  // Register patient — called by dashboard to pre-seed the registry
  if (url.pathname === "/register-patient" && method === "POST") {
    const body = await req.json() as any;
    const { sourceId, name, birthDate } = body;

    // Check if patient already registered by demographics
    const existing = findPatientByDemographics({
      resourceType: "Patient",
      name: [{ family: name.split(" ").pop(), given: name.split(" ").slice(0, -1) }],
      birthDate,
    });
    if (existing) {
      sourceToBroker.set(sourceId, existing.brokerId);
      pushEvent({ type: "patient-linked", detail: `Linked source ${sourceId} → existing ${existing.brokerId} (${name})` });
      return Response.json({ brokerId: existing.brokerId });
    }

    const brokerId = `broker-${randomHex(6)}`;
    patients.set(brokerId, { brokerId, name, birthDate });
    sourceToBroker.set(sourceId, brokerId);
    pushEvent({ type: "patient-registered", detail: `Registered ${name} (DOB ${birthDate}): ${sourceId} → ${brokerId}` });
    return Response.json({ brokerId });
  }

  // Token endpoint — SMART Backend Services with Permission Ticket
  if (url.pathname === "/auth/token" && method === "POST") {
    const contentType = req.headers.get("content-type") || "";
    let clientAssertion: string | null = null;

    if (contentType.includes("application/x-www-form-urlencoded")) {
      const text = await req.text();
      const params = new URLSearchParams(text);
      clientAssertion = params.get("client_assertion");
    } else {
      const body = await req.json().catch(() => ({})) as any;
      clientAssertion = body.client_assertion;
    }

    if (!clientAssertion) {
      pushEvent({ type: "token-error", detail: "Missing client_assertion" });
      return Response.json({ error: "invalid_request", error_description: "Missing client_assertion" }, { status: 400 });
    }

    // Decode assertion and extract permission ticket
    const assertionPayload = decodeMockToken(clientAssertion) as any;
    pushEvent({
      type: "assertion-received",
      detail: `Client assertion from ${assertionPayload?.iss || "unknown"}`,
      clientAssertion: clientAssertion,
    });

    const ticket = extractPermissionTicket(clientAssertion);
    if (!ticket?.ticket_context?.subject?.traits) {
      pushEvent({ type: "token-error", detail: "No valid permission ticket in assertion" });
      return Response.json({ error: "invalid_grant", error_description: "No valid permission ticket" }, { status: 400 });
    }

    pushEvent({
      type: "ticket-extracted",
      detail: `Permission ticket from ${ticket.iss}: ${ticket.ticket_context.subject.traits.name[0]?.given?.join(" ")} ${ticket.ticket_context.subject.traits.name[0]?.family}, DOB ${ticket.ticket_context.subject.traits.birthDate}`,
      permissionTickets: assertionPayload.permission_tickets,
      ticketPayload: ticket,
    });

    // Match demographics
    const matched = findPatientByDemographics(ticket.ticket_context.subject.traits);
    if (!matched) {
      pushEvent({
        type: "demographic-match-failed",
        detail: `No patient match for ${ticket.ticket_context.subject.traits.name[0]?.family}, DOB ${ticket.ticket_context.subject.traits.birthDate}`,
      });
      return Response.json({ error: "invalid_grant", error_description: "No patient match" }, { status: 400 });
    }

    pushEvent({
      type: "demographic-match-success",
      detail: `Matched → ${matched.brokerId} (${matched.name}, DOB ${matched.birthDate})`,
    });

    // Issue access token scoped to matched patient
    const grantedScopes = ticket.ticket_context.capability.scopes;
    const token = createMockToken({ sub: assertionPayload?.iss || "ias-client", patient: matched.brokerId, scope: grantedScopes.join(" ") });
    const respBody = { access_token: token, token_type: "bearer", expires_in: 3600, patient: matched.brokerId, scope: grantedScopes.join(" ") };
    pushEvent({ type: "token-issued", detail: `Token issued — patient: ${matched.brokerId}, scopes: ${grantedScopes.join(" ")}` });
    return Response.json(respBody);
  }

  // Create subscription — standard FHIR
  if (url.pathname === "/fhir/Subscription" && method === "POST") {
    const reqBody = await req.json() as any;
    subCounter++;
    const id = `sub-${subCounter}`;
    const patient = reqBody.criteria?.split("Patient/")[1] || "unknown";
    const sub = makeSubscription(id, {
      criteria: reqBody.criteria || "Encounter?patient=Patient/unknown",
      channelEndpoint: reqBody.channel?.endpoint || "ias-client://notifications",
      patient,
    });
    subscriptions.set(id, sub);
    pushEvent({ type: "subscription-created", detail: `Subscription/${id} — monitoring encounters for ${patient}`, resource: sub });
    return Response.json(sub, { status: 201 });
  }

  if (url.pathname.startsWith("/fhir/Subscription/") && method === "GET") {
    const id = url.pathname.split("/").pop()!;
    const sub = subscriptions.get(id);
    if (!sub) return Response.json({ error: "not found" }, { status: 404 });
    return Response.json(sub);
  }

  if (url.pathname === "/fhir/Subscription" && method === "GET") {
    const entries = [...subscriptions.values()].map((s) => ({ resource: s }));
    return Response.json({ resourceType: "Bundle", type: "searchset", total: entries.length, entry: entries });
  }

  // Internal event from Data Source
  if (url.pathname === "/internal/event" && method === "POST") {
    const event = await req.json() as any;
    pushEvent({ type: "event-received", detail: `Event from Data Source: ${event.eventType} for patient ${event.patient}` });

    const brokerPatient = sourceToBroker.get(event.patient);
    if (!brokerPatient) {
      pushEvent({ type: "patient-no-match", detail: `No mapping for source patient ${event.patient}` });
      return Response.json({ matched: false });
    }
    pushEvent({ type: "patient-matched", detail: `Mapped source ${event.patient} → ${brokerPatient}` });

    const matched: { id: string; sub: any }[] = [];
    for (const [id, sub] of subscriptions) {
      if ((sub as any).criteria?.includes(brokerPatient)) matched.push({ id, sub });
    }

    if (matched.length === 0) {
      pushEvent({ type: "no-subscriptions", detail: `No active subscriptions for ${brokerPatient}` });
      return Response.json({ matched: false });
    }

    for (const { id, sub } of matched) {
      const bundle = makeNotificationBundle(id, event.encounter);
      const endpoint = sub.channel?.endpoint;
      const deliveryUrl = endpoint && !endpoint.startsWith("ias-client://")
        ? endpoint
        : `${internalUrl("client")}/notifications`;
      pushEvent({ type: "notification-sending", detail: `Delivering notification for Subscription/${id} → ${deliveryUrl}`, resource: bundle });

      try {
        const resp = await f(deliveryUrl, {
          method: "POST",
          headers: { "Content-Type": "application/fhir+json" },
          body: JSON.stringify(bundle),
        });
        pushEvent({ type: "notification-delivered", detail: `Notification delivered — status ${resp.status}` });
      } catch (e: any) {
        pushEvent({ type: "notification-error", detail: `Delivery failed: ${e.message}` });
      }
    }

    return Response.json({ matched: true, count: matched.length });
  }

  if (url.pathname === "/patient-mappings" && method === "GET") {
    return Response.json([...sourceToBroker.entries()].map(([src, broker]) => {
      const p = patients.get(broker);
      return { source: src, broker, name: p?.name, birthDate: p?.birthDate };
    }));
  }

  return Response.json({ error: "not found" }, { status: 404 });
}
