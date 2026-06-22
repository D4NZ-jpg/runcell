import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Credentials } from 'runcell';

export function exampleModel(): string {
  return process.env['RUNCELL_EXAMPLE_MODEL'] ?? 'anthropic/claude-sonnet-4-5';
}

export function exampleCredentials(): Credentials {
  const value = process.env['RUNCELL_EXAMPLE_CREDENTIALS'] ?? 'local';
  if (value === 'local') {
    return 'local';
  }
  if (value === 'env') {
    return { type: 'env' };
  }
  if (value.startsWith('agentDir:')) {
    return { type: 'agentDir', path: value.slice('agentDir:'.length) };
  }
  throw new Error(
    'RUNCELL_EXAMPLE_CREDENTIALS must be local, env, or agentDir:/path.',
  );
}

export function runExample<T>(metaUrl: string, main: () => Promise<T>): void {
  if (process.argv[1] === undefined) {
    return;
  }
  if (path.resolve(process.argv[1]) !== fileURLToPath(metaUrl)) {
    return;
  }

  main()
    .then(result => {
      console.log(JSON.stringify(result, null, 2));
    })
    .catch((error: unknown) => {
      console.error(error);
      process.exitCode = 1;
    });
}
