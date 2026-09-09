import { createHash } from 'node:crypto';
import type { ProjectState } from '../_types.ts';

// One project per conversation, for preview and deployment alike.
//
// Both CLI commands resolve a project by name and create it when the lookup
// misses, so the name decides which project the conversation owns. A name
// shared by every conversation cannot work: a tenant token only sees projects
// its own tenant created, so the lookup misses a project another tenant
// already holds, the create then collides with the existing name, and preview
// dies on "Failed to create pages project" before it starts. Deploy has the
// same shape with a worse ending — it would publish over someone else's live
// site.
//
// Being a pure function of the session directory, the name needs no storage:
// every turn of the same conversation resolves to the same project.
const PROJECT_NAME_PREFIX = 'vibe-coding';

function pickEnvValue(context: any, key: string) {
  const value = context?.env?.[key];
  return typeof value === 'string' ? value.trim() : '';
}

export function resolveMakersProjectName(context: any, state: ProjectState) {
  // An explicit name is an operator decision: honour it exactly, including the
  // consequence that every conversation then shares the one project.
  const pinned = pickEnvValue(context, 'MAKERS_DEPLOY_PROJECT_NAME');
  if (pinned) {
    return pinned;
  }

  // Hashed rather than embedded: the conversation ID ends up in a public
  // hostname once the project is deployed.
  const digest = createHash('sha256').update(state.sessionDir).digest('hex').slice(0, 10);
  return `${PROJECT_NAME_PREFIX}-${digest}`;
}
