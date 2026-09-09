'use client';

import { useEffect, useState } from 'react';

// Typewriter placeholder: types each phrase left-to-right, holds, deletes, then
// cycles to the next (mirrors the script in plan/design-mockup.html). Returns a
// static first phrase when the user prefers reduced motion, and idles (keeps the
// last rendered text) whenever `enabled` is false.
export function useTypewriterPlaceholder(phrases: readonly string[], enabled: boolean) {
  const [text, setText] = useState('');

  useEffect(() => {
    if (!enabled || phrases.length === 0) {
      return;
    }

    const prefersReducedMotion =
      typeof window !== 'undefined'
      && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (prefersReducedMotion) {
      setText(phrases[0]);
      return;
    }

    let phraseIndex = 0;
    let charIndex = 0;
    let deleting = false;
    let timer = 0;

    const tick = () => {
      const full = phrases[phraseIndex];
      if (!deleting) {
        charIndex += 1;
        setText(full.slice(0, charIndex));
        if (charIndex === full.length) {
          deleting = true;
          timer = window.setTimeout(tick, 1600);
          return;
        }
        timer = window.setTimeout(tick, 70);
      } else {
        charIndex -= 1;
        setText(full.slice(0, charIndex));
        if (charIndex === 0) {
          deleting = false;
          phraseIndex = (phraseIndex + 1) % phrases.length;
          timer = window.setTimeout(tick, 400);
          return;
        }
        timer = window.setTimeout(tick, 35);
      }
    };

    setText('');
    timer = window.setTimeout(tick, 70);
    return () => window.clearTimeout(timer);
  }, [enabled, phrases]);

  return text;
}
