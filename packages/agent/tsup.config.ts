import { defineConfig } from 'tsup';

export default defineConfig({
  entry: { index: 'src/index.ts' },
  format: ['esm'],
  target: 'es2022',
  dts: true,
  sourcemap: true,
  clean: false,
  // Workspace + peer-ish deps are resolved by the consumer at runtime.
  external: [
    '@ai-sdk/harness',
    '@ai-sdk/provider-utils',
    '@ai-sdk/sandbox-just-bash',
    '@earendil-works/pi-coding-agent',
    '@local/harness-pi-raw',
    'zod',
  ],
});
