import { patients, practitioners, organizations, practitionerRoles, serviceRequests, tasks, clearAllStores } from "../store";
import { makePatient, makePractitioner, makeOrganization, makePractitionerRole, makeServiceRequest, makeTask } from "../fhir/resources";

export function seedDemoData(): void {
  clearAllStores();

  // --- Patient ---
  const patient = makePatient({
    id: "patient-001",
    name: "Alice M Rodriguez",
    birthDate: "1987-04-12",
    gender: "female",
  });
  patients.set(patient.id, patient);

  // --- Referring Physician (Dr. Smith, PCP) ---
  const drSmith = makePractitioner({
    id: "dr-smith",
    name: "Dr. Robert Smith",
    npi: "1234567890",
    credentials: "MD",
  });
  practitioners.set(drSmith.id, drSmith);

  // --- Provider A: Mercy General Hospital (upstream EHR data source) ---
  // This org ID MUST match the upstream EHR's serviceProvider.reference ("Organization/mercy-hospital").
  // Registering it in our store enables NPI-based matching when encounters arrive from the broker.
  const orgMercy = makeOrganization({
    id: "mercy-hospital",
    name: "Mercy General Hospital",
    npi: "1538246790",
    aliases: ["Mercy General", "MGH"],
    type: "prov",
    city: "Springfield",
    state: "IL",
  });
  organizations.set(orgMercy.id, orgMercy);

  // --- Provider B: Valley Cardiology (second referral, no EHR in broker) ---
  // This referral will NOT match encounters from the upstream EHR because Valley Cardiology
  // is not a data source — demonstrating the matching filter works correctly.
  const orgValley = makeOrganization({
    id: "org-valley-cardiology",
    name: "Valley Cardiology",
    npi: "1122334455",
    aliases: ["VCA", "Valley Cardiology Associates"],
    type: "prov",
    city: "Springfield",
    state: "IL",
  });
  organizations.set(orgValley.id, orgValley);

  const drJohnson = makePractitioner({
    id: "dr-johnson",
    name: "Dr. Sarah Johnson",
    npi: "9876543210",
    credentials: "MD",
  });
  practitioners.set(drJohnson.id, drJohnson);

  const roleCardio = makePractitionerRole({
    id: "role-cardio",
    practitionerId: "dr-johnson",
    practitionerDisplay: "Dr. Sarah Johnson",
    organizationId: "org-valley-cardiology",
    organizationDisplay: "Valley Cardiology",
    specialtyCode: "207RC0000X",
    specialtyDisplay: "Cardiovascular Disease",
  });
  practitionerRoles.set(roleCardio.id, roleCardio);
}

// Separate function to seed the demo referral — called from /api/seed but NOT from tests
// (tests create their own referrals with specific IDs for assertions).
export function seedDemoReferral(): void {
  const today = new Date().toISOString().split("T")[0];
  const sixtyDays = new Date(Date.now() + 60 * 24 * 60 * 60 * 1000).toISOString().split("T")[0];

  const sr = makeServiceRequest({
    id: "referral-001",
    patientId: "patient-001",
    requesterId: "dr-smith",
    requesterDisplay: "Dr. Robert Smith",
    codeText: "Cardiology consultation",
    reasonCode: "29857009",
    reasonDisplay: "Chest pain",
    authoredOn: new Date().toISOString(),
    occurrenceStart: today,
    occurrenceEnd: sixtyDays,
    notes: "Cardiology consultation for chest pain. Patient reports intermittent chest pain on exertion.",
    originMethod: "electronic",
    targetOrgNpi: "1538246790",
    targetOrgName: "Mercy General Hospital",
    targetPractitionerNpi: "9876543210",
    targetSpecialtyCode: "207RC0000X",
    targetSpecialtyDisplay: "Cardiovascular Disease",
  });
  serviceRequests.set(sr.id, sr);

  const task = makeTask({
    id: "task-001",
    serviceRequestId: "referral-001",
    patientId: "patient-001",
    requesterId: "dr-smith",
    requesterDisplay: "Dr. Robert Smith",
    ownerId: "mercy-hospital",
    ownerDisplay: "Mercy General Hospital",
    authoredOn: new Date().toISOString(),
    dueDate: sixtyDays,
  });
  tasks.set(task.id, task);
}
