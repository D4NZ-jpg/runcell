import { createPi } from './pi-harness';

/**
 * Default `pi` harness instance with no overrides — suitable for the common
 * case where Pi's defaults are fine. Equivalent to `createPi()`.
 */
export const pi = createPi();

export { createPi, HARNESS_ID } from './pi-harness';
export type { PiHarnessSettings } from './pi-harness';
export type { PiAuthOptions } from './pi-auth';
export type { PiResourceLoaderOptions, PiSessionSettings } from './pi-session';
