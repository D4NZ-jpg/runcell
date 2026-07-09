import { createJustBashSandbox } from '@ai-sdk/sandbox-just-bash';
import { shellQuote } from './shell.js';
import type {
  HarnessV1NetworkSandboxSession,
  HarnessV1SandboxProvider,
} from '@ai-sdk/harness';
import type {
  Experimental_SandboxProcess,
  Experimental_SandboxSession,
} from '@ai-sdk/provider-utils';
import { spawn as spawnChild } from 'node:child_process';
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { constants as osConstants } from 'node:os';
import path from 'node:path';
import type { Readable } from 'node:stream';
import { InvalidOptionError } from './errors.js';

const HOST_VIRTUAL_ROOT = '/workspace';
const VERCEL_SANDBOX_PACKAGE = '@ai-sdk/sandbox-vercel';

export type SandboxProvider = HarnessV1SandboxProvider;

export type SandboxOption =
  | 'virtual'
  | VirtualSandboxOption
  | HostSandboxOption
  | VercelSandboxOption
  | CustomSandboxOption;

export interface VirtualSandboxOption {
  type: 'virtual';
}

export interface HostSandboxOption {
  type: 'host';
  rootDir: string;
  isolation: 'external';
  env?: Record<string, string | undefined>;
}

export interface VercelSandboxOption {
  type: 'vercel';
  runtime?: string;
  ports?: readonly number[];
  timeout?: number;
  networkPolicy?: unknown;
  name?: string;
  [key: string]: unknown;
}

export interface CustomSandboxOption {
  type: 'custom';
  provider: SandboxProvider;
}

export type SandboxConfig =
  | { type: 'virtual' }
  | HostSandboxOption
  | VercelSandboxOption
  | CustomSandboxOption;

export function resolveSandboxConfig(sandbox: unknown): SandboxConfig {
  if (sandbox === undefined || sandbox === 'virtual') {
    return { type: 'virtual' };
  }

  if (!isRecord(sandbox)) {
    throw new InvalidOptionError('"sandbox" must be a valid sandbox option.');
  }

  switch (sandbox['type']) {
    case 'virtual':
      return { type: 'virtual' };

    case 'host': {
      if (sandbox['isolation'] !== 'external') {
        throw new InvalidOptionError(
          'Host sandbox mode requires isolation: "external".',
        );
      }

      const rootDir = sandbox['rootDir'];
      if (typeof rootDir !== 'string' || rootDir.trim().length === 0) {
        throw new InvalidOptionError(
          'Host sandbox mode requires a non-empty "rootDir".',
        );
      }
      if (!path.isAbsolute(rootDir)) {
        throw new InvalidOptionError(
          `Host sandbox "rootDir" must be absolute, received: ${rootDir}`,
        );
      }

      const env = sandbox['env'];
      return {
        type: 'host',
        rootDir: path.resolve(rootDir),
        isolation: 'external',
        ...(isRecord(env) ? { env: toOptionalStringRecord(env) } : {}),
      };
    }

    case 'vercel':
      if (sandbox['sandbox'] !== undefined) {
        throw new InvalidOptionError(
          'Vercel sandbox mode does not accept a pre-created sandbox. Use custom mode instead.',
        );
      }
      return normalizeVercelSandboxConfig(sandbox);

    case 'custom': {
      const provider = sandbox['provider'];
      if (!isSandboxProvider(provider)) {
        throw new InvalidOptionError(
          'Custom sandbox mode requires a valid sandbox provider.',
        );
      }
      return { type: 'custom', provider };
    }

    default:
      throw new InvalidOptionError('"sandbox" must be a valid sandbox option.');
  }
}

export function createSandboxProvider(config: SandboxConfig): SandboxProvider {
  switch (config.type) {
    case 'virtual':
      return createJustBashSandbox();

    case 'host':
      return new HostSandboxProvider(config);

    case 'vercel':
      return new LazyVercelSandboxProvider(config);

    case 'custom':
      return config.provider;
  }
}

function normalizeVercelSandboxConfig(
  input: Record<string, unknown>,
): VercelSandboxOption {
  const out: VercelSandboxOption = { type: 'vercel' };

  for (const [key, value] of Object.entries(input)) {
    if (key !== 'type') {
      out[key] = value;
    }
  }

  return out;
}

interface VercelSandboxModule {
  createVercelSandbox(settings?: Record<string, unknown>): SandboxProvider;
}

class LazyVercelSandboxProvider implements SandboxProvider {
  readonly specificationVersion = 'harness-sandbox-v1';
  readonly providerId = 'vercel-sandbox';

  private providerPromise: Promise<SandboxProvider> | undefined;

  constructor(private readonly settings: VercelSandboxOption) {}

  createSession = async (options?: {
    sessionId?: string;
    abortSignal?: AbortSignal;
    identity?: string;
    onFirstCreate?: (
      session: Experimental_SandboxSession,
      opts: { abortSignal?: AbortSignal },
    ) => Promise<void>;
  }): Promise<HarnessV1NetworkSandboxSession> => {
    return (await this.provider()).createSession(options);
  };

  resumeSession = async (options: {
    sessionId: string;
    abortSignal?: AbortSignal;
  }): Promise<HarnessV1NetworkSandboxSession> => {
    const provider = await this.provider();
    if (provider.resumeSession) {
      return provider.resumeSession(options);
    }
    return provider.createSession(options);
  };

  private provider(): Promise<SandboxProvider> {
    this.providerPromise ??= loadVercelSandboxProvider(this.settings);
    return this.providerPromise;
  }
}

async function loadVercelSandboxProvider(
  settings: VercelSandboxOption,
): Promise<SandboxProvider> {
  const imported: unknown = await import(VERCEL_SANDBOX_PACKAGE).catch(
    (error: unknown) => {
      throw new InvalidOptionError(
        'sandbox.type "vercel" requires installing @ai-sdk/sandbox-vercel.',
        { cause: error },
      );
    },
  );

  if (!isVercelSandboxModule(imported)) {
    throw new InvalidOptionError(
      '@ai-sdk/sandbox-vercel did not export createVercelSandbox.',
    );
  }

  const { type: _type, ...vercelSettings } = settings;
  return imported.createVercelSandbox(vercelSettings);
}

class HostSandboxProvider implements SandboxProvider {
  readonly specificationVersion = 'harness-sandbox-v1';
  readonly providerId = 'host-sandbox';

  constructor(private readonly settings: HostSandboxOption) {}

  createSession = async (options?: {
    sessionId?: string;
    abortSignal?: AbortSignal;
  }): Promise<HarnessV1NetworkSandboxSession> => {
    const sessionId = options?.sessionId ?? randomUUID();
    await mkdir(this.settings.rootDir, { recursive: true });
    const rootDir = await realpath(this.settings.rootDir);
    return new HostSandboxSession({
      sessionId,
      rootDir,
      env: this.settings.env,
    });
  };

  resumeSession = async (options: {
    sessionId: string;
    abortSignal?: AbortSignal;
  }): Promise<HarnessV1NetworkSandboxSession> => {
    return this.createSession(options);
  };
}

class HostSandboxSession implements HarnessV1NetworkSandboxSession {
  readonly description: string;
  readonly defaultWorkingDirectory = HOST_VIRTUAL_ROOT;
  readonly ports: readonly number[] = [];

  constructor(
    private readonly settings: {
      sessionId: string;
      rootDir: string;
      env?: Record<string, string | undefined>;
    },
  ) {
    this.description = `Host filesystem workspace mounted at ${HOST_VIRTUAL_ROOT}.`;
  }

  get id(): string {
    return `host-${this.settings.sessionId}`;
  }

  readFile = async (options: {
    path: string;
    abortSignal?: AbortSignal;
  }): Promise<ReadableStream<Uint8Array> | null> => {
    const bytes = await this.readBinaryFile(options);
    if (bytes == null) {
      return null;
    }
    return new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes);
        controller.close();
      },
    });
  };

  readBinaryFile = async (options: {
    path: string;
    abortSignal?: AbortSignal;
  }): Promise<Uint8Array | null> => {
    try {
      return await readFile(this.toHostPath(options.path));
    } catch (error) {
      if (isNotFound(error)) {
        return null;
      }
      throw error;
    }
  };

  readTextFile = async (options: {
    path: string;
    abortSignal?: AbortSignal;
    encoding?: string;
    startLine?: number;
    endLine?: number;
  }): Promise<string | null> => {
    const bytes = await this.readBinaryFile(options);
    if (bytes == null) {
      return null;
    }
    const text = Buffer.from(bytes).toString(
      toBufferEncoding(options.encoding),
    );
    if (options.startLine === undefined && options.endLine === undefined) {
      return text;
    }
    const start = Math.max((options.startLine ?? 1) - 1, 0);
    const end = options.endLine ?? Number.POSITIVE_INFINITY;
    return text.split('\n').slice(start, end).join('\n');
  };

  writeFile = async (options: {
    path: string;
    content: ReadableStream<Uint8Array>;
    abortSignal?: AbortSignal;
  }): Promise<void> => {
    const chunks: Uint8Array[] = [];
    for await (const chunk of streamToAsyncIterable(options.content)) {
      chunks.push(chunk);
    }
    await this.writeBinaryFile({
      path: options.path,
      content: Buffer.concat(chunks.map(chunk => Buffer.from(chunk))),
      ...(options.abortSignal ? { abortSignal: options.abortSignal } : {}),
    });
  };

  writeBinaryFile = async (options: {
    path: string;
    content: Uint8Array;
    abortSignal?: AbortSignal;
  }): Promise<void> => {
    const target = this.toHostPath(options.path);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, options.content);
  };

  writeTextFile = async (options: {
    path: string;
    content: string;
    abortSignal?: AbortSignal;
    encoding?: string;
  }): Promise<void> => {
    const target = this.toHostPath(options.path);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(
      target,
      options.content,
      toBufferEncoding(options.encoding),
    );
  };

  // async (despite no await) so a pre-aborted signal rejects instead of throwing synchronously.
  // eslint-disable-next-line @typescript-eslint/require-await
  spawn = async (options: {
    command: string;
    workingDirectory?: string;
    env?: Record<string, string>;
    abortSignal?: AbortSignal;
  }): Promise<Experimental_SandboxProcess> => {
    options.abortSignal?.throwIfAborted();

    const cwd = this.toHostPath(options.workingDirectory ?? HOST_VIRTUAL_ROOT);
    const command = this.toHostCommand(options.command);
    const child = spawnChild(command, {
      cwd,
      env: this.createEnv(options.env),
      shell: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const abort = () => child.kill();
    options.abortSignal?.addEventListener('abort', abort, { once: true });

    const exit = new Promise<{ exitCode: number }>((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code, signal) => {
        resolve({
          exitCode: code ?? 128 + (signal ? osConstants.signals[signal] : 0),
        });
      });
    });
    exit
      .catch(() => undefined)
      .finally(() => options.abortSignal?.removeEventListener('abort', abort));

    return {
      ...(child.pid ? { pid: child.pid } : {}),
      stdout: nodeReadableToWeb(child.stdout),
      stderr: nodeReadableToWeb(child.stderr),
      wait: () => exit,
      kill: () => {
        child.kill();
        return Promise.resolve();
      },
    };
  };

  run = async (options: {
    command: string;
    workingDirectory?: string;
    env?: Record<string, string>;
    abortSignal?: AbortSignal;
  }): Promise<{ exitCode: number; stdout: string; stderr: string }> => {
    const proc = await this.spawn(options);
    const [stdout, stderr, waitResult] = await Promise.all([
      collectText(proc.stdout),
      collectText(proc.stderr),
      proc.wait(),
    ]);
    const displayCwd = normalizeVirtualPath(
      options.workingDirectory ?? HOST_VIRTUAL_ROOT,
    );
    return {
      exitCode: waitResult.exitCode,
      stdout: this.toVirtualOutput(stdout, displayCwd),
      stderr: this.toVirtualOutput(stderr, displayCwd),
    };
  };

  getPortUrl = (options: {
    port: number;
    protocol?: 'http' | 'https' | 'ws';
  }): Promise<string> => {
    const protocol = options.protocol ?? 'http';
    return Promise.resolve(`${protocol}://127.0.0.1:${String(options.port)}`);
  };

  stop = (): Promise<void> => Promise.resolve();

  destroy = (): Promise<void> => Promise.resolve();

  restricted = (): Experimental_SandboxSession => ({
    description: this.description,
    readFile: this.readFile,
    readBinaryFile: this.readBinaryFile,
    readTextFile: this.readTextFile,
    writeFile: this.writeFile,
    writeBinaryFile: this.writeBinaryFile,
    writeTextFile: this.writeTextFile,
    spawn: this.spawn,
    run: this.run,
  });

  private createEnv(
    env: Record<string, string> | undefined,
  ): NodeJS.ProcessEnv {
    return {
      ...process.env,
      ...dropUndefined(this.settings.env),
      ...env,
    };
  }

  private toHostCommand(command: string): string {
    const quotedVirtualPath = new RegExp(
      `'${escapeRegExp(HOST_VIRTUAL_ROOT)}([^']*)?'`,
      'g',
    );
    const bareVirtualPath = new RegExp(
      `${escapeRegExp(HOST_VIRTUAL_ROOT)}(?:/[^\\s'";|&<>)]*)?`,
      'g',
    );

    return command
      .replace(quotedVirtualPath, match =>
        shellQuote(this.toHostPath(match.slice(1, -1))),
      )
      .replace(bareVirtualPath, match => shellQuote(this.toHostPath(match)));
  }

  private toHostPath(inputPath: string): string {
    const virtualPath = normalizeVirtualPath(inputPath);
    if (virtualPath === HOST_VIRTUAL_ROOT) {
      return this.settings.rootDir;
    }
    if (virtualPath.startsWith(`${HOST_VIRTUAL_ROOT}/`)) {
      return this.resolveInsideRoot(this.virtualRelativePath(virtualPath));
    }
    if (path.isAbsolute(inputPath)) {
      return this.assertInsideRoot(path.resolve(inputPath));
    }
    return this.resolveInsideRoot(inputPath);
  }

  private virtualRelativePath(virtualPath: string): string {
    const relative = virtualPath.slice(HOST_VIRTUAL_ROOT.length + 1);
    const [first, ...rest] = relative.split('/');
    if (first?.endsWith(`-${this.settings.sessionId}`)) {
      return rest.join('/');
    }
    return relative;
  }

  private resolveInsideRoot(relativePath: string): string {
    return this.assertInsideRoot(
      path.resolve(this.settings.rootDir, relativePath),
    );
  }

  private assertInsideRoot(target: string): string {
    const relative = path.relative(this.settings.rootDir, target);
    if (
      relative === '' ||
      (!relative.startsWith('..') && !path.isAbsolute(relative))
    ) {
      return target;
    }
    throw new Error(`Host sandbox path escapes rootDir: ${target}`);
  }

  private toVirtualOutput(output: string, displayCwd: string): string {
    return output.split(this.settings.rootDir).join(displayCwd);
  }
}

function normalizeVirtualPath(inputPath: string): string {
  return path.posix.normalize(inputPath.split(path.sep).join(path.posix.sep));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === 'object';
}

function isSandboxProvider(value: unknown): value is SandboxProvider {
  return (
    isRecord(value) &&
    value['specificationVersion'] === 'harness-sandbox-v1' &&
    typeof value['createSession'] === 'function'
  );
}

function isVercelSandboxModule(value: unknown): value is VercelSandboxModule {
  return isRecord(value) && typeof value['createVercelSandbox'] === 'function';
}

function toOptionalStringRecord(
  value: Record<string, unknown>,
): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (entry === undefined || typeof entry === 'string') {
      out[key] = entry;
    }
  }
  return out;
}

function dropUndefined(
  env: Record<string, string | undefined> | undefined,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env ?? {})) {
    if (value !== undefined) {
      out[key] = value;
    }
  }
  return out;
}

function toBufferEncoding(encoding: string | undefined): BufferEncoding {
  return (encoding ?? 'utf-8') as BufferEncoding;
}

function isNotFound(error: unknown): boolean {
  return (
    error != null &&
    typeof error === 'object' &&
    (error as { code?: unknown }).code === 'ENOENT'
  );
}

function nodeReadableToWeb(stream: Readable): ReadableStream<Uint8Array> {
  const iterator = stream[Symbol.asyncIterator]();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      const result = await iterator.next();
      if (result.done) {
        controller.close();
        return;
      }
      controller.enqueue(toUint8Array(result.value));
    },
    async cancel() {
      await iterator.return?.();
    },
  });
}

async function collectText(
  stream: ReadableStream<Uint8Array>,
): Promise<string> {
  const decoder = new TextDecoder();
  let text = '';
  for await (const chunk of streamToAsyncIterable(stream)) {
    text += decoder.decode(chunk, { stream: true });
  }
  text += decoder.decode();
  return text;
}

async function* streamToAsyncIterable(
  stream: ReadableStream<Uint8Array>,
): AsyncIterable<Uint8Array> {
  const reader = stream.getReader();
  try {
    for (;;) {
      const result = await reader.read();
      if (result.done) {
        return;
      }
      yield result.value;
    }
  } finally {
    reader.releaseLock();
  }
}

function toUint8Array(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) {
    return value;
  }
  if (typeof value === 'string') {
    return new TextEncoder().encode(value);
  }
  return Buffer.from(value as ArrayBufferLike);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
