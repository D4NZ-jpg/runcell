import { createPi } from './pi-harness';

/**
 * Default `pi` harness instance with no overrides — suitable for the common
 * case where Pi's defaults are fine. Equivalent to `createPi()`.
 */
export const pi = createPi();

export { createPi, HARNESS_ID } from './pi-harness';
export type { PiHarnessSettings } from './pi-harness';
export type { PiAuthOptions } from './pi-auth';
export { PiExtensionError } from './pi-session';
export type {
  PiCredentialStore,
  PiResourceLoaderOptions,
  PiSessionSettings,
  PiThinkingLevel,
} from './pi-session';
export { isToolContent, toolContent, TOOL_CONTENT_TYPE } from './tool-content';
export type {
  ToolContent,
  ToolContentImageInput,
  ToolContentImageMediaType,
  ToolContentImagePart,
  ToolContentPart,
  ToolContentPartInput,
  ToolContentTextPart,
} from './tool-content';
export type {
  ExtensionAPI,
  ExtensionFactory,
} from '@earendil-works/pi-coding-agent';
