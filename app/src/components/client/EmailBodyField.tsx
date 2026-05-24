'use client';

import { useRef, useState } from 'react';
import { Link2, X } from 'lucide-react';

interface EmailBodyFieldProps {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  rows?: number;
  className?: string;
}

/** Грубая проверка «похоже на ссылку»: домен с точкой, без пробелов. */
function looksLikeLink(raw: string): boolean {
  const s = raw.trim();
  if (!s || /\s/.test(s)) return false;
  const withProtocol = /^https?:\/\//i.test(s) ? s : `https://${s}`;
  try {
    return new URL(withProtocol).hostname.includes('.');
  } catch {
    return false;
  }
}

/**
 * Поле текста письма + inline-форма «Вставить ссылку».
 *
 * UTM-метки клиент проставляет на ссылку сам (своим конструктором / Campaign
 * URL Builder и т.п.) и вставляет УЖЕ ГОТОВУЮ ссылку. Кнопка раскрывает
 * inline-форму прямо под textarea — без модалки, без scrim'а: текст письма
 * всегда виден, фокус не теряется, Esc закрывает, Enter вставляет.
 *
 * Раньше это была full-screen модалка со stale tokens (`--cp-accent`,
 * `--cp-text`, `--cp-text-m`) и warm-stone classes (neu-input/pill/btn) —
 * absolute-ban «modal as first thought» + off-doctrine в conversion path
 * (см. /impeccable critique 2026-05-24).
 *
 * HTML не используется — ссылка остаётся обычным текстом (письма plain-text).
 */
export function EmailBodyField({
  value,
  onChange,
  placeholder,
  rows = 6,
  className,
}: EmailBodyFieldProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const linkInputRef = useRef<HTMLInputElement>(null);
  const [sel, setSel] = useState({ start: 0, end: 0 });
  const [open, setOpen] = useState(false);
  const [link, setLink] = useState('');

  const openInline = () => {
    const ta = textareaRef.current;
    const start = ta?.selectionStart ?? 0;
    const end = ta?.selectionEnd ?? 0;
    setSel({ start, end });
    // Если клиент выделил фрагмент в тексте — подставим его как ссылку.
    setLink(value.slice(start, end).trim());
    setOpen(true);
    // Focus инпута после монтирования (rAF чтобы поймать ref).
    requestAnimationFrame(() => linkInputRef.current?.focus());
  };

  const closeInline = () => {
    setOpen(false);
    setLink('');
    requestAnimationFrame(() => textareaRef.current?.focus());
  };

  const canInsert = looksLikeLink(link);

  const insert = () => {
    if (!canInsert) return;
    const clean = link.trim();
    onChange(value.slice(0, sel.start) + clean + value.slice(sel.end));
    setOpen(false);
    setLink('');
    const caret = sel.start + clean.length;
    requestAnimationFrame(() => {
      const ta = textareaRef.current;
      if (ta) {
        ta.focus();
        ta.setSelectionRange(caret, caret);
      }
    });
  };

  return (
    <div className="mt-3">
      <textarea
        ref={textareaRef}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onSelect={(e) =>
          setSel({ start: e.currentTarget.selectionStart, end: e.currentTarget.selectionEnd })
        }
        placeholder={placeholder}
        rows={rows}
        className={className}
      />
      {!open ? (
        <button
          type="button"
          onClick={openInline}
          className="mt-1.5 inline-flex items-center gap-1.5 text-[11px] font-semibold"
          style={{ color: 'var(--cp-paper)' }}
        >
          <Link2 className="h-3 w-3" aria-hidden />
          Вставить ссылку
        </button>
      ) : (
        <div
          className="mt-2 rounded-md p-3 space-y-2"
          style={{
            background: 'var(--cp-surface-rest)',
            border: '1px solid var(--cp-divider)',
          }}
          role="group"
          aria-label="Вставить ссылку"
        >
          <div className="flex items-center justify-between">
            <p
              className="text-xs font-semibold m-0"
              style={{ color: 'var(--cp-paper)' }}
            >
              Вставить ссылку
            </p>
            <button
              type="button"
              onClick={closeInline}
              className="ds-btn-ghost p-1"
              aria-label="Отмена"
            >
              <X className="h-3 w-3" aria-hidden />
            </button>
          </div>
          <p className="text-[11px] m-0" style={{ color: 'var(--cp-paper-mute)' }}>
            Вставьте готовую ссылку (с UTM-метками, если нужно). Она встанет в текст письма — заменит выделенный фрагмент или вставится в позицию курсора.
          </p>
          <div className="flex gap-2">
            <input
              ref={linkInputRef}
              type="text"
              value={link}
              onChange={(e) => setLink(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && canInsert) insert();
                else if (e.key === 'Escape') closeInline();
              }}
              placeholder="https://polzaagency.ru/?utm_source=email&utm_campaign=..."
              className="ds-input flex-1 px-3 py-2 text-sm"
              style={{ color: 'var(--cp-paper)' }}
            />
            <button
              type="button"
              onClick={insert}
              disabled={!canInsert}
              className="ds-btn-primary px-3 py-2 text-xs font-semibold disabled:opacity-50 shrink-0"
            >
              Вставить
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
