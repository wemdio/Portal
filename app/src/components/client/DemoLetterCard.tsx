'use client';

/**
 * Разворачиваемое письмо для демо-примеров (мастер запуска, «Цепочки писем»).
 * Свёрнуто — тема + первая строка тела («огрызок»-тизер); клик по карточке
 * раскрывает полный текст (whitespace-pre-line). Merge-теги вида {{firstName}}
 * оставлены в тексте намеренно — показывают персонализацию.
 */
import { useState } from 'react';
import { ChevronDown } from 'lucide-react';

export interface DemoLetter {
  subject: string;
  body: string;
  /** Подпись задержки шага: «сразу», «через 3 дня»… */
  when: string;
}

export function DemoLetterCard({
  letter,
  index,
  idPrefix,
  defaultOpen = false,
}: {
  letter: DemoLetter;
  index: number;
  /** Уникален в пределах страницы — для aria-controls. */
  idPrefix: string;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const bodyId = `${idPrefix}-letter-${index}`;
  const firstLine = letter.body.split('\n').find((l) => l.trim()) ?? '';

  return (
    <div className="neu-sm overflow-hidden">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-controls={bodyId}
        className="w-full px-3 py-2 flex items-center gap-3 text-left"
      >
        <span className="ds-mono text-xs font-semibold shrink-0" style={{ color: 'var(--cp-paper-faint)' }}>
          {String(index + 1).padStart(2, '0')}
          <span aria-hidden> → </span>
        </span>
        <span className="text-xs sm:text-sm font-semibold flex-1 min-w-0 truncate" style={{ color: 'var(--cp-paper)' }}>
          {letter.subject}
        </span>
        <span className="ds-mono text-[10px] shrink-0" style={{ color: 'var(--cp-paper-faint)' }}>
          {letter.when}
        </span>
        <ChevronDown
          size={14}
          className={`shrink-0 transition-transform ${open ? 'rotate-180' : ''}`}
          style={{ color: 'var(--cp-paper-faint)' }}
          aria-hidden
        />
      </button>
      <hr className="neu-divider mx-3" />
      <div id={bodyId}>
        {open ? (
          <p
            className="px-3 py-2.5 text-[11px] sm:text-xs leading-relaxed m-0 whitespace-pre-line"
            style={{ color: 'var(--cp-paper-mute)' }}
          >
            {letter.body}
          </p>
        ) : (
          <button type="button" onClick={() => setOpen(true)} className="block w-full px-3 py-2 text-left">
            <span className="block text-[11px] sm:text-xs leading-relaxed truncate" style={{ color: 'var(--cp-paper-mute)' }}>
              {firstLine}
            </span>
            <span className="text-[10px] font-semibold" style={{ color: 'var(--cp-amber)' }}>
              Развернуть письмо
            </span>
          </button>
        )}
      </div>
    </div>
  );
}
