import { randomUUID } from 'node:crypto';
import { Makers, MakersError } from '@edgeone/makers-sdk';
import type { ProjectState } from '../_types.ts';

// Every preview start, wrapped CLI call and deploy mints its own token, so this
// only has to outlive a single CLI invocation. An hour is already far more than
// that, which leaves nothing here worth configuring.
const SUB_TOKEN_TTL_SECONDS = 60 * 60;

let cachedPlatformClient: { masterToken: string; client: Makers } | null = null;

function pickEnvValue(context: any, key: string) {
  const value = context?.env?.[key];
  return typeof value === 'string' ? value.trim() : '';
}

export function resolveMakersMasterToken(context: any) {
  return pickEnvValue(context, 'API_TOKEN');
}

export function ensureMakersTenantId(state: ProjectState) {
  if (state.makersTenantId) {
    return state.makersTenantId;
  }

  // This identifier is persisted with project state but is not a credential.
  // Keeping it server-generated prevents a client-controlled conversation ID
  // from selecting another tenant.
  const tenantId = `vibe-${randomUUID().replaceAll('-', '')}`;
  state.makersTenantId = tenantId;
  return tenantId;
}

function getPlatformClient(masterToken: string) {
  if (cachedPlatformClient?.masterToken === masterToken) {
    return cachedPlatformClient.client;
  }

  // No host and no region: a production token finds its own home, because the
  // SDK probes the China endpoint first and caches whichever one answers.
  const client = new Makers({ token: masterToken });
  cachedPlatformClient = { masterToken, client };
  return client;
}

// The activity scrubber blanks whatever follows a "token:" label, so a message
// ending in one turns the actual cause into [REDACTED] before anyone reads it.
function formatTokenIssueError(error: unknown) {
  if (error instanceof MakersError) {
    const details = [
      error.message,
      error.code ? `code=${error.code}` : '',
      error.requestId ? `requestId=${error.requestId}` : '',
    ].filter(Boolean).join(', ');
    return `Failed to issue a temporary Makers tenant credential. ${details}`;
  }
  return `Failed to issue a temporary Makers tenant credential. ${
    error instanceof Error ? error.message : String(error)
  }`;
}

export async function issueSandboxMakersSubToken(
  state: ProjectState,
  masterToken: string,
) {
  if (!masterToken) {
    throw new Error('Missing API_TOKEN in the Agent Runtime.');
  }

  const tenantId = ensureMakersTenantId(state);
  try {
    return await getPlatformClient(masterToken).tokens.create({
      tenantId,
      name: `vibe-coding-${tenantId}`,
      expiresIn: SUB_TOKEN_TTL_SECONDS,
    });
  } catch (error) {
    throw new Error(formatTokenIssueError(error));
  }
}

/**
 * The single decision about which credential reaches the sandbox.
 *
 * API_TOKEN never leaves the Agent Runtime: the CLI only ever sees a
 * short-lived token scoped to this conversation's tenant, injected as
 * EDGEONE_PAGES_API_TOKEN — the name the sandbox CLI still reads.
 */
export async function resolveSandboxMakersToken(
  state: ProjectState,
  masterToken: string,
) {
  // Nothing configured to exchange. Let the CLI report the missing credential
  // in its own words instead of failing the turn on a token request that was
  // never going to succeed.
  if (!masterToken) {
    return '';
  }
  return (await issueSandboxMakersSubToken(state, masterToken)).token;
}

export function buildSandboxMakersEnv(sandboxToken = ''): Record<string, string> {
  return {
    PAGES_SOURCE: 'skills',
    ...(sandboxToken ? { EDGEONE_PAGES_API_TOKEN: sandboxToken } : {}),
    // A generated project that imports @edgeone/pages-blob trades the API token
    // for storage credentials on every request, and that exchange is scoped to
    // this variable. Deploys never perform it — the pipeline substitutes a
    // credential into the artifact instead — which is why a store that works on
    // the live site answers CREDENTIAL_ERROR in preview once the two ends
    // disagree. Unset, the value comes from a constant compiled into the
    // sandbox CLI, so it is pinned here rather than trusting whichever
    // environment that CLI happened to be built for.
    PAGES_BLOB_STS_ENV: 'prod',
  };
}
