// ---------------------------------------------------------------------------
// Core FHIR types
// ---------------------------------------------------------------------------

export interface Reference {
  reference: string;
  display?: string;
  identifier?: { system: string; value: string };
}

export interface Coding {
  system?: string;
  code: string;
  display?: string;
}

export interface CodeableConcept {
  coding?: Coding[];
  text?: string;
}

export interface Period {
  start?: string;
  end?: string;
}

export interface HumanName {
  family: string;
  given: string[];
  prefix?: string[];
  suffix?: string[];
  text?: string;
}

export interface Identifier {
  system: string;
  value: string;
}

export interface Extension {
  url: string;
  valueCode?: string;
  valueString?: string;
  valueCoding?: Coding;
  extension?: Extension[];
}

export interface Annotation {
  text: string;
  time?: string;
  authorReference?: Reference;
}

// ---------------------------------------------------------------------------
// FHIR Resources
// ---------------------------------------------------------------------------

export interface Patient {
  resourceType: "Patient";
  id: string;
  meta?: { profile?: string[] };
  identifier?: Identifier[];
  name: HumanName[];
  birthDate: string;
  gender?: string;
  telecom?: { system: string; value: string; use?: string }[];
  address?: {
    line?: string[];
    city?: string;
    state?: string;
    postalCode?: string;
  }[];
}

export interface Practitioner {
  resourceType: "Practitioner";
  id: string;
  identifier?: Identifier[];
  name: HumanName[];
  qualification?: { code: CodeableConcept }[];
}

export interface Organization {
  resourceType: "Organization";
  id: string;
  identifier?: Identifier[];
  name: string;
  alias?: string[];
  type?: CodeableConcept[];
  telecom?: { system: string; value: string }[];
  address?: {
    line?: string[];
    city?: string;
    state?: string;
    postalCode?: string;
  }[];
}

export interface PractitionerRole {
  resourceType: "PractitionerRole";
  id: string;
  practitioner: Reference;
  organization: Reference;
  specialty?: CodeableConcept[];
  code?: CodeableConcept[];
}

export interface ServiceRequest {
  resourceType: "ServiceRequest";
  id: string;
  status:
    | "draft"
    | "active"
    | "completed"
    | "revoked"
    | "entered-in-error";
  intent:
    | "proposal"
    | "plan"
    | "order"
    | "original-order"
    | "reflex-order"
    | "filler-order"
    | "instance-order";
  category?: CodeableConcept[];
  code?: CodeableConcept;
  subject: Reference;
  requester?: Reference;
  performer?: Reference[];
  reasonCode?: CodeableConcept[];
  authoredOn?: string;
  occurrencePeriod?: Period;
  note?: Annotation[];
  extension?: Extension[];
}

export interface Task {
  resourceType: "Task";
  id: string;
  status:
    | "requested"
    | "received"
    | "accepted"
    | "in-progress"
    | "completed"
    | "failed"
    | "cancelled";
  intent: "order" | "proposal" | "plan";
  code?: CodeableConcept;
  focus?: Reference;
  for?: Reference;
  requester?: Reference;
  owner?: Reference;
  authoredOn?: string;
  lastModified?: string;
  restriction?: { period?: Period };
  businessStatus?: CodeableConcept;
  output?: { type: CodeableConcept; valueReference?: Reference }[];
}

export interface Encounter {
  resourceType: "Encounter";
  id: string;
  meta?: { profile?: string[] };
  status:
    | "planned"
    | "arrived"
    | "triaged"
    | "in-progress"
    | "onleave"
    | "finished"
    | "cancelled";
  class: Coding;
  type?: CodeableConcept[];
  subject: Reference;
  participant?: { individual?: Reference }[];
  period?: Period;
  reasonCode?: CodeableConcept[];
  serviceProvider?: Reference;
}

// ---------------------------------------------------------------------------
// Application types
// ---------------------------------------------------------------------------

export interface SharingPreference {
  patientId: string;
  physicianRef: string;
  mode: "referrals-only" | "all-encounters";
  grantedAt: string;
  active: boolean;
}

export interface RoutedEvent {
  id: string;
  encounterId: string;
  patientId: string;
  physicianRef: string;
  taskId?: string;
  matchScore?: number;
  routedAt: string;
  encounter: Encounter;
}

export interface NotificationRecord {
  id: string;
  receivedAt: string;
  bundle: unknown;
  encounterId?: string;
  processed: boolean;
}
