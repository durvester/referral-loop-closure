import { serviceRequests, tasks, routedEvents, encounters, patients, practitioners, organizations, getOpenReferrals } from "../store";
import { createSSEStream } from "../shared/sse";
import { checkOverdueTasks } from "../portal/routing";
import { makeServiceRequest, makeTask } from "../fhir/resources";
import type { ServiceRequest, Task } from "../fhir/types";

export async function handlePhysicianRequest(req: Request, path: string): Promise<Response> {
  const url = new URL(req.url);
  const method = req.method;

  // SSE: GET /physician/events
  if (path === "/events" && method === "GET") {
    return createSSEStream("physician");
  }

  // Dashboard data: GET /physician/dashboard
  if (path === "/dashboard" && method === "GET") {
    const allReferrals: { serviceRequest: ServiceRequest; task: Task; patient?: any }[] = [];
    for (const [, task] of tasks) {
      const sr = serviceRequests.get(task.focus?.reference?.replace("ServiceRequest/", "") || "");
      if (sr) {
        const patientId = sr.subject?.reference?.replace("Patient/", "");
        const patient = patientId ? patients.get(patientId) : undefined;
        allReferrals.push({ serviceRequest: sr, task, patient });
      }
    }
    return Response.json({
      referrals: allReferrals,
      routedEvents: routedEvents,
      overdue: checkOverdueTasks(),
    });
  }

  // Get single referral: GET /physician/referral/:id
  if (path.startsWith("/referral/") && method === "GET") {
    const id = path.replace("/referral/", "");
    const sr = serviceRequests.get(id);
    if (!sr) return Response.json({ error: "Referral not found" }, { status: 404 });
    // Find task
    let matchedTask: Task | undefined;
    for (const [, task] of tasks) {
      if (task.focus?.reference === `ServiceRequest/${id}`) {
        matchedTask = task;
        break;
      }
    }
    // Find routed events for this referral
    const events = routedEvents.filter(e => e.taskId === matchedTask?.id);
    return Response.json({ serviceRequest: sr, task: matchedTask, events });
  }

  // Create referral: POST /physician/referral
  if (path === "/referral" && method === "POST") {
    const body = await req.json() as any;
    const id = `referral-${Date.now()}`;
    const taskId = `task-${Date.now()}`;

    const sr = makeServiceRequest({
      id,
      patientId: body.patientId || "patient-001",
      requesterId: body.requesterId || "dr-smith",
      requesterDisplay: body.requesterDisplay || "Dr. Robert Smith",
      performerRoleId: body.performerRoleId,
      performerDisplay: body.performerDisplay,
      codeText: body.codeText || "Consultation",
      reasonCode: body.reasonCode || "unknown",
      reasonDisplay: body.reasonDisplay || "Unknown",
      authoredOn: new Date().toISOString(),
      occurrenceStart: body.occurrenceStart || new Date().toISOString().split("T")[0],
      occurrenceEnd: body.occurrenceEnd || new Date(Date.now() + 60*24*60*60*1000).toISOString().split("T")[0],
      notes: body.notes,
      originMethod: body.originMethod || "electronic",
      targetOrgNpi: body.targetOrgNpi,
      targetOrgName: body.targetOrgName,
      targetPractitionerNpi: body.targetPractitionerNpi,
      targetSpecialtyCode: body.targetSpecialtyCode,
      targetSpecialtyDisplay: body.targetSpecialtyDisplay,
    });
    serviceRequests.set(sr.id, sr);

    const task = makeTask({
      id: taskId,
      serviceRequestId: id,
      patientId: body.patientId || "patient-001",
      requesterId: body.requesterId || "dr-smith",
      requesterDisplay: body.requesterDisplay || "Dr. Robert Smith",
      ownerId: body.targetOrgId || "unknown",
      ownerDisplay: body.targetOrgName || "Unknown",
      authoredOn: new Date().toISOString(),
      dueDate: body.occurrenceEnd || new Date(Date.now() + 60*24*60*60*1000).toISOString().split("T")[0],
    });
    tasks.set(task.id, task);

    return Response.json({ ok: true, serviceRequest: sr, task }, { status: 201 });
  }

  return Response.json({ error: "Not found" }, { status: 404 });
}
