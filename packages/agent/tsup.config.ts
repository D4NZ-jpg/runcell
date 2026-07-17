import { defineConfig } from 'tsup';

export default defineConfig({
  entry: { index: 'src/index.ts', pi: 'src/pi.ts' },
  format: ['esm'],
  target: 'es2022',
  // Inline declarations from the private workspace package so the published
  // .d.ts never references the unpublished `@local/harness-pi-raw` specifier.
  dts: { resolve: ['@local/harness-pi-raw'] },
  sourcemap: false,
  clean: false,
  // Workspace + peer-ish deps are resolved by the consumer at runtime.
  external: [
    '@ai-sdk/harness',
    '@ai-sdk/provider-utils',
    '@ai-sdk/sandbox-just-bash',
    '@ai-sdk/sandbox-vercel',
    '@earendil-works/pi-coding-agent',
    'zod',
  ],
});
