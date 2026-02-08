import type {
  Patient,
  Practitioner,
  Organization,
  PractitionerRole,
  ServiceRequest,
  Task,
  Encounter,
  Extension,
} from "./types";

// ---------------------------------------------------------------------------
// Patient
// ---------------------------------------------------------------------------

export interface MakePatientInput {
  id: string;
  name: string; // "Alice M Rodriguez" - parsed into family/given
  birthDate: string;
  gender?: string;
}

export function makePatient(input: MakePatientInput): Patient {
  const parts = input.name.split(" ");
  const family = parts.pop()!;
  const given = parts;
  return {
    resourceType: "Patient",
    id: input.id,
    meta: {
      profile: [
        "http://hl7.org/fhir/us/core/StructureDefinition/us-core-patient",
      ],
    },
    name: [{ family, given, text: input.name }],
    birthDate: input.birthDate,
    gender: input.gender,
  };
}

// ---------------------------------------------------------------------------
// Practitioner
// ---------------------------------------------------------------------------

export interface MakePractitionerInput {
  id: string;
  name: string; // "Dr. Robert Smith"
  npi: string;
  credentials?: string; // "MD"
}

export function makePractitioner(input: MakePractitionerInput): Practitioner {
  const parts = input.name.replace(/^Dr\.\s*/, "").split(" ");
  const family = parts.pop()!;
  const given = parts;
  const prefix = input.name.startsWith("Dr.") ? ["Dr."] : undefined;
  return {
    resourceType: "Practitioner",
    id: input.id,
    identifier: [
      { system: "http://hl7.org/fhir/sid/us-npi", value: input.npi },
    ],
    name: [{ family, given, prefix, text: input.name }],
    qualification: input.credentials
      ? [{ code: { text: input.credentials } }]
      : undefined,
  };
}

// ---------------------------------------------------------------------------
// Organization
// ---------------------------------------------------------------------------

export interface MakeOrganizationInput {
  id: string;
  name: string;
  npi: string;
  aliases?: string[];
  type?: string; // "prov" for healthcare provider
  city?: string;
  state?: string;
}

export function makeOrganization(input: MakeOrganizationInput): Organization {
  return {
    resourceType: "Organization",
    id: input.id,
    identifier: [
      { system: "http://hl7.org/fhir/sid/us-npi", value: input.npi },
    ],
    name: input.name,
    alias: input.aliases,
    type: input.type
      ? [
          {
            coding: [
              {
                system:
                  "http://terminology.hl7.org/CodeSystem/organization-type",
                code: input.type,
                display:
                  input.type === "prov"
                    ? "Healthcare Provider"
                    : input.type,
              },
            ],
          },
        ]
      : undefined,
    address: input.city
      ? [{ city: input.city, state: input.state }]
      : undefined,
  };
}

// ---------------------------------------------------------------------------
// PractitionerRole
// ---------------------------------------------------------------------------

export interface MakePractitionerRoleInput {
  id: string;
  practitionerId: string;
  practitionerDisplay: string;
  organizationId: string;
  organizationDisplay: string;
  specialtyCode: string; // NUCC taxonomy code e.g. "207RC0000X"
  specialtyDisplay: string; // e.g. "Cardiovascular Disease"
}

export function makePractitionerRole(
  input: MakePractitionerRoleInput
): PractitionerRole {
  return {
    resourceType: "PractitionerRole",
    id: input.id,
    practitioner: {
      reference: `Practitioner/${input.practitionerId}`,
      display: input.practitionerDisplay,
    },
    organization: {
      reference: `Organization/${input.organizationId}`,
      display: input.organizationDisplay,
    },
    specialty: [
      {
        coding: [
          {
            system: "http://nucc.org/provider-taxonomy",
            code: input.specialtyCode,
            display: input.specialtyDisplay,
          },
        ],
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// ServiceRequest (Referral)
// ---------------------------------------------------------------------------

export interface MakeServiceRequestInput {
  id: string;
  patientId: string;
  requesterId: string;
  requesterDisplay: string;
  performerRoleId?: string;
  performerDisplay?: string;
  reasonCode: string; // SNOMED code
  reasonDisplay: string;
  procedureCode?: string; // SNOMED code for procedure
  procedureDisplay?: string;
  codeText: string; // Free text e.g. "Cardiology consultation"
  authoredOn: string;
  occurrenceStart: string;
  occurrenceEnd: string;
  notes?: string;
  originMethod?: string; // "fax", "phone", "electronic"
  targetOrgNpi?: string;
  targetOrgName?: string;
  targetPractitionerNpi?: string;
  targetSpecialtyCode?: string;
  targetSpecialtyDisplay?: string;
}

export function makeServiceRequest(
  input: MakeServiceRequestInput
): ServiceRequest {
  const extensions: Extension[] = [];

  if (input.originMethod) {
    extensions.push({
      url: "http://example.org/fhir/StructureDefinition/referral-origin-method",
      valueCode: input.originMethod,
    });
  }

  // Build target identifiers extension
  const targetExtensions: Extension[] = [];
  if (input.targetOrgNpi) {
    targetExtensions.push({
      url: "organizationNpi",
      valueString: input.targetOrgNpi,
    });
  }
  if (input.targetOrgName) {
    targetExtensions.push({
      url: "organizationName",
      valueString: input.targetOrgName,
    });
  }
  if (input.targetPractitionerNpi) {
    targetExtensions.push({
      url: "practitionerNpi",
      valueString: input.targetPractitionerNpi,
    });
  }
  if (input.targetSpecialtyCode) {
    targetExtensions.push({
      url: "specialty",
      valueCoding: {
        system: "http://nucc.org/provider-taxonomy",
        code: input.targetSpecialtyCode,
        display: input.targetSpecialtyDisplay,
      },
    });
  }

  if (targetExtensions.length > 0) {
    extensions.push({
      url: "http://example.org/fhir/StructureDefinition/referral-target-identifiers",
      extension: targetExtensions,
    });
  }

  return {
    resourceType: "ServiceRequest",
    id: input.id,
    status: "active",
    intent: "order",
    category: [
      {
        coding: [
          {
            system: "http://snomed.info/sct",
            code: "3457005",
            display: "Patient referral",
          },
        ],
      },
    ],
    code: {
      coding: input.procedureCode
        ? [
            {
              system: "http://snomed.info/sct",
              code: input.procedureCode,
              display: input.procedureDisplay,
            },
          ]
        : undefined,
      text: input.codeText,
    },
    subject: { reference: `Patient/${input.patientId}` },
    requester: {
      reference: `Practitioner/${input.requesterId}`,
      display: input.requesterDisplay,
    },
    performer: input.performerRoleId
      ? [
          {
            reference: `PractitionerRole/${input.performerRoleId}`,
            display: input.performerDisplay,
          },
        ]
      : input.targetOrgName
        ? [
            {
              display: input.targetOrgName +
                (input.targetSpecialtyDisplay ? ` — ${input.targetSpecialtyDisplay}` : ""),
            },
          ]
        : undefined,
    reasonCode: [
      {
        coding: [
          {
            system: "http://snomed.info/sct",
            code: input.reasonCode,
            display: input.reasonDisplay,
          },
        ],
      },
    ],
    authoredOn: input.authoredOn,
    occurrencePeriod: {
      start: input.occurrenceStart,
      end: input.occurrenceEnd,
    },
    note: input.notes ? [{ text: input.notes }] : undefined,
    extension: extensions.length > 0 ? extensions : undefined,
  };
}

// ---------------------------------------------------------------------------
// Task (Referral Tracking)
// ---------------------------------------------------------------------------

export interface MakeTaskInput {
  id: string;
  serviceRequestId: string;
  patientId: string;
  requesterId: string;
  requesterDisplay?: string;
  ownerId: string; // Organization that owns the task
  ownerDisplay?: string;
  authoredOn: string;
  dueDate: string; // restriction.period.end
}

export function makeTask(input: MakeTaskInput): Task {
  return {
    resourceType: "Task",
    id: input.id,
    status: "requested",
    intent: "order",
    code: {
      coding: [
        {
          system: "http://hl7.org/fhir/CodeSystem/task-code",
          code: "fulfill",
        },
      ],
    },
    focus: { reference: `ServiceRequest/${input.serviceRequestId}` },
    for: { reference: `Patient/${input.patientId}` },
    requester: {
      reference: `Practitioner/${input.requesterId}`,
      display: input.requesterDisplay,
    },
    owner: {
      reference: `Organization/${input.ownerId}`,
      display: input.ownerDisplay,
    },
    authoredOn: input.authoredOn,
    lastModified: input.authoredOn,
    restriction: { period: { end: input.dueDate } },
    businessStatus: {
      coding: [
        {
          system:
            "http://example.org/fhir/CodeSystem/referral-tracking-status",
          code: "awaiting-scheduling",
          display: "Awaiting Scheduling",
        },
      ],
    },
    output: [],
  };
}

// ---------------------------------------------------------------------------
// Encounter
// ---------------------------------------------------------------------------

export interface MakeEncounterInput {
  id: string;
  patientId: string;
  patientDisplay?: string;
  status:
    | "planned"
    | "arrived"
    | "triaged"
    | "in-progress"
    | "onleave"
    | "finished"
    | "cancelled";
  classCode: "AMB" | "EMER" | "IMP" | "PRENC" | "VR";
  typeCode?: string; // SNOMED code
  typeDisplay?: string;
  reasonCode?: string; // SNOMED code
  reasonDisplay?: string;
  serviceProviderRef?: string; // e.g. "Organization/org-valley-cardiology"
  serviceProviderDisplay?: string;
  practitionerRef?: string;
  practitionerDisplay?: string;
  periodStart?: string;
  periodEnd?: string;
}

const ENCOUNTER_CLASSES: Record<
  string,
  { code: string; display: string; system: string }
> = {
  AMB: {
    code: "AMB",
    display: "ambulatory",
    system: "http://terminology.hl7.org/CodeSystem/v3-ActCode",
  },
  EMER: {
    code: "EMER",
    display: "emergency",
    system: "http://terminology.hl7.org/CodeSystem/v3-ActCode",
  },
  IMP: {
    code: "IMP",
    display: "inpatient encounter",
    system: "http://terminology.hl7.org/CodeSystem/v3-ActCode",
  },
  PRENC: {
    code: "PRENC",
    display: "pre-admission",
    system: "http://terminology.hl7.org/CodeSystem/v3-ActCode",
  },
  VR: {
    code: "VR",
    display: "virtual",
    system: "http://terminology.hl7.org/CodeSystem/v3-ActCode",
  },
};

export function makeEncounter(input: MakeEncounterInput): Encounter {
  const classInfo = ENCOUNTER_CLASSES[input.classCode] || ENCOUNTER_CLASSES.AMB;

  return {
    resourceType: "Encounter",
    id: input.id,
    meta: {
      profile: [
        "http://hl7.org/fhir/us/core/StructureDefinition/us-core-encounter",
      ],
    },
    status: input.status,
    class: {
      system: classInfo.system,
      code: classInfo.code,
      display: classInfo.display,
    },
    type: input.typeCode
      ? [
          {
            coding: [
              {
                system: "http://snomed.info/sct",
                code: input.typeCode,
                display: input.typeDisplay,
              },
            ],
            text: input.typeDisplay,
          },
        ]
      : undefined,
    subject: {
      reference: `Patient/${input.patientId}`,
      display: input.patientDisplay,
    },
    participant: input.practitionerRef
      ? [
          {
            individual: {
              reference: input.practitionerRef,
              display: input.practitionerDisplay,
            },
          },
        ]
      : undefined,
    period: {
      start: input.periodStart || new Date().toISOString(),
      end: input.periodEnd,
    },
    reasonCode: input.reasonCode
      ? [
          {
            coding: [
              {
                system: "http://snomed.info/sct",
                code: input.reasonCode,
                display: input.reasonDisplay,
              },
            ],
          },
        ]
      : undefined,
    serviceProvider: input.serviceProviderRef
      ? {
          reference: input.serviceProviderRef,
          display: input.serviceProviderDisplay,
        }
      : undefined,
  };
}
