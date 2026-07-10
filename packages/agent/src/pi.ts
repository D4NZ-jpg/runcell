/**
 * Pi engine escape hatch — `runcell/pi`.
 *
 * Everything exported here is Pi-specific surface that tracks Pi's own
 * versioning rather than runcell's core stability promise. Extensions run in
 * the host Node process with full application permissions; importing one is
 * the trust decision.
 */
import type { ExtensionFactory } from '@local/harness-pi-raw';

export type { ExtensionAPI, ExtensionFactory } from '@local/harness-pi-raw';

/**
 * Identity helper that types an inline Pi extension factory. Purely for
 * ergonomics and type inference:
 *
 * ```ts
 * const audit = defineExtension(pi => {
 *   pi.on('tool_call', event => log(event.toolName));
 * });
 *
 * createAgent({ model, pi: { extensions: [audit] } });
 * ```
 */
export function defineExtension(factory: ExtensionFactory): ExtensionFactory {
  return factory;
}
