# Pi extensions

runcell runs on the [Pi coding agent](https://pi.dev) engine. Pi has an
extension system — host-side plugins that can register custom model
providers, hook the agent lifecycle, transform requests, and add tools.
`pi.extensions` is runcell's escape hatch into that system.

::: warning Security
Extensions execute in your host Node process with full application
permissions — filesystem, network, environment variables, credentials. They
are **not** sandboxed. Importing an extension is the trust decision; treat it
like any other dependency that runs code.
:::

## Using a published extension

Extensions that export an SDK-compatible factory are ordinary npm packages.
For example, [`pi-claude-auth`](https://pi.dev/packages/pi-claude-auth)
authenticates Anthropic requests with your existing Claude Code credentials:

```bash
npm install pi-claude-auth
```

```ts
import { createAgent } from 'runcell';
import claudeAuth from 'pi-claude-auth';

const agent = createAgent({
  model: 'anthropic/claude-sonnet-4-5',
  credentials: 'local',
  pi: { extensions: [claudeAuth] },
});
```

runcell supports the **headless subset** of Pi's extension API. Not every
package on pi.dev will work: packages built for Pi's terminal UI (custom
widgets, dialogs, keyboard shortcuts, themes, `/commands`) have no UI to
attach to here, and packages that only declare extensions through a Pi
manifest may not export an importable factory at all.

## Writing an inline extension

`runcell/pi` exports the extension types and a `defineExtension` helper:

```ts
import { createAgent } from 'runcell';
import { defineExtension } from 'runcell/pi';
import { Type } from 'typebox';

const audit = defineExtension(pi => {
  pi.on('tool_call', async event => {
    console.log('tool:', event.toolName);
    // return { block: true, reason: '...' } to veto the call
  });

  pi.registerTool({
    name: 'record_finding',
    label: 'Record Finding',
    description: 'Record a single audit finding.',
    parameters: Type.Object({ finding: Type.String() }),
    execute: async (_id, params) => ({
      content: [{ type: 'text', text: `recorded: ${params.finding}` }],
      details: {},
    }),
  });
});

const agent = createAgent({
  model: 'openai/gpt-5.1',
  pi: { extensions: [audit] },
});
```

Tools registered by supplied extensions are activated automatically — the
import was the trust decision. For plain host functions you do not need an
extension at all; the top-level `tools` option is simpler and typed.

Registering a custom provider works the same way and completes before the
agent's `model` is resolved, so an extension can define the very provider the
agent is configured to use:

```ts
const corp = defineExtension(pi => {
  pi.registerProvider('corporate-ai', {
    baseUrl: 'https://ai.corp.example/v1',
    apiKey: '$CORPORATE_AI_KEY',
    api: 'openai-completions',
    models: [
      /* ... */
    ],
  });
});

createAgent({ model: 'corporate-ai/coder', pi: { extensions: [corp] } });
```

## Semantics

- **Order.** Factories load in array order, before the model is resolved.
  Later extensions may override providers registered by earlier ones,
  following Pi semantics.
- **Failures are fatal.** A factory that throws (sync or async) rejects the
  run with `ExtensionError` before any model request. Extensions that want to
  degrade gracefully should catch their own recoverable errors, as
  `pi-claude-auth` does.
- **Tool collisions.** An extension tool that shares a name with a runcell
  tool or a reserved sandbox tool (`read`, `write`, `edit`, `bash`, …)
  rejects the run with `ExtensionError`. Two extensions may shadow each
  other's tools (last wins, per Pi).
- **Factories must be idempotent.** Pi may re-run factories within one run
  (its reload semantics) and runcell re-runs them for every run and thread
  resume. Do not start background resources in the factory; use
  `session_start`/`session_shutdown` handlers.
- **Shutdown.** `session_shutdown` is emitted and awaited on every teardown
  path, including errors and aborts.
- **Headless environment.** `ctx.hasUI` is `false`. Dialogs, notifications,
  widgets, shortcuts, themes, and `/commands` are unavailable; registering
  them is a no-op. `session_start` may not fire in embedded mode — prefer
  `agent_start`.
- **Concurrency.** Concurrent runs sharing one agent each get their own
  extension runtime, but your factory's closure and module state are shared;
  keep them concurrency-safe.
- **Credentials.** Extensions may override the credentials runcell
  configured (that is how auth extensions work). Credential-writing
  extensions are designed around Pi's local agent dir, so they pair best
  with `credentials: 'local'` or `{ type: 'agentDir' }`.

## Versioning

Everything under `pi.extensions` and `runcell/pi` is engine-specific surface
that tracks Pi's own extension API and versioning, not runcell's core
stability promise.
