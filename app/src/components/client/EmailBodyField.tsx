'use client';

import { useRef, useState } from 'react';
import { Link2 } from 'lucide-react';
import { appendUtm, looksLikeUrl, type UtmParams } from '@/lib/clientLaunch/utm';

const UTM_STORAGE_KEY = 'client_launch_utm_stable';

/** utm_source / utm_medium стабильны между кампаниями — запоминаем их. */
function loadStableUtm(): { utm_source: string; utm_medium: string } {
  const fallback = { utm_source: 'email', utm_medium: 'cold_outreach' };
  if (typeof window === 'undefined') return fallback;
  try {
    const raw = window.localStorage.getItem(UTM_STORAGE_KEY);
    if (raw) {
      const p = JSON.parse(raw) as Partial<UtmParams>;
      return {
        utm_source: (p.utm_source || fallback.utm_source).trim(),
        utm_medium: (p.utm_medium || fallback.utm_medium).trim(),
      };
    }
  } catch {
    /* ignore — вернём дефолт */
  }
  return fallback;
}

interface EmailBodyFieldProps {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  rows?: number;
  className?: string;
}

const UTM_FIELDS: [keyof UtmParams, string][] = [
  ['utm_source', 'utm_source'],
  ['utm_medium', 'utm_medium'],
  ['utm_campaign', 'utm_campaign'],
  ['utm_content', 'utm_content (необяз.)'],
];

/**
 * Поле текста письма + кнопка «Ссылка с UTM».
 *
 * Клиент выделяет URL прямо в тексте письма, жмёт кнопку, в модалке
 * задаёт utm-параметры и видит превью — по «Вставить» выделенный
 * фрагмент заменяется на URL с метками. Без выделения ссылку можно
 * вписать в модалке, она вставится в позицию курсора.
 *
 * HTML не используется: ссылка остаётся обычным текстом, метки видны
 * в самой ссылке (так работает plain-text письмо).
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
  const [url, setUrl] = useState('');
  const [utm, setUtm] = useState<UtmParams>({});

  const openModal = () => {
    const ta = textareaRef.current;
    const start = ta?.selectionStart ?? 0;
    const end = ta?.selectionEnd ?? 0;
    setSel({ start, end });
    setUrl(value.slice(start, end).trim());
    setUtm({ ...loadStableUtm(), utm_campaign: '', utm_content: '' });
    setOpen(true);
  };

  const tagged = appendUtm(url, utm);
  const canApply = looksLikeUrl(url);

  const apply = () => {
    if (!canApply) return;
    onChange(value.slice(0, sel.start) + tagged + value.slice(sel.end));
    try {
      window.localStorage.setItem(
        UTM_STORAGE_KEY,
        JSON.stringify({ utm_source: utm.utm_source ?? '', utm_medium: utm.utm_medium ?? '' }),
      );
    } catch {
      /* ignore — запоминание дефолтов не критично */
    }
    setOpen(false);
    const caret = sel.start + tagged.length;
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
        Ссылка с UTM
      </button>

      {open && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4"
          onClick={() => setOpen(false)}
        >
          <div
            className="neu-card w-full max-w-md p-5 max-h-[90vh] overflow-y-auto"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="text-sm font-bold mb-1" style={{ color: 'var(--cp-text)' }}>
              Ссылка с UTM-метками
            </h3>
            <p className="text-[11px] mb-3" style={{ color: 'var(--cp-text-m)' }}>
              Выделите ссылку в тексте письма перед нажатием кнопки — или впишите её здесь.
              Метки добавятся к ссылке, она останется обычным текстом.
            </p>

            <label
              className="block text-[11px] font-semibold mb-1"
              style={{ color: 'var(--cp-text-m)' }}
            >
              Ссылка
            </label>
            <input
              type="text"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="polzaagency.ru"
              className="neu-input w-full px-3 py-2 text-sm mb-3"
            />

            <div className="grid grid-cols-2 gap-2 mb-3">
              {UTM_FIELDS.map(([key, label]) => (
                <div key={key}>
                  <label
                    className="block text-[11px] font-semibold mb-1"
                    style={{ color: 'var(--cp-text-m)' }}
                  >
                    {label}
                  </label>
                  <input
                    type="text"
                    value={utm[key] ?? ''}
                    onChange={(e) => setUtm((prev) => ({ ...prev, [key]: e.target.value }))}
                    className="neu-input w-full px-2.5 py-1.5 text-xs"
                  />
                </div>
              ))}
            </div>

            <div className="neu-inset rounded-xl px-3 py-2 mb-4">
              <p
                className="text-[10px] font-semibold uppercase tracking-wide mb-1"
                style={{ color: 'var(--cp-text-l)' }}
              >
                Итоговая ссылка
              </p>
              <p
                className="text-xs break-all"
                style={{ color: canApply ? 'var(--cp-text)' : 'var(--cp-text-l)' }}
              >
                {canApply ? tagged : 'Введите корректную ссылку'}
              </p>
            </div>

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
                onClick={apply}
                disabled={!canApply}
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
