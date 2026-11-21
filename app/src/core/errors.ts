// Formats an unknown caught value as a human-readable error message.

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
