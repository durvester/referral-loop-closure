// Mock JWT: base64url encode header + payload, mock signature
export function createMockJwt(payload: Record<string, unknown>): string {
  const header = { alg: "RS384", typ: "JWT" };
  const encHeader = btoa(JSON.stringify(header)).replace(/=/g, "");
  const encPayload = btoa(JSON.stringify(payload)).replace(/=/g, "");
  return `${encHeader}.${encPayload}.mock-signature`;
}

export function decodeMockJwt(jwt: string): Record<string, unknown> {
  const parts = jwt.split(".");
  return JSON.parse(atob(parts[1]));
}

export interface PatientDemographics {
  name: string; // "Alice M Rodriguez"
  birthDate: string; // "1987-04-12"
}

// Create a permission ticket JWT with patient demographics
export function createPermissionTicket(
  patient: PatientDemographics,
  clientId: string,
  scopes: string[] = ["patient/Encounter.rs"],
): string {
  // Parse name into FHIR HumanName format
  const nameParts = patient.name.split(" ");
  const family = nameParts.pop()!;
  const given = nameParts;

  const payload = {
    iss: "https://identity-provider.example.org",
    sub: clientId,
    aud: "https://cms-network.example.org",
    ticket_context: {
      subject: {
        type: "match",
        traits: {
          resourceType: "Patient",
          name: [{ family, given }],
          birthDate: patient.birthDate,
        },
      },
      capability: {
        scopes,
      },
    },
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 3600,
  };

  return createMockJwt(payload);
}

// Create client assertion embedding permission ticket(s)
export function createClientAssertion(
  clientId: string,
  audience: string,
  permissionTicket: string,
): string {
  const payload = {
    iss: clientId,
    sub: clientId,
    aud: audience,
    jti: `assertion-${Date.now()}`,
    permission_tickets: [permissionTicket],
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 300,
  };

  return createMockJwt(payload);
}
