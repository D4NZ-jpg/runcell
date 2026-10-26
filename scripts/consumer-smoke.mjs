#!/usr/bin/env node
/**
 * Packed-consumer regression check.
 *
 * Packs `runcell` exactly as it would publish, then installs the tarball into
 * throwaway apps and verifies a real consumer can use it:
 *   - types resolve and both run overloads + stream + sandbox + thread compile,
 *   - against Zod 4 AND Zod 3 (the public schema surface is Standard Schema, so
 *     it must not lock consumers to one Zod major),
 *   - the optional `@ai-sdk/sandbox-vercel` peer is NOT pulled in,
 *   - the runtime works with no model: create sandbox, exec, snapshot, restore.
 *
 * Run: `npm run test:consumer`. Fails loud and non-zero on any regression.
 */
import { execSync } from 'node:child_process';
import { createRequire } from 'node:module';
import {
  mkdtempSync,
  writeFileSync,
  mkdirSync,
  readdirSync,
  readFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);
const run = (cmd, cwd) =>
  execSync(cmd, { cwd, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' });

function log(step) {
  process.stdout.write(`\n▶ ${step}\n`);
}

const CONSUMER_TS = `
import {
  createAgent,
  createVirtualSandbox,
  createThread,
  getRunUsage,
  getRunExecution,
  type RunExecution,
  type RunContext,
  type AttemptExecution,
  threadFromJSON,
  type Sandbox,
  type Thread,
  type StreamRun,
  type UIChatMessage,
  type UIMessageChunk,
} from 'runcell';
import { z } from 'zod';

const agent = createAgent({ model: 'm', credentials: 'local', events: {
  onRunStart: event => { event.runId satisfies string; event.context satisfies RunContext | undefined; },
  onAttemptStart: event => { event.attemptId satisfies string; },
  onAttemptEnd: event => { event satisfies AttemptExecution; },
  onRunEnd: event => { event satisfies RunExecution; },
} });

// Named routes preserve key inference through the published declarations.
const routed = createAgent({
  credentials: { subscription: { type: 'env' }, aws: { type: 'env' } },
  models: [
    { model: 'anthropic/m', credentials: 'subscription' },
    { model: 'amazon-bedrock/m', credentials: 'aws' },
  ],
  events: { onFallback: ({ from, to }) => {
    from.model satisfies string;
    to.credentials satisfies string;
  } },
});
routed.run({ prompt: 'hi' });
// @ts-expect-error - model references must exist in the credential map.
createAgent({ credentials: { subscription: { type: 'env' } }, models: [{ model: 'm', credentials: 'missing' }] });

// Structured run: data is typed and validated.
const structured = await agent.run({
  prompt: 'go',
  schema: z.object({ ok: z.boolean() }),
});
structured.data.ok satisfies boolean;

// Plain run: data is undefined, text is the output.
const context = { requestId: 'request-1', operation: 'summarize', sampled: true } satisfies RunContext;
const plain = await agent.run({ prompt: 'hi', context });
plain.execution?.context satisfies RunContext | undefined;
// @ts-expect-error - application context must contain scalar values, not nested objects.
agent.run({ prompt: 'hi', context: { request: { id: 'request-1' } } });
plain.data satisfies undefined;
plain.text satisfies string;
plain.finishReason satisfies string;
plain.execution?.runId satisfies string | undefined;
plain.execution?.usage.status satisfies 'complete' | 'partial' | 'unknown' | undefined;
getRunExecution(new Error('x')) satisfies RunExecution | undefined;

// Streaming: text deltas plus a final result.
const stream: StreamRun<undefined> = agent.stream({ prompt: 'hi' });
for await (const delta of stream.textStream) {
  delta satisfies string;
}
(await stream.result).finishReason satisfies string;

// UI message stream surface: messages input, chunk iterable, SSE response.
const history: UIChatMessage[] = [
  { role: 'user', parts: [{ type: 'text', text: 'hi' }] },
];
const uiRun = agent.stream({ messages: history });
for await (const chunk of uiRun.toUIMessageStream({ sendReasoning: false })) {
  chunk satisfies UIMessageChunk;
}
const uiResponse: Response = agent
  .stream({ messages: history })
  .toUIMessageStreamResponse({
    sendTools: { secret: false, weather: 'names-only' },
    onError: () => 'masked',
    status: 200,
  });
void uiResponse;

// Chat attachments: host code sees the same workspace paths as the run.
import { uiChatMessageAttachments, type UIChatAttachment } from 'runcell';

const attachments: UIChatAttachment[] = uiChatMessageAttachments(history, {
  maxAttachmentBytes: 1024,
});
attachments[0]?.path satisfies string | undefined;
attachments[0]?.filename satisfies string | undefined;
attachments[0]?.bytes satisfies Uint8Array | undefined;

// Failure usage discovery is part of the public surface.
getRunUsage(new Error('x'))?.costMeasured satisfies boolean | undefined;

// Sandboxes and threads are values you hold and persist.
const sandbox: Sandbox = await createVirtualSandbox();
const thread: Thread = createThread();
await agent.run({ prompt: 'go', schema: z.object({ ok: z.boolean() }), sandbox, thread });
const revived: Thread = threadFromJSON(thread.toJSON());
void revived;

// The Vercel sandbox option must typecheck even without the optional peer.
await agent.run({ prompt: 'go', sandbox: { type: 'vercel', runtime: 'node24' } });

// Multi-part tool results: real types must flow through the packed .d.ts.
import { toolContent, isToolContent, type ToolContent } from 'runcell';

const content: ToolContent = toolContent([
  { type: 'text', text: 'Rendered page 1:' },
  { type: 'image', data: new Uint8Array([1, 2, 3]), mediaType: 'image/png' },
]);
isToolContent(content) satisfies boolean;
content.content[0].type satisfies 'text' | 'image';

// @ts-expect-error - 'audio' is not a valid part type; if the API ever
// degrades to \`any\` this suppression becomes unused and tsc reports TS2578.
toolContent([{ type: 'audio' }]);
`;

const TSCONFIG = JSON.stringify(
  {
    compilerOptions: {
      target: 'ES2022',
      module: 'NodeNext',
      moduleResolution: 'NodeNext',
      strict: true,
      skipLibCheck: true,
      noEmit: true,
    },
    files: ['consumer.ts'],
  },
  null,
  2,
);

const RUNTIME_MJS = `
import {
  createAgent,
  createVirtualSandbox,
  getRunExecution,
  getRunUsage,
  restoreSandbox,
  uiChatMessageAttachments,
} from 'runcell';
import assert from 'node:assert';

const photo = (text) => ({
  type: 'file',
  url: 'data:image/jpeg;base64,' + Buffer.from(text).toString('base64'),
  mediaType: 'image/jpeg',
  filename: 'image.jpg',
});
assert.deepEqual(
  uiChatMessageAttachments([
    { role: 'user', parts: [photo('a')] },
    { role: 'user', parts: [photo('b')] },
  ]).map(a => a.path),
  ['attachments/image.jpg', 'attachments/image-2.jpg'],
);

const sb = await createVirtualSandbox();
await sb.writeFile('src/app.ts', 'export const n = 41;\\n');
const exec = await sb.exec('echo $((41 + 1))');
assert.equal(exec.exitCode, 0);
assert.equal(exec.stdout.trim(), '42');
assert.deepEqual(sb.capabilities, { ports: false, nativeSnapshot: false, resume: false });

const snap = await sb.snapshot();
assert.ok(snap.files.some(f => f.path === 'src/app.ts'));
await sb.destroy();

const sb2 = await restoreSandbox(snap);
assert.equal(await sb2.readTextFile('src/app.ts'), 'export const n = 41;\\n');
await sb2.destroy();

// An unknown model fails locally, before a provider request or network call.
const reports = [];
const agent = createAgent({
  model: '__runcell_consumer_nonexistent_model__',
  credentials: { type: 'apiKeys', keys: { anthropic: 'not-a-real-key' } },
  events: { onRunEnd: report => reports.push(report) },
});
const context = { requestId: 'server-request-123', operation: 'consumer-smoke' };
const failure = await agent.run({ prompt: 'private prompt', context }).catch(error => error);
const execution = getRunExecution(failure);
assert.ok(execution);
assert.equal(execution.outcome, 'failed');
assert.equal(execution.attempts.length, 1);
assert.deepEqual(execution.context, context);
assert.notEqual(execution.context, context);
assert.equal(execution.attempts[0].context, execution.context);
assert.ok(Object.isFrozen(execution.context));
assert.equal(reports[0], execution);
assert.equal(getRunUsage(failure).totalTokens, 0);
assert.ok(!JSON.stringify(execution).includes('not-a-real-key'));
assert.ok(!JSON.stringify(execution).includes('private prompt'));

console.log('runtime OK');
`;

function main() {
  // Full build: runcell bundles the internal adapter, whose dist must exist.
  log('Building');
  run('npm run build', repoRoot);

  const workRoot = mkdtempSync(path.join(tmpdir(), 'runcell-consumer-'));
  const pkgDir = path.join(workRoot, 'pkg');
  mkdirSync(pkgDir, { recursive: true });

  log('Packing runcell');
  run(`npm pack -w runcell --pack-destination "${pkgDir}"`, repoRoot);
  const tarball = path.join(
    pkgDir,
    readdirSync(pkgDir).find(f => f.endsWith('.tgz')),
  );

  const zodSpecs = ['zod@^4', 'zod@3.25.76'];
  for (const zodSpec of zodSpecs) {
    log(`Consumer install with ${zodSpec}`);
    const app = path.join(
      workRoot,
      `app-${zodSpec.replace(/[^a-z0-9]/gi, '-')}`,
    );
    mkdirSync(app, { recursive: true });
    run('npm init -y', app);
    run('npm pkg set type=module', app);
    run(`npm install "${tarball}" typescript ${zodSpec}`, app);

    const require = createRequire(path.join(app, 'noop.js'));
    const installedZod = require('zod/package.json').version;
    process.stdout.write(`  installed zod ${installedZod}\n`);

    // The optional peer must not be present.
    let vercelPresent = true;
    try {
      require.resolve('@ai-sdk/sandbox-vercel');
    } catch {
      vercelPresent = false;
    }
    if (vercelPresent) {
      throw new Error(
        '@ai-sdk/sandbox-vercel was installed but must be optional',
      );
    }
    process.stdout.write('  optional vercel peer absent ✓\n');

    // The packed declarations must never reference private workspace
    // specifiers: with skipLibCheck the imports would silently degrade to
    // `any`, so check the installed .d.ts directly.
    const distDir = path.join(app, 'node_modules', 'runcell', 'dist');
    for (const file of readdirSync(distDir).filter(f => f.endsWith('.d.ts'))) {
      const dts = readFileSync(path.join(distDir, file), 'utf8');
      if (dts.includes("'@local/") || dts.includes('"@local/')) {
        throw new Error(
          `packed ${file} references a private @local/ workspace package`,
        );
      }
    }
    process.stdout.write('  packed .d.ts free of @local/ specifiers ✓\n');

    // Optional providers must be loaded via a runtime-computed specifier:
    // a statically-analyzable `import('<literal>')` makes bundlers
    // (Turbopack, webpack) resolve the optional package at build time and
    // hard-fail for consumers who don't install it.
    for (const file of readdirSync(distDir).filter(f => f.endsWith('.js'))) {
      const js = readFileSync(path.join(distDir, file), 'utf8');
      if (/import\(\s*["']@ai-sdk\/sandbox-vercel["']/.test(js)) {
        throw new Error(
          `packed ${file} statically imports the optional vercel sandbox`,
        );
      }
    }
    process.stdout.write('  optional providers imported opaquely ✓\n');

    writeFileSync(path.join(app, 'tsconfig.json'), TSCONFIG);
    writeFileSync(path.join(app, 'consumer.ts'), CONSUMER_TS);
    run('./node_modules/.bin/tsc -p tsconfig.json', app);
    process.stdout.write('  typecheck ✓\n');

    writeFileSync(path.join(app, 'runtime.mjs'), RUNTIME_MJS);
    const out = run('node runtime.mjs', app);
    if (!out.includes('runtime OK')) {
      throw new Error(`runtime smoke failed:\n${out}`);
    }
    process.stdout.write('  runtime ✓\n');
  }

  process.stdout.write('\n✅ consumer smoke passed for all Zod versions\n');
}

try {
  main();
} catch (error) {
  process.stderr.write(`\n❌ consumer smoke failed\n`);
  if (error && typeof error === 'object' && 'stdout' in error) {
    process.stderr.write(String(error.stdout ?? ''));
    process.stderr.write(String(error.stderr ?? ''));
  }
  process.stderr.write(
    `${error instanceof Error ? error.stack : String(error)}\n`,
  );
  process.exit(1);
}
