import { describe, it, expect } from "bun:test";
import {
  makePatient,
  makePractitioner,
  makeOrganization,
  makePractitionerRole,
  makeServiceRequest,
  makeTask,
  makeEncounter,
} from "../fhir/resources";
import type {
  Patient,
  Practitioner,
  Organization,
  PractitionerRole,
  ServiceRequest,
  Task,
  Encounter,
  Extension,
} from "../fhir/types";

// ---------------------------------------------------------------------------
// makePatient
// ---------------------------------------------------------------------------
describe("makePatient", () => {
  it("creates US Core Patient with name parsed into family/given", () => {
    const patient = makePatient({
      id: "pat-1",
      name: "Alice M Rodriguez",
      birthDate: "1985-03-15",
    });

    expect(patient.resourceType).toBe("Patient");
    expect(patient.id).toBe("pat-1");
    expect(patient.meta?.profile).toContain(
      "http://hl7.org/fhir/us/core/StructureDefinition/us-core-patient"
    );
    expect(patient.name[0].family).toBe("Rodriguez");
    expect(patient.name[0].given).toEqual(["Alice", "M"]);
    expect(patient.name[0].text).toBe("Alice M Rodriguez");
  });

  it("includes birthDate", () => {
    const patient = makePatient({
      id: "pat-2",
      name: "Bob Jones",
      birthDate: "1990-07-04",
      gender: "male",
    });

    expect(patient.birthDate).toBe("1990-07-04");
    expect(patient.gender).toBe("male");
  });
});

// ---------------------------------------------------------------------------
// makePractitioner
// ---------------------------------------------------------------------------
describe("makePractitioner", () => {
  it("creates Practitioner with NPI identifier", () => {
    const pract = makePractitioner({
      id: "pract-1",
      name: "Dr. Robert Smith",
      npi: "1234567890",
    });

    expect(pract.resourceType).toBe("Practitioner");
    expect(pract.id).toBe("pract-1");
    expect(pract.identifier).toBeDefined();
    expect(pract.identifier![0].system).toBe("http://hl7.org/fhir/sid/us-npi");
    expect(pract.identifier![0].value).toBe("1234567890");
  });

  it("includes name and credentials", () => {
    const pract = makePractitioner({
      id: "pract-2",
      name: "Dr. Robert Smith",
      npi: "1234567890",
      credentials: "MD",
    });

    expect(pract.name[0].family).toBe("Smith");
    expect(pract.name[0].given).toEqual(["Robert"]);
    expect(pract.name[0].prefix).toEqual(["Dr."]);
    expect(pract.name[0].text).toBe("Dr. Robert Smith");
    expect(pract.qualification).toBeDefined();
    expect(pract.qualification![0].code.text).toBe("MD");
  });
});

// ---------------------------------------------------------------------------
// makeOrganization
// ---------------------------------------------------------------------------
describe("makeOrganization", () => {
  it("creates Organization with NPI identifier", () => {
    const org = makeOrganization({
      id: "org-1",
      name: "Valley Cardiology",
      npi: "9876543210",
    });

    expect(org.resourceType).toBe("Organization");
    expect(org.id).toBe("org-1");
    expect(org.identifier).toBeDefined();
    expect(org.identifier![0].system).toBe("http://hl7.org/fhir/sid/us-npi");
    expect(org.identifier![0].value).toBe("9876543210");
  });

  it("includes name and aliases", () => {
    const org = makeOrganization({
      id: "org-2",
      name: "Valley Cardiology Associates",
      npi: "9876543210",
      aliases: ["VCA", "Valley Cardio"],
      type: "prov",
      city: "Springfield",
      state: "IL",
    });

    expect(org.name).toBe("Valley Cardiology Associates");
    expect(org.alias).toEqual(["VCA", "Valley Cardio"]);
    expect(org.type).toBeDefined();
    expect(org.type![0].coding![0].code).toBe("prov");
    expect(org.type![0].coding![0].display).toBe("Healthcare Provider");
    expect(org.address).toBeDefined();
    expect(org.address![0].city).toBe("Springfield");
    expect(org.address![0].state).toBe("IL");
  });
});

// ---------------------------------------------------------------------------
// makePractitionerRole
// ---------------------------------------------------------------------------
describe("makePractitionerRole", () => {
  it("links practitioner and organization", () => {
    const role = makePractitionerRole({
      id: "role-1",
      practitionerId: "pract-1",
      practitionerDisplay: "Dr. Robert Smith",
      organizationId: "org-1",
      organizationDisplay: "Valley Cardiology",
      specialtyCode: "207RC0000X",
      specialtyDisplay: "Cardiovascular Disease",
    });

    expect(role.resourceType).toBe("PractitionerRole");
    expect(role.id).toBe("role-1");
    expect(role.practitioner.reference).toBe("Practitioner/pract-1");
    expect(role.practitioner.display).toBe("Dr. Robert Smith");
    expect(role.organization.reference).toBe("Organization/org-1");
    expect(role.organization.display).toBe("Valley Cardiology");
  });

  it("includes specialty taxonomy coding", () => {
    const role = makePractitionerRole({
      id: "role-1",
      practitionerId: "pract-1",
      practitionerDisplay: "Dr. Robert Smith",
      organizationId: "org-1",
      organizationDisplay: "Valley Cardiology",
      specialtyCode: "207RC0000X",
      specialtyDisplay: "Cardiovascular Disease",
    });

    expect(role.specialty).toBeDefined();
    expect(role.specialty!.length).toBe(1);
    const coding = role.specialty![0].coding![0];
    expect(coding.system).toBe("http://nucc.org/provider-taxonomy");
    expect(coding.code).toBe("207RC0000X");
    expect(coding.display).toBe("Cardiovascular Disease");
  });
});

// ---------------------------------------------------------------------------
// makeServiceRequest
// ---------------------------------------------------------------------------
describe("makeServiceRequest", () => {
  const baseInput = {
    id: "sr-1",
    patientId: "pat-1",
    requesterId: "pract-pcp",
    requesterDisplay: "Dr. Sarah Chen",
    codeText: "Cardiology consultation",
    reasonCode: "194828000",
    reasonDisplay: "Angina pectoris",
    authoredOn: "2025-01-15",
    occurrenceStart: "2025-01-15",
    occurrenceEnd: "2025-03-15",
  };

  it("creates valid ServiceRequest with required fields", () => {
    const sr = makeServiceRequest(baseInput);

    expect(sr.resourceType).toBe("ServiceRequest");
    expect(sr.id).toBe("sr-1");
    expect(sr.status).toBe("active");
    expect(sr.intent).toBe("order");
    expect(sr.category).toBeDefined();
    expect(sr.category![0].coding![0].code).toBe("3457005");
    expect(sr.category![0].coding![0].display).toBe("Patient referral");
    expect(sr.code?.text).toBe("Cardiology consultation");
    expect(sr.authoredOn).toBe("2025-01-15");
  });

  it("includes referral-target-identifiers extension with org NPI, name, practitioner NPI, specialty", () => {
    const sr = makeServiceRequest({
      ...baseInput,
      targetOrgNpi: "9876543210",
      targetOrgName: "Valley Cardiology",
      targetPractitionerNpi: "1234567890",
      targetSpecialtyCode: "207RC0000X",
      targetSpecialtyDisplay: "Cardiovascular Disease",
    });

    expect(sr.extension).toBeDefined();
    const targetExt = sr.extension!.find(
      (e) =>
        e.url ===
        "http://example.org/fhir/StructureDefinition/referral-target-identifiers"
    );
    expect(targetExt).toBeDefined();
    expect(targetExt!.extension).toBeDefined();

    const subExts = targetExt!.extension!;
    const orgNpi = subExts.find((e) => e.url === "organizationNpi");
    expect(orgNpi?.valueString).toBe("9876543210");

    const orgName = subExts.find((e) => e.url === "organizationName");
    expect(orgName?.valueString).toBe("Valley Cardiology");

    const practNpi = subExts.find((e) => e.url === "practitionerNpi");
    expect(practNpi?.valueString).toBe("1234567890");

    const specialty = subExts.find((e) => e.url === "specialty");
    expect(specialty?.valueCoding?.code).toBe("207RC0000X");
    expect(specialty?.valueCoding?.display).toBe("Cardiovascular Disease");
    expect(specialty?.valueCoding?.system).toBe(
      "http://nucc.org/provider-taxonomy"
    );
  });

  it("includes referral-origin-method extension", () => {
    const sr = makeServiceRequest({
      ...baseInput,
      originMethod: "fax",
    });

    expect(sr.extension).toBeDefined();
    const originExt = sr.extension!.find(
      (e) =>
        e.url ===
        "http://example.org/fhir/StructureDefinition/referral-origin-method"
    );
    expect(originExt).toBeDefined();
    expect(originExt!.valueCode).toBe("fax");
  });

  it("sets occurrencePeriod from input dates", () => {
    const sr = makeServiceRequest(baseInput);

    expect(sr.occurrencePeriod).toBeDefined();
    expect(sr.occurrencePeriod!.start).toBe("2025-01-15");
    expect(sr.occurrencePeriod!.end).toBe("2025-03-15");
  });

  it("references patient, requester, and performer correctly", () => {
    const sr = makeServiceRequest({
      ...baseInput,
      performerRoleId: "role-cardio",
      performerDisplay: "Dr. Robert Smith (Cardiology)",
    });

    expect(sr.subject.reference).toBe("Patient/pat-1");
    expect(sr.requester?.reference).toBe("Practitioner/pract-pcp");
    expect(sr.requester?.display).toBe("Dr. Sarah Chen");
    expect(sr.performer).toBeDefined();
    expect(sr.performer![0].reference).toBe("PractitionerRole/role-cardio");
    expect(sr.performer![0].display).toBe("Dr. Robert Smith (Cardiology)");
  });
});

// ---------------------------------------------------------------------------
// makeTask
// ---------------------------------------------------------------------------
describe("makeTask", () => {
  const baseTaskInput = {
    id: "task-1",
    serviceRequestId: "sr-1",
    patientId: "pat-1",
    requesterId: "pract-pcp",
    requesterDisplay: "Dr. Sarah Chen",
    ownerId: "org-valley-cardiology",
    ownerDisplay: "Valley Cardiology",
    authoredOn: "2025-01-15",
    dueDate: "2025-03-15",
  };

  it("creates Task with status=requested, businessStatus=awaiting-scheduling", () => {
    const task = makeTask(baseTaskInput);

    expect(task.resourceType).toBe("Task");
    expect(task.id).toBe("task-1");
    expect(task.status).toBe("requested");
    expect(task.intent).toBe("order");
    expect(task.businessStatus).toBeDefined();
    expect(task.businessStatus!.coding![0].code).toBe("awaiting-scheduling");
    expect(task.businessStatus!.coding![0].display).toBe("Awaiting Scheduling");
  });

  it("references the ServiceRequest in focus", () => {
    const task = makeTask(baseTaskInput);

    expect(task.focus).toBeDefined();
    expect(task.focus!.reference).toBe("ServiceRequest/sr-1");
  });

  it("sets restriction.period.end from referral window", () => {
    const task = makeTask(baseTaskInput);

    expect(task.restriction).toBeDefined();
    expect(task.restriction!.period?.end).toBe("2025-03-15");
  });

  it("output array starts empty", () => {
    const task = makeTask(baseTaskInput);

    expect(task.output).toBeDefined();
    expect(task.output).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// makeEncounter
// ---------------------------------------------------------------------------
describe("makeEncounter", () => {
  it("creates Encounter with correct class coding", () => {
    const enc = makeEncounter({
      id: "enc-1",
      patientId: "pat-1",
      patientDisplay: "Alice Rodriguez",
      status: "finished",
      classCode: "AMB",
      periodStart: "2025-02-10T09:00:00Z",
      periodEnd: "2025-02-10T10:00:00Z",
    });

    expect(enc.resourceType).toBe("Encounter");
    expect(enc.id).toBe("enc-1");
    expect(enc.status).toBe("finished");
    expect(enc.class.code).toBe("AMB");
    expect(enc.class.display).toBe("ambulatory");
    expect(enc.class.system).toBe(
      "http://terminology.hl7.org/CodeSystem/v3-ActCode"
    );
    expect(enc.subject.reference).toBe("Patient/pat-1");
    expect(enc.period?.start).toBe("2025-02-10T09:00:00Z");
    expect(enc.period?.end).toBe("2025-02-10T10:00:00Z");
  });
});
