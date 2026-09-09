/**
 * The models the composer offers and the runtime accepts.
 *
 * Both ends read this file: the browser renders the picker from it and the agent
 * runtime validates the choice that comes back against it. One list is what
 * keeps the UI from offering a model the server would refuse.
 *
 * Keep this module runtime-agnostic: no React, Next.js, or EdgeOne imports.
 */

export type ModelOption = {
  /** Sent to the gateway verbatim; must match the platform's ID exactly. */
  id: string;
  /**
   * What the picker shows. Deliberately not the ID: the built-in IDs are scoped
   * with the platform tier, and no user-facing string in this product names it.
   */
  label: string;
};

/** Runs when the deployment configures nothing and the user picks nothing. */
export const DEFAULT_MODEL = '@makers/deepseek-v4-flash';

/**
 * The models the platform serves without a vendor key. Free and rate limited,
 * which is what makes them the right menu for a template someone is trying out.
 *
 * Vendor models (`deepseek/...`, `openai/...`) reach the same gateway but bill
 * against a key bound in the console, so they are not listed here by default —
 * a deployment that has bound one adds it through EXTRA_MODELS_ENV_KEY.
 */
export const BUILT_IN_MODELS: readonly ModelOption[] = [
  { id: '@makers/deepseek-v4-flash', label: 'DeepSeek V4 Flash' },
  { id: '@makers/deepseek-v4-pro', label: 'DeepSeek V4 Pro' },
  { id: '@makers/hy3', label: 'Hunyuan 3' },
  { id: '@makers/hy3-preview', label: 'Hunyuan 3 Preview' },
  { id: '@makers/minimax-m3', label: 'MiniMax M3' },
  { id: '@makers/minimax-m2.7', label: 'MiniMax M2.7' },
  { id: '@makers/kimi-k2.6', label: 'Kimi K2.6' },
];

export const EXTRA_MODELS_ENV_KEY = 'AI_GATEWAY_EXTRA_MODELS';

/**
 * A readable stand-in when an entry carries no label. Drops a leading `@scope/`,
 * which is where the built-in IDs carry the platform tier.
 */
function fallbackLabel(id: string) {
  return id.replace(/^@[^/]+\//, '') || id;
}

/**
 * What to call a model in front of the user: the catalogue's label, or a
 * readable form of an ID this deployment runs without listing. Never the raw
 * ID, which is where the built-in models carry the platform tier.
 */
export function resolveModelLabel(catalog: readonly ModelOption[], id: unknown): string {
  const trimmed = typeof id === 'string' ? id.trim() : '';
  if (!trimmed) return '';
  return catalog.find((option) => option.id === trimmed)?.label || fallbackLabel(trimmed);
}

/**
 * Comma-separated `id|Label` pairs, label optional:
 *
 *   AI_GATEWAY_EXTRA_MODELS="deepseek/deepseek-v4-pro|DeepSeek V4 Pro (vendor)"
 *
 * Entries must be reachable through the configured gateway. One API key and one
 * base URL serve every model in the picker, so this extends the choice of model,
 * not the choice of provider.
 */
export function parseExtraModels(raw: unknown): ModelOption[] {
  if (typeof raw !== 'string' || !raw.trim()) {
    return [];
  }
  return raw
    .split(',')
    .map((entry) => {
      const separator = entry.indexOf('|');
      const id = (separator === -1 ? entry : entry.slice(0, separator)).trim();
      const label = separator === -1 ? '' : entry.slice(separator + 1).trim();
      return { id, label: label || fallbackLabel(id) };
    })
    .filter((option) => Boolean(option.id));
}

/**
 * The picker's menu for this deployment, in display order. Duplicate IDs collapse
 * to their first occurrence so a configured or extra model cannot appear twice.
 */
export function buildModelCatalog(options: {
  /** Whatever AI_GATEWAY_MODEL and its fallbacks resolved to. */
  configuredModel?: string;
  /** Raw EXTRA_MODELS_ENV_KEY value. */
  extraModels?: string;
} = {}): ModelOption[] {
  const catalog: ModelOption[] = [];
  const seen = new Set<string>();
  const add = (option: ModelOption) => {
    if (seen.has(option.id)) return;
    seen.add(option.id);
    catalog.push(option);
  };

  // The configured model leads the list even when it is not a built-in: it is
  // what this deployment already runs, so a picker that omitted it could only
  // ever change behaviour, never preserve it.
  const configured = (options.configuredModel || '').trim();
  if (configured) {
    const known = BUILT_IN_MODELS.find((option) => option.id === configured);
    add(known || { id: configured, label: fallbackLabel(configured) });
  }
  for (const option of BUILT_IN_MODELS) add(option);
  for (const option of parseExtraModels(options.extraModels)) add(option);
  return catalog;
}

/**
 * The requested model, or '' when this deployment does not offer it. Callers
 * treat '' as "no choice" and fall back to the configured default, so an
 * unrecognized ID never reaches the gateway.
 */
export function resolveSelectedModel(
  catalog: readonly ModelOption[],
  requested: unknown,
): string {
  if (typeof requested !== 'string') return '';
  const trimmed = requested.trim();
  if (!trimmed) return '';
  return catalog.some((option) => option.id === trimmed) ? trimmed : '';
}
