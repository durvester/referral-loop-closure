import { config, brokerUrl, ehrUrl, selfUrl } from "../config";
import {
  createPermissionTicket,
  createClientAssertion,
  type PatientDemographics,
} from "../shared/auth";
import { brokerSessions, type BrokerSession } from "../store";

export interface OnboardResult {
  brokerId: string;
  sourceId: string;
  accessToken: string;
  subscriptionId: string;
}

// ---------------------------------------------------------------------------
// Step 1: Register patient with broker
// ---------------------------------------------------------------------------
export async function registerWithBroker(
  patient: PatientDemographics,
  sourceId: string = "pending",
): Promise<string> {
  const resp = await fetch(brokerUrl("/register-patient"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      sourceId,
      name: patient.name,
      birthDate: patient.birthDate,
    }),
  });
  if (!resp.ok) throw new Error(`Broker registration failed: ${resp.status}`);
  const data = (await resp.json()) as any;
  return data.brokerId;
}

// ---------------------------------------------------------------------------
// Step 2: Register patient with EHR data source
// ---------------------------------------------------------------------------
export async function registerWithEhr(
  patient: PatientDemographics,
): Promise<string> {
  const resp = await fetch(ehrUrl("/register-patient"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name: patient.name,
      birthDate: patient.birthDate,
    }),
  });
  if (!resp.ok) throw new Error(`EHR registration failed: ${resp.status}`);
  const data = (await resp.json()) as any;
  return data.sourceId;
}

// ---------------------------------------------------------------------------
// Step 3: Link sourceId to brokerId
// ---------------------------------------------------------------------------
export async function linkPatientIds(
  patient: PatientDemographics,
  sourceId: string,
): Promise<string> {
  return registerWithBroker(patient, sourceId);
}

// ---------------------------------------------------------------------------
// Step 4: Authenticate with broker using permission ticket + client assertion
// ---------------------------------------------------------------------------
export async function authenticateWithBroker(
  patient: PatientDemographics,
): Promise<{ accessToken: string; brokerId: string }> {
  const ticket = createPermissionTicket(patient, config.clientId);
  const assertion = createClientAssertion(
    config.clientId,
    brokerUrl(""), // audience is the broker base URL
    ticket,
  );

  const resp = await fetch(brokerUrl("/auth/token"), {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_assertion_type:
        "urn:ietf:params:oauth:client-assertion-type:jwt-bearer",
      client_assertion: assertion,
    }).toString(),
  });

  if (!resp.ok) throw new Error(`Auth failed: ${resp.status}`);
  const data = (await resp.json()) as any;
  return { accessToken: data.access_token, brokerId: data.patient };
}

// ---------------------------------------------------------------------------
// Step 5: Create subscription for encounter notifications
// ---------------------------------------------------------------------------
export async function createSubscription(
  accessToken: string,
  brokerId: string,
): Promise<string> {
  const resp = await fetch(brokerUrl("/fhir/Subscription"), {
    method: "POST",
    headers: {
      "Content-Type": "application/fhir+json",
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify({
      resourceType: "Subscription",
      criteria: `Encounter?patient=Patient/${brokerId}`,
      channel: {
        type: "rest-hook",
        endpoint: `http://localhost:${config.port}/notifications`,
        payload: "application/fhir+json",
      },
    }),
  });

  if (!resp.ok)
    throw new Error(`Subscription creation failed: ${resp.status}`);
  const sub = (await resp.json()) as any;
  return sub.id;
}

// ---------------------------------------------------------------------------
// Full onboarding flow
// ---------------------------------------------------------------------------
export async function onboardPatient(
  patientId: string,
  patient: PatientDemographics,
): Promise<OnboardResult> {
  // Register with broker (get brokerId)
  const brokerId = await registerWithBroker(patient);

  // Register with EHR (get sourceId)
  const sourceId = await registerWithEhr(patient);

  // Link sourceId -> brokerId
  await linkPatientIds(patient, sourceId);

  // Authenticate
  const auth = await authenticateWithBroker(patient);

  // Subscribe
  const subscriptionId = await createSubscription(
    auth.accessToken,
    auth.brokerId,
  );

  // Store session
  const session: BrokerSession = {
    brokerId: auth.brokerId,
    sourceId,
    accessToken: auth.accessToken,
    subscriptionId,
    patientId,
  };
  brokerSessions.set(patientId, session);

  return {
    brokerId: auth.brokerId,
    sourceId,
    accessToken: auth.accessToken,
    subscriptionId,
  };
}

// ---------------------------------------------------------------------------
// Fetch encounter from EHR after notification
// ---------------------------------------------------------------------------
export async function fetchEncounterFromEhr(
  encounterRef: string,
  accessToken?: string,
): Promise<any> {
  // Get a data source token if we don't have one
  let token = accessToken;
  if (!token) {
    const tokenResp = await fetch(ehrUrl("/auth/token"), { method: "POST" });
    const tokenData = (await tokenResp.json()) as any;
    token = tokenData.access_token;
  }

  const resp = await fetch(ehrUrl(`/fhir/${encounterRef}`), {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!resp.ok)
    throw new Error(`Failed to fetch ${encounterRef}: ${resp.status}`);
  return resp.json();
}

// ---------------------------------------------------------------------------
// Trigger an encounter at the EHR (for demo/testing)
// ---------------------------------------------------------------------------
// Trigger an encounter at the upstream EHR.
// Note: The upstream EHR always sets serviceProvider to "Mercy General Hospital" —
// we don't try to override this. The encounter flows through the broker
// and arrives at our /notifications webhook with the EHR's real data.
export async function triggerEncounterAtEhr(
  patient: PatientDemographics,
  options: {
    classCode?: string;
    typeCode?: string;
    status?: string;
    reasonCode?: string;
    practitionerNpi?: string;
    practitionerDisplay?: string;
    encounterId?: string;
  } = {},
): Promise<{ encounterId: string; sourceId: string }> {
  const resp = await fetch(ehrUrl("/trigger-event"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      patient: { name: patient.name, birthDate: patient.birthDate },
      encounterOptions: {
        classCode: options.classCode || "AMB",
        typeCode: options.typeCode || "185349003",
        status: options.status || "planned",
        reasonCode: options.reasonCode,
        practitionerNpi: options.practitionerNpi,
        practitionerDisplay: options.practitionerDisplay,
      },
      encounterId: options.encounterId,
    }),
  });

  if (!resp.ok) throw new Error(`Trigger event failed: ${resp.status}`);
  const data = (await resp.json()) as any;
  return { encounterId: data.encounterId, sourceId: data.sourceId };
}
