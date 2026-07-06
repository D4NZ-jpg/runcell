# Sandboxes

Every run executes inside a sandbox workspace. There are two ways to get one:

- **Ephemeral (default):** omit `sandbox`, or pass a mode option like
  `'virtual'`. runcell creates the sandbox for the run and destroys it after.
- **Caller-owned handle:** create a `Sandbox` yourself and pass it to runs.
  It persists across runs, and runcell never destroys it.

```ts
import { createAgent, createVirtualSandbox } from 'runcell';

const agent = createAgent({ model: 'anthropic/claude-sonnet-4-5' });

// Ephemeral: fresh workspace, gone after the run.
await agent.run({ prompt: 'One-off task.' });

// Caller-owned: one workspace across many runs.
const sandbox = await createVirtualSandbox();
await agent.run({ prompt: 'Scaffold a TypeScript project.', sandbox });
await agent.run({ prompt: 'Add tests and make them pass.', sandbox }); // same files
await sandbox.destroy(); // your call, always
```

## The Sandbox handle

A handle is a live resource you can drive **with no agent at all**:

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
await db.save(id, snapshot); // plain JSON — store anywhere
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

runcell guarantees its own bookkeeping stays consistent under concurrent use,
but it does not referee your logic: two agents writing the same file is
allowed, exactly like two processes on a real machine. If you want mutual
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

## Ownership rules, in one table

| What you pass to `run`              | Who creates it | Who destroys it | Files persist across runs |
| ----------------------------------- | -------------- | --------------- | ------------------------- |
| nothing / `'virtual'` / mode option | runcell        | runcell         | no                        |
| a `Sandbox` handle                  | you            | **you**         | yes                       |
