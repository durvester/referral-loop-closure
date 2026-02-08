import type { Encounter } from "../fhir/types";
import { patients, encounters, serviceRequests, tasks, getOpenReferrals, getSharingPreference, setSharingPreference, sharingPreferences, routedEvents, onboardingStates, brokerSessions, type OnboardingState, type BrokerSession } from "../store";
import { createSSEStream } from "../shared/sse";
import { processEncounter } from "./routing";
import { onboardPatient, fetchEncounterFromEhr, registerWithBroker, registerWithEhr, linkPatientIds, authenticateWithBroker, createSubscription } from "./broker-client";
import { config } from "../config";

export async function handlePatientRequest(req: Request, path: string): Promise<Response> {
  const url = new URL(req.url);
  const method = req.method;

  // SSE: GET /patient/events?patientId=xxx
  if (path === "/events" && method === "GET") {
    const patientId = url.searchParams.get("patientId") || "patient-001";
    return createSSEStream("patient", patientId);
  }

  // Get patient info: GET /patient/info?patientId=xxx
  if (path === "/info" && method === "GET") {
    const patientId = url.searchParams.get("patientId") || "patient-001";
    const patient = patients.get(patientId);
    if (!patient) return Response.json({ error: "Patient not found" }, { status: 404 });
    return Response.json(patient);
  }

  // Get referrals for patient: GET /patient/referrals?patientId=xxx
  if (path === "/referrals" && method === "GET") {
    const patientId = url.searchParams.get("patientId") || "patient-001";
    const openRefs = getOpenReferrals(patientId);
    // Also include completed tasks
    const allReferrals = [...openRefs];
    for (const [, task] of tasks) {
      if (task.for?.reference === `Patient/${patientId}` && !openRefs.some(r => r.task.id === task.id)) {
        const sr = serviceRequests.get(task.focus?.reference?.replace("ServiceRequest/", "") || "");
        if (sr) allReferrals.push({ serviceRequest: sr, task });
      }
    }
    return Response.json(allReferrals);
  }

  // Get all encounters for patient: GET /patient/encounters?patientId=xxx
  if (path === "/encounters" && method === "GET") {
    const patientId = url.searchParams.get("patientId") || "patient-001";
    const patientEncounters: Encounter[] = [];
    for (const [, enc] of encounters) {
      if (enc.subject?.reference === `Patient/${patientId}`) {
        patientEncounters.push(enc);
      }
    }
    // Mark which ones are shared
    const enriched = patientEncounters.map(enc => ({
      ...enc,
      _shared: routedEvents.some(e => e.encounterId === enc.id),
    }));
    return Response.json(enriched);
  }

  // Get/Set sharing preference: GET/POST /patient/sharing?patientId=xxx
  if (path === "/sharing" && method === "GET") {
    const patientId = url.searchParams.get("patientId") || "patient-001";
    const physicianRef = url.searchParams.get("physicianRef") || "Practitioner/dr-smith";
    const pref = getSharingPreference(patientId, physicianRef);
    return Response.json(pref || { patientId, physicianRef, mode: "none", active: false });
  }

  if (path === "/sharing" && method === "POST") {
    const body = await req.json() as any;
    setSharingPreference({
      patientId: body.patientId || "patient-001",
      physicianRef: body.physicianRef || "Practitioner/dr-smith",
      mode: body.mode || "referrals-only",
      grantedAt: new Date().toISOString(),
      active: true,
    });
    return Response.json({ ok: true });
  }

  // Onboard patient with broker: POST /patient/onboard (legacy — full flow in one call)
  if (path === "/onboard" && method === "POST") {
    const body = await req.json() as any;
    try {
      const result = await onboardPatient(
        body.patientId || "patient-001",
        { name: body.name || "Alice M Rodriguez", birthDate: body.birthDate || "1987-04-12" },
      );
      return Response.json(result);
    } catch (e: any) {
      return Response.json({ error: e.message }, { status: 500 });
    }
  }

  // =========================================================================
  // ONBOARDING WIZARD — Step-by-step endpoints
  // =========================================================================

  // GET /patient/onboarding-status — returns current OnboardingState
  if (path === "/onboarding-status" && method === "GET") {
    const patientId = url.searchParams.get("patientId") || "patient-001";
    const state = onboardingStates.get(patientId);
    if (!state) {
      return Response.json({ patientId, step: 1, identityVerified: false, brokerId: null, sourceId: null, accessToken: null, subscriptionId: null, sharingEnabled: false, completedAt: null });
    }
    return Response.json(state);
  }

  // Step 1: POST /patient/verify-identity — IAL2 identity verification (simulated)
  if (path === "/verify-identity" && method === "POST") {
    const body = await req.json() as any;
    const patientId = body.patientId || "patient-001";
    const name = body.name || "Alice M Rodriguez";
    const birthDate = body.birthDate || "1987-04-12";

    if (!name || !birthDate) {
      return Response.json({ error: "Name and date of birth are required" }, { status: 400 });
    }

    // Simulated IAL2: in production this would involve document scan + facial match
    const state: OnboardingState = {
      patientId,
      step: 2,
      identityVerified: true,
      brokerId: null,
      sourceId: null,
      accessToken: null,
      subscriptionId: null,
      sharingEnabled: false,
      completedAt: null,
    };
    onboardingStates.set(patientId, state);

    return Response.json({ ok: true, step: 2, identityVerified: true, message: "Identity verified (IAL2 simulated)" });
  }

  // Step 2: POST /patient/register — Register with broker + EHR
  if (path === "/register" && method === "POST") {
    const body = await req.json() as any;
    const patientId = body.patientId || "patient-001";
    const patient = { name: body.name || "Alice M Rodriguez", birthDate: body.birthDate || "1987-04-12" };

    const state = onboardingStates.get(patientId);
    if (!state || !state.identityVerified) {
      return Response.json({ error: "Identity verification required first (step 1)" }, { status: 400 });
    }

    try {
      const brokerId = await registerWithBroker(patient);
      const sourceId = await registerWithEhr(patient);
      await linkPatientIds(patient, sourceId);

      state.brokerId = brokerId;
      state.sourceId = sourceId;
      state.step = 3;
      onboardingStates.set(patientId, state);

      return Response.json({ ok: true, step: 3, brokerId, sourceId });
    } catch (e: any) {
      return Response.json({ error: e.message }, { status: 500 });
    }
  }

  // Step 3: POST /patient/authorize — Permission ticket + token exchange
  if (path === "/authorize" && method === "POST") {
    const body = await req.json() as any;
    const patientId = body.patientId || "patient-001";
    const patient = { name: body.name || "Alice M Rodriguez", birthDate: body.birthDate || "1987-04-12" };

    const state = onboardingStates.get(patientId);
    if (!state || !state.brokerId) {
      return Response.json({ error: "Registration required first (step 2)" }, { status: 400 });
    }

    try {
      const auth = await authenticateWithBroker(patient);
      state.accessToken = auth.accessToken;
      state.step = 4;
      onboardingStates.set(patientId, state);

      return Response.json({ ok: true, step: 4, accessToken: auth.accessToken, brokerId: auth.brokerId });
    } catch (e: any) {
      return Response.json({ error: e.message }, { status: 500 });
    }
  }

  // Step 4: POST /patient/subscribe — Create FHIR Subscription with real webhook
  if (path === "/subscribe" && method === "POST") {
    const body = await req.json() as any;
    const patientId = body.patientId || "patient-001";

    const state = onboardingStates.get(patientId);
    if (!state || !state.accessToken) {
      return Response.json({ error: "Authorization required first (step 3)" }, { status: 400 });
    }

    try {
      const subscriptionId = await createSubscription(state.accessToken, state.brokerId!);

      state.subscriptionId = subscriptionId;
      state.step = 5;
      onboardingStates.set(patientId, state);

      // Also store broker session for encounter processing
      const session: BrokerSession = {
        brokerId: state.brokerId,
        sourceId: state.sourceId,
        accessToken: state.accessToken,
        subscriptionId,
        patientId,
      };
      brokerSessions.set(patientId, session);

      return Response.json({ ok: true, step: 5, subscriptionId });
    } catch (e: any) {
      return Response.json({ error: e.message }, { status: 500 });
    }
  }

  // Step 5: POST /patient/complete-onboarding — Finalize (sharing preferences set separately)
  if (path === "/complete-onboarding" && method === "POST") {
    const body = await req.json() as any;
    const patientId = body.patientId || "patient-001";

    const state = onboardingStates.get(patientId);
    if (!state || !state.subscriptionId) {
      return Response.json({ error: "Subscription required first (step 4)" }, { status: 400 });
    }

    state.sharingEnabled = !!body.sharingEnabled;
    state.step = "complete";
    state.completedAt = new Date().toISOString();
    onboardingStates.set(patientId, state);

    // If sharing enabled, set the preference
    if (body.sharingEnabled) {
      setSharingPreference({
        patientId,
        physicianRef: body.physicianRef || "Practitioner/dr-smith",
        mode: body.sharingMode || "referrals-only",
        grantedAt: new Date().toISOString(),
        active: true,
      });
    }

    return Response.json({ ok: true, step: "complete", completedAt: state.completedAt, sharingEnabled: state.sharingEnabled });
  }

  return Response.json({ error: "Not found" }, { status: 404 });
}
