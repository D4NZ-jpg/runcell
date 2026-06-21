import {
  commonTool,
  type HarnessV1,
  type HarnessV1BuiltinTool,
} from '@ai-sdk/harness';
import { tool } from '@ai-sdk/provider-utils';
import { z } from 'zod';
import { piResumeStateSchema } from './pi-resume-state';
import { createPiSession, type PiSessionSettings } from './pi-session';

/**
 * Configuration knobs for `createPi`. Pi runs as an in-process Node library
 * (no bridge), so there's no `port` or `startupTimeoutMs` to set. This local
 * fork intentionally exposes raw Pi SDK services/resource loading options in
 * addition to the stock auth/model/thinking settings.
 */
export interface PiHarnessSettings extends PiSessionSettings {}

const PI_BUILTIN_TOOLS = {
  read: commonTool('read', {
    nativeName: 'read',
    toolUseKind: 'readonly',
    description: 'Read file contents.',
    inputSchema: z.object({
      file_path: z.string(),
    }),
  }),
  write: commonTool('write', {
    nativeName: 'write',
    toolUseKind: 'edit',
    description: 'Overwrite or create a file.',
    inputSchema: z.object({
      file_path: z.string(),
      content: z.string(),
    }),
  }),
  edit: commonTool('edit', {
    nativeName: 'edit',
    toolUseKind: 'edit',
    description: 'Edit a file by exact string replacement.',
    inputSchema: z.object({
      file_path: z.string(),
      old_string: z.string(),
      new_string: z.string(),
    }),
  }),
  bash: commonTool('bash', {
    nativeName: 'bash',
    toolUseKind: 'bash',
    description: 'Execute a shell command in the sandbox.',
    inputSchema: z.object({
      command: z.string(),
      timeout: z.number().optional(),
    }),
  }),
  grep: commonTool('grep', {
    nativeName: 'grep',
    toolUseKind: 'readonly',
    description: 'Search file contents with regex.',
    inputSchema: z.object({
      pattern: z.string(),
      path: z.string().optional(),
      glob: z.string().optional(),
      ignoreCase: z.boolean().optional(),
      literal: z.boolean().optional(),
      context: z.number().optional(),
      limit: z.number().optional(),
    }),
  }),
  glob: commonTool('glob', {
    nativeName: 'find',
    toolUseKind: 'readonly',
    description: 'Find files matching a glob pattern.',
    inputSchema: z.object({
      pattern: z.string(),
      path: z.string().optional(),
      limit: z.number().optional(),
    }),
  }),
  ls: {
    ...tool({
      description: 'List directory entries.',
      inputSchema: z.object({
        path: z.string().optional(),
        limit: z.number().optional(),
      }),
      outputSchema: z.unknown(),
    }),
    nativeName: 'ls',
    toolUseKind: 'readonly',
  } as HarnessV1BuiltinTool,
} as const satisfies Record<string, HarnessV1BuiltinTool<any, any>>;

export function createPi(
  settings: PiHarnessSettings = {},
): HarnessV1<typeof PI_BUILTIN_TOOLS> {
  return {
    specificationVersion: 'harness-v1',
    harnessId: 'pi',
    builtinTools: PI_BUILTIN_TOOLS,
    supportsBuiltinToolApprovals: true,
    lifecycleStateSchema: piResumeStateSchema,
    doStart: async startOpts => {
      const lifecycleState = startOpts.continueFrom ?? startOpts.resumeFrom;
      const resumeData = lifecycleState?.data as
        | { sessionFileName?: string }
        | undefined;

      return createPiSession({
        sessionId: startOpts.sessionId,
        sandboxSession: startOpts.sandboxSession,
        sessionWorkDir: startOpts.sessionWorkDir,
        skills: startOpts.skills ?? [],
        settings,
        isResume: lifecycleState != null,
        permissionMode: startOpts.permissionMode,
        ...(resumeData?.sessionFileName
          ? { resumeSessionFileName: resumeData.sessionFileName }
          : {}),
        ...(startOpts.abortSignal
          ? { abortSignal: startOpts.abortSignal }
          : {}),
      });
    },
  };
}
