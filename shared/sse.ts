import { sseClients, type SSEClient } from "../store";

let clientIdCounter = 0;

export function createSSEStream(channel: "patient" | "physician", patientId?: string): Response {
  const stream = new ReadableStream({
    start(controller) {
      const client: SSEClient = {
        id: `sse-${++clientIdCounter}`,
        controller,
        channel,
        patientId,
      };
      sseClients.push(client);

      // Send initial connection event
      const data = JSON.stringify({ type: "connected", channel });
      controller.enqueue(new TextEncoder().encode(`data: ${data}\n\n`));
    },
    cancel() {
      // Remove client on disconnect
      const idx = sseClients.findIndex((c) => c.id === `sse-${clientIdCounter}`);
      if (idx !== -1) sseClients.splice(idx, 1);
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}

export function broadcast(
  channel: "patient" | "physician",
  event: Record<string, unknown>,
  patientId?: string,
): void {
  const data = JSON.stringify(event);
  const message = `data: ${data}\n\n`;
  const encoded = new TextEncoder().encode(message);

  for (let i = sseClients.length - 1; i >= 0; i--) {
    const client = sseClients[i];
    if (client.channel !== channel) continue;
    if (patientId && client.patientId && client.patientId !== patientId) continue;

    try {
      client.controller.enqueue(encoded);
    } catch {
      // Client disconnected
      sseClients.splice(i, 1);
    }
  }
}
