// Only these locally authored messages are safe to include in operator diagnostics.
export class SetupError extends Error {
  override name = 'SetupError';
}
