import {
  DEFAULT_MODEL,
  EXTRA_MODELS_ENV_KEY,
  buildModelCatalog,
  resolveModelLabel,
  resolveSelectedModel,
  type ModelOption,
} from '../shared/models.ts';

function envValue(context: any, key: string) {
  const value = context?.env?.[key];
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * The model this deployment runs when the composer has not chosen one. Kept as
 * the single reader of the model env chain so the picker's default and the
 * agent's fallback can never drift apart.
 */
export function resolveConfiguredModel(context: any) {
  return envValue(context, 'AI_GATEWAY_MODEL')
    || envValue(context, 'ANTHROPIC_MODEL')
    || envValue(context, 'DEEPSEEK_MODEL')
    || DEFAULT_MODEL;
}

/** The menu the composer's picker shows for this deployment. */
export function resolveModelCatalog(context: any): ModelOption[] {
  return buildModelCatalog({
    configuredModel: resolveConfiguredModel(context),
    extraModels: envValue(context, EXTRA_MODELS_ENV_KEY),
  });
}

/**
 * A request's model choice, dropped unless this deployment offers it. Callers
 * read '' as "no choice" and fall back to the configured model, so a client that
 * sends an arbitrary string cannot pick what the gateway bills for.
 */
export function resolveRequestedModel(context: any, requested: unknown) {
  return resolveSelectedModel(resolveModelCatalog(context), requested);
}

/**
 * What to call the running model when the agent is asked. The composer already
 * shows this label, and the agent has to say the same words the user is looking
 * at — a raw ID would name the platform tier no user-facing string names.
 */
export function resolveRunningModelLabel(context: any, model: string) {
  return resolveModelLabel(resolveModelCatalog(context), model);
}

/** The slice of the SDK's per-model usage this report reads. */
type ModelRunUsage = {
  cacheReadInputTokens?: number;
  cacheCreationInputTokens?: number;
};

/**
 * Which model actually served a finished run, against the one it asked for.
 *
 * `SDKResultMessage.modelUsage` is keyed by the served model ID, which makes it
 * the only ground truth available: every model reaches this harness through the
 * same Anthropic-shaped interface, so the agent's own account of which model it
 * is comes from that model's priors rather than from this run, and a gateway
 * quietly serving something else would look identical from the outside.
 */
export function describeModelRun(
  requested: string,
  modelUsage: Record<string, ModelRunUsage> | undefined,
) {
  const entries = Object.entries(modelUsage || {});
  const served = entries.map(([id]) => id);
  const total = (key: keyof ModelRunUsage) => entries
    .reduce((sum, [, usage]) => sum + (Number(usage?.[key]) || 0), 0);

  return {
    // The cache counters travel with it because the system prompt is a ~20k
    // character prefix that is identical every turn: once past the first turn
    // of a conversation, a read far larger than the write is what says the
    // provider is reusing it rather than re-reading it.
    line: `requested=${requested || '<default>'} served=${served.join(',') || '<unreported>'}`
      + ` cacheRead=${total('cacheReadInputTokens')} cacheWrite=${total('cacheCreationInputTokens')}`,
    // An empty report is the sandbox not telling us, not a substitution.
    mismatch: served.length > 0 && !served.includes(requested),
  };
}
