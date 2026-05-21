'use client';

import { useState } from 'react';
import { Loader2 } from 'lucide-react';
import type { ClientBriefFields } from '@/lib/clientBrief';

export interface BriefAutofillResult {
  ok: boolean;
  fieldsPatch: Partial<ClientBriefFields>;
  questions: string[];
  /** Optional human-readable error message when ok=false. */
  error?: string;
}

export interface BriefAutofillPanelProps {
  /** Pre-populated website URL (usually the form's company_website value). */
  initialWebsite?: string;
  /** Performs the autofill request — returns the AI-derived patch. */
  onAutofill: (website: string) => Promise<BriefAutofillResult>;
  /** Called with the patch the user wants applied locally (parent merges). */
  onApplyPatch: (patch: Partial<ClientBriefFields>) => void;
}

export function BriefAutofillPanel({
  initialWebsite = '',
  onAutofill,
  onApplyPatch,
}: BriefAutofillPanelProps) {
  const [website, setWebsite] = useState(initialWebsite);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [questions, setQuestions] = useState<string[]>([]);
  const [filledCount, setFilledCount] = useState<number | null>(null);

  const trimmed = website.trim();
  const disabled = loading || !trimmed;

  async function handleClick() {
    setError(null);
    setQuestions([]);
    setFilledCount(null);
    setLoading(true);
    try {
      const result = await onAutofill(trimmed);
      if (!result || !result.ok) {
        setError(result?.error || 'AI не вернул черновик. Попробуйте ещё раз.');
        return;
      }
      const patch = result.fieldsPatch ?? {};
      onApplyPatch(patch);
      setQuestions(Array.isArray(result.questions) ? result.questions : []);
      setFilledCount(Object.keys(patch).length);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Неизвестная ошибка');
    } finally {
      setLoading(false);
    }
  }

  // Shared style for the four status messages (loading / error / success /
  // questions). Editorial dark: surface-rest background, hairline divider
  // border, paper text. State is signaled by a 6px status dot, not by tinted
  // backgrounds — see DESIGN.md §Status-as-Data Rule.
  const statusBoxStyle = {
    background: 'var(--cp-surface-rest)',
    border: '1px solid var(--cp-divider)',
    color: 'var(--cp-paper)',
  };

  return (
    <section
      className="rounded-xl p-4"
      style={{
        background: 'var(--cp-surface-elev)',
        border: '1px solid var(--cp-divider-strong)',
      }}
    >
      <p className="ds-eyebrow mb-2">AI ассистент</p>
      <header
        className="flex items-center gap-2 text-sm font-semibold"
        style={{ color: 'var(--cp-paper)' }}
      >
        Заполнить бриф по сайту
      </header>
      <p className="mt-1 text-xs" style={{ color: 'var(--cp-paper-mute)' }}>
        Вставьте сайт компании — AI заполнит только те поля, которые видны на сайте. Цены, цикл
        сделки, контактных лиц и боли клиентов вам всё равно нужно будет подтвердить руками.
      </p>

      <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:items-center">
        <input
          type="text"
          value={website}
          onChange={(e) => setWebsite(e.target.value)}
          placeholder="например, roga-kopyta.example или https://example.com"
          className="ds-input flex-1"
          disabled={loading}
        />
        <button
          type="button"
          onClick={handleClick}
          disabled={disabled}
          className="ds-btn-primary inline-flex items-center justify-center gap-2"
        >
          {loading && <Loader2 className="h-4 w-4 animate-spin" aria-hidden />}
          Заполнить по сайту
        </button>
      </div>

      {loading && (
        <div
          className="mt-3 flex items-center gap-2 rounded-md px-3 py-2 text-xs"
          style={statusBoxStyle}
        >
          <Loader2
            className="h-3.5 w-3.5 animate-spin shrink-0"
            style={{ color: 'var(--cp-paper-faint)' }}
            aria-hidden
          />
          <span style={{ color: 'var(--cp-paper-mute)' }}>
            Изучаем сайт и готовим черновик — обычно 30-60 секунд…
          </span>
        </div>
      )}

      {error && !loading && (
        <div
          className="mt-3 flex items-start gap-2.5 rounded-md px-3 py-2 text-xs"
          style={statusBoxStyle}
          role="alert"
        >
          <span
            aria-hidden
            className="ds-status-dot shrink-0"
            style={{ background: 'var(--cp-red)', marginTop: '5px' }}
          />
          <span>{error}</span>
        </div>
      )}

      {!loading && filledCount !== null && !error && (
        <div
          className="mt-3 flex items-start gap-2.5 rounded-md px-3 py-2 text-xs"
          style={statusBoxStyle}
        >
          <span
            aria-hidden
            className="ds-status-dot shrink-0"
            style={{ background: 'var(--cp-green)', marginTop: '5px' }}
          />
          <span>
            Заполнено {filledCount}{' '}
            {filledCount === 1
              ? 'поле'
              : filledCount && filledCount < 5
                ? 'поля'
                : 'полей'}
            . Проверьте факты перед сохранением.
          </span>
        </div>
      )}

      {!loading && questions.length > 0 && (
        <div
          className="mt-3 rounded-md px-3 py-2 text-xs"
          style={statusBoxStyle}
        >
          <p
            className="font-medium flex items-center gap-2.5"
            style={{ color: 'var(--cp-paper)' }}
          >
            <span
              aria-hidden
              className="ds-status-dot shrink-0"
              style={{ background: 'var(--cp-amber)' }}
            />
            Осталось уточнить:
          </p>
          <ul
            className="mt-1.5 list-disc space-y-1 pl-5"
            style={{ color: 'var(--cp-paper-mute)' }}
          >
            {questions.map((q, i) => (
              <li key={`${i}-${q}`}>{q}</li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
