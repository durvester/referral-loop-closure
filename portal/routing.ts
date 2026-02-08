// ---------------------------------------------------------------------------
// Consent + Routing Logic + Task Lifecycle
//
// Given a new encounter:
// 1. Store the encounter in the patient's portal view
// 2. Run the matching engine against open referrals
// 3. Update the Task status based on encounter status (if matched)
// 4. Check the patient's sharing preference
// 5. Route to the physician EHR if appropriate
//
// Routing rules:
// - "referrals-only" + match found  -> route to physician EHR
// - "referrals-only" + no match     -> portal only
// - "all-encounters"                -> always route to physician EHR
// - No sharing preference / inactive -> portal only
//
// Task lifecycle transitions (independent of routing/consent):
// - requested/awaiting-scheduling  -> (planned encounter matched) -> in-progress/appointment-scheduled
// - in-progress/appointment-scheduled -> (in-progress|arrived|triaged encounter) -> in-progress/encounter-in-progress
// - in-progress/*                  -> (finished encounter matched) -> completed/loop-closed
// - Any non-completed              -> (past restriction.period.end) -> failed/overdue
// - completed tasks are NOT affected by subsequent encounters
// ---------------------------------------------------------------------------

import type { Encounter, RoutedEvent } from "../fhir/types";
import type { MatchResult, MatchContext } from "../matching/engine";
import { matchEncounterToReferrals } from "../matching/engine";
import {
  encounters,
  tasks,
  serviceRequests,
  organizations,
  practitioners,
  practitionerRoles,
  routedEvents,
  getOpenReferrals,
  getSharingPreference,
  resolvePatientId,
} from "../store";
import { broadcast } from "../shared/sse";

// Minimum match score to auto-link (for demo, use 0.40 instead of 0.70)
const AUTO_LINK_THRESHOLD = 0.70;

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface ProcessEncounterResult {
  encounterId: string;
  patientId: string;
  matchResults: MatchResult[];
  bestMatch: MatchResult | null;
  routed: boolean;
  routedTo?: string;   // physician reference
  taskUpdated?: string; // task ID that was updated
  reason: string;
}

// ---------------------------------------------------------------------------
// Build match context from the in-memory store
// ---------------------------------------------------------------------------

export function buildMatchContext(): MatchContext {
  return {
    orgNpiLookup: (ref: string) => {
      const id = ref.replace("Organization/", "");
      const org = organizations.get(id);
      return org?.identifier?.find(
        (i) => i.system === "http://hl7.org/fhir/sid/us-npi",
      )?.value;
    },
    practitionerNpiLookup: (ref: string) => {
      const id = ref.replace("Practitioner/", "");
      const pract = practitioners.get(id);
      return pract?.identifier?.find(
        (i) => i.system === "http://hl7.org/fhir/sid/us-npi",
      )?.value;
    },
    specialtyLookup: (ref: string) => {
      // Look up practitioner's specialty via PractitionerRole
      for (const [, role] of practitionerRoles) {
        if (role.practitioner.reference === ref) {
          return role.specialty?.[0]?.coding?.[0]?.code;
        }
      }
      return undefined;
    },
  };
}

// ---------------------------------------------------------------------------
// Task state machine: update Task based on encounter status
// ---------------------------------------------------------------------------

export function updateTaskForEncounter(
  taskId: string,
  encounter: Encounter,
  _matchResult: MatchResult,
): void {
  const task = tasks.get(taskId);
  if (!task || task.status === "completed" || task.status === "failed") return;

  task.lastModified = new Date().toISOString();

  if (encounter.status === "planned") {
    task.status = "in-progress";
    task.businessStatus = {
      coding: [
        {
          system:
            "http://example.org/fhir/CodeSystem/referral-tracking-status",
          code: "appointment-scheduled",
          display: "Appointment Scheduled",
        },
      ],
    };
  } else if (
    encounter.status === "in-progress" ||
    encounter.status === "arrived" ||
    encounter.status === "triaged"
  ) {
    task.status = "in-progress";
    task.businessStatus = {
      coding: [
        {
          system:
            "http://example.org/fhir/CodeSystem/referral-tracking-status",
          code: "encounter-in-progress",
          display: "Encounter In Progress",
        },
      ],
    };
  } else if (encounter.status === "finished") {
    task.status = "completed";
    task.businessStatus = {
      coding: [
        {
          system:
            "http://example.org/fhir/CodeSystem/referral-tracking-status",
          code: "loop-closed",
          display: "Loop Closed",
        },
      ],
    };
    // Add encounter to task output
    task.output = task.output || [];
    task.output.push({
      type: { text: "Matched Encounter" },
      valueReference: {
        reference: `Encounter/${encounter.id}`,
        display: `${encounter.class?.code} encounter`,
      },
    });
  }
}

// ---------------------------------------------------------------------------
// Overdue check: mark tasks past their restriction.period.end as failed
// ---------------------------------------------------------------------------

export function checkOverdueTasks(): string[] {
  const now = new Date().toISOString();
  const overdueTaskIds: string[] = [];

  for (const [id, task] of tasks) {
    if (
      task.status === "completed" ||
      task.status === "failed" ||
      task.status === "cancelled"
    ) {
      continue;
    }
    const dueDate = task.restriction?.period?.end;
    if (dueDate && now > dueDate) {
      task.status = "failed";
      task.businessStatus = {
        coding: [
          {
            system:
              "http://example.org/fhir/CodeSystem/referral-tracking-status",
            code: "overdue",
            display: "Overdue",
          },
        ],
      };
      task.lastModified = now;
      overdueTaskIds.push(id);
    }
  }

  return overdueTaskIds;
}

// ---------------------------------------------------------------------------
// Main function: process a new encounter through the pipeline
// ---------------------------------------------------------------------------

export function processEncounter(encounter: Encounter): ProcessEncounterResult {
  const rawPatientId =
    encounter.subject?.reference?.replace("Patient/", "") || "";

  // Cross-reference EHR patient ID to our canonical patient ID (MPI pattern).
  // The upstream EHR assigns its own IDs (e.g., "mercy-a1b2c3d"); we resolve them
  // to our internal IDs (e.g., "patient-001") via the brokerSessions mapping.
  const patientId = resolvePatientId(rawPatientId);

  // Normalize the encounter's subject reference to our canonical patient ID
  // so downstream queries (portal, physician dashboard) find it correctly.
  if (patientId !== rawPatientId) {
    encounter = {
      ...encounter,
      subject: { reference: `Patient/${patientId}` },
    };
  }

  // 1. Store encounter (patient portal always sees it) — detect updates
  const isUpdate = encounters.has(encounter.id);
  encounters.set(encounter.id, encounter);

  // 2. Broadcast to patient portal
  broadcast(
    "patient",
    {
      type: isUpdate ? "encounter-updated" : "encounter-stored",
      encounterId: encounter.id,
      encounter,
    },
    patientId,
  );

  // 3. Run matching engine against open referrals
  const openReferrals = getOpenReferrals(patientId);
  const context = buildMatchContext();
  const matchResults = matchEncounterToReferrals(
    encounter,
    openReferrals,
    context,
  );
  const bestMatch =
    matchResults.length > 0 && matchResults[0].score >= AUTO_LINK_THRESHOLD
      ? matchResults[0]
      : null;

  // 4. If matched, update task (independent of consent/routing)
  let taskUpdated: string | undefined;
  if (bestMatch) {
    updateTaskForEncounter(bestMatch.taskId, encounter, bestMatch);
    taskUpdated = bestMatch.taskId;
  }

  // 5. Find who referred this patient (for sharing preference lookup)
  //    Use the first open referral's requester
  let physicianRef: string | undefined;
  if (openReferrals.length > 0) {
    const sr = openReferrals[0].serviceRequest;
    physicianRef = sr.requester?.reference;
  }

  // 6. Check sharing preference to decide routing
  const pref = physicianRef
    ? getSharingPreference(patientId, physicianRef)
    : undefined;
  let routed = false;
  let reason = "";

  if (!pref || !pref.active) {
    reason = "No active sharing preference";
  } else if (pref.mode === "all-encounters") {
    routed = true;
    reason = "Patient selected 'share all encounters'";
  } else if (pref.mode === "referrals-only") {
    if (bestMatch) {
      routed = true;
      reason = `Matched referral ${bestMatch.serviceRequestId} (score: ${bestMatch.score.toFixed(2)})`;
    } else {
      reason = "No referral match found (referrals-only mode)";
    }
  }

  // 7. If routed, record event and broadcast to physician
  if (routed && physicianRef) {
    const event: RoutedEvent = {
      id: `route-${Date.now()}`,
      encounterId: encounter.id,
      patientId,
      physicianRef,
      taskId: bestMatch?.taskId,
      matchScore: bestMatch?.score,
      routedAt: new Date().toISOString(),
      encounter,
    };

    // Upsert: update existing routed event for this encounter, or add new one
    const existingIdx = routedEvents.findIndex(e => e.encounterId === encounter.id);
    if (existingIdx >= 0) {
      routedEvents[existingIdx] = event;
    } else {
      routedEvents.push(event);
    }

    broadcast("physician", {
      type: isUpdate ? "encounter-updated" : "encounter-routed",
      encounterId: encounter.id,
      encounter,
      matchResult: bestMatch,
      taskId: taskUpdated,
    });
  }

  return {
    encounterId: encounter.id,
    patientId,
    matchResults,
    bestMatch,
    routed,
    routedTo: routed ? physicianRef : undefined,
    taskUpdated,
    reason,
  };
}
