import { describe, it, expect, beforeAll } from "bun:test";
import {
  registerWithBroker,
  registerWithEhr,
  linkPatientIds,
  authenticateWithBroker,
  createSubscription,
  onboardPatient,
} from "../portal/broker-client";
import { clearAllStores } from "../store";
import type { PatientDemographics } from "../shared/auth";

const TEST_PATIENT: PatientDemographics = {
  name: "Alice M Rodriguez",
  birthDate: "1987-04-12",
};

// Check if broker is running
async function isBrokerRunning(): Promise<boolean> {
  try {
    const resp = await fetch("http://localhost:3000/broker/admin/state");
    return resp.ok;
  } catch {
    return false;
  }
}

let brokerAvailable = false;

beforeAll(async () => {
  brokerAvailable = await isBrokerRunning();
  if (!brokerAvailable) {
    console.log(
      "\u26A0 Broker not running on port 3000 \u2014 skipping broker integration tests",
    );
  }
  clearAllStores();
});

// Helper to conditionally skip tests
function brokerTest(name: string, fn: () => Promise<void>) {
  it(name, async () => {
    if (!brokerAvailable) return; // silently skip
    await fn();
  });
}

describe("broker integration", () => {
  let brokerId: string;
  let sourceId: string;
  let accessToken: string;

  brokerTest(
    "registerPatient: registers patient with Broker and gets brokerId",
    async () => {
      brokerId = await registerWithBroker(TEST_PATIENT);
      expect(brokerId).toBeDefined();
      expect(typeof brokerId).toBe("string");
      expect(brokerId.length).toBeGreaterThan(0);
    },
  );

  brokerTest(
    "registerPatient: registers patient with EHR and gets sourceId",
    async () => {
      sourceId = await registerWithEhr(TEST_PATIENT);
      expect(sourceId).toBeDefined();
      expect(typeof sourceId).toBe("string");
      expect(sourceId.length).toBeGreaterThan(0);
    },
  );

  brokerTest(
    "linkPatient: links sourceId to brokerId at Broker",
    async () => {
      const linked = await linkPatientIds(TEST_PATIENT, sourceId);
      expect(linked).toBe(brokerId);
    },
  );

  brokerTest(
    "authenticate: exchanges client assertion for access token with patient context",
    async () => {
      const auth = await authenticateWithBroker(TEST_PATIENT);
      expect(auth.accessToken).toBeDefined();
      expect(auth.brokerId).toBeDefined();
      accessToken = auth.accessToken;
    },
  );

  brokerTest(
    "subscribe: creates Subscription with patient criteria and webhook endpoint",
    async () => {
      const subId = await createSubscription(accessToken, brokerId);
      expect(subId).toBeDefined();
      expect(typeof subId).toBe("string");
    },
  );

  brokerTest(
    "onboardPatient: full flow (register -> auth -> subscribe) succeeds end-to-end",
    async () => {
      clearAllStores();
      const result = await onboardPatient("patient-001", TEST_PATIENT);
      expect(result.brokerId).toBeDefined();
      expect(result.sourceId).toBeDefined();
      expect(result.accessToken).toBeDefined();
      expect(result.subscriptionId).toBeDefined();
    },
  );

  brokerTest(
    "subscription uses real webhook URL (not ias-client://)",
    async () => {
      clearAllStores();
      // Onboard to create subscription
      const result = await onboardPatient("patient-001", TEST_PATIENT);

      // Verify the subscription at the broker has our webhook endpoint
      const resp = await fetch(
        `http://localhost:3000/broker/fhir/Subscription/${result.subscriptionId}`,
      );
      expect(resp.ok).toBe(true);
      const sub = (await resp.json()) as any;
      expect(sub.channel?.endpoint).toContain("http://localhost:");
      expect(sub.channel?.endpoint).toContain("/notifications");
      expect(sub.channel?.endpoint).not.toContain("ias-client://");
    },
  );
});
