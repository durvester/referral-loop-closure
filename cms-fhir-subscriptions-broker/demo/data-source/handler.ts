// Data Source — Mercy EHR handler — no server, just exports handle()
import { makeEncounter, makePatient, ENCOUNTER_CLASSES, ENCOUNTER_TYPES, REASON_CODES } from "../shared/types";
import type { EncounterOptions } from "../shared/types";
import { createMockToken } from "../shared/auth";
import { serviceUrl, internalUrl, injectHtmlConfig, isStatic } from "../config";
import type { HandlerContext } from "../shared/handler-context";

// Dynamic patient registry (MPI): sourceId → { name, birthDate, resource }
const patients: Map<string, { sourceId: string; name: string; birthDate: string; resource: any }> = new Map();

// Encounters: id → { encounter, sourceId }
const encounters: Map<string, { encounter: any; sourceId: string }> = new Map();
let encounterCounter = 0;

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
    return new Response(injectHtmlConfig(raw, "dataSource"), {
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
  }

  // Admin reset — clear all state
  if (url.pathname === "/admin/reset" && method === "POST") {
    patients.clear();
    encounters.clear();
    encounterCounter = 0;
    eventLog.length = 0;
    pushEvent({ type: "admin-reset", detail: "All EHR state cleared" });
    return Response.json({ ok: true, message: "EHR state cleared" });
  }

  // Admin state — system-wide MPI view
  if (url.pathname === "/admin/state" && method === "GET") {
    return Response.json({
      patients: [...patients.values()].map(p => ({ sourceId: p.sourceId, name: p.name, birthDate: p.birthDate, encounterCount: [...encounters.values()].filter(e => e.sourceId === p.sourceId).length })),
      encounters: [...encounters.values()].map(e => {
        const enc = e.encounter as any;
        return {
          id: enc.id,
          sourceId: e.sourceId,
          patient: patients.get(e.sourceId)?.name,
          status: enc.status,
          classCode: enc.class?.code,
          classDisplay: enc.class?.display,
          typeDisplay: enc.type?.[0]?.coding?.[0]?.display,
          reasonDisplay: enc.reasonCode?.[0]?.coding?.[0]?.display,
          periodStart: enc.period?.start,
        };
      }),
      eventCount: eventLog.length,
    });
  }

  // SSE — system-wide broadcast
  if (url.pathname === "/events" && method === "GET") {
    const stream = new ReadableStream({
      start(controller) {
        sseClients.add(controller);
        const stateMsg = `data: ${JSON.stringify({
          type: "state-sync",
          patients: [...patients.values()].map(p => ({ sourceId: p.sourceId, name: p.name, birthDate: p.birthDate })),
          encounters: [...encounters.values()].map(e => e.encounter),
        })}\n\n`;
        controller.enqueue(new TextEncoder().encode(": connected\n\n" + stateMsg));
      },
      cancel(controller) { sseClients.delete(controller); },
    });
    return new Response(stream, {
      headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" },
    });
  }

  // Register patient — called by dashboard to pre-seed the MPI
  if (url.pathname === "/register-patient" && method === "POST") {
    const body = await req.json() as any;
    const { name, birthDate } = body;

    // Check if already registered by demographics
    for (const [, p] of patients) {
      if (p.name === name && p.birthDate === birthDate) {
        pushEvent({ type: "patient-found", detail: `Patient ${name} already registered as ${p.sourceId}` });
        return Response.json({ sourceId: p.sourceId });
      }
    }

    const sourceId = `mercy-${randomHex(6)}`;
    const resource = makePatient(sourceId, name, birthDate);
    patients.set(sourceId, { sourceId, name, birthDate, resource });
    pushEvent({ type: "patient-registered", detail: `Registered ${name} (DOB ${birthDate}) as ${sourceId}` });
    return Response.json({ sourceId });
  }

  if (url.pathname === "/auth/token" && method === "POST") {
    const token = createMockToken({ sub: "data-source", scope: "system/*.read" });
    const body = { access_token: token, token_type: "bearer", expires_in: 3600 };
    pushEvent({ type: "token-issued", detail: "Access token issued to client" });
    return Response.json(body);
  }

  // FHIR Encounter read
  if (url.pathname.startsWith("/fhir/Encounter/") && method === "GET") {
    const id = url.pathname.split("/").pop()!;
    const entry = encounters.get(id);
    if (!entry) return Response.json({ error: "not found" }, { status: 404 });
    pushEvent({ type: "encounter-read", detail: `Encounter/${id} read by client` });
    return Response.json(entry.encounter);
  }

  // FHIR Patient read
  if (url.pathname.startsWith("/fhir/Patient/") && method === "GET") {
    const id = url.pathname.split("/").pop()!;
    const p = patients.get(id);
    if (!p) return Response.json({ error: "not found" }, { status: 404 });
    return Response.json(p.resource);
  }

  // Trigger event — dashboard sends patient demographics + encounter options
  if (url.pathname === "/trigger-event" && method === "POST") {
    const body = await req.json() as any;
    const { patient, encounterOptions } = body;

    // Find patient by demographics
    let sourceId: string | null = null;
    if (patient?.name && patient?.birthDate) {
      for (const [, p] of patients) {
        if (p.name === patient.name && p.birthDate === patient.birthDate) {
          sourceId = p.sourceId;
          break;
        }
      }
    }

    if (!sourceId) {
      // Auto-register if not found
      sourceId = `mercy-${randomHex(6)}`;
      const resource = makePatient(sourceId, patient?.name || "Unknown", patient?.birthDate);
      patients.set(sourceId, { sourceId, name: patient?.name || "Unknown", birthDate: patient?.birthDate || "unknown", resource });
      pushEvent({ type: "patient-auto-registered", detail: `Auto-registered ${patient?.name} as ${sourceId}` });
    }

    const patientInfo = patients.get(sourceId)!;
    const opts: EncounterOptions = encounterOptions || {};
    let id: string;
    let eventType: string;

    // Check if this is an update to an existing encounter
    if (body.encounterId && encounters.has(body.encounterId)) {
      id = body.encounterId;
      const existing = encounters.get(id)!;
      const updated = { ...existing.encounter, status: opts.status || existing.encounter.status };
      encounters.set(id, { encounter: updated, sourceId: existing.sourceId });
      eventType = "encounter-updated";

      const classDisplay = ENCOUNTER_CLASSES[opts.classCode || "EMER"]?.display || "emergency";
      const statusLabel = opts.status || updated.status;
      pushEvent({ type: "encounter-updated", detail: `Encounter/${id} updated to ${statusLabel} for ${patientInfo.name}`, resource: updated, sourceId });
    } else {
      // Create new encounter
      encounterCounter++;
      id = `enc-${encounterCounter}`;
      const encounter = makeEncounter(id, sourceId, patientInfo.name, opts);
      encounters.set(id, { encounter, sourceId });
      eventType = "encounter-created";

      const classDisplay = ENCOUNTER_CLASSES[opts.classCode || "EMER"]?.display || "emergency";
      const typeDisplay = ENCOUNTER_TYPES[opts.typeCode || "50849002"]?.text || "ED visit";
      const statusLabel = opts.status === "planned" ? "planned" : "in-progress";
      pushEvent({ type: "encounter-created", detail: `Encounter/${id} created — ${typeDisplay} (${classDisplay}, ${statusLabel}) for ${patientInfo.name}`, resource: encounter, sourceId });
    }

    // Push to Broker via HTTP
    try {
      const resp = await f(`${internalUrl("broker")}/internal/event`, {
        method: "POST",
        headers: { "Content-Type": "application/fhir+json" },
        body: JSON.stringify({
          eventType: "encounter-start",
          patient: sourceId,
          encounter: `Encounter/${id}`,
          dataSourceBase: internalUrl("dataSource"),
        }),
      });
      pushEvent({ type: "event-sent", detail: `Event sent to Broker — status ${resp.status}` });
    } catch (e: any) {
      pushEvent({ type: "event-error", detail: `Failed to reach Broker: ${e.message}` });
    }

    return Response.json({ ok: true, encounterId: id, sourceId });
  }

  return Response.json({ error: "not found" }, { status: 404 });
}
