/** Context passed to handlers — provides overrides for platform-specific operations. */
export interface HandlerContext {
  /** Override fetch for inter-service calls (used by SW to route internally). */
  fetch?: typeof globalThis.fetch;
}
