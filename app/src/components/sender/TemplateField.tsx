'use client';

import { useState, type KeyboardEvent, type RefObject } from 'react';
import { varKey } from '@/lib/sender/templateVars';
import type { RecipientVariableDto } from './api';

type FieldElement = HTMLInputElement | HTMLTextAreaElement;

/** Недописанная переменная перед кареткой: «…{{комп» → «комп». */
function openToken(text: string, caret: number): { start: number; query: string } | null {
  const match = /\{\{([^{}]*)$/.exec(text.slice(0, caret));
  return match ? { start: match.index, query: match[1] } : null;
}

/**
 * Вставляет {{key}} на место каретки (или вместо недописанной «{{…»)
 * и возвращает новый текст и позицию каретки после вставки.
 */
export function insertVariable(
  text: string,
  caret: number,
  key: string,
): { text: string; caret: number } {
  const token = openToken(text, caret);
  const start = token ? token.start : caret;
  // Если закрывающие скобки уже стоят сразу за кареткой — не дублируем их.
  const end = text.slice(caret).startsWith('}}') && token ? caret + 2 : caret;
  const inserted = `{{${key}}}`;
  return { text: text.slice(0, start) + inserted + text.slice(end), caret: start + inserted.length };
}

export function placeCaret(el: FieldElement | null, caret: number) {
  if (!el) return;
  // После setState текст в поле обновится только на следующем кадре.
  requestAnimationFrame(() => {
    el.focus();
    el.setSelectionRange(caret, caret);
  });
}

/**
 * Поле темы/текста письма с подсказкой переменных: набрали «{{» — под полем
 * список колонок загруженной базы, стрелки выбирают, Enter или Tab вставляет.
 */
export function TemplateField({
  multiline,
  value,
  onChange,
  variables,
  fieldRef,
  onFocus,
  placeholder,
  rows,
  className,
}: {
  multiline?: boolean;
  value: string;
  onChange: (value: string) => void;
  variables: RecipientVariableDto[];
  fieldRef: RefObject<FieldElement | null>;
  onFocus?: () => void;
  placeholder: string;
  rows?: number;
  className: string;
}) {
  const [query, setQuery] = useState<string | null>(null);
  const [active, setActive] = useState(0);

  const normalized = query == null ? '' : varKey(query);
  const suggestions =
    query == null
      ? []
      : variables.filter(
          (v) =>
            !normalized ||
            v.key.includes(normalized) ||
            (v.header ?? '').toLowerCase().includes(query.trim().toLowerCase()),
        );
  const open = suggestions.length > 0;

  const refresh = (el: FieldElement) => {
    const token = openToken(el.value, el.selectionStart ?? el.value.length);
    setQuery(token ? token.query : null);
    setActive(0);
  };

  const choose = (key: string) => {
    const el = fieldRef.current;
    const caret = el?.selectionStart ?? value.length;
    const next = insertVariable(value, caret, key);
    onChange(next.text);
    setQuery(null);
    placeCaret(el, next.caret);
  };

  const handleKeyDown = (e: KeyboardEvent<FieldElement>) => {
    if (!open) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const step = e.key === 'ArrowDown' ? 1 : -1;
      setActive((i) => (i + step + suggestions.length) % suggestions.length);
    } else if (e.key === 'Enter' || e.key === 'Tab') {
      e.preventDefault();
      choose(suggestions[Math.min(active, suggestions.length - 1)].key);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      setQuery(null);
    }
  };

  const common = {
    value,
    placeholder,
    className,
    onFocus,
    onKeyDown: handleKeyDown,
    onChange: (e: { target: FieldElement }) => {
      onChange(e.target.value);
      refresh(e.target);
    },
    onClick: (e: { currentTarget: FieldElement }) => refresh(e.currentTarget),
    // Задержка — чтобы клик по подсказке успел сработать до закрытия списка.
    onBlur: () => window.setTimeout(() => setQuery(null), 150),
  };

  return (
    <div className="relative">
      {multiline ? (
        <textarea ref={fieldRef as RefObject<HTMLTextAreaElement>} rows={rows} {...common} />
      ) : (
        <input ref={fieldRef as RefObject<HTMLInputElement>} {...common} />
      )}
      {open ? (
        <div className="absolute left-0 right-0 z-20 mt-1 max-h-56 overflow-y-auto rounded-lg border border-zinc-200 bg-white py-1 shadow-lg">
          {suggestions.map((v, i) => (
            <button
              key={v.key}
              type="button"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => choose(v.key)}
              className={`flex w-full items-baseline gap-2 px-3 py-1.5 text-left text-sm ${
                i === active ? 'bg-blue-50' : 'hover:bg-zinc-50'
              }`}
            >
              <span className="font-mono text-blue-700">{`{{${v.key}}}`}</span>
              <span className="truncate text-xs text-zinc-500">
                {v.sample ? `например: ${v.sample}` : 'пусто у всех'}
              </span>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
