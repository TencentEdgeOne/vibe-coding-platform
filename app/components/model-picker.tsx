'use client';

import { Check, ChevronDown } from 'lucide-react';
import { useEffect, useId, useRef, useState } from 'react';
import type { ModelOption } from '../../shared/models';

/**
 * Model switcher for both composers.
 *
 * A listbox rather than a native `<select>`: the native popup is drawn by the
 * operating system, so it arrives in the OS font at the OS width with the OS
 * highlight, and lands in the middle of a composer that is styled to the pixel.
 * The cost of replacing it is that keyboard support, the selected-option
 * marker, and dismissal are now this file's problem rather than the platform's,
 * which is what the rest of this component is.
 *
 * Only ever renders `label`, never `id`. The built-in IDs are scoped with the
 * platform tier, which no user-facing string in this product names.
 */
export function ModelPicker({
  models,
  value,
  ariaLabel,
  disabled,
  onChange,
}: {
  models: readonly ModelOption[];
  value: string;
  ariaLabel: string;
  disabled?: boolean;
  onChange: (model: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const rootRef = useRef<HTMLSpanElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const listId = useId();

  const selectedIndex = Math.max(0, models.findIndex((model) => model.id === value));

  // A pointer press outside is a dismissal, including one that lands on the
  // textarea: the user is going back to typing, not choosing a model.
  useEffect(() => {
    if (!open) return undefined;
    const dismiss = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', dismiss);
    return () => document.removeEventListener('pointerdown', dismiss);
  }, [open]);

  // The list takes focus so it can own the arrow keys, and gives it back to the
  // trigger on close; without that, dismissing sends focus to the top of the
  // document and the next Tab restarts from the page header.
  useEffect(() => {
    if (open) listRef.current?.focus();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    listRef.current
      ?.querySelector(`[data-index="${activeIndex}"]`)
      ?.scrollIntoView({ block: 'nearest' });
  }, [open, activeIndex]);

  // Disabling mid-turn while the list is open would otherwise leave it hanging
  // over a composer that no longer answers.
  useEffect(() => {
    if (disabled) setOpen(false);
  }, [disabled]);

  // Nothing to switch between: a picker with one entry is a label that looks
  // like a control. Also covers the window before /models answers.
  if (models.length < 2) {
    return null;
  }

  const selected = models[selectedIndex];

  const close = () => {
    setOpen(false);
    triggerRef.current?.focus();
  };

  const commit = (index: number) => {
    const option = models[index];
    if (option) onChange(option.id);
    close();
  };

  const openAt = (index: number) => {
    setActiveIndex(index);
    setOpen(true);
  };

  return (
    <span
      className={`model-picker${disabled ? ' model-picker-disabled' : ''}`}
      ref={rootRef}
    >
      <button
        type="button"
        className="model-picker-trigger"
        ref={triggerRef}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={ariaLabel}
        disabled={disabled}
        onClick={() => (open ? setOpen(false) : openAt(selectedIndex))}
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault();
            openAt(selectedIndex);
          }
        }}
      >
        <span className="model-picker-value">{selected.label}</span>
        <ChevronDown aria-hidden="true" size={13} />
      </button>

      {open && (
        <ul
          className="model-picker-menu"
          ref={listRef}
          id={listId}
          role="listbox"
          tabIndex={-1}
          aria-label={ariaLabel}
          aria-activedescendant={`${listId}-${activeIndex}`}
          onKeyDown={(event) => {
            switch (event.key) {
              case 'ArrowDown':
                event.preventDefault();
                setActiveIndex((index) => Math.min(models.length - 1, index + 1));
                break;
              case 'ArrowUp':
                event.preventDefault();
                setActiveIndex((index) => Math.max(0, index - 1));
                break;
              case 'Home':
                event.preventDefault();
                setActiveIndex(0);
                break;
              case 'End':
                event.preventDefault();
                setActiveIndex(models.length - 1);
                break;
              case 'Enter':
              case ' ':
                event.preventDefault();
                commit(activeIndex);
                break;
              case 'Escape':
                event.preventDefault();
                close();
                break;
              case 'Tab':
                setOpen(false);
                break;
              default:
                break;
            }
          }}
        >
          {models.map((model, index) => (
            <li
              key={model.id}
              id={`${listId}-${index}`}
              data-index={index}
              role="option"
              aria-selected={index === selectedIndex}
              className={`model-picker-option${index === activeIndex ? ' is-active' : ''}`}
              // Pointer, not hover: the highlight follows the input the user is
              // actually driving, so an arrow key does not fight the last place
              // the mouse happened to rest.
              onPointerMove={() => setActiveIndex(index)}
              onClick={() => commit(index)}
            >
              <Check className="model-picker-check" aria-hidden="true" size={13} />
              <span className="model-picker-option-label">{model.label}</span>
            </li>
          ))}
        </ul>
      )}
    </span>
  );
}
