import type { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { getAiGatewayAuthFromEnv } from '@ai-sdk/harness/utils';

type PiModel = ReturnType<ModelRuntime['getModels']>[number];

/**
 * Default model id used when no `model` is configured AND gateway credentials
 * are available in the environment. Looked up from Pi's own model registry —
 * the entry must exist under the `vercel-ai-gateway` provider in
 * `@earendil-works/pi-ai`'s catalog.
 */
export const DEFAULT_PI_GATEWAY_MODEL_ID = 'anthropic/claude-sonnet-4.6';

export function createPiModelResolver(
  modelRuntime: ModelRuntime,
  env: NodeJS.ProcessEnv = process.env,
) {
  let cachedModels: readonly PiModel[] | undefined;

  const loadModels = (): readonly PiModel[] => {
    if (cachedModels) {
      return cachedModels;
    }
    try {
      cachedModels = modelRuntime.getModels();
    } catch {
      cachedModels = [];
    }
    return cachedModels;
  };

  return (modelId: string | undefined): PiModel | undefined => {
    const useGateway = Boolean(getAiGatewayAuthFromEnv({ env }).apiKey);
    const effectiveId =
      modelId ?? (useGateway ? DEFAULT_PI_GATEWAY_MODEL_ID : undefined);
    if (!effectiveId) return undefined;

    const models = loadModels();
    const matches = (m: PiModel) =>
      m.id === effectiveId || m.name === effectiveId;
    // A `provider/id` (or `provider/name`) form disambiguates ids that Pi's
    // catalog lists under multiple providers (e.g. `gpt-5.5` exists under
    // `openai-codex`, `azure-openai-responses`, and others). Without this a
    // bare id resolves to whichever provider happens to come first, which may
    // be one the caller has no credentials for.
    const matchesQualified = (m: PiModel) =>
      `${m.provider}/${m.id}` === effectiveId ||
      `${m.provider}/${m.name}` === effectiveId;

    // When gateway creds are present, prefer the gateway-routed entry for the
    // given id. Pi's catalog lists the same model id under multiple providers
    // (e.g. `anthropic/claude-sonnet-4.6` exists under both `openrouter` and
    // `vercel-ai-gateway`); without this preference Pi would dispatch through
    // a provider we didn't register, which fails with "No API key found".
    return (
      (useGateway &&
        models.find(m => m.provider === 'vercel-ai-gateway' && matches(m))) ||
      models.find(matchesQualified) ||
      models.find(matches)
    );
  };
}
