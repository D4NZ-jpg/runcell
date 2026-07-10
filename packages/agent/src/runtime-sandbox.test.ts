import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { ResolvedAgentConfig } from './create-agent.js';
import { resolveRunSandbox } from './runtime.js';
import { createVirtualSandbox, getSandboxInternals } from './sandbox-handle.js';

const config: ResolvedAgentConfig = {
  model: 'anthropic/test',
  systemPrompt: undefined,
  credentials: { mode: 'env' },
  toolNames: [],
  sandbox: { type: 'virtual' },
  maxRepairs: 1,
};

const schema = z.object({ ok: z.boolean() });

describe('resolveRunSandbox', () => {
  it('reuses a live sandbox handle and pins its session token', async () => {
    const sandbox = await createVirtualSandbox();
    try {
      const { provider, sessionId } = resolveRunSandbox({
        config,
        runOptions: { prompt: 'go', schema, sandbox },
      });
      expect(provider.providerId).toBe('runcell-reused-sandbox');
      expect(sessionId).toBe(getSandboxInternals(sandbox)?.sessionToken);
    } finally {
      await sandbox.destroy();
    }
  });

  it('creates an ephemeral provider for a sandbox option and forwards the run session id', () => {
    const { provider, sessionId } = resolveRunSandbox({
      config,
      runOptions: { prompt: 'go', schema, sessionId: 'run-123' },
    });
    expect(provider.providerId).not.toBe('runcell-reused-sandbox');
    expect(sessionId).toBe('run-123');
  });

  it('falls back to the agent-level sandbox when no run sandbox is given', () => {
    const { provider } = resolveRunSandbox({
      config,
      runOptions: { prompt: 'go', schema },
    });
    // virtual config maps to the just-bash provider
    expect(provider.providerId).toBe('just-bash-sandbox');
  });
});
