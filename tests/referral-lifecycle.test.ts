import { describe, it, expect, beforeEach } from "bun:test";
import {
  processEncounter,
  checkOverdueTasks,
  updateTaskForEncounter,
  buildMatchContext,
} from "../portal/routing";
import {
  clearAllStores,
  setSharingPreference,
  serviceRequests,
  tasks,
  organizations,
  practitioners,
  practitionerRoles,
  routedEvents,
} from "../store";
import {
  makeServiceRequest,
  makeTask,
  makeEncounter,
  makeOrganization,
  makePractitioner,
  makePractitionerRole,
} from "../fhir/resources";

// ---------------------------------------------------------------------------
// Seed helper — same data as consent-routing tests plus a sharing preference
// ---------------------------------------------------------------------------

function seedWithSharing() {
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

  // Set sharing preference so routing is enabled
  setSharingPreference({
    patientId: "patient-001",
    physicianRef: "Practitioner/dr-smith",
    mode: "referrals-only",
    grantedAt: new Date().toISOString(),
    active: true,
  });
}

// ---------------------------------------------------------------------------
// Tests: referral lifecycle (Task state machine)
// ---------------------------------------------------------------------------

describe("referral lifecycle", () => {
  beforeEach(() => {
    clearAllStores();
    seedWithSharing();
  });

  it("new referral: Task status=requested, businessStatus=awaiting-scheduling", () => {
    const task = tasks.get("task-001")!;
    expect(task.status).toBe("requested");
    expect(task.businessStatus!.coding![0].code).toBe("awaiting-scheduling");
  });

  it("planned encounter matched: Task -> in-progress/appointment-scheduled", () => {
    const enc = makeEncounter({
      id: "enc-planned",
      patientId: "patient-001",
      status: "planned",
      classCode: "AMB",
      serviceProviderRef: "Organization/org-valley",
      serviceProviderDisplay: "Valley Cardiology",
      practitionerRef: "Practitioner/dr-johnson",
      periodStart: "2026-02-15T09:00:00Z",
    });

    processEncounter(enc);
    const task = tasks.get("task-001")!;
    expect(task.status).toBe("in-progress");
    expect(task.businessStatus!.coding![0].code).toBe("appointment-scheduled");
  });

  it("in-progress encounter matched: Task -> in-progress/encounter-in-progress", () => {
    const enc = makeEncounter({
      id: "enc-inprogress",
      patientId: "patient-001",
      status: "in-progress",
      classCode: "AMB",
      serviceProviderRef: "Organization/org-valley",
      serviceProviderDisplay: "Valley Cardiology",
      practitionerRef: "Practitioner/dr-johnson",
      periodStart: "2026-02-15T09:00:00Z",
    });

    processEncounter(enc);
    const task = tasks.get("task-001")!;
    expect(task.status).toBe("in-progress");
    expect(task.businessStatus!.coding![0].code).toBe("encounter-in-progress");
  });

  it("arrived encounter matched: Task -> in-progress/encounter-in-progress", () => {
    const enc = makeEncounter({
      id: "enc-arrived",
      patientId: "patient-001",
      status: "arrived",
      classCode: "AMB",
      serviceProviderRef: "Organization/org-valley",
      serviceProviderDisplay: "Valley Cardiology",
      practitionerRef: "Practitioner/dr-johnson",
      periodStart: "2026-02-15T09:00:00Z",
    });

    processEncounter(enc);
    const task = tasks.get("task-001")!;
    expect(task.status).toBe("in-progress");
    expect(task.businessStatus!.coding![0].code).toBe("encounter-in-progress");
  });

  it("triaged encounter matched: Task -> in-progress/encounter-in-progress", () => {
    const enc = makeEncounter({
      id: "enc-triaged",
      patientId: "patient-001",
      status: "triaged",
      classCode: "AMB",
      serviceProviderRef: "Organization/org-valley",
      serviceProviderDisplay: "Valley Cardiology",
      practitionerRef: "Practitioner/dr-johnson",
      periodStart: "2026-02-15T09:00:00Z",
    });

    processEncounter(enc);
    const task = tasks.get("task-001")!;
    expect(task.status).toBe("in-progress");
    expect(task.businessStatus!.coding![0].code).toBe("encounter-in-progress");
  });

  it("finished encounter matched: Task -> completed/loop-closed, encounter in output", () => {
    const enc = makeEncounter({
      id: "enc-finished",
      patientId: "patient-001",
      status: "finished",
      classCode: "AMB",
      serviceProviderRef: "Organization/org-valley",
      serviceProviderDisplay: "Valley Cardiology",
      practitionerRef: "Practitioner/dr-johnson",
      periodStart: "2026-02-15T09:00:00Z",
    });

    processEncounter(enc);
    const task = tasks.get("task-001")!;
    expect(task.status).toBe("completed");
    expect(task.businessStatus!.coding![0].code).toBe("loop-closed");
    expect(task.output!.length).toBeGreaterThan(0);
    expect(task.output![0].valueReference?.reference).toBe(
      "Encounter/enc-finished",
    );
  });

  it("overdue: no encounter after restriction.period.end -> Task -> failed/overdue", () => {
    // Modify task to have an expired due date
    const task = tasks.get("task-001")!;
    task.restriction = { period: { end: "2020-01-01" } };

    const overdue = checkOverdueTasks();
    expect(overdue).toContain("task-001");
    expect(task.status).toBe("failed");
    expect(task.businessStatus!.coding![0].code).toBe("overdue");
  });

  it("overdue check does not affect completed tasks", () => {
    const task = tasks.get("task-001")!;
    task.status = "completed";
    task.restriction = { period: { end: "2020-01-01" } };

    const overdue = checkOverdueTasks();
    expect(overdue).not.toContain("task-001");
    expect(task.status).toBe("completed");
  });

  it("overdue check does not affect failed tasks", () => {
    const task = tasks.get("task-001")!;
    task.status = "failed";
    task.restriction = { period: { end: "2020-01-01" } };

    const overdue = checkOverdueTasks();
    expect(overdue).not.toContain("task-001");
    expect(task.status).toBe("failed");
  });

  it("overdue check does not affect cancelled tasks", () => {
    const task = tasks.get("task-001")!;
    task.status = "cancelled";
    task.restriction = { period: { end: "2020-01-01" } };

    const overdue = checkOverdueTasks();
    expect(overdue).not.toContain("task-001");
    expect(task.status).toBe("cancelled");
  });

  it("overdue check skips tasks with no restriction period", () => {
    const task = tasks.get("task-001")!;
    task.restriction = undefined;

    const overdue = checkOverdueTasks();
    expect(overdue).not.toContain("task-001");
    expect(task.status).toBe("requested");
  });

  it("overdue check skips tasks whose due date is in the future", () => {
    const task = tasks.get("task-001")!;
    task.restriction = { period: { end: "2099-12-31" } };

    const overdue = checkOverdueTasks();
    expect(overdue).not.toContain("task-001");
    expect(task.status).toBe("requested");
  });

  it("completed referral is not affected by subsequent encounters", () => {
    // First, close the loop
    const enc1 = makeEncounter({
      id: "enc-close",
      patientId: "patient-001",
      status: "finished",
      classCode: "AMB",
      serviceProviderRef: "Organization/org-valley",
      serviceProviderDisplay: "Valley Cardiology",
      practitionerRef: "Practitioner/dr-johnson",
      periodStart: "2026-02-15T09:00:00Z",
    });
    processEncounter(enc1);

    const task = tasks.get("task-001")!;
    expect(task.status).toBe("completed");

    // Another encounter should not change status
    const enc2 = makeEncounter({
      id: "enc-followup",
      patientId: "patient-001",
      status: "finished",
      classCode: "AMB",
      serviceProviderRef: "Organization/org-valley",
      serviceProviderDisplay: "Valley Cardiology",
      practitionerRef: "Practitioner/dr-johnson",
      periodStart: "2026-03-15T09:00:00Z",
    });
    processEncounter(enc2);

    expect(task.status).toBe("completed");
    expect(task.businessStatus!.coding![0].code).toBe("loop-closed");
  });

  it("cancelled sharing preference -> Task still gets updated by match, but routing stops", () => {
    setSharingPreference({
      patientId: "patient-001",
      physicianRef: "Practitioner/dr-smith",
      mode: "referrals-only",
      grantedAt: new Date().toISOString(),
      active: false, // Deactivated
    });

    const enc = makeEncounter({
      id: "enc-cancelled",
      patientId: "patient-001",
      status: "planned",
      classCode: "AMB",
      serviceProviderRef: "Organization/org-valley",
      serviceProviderDisplay: "Valley Cardiology",
      practitionerRef: "Practitioner/dr-johnson",
      periodStart: "2026-02-15T09:00:00Z",
    });

    const result = processEncounter(enc);
    expect(result.routed).toBe(false);
    // Task is still updated because matching is independent of consent
    const task = tasks.get("task-001")!;
    expect(task.status).toBe("in-progress");
    expect(task.businessStatus!.coding![0].code).toBe("appointment-scheduled");
    // No routed events
    expect(routedEvents.length).toBe(0);
  });

  it("sequential lifecycle: planned -> in-progress -> finished", () => {
    // Step 1: planned encounter
    const encPlanned = makeEncounter({
      id: "enc-step1",
      patientId: "patient-001",
      status: "planned",
      classCode: "AMB",
      serviceProviderRef: "Organization/org-valley",
      serviceProviderDisplay: "Valley Cardiology",
      practitionerRef: "Practitioner/dr-johnson",
      periodStart: "2026-02-15T09:00:00Z",
    });
    processEncounter(encPlanned);
    let task = tasks.get("task-001")!;
    expect(task.status).toBe("in-progress");
    expect(task.businessStatus!.coding![0].code).toBe("appointment-scheduled");

    // Step 2: in-progress encounter
    const encInProgress = makeEncounter({
      id: "enc-step2",
      patientId: "patient-001",
      status: "in-progress",
      classCode: "AMB",
      serviceProviderRef: "Organization/org-valley",
      serviceProviderDisplay: "Valley Cardiology",
      practitionerRef: "Practitioner/dr-johnson",
      periodStart: "2026-02-15T09:00:00Z",
    });
    processEncounter(encInProgress);
    task = tasks.get("task-001")!;
    expect(task.status).toBe("in-progress");
    expect(task.businessStatus!.coding![0].code).toBe("encounter-in-progress");

    // Step 3: finished encounter
    const encFinished = makeEncounter({
      id: "enc-step3",
      patientId: "patient-001",
      status: "finished",
      classCode: "AMB",
      serviceProviderRef: "Organization/org-valley",
      serviceProviderDisplay: "Valley Cardiology",
      practitionerRef: "Practitioner/dr-johnson",
      periodStart: "2026-02-15T09:00:00Z",
    });
    processEncounter(encFinished);
    task = tasks.get("task-001")!;
    expect(task.status).toBe("completed");
    expect(task.businessStatus!.coding![0].code).toBe("loop-closed");
    expect(task.output!.length).toBe(1);
    expect(task.output![0].valueReference?.reference).toBe(
      "Encounter/enc-step3",
    );
  });

  it("updateTaskForEncounter sets lastModified timestamp", () => {
    const task = tasks.get("task-001")!;
    const originalModified = task.lastModified;

    const enc = makeEncounter({
      id: "enc-timestamp",
      patientId: "patient-001",
      status: "planned",
      classCode: "AMB",
      serviceProviderRef: "Organization/org-valley",
      serviceProviderDisplay: "Valley Cardiology",
      practitionerRef: "Practitioner/dr-johnson",
      periodStart: "2026-02-15T09:00:00Z",
    });

    updateTaskForEncounter("task-001", enc, {
      serviceRequestId: "referral-001",
      taskId: "task-001",
      score: 0.9,
      confidence: "high",
      signals: {
        orgNpi: true,
        orgName: 1.0,
        practitionerNpi: true,
        specialty: true,
        dateInWindow: true,
      },
    });

    expect(task.lastModified).not.toBe(originalModified);
  });

  it("overdue check sets lastModified on overdue tasks", () => {
    const task = tasks.get("task-001")!;
    const originalModified = task.lastModified;
    task.restriction = { period: { end: "2020-01-01" } };

    checkOverdueTasks();

    expect(task.lastModified).not.toBe(originalModified);
  });

  it("processEncounter returns taskUpdated when match found", () => {
    const enc = makeEncounter({
      id: "enc-taskref",
      patientId: "patient-001",
      status: "planned",
      classCode: "AMB",
      serviceProviderRef: "Organization/org-valley",
      serviceProviderDisplay: "Valley Cardiology",
      practitionerRef: "Practitioner/dr-johnson",
      periodStart: "2026-02-15T09:00:00Z",
    });

    const result = processEncounter(enc);
    expect(result.taskUpdated).toBe("task-001");
  });

  it("processEncounter returns no taskUpdated when no match", () => {
    const enc = makeEncounter({
      id: "enc-nomatch",
      patientId: "patient-001",
      status: "planned",
      classCode: "AMB",
      serviceProviderRef: "Organization/org-urgent-care",
      serviceProviderDisplay: "City Urgent Care",
      periodStart: "2026-02-15T09:00:00Z",
    });

    const result = processEncounter(enc);
    expect(result.taskUpdated).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Tests: buildMatchContext
// ---------------------------------------------------------------------------

describe("buildMatchContext", () => {
  beforeEach(() => {
    clearAllStores();
    seedWithSharing();
  });

  it("orgNpiLookup resolves organization NPI from store", () => {
    const ctx = buildMatchContext();
    const npi = ctx.orgNpiLookup!("Organization/org-valley");
    expect(npi).toBe("1122334455");
  });

  it("orgNpiLookup returns undefined for unknown org", () => {
    const ctx = buildMatchContext();
    const npi = ctx.orgNpiLookup!("Organization/unknown");
    expect(npi).toBeUndefined();
  });

  it("practitionerNpiLookup resolves practitioner NPI from store", () => {
    const ctx = buildMatchContext();
    const npi = ctx.practitionerNpiLookup!("Practitioner/dr-johnson");
    expect(npi).toBe("9876543210");
  });

  it("practitionerNpiLookup returns undefined for unknown practitioner", () => {
    const ctx = buildMatchContext();
    const npi = ctx.practitionerNpiLookup!("Practitioner/unknown");
    expect(npi).toBeUndefined();
  });

  it("specialtyLookup resolves specialty code via PractitionerRole", () => {
    const ctx = buildMatchContext();
    const code = ctx.specialtyLookup!("Practitioner/dr-johnson");
    expect(code).toBe("207RC0000X");
  });

  it("specialtyLookup returns undefined for practitioner with no role", () => {
    const ctx = buildMatchContext();
    const code = ctx.specialtyLookup!("Practitioner/dr-smith");
    expect(code).toBeUndefined();
  });
});
