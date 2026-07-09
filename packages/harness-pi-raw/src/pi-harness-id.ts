/**
 * Harness identifier. The framework composes each session's working directory
 * as `<defaultWorkingDirectory>/<harnessId>-<sessionId>`, so consumers that
 * need to predict that path share this constant.
 *
 * Lives in its own leaf module so both `pi-harness.ts` and `pi-session.ts`
 * can import it without an import cycle (`pi-harness.ts` already imports
 * `createPiSession` from `pi-session.ts`).
 */
export const HARNESS_ID = 'pi';
