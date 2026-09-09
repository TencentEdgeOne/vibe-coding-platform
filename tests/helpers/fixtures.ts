import type { ProjectState } from '../../agents/_types.ts';

/**
 * A scaffolded project, as the pipelines see one. Lives here because four test
 * files had grown their own copy of the same three fields, and a change to
 * ProjectState had to be made in all of them or in none.
 *
 * `sessionDir` is a parameter because the deploy tests derive a project name
 * from it; everything else is overridable for the cases that need a preview or
 * a deployment attached.
 */
export function projectState(
  sessionDir = 'projects/demo',
  overrides: Partial<ProjectState> = {},
): ProjectState {
  return {
    created: true,
    sessionDir,
    appDir: `${sessionDir}/app`,
    ...overrides,
  };
}
