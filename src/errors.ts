// Only these locally authored messages are safe to display in startup diagnostics.
export class SetupError extends Error {
  override name = 'SetupError';
}
