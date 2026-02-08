// FHIR Resource builders — no external deps

// Encounter class definitions (v3-ActEncounterCode)
export const ENCOUNTER_CLASSES: Record<string, { code: string; display: string }> = {
  EMER:  { code: "EMER",  display: "emergency" },
  AMB:   { code: "AMB",   display: "ambulatory" },
  IMP:   { code: "IMP",   display: "inpatient encounter" },
  OBSENC:{ code: "OBSENC",display: "observation encounter" },
  PRENC: { code: "PRENC", display: "pre-admission" },
  SS:    { code: "SS",    display: "short stay" },
  VR:    { code: "VR",    display: "virtual" },
};

// Encounter type/reason definitions (SNOMED CT)
export const ENCOUNTER_TYPES: Record<string, { code: string; display: string; text: string }> = {
  "50849002":  { code: "50849002",  display: "Emergency department patient visit", text: "ED visit" },
  "185349003": { code: "185349003", display: "Encounter for check up",            text: "Check-up" },
  "308335008": { code: "308335008", display: "Patient encounter procedure",       text: "Procedure" },
  "390906007": { code: "390906007", display: "Follow-up encounter",               text: "Follow-up" },
  "281036007": { code: "281036007", display: "Follow-up consultation",             text: "Consultation" },
  "183452005": { code: "183452005", display: "Emergency hospital admission",       text: "Emergency admission" },
  "32485007":  { code: "32485007",  display: "Hospital admission",                 text: "Hospital admission" },
};

export const REASON_CODES: Record<string, { code: string; display: string }> = {
  "3723001":   { code: "3723001",   display: "Arthritis" },
  "386661006": { code: "386661006", display: "Fever" },
  "25064002":  { code: "25064002",  display: "Headache" },
  "267036007": { code: "267036007", display: "Dyspnea" },
  "29857009":  { code: "29857009",  display: "Chest pain" },
  "422587007": { code: "422587007", display: "Nausea" },
  "161891005": { code: "161891005", display: "Back pain" },
  "422400008": { code: "422400008", display: "Vomiting" },
};

export interface EncounterOptions {
  classCode?: string;      // key into ENCOUNTER_CLASSES
  typeCode?: string;       // key into ENCOUNTER_TYPES
  reasonCode?: string;     // key into REASON_CODES
  status?: string;         // "in-progress" | "planned" | "arrived" | "finished"
  scheduledDate?: string;  // ISO date for planned encounters
  practitionerNpi?: string;
  practitionerDisplay?: string;
}

export function makeEncounter(id: string, patientRef: string, patientName?: string, opts?: EncounterOptions): object {
  const classInfo = ENCOUNTER_CLASSES[opts?.classCode || "EMER"] || ENCOUNTER_CLASSES.EMER;
  const typeInfo = ENCOUNTER_TYPES[opts?.typeCode || "50849002"] || ENCOUNTER_TYPES["50849002"];
  const status = opts?.status || "in-progress";
  const periodStart = opts?.scheduledDate ? new Date(opts.scheduledDate).toISOString() : new Date().toISOString();

  const encounter: any = {
    resourceType: "Encounter",
    id,
    meta: {
      profile: [
        "http://hl7.org/fhir/us/core/StructureDefinition/us-core-encounter",
      ],
    },
    status,
    class: {
      system: "http://terminology.hl7.org/CodeSystem/v3-ActCode",
      code: classInfo.code,
      display: classInfo.display,
    },
    type: [
      {
        coding: [
          {
            system: "http://snomed.info/sct",
            code: typeInfo.code,
            display: typeInfo.display,
          },
        ],
        text: patientName ? `${typeInfo.text} for ${patientName}` : typeInfo.display,
      },
    ],
    subject: { reference: `Patient/${patientRef}` },
    period: { start: periodStart },
    serviceProvider: {
      reference: "Organization/mercy-hospital",
      display: "Mercy General Hospital",
    },
  };

  if (opts?.reasonCode && REASON_CODES[opts.reasonCode]) {
    const reason = REASON_CODES[opts.reasonCode];
    encounter.reasonCode = [{
      coding: [{ system: "http://snomed.info/sct", code: reason.code, display: reason.display }],
      text: reason.display,
    }];
  }

  if (opts?.practitionerNpi || opts?.practitionerDisplay) {
    encounter.participant = [{
      individual: {
        reference: `Practitioner/${opts.practitionerNpi || "unknown"}`,
        display: opts.practitionerDisplay || "Unknown Provider",
        ...(opts.practitionerNpi && {
          identifier: {
            system: "http://hl7.org/fhir/sid/us-npi",
            value: opts.practitionerNpi,
          },
        }),
      },
    }];
  }

  return encounter;
}

export function makeSubscription(
  id: string,
  opts: {
    criteria: string;
    channelEndpoint: string;
    patient: string;
  }
): object {
  return {
    resourceType: "Subscription",
    id,
    status: "active",
    reason: "Monitor admission events",
    criteria: "Encounter?patient=Patient/" + opts.patient,
    channel: {
      type: "rest-hook",
      endpoint: opts.channelEndpoint,
      payload: "application/fhir+json",
      _payload: {
        extension: [
          {
            url: "http://hl7.org/fhir/uv/subscriptions-backport/StructureDefinition/backport-payload-content",
            valueCode: "id-only",
          },
        ],
      },
    },
    extension: [
      {
        url: "http://hl7.org/fhir/uv/subscriptions-backport/StructureDefinition/backport-topic-canonical",
        valueUri:
          "http://example.org/fhir/SubscriptionTopic/encounter-start",
      },
    ],
  };
}

export function makeNotificationBundle(
  subscriptionId: string,
  encounterRef: string
): object {
  return {
    resourceType: "Bundle",
    type: "subscription-notification",
    timestamp: new Date().toISOString(),
    entry: [
      {
        fullUrl: `urn:uuid:status-${Date.now()}`,
        resource: {
          resourceType: "SubscriptionStatus",
          status: "active",
          type: "event-notification",
          eventsSinceSubscriptionStart: "1",
          subscription: { reference: `Subscription/${subscriptionId}` },
          notificationEvent: [
            {
              eventNumber: "1",
              focus: { reference: encounterRef },
            },
          ],
        },
      },
    ],
  };
}

export function makePatient(id: string, name: string, birthDate?: string): object {
  const parts = name.split(" ");
  const family = parts.pop()!;
  const given = parts;
  return {
    resourceType: "Patient",
    id,
    name: [{ given, family }],
    ...(birthDate ? { birthDate } : {}),
  };
}
