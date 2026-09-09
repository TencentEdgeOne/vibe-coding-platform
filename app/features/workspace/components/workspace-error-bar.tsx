'use client';

type WorkspaceErrorBarProps = {
  build: string;
  preview: string;
  download: string;
};

/**
 * The three things that can go wrong without ending the turn. Rendering nothing
 * when they are all empty keeps the caller from having to repeat the condition
 * that decides whether the bar exists at all.
 */
export function WorkspaceErrorBar({ build, preview, download }: WorkspaceErrorBarProps) {
  if (!build && !preview && !download) {
    return null;
  }

  return (
    <div className="workspace-error-bar">
      {build && <p className="text-destructive">{build}</p>}
      {preview && <p>{preview}</p>}
      {download && <p>{download}</p>}
    </div>
  );
}
