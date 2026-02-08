import { describe, it, expect } from "bun:test";
import {
  levenshteinDistance,
  fuzzyNameMatch,
  normalizeName,
  tokenJaccard,
} from "../matching/fuzzy";
import {
  matchEncounterToReferrals,
  type MatchResult,
  type OpenReferral,
  type MatchContext,
} from "../matching/engine";
import type {
  ServiceRequest,
  Task,
  Encounter,
  Extension,
} from "../fhir/types";

// ---------------------------------------------------------------------------
// Test data helpers
// ---------------------------------------------------------------------------

function makeTestServiceRequest(overrides: {
  id?: string;
  targetOrgNpi?: string;
  targetOrgName?: string;
  targetPractitionerNpi?: string;
  targetSpecialtyCode?: string;
  targetSpecialtyDisplay?: string;
  occurrenceStart?: string;
  occurrenceEnd?: string;
}): ServiceRequest {
  const extensions: Extension[] = [];

  // Build referral-target-identifiers extension
  const subExts: Extension[] = [];
  if (overrides.targetOrgNpi) {
    subExts.push({ url: "organizationNpi", valueString: overrides.targetOrgNpi });
  }
  if (overrides.targetOrgName) {
    subExts.push({ url: "organizationName", valueString: overrides.targetOrgName });
  }
  if (overrides.targetPractitionerNpi) {
    subExts.push({ url: "practitionerNpi", valueString: overrides.targetPractitionerNpi });
  }
  if (overrides.targetSpecialtyCode) {
    subExts.push({
      url: "specialty",
      valueCoding: {
        system: "http://nucc.org/provider-taxonomy",
        code: overrides.targetSpecialtyCode,
        display: overrides.targetSpecialtyDisplay || overrides.targetSpecialtyCode,
      },
    });
  }

  if (subExts.length > 0) {
    extensions.push({
      url: "http://example.org/fhir/StructureDefinition/referral-target-identifiers",
      extension: subExts,
    });
  }

  return {
    resourceType: "ServiceRequest",
    id: overrides.id || "sr-test",
    status: "active",
    intent: "order",
    subject: { reference: "Patient/pat-1" },
    authoredOn: "2025-01-15",
    occurrencePeriod:
      overrides.occurrenceStart || overrides.occurrenceEnd
        ? {
            start: overrides.occurrenceStart,
            end: overrides.occurrenceEnd,
          }
        : undefined,
    extension: extensions.length > 0 ? extensions : undefined,
  };
}

function makeTestTask(overrides?: { id?: string; serviceRequestId?: string }): Task {
  return {
    resourceType: "Task",
    id: overrides?.id || "task-test",
    status: "requested",
    intent: "order",
    focus: {
      reference: `ServiceRequest/${overrides?.serviceRequestId || "sr-test"}`,
    },
    for: { reference: "Patient/pat-1" },
    authoredOn: "2025-01-15",
    output: [],
  };
}

function makeTestEncounter(overrides: {
  id?: string;
  serviceProviderRef?: string;
  serviceProviderDisplay?: string;
  participantRef?: string;
  periodStart?: string;
  periodEnd?: string;
  classCode?: string;
  noServiceProvider?: boolean;
}): Encounter {
  const enc: Encounter = {
    resourceType: "Encounter",
    id: overrides.id || "enc-test",
    status: "finished",
    class: {
      system: "http://terminology.hl7.org/CodeSystem/v3-ActCode",
      code: overrides.classCode || "AMB",
      display: "ambulatory",
    },
    subject: { reference: "Patient/pat-1" },
    period: {
      start: overrides.periodStart || "2025-02-10T09:00:00Z",
      end: overrides.periodEnd || "2025-02-10T10:00:00Z",
    },
  };

  if (!overrides.noServiceProvider) {
    enc.serviceProvider = {
      reference: overrides.serviceProviderRef || "Organization/org-valley",
      display: overrides.serviceProviderDisplay || "Valley Cardiology",
    };
  }

  if (overrides.participantRef) {
    enc.participant = [
      { individual: { reference: overrides.participantRef } },
    ];
  }

  return enc;
}

function makeOpenReferral(
  srOverrides: Parameters<typeof makeTestServiceRequest>[0],
  taskOverrides?: Parameters<typeof makeTestTask>[0],
): OpenReferral {
  const sr = makeTestServiceRequest(srOverrides);
  const task = makeTestTask({
    id: taskOverrides?.id || `task-${sr.id}`,
    serviceRequestId: sr.id,
    ...taskOverrides,
  });
  return { serviceRequest: sr, task };
}

// ---------------------------------------------------------------------------
// levenshteinDistance
// ---------------------------------------------------------------------------
describe("levenshteinDistance", () => {
  it("identical strings return 0", () => {
    expect(levenshteinDistance("hello", "hello")).toBe(0);
  });

  it("single character difference returns 1", () => {
    expect(levenshteinDistance("cat", "bat")).toBe(1);
  });

  it("\"kitten\" vs \"sitting\" returns 3", () => {
    expect(levenshteinDistance("kitten", "sitting")).toBe(3);
  });

  it("empty string vs \"abc\" returns 3", () => {
    expect(levenshteinDistance("", "abc")).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// fuzzyNameMatch
// ---------------------------------------------------------------------------
describe("fuzzyNameMatch", () => {
  it("exact match returns 1.0", () => {
    expect(fuzzyNameMatch("Valley Cardiology", "Valley Cardiology")).toBe(1.0);
  });

  it("\"Valley Cardiology\" vs \"Valley Cardiology Associates LLC\" returns >= 0.7", () => {
    const score = fuzzyNameMatch("Valley Cardiology", "Valley Cardiology Associates LLC");
    expect(score).toBeGreaterThanOrEqual(0.7);
  });

  it("\"Valley Cardiology\" vs \"Metro Orthopedic Group\" returns < 0.3", () => {
    const score = fuzzyNameMatch("Valley Cardiology", "Metro Orthopedic Group");
    expect(score).toBeLessThan(0.3);
  });

  it("case insensitive: \"valley cardiology\" vs \"Valley Cardiology\" returns 1.0", () => {
    expect(fuzzyNameMatch("valley cardiology", "Valley Cardiology")).toBe(1.0);
  });

  it("handles punctuation: \"St. Mary's Hospital\" vs \"St Marys Hospital\" returns >= 0.9", () => {
    const score = fuzzyNameMatch("St. Mary's Hospital", "St Marys Hospital");
    expect(score).toBeGreaterThanOrEqual(0.9);
  });

  it("strips common suffixes: \"Valley Cardiology Associates\" vs \"Valley Cardiology\" returns >= 0.8", () => {
    const score = fuzzyNameMatch("Valley Cardiology Associates", "Valley Cardiology");
    expect(score).toBeGreaterThanOrEqual(0.8);
  });
});

// ---------------------------------------------------------------------------
// matchEncounterToReferrals
// ---------------------------------------------------------------------------
describe("matchEncounterToReferrals", () => {
  it("exact org NPI match scores >= 0.35", () => {
    const referral = makeOpenReferral({
      id: "sr-1",
      targetOrgNpi: "1122334455",
      targetOrgName: "Valley Cardiology",
    });

    const encounter = makeTestEncounter({
      serviceProviderRef: "Organization/org-valley",
      serviceProviderDisplay: "Some Other Name",
    });

    const context: MatchContext = {
      orgNpiLookup: (ref: string) =>
        ref === "Organization/org-valley" ? "1122334455" : undefined,
    };

    const results = matchEncounterToReferrals(encounter, [referral], context);
    expect(results.length).toBeGreaterThanOrEqual(1);
    // Org NPI (0.35) + partial org name fuzzy score
    expect(results[0].score).toBeGreaterThanOrEqual(0.35);
    expect(results[0].signals.orgNpi).toBe(true);
  });

  it("exact org NPI + practitioner NPI scores >= 0.60", () => {
    const referral = makeOpenReferral({
      id: "sr-1",
      targetOrgNpi: "1122334455",
      targetOrgName: "Valley Cardiology",
      targetPractitionerNpi: "9876543210",
    });

    const encounter = makeTestEncounter({
      serviceProviderRef: "Organization/org-valley",
      serviceProviderDisplay: "Valley Cardiology",
      participantRef: "Practitioner/pract-smith",
    });

    const context: MatchContext = {
      orgNpiLookup: (ref: string) =>
        ref === "Organization/org-valley" ? "1122334455" : undefined,
      practitionerNpiLookup: (ref: string) =>
        ref === "Practitioner/pract-smith" ? "9876543210" : undefined,
    };

    const results = matchEncounterToReferrals(encounter, [referral], context);
    expect(results.length).toBeGreaterThanOrEqual(1);
    // Org NPI (0.35) + Practitioner NPI (0.25) + org name fuzzy (0.20 * ~1.0) = ~0.80
    expect(results[0].score).toBeGreaterThanOrEqual(0.60);
    expect(results[0].signals.orgNpi).toBe(true);
    expect(results[0].signals.practitionerNpi).toBe(true);
  });

  it("full match (NPI + name + specialty + date) scores >= 0.90", () => {
    const referral = makeOpenReferral({
      id: "sr-1",
      targetOrgNpi: "1122334455",
      targetOrgName: "Valley Cardiology",
      targetPractitionerNpi: "9876543210",
      targetSpecialtyCode: "207RC0000X",
      targetSpecialtyDisplay: "Cardiovascular Disease",
      occurrenceStart: "2025-01-15",
      occurrenceEnd: "2025-06-15",
    });

    const encounter = makeTestEncounter({
      serviceProviderRef: "Organization/org-valley",
      serviceProviderDisplay: "Valley Cardiology",
      participantRef: "Practitioner/pract-smith",
      periodStart: "2025-02-10T09:00:00Z",
    });

    const context: MatchContext = {
      orgNpiLookup: (ref: string) =>
        ref === "Organization/org-valley" ? "1122334455" : undefined,
      practitionerNpiLookup: (ref: string) =>
        ref === "Practitioner/pract-smith" ? "9876543210" : undefined,
      specialtyLookup: (ref: string) =>
        ref === "Practitioner/pract-smith" ? "207RC0000X" : undefined,
    };

    const results = matchEncounterToReferrals(encounter, [referral], context);
    expect(results.length).toBeGreaterThanOrEqual(1);
    // 0.35 + 0.20 + 0.25 + 0.10 + 0.10 = 1.0
    expect(results[0].score).toBeGreaterThanOrEqual(0.90);
    expect(results[0].confidence).toBe("high");
    expect(results[0].signals.orgNpi).toBe(true);
    expect(results[0].signals.practitionerNpi).toBe(true);
    expect(results[0].signals.specialty).toBe(true);
    expect(results[0].signals.dateInWindow).toBe(true);
  });

  it("org name only (fuzzy) scores 0.20 * similarity", () => {
    const referral = makeOpenReferral({
      id: "sr-1",
      targetOrgName: "Valley Cardiology",
    });

    const encounter = makeTestEncounter({
      serviceProviderRef: "Organization/org-valley",
      serviceProviderDisplay: "Valley Cardiology Associates LLC",
    });

    // No NPI lookups - only fuzzy name matching
    const results = matchEncounterToReferrals(encounter, [referral], {});
    expect(results.length).toBeGreaterThanOrEqual(1);

    // Score should be 0.20 * fuzzyNameMatch("Valley Cardiology", "Valley Cardiology Associates LLC")
    const expectedSimilarity = fuzzyNameMatch("Valley Cardiology", "Valley Cardiology Associates LLC");
    const expectedScore = 0.20 * expectedSimilarity;
    expect(results[0].score).toBeCloseTo(expectedScore, 2);
    expect(results[0].signals.orgNpi).toBe(false);
    expect(results[0].signals.orgName).toBeCloseTo(expectedSimilarity, 2);
  });

  it("no matching fields returns empty results (below threshold)", () => {
    const referral = makeOpenReferral({
      id: "sr-1",
      targetOrgNpi: "1122334455",
      targetOrgName: "Valley Cardiology",
    });

    const encounter = makeTestEncounter({
      serviceProviderRef: "Organization/org-unrelated",
      serviceProviderDisplay: "Metro Orthopedic Group",
    });

    // NPI lookup returns something different
    const context: MatchContext = {
      orgNpiLookup: (ref: string) =>
        ref === "Organization/org-unrelated" ? "9999999999" : undefined,
    };

    const results = matchEncounterToReferrals(encounter, [referral], context);
    // The fuzzy name match between "Valley Cardiology" and "Metro Orthopedic Group"
    // should be very low, and since only org name signal could contribute (at most 0.20 * low_score),
    // total score should be below the 0.10 threshold
    expect(results.length).toBe(0);
  });

  it("encounter outside referral date window loses date points", () => {
    const referral = makeOpenReferral({
      id: "sr-1",
      targetOrgNpi: "1122334455",
      targetOrgName: "Valley Cardiology",
      occurrenceStart: "2025-01-15",
      occurrenceEnd: "2025-02-15",
    });

    // Encounter after the referral window
    const encounter = makeTestEncounter({
      serviceProviderRef: "Organization/org-valley",
      serviceProviderDisplay: "Valley Cardiology",
      periodStart: "2025-06-01T09:00:00Z",
    });

    const context: MatchContext = {
      orgNpiLookup: (ref: string) =>
        ref === "Organization/org-valley" ? "1122334455" : undefined,
    };

    const results = matchEncounterToReferrals(encounter, [referral], context);
    expect(results.length).toBeGreaterThanOrEqual(1);
    // Should have org NPI (0.35) + org name (~0.20) but NOT date (0.10)
    expect(results[0].signals.dateInWindow).toBe(false);
    // Score should be less than it would be with date
    expect(results[0].score).toBeLessThan(0.35 + 0.20 + 0.10);
  });

  it("returns results sorted by score descending", () => {
    // Referral 1: strong match (NPI match)
    const referral1 = makeOpenReferral({
      id: "sr-strong",
      targetOrgNpi: "1122334455",
      targetOrgName: "Valley Cardiology",
    });

    // Referral 2: weak match (name only, fuzzy)
    const referral2 = makeOpenReferral({
      id: "sr-weak",
      targetOrgName: "Valley Cardiology Associates",
    });

    const encounter = makeTestEncounter({
      serviceProviderRef: "Organization/org-valley",
      serviceProviderDisplay: "Valley Cardiology",
    });

    const context: MatchContext = {
      orgNpiLookup: (ref: string) =>
        ref === "Organization/org-valley" ? "1122334455" : undefined,
    };

    const results = matchEncounterToReferrals(
      encounter,
      [referral2, referral1], // weak first
      context,
    );
    expect(results.length).toBe(2);
    expect(results[0].score).toBeGreaterThanOrEqual(results[1].score);
    expect(results[0].serviceRequestId).toBe("sr-strong");
  });

  it("multiple open referrals: returns best match first", () => {
    // Referral A: full match
    const referralA = makeOpenReferral({
      id: "sr-full",
      targetOrgNpi: "1122334455",
      targetOrgName: "Valley Cardiology",
      targetPractitionerNpi: "9876543210",
      targetSpecialtyCode: "207RC0000X",
      occurrenceStart: "2025-01-01",
      occurrenceEnd: "2025-12-31",
    });

    // Referral B: only org name match
    const referralB = makeOpenReferral({
      id: "sr-partial",
      targetOrgName: "Valley Cardiology Center",
    });

    // Referral C: different org entirely
    const referralC = makeOpenReferral({
      id: "sr-unrelated",
      targetOrgNpi: "5555555555",
      targetOrgName: "Metro Orthopedics",
    });

    const encounter = makeTestEncounter({
      serviceProviderRef: "Organization/org-valley",
      serviceProviderDisplay: "Valley Cardiology",
      participantRef: "Practitioner/pract-smith",
      periodStart: "2025-03-15T09:00:00Z",
    });

    const context: MatchContext = {
      orgNpiLookup: (ref: string) =>
        ref === "Organization/org-valley" ? "1122334455" : undefined,
      practitionerNpiLookup: (ref: string) =>
        ref === "Practitioner/pract-smith" ? "9876543210" : undefined,
      specialtyLookup: (ref: string) =>
        ref === "Practitioner/pract-smith" ? "207RC0000X" : undefined,
    };

    const results = matchEncounterToReferrals(
      encounter,
      [referralC, referralB, referralA],
      context,
    );

    // Best match should be first
    expect(results[0].serviceRequestId).toBe("sr-full");
    expect(results[0].score).toBeGreaterThan(results[1]?.score || 0);
  });

  it("encounter with no serviceProvider returns empty results", () => {
    const referral = makeOpenReferral({
      id: "sr-1",
      targetOrgNpi: "1122334455",
      targetOrgName: "Valley Cardiology",
    });

    const encounter = makeTestEncounter({
      noServiceProvider: true,
    });

    const results = matchEncounterToReferrals(encounter, [referral], {});
    expect(results).toEqual([]);
  });
});
