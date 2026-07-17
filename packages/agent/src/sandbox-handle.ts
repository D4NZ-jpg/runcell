import type {
  HarnessV1NetworkSandboxSession,
  HarnessV1SandboxProvider,
} from '@ai-sdk/harness';
import { HARNESS_ID } from '@local/harness-pi-raw';
import { InvalidOptionError } from './errors.js';
import { createPatchedJustBashSandbox } from './just-bash-env.js';
import { assertSafeWorkspacePath } from './paths.js';
import { shellQuote } from './shell.js';
import { randomUUID } from 'node:crypto';
import path from 'node:path';

/** Directory holding the internal agent session journal; hidden from snapshots. */
const AGENT_STATE_DIR = '.pi-sessions';

/**
 * A live, mutable sandbox resource. Usable directly with no agent: run
 * commands, read/write files, snapshot, and dispose. The same handle can be
 * passed to {@link Agent.run} via the `sandbox` option, in which case the
 * caller owns its lifecycle and runcell never destroys it.
 *
 * Backed by a provider session, so one interface spans the in-memory virtual
 * sandbox, hosted providers, and custom providers. Capabilities that a backend
 * cannot support are reported through {@link Sandbox.capabilities}.
 */
export interface Sandbox {
  /** Stable identifier for the underlying sandbox resource. */
  readonly id: string;
  /** What this backend can do beyond the universal primitives. */
  readonly capabilities: SandboxCapabilities;

  /** Run a shell command and resolve with its result. */
  exec(command: string, options?: ExecOptions): Promise<ExecResult>;

  /** Read a file as raw bytes. Resolves to `null` when it does not exist. */
  readFile(path: string): Promise<Uint8Array | null>;
  /** Read a file as text. Resolves to `null` when it does not exist. */
  readTextFile(path: string): Promise<string | null>;
  /** Write a file, creating parent directories as needed. */
  writeFile(path: string, content: Uint8Array | string): Promise<void>;
  /** Remove a file or directory. No-op when it does not exist. */
  remove(path: string): Promise<void>;

  /**
   * Capture a portable snapshot of the workspace files. This captures files,
   * not running processes. Restore with {@link restoreSandbox}.
   */
  snapshot(): Promise<SandboxSnapshot>;

  /**
   * Resolve a publicly reachable URL for a sandbox-exposed port. Present only
   * when {@link SandboxCapabilities.ports} is `true`.
   */
  exposeUrl?(port: number): Promise<string>;

  /**
   * Run `fn` with exclusive access to `key`, serialized against other `lock`
   * calls for the same key on this handle. An opt-in coordination primitive;
   * runcell never takes this lock on your behalf.
   */
  lock<T>(key: string, fn: () => Promise<T>): Promise<T>;

  /**
   * Dispose the sandbox. Idempotent; any further operation on the handle
   * rejects with {@link InvalidOptionError}.
   */
  destroy(): Promise<void>;
}

/**
 * What a sandbox backend supports beyond the universal primitives. Lets one
 * interface span providers with very different feature sets.
 */
export interface SandboxCapabilities {
  /** Can expose network ports as public URLs. */
  ports: boolean;
  /** Has a native checkpoint that captures processes, not just files. */
  nativeSnapshot: boolean;
  /** Can reattach to a previously created live instance. */
  resume: boolean;
}

export interface ExecOptions {
  /** Working directory for this command. Defaults to the sandbox workspace. */
  cwd?: string;
  /** Extra environment variables, merged over the sandbox defaults. */
  env?: Record<string, string>;
  /** Abort signal that kills the running command. */
  signal?: AbortSignal;
}

export interface ExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/**
 * A portable, serializable snapshot of a sandbox workspace. File bytes are
 * base64-encoded so the whole value round-trips through `JSON.stringify`.
 */
export interface SandboxSnapshot {
  version: 1;
  files: SnapshotFile[];
}

export interface SnapshotFile {
  /** Workspace-relative path. */
  path: string;
  /** Base64-encoded file bytes. */
  data: string;
}

export interface VirtualSandboxOptions {
  /** Environment variables available to every command. */
  env?: Record<string, string>;
}

/**
 * Internal handle state needed to reuse a sandbox inside an agent run. Not part
 * of the public surface.
 */
interface SandboxInternals {
  session: HarnessV1NetworkSandboxSession;
  sessionToken: string;
}

const internalsRegistry = new WeakMap<Sandbox, SandboxInternals>();

/**
 * Retrieve the reuse state for a runcell-created sandbox handle, or `undefined`
 * for anything else (sandbox options, foreign objects). Internal.
 */
export function getSandboxInternals(
  sandbox: unknown,
): SandboxInternals | undefined {
  return typeof sandbox === 'object' && sandbox !== null
    ? internalsRegistry.get(sandbox as Sandbox)
    : undefined;
}

/**
 * Create an in-memory virtual sandbox. Zero-config and bundled: a bare install
 * runs this with no extra dependencies. Has no ports and no native snapshot,
 * but supports portable file snapshots like every other backend.
 */
export async function createVirtualSandbox(
  options: VirtualSandboxOptions = {},
): Promise<Sandbox> {
  const provider = createPatchedJustBashSandbox(
    options.env ? { env: options.env } : {},
  );
  const session = await provider.createSession();
  const sessionToken = randomUUID();
  // Match the working directory the harness composes for this session, so the
  // handle and a later agent run operate on exactly the same files.
  const workDir = `${session.defaultWorkingDirectory}/${HARNESS_ID}-${sessionToken}`;
  await session.run({ command: `mkdir -p ${shellQuote(workDir)}` });

  const sandbox = new SessionSandbox(
    session,
    { ports: false, nativeSnapshot: false, resume: false },
    workDir,
  );
  internalsRegistry.set(sandbox, { session, sessionToken });
  return sandbox;
}

/**
 * Rehydrate a {@link SandboxSnapshot} into a fresh virtual sandbox. Writes the
 * snapshot files back into a new workspace; running processes are not restored.
 */
export async function restoreSandbox(
  snapshot: SandboxSnapshot,
  options: VirtualSandboxOptions = {},
): Promise<Sandbox> {
  const files = validateSnapshot(snapshot);
  const sandbox = await createVirtualSandbox(options);
  try {
    for (const file of files) {
      await sandbox.writeFile(file.path, file.bytes);
    }
  } catch (error) {
    await sandbox.destroy().catch(() => undefined);
    throw error;
  }
  return sandbox;
}

/**
 * Validate a snapshot before any sandbox exists: workspace-safe unique paths
 * and canonical base64. Rejecting up front keeps restore atomic — a hostile or
 * corrupt snapshot never creates a sandbox or writes a single file.
 */
function validateSnapshot(
  snapshot: SandboxSnapshot,
): { path: string; bytes: Uint8Array }[] {
  // Snapshots come from persisted, possibly tampered data; the static types
  // say nothing about what is actually on disk.
  const state: { version?: unknown; files?: unknown } = snapshot;
  if (state.version !== 1 || !Array.isArray(state.files)) {
    throw new InvalidOptionError(
      'Snapshot must be a version 1 SandboxSnapshot.',
    );
  }
  const seen = new Set<string>();
  return snapshot.files.map(file => {
    const safePath = assertSafeWorkspacePath(file.path);
    if (seen.has(safePath)) {
      throw new InvalidOptionError(
        `Snapshot contains duplicate path: ${safePath}`,
      );
    }
    seen.add(safePath);
    const bytes = Buffer.from(file.data, 'base64');
    if (bytes.toString('base64') !== file.data) {
      throw new InvalidOptionError(
        `Snapshot file has invalid base64 data: ${safePath}`,
      );
    }
    return { path: safePath, bytes: new Uint8Array(bytes) };
  });
}

/**
 * Build a sandbox provider that reuses an existing handle's session without
 * ever stopping or destroying it, so the caller keeps ownership. Internal.
 */
export function createReusedSandboxProvider(
  internals: SandboxInternals,
): HarnessV1SandboxProvider {
  const guarded = guardSession(internals.session);
  return {
    specificationVersion: 'harness-sandbox-v1',
    providerId: 'runcell-reused-sandbox',
    createSession: () => Promise.resolve(guarded),
    resumeSession: () => Promise.resolve(guarded),
  };
}

/**
 * A view of a session with `stop`/`destroy` neutralized so the harness cleanup
 * cannot dispose a caller-owned sandbox. All other members delegate unchanged.
 */
function guardSession(
  session: HarnessV1NetworkSandboxSession,
): HarnessV1NetworkSandboxSession {
  return new Proxy(session, {
    get(target, prop, receiver) {
      if (prop === 'stop' || prop === 'destroy') {
        return () => Promise.resolve();
      }
      const value = Reflect.get(target, prop, receiver) as unknown;
      return typeof value === 'function'
        ? (value as (...args: unknown[]) => unknown).bind(target)
        : value;
    },
  });
}

/**
 * Wraps a provider sandbox session as a public {@link Sandbox}. The session
 * interface is implemented by every backend, so the same wrapper serves the
 * virtual sandbox and hosted/custom providers.
 */
class SessionSandbox implements Sandbox {
  readonly id: string;
  readonly capabilities: SandboxCapabilities;

  private readonly session: HarnessV1NetworkSandboxSession;
  private readonly workDir: string;
  private readonly locks = new Map<string, Promise<unknown>>();
  private destroyed = false;
  private destroyPromise: Promise<void> | undefined;

  constructor(
    session: HarnessV1NetworkSandboxSession,
    capabilities: SandboxCapabilities,
    workDir: string,
  ) {
    this.session = session;
    this.id = session.id;
    this.capabilities = capabilities;
    this.workDir = workDir;
    if (capabilities.ports) {
      this.exposeUrl = async (port: number) => {
        this.assertActive();
        return this.session.getPortUrl({ port });
      };
    }
  }

  exposeUrl?: (port: number) => Promise<string>;

  async exec(command: string, options: ExecOptions = {}): Promise<ExecResult> {
    this.assertActive();
    const result = await this.session.run({
      command,
      workingDirectory: options.cwd ?? this.workDir,
      ...(options.env ? { env: options.env } : {}),
      ...(options.signal ? { abortSignal: options.signal } : {}),
    });
    return {
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
    };
  }

  async readFile(filePath: string): Promise<Uint8Array | null> {
    this.assertActive();
    return this.session.readBinaryFile({ path: this.resolve(filePath) });
  }

  async readTextFile(filePath: string): Promise<string | null> {
    this.assertActive();
    return this.session.readTextFile({ path: this.resolve(filePath) });
  }

  async writeFile(
    filePath: string,
    content: Uint8Array | string,
  ): Promise<void> {
    this.assertActive();
    const target = this.resolve(filePath);
    if (typeof content === 'string') {
      await this.session.writeTextFile({ path: target, content });
    } else {
      await this.session.writeBinaryFile({ path: target, content });
    }
  }

  async remove(filePath: string): Promise<void> {
    this.assertActive();
    await this.session.run({
      command: `rm -rf -- ${shellQuote(this.resolve(filePath))}`,
    });
  }

  async snapshot(): Promise<SandboxSnapshot> {
    this.assertActive();
    const listing = await this.session.run({
      command: 'find . -type f',
      workingDirectory: this.workDir,
    });
    const paths = listing.stdout
      .split('\n')
      .map(line => line.trim())
      .filter(line => line.length > 0)
      .map(line => (line.startsWith('./') ? line.slice(2) : line))
      .filter(line => line.length > 0 && !isAgentStatePath(line))
      .sort();

    const files: SnapshotFile[] = [];
    for (const relativePath of paths) {
      const bytes = await this.session.readBinaryFile({
        path: path.posix.join(this.workDir, relativePath),
      });
      if (bytes != null) {
        files.push({ path: relativePath, data: bytesToBase64(bytes) });
      }
    }
    return { version: 1, files };
  }

  lock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(key) ?? Promise.resolve();
    // Re-check at execution time: the handle may be destroyed while queued.
    const result = previous.then(() => {
      this.assertActive();
      return fn();
    });
    // Keep the chain alive even if fn rejects, so later lock calls still run.
    this.locks.set(
      key,
      result.then(
        () => undefined,
        () => undefined,
      ),
    );
    return result;
  }

  destroy(): Promise<void> {
    this.destroyPromise ??= (() => {
      this.destroyed = true;
      internalsRegistry.delete(this);
      return Promise.resolve(
        this.session.destroy ? this.session.destroy() : this.session.stop(),
      );
    })();
    return this.destroyPromise;
  }

  private assertActive(): void {
    if (this.destroyed) {
      throw new InvalidOptionError('Sandbox has been destroyed.');
    }
  }

  private resolve(filePath: string): string {
    return path.posix.join(this.workDir, assertSafeWorkspacePath(filePath));
  }
}

function isAgentStatePath(relativePath: string): boolean {
  return (
    relativePath === AGENT_STATE_DIR ||
    relativePath.startsWith(`${AGENT_STATE_DIR}/`)
  );
}

function bytesToBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64');
}
