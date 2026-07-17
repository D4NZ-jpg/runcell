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
  threadFromJSON,
  type Sandbox,
  type Thread,
  type StreamRun,
} from 'runcell';
import { z } from 'zod';

const agent = createAgent({ model: 'm', credentials: 'local' });

// Structured run: data is typed and validated.
const structured = await agent.run({
  prompt: 'go',
  schema: z.object({ ok: z.boolean() }),
});
structured.data.ok satisfies boolean;

// Plain run: data is undefined, text is the output.
const plain = await agent.run({ prompt: 'hi' });
plain.data satisfies undefined;
plain.text satisfies string;
plain.finishReason satisfies string;

// Streaming: text deltas plus a final result.
const stream: StreamRun<undefined> = agent.stream({ prompt: 'hi' });
for await (const delta of stream.textStream) {
  delta satisfies string;
}
(await stream.result).finishReason satisfies string;

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
import { createVirtualSandbox, restoreSandbox } from 'runcell';
import assert from 'node:assert';

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
