'use client';

import { useRef, useState } from 'react';
import { Link2, X } from 'lucide-react';
import { buildMarkdownLink } from '@/lib/clientLaunch/linkSnippet';

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
 * Скрытая ссылка: клиент выделяет слово («наш сайт» / «Егор») и вставляет
 * URL — слово становится кликабельным, а URL скрыт от получателя. В поле
 * это хранится как markdown `[наш сайт](https://…)`; при отправке
 * toInstantlyHtmlBody превращает в `<a href>`, и письмо С этой ссылкой
 * уходит в HTML-формате (без ссылок — остаётся текстовым). Логика сборки
 * markdown — в buildMarkdownLink (покрыта тестами).
 *
 * Клиент вставляет УЖЕ ГОТОВУЮ ссылку (с UTM, если нужно) — конструктор UTM
 * не наша забота. Произвольный HTML вставить нельзя: всё кроме этой
 * markdown-ссылки экранируется. Inline-форма без модалки: текст письма
 * виден, Esc закрывает, Enter вставляет.
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
  // Выделенное слово, которое мы СОХРАНИМ рядом со ссылкой. Пусто, если
  // ничего не выделено или выделение само похоже на URL (тогда это
  // «перевставить ссылку», anchor не нужен).
  const [anchor, setAnchor] = useState('');

  const openInline = () => {
    const ta = textareaRef.current;
    const start = ta?.selectionStart ?? 0;
    const end = ta?.selectionEnd ?? 0;
    setSel({ start, end });
    const selected = value.slice(start, end).trim();
    if (selected && looksLikeLink(selected)) {
      // Выделена уже-ссылка → режим «заменить/обновить URL». Префиллим
      // инпут ей, anchor не используем.
      setLink(selected);
      setAnchor('');
    } else {
      // Выделено обычное слово (или ничего) → это anchor, который сохраним.
      // Инпут ссылки начинается пустым (раньше сюда ошибочно клали «Егор»).
      setLink('');
      setAnchor(selected);
    }
    setOpen(true);
    requestAnimationFrame(() => linkInputRef.current?.focus());
  };

  const closeInline = () => {
    setOpen(false);
    setLink('');
    setAnchor('');
    requestAnimationFrame(() => textareaRef.current?.focus());
  };

  const canInsert = looksLikeLink(link);

  // Normalize the URL: add https:// if the client pasted a bare domain, so
  // the markdown link is a valid http(s) URL that toInstantlyHtmlBody accepts.
  const normalizedLink = (() => {
    const s = link.trim();
    return /^https?:\/\//i.test(s) ? s : `https://${s}`;
  })();

  // Превью markdown-метки, которая встанет в поле.
  const previewSnippet = canInsert ? buildMarkdownLink(anchor, normalizedLink) : '';

  const insert = () => {
    if (!canInsert) return;
    const snippet = buildMarkdownLink(anchor, normalizedLink);
    onChange(value.slice(0, sel.start) + snippet + value.slice(sel.end));
    setOpen(false);
    setLink('');
    setAnchor('');
    const caret = sel.start + snippet.length;
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
            {anchor
              ? `Слово «${anchor}» станет кликабельным, а ссылка (с UTM) будет скрыта от получателя. Письмо с ссылкой уходит в HTML-формате.`
              : 'Вставьте готовую ссылку (с UTM, если нужно). Выделите слово в тексте перед вставкой, чтобы кликабельным стало именно оно, а URL скрылся.'}
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
          {previewSnippet && (
            <p className="text-[11px] m-0 break-all" style={{ color: 'var(--cp-paper-faint)' }}>
              В поле: <span style={{ color: 'var(--cp-paper-mute)' }}>{previewSnippet}</span>
            </p>
          )}
        </div>
      )}
    </div>
  );
}
