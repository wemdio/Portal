'use client';

import { useRef, useState } from 'react';
import { Link2 } from 'lucide-react';

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
 * Поле текста письма + кнопка «Вставить ссылку».
 *
 * UTM-метки клиент проставляет на ссылку сам (своим конструктором / Campaign
 * URL Builder и т.п.) и вставляет УЖЕ ГОТОВУЮ ссылку. Кнопка открывает окно
 * с одним полем: вставил ссылку → «Вставить» помещает её в текст письма —
 * заменяет выделенный фрагмент или встаёт в позицию курсора.
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
  const [sel, setSel] = useState({ start: 0, end: 0 });
  const [open, setOpen] = useState(false);
  const [link, setLink] = useState('');

  const openModal = () => {
    const ta = textareaRef.current;
    const start = ta?.selectionStart ?? 0;
    const end = ta?.selectionEnd ?? 0;
    setSel({ start, end });
    // Если клиент выделил фрагмент в тексте — подставим его как ссылку.
    setLink(value.slice(start, end).trim());
    setOpen(true);
  };

  const canInsert = looksLikeLink(link);

  const insert = () => {
    if (!canInsert) return;
    const clean = link.trim();
    onChange(value.slice(0, sel.start) + clean + value.slice(sel.end));
    setOpen(false);
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
      <button
        type="button"
        onClick={openModal}
        className="mt-1.5 inline-flex items-center gap-1.5 text-[11px] font-semibold"
        style={{ color: 'var(--cp-accent)' }}
      >
        <Link2 className="h-3 w-3" />
        Вставить ссылку
      </button>

      {open && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4"
          onClick={() => setOpen(false)}
        >
          <div
            className="neu-card w-full max-w-md p-5"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="text-sm font-bold mb-1" style={{ color: 'var(--cp-text)' }}>
              Вставить ссылку
            </h3>
            <p className="text-[11px] mb-3" style={{ color: 'var(--cp-text-m)' }}>
              Вставьте готовую ссылку (с UTM-метками, если нужно). Она встанет в текст
              письма — заменит выделенный фрагмент или вставится в позицию курсора.
            </p>
            <input
              type="text"
              value={link}
              onChange={(e) => setLink(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && canInsert) insert();
              }}
              placeholder="https://polzaagency.ru/?utm_source=email&utm_campaign=..."
              autoFocus
              className="neu-input w-full px-3 py-2 text-sm mb-4"
            />
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setOpen(false)}
                className="neu-pill px-3 py-1.5 text-xs font-semibold"
                style={{ color: 'var(--cp-text-m)' }}
              >
                Отмена
              </button>
              <button
                type="button"
                onClick={insert}
                disabled={!canInsert}
                className="neu-btn px-3 py-1.5 text-xs font-semibold disabled:opacity-50"
              >
                Вставить в письмо
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
