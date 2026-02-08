# Referral Loop Closure POC

A proof-of-concept demonstrating **referral loop closure** using the [FHIR Subscriptions Broker architecture](https://github.com/jmandel/cms-fhir-subscriptions-broker) proposed by [Josh Mandel](https://github.com/jmandel) for the CMS Interoperability Framework (July 2026 deadline).

## What this does

This application acts as an **Identity-Assured Subscriber (IAS) client** that sits on top of Josh's Subscriptions Broker. It demonstrates a complete referral loop closure workflow:

1. A PCP (Dr. Smith) creates a referral for a patient (Alice Rodriguez) to a cardiologist (Dr. Johnson) at Mercy General Hospital
2. Alice onboards through a patient portal with IAL2 identity verification, broker registration, SMART authorisation, and FHIR Subscription creation
3. When Mercy General's EHR creates encounters for Alice, the Broker delivers notifications to the application's webhook
4. A matching engine scores encounters against open referrals using NPI, organisation name, specialty, and date signals
5. Matched encounters update the referral Task lifecycle and route to Dr. Smith's dashboard in real time (based on Alice's consent preferences)

## Architecture

```
Dr. Smith's Dashboard ←──SSE──┐
                               │
Alice's Portal ←──SSE──── This App (port 4000) ←── webhook ─── Broker (port 3000)
                               │                                      │
                               └── FHIR read ──→ Mercy General EHR ──┘
                                                   (Josh's demo)
```

**This app** (`referral-loop-closure/`): Patient portal, physician dashboard, matching engine, consent routing, FHIR resource builders, and test suite.

**Josh's Broker** (`cms-fhir-subscriptions-broker/`, [upstream](https://github.com/jmandel/cms-fhir-subscriptions-broker)): Subscriptions Broker, IAS client services, and simulated Mercy General EHR. Included as a git submodule; runs as a separate process.

## Prerequisites

- [Bun](https://bun.sh) v1.3+

## Setup

```bash
git clone --recurse-submodules https://github.com/durvester/referral-loop-closure.git
cd referral-loop-closure
bun install
```

If you've already cloned without `--recurse-submodules`:
```bash
git submodule update --init
```

## Running

```bash
# Terminal 1: Start Josh's Broker + simulated EHR
cd cms-fhir-subscriptions-broker/demo
ROUTING_MODE=path bun run server.ts

# Terminal 2: Start this app (from repo root)
bun run server.ts

# Open http://localhost:4000
```

### Demo flow

1. Click **Seed Data** (creates patient, providers, and cardiology referral)
2. Open **Patient Portal** and complete the 5-step onboarding wizard
3. Click **Schedule Cardiology Appointment** to simulate an encounter at Mercy General
4. Watch the notification flow through to both Alice's portal and Dr. Smith's dashboard
5. Click **Begin Cardiology Encounter** to see the same encounter update in place
6. Try **Psychiatrist Visit** to see an unrelated encounter filtered by consent

## Testing

```bash
bun test                      # All tests (122 tests across 8 files)
bun test tests/e2e-server     # E2E only (needs ports 3000 + 4000 free)
```

## Modifications to Josh's implementation

I made two additions to Josh's EHR data source handler to support the demo:

1. **`/trigger-event` endpoint**: Accepts patient demographics and encounter options to simulate encounter creation at Mercy General with specific practitioner and clinical details
2. **Encounter update by ID**: Support for updating an existing encounter's status rather than always creating new ones, enabling `planned → in-progress → finished` progression on a single Encounter resource

These changes are in the companion fork and are not required for the core Broker functionality.

## Key files

| File | Purpose |
|------|---------|
| `server.ts` | HTTP server, routing, landing page, trigger handlers |
| `portal/handler.ts` | Patient portal API (onboarding wizard, referrals, encounters, sharing) |
| `portal/broker-client.ts` | Broker integration (registration, auth, subscription, data fetch) |
| `portal/routing.ts` | Consent checking, referral matching, task lifecycle, physician routing |
| `matching/engine.ts` | Weighted scoring engine (NPI, org name, specialty, date window) |
| `matching/fuzzy.ts` | Levenshtein-based fuzzy name matching |
| `physician/handler.ts` | Physician dashboard API |
| `fhir/types.ts` | FHIR R4 type definitions |
| `fhir/resources.ts` | FHIR resource builders (Patient, ServiceRequest, Task, Encounter, etc.) |
| `store.ts` | In-memory data stores, patient ID cross-referencing, sharing preferences |
| `shared/auth.ts` | Permission ticket and client assertion generation |
| `shared/sse.ts` | Server-Sent Events broadcasting |
| `shared/seed.ts` | Demo seed data |

## Acknowledgements

This POC builds directly on [Josh Mandel's](https://github.com/jmandel) FHIR Subscriptions Broker architecture and [demo implementation](https://github.com/jmandel/cms-fhir-subscriptions-broker). The Broker handles patient registration, demographic matching, subscription management, and notification delivery. This application adds referral tracking, encounter matching, consent routing, and provider-facing dashboards on top of that infrastructure.

## License

[MIT](LICENSE)
