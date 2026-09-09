'use client';

import { ArrowLeft, MessageCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { LanguageSwitch } from '@/app/components/language-switch';
import type { Locale, UiCopy } from '@/app/i18n';

type SiteHeaderProps = {
  copy: UiCopy;
  language: Locale;
  hasWorkspace: boolean;
  contactUrl: string;
  templateSourceUrl: string;
  templateDeployUrl: string;
  onLanguageChange: (language: Locale) => void;
  onBack: () => void;
};

/**
 * lucide dropped its brand marks, and a generic branch or fork glyph would not
 * read as "the code is on GitHub" — which is the entire point of the link.
 */
function GithubMark() {
  return (
    <svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.07-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82a7.42 7.42 0 0 1 2-.27c.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A7.995 7.995 0 0 0 16 8c0-4.42-3.58-8-8-8Z" />
    </svg>
  );
}

export function SiteHeader({
  copy,
  language,
  hasWorkspace,
  contactUrl,
  templateSourceUrl,
  templateDeployUrl,
  onLanguageChange,
  onBack,
}: SiteHeaderProps) {
  const isZh = language === 'zh';

  return (
    <header className="site-topbar">
      <div className="site-brand-cluster">
        {hasWorkspace && (
          <span className="site-hint is-start" data-hint={copy.workspace.back}>
            <button
              type="button"
              onClick={onBack}
              className="site-icon-button is-ghost"
              aria-label={copy.workspace.back}
            >
              <ArrowLeft />
            </button>
          </span>
        )}
        <div className="site-brand" aria-label="MAKERS VIBE CODING">MAKERS VIBE CODING</div>
        <span className="site-brand-tag">{copy.brandTag}</span>
      </div>
      <div className="site-topbar-actions">
        {!hasWorkspace && (
          <LanguageSwitch
            language={language}
            onChange={onLanguageChange}
            ariaLabel={copy.languageToggleAria}
            className="site-language"
          />
        )}
        {/* Everything in this bar is now about the template rather than about the
            session, so all of it stays put whether or not a project exists.
            Reading the code first, then taking a copy, then talking to us. */}
        <div className="site-topbar-group">
          <span className="site-hint" data-hint={copy.templateSourceLabel}>
            <a
              href={templateSourceUrl}
              target="_blank"
              rel="noreferrer"
              className="site-icon-button"
              aria-label={copy.templateSourceLabel}
            >
              <GithubMark />
            </a>
          </span>
        </div>
        <div className="site-topbar-group">
          <a
            href={templateDeployUrl}
            target="_blank"
            rel="noreferrer"
            className="site-primary-button"
          >
            {copy.templateDeployLabel}
          </a>
          <Dialog>
            <DialogTrigger asChild>
              <button type="button" className="site-accent-button">
                {isZh ? '联系我们' : 'Contact'}
              </button>
            </DialogTrigger>
            <DialogContent
              className="contact-dialog"
              overlayClassName="contact-dialog-overlay"
              showCloseButton={false}
            >
              <DialogHeader>
                <div className="contact-dialog-icon" aria-hidden="true"><MessageCircle /></div>
                <DialogTitle>
                  {isZh ? '集成平台化部署能力' : 'Integrate deployment capabilities'}
                </DialogTitle>
                <DialogDescription>
                  {isZh
                    ? '希望把代码生成、实时预览与全球加速部署能力集成到你自己的产品中？我们提供开放 API 与专属技术支持，可根据你的业务场景定制接入方案。欢迎与我们联系，一起聊聊具体需求。'
                    : "Want to bring code generation, live preview, and globally accelerated deployment into your own product? We provide open APIs and dedicated technical support tailored to your business needs. Get in touch and let's talk."}
                </DialogDescription>
              </DialogHeader>
              <DialogFooter className="contact-dialog-footer">
                <DialogClose asChild>
                  <Button variant="outline">{isZh ? '取消' : 'Cancel'}</Button>
                </DialogClose>
                <Button asChild>
                  <a href={contactUrl} target="_blank" rel="noreferrer">
                    {isZh ? '联系我们' : 'Contact us'}
                  </a>
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        </div>
      </div>
    </header>
  );
}
