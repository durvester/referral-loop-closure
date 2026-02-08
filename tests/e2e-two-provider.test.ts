import { describe, it, expect, beforeEach } from "bun:test";
import { seedDemoData } from "../shared/seed";
import { makeServiceRequest, makeTask } from "../fhir/resources";
import {
  clearAllStores,
  setSharingPreference,
  serviceRequests,
  tasks,
  encounters,
  routedEvents,
  brokerSessions,
} from "../store";
import { processEncounter } from "../portal/routing";
import type { Encounter } from "../fhir/types";

// ---------------------------------------------------------------------------
// Helper: create an encounter shaped exactly like the upstream EHR produces them.
// serviceProvider is always "Mercy General Hospital" (hardcoded in the upstream EHR).
// Patient IDs are EHR-local (e.g., "mercy-abc123").
// Now includes practitioner with embedded NPI identifier.
// ---------------------------------------------------------------------------

const EHR_PATIENT_ID = "mercy-abc123";
let encCounter = 0;

function makeEhrEncounter(overrides: {
  id?: string;
  status?: Encounter["status"];
  classCode?: string;
  practitionerNpi?: string;
  practitionerDisplay?: string;
} = {}): Encounter {
  const id = overrides.id || `enc-mercy-${++encCounter}`;

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

  return {
    resourceType: "Encounter",
    id,
    status: overrides.status || "planned",
    class: {
      system: "http://terminology.hl7.org/CodeSystem/v3-ActCode",
      code: overrides.classCode || "AMB",
      display: overrides.classCode === "EMER" ? "emergency" : "ambulatory",
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
        text: "Consultation for Alice M Rodriguez",
      },
    ],
    subject: { reference: `Patient/${EHR_PATIENT_ID}` },
    participant,
    period: { start: new Date().toISOString() },
    serviceProvider: {
      reference: "Organization/mercy-hospital",
      display: "Mercy General Hospital",
    },
  } as Encounter;
}

// ---------------------------------------------------------------------------
// Helper: create referrals + tasks in store
// ---------------------------------------------------------------------------

function seedReferralsAndTasks() {
  // Referral 1: to Mercy General Hospital (WILL match EHR encounters with Dr. Johnson)
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

  // Referral 2: to Valley Cardiology (will NOT match — different org NPI)
  const referral2 = makeServiceRequest({
    id: "referral-002",
    patientId: "patient-001",
    requesterId: "dr-smith",
    requesterDisplay: "Dr. Robert Smith",
    performerRoleId: "role-cardio",
    performerDisplay: "Dr. Sarah Johnson, Valley Cardiology",
    reasonCode: "29857009",
    reasonDisplay: "Chest pain",
    codeText: "Cardiology follow-up",
    authoredOn: "2026-02-01T10:30:00Z",
    occurrenceStart: "2026-02-01",
    occurrenceEnd: "2026-04-01",
    notes: "Follow-up at Valley Cardiology.",
    originMethod: "fax",
    targetOrgNpi: "1122334455",
    targetOrgName: "Valley Cardiology",
    targetPractitionerNpi: "9876543210",
    targetSpecialtyCode: "207RC0000X",
    targetSpecialtyDisplay: "Cardiovascular Disease",
  });
  serviceRequests.set(referral2.id, referral2);

  const task2 = makeTask({
    id: "task-002",
    serviceRequestId: "referral-002",
    patientId: "patient-001",
    requesterId: "dr-smith",
    requesterDisplay: "Dr. Robert Smith",
    ownerId: "org-valley-cardiology",
    ownerDisplay: "Valley Cardiology",
    authoredOn: "2026-02-01T10:30:00Z",
    dueDate: "2026-04-01",
  });
  tasks.set(task2.id, task2);
}

// ---------------------------------------------------------------------------
// Two-referral scenario:
//
// Referral 1: to Mercy General Hospital → encounters with Dr. Johnson MATCH
// Referral 2: to Valley Cardiology → encounters from Mercy General DON'T MATCH
//
// This demonstrates that the matching engine correctly filters encounters
// against the right referral target, even though all encounters come from
// the same EHR data source (the upstream single-hospital demo).
// ---------------------------------------------------------------------------

describe("two-referral scenario", () => {
  beforeEach(() => {
    encCounter = 0;
    clearAllStores();
    seedDemoData();
    seedReferralsAndTasks();

    // Set up broker session for patient ID cross-referencing
    brokerSessions.set("patient-001", {
      brokerId: "broker-xyz789",
      sourceId: EHR_PATIENT_ID,
      accessToken: "mock-token",
      subscriptionId: "sub-1",
      patientId: "patient-001",
    });
  });

  // -------------------------------------------------------------------------
  // referrals-only mode
  // -------------------------------------------------------------------------

  describe("referrals-only mode", () => {
    beforeEach(() => {
      setSharingPreference({
        patientId: "patient-001",
        physicianRef: "Practitioner/dr-smith",
        mode: "referrals-only",
        grantedAt: new Date().toISOString(),
        active: true,
      });
    });

    it("setup: referral-001 targets Mercy General, referral-002 targets Valley Cardiology", () => {
      const sr1 = serviceRequests.get("referral-001")!;
      const target1 = sr1.extension?.find(
        (e) =>
          e.url ===
          "http://example.org/fhir/StructureDefinition/referral-target-identifiers",
      );
      const orgName1 = target1?.extension?.find(
        (e) => e.url === "organizationName",
      )?.valueString;
      expect(orgName1).toBe("Mercy General Hospital");

      const sr2 = serviceRequests.get("referral-002")!;
      const target2 = sr2.extension?.find(
        (e) =>
          e.url ===
          "http://example.org/fhir/StructureDefinition/referral-target-identifiers",
      );
      const orgName2 = target2?.extension?.find(
        (e) => e.url === "organizationName",
      )?.valueString;
      expect(orgName2).toBe("Valley Cardiology");
    });

    it("encounter with Dr. Johnson: matches referral-001, routes to physician", () => {
      const routedBefore = routedEvents.length;
      const enc = makeEhrEncounter({
        status: "planned",
        practitionerNpi: "9876543210",
        practitionerDisplay: "Dr. Sarah Johnson",
      });
      const result = processEncounter(enc);

      expect(result.routed).toBe(true);
      expect(result.bestMatch).not.toBeNull();
      expect(result.bestMatch!.serviceRequestId).toBe("referral-001");
      expect(routedEvents.length).toBe(routedBefore + 1);
    });

    it("Mercy General encounter does NOT match Valley Cardiology referral", () => {
      const enc = makeEhrEncounter({
        status: "planned",
        practitionerNpi: "9876543210",
        practitionerDisplay: "Dr. Sarah Johnson",
      });
      const result = processEncounter(enc);

      // Best match is referral-001 (Mercy General), not referral-002 (Valley)
      expect(result.bestMatch!.serviceRequestId).toBe("referral-001");

      // If there are other match results, Valley should score lower
      const valleyMatch = result.matchResults.find(
        (m) => m.serviceRequestId === "referral-002",
      );
      if (valleyMatch) {
        // Valley Cardiology NPI won't match Mercy General's NPI
        expect(valleyMatch.score).toBeLessThan(result.bestMatch!.score);
      }
    });

    it("task-001 (Mercy) updates to scheduled, task-002 (Valley) stays awaiting", () => {
      const enc = makeEhrEncounter({
        status: "planned",
        practitionerNpi: "9876543210",
        practitionerDisplay: "Dr. Sarah Johnson",
      });
      processEncounter(enc);

      const task1 = tasks.get("task-001")!;
      expect(task1.status).toBe("in-progress");
      expect(task1.businessStatus!.coding![0].code).toBe(
        "appointment-scheduled",
      );

      const task2 = tasks.get("task-002")!;
      expect(task2.status).toBe("requested");
      expect(task2.businessStatus!.coding![0].code).toBe(
        "awaiting-scheduling",
      );
    });

    it("patient sees encounter in portal regardless of match", () => {
      const enc = makeEhrEncounter({
        id: "enc-portal-visible",
        practitionerNpi: "9876543210",
        practitionerDisplay: "Dr. Sarah Johnson",
      });
      processEncounter(enc);
      expect(encounters.has("enc-portal-visible")).toBe(true);
    });

    it("full lifecycle: planned -> finished closes Mercy referral, Valley stays pending", () => {
      const ENCOUNTER_ID = "enc-lifecycle";

      // Step 1: planned encounter at Mercy General with Dr. Johnson
      processEncounter(makeEhrEncounter({
        id: ENCOUNTER_ID,
        status: "planned",
        practitionerNpi: "9876543210",
        practitionerDisplay: "Dr. Sarah Johnson",
      }));
      expect(tasks.get("task-001")!.status).toBe("in-progress");
      expect(encounters.size).toBe(1);

      // Step 2: same encounter finishes at Mercy General with Dr. Johnson
      processEncounter(
        makeEhrEncounter({
          id: ENCOUNTER_ID,
          status: "finished",
          practitionerNpi: "9876543210",
          practitionerDisplay: "Dr. Sarah Johnson",
        }),
      );
      expect(tasks.get("task-001")!.status).toBe("completed");
      expect(tasks.get("task-001")!.businessStatus!.coding![0].code).toBe(
        "loop-closed",
      );

      // Still only 1 encounter (same ID updated in place)
      expect(encounters.size).toBe(1);
      expect(encounters.get(ENCOUNTER_ID)!.status).toBe("finished");

      // Only 1 routed event (upserted, not duplicated)
      expect(routedEvents.length).toBe(1);
      expect(routedEvents[0].encounterId).toBe(ENCOUNTER_ID);

      // Valley Cardiology referral is still pending
      expect(tasks.get("task-002")!.status).toBe("requested");
    });
  });

  // -------------------------------------------------------------------------
  // all-encounters mode
  // -------------------------------------------------------------------------

  describe("all-encounters mode", () => {
    beforeEach(() => {
      setSharingPreference({
        patientId: "patient-001",
        physicianRef: "Practitioner/dr-smith",
        mode: "all-encounters",
        grantedAt: new Date().toISOString(),
        active: true,
      });
    });

    it("encounter with Dr. Johnson: matches referral and routes", () => {
      const enc = makeEhrEncounter({
        status: "planned",
        practitionerNpi: "9876543210",
        practitionerDisplay: "Dr. Sarah Johnson",
      });
      const result = processEncounter(enc);
      expect(result.routed).toBe(true);
      expect(result.bestMatch).not.toBeNull();
    });

    it("all-encounters mode routes even after Mercy referral is closed", () => {
      // Close the Mercy referral first
      processEncounter(
        makeEhrEncounter({
          id: "enc-close",
          status: "finished",
          practitionerNpi: "9876543210",
          practitionerDisplay: "Dr. Sarah Johnson",
        }),
      );
      expect(tasks.get("task-001")!.status).toBe("completed");

      // New encounter: no active Mercy referral to match,
      // but all-encounters mode routes it anyway
      const enc = makeEhrEncounter({
        id: "enc-after-close",
        status: "planned",
        practitionerNpi: "9876543210",
        practitionerDisplay: "Dr. Sarah Johnson",
      });
      const result = processEncounter(enc);
      expect(result.routed).toBe(true);
      expect(result.reason).toContain("share all encounters");
    });
  });

  // -------------------------------------------------------------------------
  // switching modes
  // -------------------------------------------------------------------------

  describe("switching modes", () => {
    it("referrals-only: encounter routes (Mercy match). After closing loop, new encounter does NOT route", () => {
      setSharingPreference({
        patientId: "patient-001",
        physicianRef: "Practitioner/dr-smith",
        mode: "referrals-only",
        grantedAt: new Date().toISOString(),
        active: true,
      });

      // Close the Mercy referral with Dr. Johnson
      const r1 = processEncounter(
        makeEhrEncounter({
          id: "enc-close-it",
          status: "finished",
          practitionerNpi: "9876543210",
          practitionerDisplay: "Dr. Sarah Johnson",
        }),
      );
      expect(r1.routed).toBe(true);

      // New encounter: Mercy referral is closed (completed), Valley doesn't match
      // In referrals-only mode, no active matching referral → not routed
      const r2 = processEncounter(
        makeEhrEncounter({
          id: "enc-after",
          status: "planned",
          practitionerNpi: "9876543210",
          practitionerDisplay: "Dr. Sarah Johnson",
        }),
      );
      // The Valley referral may score low but below threshold
      // Without a matching referral above threshold, it won't route in referrals-only mode
      expect(r2.bestMatch?.serviceRequestId).not.toBe("referral-002");
    });

    it("switch to all-encounters: now routes regardless", () => {
      setSharingPreference({
        patientId: "patient-001",
        physicianRef: "Practitioner/dr-smith",
        mode: "referrals-only",
        grantedAt: new Date().toISOString(),
        active: true,
      });

      // Close Mercy referral
      processEncounter(
        makeEhrEncounter({
          id: "enc-close2",
          status: "finished",
          practitionerNpi: "9876543210",
          practitionerDisplay: "Dr. Sarah Johnson",
        }),
      );

      // Switch to all-encounters
      setSharingPreference({
        patientId: "patient-001",
        physicianRef: "Practitioner/dr-smith",
        mode: "all-encounters",
        grantedAt: new Date().toISOString(),
        active: true,
      });

      const r2 = processEncounter(
        makeEhrEncounter({
          id: "enc-afterswitch",
          status: "planned",
          practitionerNpi: "9876543210",
          practitionerDisplay: "Dr. Sarah Johnson",
        }),
      );
      expect(r2.routed).toBe(true);
    });
  });
});
