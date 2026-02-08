# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

A proof-of-concept demonstrating **referral loop closure** using the FHIR Subscriptions Broker architecture for the CMS Interoperability Framework (July 4, 2026 deadline). The app is an Identity-Assured Subscriber (IAS) client that onboards patients, creates FHIR Subscriptions at a Broker, receives encounter notifications, matches them to open referrals, and routes updates to referring physicians based on patient consent.

## Commands

```bash
# Runtime: Bun v1.3+ (ensure ~/.bun/bin is on PATH)
export PATH="$HOME/.bun/bin:$PATH"

# Start the broker (required — runs on port 3000)
cd cms-fhir-subscriptions-broker/demo && ROUTING_MODE=path bun run server.ts

# Start this app (port 4000)
bun run server.ts
bun --watch run server.ts   # dev mode with hot reload

# Tests
bun test                              # All tests (122 across 8 files)
bun test tests/matching.test.ts       # Single file
bun test tests/e2e-server             # E2E only (needs ports 3000+4000 free)
```

No build step. No external runtime dependencies (only `@types/bun` devDep). No tsconfig — Bun handles TypeScript natively.

## Architecture

### Data Flow

```
Patient onboards → Broker assigns brokerId → App creates FHIR Subscription
EHR creates Encounter → Broker matches patient → delivers to /notifications webhook
App fetches full Encounter → matching engine scores against open referrals
→ If match + consent allows → route to physician dashboard via SSE
```

### Source Map

| File | Role |
|------|------|
| `server.ts` | HTTP server, all routing, landing page HTML, `/notifications` webhook handler, `/api/seed`, `/api/reset`, `/api/trigger` |
| `config.ts` | Ports + broker URL paths. Helpers: `brokerUrl()`, `ehrUrl()`, `selfUrl()` |
| `store.ts` | All in-memory `Map`s for FHIR resources, broker sessions, sharing prefs, SSE clients. Helpers: `resolvePatientId()`, `getOpenReferrals()`, `getSharingPreference()`, `clearAllStores()` |
| `fhir/types.ts` | FHIR R4 interfaces + app types (`SharingPreference`, `RoutedEvent`, `NotificationRecord`) |
| `fhir/resources.ts` | Factory functions: `makePatient()`, `makePractitioner()`, `makeOrganization()`, `makePractitionerRole()`, `makeServiceRequest()`, `makeTask()`, `makeEncounter()` |
| `matching/fuzzy.ts` | `normalizeName()`, `levenshteinDistance()`, `fuzzyNameMatch()`, `tokenJaccard()` |
| `matching/engine.ts` | `matchEncounterToReferrals()` — weighted scoring (see below) |
| `portal/handler.ts` | Patient portal API: info, referrals, encounters, sharing, 5-step onboarding wizard |
| `portal/broker-client.ts` | All broker communication: `registerWithBroker()`, `registerWithEhr()`, `linkPatientIds()`, `authenticateWithBroker()`, `createSubscription()`, `triggerEncounterAtEhr()`, `fetchEncounterFromEhr()` |
| `portal/routing.ts` | **Main pipeline**: `processEncounter()`, `updateTaskForEncounter()`, `buildMatchContext()`, `checkOverdueTasks()` |
| `physician/handler.ts` | Physician dashboard API: SSE stream, dashboard data, referral CRUD |
| `shared/auth.ts` | Mock JWT creation, `createPermissionTicket()`, `createClientAssertion()` for SMART Backend Services |
| `shared/sse.ts` | `createSSEStream()`, `broadcast()` — SSE connection management |
| `shared/seed.ts` | `seedDemoData()` (patient + providers) and `seedDemoReferral()` (cardiology referral) |

### Key Entry Points

**`processEncounter()`** (`portal/routing.ts`) — the central pipeline:
1. `resolvePatientId()` — maps EHR-local patient ID to canonical ID via `brokerSessions`
2. Store encounter in `encounters` map
3. Broadcast to patient portal via SSE
4. `matchEncounterToReferrals()` — score against open referrals
5. `updateTaskForEncounter()` — advance task state machine
6. Check `getSharingPreference()` to decide routing
7. If routed, record `RoutedEvent` and broadcast to physician via SSE

**`matchEncounterToReferrals()`** (`matching/engine.ts`) — weighted scoring:
| Signal | Weight | Match Type |
|--------|--------|------------|
| Organization NPI | 0.35 | Exact |
| Practitioner NPI | 0.25 | Exact |
| Organization name | 0.20 | Fuzzy (Levenshtein) |
| Specialty code | 0.10 | Exact taxonomy code |
| Date in window | 0.10 | Within `occurrencePeriod` |

Confidence: high (>=0.70, auto-link), medium (>=0.40), low (<0.40). Results below 0.10 excluded.

The engine uses `MatchContext` lookup functions to resolve FHIR references to NPI values from the in-memory stores. Encounters from the upstream EHR also carry embedded NPI identifiers on `participant[0].individual.identifier`.

### Patient Identity Cross-Referencing

Three ID scopes maintained in `brokerSessions` map:
- **Canonical** (ours): e.g. `patient-001`
- **Broker-scoped**: assigned during broker registration
- **EHR-local** (`sourceId`): assigned by Mercy General EHR (e.g. `mercy-a1b2c3d`)

`resolvePatientId(ehrPatientId)` iterates `brokerSessions` to find the canonical ID matching a given `sourceId`.

### Task State Machine

```
requested/awaiting-scheduling
  → planned encounter matched → in-progress/appointment-scheduled
  → in-progress|arrived|triaged encounter → in-progress/encounter-in-progress
  → finished encounter → completed/loop-closed
  → past restriction.period.end → failed/overdue
```

Completed/failed/cancelled tasks are not affected by subsequent encounters.

### Consent Routing

| Mode | Match found | No match |
|------|-------------|----------|
| `"referrals-only"` | Route to physician | Portal only |
| `"all-encounters"` | Route to physician | Route to physician |
| No preference / inactive | Portal only | Portal only |

Sharing preferences keyed by `${patientId}:${physicianRef}` in the `sharingPreferences` map.

### Onboarding Wizard

Five sequential steps enforced by `OnboardingState` in `portal/handler.ts`:
1. **Verify identity** (`POST /patient/verify-identity`) — simulated IAL2
2. **Register** (`POST /patient/register`) — broker + EHR registration, link IDs
3. **Authorize** (`POST /patient/authorize`) — permission ticket + token exchange
4. **Subscribe** (`POST /patient/subscribe`) — create FHIR Subscription with webhook endpoint
5. **Complete** (`POST /patient/complete-onboarding`) — set sharing preference

Each step validates the previous step completed. The wizard state is stored in `onboardingStates`.

### Server Routes

| Route | Method | Handler |
|-------|--------|---------|
| `/` | GET | Landing page with demo controls |
| `/patient/*` | GET/POST | `handlePatientRequest()` — portal API |
| `/physician/*` | GET/POST | `handlePhysicianRequest()` — dashboard API |
| `/notifications` | POST | Webhook from broker — fetches encounters, runs `processEncounter()` |
| `/api/seed` | POST | Seeds demo data + referral |
| `/api/reset` | POST | `clearAllStores()` + resets broker + EHR |
| `/api/trigger` | POST | Triggers encounters at the upstream EHR (`schedule-appointment`, `start-encounter`, `psychiatrist-visit`) |

## Testing

**Framework**: Bun's native test runner (`bun:test`) with `describe`/`it`/`expect`.

| Test file | Scope |
|-----------|-------|
| `fhir-resources.test.ts` | FHIR resource factory functions |
| `matching.test.ts` | Levenshtein, fuzzy matching, weighted scoring engine |
| `consent-routing.test.ts` | Consent modes, routing logic, `processEncounter()` pipeline |
| `referral-lifecycle.test.ts` | Task state transitions, overdue detection |
| `broker-integration.test.ts` | Broker registration, auth, subscription (auto-skips if broker down) |
| `e2e-server.test.ts` | Server startup, HTTP routing |
| `e2e-referral-flow.test.ts` | Full referral → encounter → match → route flow |
| `e2e-two-provider.test.ts` | Multiple referrals, consent filtering across providers |

### Testing Patterns

- **`clearAllStores()`** in `beforeEach` resets all in-memory Maps
- **`isBrokerRunning()`** — broker integration tests auto-skip when broker not running
- **E2E tests** auto-start/stop both servers; skip if ports unavailable
- **`makeEncounter()`** needs both `serviceProviderRef` and `serviceProviderDisplay` for matching engine NPI + name matching to work
- **`seedDemoReferral()`** is separate from `seedDemoData()` — tests create their own referrals with specific IDs for assertions

## The Broker (vendored)

Vendored at `cms-fhir-subscriptions-broker/` (originally from [jmandel/cms-fhir-subscriptions-broker](https://github.com/jmandel/cms-fhir-subscriptions-broker), with local modifications).

- Must run with `ROUTING_MODE=path` for this app to communicate via path-based URLs
- Three services: `/client/` (IAS Client), `/broker/` (Subscriptions Broker), `/mercy-ehr/` (simulated EHR)
- All inter-service communication happens over HTTP (no in-process wiring)
- The EHR always sets `serviceProvider` to "Mercy General Hospital" — encounters arrive with the EHR's real data
- **Local modifications**: admin reset endpoints, custom subscription endpoint delivery, encounter update-by-ID support, practitioner NPI/display fields in EncounterOptions

## Seed Data (from `shared/seed.ts`)

| Entity | ID | NPI | Notes |
|--------|-----|-----|-------|
| Patient Alice Rodriguez | `patient-001` | — | DOB: 1987-04-12 |
| Dr. Robert Smith (PCP) | `dr-smith` | 1234567890 | Referring physician |
| Mercy General Hospital | `mercy-hospital` | 1538246790 | Upstream EHR data source |
| Valley Cardiology | `org-valley-cardiology` | 1122334455 | Not in broker — tests matching filter |
| Dr. Sarah Johnson | `dr-johnson` | 9876543210 | Cardiologist |
| Cardiology role | `role-cardio` | — | Links dr-johnson to Valley Cardiology, specialty 207RC0000X |

The demo referral (`referral-001` / `task-001`) targets Mercy General + Dr. Johnson for cardiovascular disease.

## Platform Notes

- macOS doesn't have `timeout` — to test server startup: `bun -e "import './server.ts'; setTimeout(() => process.exit(0), 2000);"`
- Background sub-agents can't get interactive Bash permissions — run tests from main thread
