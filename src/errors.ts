// Only these locally authored messages are safe to display in diagnostics and replies.
export class SetupError extends Error {
  override name = 'SetupError';
}
