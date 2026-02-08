export const config = {
  port: 4000,
  broker: {
    baseUrl: "http://localhost:3000",
    brokerPath: "/broker",
    ehrPath: "/mercy-ehr",
    clientPath: "/client",
  },
  // Our app's base URL (used for webhook endpoint)
  selfUrl: "http://localhost:4000",
  // Client ID for SMART auth
  clientId: "referral-loop-closure-app",
} as const;

// Helper to build broker service URLs
export function brokerUrl(path: string): string {
  return `${config.broker.baseUrl}${config.broker.brokerPath}${path}`;
}

export function ehrUrl(path: string): string {
  return `${config.broker.baseUrl}${config.broker.ehrPath}${path}`;
}

export function selfUrl(path: string): string {
  return `${config.selfUrl}${path}`;
}
