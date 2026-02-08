import type {
  ServiceRequest,
  Task,
  Patient,
  Practitioner,
  Organization,
  PractitionerRole,
  Encounter,
  SharingPreference,
  RoutedEvent,
  NotificationRecord,
} from "./fhir/types";

// FHIR resource stores
export const patients = new Map<string, Patient>();
export const practitioners = new Map<string, Practitioner>();
export const organizations = new Map<string, Organization>();
export const practitionerRoles = new Map<string, PractitionerRole>();
export const serviceRequests = new Map<string, ServiceRequest>();
export const tasks = new Map<string, Task>();
export const encounters = new Map<string, Encounter>();

// Consent / sharing preferences: key = `${patientId}:${physicianRef}`
export const sharingPreferences = new Map<string, SharingPreference>();

// Routed events (encounters sent to physician EHR)
export const routedEvents: RoutedEvent[] = [];

// Notification log
export const notifications: NotificationRecord[] = [];

// Broker session state
export interface BrokerSession {
  brokerId: string | null;
  sourceId: string | null;
  accessToken: string | null;
  subscriptionId: string | null;
  patientId: string;
}
export const brokerSessions = new Map<string, BrokerSession>();

// Onboarding wizard state
export interface OnboardingState {
  patientId: string;
  step: 1 | 2 | 3 | 4 | 5 | "complete";
  identityVerified: boolean;
  brokerId: string | null;
  sourceId: string | null;
  accessToken: string | null;
  subscriptionId: string | null;
  sharingEnabled: boolean;
  completedAt: string | null;
}
export const onboardingStates = new Map<string, OnboardingState>();

// SSE clients
export interface SSEClient {
  id: string;
  controller: ReadableStreamDefaultController;
  channel: "patient" | "physician";
  patientId?: string;
}
export const sseClients: SSEClient[] = [];

// Helper: resolve EHR patient ID to our internal patient ID via brokerSessions.
// This is the standard HIE patient cross-referencing (MPI) pattern:
// Josh's EHR assigns its own IDs (e.g., "mercy-a1b2c3d"). When an encounter
// arrives from the broker, we look up which of our patients has that sourceId
// and return our canonical patientId.
export function resolvePatientId(ehrPatientId: string): string {
  for (const [patientId, session] of brokerSessions) {
    if (session.sourceId === ehrPatientId) {
      return patientId;
    }
  }
  return ehrPatientId; // no mapping found — use as-is (e.g., local encounters)
}

// Helper: get all open referrals (ServiceRequests with active Tasks) for a patient
export function getOpenReferrals(patientId: string): { serviceRequest: ServiceRequest; task: Task }[] {
  const results: { serviceRequest: ServiceRequest; task: Task }[] = [];
  for (const [, task] of tasks) {
    if (
      task.for?.reference === `Patient/${patientId}` &&
      task.status !== "completed" &&
      task.status !== "cancelled" &&
      task.status !== "failed"
    ) {
      const sr = serviceRequests.get(task.focus?.reference?.replace("ServiceRequest/", "") || "");
      if (sr) {
        results.push({ serviceRequest: sr, task });
      }
    }
  }
  return results;
}

// Helper: get sharing preference for a patient-physician pair
export function getSharingPreference(patientId: string, physicianRef: string): SharingPreference | undefined {
  return sharingPreferences.get(`${patientId}:${physicianRef}`);
}

// Helper: set sharing preference
export function setSharingPreference(pref: SharingPreference): void {
  sharingPreferences.set(`${pref.patientId}:${pref.physicianRef}`, pref);
}

// Helper: clear all stores (for testing)
export function clearAllStores(): void {
  patients.clear();
  practitioners.clear();
  organizations.clear();
  practitionerRoles.clear();
  serviceRequests.clear();
  tasks.clear();
  encounters.clear();
  sharingPreferences.clear();
  routedEvents.length = 0;
  notifications.length = 0;
  brokerSessions.clear();
  onboardingStates.clear();
  sseClients.length = 0;
}
