'use client';

import { cn } from '@/lib/utils';
import type { Locale } from '../i18n';

const OPTIONS: { value: Locale; label: string }[] = [
  { value: 'zh', label: '中文' },
  { value: 'en', label: 'EN' },
];

export function LanguageSwitch({
  language,
  onChange,
  ariaLabel,
  className = '',
}: {
  language: Locale;
  onChange: (next: Locale) => void;
  ariaLabel: string;
  className?: string;
}) {
  return (
    <div
      role="group"
      aria-label={ariaLabel}
      className={cn('site-lang-toggle', className)}
    >
      {OPTIONS.map((option) => {
        const active = language === option.value;
        return (
          <button
            key={option.value}
            type="button"
            aria-pressed={active}
            onClick={() => onChange(option.value)}
            className={cn('site-lang-option', active && 'is-active')}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}
