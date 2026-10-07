import { defineConfig } from 'tsup';

export default defineConfig({
  entry: { index: 'src/index.ts' },
  format: ['esm'],
  target: 'es2022',
  // tsup 8.5 hardcodes `baseUrl: "."` in its declaration build, which
  // TypeScript 6 deprecates. Scoped here so typecheck still reports other
  // deprecations. Remove when tsup stops setting baseUrl.
  dts: { compilerOptions: { ignoreDeprecations: '6.0' } },
  sourcemap: true,
});
