// ---------------------------------------------------------------------------
// Matching engine: scores encounters against open referrals to determine
// if an encounter closes a referral loop.
// ---------------------------------------------------------------------------

import type { ServiceRequest, Task, Encounter, Extension } from "../fhir/types";
import { fuzzyNameMatch } from "./fuzzy";

// ---------------------------------------------------------------------------
// Scoring weights
// ---------------------------------------------------------------------------
const WEIGHTS = {
  orgNpi: 0.35,
  orgName: 0.20,
  practitionerNpi: 0.25,
  specialty: 0.10,
  dateInWindow: 0.10,
} as const;

// Minimum score to include in results
const MIN_SCORE_THRESHOLD = 0.10;

// Confidence thresholds
const HIGH_CONFIDENCE = 0.70;
const MEDIUM_CONFIDENCE = 0.40;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface MatchResult {
  serviceRequestId: string;
  taskId: string;
  score: number;
  confidence: "high" | "medium" | "low";
  signals: {
    orgNpi: boolean;
    orgName: number; // fuzzy score 0-1
    practitionerNpi: boolean;
    specialty: boolean;
    dateInWindow: boolean;
  };
}

export interface OpenReferral {
  serviceRequest: ServiceRequest;
  task: Task;
}

/** Lookup function: given an organization FHIR reference (e.g. "Organization/org-123"), return its NPI or undefined */
export type OrgNpiLookup = (orgRef: string) => string | undefined;

/** Lookup function: given a practitioner FHIR reference, return its NPI or undefined */
export type PractitionerNpiLookup = (practRef: string) => string | undefined;

/** Lookup function: given a practitioner FHIR reference, return their primary specialty taxonomy code or undefined */
export type SpecialtyLookup = (practRef: string) => string | undefined;

export interface MatchContext {
  orgNpiLookup?: OrgNpiLookup;
  practitionerNpiLookup?: PractitionerNpiLookup;
  specialtyLookup?: SpecialtyLookup;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Extract the target identifiers from a ServiceRequest's
 * referral-target-identifiers extension.
 */
function getTargetIdentifiers(sr: ServiceRequest): {
  orgNpi?: string;
  orgName?: string;
  practitionerNpi?: string;
  specialtyCode?: string;
} {
  const targetExt = sr.extension?.find(
    (e) =>
      e.url ===
      "http://example.org/fhir/StructureDefinition/referral-target-identifiers",
  );
  if (!targetExt?.extension) return {};

  return {
    orgNpi: targetExt.extension.find((e) => e.url === "organizationNpi")
      ?.valueString,
    orgName: targetExt.extension.find((e) => e.url === "organizationName")
      ?.valueString,
    practitionerNpi: targetExt.extension.find(
      (e) => e.url === "practitionerNpi",
    )?.valueString,
    specialtyCode: targetExt.extension.find((e) => e.url === "specialty")
      ?.valueCoding?.code,
  };
}

// ---------------------------------------------------------------------------
// Main matching function
// ---------------------------------------------------------------------------

/**
 * Score an encounter against a list of open referrals.
 *
 * Scoring signals and weights:
 * - Organization NPI exact match:  0.35
 * - Organization name fuzzy match: 0.20 * similarity
 * - Practitioner NPI exact match:  0.25
 * - Specialty taxonomy code match: 0.10
 * - Date within referral window:   0.10
 *
 * Resolution thresholds:
 * - >= 0.70: high confidence (auto-link)
 * - 0.40-0.69: medium confidence (possible match)
 * - < 0.40: low confidence
 *
 * Results below MIN_SCORE_THRESHOLD (0.10) are excluded entirely.
 * Results are returned sorted by score descending (best match first).
 */
export function matchEncounterToReferrals(
  encounter: Encounter,
  openReferrals: OpenReferral[],
  context: MatchContext = {},
): MatchResult[] {
  // If the encounter has no serviceProvider, we cannot match it
  if (!encounter.serviceProvider) return [];

  const results: MatchResult[] = [];

  // Extract encounter information
  const encOrgRef = encounter.serviceProvider.reference;
  const encOrgName = encounter.serviceProvider.display || "";
  const encOrgNpi = encOrgRef ? context.orgNpiLookup?.(encOrgRef) : undefined;

  // Get encounter practitioner info from first participant
  const encPractRef = encounter.participant?.[0]?.individual?.reference;
  // Check embedded NPI identifier on participant (from upstream EHR encounters)
  const participantId = encounter.participant?.[0]?.individual?.identifier;
  const embeddedNpi = participantId?.system === "http://hl7.org/fhir/sid/us-npi"
    ? participantId.value : undefined;
  // Use store lookup first, fallback to embedded NPI
  const encPractNpi = (encPractRef ? context.practitionerNpiLookup?.(encPractRef) : undefined) || embeddedNpi;

  // Get encounter specialty from practitioner lookup
  const encSpecialty = encPractRef
    ? context.specialtyLookup?.(encPractRef)
    : undefined;

  // Get encounter date (use period.start)
  const encDate = encounter.period?.start;

  for (const referral of openReferrals) {
    const targets = getTargetIdentifiers(referral.serviceRequest);

    // Skip referrals with no target identifiers at all
    if (!targets.orgNpi && !targets.orgName && !targets.practitionerNpi) {
      continue;
    }

    let score = 0;
    const signals = {
      orgNpi: false,
      orgName: 0,
      practitionerNpi: false,
      specialty: false,
      dateInWindow: false,
    };

    // --- Organization NPI (weight: 0.35) ---
    if (targets.orgNpi && encOrgNpi && targets.orgNpi === encOrgNpi) {
      score += WEIGHTS.orgNpi;
      signals.orgNpi = true;
    }

    // --- Organization Name fuzzy (weight: 0.20) ---
    if (targets.orgName && encOrgName) {
      const nameSim = fuzzyNameMatch(targets.orgName, encOrgName);
      score += WEIGHTS.orgName * nameSim;
      signals.orgName = nameSim;
    }

    // --- Practitioner NPI (weight: 0.25) ---
    if (
      targets.practitionerNpi &&
      encPractNpi &&
      targets.practitionerNpi === encPractNpi
    ) {
      score += WEIGHTS.practitionerNpi;
      signals.practitionerNpi = true;
    }

    // --- Specialty taxonomy code (weight: 0.10) ---
    if (
      targets.specialtyCode &&
      encSpecialty &&
      targets.specialtyCode === encSpecialty
    ) {
      score += WEIGHTS.specialty;
      signals.specialty = true;
    }

    // --- Date within referral window (weight: 0.10) ---
    if (encDate && referral.serviceRequest.occurrencePeriod) {
      const windowStart = referral.serviceRequest.occurrencePeriod.start;
      const windowEnd = referral.serviceRequest.occurrencePeriod.end;
      if (
        (!windowStart || encDate >= windowStart) &&
        (!windowEnd || encDate <= windowEnd)
      ) {
        score += WEIGHTS.dateInWindow;
        signals.dateInWindow = true;
      }
    }

    // Only include results above the minimum threshold
    if (score >= MIN_SCORE_THRESHOLD) {
      const confidence: "high" | "medium" | "low" =
        score >= HIGH_CONFIDENCE
          ? "high"
          : score >= MEDIUM_CONFIDENCE
            ? "medium"
            : "low";

      results.push({
        serviceRequestId: referral.serviceRequest.id,
        taskId: referral.task.id,
        score,
        confidence,
        signals,
      });
    }
  }

  // Sort by score descending (best match first)
  results.sort((a, b) => b.score - a.score);

  return results;
}
