'use client';

/**
 * «Попробуйте на своей компании» — панель в демо-брифе.
 *
 * Посетитель вставляет URL своего сайта → три последовательных шага к
 * /api/client/demo/personalize (бриф → гипотезы → письма), с живым прогрессом.
 * Письма 2–3 показываются под блюром до регистрации (promptDemoRegister).
 * Рендерится ТОЛЬКО в демо (гейт в brief/page.tsx по useDemoMode).
 */

import { useState } from 'react';
import { Check, Globe, Loader2, Lock, Sparkles } from 'lucide-react';
import { authFetch } from '@/lib/authFetch';
import { promptDemoRegister } from '@/lib/clientDemo/registerPrompt';
import { LeadSourceHypothesesView } from '@/components/projects/LeadSourceHypothesesView';
import { DemoLetterCard, type DemoLetter } from '@/components/client/DemoLetterCard';

interface RunPayload {
  runId: string;
  resolvedUrl: string | null;
  brief: Record<string, unknown> | null;
  hypotheses: string | null;
  letters: Array<{ subject: string; body: string; wait_days: number }> | null;
  cached: boolean;
}

type StepState = 'idle' | 'loading' | 'done' | 'error';

/** Поля брифа, которые показываем в результате (в этом порядке). */
const BRIEF_LABELS: Array<[key: string, label: string]> = [
  ['company_description', 'О компании'],
  ['product_description', 'Продукт / услуга'],
  ['target_audience', 'Целевая аудитория'],
  ['client_problems', 'Боли клиентов'],
  ['advantages', 'Преимущества'],
  ['impressive_numbers', 'Цифры'],
  ['special_offer', 'Оффер'],
];

function waitLabel(waitDays: number, index: number): string {
  if (index === 0 || waitDays <= 0) return 'сразу';
  const mod10 = waitDays % 10;
  const mod100 = waitDays % 100;
  const word =
    mod10 === 1 && mod100 !== 11
      ? 'день'
      : mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)
        ? 'дня'
        : 'дней';
  return `через ${waitDays} ${word}`;
}

class ApiError extends Error {
  code?: string;
  constructor(message: string, code?: string) {
    super(message);
    this.code = code;
  }
}

async function callPersonalize(body: Record<string, unknown>): Promise<RunPayload> {
  const res = await authFetch('/api/client/demo/personalize', {
    method: 'POST',
    body: JSON.stringify(body),
  });
  const data = (await res.json().catch(() => null)) as
    | (RunPayload & { error?: string; code?: string })
    | null;
  if (!res.ok) {
    throw new ApiError(data?.error || `Ошибка ${res.status}`, data?.code);
  }
  if (!data) throw new ApiError('Пустой ответ сервера');
  return data;
}

export function DemoPersonalizePanel() {
  const [website, setWebsite] = useState('');
  const [brief, setBrief] = useState<StepState>('idle');
  const [hypo, setHypo] = useState<StepState>('idle');
  const [letters, setLetters] = useState<StepState>('idle');
  const [run, setRun] = useState<RunPayload | null>(null);
  const [error, setError] = useState<string | null>(null);

  const busy = brief === 'loading' || hypo === 'loading' || letters === 'loading';

  const handleError = (err: unknown, setStep: (s: StepState) => void) => {
    setStep('error');
    const e = err instanceof ApiError ? err : new ApiError('Что-то пошло не так');
    if (e.code === 'DEMO_PERSONALIZE_LIMIT') {
      promptDemoRegister('сделать разбор ещё одного сайта');
    }
    setError(e.message);
  };

  const runHypotheses = async (runId: string) => {
    setError(null);
    setHypo('loading');
    try {
      const data = await callPersonalize({ runId, step: 'hypotheses' });
      setRun((prev) => (prev ? { ...prev, hypotheses: data.hypotheses } : data));
      setHypo('done');
      return true;
    } catch (err) {
      handleError(err, setHypo);
      return false;
    }
  };

  const runLetters = async (runId: string) => {
    setError(null);
    setLetters('loading');
    try {
      const data = await callPersonalize({ runId, step: 'letters' });
      setRun((prev) => (prev ? { ...prev, letters: data.letters } : data));
      setLetters('done');
      return true;
    } catch (err) {
      handleError(err, setLetters);
      return false;
    }
  };

  const start = async () => {
    const trimmed = website.trim();
    if (!trimmed || busy) return;
    setError(null);
    setRun(null);
    setHypo('idle');
    setLetters('idle');
    setBrief('loading');

    let first: RunPayload;
    try {
      first = await callPersonalize({ website: trimmed });
    } catch (err) {
      handleError(err, setBrief);
      return;
    }
    setRun(first);
    setBrief('done');

    // Кэшированный прогон может уже содержать всё — не дёргаем LLM зря.
    if (first.hypotheses) setHypo('done');
    if (first.letters && first.letters.length > 0) setLetters('done');

    if (!first.hypotheses) {
      const ok = await runHypotheses(first.runId);
      if (!ok) return;
    }
    if (!first.letters || first.letters.length === 0) {
      await runLetters(first.runId);
    }
  };

  const stepChip = (state: StepState, label: string) => (
    <span
      className="inline-flex items-center gap-1.5 text-[11px] font-semibold"
      style={{
        color:
          state === 'done'
            ? 'var(--cp-paper)'
            : state === 'loading'
              ? 'var(--cp-amber)'
              : state === 'error'
                ? 'var(--cp-red)'
                : 'var(--cp-paper-faint)',
      }}
    >
      {state === 'loading' ? (
        <Loader2 size={12} className="animate-spin" aria-hidden />
      ) : state === 'done' ? (
        <Check size={12} aria-hidden />
      ) : (
        <span
          className="inline-block h-1.5 w-1.5 rounded-full"
          style={{ background: 'currentColor' }}
          aria-hidden
        />
      )}
      {label}
    </span>
  );

  const briefEntries =
    run?.brief
      ? BRIEF_LABELS.flatMap(([key, label]) => {
          const value = run.brief?.[key];
          return typeof value === 'string' && value.trim() ? [[label, value.trim()] as const] : [];
        })
      : [];

  const letterCards: DemoLetter[] =
    run?.letters?.map((l, i) => ({
      subject: l.subject,
      body: l.body,
      when: waitLabel(l.wait_days, i),
    })) ?? [];

  return (
    <section className="neu-card p-4 sm:p-6 mb-6">
      <p className="ds-eyebrow m-0 mb-1" style={{ color: 'var(--cp-amber)' }}>
        Попробуйте на своей компании
      </p>
      <h2 className="text-base sm:text-lg font-bold m-0 mb-1" style={{ color: 'var(--cp-paper)' }}>
        Вставьте сайт — увидите свой бриф, гипотезы и цепочку писем
      </h2>
      <p className="text-xs sm:text-sm m-0 mb-4" style={{ color: 'var(--cp-paper-mute)' }}>
        AI прочитает сайт и покажет, как outreachOS соберёт кампанию под вашу компанию.
        Один бесплатный разбор, ~2–3 минуты.
      </p>

      <div className="flex flex-col sm:flex-row gap-2">
        <div className="relative flex-1">
          <Globe
            size={14}
            className="absolute left-3 top-1/2 -translate-y-1/2"
            style={{ color: 'var(--cp-paper-faint)' }}
            aria-hidden
          />
          <input
            type="text"
            inputMode="url"
            value={website}
            onChange={(e) => setWebsite(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void start();
            }}
            placeholder="ваш-сайт.ru"
            disabled={busy}
            className="neu-input w-full pl-9 pr-3 py-2.5 text-sm"
            aria-label="URL вашего сайта"
          />
        </div>
        <button
          type="button"
          onClick={() => void start()}
          disabled={busy || !website.trim()}
          className="neu-pill inline-flex items-center justify-center gap-2 px-4 py-2.5 text-sm font-semibold shrink-0 disabled:opacity-60"
          style={{ background: 'var(--cp-amber)', color: 'var(--cp-ink)' }}
        >
          {busy ? <Loader2 size={15} className="animate-spin" aria-hidden /> : <Sparkles size={15} aria-hidden />}
          {busy ? 'Разбираем…' : 'Разобрать сайт'}
        </button>
      </div>

      {(brief !== 'idle' || error) && (
        <div className="mt-3 flex items-center gap-4 flex-wrap">
          {stepChip(brief, 'Бриф')}
          {stepChip(hypo, 'Гипотезы')}
          {stepChip(letters, 'Цепочка писем')}
          {run?.cached && (
            <span className="text-[11px]" style={{ color: 'var(--cp-paper-faint)' }}>
              из недавнего разбора этого сайта
            </span>
          )}
        </div>
      )}

      {error && (
        <div
          className="mt-3 text-xs rounded-md p-2.5"
          style={{
            background: 'rgba(229,72,77,0.1)',
            border: '1px solid var(--cp-red)',
            color: 'var(--cp-red)',
          }}
        >
          {error}
        </div>
      )}

      {briefEntries.length > 0 && (
        <div className="mt-5">
          <h3 className="text-sm font-bold m-0 mb-2" style={{ color: 'var(--cp-paper)' }}>
            Бриф по вашему сайту
          </h3>
          <dl className="space-y-2 m-0">
            {briefEntries.map(([label, value]) => (
              <div key={label} className="grid grid-cols-1 gap-x-3 gap-y-0.5 sm:grid-cols-[10rem_1fr]">
                <dt
                  className="pt-0.5 text-[11px] font-medium uppercase tracking-wide"
                  style={{ color: 'var(--cp-paper-faint)' }}
                >
                  {label}
                </dt>
                <dd
                  className="text-sm leading-relaxed m-0 whitespace-pre-line"
                  style={{ color: 'var(--cp-paper-mute)' }}
                >
                  {value}
                </dd>
              </div>
            ))}
          </dl>
        </div>
      )}

      {run?.hypotheses && (
        <div className="mt-5">
          <h3 className="text-sm font-bold m-0 mb-2" style={{ color: 'var(--cp-paper)' }}>
            Гипотезы по сбору базы
          </h3>
          <LeadSourceHypothesesView markdown={run.hypotheses} />
        </div>
      )}
      {hypo === 'error' && run && (
        <button
          type="button"
          onClick={() => {
            // После успешного ретрая гипотез продолжаем цепочку: без этого
            // разбор навсегда останавливался на 2/3 (письма — главный крючок).
            void (async () => {
              const ok = await runHypotheses(run.runId);
              if (ok && (!run.letters || run.letters.length === 0)) {
                await runLetters(run.runId);
              }
            })();
          }}
          className="neu-pill mt-3 px-3 py-1.5 text-xs font-semibold"
        >
          Повторить генерацию гипотез
        </button>
      )}

      {letterCards.length > 0 && (
        <div className="mt-5">
          <h3 className="text-sm font-bold m-0 mb-2" style={{ color: 'var(--cp-paper)' }}>
            Цепочка писем под вашу компанию
          </h3>
          <div className="space-y-2">
            <DemoLetterCard letter={letterCards[0]} index={0} idPrefix="pers" defaultOpen />
            {letterCards.length > 1 && (
              <div className="relative">
                {/* inert выводит кнопки заблюренных карточек из tab-order —
                    aria-hidden без него оставлял фокусируемые элементы (WCAG 4.1.2). */}
                <div className="space-y-2 blur-sm select-none pointer-events-none" aria-hidden inert>
                  {letterCards.slice(1).map((l, i) => (
                    <DemoLetterCard key={i} letter={l} index={i + 1} idPrefix="pers" />
                  ))}
                </div>
                <div className="absolute inset-0 flex items-center justify-center">
                  <button
                    type="button"
                    onClick={() => promptDemoRegister('увидеть всю цепочку писем')}
                    className="neu-pill inline-flex items-center gap-2 px-4 py-2 text-sm font-semibold"
                    style={{ background: 'var(--cp-amber)', color: 'var(--cp-ink)' }}
                  >
                    <Lock size={14} aria-hidden />
                    Показать письма 2–3 — создайте аккаунт
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}
      {letters === 'error' && run && (
        <button
          type="button"
          onClick={() => void runLetters(run.runId)}
          className="neu-pill mt-3 px-3 py-1.5 text-xs font-semibold"
        >
          Повторить генерацию писем
        </button>
      )}
    </section>
  );
}
