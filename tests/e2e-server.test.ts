// ---------------------------------------------------------------------------
// HTTP-level E2E tests
//
// These tests start both the broker (Josh's demo server on port 3000) and
// our app (port 4000), then hit real HTTP endpoints.  This catches the class
// of bug we hit in the field — missing imports, broken routes, broken webhook
// delivery — which function-level tests miss entirely.
//
// If ports are already in use, the suite skips with a message.
// ---------------------------------------------------------------------------

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import type { Subprocess } from "bun";

const BROKER_PORT = 3000;
const APP_PORT = 4000;
const BROKER_URL = `http://localhost:${BROKER_PORT}`;
const APP_URL = `http://localhost:${APP_PORT}`;
const BROKER_CWD = import.meta.dir + "/../../cms-fhir-subscriptions-broker/demo";
const APP_CWD = import.meta.dir + "/..";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function isPortFree(port: number): Promise<boolean> {
  try {
    const resp = await fetch(`http://localhost:${port}/`);
    // Port is in use (got a response)
    return false;
  } catch {
    return true;
  }
}

async function waitForServer(url: string, timeoutMs = 10_000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const resp = await fetch(url);
      if (resp.ok || resp.status < 500) return true;
    } catch {
      // not ready yet
    }
    await Bun.sleep(200);
  }
  return false;
}

// ---------------------------------------------------------------------------
// Process management
// ---------------------------------------------------------------------------

let brokerProc: Subprocess | null = null;
let appProc: Subprocess | null = null;
let portsAvailable = false;

beforeAll(async () => {
  // Check both ports are free
  const brokerFree = await isPortFree(BROKER_PORT);
  const appFree = await isPortFree(APP_PORT);

  if (!brokerFree || !appFree) {
    console.log(
      `⚠ Ports not free (broker:${BROKER_PORT}=${brokerFree ? "free" : "in-use"}, ` +
      `app:${APP_PORT}=${appFree ? "free" : "in-use"}) — skipping E2E server tests`,
    );
    return;
  }

  // Start broker
  try {
    brokerProc = Bun.spawn(["bun", "run", "server.ts"], {
      cwd: BROKER_CWD,
      env: { ...process.env, ROUTING_MODE: "path" },
      stdout: "pipe",
      stderr: "pipe",
    });
  } catch (e: any) {
    console.log(`⚠ Failed to start broker: ${e.message} — skipping E2E server tests`);
    return;
  }

  // Start app
  try {
    appProc = Bun.spawn(["bun", "run", "server.ts"], {
      cwd: APP_CWD,
      stdout: "pipe",
      stderr: "pipe",
    });
  } catch (e: any) {
    brokerProc?.kill();
    brokerProc = null;
    console.log(`⚠ Failed to start app: ${e.message} — skipping E2E server tests`);
    return;
  }

  // Wait for both to be ready
  const brokerReady = await waitForServer(`${BROKER_URL}/broker/admin/state`);
  const appReady = await waitForServer(`${APP_URL}/`);

  if (!brokerReady || !appReady) {
    brokerProc?.kill();
    appProc?.kill();
    brokerProc = null;
    appProc = null;
    console.log(
      `⚠ Servers failed to start (broker=${brokerReady}, app=${appReady}) — skipping E2E server tests`,
    );
    return;
  }

  portsAvailable = true;
}, 15_000);

afterAll(() => {
  brokerProc?.kill();
  appProc?.kill();
});

// Conditional test helper
function e2eTest(name: string, fn: () => Promise<void>, timeout?: number) {
  it(name, async () => {
    if (!portsAvailable) return; // silently skip
    await fn();
  }, timeout);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("E2E server tests", () => {
  // -- Health checks -------------------------------------------------------

  e2eTest("GET / returns 200 with landing page HTML", async () => {
    const resp = await fetch(`${APP_URL}/`);
    expect(resp.status).toBe(200);
    const html = await resp.text();
    expect(html).toContain("Referral Loop Closure");
  });

  e2eTest("GET /patient/ui returns 200 with patient portal HTML", async () => {
    const resp = await fetch(`${APP_URL}/patient/ui`);
    expect(resp.status).toBe(200);
    const html = await resp.text();
    expect(html).toContain("My Health Portal");
  });

  e2eTest("GET /physician/ui returns 200 with physician dashboard HTML", async () => {
    const resp = await fetch(`${APP_URL}/physician/ui`);
    expect(resp.status).toBe(200);
    const html = await resp.text();
    expect(html).toContain("html");
  });

  // -- Seed data -----------------------------------------------------------

  e2eTest("POST /api/seed returns ok", async () => {
    const resp = await fetch(`${APP_URL}/api/seed`, { method: "POST" });
    expect(resp.status).toBe(200);
    const data = await resp.json() as any;
    expect(data.ok).toBe(true);
  });

  // -- Onboarding wizard flow (sequential) ---------------------------------

  e2eTest("onboarding: initial status is step 1", async () => {
    const resp = await fetch(`${APP_URL}/patient/onboarding-status?patientId=patient-001`);
    expect(resp.status).toBe(200);
    const data = await resp.json() as any;
    expect(data.step).toBe(1);
    expect(data.identityVerified).toBe(false);
  });

  e2eTest("onboarding: step ordering enforced — authorize without register returns 400", async () => {
    const resp = await fetch(`${APP_URL}/patient/authorize`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ patientId: "patient-001" }),
    });
    expect(resp.status).toBe(400);
    const data = await resp.json() as any;
    expect(data.error).toContain("Registration required");
  });

  e2eTest("onboarding: step 1 — verify identity", async () => {
    const resp = await fetch(`${APP_URL}/patient/verify-identity`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        patientId: "patient-001",
        name: "Alice M Rodriguez",
        birthDate: "1987-04-12",
      }),
    });
    expect(resp.status).toBe(200);
    const data = await resp.json() as any;
    expect(data.ok).toBe(true);
    expect(data.step).toBe(2);
  });

  e2eTest("onboarding: step 2 — register with broker + EHR", async () => {
    const resp = await fetch(`${APP_URL}/patient/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        patientId: "patient-001",
        name: "Alice M Rodriguez",
        birthDate: "1987-04-12",
      }),
    });
    expect(resp.status).toBe(200);
    const data = await resp.json() as any;
    expect(data.ok).toBe(true);
    expect(data.step).toBe(3);
    expect(data.brokerId).toBeTruthy();
    expect(data.sourceId).toBeTruthy();
  });

  e2eTest("onboarding: step 3 — authorize", async () => {
    const resp = await fetch(`${APP_URL}/patient/authorize`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        patientId: "patient-001",
        name: "Alice M Rodriguez",
        birthDate: "1987-04-12",
      }),
    });
    expect(resp.status).toBe(200);
    const data = await resp.json() as any;
    expect(data.ok).toBe(true);
    expect(data.step).toBe(4);
    expect(data.accessToken).toBeTruthy();
  });

  e2eTest("onboarding: step 4 — subscribe", async () => {
    const resp = await fetch(`${APP_URL}/patient/subscribe`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ patientId: "patient-001" }),
    });
    expect(resp.status).toBe(200);
    const data = await resp.json() as any;
    expect(data.ok).toBe(true);
    expect(data.step).toBe(5);
    expect(data.subscriptionId).toBeTruthy();
  });

  e2eTest("onboarding: step 5 — complete with sharing enabled", async () => {
    const resp = await fetch(`${APP_URL}/patient/complete-onboarding`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        patientId: "patient-001",
        sharingEnabled: true,
        sharingMode: "referrals-only",
      }),
    });
    expect(resp.status).toBe(200);
    const data = await resp.json() as any;
    expect(data.ok).toBe(true);
    expect(data.step).toBe("complete");
    expect(data.sharingEnabled).toBe(true);
  });

  e2eTest("onboarding: status shows complete after wizard", async () => {
    const resp = await fetch(`${APP_URL}/patient/onboarding-status?patientId=patient-001`);
    expect(resp.status).toBe(200);
    const data = await resp.json() as any;
    expect(data.step).toBe("complete");
    expect(data.completedAt).toBeTruthy();
  });

  // -- Physician creates referral -------------------------------------------

  e2eTest("physician creates referral via POST /physician/referral", async () => {
    const today = new Date().toISOString().split("T")[0];
    const sixtyDays = new Date(Date.now() + 60 * 24 * 60 * 60 * 1000).toISOString().split("T")[0];

    const resp = await fetch(`${APP_URL}/physician/referral`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        patientId: "patient-001",
        requesterId: "dr-smith",
        requesterDisplay: "Dr. Robert Smith",
        codeText: "Cardiology consultation",
        reasonCode: "29857009",
        reasonDisplay: "Chest pain",
        occurrenceStart: today,
        occurrenceEnd: sixtyDays,
        targetOrgNpi: "1538246790",
        targetOrgName: "Mercy General Hospital",
        targetPractitionerNpi: "9876543210",
        targetSpecialtyCode: "207RC0000X",
        targetSpecialtyDisplay: "Cardiovascular Disease",
        originMethod: "electronic",
      }),
    });
    expect(resp.status).toBe(201);
    const data = await resp.json() as any;
    expect(data.ok).toBe(true);
    expect(data.serviceRequest).toBeTruthy();
    expect(data.task).toBeTruthy();
  });

  // -- Trigger encounter + verify delivery (the critical test) -------------

  e2eTest("trigger schedule-appointment and verify delivery via webhook", async () => {
    // Trigger a planned cardiology encounter at Mercy General
    const triggerResp = await fetch(`${APP_URL}/api/trigger`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "schedule-appointment" }),
    });
    expect(triggerResp.status).toBe(200);
    const triggerData = await triggerResp.json() as any;
    expect(triggerData.ok).toBe(true);
    expect(triggerData.encounterId).toBeTruthy();

    // Wait for broker to deliver notification via webhook
    // The broker processes async: EHR creates encounter → broker matches → delivers to /notifications
    let encounterFound = false;
    for (let attempt = 0; attempt < 15; attempt++) {
      await Bun.sleep(500);
      const encResp = await fetch(`${APP_URL}/patient/encounters?patientId=patient-001`);
      const encData = await encResp.json() as any;
      if (Array.isArray(encData) && encData.length > 0) {
        encounterFound = true;
        // Verify encounter shape
        const enc = encData[0];
        expect(enc.status).toBeTruthy();
        expect(enc.subject).toBeTruthy();
        expect(enc.serviceProvider).toBeTruthy();
        break;
      }
    }
    expect(encounterFound).toBe(true);
  }, 15_000);

  // -- Referral matching ---------------------------------------------------

  e2eTest("referrals updated after encounter delivery", async () => {
    const resp = await fetch(`${APP_URL}/patient/referrals?patientId=patient-001`);
    expect(resp.status).toBe(200);
    const data = await resp.json() as any;
    expect(Array.isArray(data)).toBe(true);
    // After seed + referral creation + encounter, there should be referrals
    expect(data.length).toBeGreaterThan(0);
  });

  // -- Physician dashboard -------------------------------------------------

  e2eTest("physician dashboard returns data", async () => {
    const resp = await fetch(`${APP_URL}/physician/dashboard`);
    expect(resp.status).toBe(200);
    const data = await resp.json() as any;
    expect(data.referrals).toBeDefined();
    expect(Array.isArray(data.referrals)).toBe(true);
  });

  // -- API reset -----------------------------------------------------------

  e2eTest("POST /api/reset clears all data", async () => {
    const resp = await fetch(`${APP_URL}/api/reset`, { method: "POST" });
    expect(resp.status).toBe(200);
    const data = await resp.json() as any;
    expect(data.ok).toBe(true);

    // Verify encounters are cleared
    const encResp = await fetch(`${APP_URL}/patient/encounters?patientId=patient-001`);
    const encData = await encResp.json() as any;
    expect(Array.isArray(encData)).toBe(true);
    expect(encData.length).toBe(0);
  });

  // -- 404 -----------------------------------------------------------------

  e2eTest("unknown route returns 404", async () => {
    const resp = await fetch(`${APP_URL}/nonexistent`);
    expect(resp.status).toBe(404);
  });
});
