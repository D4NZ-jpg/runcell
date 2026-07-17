# Pi extensions

runcell runs on the [Pi coding agent](https://pi.dev) engine. Pi extensions are
host-side plugins that can register custom model providers, hook the agent
lifecycle, transform requests, or add tools. The `pi` option exposes
Pi-specific configuration, including thinking effort and extensions.

## Thinking effort

Set `pi.thinkingLevel` when creating an agent to choose its default reasoning
or thinking effort. Override it for one run with the run-level `pi` option:

```ts
import { createAgent } from 'runcell';

const agent = createAgent({
  model: 'anthropic/claude-sonnet-4-5',
  pi: { thinkingLevel: 'high' },
});

const result = await agent.run({
  prompt: 'Solve this difficult problem.',
  pi: { thinkingLevel: 'xhigh' }, // this run only
});
```

The available levels are `'off'`, `'minimal'`, `'low'`, `'medium'`, `'high'`,
and `'xhigh'` (`PiThinkingLevel`, exported from `runcell`). Pi maps the selected
level to the provider's native control, such as Anthropic's thinking budget or
OpenAI's `reasoning_effort`, and clamps it to what the model supports. If the
option is omitted, Pi uses its default for the selected model.

Only `thinkingLevel` is accepted in a run-level `pi` object; extensions remain
agent-level. Invalid levels throw `InvalidOptionError` eagerly: during
`createAgent()` for the agent default, or during `run()` for an override.

::: warning Security
Extensions execute in your host Node process with access to the filesystem,
network, environment variables, and credentials. They are **not** sandboxed. Importing an extension is the trust decision; treat it
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

Tools registered by supplied extensions are activated automatically.
Importing the extension is the trust decision. For plain host functions you do not need an
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

- Factories load in array order before the model is resolved. Later extensions
  may override providers registered by earlier ones, following Pi semantics.
- If a factory throws synchronously or asynchronously, the run rejects with
  `ExtensionError` before any model request. Extensions should catch their own
  recoverable errors if needed, as `pi-claude-auth` does.
- If an extension tool shares a name with a Runcell tool or reserved sandbox
  tool (`read`, `write`, `edit`, `bash`, …), the run rejects with
  `ExtensionError`. Two extensions may shadow each other's tools; the last one
  wins, following Pi semantics.
- Factories must be idempotent. Pi may rerun them under its reload semantics,
  and Runcell runs them for each run and thread resume. Use `session_start` and
  `session_shutdown` handlers instead of starting background resources in the
  factory.
- `session_shutdown` is emitted and awaited during teardown, including errors
  and aborts.
- In the headless environment, `ctx.hasUI` is `false`. Dialogs, notifications,
  widgets, shortcuts, themes, and `/commands` are unavailable. Because
  `session_start` may not fire in embedded mode, prefer `agent_start`.
- Concurrent runs sharing an agent receive separate extension runtimes, but
  the factory closure and module state remain shared. Keep them safe for
  concurrent use.
- Extensions may override credentials configured by Runcell. Credential-writing
  extensions use Pi's local agent directory, so they work best with
  `credentials: 'local'` or `{ type: 'agentDir' }`.

## Versioning

The `pi` options and `runcell/pi` APIs track Pi's API and versioning. They are
outside Runcell's core stability guarantee.
