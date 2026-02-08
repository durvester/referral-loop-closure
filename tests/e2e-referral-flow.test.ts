import { describe, it, expect, beforeEach } from "bun:test";
import { seedDemoData } from "../shared/seed";
import { makeServiceRequest, makeTask } from "../fhir/resources";
import {
  clearAllStores,
  setSharingPreference,
  getSharingPreference,
  serviceRequests,
  tasks,
  encounters,
  routedEvents,
  getOpenReferrals,
  brokerSessions,
  resolvePatientId,
} from "../store";
import { processEncounter } from "../portal/routing";
import type { Encounter } from "../fhir/types";

// ---------------------------------------------------------------------------
// Helper: create an encounter that mimics what the upstream EHR actually produces.
// The upstream EHR always sets serviceProvider to "Mercy General Hospital" with
// reference "Organization/mercy-hospital", and uses EHR-local patient IDs.
// Optionally includes a practitioner with embedded NPI identifier.
// ---------------------------------------------------------------------------

function makeEhrEncounter(overrides: {
  id?: string;
  ehrPatientId?: string;
  status?: Encounter["status"];
  classCode?: string;
  practitionerNpi?: string;
  practitionerDisplay?: string;
}): Encounter {
  const id = overrides.id || `enc-${Date.now()}`;
  const patientId = overrides.ehrPatientId || "mercy-abc123";
  const classCode = overrides.classCode || "AMB";
  const status = overrides.status || "planned";

  const participant = (overrides.practitionerNpi || overrides.practitionerDisplay)
    ? [{
        individual: {
          reference: `Practitioner/${overrides.practitionerNpi || "unknown"}`,
          display: overrides.practitionerDisplay || "Unknown Provider",
          ...(overrides.practitionerNpi && {
            identifier: {
              system: "http://hl7.org/fhir/sid/us-npi",
              value: overrides.practitionerNpi,
            },
          }),
        },
      }]
    : undefined;

  // This mirrors the shape of encounters from the upstream EHR (shared/types.ts:44-93)
  return {
    resourceType: "Encounter",
    id,
    status,
    class: {
      system: "http://terminology.hl7.org/CodeSystem/v3-ActCode",
      code: classCode,
      display: classCode === "EMER" ? "emergency" : "ambulatory",
    },
    type: [
      {
        coding: [
          {
            system: "http://snomed.info/sct",
            code: "281036007",
            display: "Follow-up consultation",
          },
        ],
        text: `Consultation for Alice M Rodriguez`,
      },
    ],
    subject: { reference: `Patient/${patientId}` },
    participant,
    period: { start: new Date().toISOString() },
    // The upstream EHR hardcodes this — we don't override it
    serviceProvider: {
      reference: "Organization/mercy-hospital",
      display: "Mercy General Hospital",
    },
  } as Encounter;
}

// ---------------------------------------------------------------------------
// Helper: create referral + task in store (replaces what seed used to do)
// ---------------------------------------------------------------------------

function seedReferralAndTask() {
  const referral = makeServiceRequest({
    id: "referral-001",
    patientId: "patient-001",
    requesterId: "dr-smith",
    requesterDisplay: "Dr. Robert Smith",
    reasonCode: "29857009",
    reasonDisplay: "Chest pain",
    codeText: "Cardiology consultation",
    authoredOn: "2026-02-01T10:30:00Z",
    occurrenceStart: "2026-02-01",
    occurrenceEnd: "2026-04-01",
    notes: "Cardiology consultation for chest pain.",
    originMethod: "electronic",
    targetOrgNpi: "1538246790",
    targetOrgName: "Mercy General Hospital",
    targetPractitionerNpi: "9876543210",
    targetSpecialtyCode: "207RC0000X",
    targetSpecialtyDisplay: "Cardiovascular Disease",
  });
  serviceRequests.set(referral.id, referral);

  const task = makeTask({
    id: "task-001",
    serviceRequestId: "referral-001",
    patientId: "patient-001",
    requesterId: "dr-smith",
    requesterDisplay: "Dr. Robert Smith",
    ownerId: "mercy-hospital",
    ownerDisplay: "Mercy General Hospital",
    authoredOn: "2026-02-01T10:30:00Z",
    dueDate: "2026-04-01",
  });
  tasks.set(task.id, task);
}

// ---------------------------------------------------------------------------
// E2E: complete referral lifecycle using EHR-shaped encounters
// ---------------------------------------------------------------------------

describe("end-to-end referral flow", () => {
  const EHR_PATIENT_ID = "mercy-abc123"; // simulates the upstream EHR patient ID

  beforeEach(() => {
    clearAllStores();
    seedDemoData();
    seedReferralAndTask();

    // Simulate that the patient was onboarded via broker.
    // This creates the patient ID mapping (EHR sourceId → our patientId).
    brokerSessions.set("patient-001", {
      brokerId: "broker-xyz789",
      sourceId: EHR_PATIENT_ID,
      accessToken: "mock-token",
      subscriptionId: "sub-1",
      patientId: "patient-001",
    });

    // Patient grants referrals-only sharing to referring physician
    setSharingPreference({
      patientId: "patient-001",
      physicianRef: "Practitioner/dr-smith",
      mode: "referrals-only",
      grantedAt: new Date().toISOString(),
      active: true,
    });
  });

  it("seed data creates no referrals", () => {
    // Verify that seedDemoData alone (without seedReferralAndTask) creates no referrals
    clearAllStores();
    seedDemoData();
    expect(serviceRequests.size).toBe(0);
    expect(tasks.size).toBe(0);
  });

  it("physician creates referral: ServiceRequest + Task created in store", () => {
    expect(serviceRequests.has("referral-001")).toBe(true);
    expect(tasks.has("task-001")).toBe(true);

    const sr = serviceRequests.get("referral-001")!;
    expect(sr.resourceType).toBe("ServiceRequest");
    expect(sr.status).toBe("active");
    expect(sr.subject.reference).toBe("Patient/patient-001");

    const task = tasks.get("task-001")!;
    expect(task.resourceType).toBe("Task");
    expect(task.status).toBe("requested");
    expect(task.focus?.reference).toBe("ServiceRequest/referral-001");
  });

  it("referral appears in patient portal API (via getOpenReferrals)", () => {
    const openRefs = getOpenReferrals("patient-001");
    expect(openRefs.length).toBe(1);
    expect(openRefs[0].serviceRequest.id).toBe("referral-001");
  });

  it("patient sets 'referrals-only' sharing preference", () => {
    const pref = getSharingPreference("patient-001", "Practitioner/dr-smith");
    expect(pref).toBeDefined();
    expect(pref!.mode).toBe("referrals-only");
    expect(pref!.active).toBe(true);
  });

  it("resolvePatientId maps EHR patient ID to our internal ID", () => {
    expect(resolvePatientId(EHR_PATIENT_ID)).toBe("patient-001");
    expect(resolvePatientId("unknown-id")).toBe("unknown-id"); // fallback
  });

  it("EHR-shaped encounter with matching practitioner NPI matches referral", () => {
    const encounter = makeEhrEncounter({
      id: "enc-ehr-match",
      ehrPatientId: EHR_PATIENT_ID,
      status: "planned",
      practitionerNpi: "9876543210",
      practitionerDisplay: "Dr. Sarah Johnson",
    });

    const result = processEncounter(encounter);

    // Patient ID was cross-referenced from mercy-abc123 → patient-001
    expect(result.patientId).toBe("patient-001");
    // Matching engine found the Mercy General referral with high score
    expect(result.bestMatch).not.toBeNull();
    expect(result.bestMatch!.serviceRequestId).toBe("referral-001");
    expect(result.bestMatch!.score).toBeGreaterThanOrEqual(0.70);
  });

  it("Task updates to in-progress/appointment-scheduled after planned encounter", () => {
    const encounter = makeEhrEncounter({
      id: "enc-ehr-planned",
      ehrPatientId: EHR_PATIENT_ID,
      status: "planned",
      practitionerNpi: "9876543210",
      practitionerDisplay: "Dr. Sarah Johnson",
    });

    processEncounter(encounter);

    const task = tasks.get("task-001")!;
    expect(task.status).toBe("in-progress");
    expect(task.businessStatus!.coding![0].code).toBe("appointment-scheduled");
  });

  it("encounter is routed to physician (referrals-only mode + match)", () => {
    const encounter = makeEhrEncounter({
      id: "enc-ehr-routed",
      ehrPatientId: EHR_PATIENT_ID,
      status: "planned",
      practitionerNpi: "9876543210",
      practitionerDisplay: "Dr. Sarah Johnson",
    });

    const result = processEncounter(encounter);
    expect(result.routed).toBe(true);
    expect(routedEvents.length).toBe(1);
    expect(routedEvents[0].encounterId).toBe("enc-ehr-routed");
  });

  it("encounter stored with canonical patient ID (not EHR-local ID)", () => {
    const encounter = makeEhrEncounter({
      id: "enc-ehr-stored",
      ehrPatientId: EHR_PATIENT_ID,
      status: "planned",
      practitionerNpi: "9876543210",
      practitionerDisplay: "Dr. Sarah Johnson",
    });

    processEncounter(encounter);

    const stored = encounters.get("enc-ehr-stored")!;
    // Subject reference should be normalized to our patient ID
    expect(stored.subject?.reference).toBe("Patient/patient-001");
    // ServiceProvider should remain unchanged (from the upstream EHR)
    expect(stored.serviceProvider?.display).toBe("Mercy General Hospital");
  });

  it("finished encounter closes the loop: Task -> completed/loop-closed", () => {
    // Same encounter ID progresses through statuses (planned → finished)
    const ENCOUNTER_ID = "enc-ehr-lifecycle";

    // First process a planned encounter
    processEncounter(
      makeEhrEncounter({
        id: ENCOUNTER_ID,
        ehrPatientId: EHR_PATIENT_ID,
        status: "planned",
        practitionerNpi: "9876543210",
        practitionerDisplay: "Dr. Sarah Johnson",
      }),
    );

    expect(encounters.size).toBe(1);

    // Then the same encounter finishes
    processEncounter(
      makeEhrEncounter({
        id: ENCOUNTER_ID,
        ehrPatientId: EHR_PATIENT_ID,
        status: "finished",
        practitionerNpi: "9876543210",
        practitionerDisplay: "Dr. Sarah Johnson",
      }),
    );

    // Still only 1 encounter — same ID was updated, not a new one created
    expect(encounters.size).toBe(1);
    expect(encounters.get(ENCOUNTER_ID)!.status).toBe("finished");

    const task = tasks.get("task-001")!;
    expect(task.status).toBe("completed");
    expect(task.businessStatus!.coding![0].code).toBe("loop-closed");
    expect(task.output).toBeDefined();
    expect(task.output!.length).toBeGreaterThan(0);
    expect(task.output![0].valueReference?.reference).toBe(
      `Encounter/${ENCOUNTER_ID}`,
    );

    // Only 1 routed event (upserted, not duplicated)
    expect(routedEvents.length).toBe(1);
    expect(routedEvents[0].encounterId).toBe(ENCOUNTER_ID);
  });

  it("physician timeline shows routed encounter with task reference", () => {
    const encounter = makeEhrEncounter({
      id: "enc-ehr-timeline",
      ehrPatientId: EHR_PATIENT_ID,
      status: "planned",
      practitionerNpi: "9876543210",
      practitionerDisplay: "Dr. Sarah Johnson",
    });

    processEncounter(encounter);

    expect(routedEvents.length).toBe(1);
    const event = routedEvents[0];
    expect(event.encounterId).toBe("enc-ehr-timeline");
    expect(event.taskId).toBe("task-001");
    expect(event.patientId).toBe("patient-001");
    expect(event.physicianRef).toBe("Practitioner/dr-smith");
  });

  it("psychiatrist visit: stored but not routed (different practitioner NPI, below 0.70)", () => {
    const encounter = makeEhrEncounter({
      id: "enc-psychiatrist",
      ehrPatientId: EHR_PATIENT_ID,
      status: "planned",
      practitionerNpi: "5555555555",
      practitionerDisplay: "Dr. Maria Chen",
    });

    const result = processEncounter(encounter);

    // Encounter should be stored (patient always sees it)
    expect(encounters.has("enc-psychiatrist")).toBe(true);
    // Score should be below 0.70 (org NPI 0.35 + org name 0.20 + date 0.10 = 0.65, no practitioner match)
    if (result.bestMatch) {
      expect(result.bestMatch.score).toBeLessThan(0.70);
    }
    // Should NOT be routed (referrals-only mode, no match above threshold)
    expect(result.routed).toBe(false);
  });

  it("encounter without referral: stored but not routed", () => {
    // Clear referrals so there's nothing to match against
    clearAllStores();
    seedDemoData();

    brokerSessions.set("patient-001", {
      brokerId: "broker-xyz789",
      sourceId: EHR_PATIENT_ID,
      accessToken: "mock-token",
      subscriptionId: "sub-1",
      patientId: "patient-001",
    });

    setSharingPreference({
      patientId: "patient-001",
      physicianRef: "Practitioner/dr-smith",
      mode: "referrals-only",
      grantedAt: new Date().toISOString(),
      active: true,
    });

    const encounter = makeEhrEncounter({
      id: "enc-no-referral",
      ehrPatientId: EHR_PATIENT_ID,
      status: "planned",
      practitionerNpi: "9876543210",
      practitionerDisplay: "Dr. Sarah Johnson",
    });

    const result = processEncounter(encounter);

    // Encounter stored
    expect(encounters.has("enc-no-referral")).toBe(true);
    // No referrals to match
    expect(result.bestMatch).toBeNull();
    // Not routed (referrals-only but no match)
    expect(result.routed).toBe(false);
  });
});
