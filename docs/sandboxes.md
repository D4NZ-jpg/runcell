# Sandboxes

Every run executes inside a sandbox workspace. There are two ways to get one:

- **Ephemeral (default):** omit `sandbox`, or pass a mode option like
  `'virtual'`. runcell creates the sandbox for the run and destroys it after.
- **Caller-owned handle:** create a `Sandbox` and pass it to runs. It persists
  across runs, and the caller is responsible for destroying it.

```ts
import { createAgent, createVirtualSandbox } from 'runcell';

const agent = createAgent({ model: 'anthropic/claude-sonnet-4-5' });

// Ephemeral: fresh workspace, gone after the run.
await agent.run({ prompt: 'One-off task.' });

// Caller-owned: one workspace across many runs.
const sandbox = await createVirtualSandbox();
await agent.run({ prompt: 'Scaffold a TypeScript project.', sandbox });
await agent.run({ prompt: 'Add tests and make them pass.', sandbox }); // same files
await sandbox.destroy(); // Caller-owned handles require explicit cleanup.
```

## The Sandbox handle

A handle is a live resource you can use without an agent:

```ts
const sandbox = await createVirtualSandbox();

await sandbox.writeFile('src/index.ts', 'export const x = 1;\n');
const result = await sandbox.exec('ls -la src');
console.log(result.exitCode, result.stdout);

const bytes = await sandbox.readFile('data.bin'); // Uint8Array | null
const text = await sandbox.readTextFile('src/index.ts'); // string | null
await sandbox.remove('scratch'); // file or directory, no-op if missing
```

Paths are relative to the sandbox workspace, the same directory the agent
works in, so anything the agent writes is immediately visible to your code and
vice versa.

## Snapshot and restore

`snapshot()` captures the workspace **files** as a portable, JSON-serializable
value. `restoreSandbox()` rehydrates one into a fresh sandbox:

```ts
const snapshot = await sandbox.snapshot(); // { version: 1, files: [...] }
await db.save(id, snapshot); // Store the JSON snapshot.
await sandbox.destroy();

// later, anywhere
const revived = await restoreSandbox(await db.load(id));
```

Snapshots capture files, **not** running processes: a dev server that was
running will not be running after restore. Internal engine state is excluded
automatically.

## Sharing and concurrency

A handle is just a value. Share it between agents or runs however you like:

```ts
await Promise.all([
  reviewer.run({ prompt: 'Review the code.', sandbox, thread: reviewThread }),
  fixer.run({ prompt: 'Fix the lint errors.', sandbox, thread: fixThread }),
]);
```

runcell keeps its bookkeeping consistent under concurrent use, but does not
coordinate application-level access. Two agents may write the same file, just
as two processes may on a real machine. If you want mutual
exclusion, one opt-in primitive is provided:

```ts
await sandbox.lock('package.json', async () => {
  // exclusive among lock('package.json', ...) callers on this handle
});
```

## Capabilities

Backends differ. The handle tells you what it supports:

```ts
sandbox.capabilities;
// { ports: boolean, nativeSnapshot: boolean, resume: boolean }

if (sandbox.capabilities.ports) {
  const url = await sandbox.exposeUrl?.(3000);
}
```

The bundled virtual sandbox reports `{ ports: false, nativeSnapshot: false,
resume: false }`. Portable file snapshots work everywhere regardless.

## Sandbox modes (ephemeral)

When you pass a mode option instead of a handle, runcell creates and owns the
sandbox for that run:

### Virtual (default)

An isolated in-memory workspace. Zero config, bundled with runcell:

```ts
await agent.run({ prompt, sandbox: 'virtual' }); // same as omitting it
```

### Host

Maps the workspace onto a real directory. **Only** for processes that are
already externally isolated: a CI job, a container, an ephemeral VM. runcell
does not add an OS security boundary in this mode, which is why the option
forces you to say so:

```ts
await agent.run({
  prompt,
  sandbox: {
    type: 'host',
    rootDir: process.env.GITHUB_WORKSPACE ?? process.cwd(),
    isolation: 'external',
  },
});
```

Agent-executed commands do **not** inherit the host environment. They only
see baseline system vars (`PATH`, `HOME`, `USER`, `LOGNAME`, `SHELL`,
`TERM`, `TMPDIR`, `TEMP`, `TMP`, `LANG`, `LC_*`, `TZ`), so the agent cannot
read secrets with `echo $ANTHROPIC_API_KEY`. Model credentials are captured
from your process before the sandbox starts and are unaffected.

This filter prevents direct environment inheritance but is not an OS security
boundary. Commands still run as your host user, so this mode requires external
isolation. The baseline list is POSIX-oriented; if
commands need proxies or similar host config (`HTTPS_PROXY`, …), opt them
in via `env`.

Other environment variables are opt-in. Add the variables that commands need
to `env`:

```ts
sandbox: {
  type: 'host',
  rootDir: process.env.GITHUB_WORKSPACE!,
  isolation: 'external',
  env: {
    CI: process.env.CI,
    NODE_ENV: 'test',
    NPM_TOKEN: process.env.NPM_TOKEN, // Explicitly passed to sandbox commands.
  },
}
```

Entries with `undefined` values are dropped, so `VAR: process.env.VAR`
pass-throughs are safe when the var is not set on the host.

If the process is fully trusted and the agent needs the complete host
environment, set `inheritHostEnv` explicitly:

```ts
sandbox: { type: 'host', rootDir, isolation: 'external', inheritHostEnv: true }
```

### Vercel Sandbox

Cloud isolation via [Vercel Sandbox](https://vercel.com/docs/vercel-sandbox).
Requires Node.js 22+ and the optional peer dependency:

```bash
npm install @ai-sdk/sandbox-vercel
```

```ts
await agent.run({
  prompt,
  sandbox: { type: 'vercel', runtime: 'node24', ports: [3000] },
});
```

### Custom

Bring your own provider (Docker, E2B, Modal, a pre-created cloud sandbox, …):

```ts
await agent.run({ prompt, sandbox: { type: 'custom', provider } });
```

`provider` implements the sandbox provider interface; see
[API reference](./api.md#sandboxprovider).

## Using runcell with Next.js and other bundlers

runcell loads optional providers (like `@ai-sdk/sandbox-vercel`) at runtime,
only when the matching sandbox type is requested. The import is deliberately
opaque to static analysis so bundlers don't try to resolve packages you never
installed.

Even so, runcell runs processes, reads credentials, and loads Pi resources —
it belongs on the server, outside the bundle. In Next.js, mark it external:

```ts
// next.config.ts
const nextConfig = {
  serverExternalPackages: ['runcell'],
};
```

This keeps Node's module resolution in charge (optional peers stay optional)
and avoids bundling the runtime into route chunks.

## Ownership rules, in one table

| What you pass to `run`              | Who creates it | Who destroys it | Files persist across runs |
| ----------------------------------- | -------------- | --------------- | ------------------------- |
| nothing / `'virtual'` / mode option | runcell        | runcell         | no                        |
| a `Sandbox` handle                  | you            | **you**         | yes                       |
