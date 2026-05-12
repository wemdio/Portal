'use client';

import { useState } from 'react';
import { Loader2, Sparkles, AlertCircle, CheckCircle2 } from 'lucide-react';
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

  return (
    <section className="rounded-xl border border-indigo-200 bg-indigo-50/60 p-4">
      <header className="flex items-center gap-2 text-sm font-semibold text-indigo-900">
        <Sparkles className="h-4 w-4" />
        Заполнить бриф по сайту (AI)
      </header>
      <p className="mt-1 text-xs text-indigo-900/80">
        Вставьте сайт компании — AI заполнит только те поля, которые видны на сайте. Цены, цикл
        сделки, контактных лиц и боли клиентов вам всё равно нужно будет подтвердить руками.
      </p>

      <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:items-center">
        <input
          type="text"
          value={website}
          onChange={(e) => setWebsite(e.target.value)}
          placeholder="например, redev.ru или https://acme.com"
          className="flex-1 rounded-lg border border-indigo-200 bg-white px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
          disabled={loading}
        />
        <button
          type="button"
          onClick={handleClick}
          disabled={disabled}
          className={`inline-flex items-center justify-center gap-2 rounded-lg px-4 py-2 text-sm font-medium text-white transition-colors ${
            disabled
              ? 'bg-indigo-300 cursor-not-allowed'
              : 'bg-indigo-600 hover:bg-indigo-700'
          }`}
        >
          {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
          Заполнить по сайту
        </button>
      </div>

      {loading && (
        <div className="mt-3 flex items-center gap-2 rounded-lg border border-indigo-200 bg-white px-3 py-2 text-xs text-indigo-900">
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
          Изучаем сайт и готовим черновик — обычно 30-60 секунд…
        </div>
      )}

      {error && !loading && (
        <div className="mt-3 flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-800">
          <AlertCircle className="h-3.5 w-3.5 mt-0.5 flex-shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {!loading && filledCount !== null && !error && (
        <div className="mt-3 flex items-start gap-2 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs text-emerald-900">
          <CheckCircle2 className="h-3.5 w-3.5 mt-0.5 flex-shrink-0" />
          <span>
            Заполнено {filledCount} {filledCount === 1 ? 'поле' : filledCount && filledCount < 5 ? 'поля' : 'полей'}.
            Проверьте факты перед сохранением.
          </span>
        </div>
      )}

      {!loading && questions.length > 0 && (
        <div className="mt-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">
          <p className="font-medium">Осталось уточнить:</p>
          <ul className="mt-1 list-disc space-y-1 pl-5">
            {questions.map((q, i) => (
              <li key={`${i}-${q}`}>{q}</li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
