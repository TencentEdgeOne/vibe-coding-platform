'use client';

import type { FormEvent, KeyboardEvent } from 'react';
import { Bot, Globe, Server, Sparkles, SquareTerminal } from 'lucide-react';
import type { HomeFeatureIcon, Locale, UiCopy } from '@/app/i18n';
import { ModelPicker } from '@/app/components/model-picker';
import type { ModelOption } from '../../../../shared/models';

type HomeStageProps = {
  copy: UiCopy;
  locale: Locale;
  input: string;
  placeholder: string;
  canSend: boolean;
  loading: boolean;
  models: readonly ModelOption[];
  model: string;
  onModelChange: (model: string) => void;
  onInputChange: (value: string) => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  onSend: () => void;
};

// lucide fits every glyph to the same 24×24 box but they fill very different
// amounts of it, so one shared size draws them at visibly different weights.
// These are matched on each drawing's own extent instead: Server and Globe
// reach all four edges of the box, Bot reaches 18–20, so the sparser ones are
// set larger to land at the same optical size.
//
// Plain `Terminal` is not used for the same reason. Its extent is 16×14 — about
// half the ink of Server — and closing that by size alone would have scaled its
// stroke up with it, trading a size mismatch for a weight mismatch.
function FeatureIcon({ icon }: { icon: HomeFeatureIcon }) {
  if (icon === 'agent') return <Bot aria-hidden="true" size={16.5} />;
  if (icon === 'functions') return <Server aria-hidden="true" size={15} />;
  if (icon === 'edge') return <Globe aria-hidden="true" size={15} />;
  return <SquareTerminal aria-hidden="true" size={16.5} />;
}

// What makes the four cells read as one ordered run rather than four unordered
// claims. A phase ribbon above the title used to carry this, but it named the
// same four phases the subtitle already describes and the cells below already
// carry, so the ordinal moved down to the one place that also says what happens
// in each phase.
function phaseNumber(index: number) {
  return String(index + 1).padStart(2, '0');
}

export function HomeStage({
  copy,
  locale,
  input,
  placeholder,
  canSend,
  loading,
  models,
  model,
  onModelChange,
  onInputChange,
  onSubmit,
  onSend,
}: HomeStageProps) {
  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      onSend();
    }
  };

  return (
    <section className="home-stage scroll-quiet">
      {/* my-auto centers the hero when it fits and keeps the top reachable when it
          does not, which justify-center would clip. */}
      <div className="home-inner my-auto">
        <h1 className="home-title">
          {copy.home.titleBefore}
          {locale === 'en' ? ' ' : ''}
          <span className="home-title-accent">{copy.home.titleAccent}</span>
          {locale === 'en' ? ' ' : ''}
          {copy.home.titleAfter}
        </h1>
        <p className="home-subtitle">{copy.home.subtitle}</p>

        <form className="home-composer" onSubmit={onSubmit}>
          <textarea
            value={input}
            onChange={(event) => onInputChange(event.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={placeholder || copy.home.placeholder}
            rows={3}
          />
          <div className="home-composer-actions">
            <div className="home-examples">
              {copy.home.examples.map((example) => (
                <button
                  key={example.label}
                  type="button"
                  className="home-example"
                  onClick={() => onInputChange(example.prompt)}
                >
                  {/* Carries the truncation itself: text sitting directly in a
                      flex container becomes an anonymous item, and text-overflow
                      does not inherit onto it, so the chip would clip its label
                      mid-character instead of ellipsizing it. */}
                  <span className="home-example-label">{example.label}</span>
                </button>
              ))}
            </div>
            {/* Sits with the submit button rather than among the example chips:
                both are about how this run happens, the chips are about what to
                ask for. */}
            <ModelPicker
              models={models}
              value={model}
              ariaLabel={copy.workspace.modelLabel}
              disabled={loading}
              onChange={onModelChange}
            />
            <button type="submit" disabled={!canSend} className="home-submit">
              {loading ? <span className="home-submit-spinner" /> : <Sparkles />}
              {copy.home.fastBuild}
            </button>
          </div>
        </form>

        {/* One cell per phase, in order, each carrying its own ordinal and
            saying what the platform does in that phase — the ordinals live
            only here now that the ribbon above the title is gone.
            Read-only — nothing here is a control. */}
        <ol className="home-features">
          {copy.home.features.map((feature, index) => (
            <li key={feature.title} className="home-feature">
              <span className="home-feature-index" aria-hidden="true">
                {phaseNumber(index)}
              </span>
              <span className="home-feature-copy">
                <strong>
                  <span className="home-feature-icon">
                    <FeatureIcon icon={feature.icon} />
                  </span>
                  {feature.title}
                </strong>
                <span className="home-feature-desc">{feature.desc}</span>
              </span>
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}
