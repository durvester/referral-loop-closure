import { describe, it, expect, beforeEach } from "bun:test";
import {
  processEncounter,
  checkOverdueTasks,
  buildMatchContext,
  updateTaskForEncounter,
} from "../portal/routing";
import {
  clearAllStores,
  setSharingPreference,
  getSharingPreference,
  serviceRequests,
  tasks,
  organizations,
  practitioners,
  practitionerRoles,
  encounters,
  routedEvents,
  sharingPreferences,
} from "../store";
import {
  makeServiceRequest,
  makeTask,
  makeEncounter,
  makeOrganization,
  makePractitioner,
  makePractitionerRole,
} from "../fhir/resources";
import type { SharingPreference, Encounter } from "../fhir/types";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function seedTestData() {
  // Create org with NPI
  const org = makeOrganization({
    id: "org-valley",
    name: "Valley Cardiology",
    npi: "1122334455",
  });
  organizations.set(org.id, org);

  // Create referring physician
  const drSmith = makePractitioner({
    id: "dr-smith",
    name: "Dr. Robert Smith",
    npi: "1234567890",
  });
  practitioners.set(drSmith.id, drSmith);

  // Create specialist
  const drJohnson = makePractitioner({
    id: "dr-johnson",
    name: "Dr. Sarah Johnson",
    npi: "9876543210",
  });
  practitioners.set(drJohnson.id, drJohnson);

  // Create specialist role
  const role = makePractitionerRole({
    id: "role-cardio",
    practitionerId: "dr-johnson",
    practitionerDisplay: "Dr. Sarah Johnson",
    organizationId: "org-valley",
    organizationDisplay: "Valley Cardiology",
    specialtyCode: "207RC0000X",
    specialtyDisplay: "Cardiovascular Disease",
  });
  practitionerRoles.set(role.id, role);

  // Create referral
  const sr = makeServiceRequest({
    id: "referral-001",
    patientId: "patient-001",
    requesterId: "dr-smith",
    requesterDisplay: "Dr. Robert Smith",
    codeText: "Cardiology consultation",
    reasonCode: "49436004",
    reasonDisplay: "Atrial fibrillation",
    authoredOn: "2026-02-01T10:30:00Z",
    occurrenceStart: "2026-02-01",
    occurrenceEnd: "2026-04-01",
    targetOrgNpi: "1122334455",
    targetOrgName: "Valley Cardiology",
    targetPractitionerNpi: "9876543210",
    targetSpecialtyCode: "207RC0000X",
    targetSpecialtyDisplay: "Cardiovascular Disease",
    originMethod: "fax",
  });
  serviceRequests.set(sr.id, sr);

  // Create task
  const task = makeTask({
    id: "task-001",
    serviceRequestId: "referral-001",
    patientId: "patient-001",
    requesterId: "dr-smith",
    requesterDisplay: "Dr. Robert Smith",
    ownerId: "org-valley",
    ownerDisplay: "Valley Cardiology",
    authoredOn: "2026-02-01T10:30:00Z",
    dueDate: "2026-04-01",
  });
  tasks.set(task.id, task);
}

function makeMatchingEncounter(
  overrides: Partial<Parameters<typeof makeEncounter>[0]> = {},
): Encounter {
  return makeEncounter({
    id: `enc-${Date.now()}`,
    patientId: "patient-001",
    status: "planned",
    classCode: "AMB",
    serviceProviderRef: "Organization/org-valley",
    serviceProviderDisplay: "Valley Cardiology",
    practitionerRef: "Practitioner/dr-johnson",
    periodStart: "2026-02-15T09:00:00Z",
    ...overrides,
  });
}

function makeNonMatchingEncounter(
  overrides: Partial<Parameters<typeof makeEncounter>[0]> = {},
): Encounter {
  return makeEncounter({
    id: `enc-nonmatch-${Date.now()}`,
    patientId: "patient-001",
    status: "planned",
    classCode: "AMB",
    serviceProviderRef: "Organization/org-urgent-care",
    serviceProviderDisplay: "City Urgent Care",
    periodStart: "2026-02-15T09:00:00Z",
    ...overrides,
  });
}

// ---------------------------------------------------------------------------
// Tests: sharing preferences and routing
// ---------------------------------------------------------------------------

describe("sharing preferences", () => {
  beforeEach(() => {
    clearAllStores();
    seedTestData();
  });

  it("default: no preference set -> encounter stays in portal only", () => {
    const enc = makeMatchingEncounter();
    const result = processEncounter(enc);
    expect(result.routed).toBe(false);
    expect(result.reason).toContain("No active sharing preference");
    expect(routedEvents.length).toBe(0);
  });

  it('"referrals-only": matched encounter routes to physician', () => {
    setSharingPreference({
      patientId: "patient-001",
      physicianRef: "Practitioner/dr-smith",
      mode: "referrals-only",
      grantedAt: new Date().toISOString(),
      active: true,
    });

    const enc = makeMatchingEncounter();
    const result = processEncounter(enc);
    expect(result.routed).toBe(true);
    expect(result.bestMatch).toBeDefined();
    expect(result.bestMatch!.score).toBeGreaterThan(0.4);
    expect(routedEvents.length).toBe(1);
  });

  it('"referrals-only": unmatched encounter stays in portal only', () => {
    setSharingPreference({
      patientId: "patient-001",
      physicianRef: "Practitioner/dr-smith",
      mode: "referrals-only",
      grantedAt: new Date().toISOString(),
      active: true,
    });

    const enc = makeNonMatchingEncounter();
    const result = processEncounter(enc);
    expect(result.routed).toBe(false);
    expect(result.reason).toContain("No referral match");
    expect(routedEvents.length).toBe(0);
  });

  it('"all-encounters": matched encounter routes to physician', () => {
    setSharingPreference({
      patientId: "patient-001",
      physicianRef: "Practitioner/dr-smith",
      mode: "all-encounters",
      grantedAt: new Date().toISOString(),
      active: true,
    });

    const enc = makeMatchingEncounter();
    const result = processEncounter(enc);
    expect(result.routed).toBe(true);
    expect(routedEvents.length).toBe(1);
  });

  it('"all-encounters": unmatched encounter also routes to physician', () => {
    setSharingPreference({
      patientId: "patient-001",
      physicianRef: "Practitioner/dr-smith",
      mode: "all-encounters",
      grantedAt: new Date().toISOString(),
      active: true,
    });

    const enc = makeNonMatchingEncounter();
    const result = processEncounter(enc);
    expect(result.routed).toBe(true);
    expect(result.reason).toContain("share all encounters");
    expect(routedEvents.length).toBe(1);
  });

  it('preference can be changed from "referrals-only" to "all-encounters"', () => {
    setSharingPreference({
      patientId: "patient-001",
      physicianRef: "Practitioner/dr-smith",
      mode: "referrals-only",
      grantedAt: new Date().toISOString(),
      active: true,
    });

    const enc1 = makeNonMatchingEncounter({ id: "enc-before" });
    const r1 = processEncounter(enc1);
    expect(r1.routed).toBe(false);

    // Change to all-encounters
    setSharingPreference({
      patientId: "patient-001",
      physicianRef: "Practitioner/dr-smith",
      mode: "all-encounters",
      grantedAt: new Date().toISOString(),
      active: true,
    });

    const enc2 = makeNonMatchingEncounter({ id: "enc-after" });
    const r2 = processEncounter(enc2);
    expect(r2.routed).toBe(true);
  });

  it("deactivated preference stops routing", () => {
    setSharingPreference({
      patientId: "patient-001",
      physicianRef: "Practitioner/dr-smith",
      mode: "all-encounters",
      grantedAt: new Date().toISOString(),
      active: false,
    });

    const enc = makeMatchingEncounter();
    const result = processEncounter(enc);
    expect(result.routed).toBe(false);
  });

  it("routing includes encounter data and match details", () => {
    setSharingPreference({
      patientId: "patient-001",
      physicianRef: "Practitioner/dr-smith",
      mode: "referrals-only",
      grantedAt: new Date().toISOString(),
      active: true,
    });

    const enc = makeMatchingEncounter({ id: "enc-details" });
    const result = processEncounter(enc);
    expect(result.routed).toBe(true);
    expect(routedEvents[0].encounter.id).toBe("enc-details");
    expect(routedEvents[0].matchScore).toBeGreaterThan(0);
  });

  it("routed encounters appear in physician's referral timeline", () => {
    setSharingPreference({
      patientId: "patient-001",
      physicianRef: "Practitioner/dr-smith",
      mode: "referrals-only",
      grantedAt: new Date().toISOString(),
      active: true,
    });

    processEncounter(makeMatchingEncounter({ id: "enc-timeline" }));
    expect(routedEvents.some((e) => e.encounterId === "enc-timeline")).toBe(
      true,
    );
    expect(routedEvents[0].physicianRef).toBe("Practitioner/dr-smith");
  });

  it("non-routed encounters do NOT appear in physician view", () => {
    setSharingPreference({
      patientId: "patient-001",
      physicianRef: "Practitioner/dr-smith",
      mode: "referrals-only",
      grantedAt: new Date().toISOString(),
      active: true,
    });

    processEncounter(makeNonMatchingEncounter({ id: "enc-private" }));
    expect(routedEvents.some((e) => e.encounterId === "enc-private")).toBe(
      false,
    );
    // But it should be in the encounters store (patient portal)
    expect(encounters.has("enc-private")).toBe(true);
  });

  it("encounter is always stored in encounters map regardless of routing", () => {
    // No sharing preference at all
    const enc = makeMatchingEncounter({ id: "enc-stored" });
    processEncounter(enc);
    expect(encounters.has("enc-stored")).toBe(true);
  });

  it("processEncounter returns patientId extracted from encounter subject", () => {
    const enc = makeMatchingEncounter({ id: "enc-pid" });
    const result = processEncounter(enc);
    expect(result.patientId).toBe("patient-001");
    expect(result.encounterId).toBe("enc-pid");
  });
});
