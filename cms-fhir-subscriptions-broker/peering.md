# Cross-Network Peering (Experimental)

**Status: Informative / Experimental**

This document sketches how Brokers in different CMS-Aligned Networks might exchange subscription intent and route notifications across network boundaries. The patterns described here are not normative; they are intended to inform experimentation and future standardization.

See also: [Main specification](index.md) | [FAQ](faq.md) | [End-to-end example](e2e-ias-example.md)

---

## 1. The Problem

A subscription created at Broker X contains:

```
Encounter?patient=Patient/broker-x-123&trigger=feed-event
```

This filter is **not portable** to other networks:
- `Patient/broker-x-123` is a Broker X-scoped identifier, meaningless to Broker Y
- Broker Y cannot match incoming events against this filter without additional context

Cross-network routing therefore requires Brokers to exchange **subscription intent** — patient identity plus event scope — rather than forwarding filter strings verbatim.

---

## 2. Approaches

### 2.1 Full Event Feed (Optionally Filtered)

Broker Y shares its event stream with Broker X, either as a complete feed or filtered based on Broker Y's understanding of which patients Broker X is tracking.

**How it works:**
- Broker Y sends events (e.g., HL7v2 ADT messages) to Broker X under a trust agreement
- Broker X performs matching against its subscriptions locally
- Optionally, Broker Y filters the feed based on patient lists exchanged out-of-band

**Tradeoffs:**
- Simple integration — mirrors existing ADT feed arrangements
- Higher bandwidth if unfiltered; Broker X bears matching cost
- Broker Y learns little or nothing about Broker X's specific subscriptions

**When appropriate:** Networks with existing ADT sharing arrangements, or high-trust relationships where full event exchange is acceptable.

### 2.2 Subscription Intent Exchange (`$brokered`)

Broker X exposes a FHIR operation that returns subscription intent — the information a peer needs to match events and route notifications. The response uses the [FHIR Bulk Data](http://hl7.org/fhir/uv/bulkdata/) pattern.

**Kick-off request:**

```http
GET https://broker-x.example.org/fhir/Subscription/$brokered?_since=2026-03-01T00:00:00Z
Accept: application/fhir+json
Prefer: respond-async
```

**Kick-off response:**

```http
HTTP/1.1 202 Accepted
Content-Location: https://broker-x.example.org/fhir/bulkstatus/abc123
```

**Completion response** (when polling status URL returns 200):

```js
{
  "transactionTime": "2026-03-15T12:00:00Z",
  "request": "https://broker-x.example.org/fhir/Subscription/$brokered?_since=2026-03-01T00:00:00Z",
  "output": [
    { "type": "Parameters", "url": "https://broker-x.example.org/bulk/abc123/parameters.ndjson" }
  ]
}
```

**NDJSON content** — each line is a Parameters resource representing one subscription's intent:

```js
{"resourceType":"Parameters","parameter":[{"name":"subscription-id","valueString":"sub-abc-123"},{"name":"subscription-status","valueCode":"active"},{"name":"patient","resource":{...}},{"name":"event-scope","valueCoding":{...}},{"name":"permission-ticket","valueString":"eyJ..."}]}
{"resourceType":"Parameters","parameter":[{"name":"subscription-id","valueString":"sub-def-456"},{"name":"subscription-status","valueCode":"active"},{"name":"patient","resource":{...}},{"name":"event-scope","valueCoding":{...}},{"name":"permission-ticket","valueString":"eyJ..."}]}
```

**Parameters structure** (formatted for readability):

```js
{
  "resourceType": "Parameters",
  "parameter": [
    {
      "name": "subscription-id",
      "valueString": "sub-abc-123"  // Opaque; for correlation only
    },
    {
      "name": "subscription-status",
      "valueCode": "active"  // or "off" for deletions
    },
    {
      "name": "patient",
      "resource": {
        "resourceType": "Patient",
        "identifier": [{ "system": "...", "value": "..." }],
        "name": [{ "family": "Smith", "given": ["Maria"] }],
        "birthDate": "1970-05-15",
        "gender": "female"
        // Demographics sufficient for cross-network matching
      }
    },
    {
      "name": "event-scope",
      "valueCoding": {
        "system": "http://hl7.org/fhir/us/core/CodeSystem/...",
        "code": "encounter-start"
      }
    },
    {
      "name": "permission-ticket",
      "valueString": "eyJhbGciOiJFUzI1NiIs..."
      // Instance of nascent SMART Permission Ticket artifact
      // JWT carries: iss, sub, iat, exp, scope, purpose, etc.
    }
  ]
}
```

**What gets included:**

| Parameter | Purpose |
|-----------|---------|
| `subscription-id` | Opaque identifier for correlation; allows updates/deletes |
| `subscription-status` | `active` or `off` — allows peer to track lifecycle |
| `patient` | Embedded Patient resource with demographics for cross-network matching |
| `event-scope` | Event types of interest (encounter-start, encounter-end, etc.) |
| `permission-ticket` | SMART Permission Ticket JWT carrying purpose, scope, and verifiable consent |

**What gets excluded:**

| Excluded | Rationale |
|----------|-----------|
| Client delivery endpoint | Peer does not deliver to Client; only home Broker does |
| Client authentication headers | Shared secrets; security risk if leaked |
| Broker-internal state | Matching thresholds, retry policies, etc. |

**Tradeoffs:**
- Lower bandwidth — peer sends only matched events
- Requires new protocol element
- Broker Y learns which patients Broker X is tracking

---

## 3. Synchronization

### 3.1 Polling

Broker Y can poll Broker X's `$brokered` operation periodically:
- Call with `_since` parameter to get updates since last sync (e.g., nightly)
- Maintain local cache of Broker X's subscription intents
- Filter outgoing event stream to matching patients

### 3.2 Real-Time Updates via Subscription

For real-time synchronization, Broker Y can subscribe to Broker X for subscription intent changes using a dedicated topic.

**Topic (functional definition):**

| Property | Value |
|----------|-------|
| URL | `http://hl7.org/fhir/us/cms-network/SubscriptionTopic/brokered-subscription-intent` |
| Trigger | Subscription created, updated, or deleted at Broker X |
| Focus | Parameters resource containing subscription intent |
| Notification content | Parameters with patient demographics, event scope, subscription ID, and status |

**Subscription request** (Broker Y → Broker X):

```http
POST https://broker-x.example.org/fhir/Subscription
Authorization: Bearer {peering_token}
Content-Type: application/fhir+json
```

```js
{
  "resourceType": "Subscription",
  "status": "requested",
  "reason": "Cross-network subscription intent sync",
  "criteria": "http://hl7.org/fhir/us/cms-network/SubscriptionTopic/brokered-subscription-intent",
  "channel": {
    "type": "rest-hook",
    "endpoint": "https://broker-y.example.org/peering/intent-updates",
    "payload": "application/fhir+json"
  }
}
```

**Notification** (Broker X → Broker Y when a subscription changes):

```js
{
  "resourceType": "Bundle",
  "type": "subscription-notification",
  "entry": [{
    "fullUrl": "urn:uuid:a1b2c3d4-0000-0000-0000-000000000001",
    "resource": {
      "resourceType": "SubscriptionStatus",
      "type": "event-notification",
      "notificationEvent": [{
        "focus": { "reference": "urn:uuid:a1b2c3d4-0000-0000-0000-000000000002" }
      }],
      "subscription": { "reference": "https://broker-x.example.org/fhir/Subscription/peering-sub-xyz" },
      "topic": "http://hl7.org/fhir/us/cms-network/SubscriptionTopic/brokered-subscription-intent"
    }
  }, {
    "fullUrl": "urn:uuid:a1b2c3d4-0000-0000-0000-000000000002",
    "resource": {
      "resourceType": "Parameters",
      "parameter": [
        {
          "name": "subscription-id",
          "valueString": "sub-abc-123"
        },
        {
          "name": "subscription-status",
          "valueCode": "active"  // or "off" for deletions
        },
        {
          "name": "patient",
          "resource": {
            "resourceType": "Patient",
            "identifier": [{ "system": "...", "value": "..." }],
            "name": [{ "family": "Smith", "given": ["Maria"] }],
            "birthDate": "1970-05-15",
            "gender": "female"
          }
        },
        {
          "name": "event-scope",
          "valueCoding": {
            "system": "http://hl7.org/fhir/us/core/CodeSystem/...",
            "code": "encounter-start"
          }
        },
        {
          "name": "permission-ticket",
          "valueString": "eyJhbGciOiJFUzI1NiIsInR5cCI6InBlcm1pc3Npb24tdGlja2V0K2p3dCJ9.eyJpc3MiOiJodHRwczovL2lkcC5leGFtcGxlLm9yZyIsInN1YiI6InBhdGllbnQtMTIzIiwiaWF0IjoxNzA5MjIwMDAwLCJleHAiOjE3NDA3NTYwMDAsInNjb3BlIjoiRW5jb3VudGVyLnJzIiwicHVycG9zZSI6InBhdGllbnQtcmVxdWVzdGVkIn0.signature"
          // Instance of nascent SMART Permission Ticket artifact
          // JWT carries: iss, sub, iat, exp, scope, purpose, etc.
          // Allows peer to verify authorization provenance
        }
      ]
    }
  }]
}
```

**Status values:**

| `subscription-status` | Meaning |
|-----------------------|---------|
| `active` | Subscription is live; peer should match events for this patient |
| `off` | Subscription deleted or disabled; peer should stop matching |

This allows Broker Y to maintain a synchronized view of Broker X's subscription intents with minimal latency.

---

## 4. What Controls What Flows

Cross-network routing does not necessarily imply unconstrained broadcast. Networks have options:

- **Authorization context** — Purpose of use (patient-requested, treatment, etc.) determines entitlement
- **Peering agreements** — Networks may scope routing by trust framework, bilateral agreement, geography, or data type
- **Local policy enforcement** — Each network may apply its own consent and risk controls before emitting events across a boundary

Data Sources may participate in multiple Networks simultaneously. This specification does not require exclusive participation or uniform scoping rules.

---

## 5. Open Questions

1. **Operation details** — What additional parameters should `$brokered` support? Filtering by event type? Additional bulk data options?

2. **Patient matching** — How do Brokers resolve cross-network patient identity? Leverage existing MPI/RLS infrastructure? Require specific identifier types?

3. **Permission ticket details** — What claims must a SMART Permission Ticket carry for cross-network use? What verification must the peer perform? How do permission tickets interact with network trust frameworks?

4. **Deletion and revocation** — The `subscription-status=off` mechanism signals deletion, but what latency is acceptable? What consistency guarantees are needed?

5. **Business alignment** — Networks that contribute more events than they receive may need compensation models to sustain participation.

---

## References

- [Main specification](index.md)
- [FAQ](faq.md)
- [End-to-end example](e2e-ias-example.md)
- [FHIR Bulk Data Access](http://hl7.org/fhir/uv/bulkdata/)
