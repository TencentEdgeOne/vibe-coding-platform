'use client';

import { memo } from 'react';
import { ExternalLink, Laptop, RefreshCw, Smartphone } from 'lucide-react';
import type { PreviewViewport } from './preview-frame';

export type PreviewControlsCopy = {
  viewportGroup: string;
  desktop: string;
  mobile: string;
  refresh: string;
  open: string;
  /** Shown on refresh and open while a publish has the dev server stopped. */
  pausedForDeploy: string;
};

type PreviewControlsProps = {
  viewport: PreviewViewport;
  /** A publish stops the dev server, so both links lead nowhere until it ends. */
  publishing: boolean;
  copy: PreviewControlsCopy;
  onViewportChange: (viewport: PreviewViewport) => void;
  onRefresh: () => void;
  onOpen: () => void;
};

export const PreviewControls = memo(function PreviewControls({
  viewport,
  publishing,
  copy,
  onViewportChange,
  onRefresh,
  onOpen,
}: PreviewControlsProps) {
  // Both of these lead to the stopped server while a publish runs. Reconnecting
  // is the worse of the two: it fails, and then reports an expired connection,
  // which is the one explanation that is not true here.
  const linkHint = publishing ? copy.pausedForDeploy : '';

  return (
    <div className="workspace-topbar-group">
      <div className="workspace-viewport-switch" role="group" aria-label={copy.viewportGroup}>
        <button
          type="button"
          aria-pressed={viewport === 'desktop'}
          aria-label={copy.desktop}
          onClick={() => onViewportChange('desktop')}
          title={copy.desktop}
        >
          <Laptop />
        </button>
        <button
          type="button"
          aria-pressed={viewport === 'mobile'}
          aria-label={copy.mobile}
          onClick={() => onViewportChange('mobile')}
          title={copy.mobile}
        >
          <Smartphone />
        </button>
      </div>
      <button
        type="button"
        onClick={onRefresh}
        disabled={publishing}
        className="workspace-icon-button"
        aria-label={linkHint || copy.refresh}
        data-tooltip={linkHint || copy.refresh}
      >
        <RefreshCw className="size-3.5" />
      </button>
      <button
        type="button"
        onClick={onOpen}
        disabled={publishing}
        className="workspace-icon-button"
        aria-label={linkHint || copy.open}
        data-tooltip={linkHint || copy.open}
      >
        <ExternalLink className="size-3.5" />
      </button>
    </div>
  );
});
