# End-to-End Example: IAS App Receives Encounter Notification

This walkthrough shows every step when a patient using an Individual Access Services (IAS) app receives a notification about an out-of-state ED visit — from app setup through data retrieval.

**Scenario**: Jane is a "snowbird" — she lives in Minnesota but spends winters in Arizona. While in Arizona, she visits an ED for chest pain. Her IAS app receives the notification in real-time, keeping her informed about her care no matter where she travels.

Each step is labeled:

| Label | Meaning |
|-------|---------|
| **Specified** | Client-facing FHIR interaction defined by this protocol |
| **Network-Internal** | Below the abstraction barrier — each CMS-Aligned Network implements using its own mechanisms (FHIR Subscriptions, HL7v2 ADT, polling, RLS queries, etc.). Not standardized by this protocol. |
| **Prerequisite** | Completed before the protocol flow begins; outside both layers |

---

## Actors

| Actor | Example |
|-------|---------|
| **Patient** | Jane Doe (Minnesota resident, winters in Arizona) |
| **IAS App** | A patient-facing mobile health app (the Client) |
| **Broker** | CMS-Aligned Network's Subscriptions Broker |
| **Identity Service** | CLEAR or ID.me (Kantara-certified IAL2) |
| **Data Source** | Mercy Hospital EHR (Phoenix, AZ) |

---

## Phase 1: Setup

### Step 1 — Patient installs IAS app
> **Prerequisite**

Jane downloads and installs an IAS app on her phone.

### Step 2 — Patient completes identity proofing
> **Prerequisite**

Jane verifies her identity through a trusted identity service (e.g., CLEAR or ID.me) at IAL2. The identity service produces a credential or assertion that the IAS app can present later.

### Step 3 — Patient provides consent
> **Prerequisite**

Jane authorizes the IAS app to receive notifications about her care. For an initial pilot, this may be implicit (she installed the app and verified her identity). At scale, explicit consent capture is needed — especially for designated representatives, caregivers, or sensitive data categories. See [FAQ](faq.md#why-is-implicit-consent-acceptable-for-a-pilot-but-not-at-scale) and the main document's discussion of SMART Permission Tickets.

### Step 4 — IAS app is registered with the Broker
> **Prerequisite**

The IAS app has a registered `client_id` and a registered public key (JWK) with the Broker. The app holds the corresponding private key, which it uses to sign client assertion JWTs when requesting access tokens.

---

## Phase 2: Obtain Access Token

### Step 5 — IAS app requests access token from Broker
> **Specified**

The IAS app presents Jane's identity credentials (from the trusted identity service) along with consent evidence and purpose of use in a Backend Services-style token request.

```http
POST https://broker.example.org/auth/token
Content-Type: application/x-www-form-urlencoded

grant_type=client_credentials
&client_assertion_type=urn:ietf:params:oauth:client-assertion-type:jwt-bearer
&client_assertion={signed_jwt}  // assume identity + consent context is conveyed here (format TBD)
```

### Step 6 — Broker verifies identity and issues token
> **Specified**

The Broker:
1. Validates the IAS app's client credentials
2. Validates Jane's IAL2 identity credential
3. Performs patient matching against its records
4. Assigns a broker-scoped `Patient.id` (e.g., `Patient/broker-123`)
5. Returns an access token scoped to Jane's data

```js
{
  "access_token": "eyJ...",
  "token_type": "bearer",
  "expires_in": 3600,
  "scope": "system/Subscription.crud system/Encounter.r",
  // SMART on FHIR patient context — the broker-scoped Patient.id
  // Use this value in subscription filter criteria (Step 7)
  "patient": "broker-123"
}
```

The `patient` value is a broker-scoped `Patient.id` — not a cross-organization identifier. The IAS app uses it in subscription filter criteria to tell the Broker which patient to watch.

---

## Phase 3: Create Subscription

### Step 7 — IAS app creates Subscription at Broker
> **Specified**

```http
POST https://broker.example.org/fhir/Subscription
Authorization: Bearer eyJ...
Content-Type: application/fhir+json
```

```json
{
  "resourceType": "Subscription",
  "status": "requested",
  "reason": "Patient notifications for IAS app",
  "criteria": "http://hl7.org/fhir/us/core/SubscriptionTopic/patient-data-feed",
  "_criteria": {
    "extension": [
      {
        "url": "http://hl7.org/fhir/uv/subscriptions-backport/StructureDefinition/backport-filter-criteria",
        "valueString": "Encounter?patient=Patient/broker-123&trigger=feed-event"
      },
      {
        "url": "http://hl7.org/fhir/uv/subscriptions-backport/StructureDefinition/backport-filter-criteria",
        "valueString": "DiagnosticReport?patient=Patient/broker-123&category=LAB&trigger=feed-event"
      }
    ]
  },
  "channel": {
    "type": "rest-hook",
    "endpoint": "https://ias-app.example.com/notifications",
    "payload": "application/fhir+json",
    "header": [
      "X-Subscription-Token: {shared_secret}"
    ],
    "_payload": {
      "extension": [
        {
          "url": "http://hl7.org/fhir/uv/subscriptions-backport/StructureDefinition/backport-payload-content",
          "valueCode": "id-only"
        }
      ]
    }
  }
}
```

### Step 8 — Broker acknowledges subscription
> **Specified**

```http
HTTP/1.1 201 Created
Content-Type: application/fhir+json
Location: https://broker.example.org/fhir/Subscription/sub-abc123

{
  "resourceType": "Subscription",
  "id": "sub-abc123",
  "status": "active",
  ...
}
```

---

## Phase 4: Broker Arranges Network-Internal Event Feeds

Everything in this phase is below the abstraction barrier. The IAS app is unaware of these steps.

### Step 9 — Broker queries Record Locator Service
> **Network-Internal**

The Broker queries an RLS to discover which Data Sources hold records for Jane. This may return Mercy Hospital, City Clinic, and Blue Cross as known data holders.

This is also the mechanism that would support historical lookback — the Broker (or RLS) knows where Jane has been seen, enabling future event matching.

### Step 10 — Broker arranges event feeds from Data Sources
> **Network-Internal**

For each discovered Data Source, the Broker sets up event delivery using whatever mechanism that source supports:

| Data Source | Mechanism | Notes |
|-------------|-----------|-------|
| Mercy Hospital | HL7v2 ADT feed | Hospital sends ADT messages to its network; network routes to Broker |
| City Clinic | FHIR Subscription | Clinic's EHR supports FHIR natively; Broker creates a child subscription |
| Blue Cross (Payer) | Polling | Broker periodically checks for new claims |
| Network Y (peer) | Broker-to-Broker subscription | Broker X subscribes at Broker Y for Jane's events; Broker Y delivers notifications when Jane is seen at any Network Y provider (e.g., Valley Medical) |

The last row illustrates **network peering**: Broker X doesn't need to know about Valley Medical directly — it subscribes once at Broker Y, and Broker Y handles the internal routing. This is how a patient can receive notifications from providers across multiple connected networks through a single Client subscription. See [FAQ](faq.md#can-a-client-receive-notifications-from-providers-in-a-different-network) for more on peering.

---

## Phase 5: Event Occurs

### Step 11 — Jane visits Mercy Hospital ED (Phoenix, AZ)
> **Real-world event**

Jane experiences chest pain while at her winter home in Arizona. She presents at Mercy Hospital's Emergency Department in Phoenix — a facility she's never visited before and that has no prior record of her.

### Step 12 — Mercy Hospital EHR generates ADT event
> **Network-Internal**

Mercy Hospital's EHR produces an ADT A01 (admit) message as part of its normal workflow. This message flows to the CMS-Aligned Network through whatever integration Mercy Hospital has in place — a direct HL7v2 feed, an integration engine, or a network gateway.

```
MSH|^~\&|MERCY_EHR|MERCY|NETWORK|CMS_NET|202603151430||ADT^A01|...|
PID|||MRN-5678^^^MERCY||DOE^JANE||19850101|F|||...
PV1||E|ED^ROOM3||||...
```

### Step 13 — Event reaches Broker
> **Network-Internal**

The network routes the ADT message to the Broker. The Broker:

1. Parses the event (from HL7v2, FHIR, or whatever format)
2. Resolves the patient identity (Mercy's MRN-5678 → Broker's Patient/broker-123) — see [FAQ](faq.md#what-about-patient-matching-ehrs-manage-their-own-matching-thresholds-today) on matching approaches
3. Matches against active subscriptions
4. Finds that Subscription/sub-abc123 is watching for Encounter events on Patient/broker-123

---

## Phase 6: Notification Delivery

### Step 14 — Broker sends FHIR notification to IAS app
> **Specified**

The Broker converts the event into a standard FHIR notification bundle and delivers it to the IAS app's registered endpoint:

```http
POST https://ias-app.example.com/notifications
Content-Type: application/fhir+json
X-Subscription-Token: {shared_secret}
```

```json
{
  "resourceType": "Bundle",
  "type": "subscription-notification",
  "timestamp": "2026-03-15T14:32:00Z",
  "entry": [
    {
      "fullUrl": "urn:uuid:notification-status-1",
      "resource": {
        "resourceType": "SubscriptionStatus",
        "status": "active",
        "type": "event-notification",
        "eventsSinceSubscriptionStart": 1,
        "notificationEvent": [
          {
            "eventNumber": 1,
            "timestamp": "2026-03-15T14:30:15Z",
            "focus": {
              // Proxy Retrieval Mode (baseline): reference points to Broker
              "reference": "https://broker.example.org/fhir/Encounter/enc-98765",
              // Direct Retrieval Mode (if network provides automated registration):
              // "reference": "https://mercy-hospital.example.org/fhir/Encounter/enc-98765",
              "type": "Encounter"
            }
          }
        ],
        "subscription": {
          "reference": "https://broker.example.org/fhir/Subscription/sub-abc123"
        },
        "topic": "http://hl7.org/fhir/us/core/SubscriptionTopic/patient-data-feed"
      }
    }
  ]
}
```

Note: In the baseline Proxy Retrieval Mode, `focus.reference` points to the Broker, which proxies/caches the Encounter content so the IAS app does not need per-provider registrations.

### Step 15 — IAS app acknowledges
> **Specified**

```http
HTTP/1.1 200 OK
```

---

## Phase 7: Data Retrieval (Proxy Retrieval Mode)

### Step 16 — IAS app parses notification
> **Specified** (client-side processing)

The IAS app extracts the focus reference URL:

```
focus.reference = "https://broker.example.org/fhir/Encounter/enc-98765"
```

This is a Broker URL, so the IAS app can retrieve the Encounter from the Broker using its existing Broker-issued access token.

### Step 17 — IAS app fetches Encounter resource from Broker
> **Specified**

```http
GET https://broker.example.org/fhir/Encounter/enc-98765
Authorization: Bearer eyJ...
Accept: application/fhir+json
```

### Step 18 — Broker returns Encounter
> **Specified**

```http
HTTP/1.1 200 OK
Content-Type: application/fhir+json

{
  "resourceType": "Encounter",
  "id": "enc-98765",
  "status": "in-progress",
  "class": {
    "system": "http://terminology.hl7.org/CodeSystem/v3-ActCode",
    "code": "EMER",
    "display": "emergency"
  },
  "type": [
    {
      "coding": [
        {
          "system": "http://snomed.info/sct",
          "code": "50849002",
          "display": "Emergency department patient visit"
        }
      ]
    }
  ],
  "subject": {
    "reference": "Patient/broker-123"
  },
  "period": {
    "start": "2026-03-15T14:30:00Z"
  },
  "serviceProvider": {
    "reference": "Organization/mercy-hospital",
    "display": "Mercy Hospital"
  }
}
```

Jane's IAS app now shows: "New ED visit at Mercy Hospital (Phoenix, AZ) — started 2:30 PM today."

**Looking ahead** (beyond the scope of this walkthrough, showing future capabilities): Jane taps the notification to retrieve full clinical details—the ED note, lab results, and discharge instructions. From the app, she schedules a follow-up telehealth visit with her Minnesota PCP.

---

## Summary

| Step | Phase | Label | Description |
|------|-------|-------|-------------|
| 1 | Setup | Prerequisite | Patient installs IAS app |
| 2 | Setup | Prerequisite | Patient completes IAL2 identity proofing |
| 3 | Setup | Prerequisite | Patient provides consent |
| 4 | Setup | Prerequisite | IAS app registered with Broker |
| 5 | Token | **Specified** | IAS app requests access token from Broker |
| 6 | Token | **Specified** | Broker verifies identity, assigns `Patient.id`, returns token |
| 7 | Subscribe | **Specified** | IAS app creates `Subscription` using broker-scoped `Patient.id` |
| 8 | Subscribe | **Specified** | Broker returns active Subscription |
| 9 | Arrange feeds | **Network-Internal** | Broker queries RLS for known data sources |
| 10 | Arrange feeds | **Network-Internal** | Broker sets up ADT/FHIR/polling feeds per source |
| 11 | Event | Real-world | Patient visits Mercy Hospital ED |
| 12 | Event | **Network-Internal** | EHR generates ADT; event reaches network |
| 13 | Event | **Network-Internal** | Broker resolves patient identity, matches subscription |
| 14 | Notify | **Specified** | Broker sends FHIR notification bundle to IAS app |
| 15 | Notify | **Specified** | IAS app acknowledges |
| 16 | Retrieve | **Specified** | IAS app parses `focus.reference` URL (points to Broker) |
| 17 | Retrieve | **Specified** | IAS app fetches Encounter from Broker |
| 18 | Retrieve | **Specified** | Broker returns US Core Encounter |
