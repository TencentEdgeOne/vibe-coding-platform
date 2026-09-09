'use client';

import { memo } from 'react';
import { Button } from '@/components/ui/button';

export type PreviewViewport = 'desktop' | 'mobile';

export type PreviewFrameCopy = {
  unavailable: string;
  loading: string;
  retry: string;
};

type PreviewFrameProps = {
  activeUrl: string;
  activeRevision: number;
  /** The next preview, loading behind the active one so a refresh cannot flash. */
  pendingUrl: string;
  pendingRevision: number;
  viewport: PreviewViewport;
  loaded: boolean;
  refreshing: boolean;
  refreshFailed: boolean;
  copy: PreviewFrameCopy;
  onActiveLoad: () => void;
  onPendingLoad: () => void;
  onRetry: () => void;
};

// Memoized deliberately: this subtree owns two live iframes, and re-rendering it
// on every streamed chat token was enough to make the preview stutter while the
// agent talked. Every prop here is a primitive or a stable callback so the
// comparison actually holds.
export const PreviewFrame = memo(function PreviewFrame({
  activeUrl,
  activeRevision,
  pendingUrl,
  pendingRevision,
  viewport,
  loaded,
  refreshing,
  refreshFailed,
  copy,
  onActiveLoad,
  onPendingLoad,
  onRetry,
}: PreviewFrameProps) {
  return (
    <div className={`workspace-preview-shell is-${viewport}`}>
      <div className="workspace-preview-stage">
        <div className="workspace-preview-frame">
          {(!loaded || refreshing || refreshFailed) && (
            <div className={`workspace-preview-loading${refreshFailed ? ' is-actionable' : ''}`}>
              {/* Stacked only when there is an action: a lone sentence in a
                  column is the same box, and a button beside it is not. */}
              <div className={`workspace-preview-status${refreshFailed ? ' is-stacked' : ''}`}>
                <span>{refreshFailed ? copy.unavailable : copy.loading}</span>
                {refreshFailed && (
                  <Button size="sm" variant="outline" onClick={onRetry}>
                    {copy.retry}
                  </Button>
                )}
              </div>
            </div>
          )}
          {activeUrl && (
            <iframe
              key={`${activeUrl}:${activeRevision}`}
              title="sandbox-preview"
              src={activeUrl}
              onLoad={onActiveLoad}
              className="h-full w-full border-0"
            />
          )}
          {pendingUrl && (
            <iframe
              key={`pending:${pendingUrl}:${pendingRevision}`}
              title="sandbox-preview-pending"
              src={pendingUrl}
              onLoad={onPendingLoad}
              className="invisible pointer-events-none absolute inset-0 h-full w-full border-0"
            />
          )}
        </div>
      </div>
    </div>
  );
});
