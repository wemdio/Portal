'use client';

/**
 * Блок «Цепочки запуска» на экране запуска русского и английского аутричей
 * (спека 2026-09-26-outreach-to-sender-design.md §4).
 *
 * Цепочку из четырёх писем ИИ пишет один раз на оффер запуска, под компанию в
 * неё подставляются проверенные факты. Здесь видно, какие цепочки написаны,
 * сколько они стоили и что в них, а цепочку, не прошедшую автопроверку, можно
 * переписать кнопкой — компании, которые её ждали, получат письма заново.
 * Адреса у RU и EN разные (GET …/[jobId]/templates, POST
 * …/templates/[offerKey]/regenerate), остальное общее — поэтому компонент один
 * и получает адрес запуска пропсом.
 *
 * Клиентский код: серверные модули аутричей (писатель, проверка, пересборка)
 * сюда не тянем — формы ответов объявлены ниже.
 */

import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { ChevronDown, ChevronRight, Loader2, RefreshCw } from 'lucide-react';
import { authFetch, authFetchJson } from '@/lib/authFetch';
import { fmtUsd } from '@/lib/outreachLlm/format';

/** Как опрос запуска на экранах RU и EN: цепочки пишутся по ходу прогона. */
const POLL_MS = 5_000;

/** Письмо шаблона — как лежит в polza_chain_templates.letters (контракт писателя). */
interface TemplateLetterJson {
  n?: number;
  subject?: string;
  body?: string;
  body_direct?: string;
  body_routing?: string;
  body_with_case?: string;
  body_without_case?: string;
}

/** Строка ответа GET …/templates. */
interface ChainTemplateItem {
  id: string;
  offer_key: string;
  offer_label: string;
  status: 'pending' | 'ok' | 'failed';
  /** У не прошедшей проверку — последний вариант писателя, если он был. */
  letters: TemplateLetterJson[] | null;
  qa_flags: string[] | null;
  /** Замечания автопроверки словами. */
  qa_flags_text?: string[];
  model: string | null;
  /** Все попытки писателя вместе, включая прошлые «Переписать цепочку». */
  cost_usd: number;
  /** Почему цепочки нет совсем: ИИ не ответил, кончился лимит, ключ. */
  error: string | null;
  /** Сколько компаний ждут эту цепочку — их письма соберёт «Переписать цепочку». */
  waiting?: number;
  /** pending, чей процесс умер: писатель её уже не допишет. */
  stale?: boolean;
}

/**
 * Итог «Переписать цепочку» — RegenerateSummary из lib/polzaRuOutreach/regenerate.ts
 * и lib/polzaOutreach/regenerate.ts: у RU оставшиеся — stillDoubtful, и строки
 * могут не успеть до срока роута (unfinished); у EN — stillReview.
 */
interface RegenerateSummary {
  status: 'ok' | 'failed';
  rewritten: boolean;
  waiting: number;
  promoted: number;
  stillDoubtful?: number;
  stillReview?: number;
  limitReached: number;
  unfinished?: number;
  costUsd: number;
  error: string | null;
}

interface Outcome {
  tone: 'ok' | 'warn' | 'error';
  text: string;
}

const OUTCOME_TONE: Record<Outcome['tone'], string> = {
  ok: 'bg-emerald-50 text-emerald-800',
  warn: 'bg-amber-50 text-amber-800',
  error: 'bg-red-50 text-red-700',
};

/**
 * Плейсхолдеры шаблонов (RU — TEMPLATE_PLACEHOLDERS, EN — POLZA_TEMPLATE_PLACEHOLDERS
 * в types.ts аутричей): короткая метка в тексте и что подставится. Ключи RU и
 * EN не пересекаются — словарь один.
 */
const PLACEHOLDERS: Record<string, { label: string; hint: string }> = {
  'бренд': { label: 'бренд', hint: 'Название компании' },
  'повод': { label: 'повод', hint: 'Фраза-повод из проверенных фактов о компании' },
  'кейс': { label: 'кейс', hint: 'Утверждённый кейс из отрасли компании' },
  'гипотеза': { label: 'гипотеза', hint: 'Гипотеза сегментов по сайту компании' },
  'подпись': { label: 'подпись', hint: 'Подпись отправителя' },
  'company': { label: 'компания', hint: 'Название компании' },
  'trigger': { label: 'повод', hint: 'Фраза-повод из проверенных фактов о компании' },
  'trigger_short': { label: 'повод коротко', hint: 'Повод в двух словах — для середины фразы' },
  'case': { label: 'кейс', hint: 'Утверждённый кейс из отрасли компании' },
  'segments': { label: 'сегменты', hint: 'Первые сегменты по разбору сайта компании' },
  'signature': { label: 'подпись', hint: 'Подпись из настроек аутрича' },
};

const PLACEHOLDER_RE = /\{\{\s*([^{}]+?)\s*\}\}/g;

function companies(n: number): string {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return `${n} компания`;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return `${n} компании`;
  return `${n} компаний`;
}

function fmtElapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function statusView(t: ChainTemplateItem): { label: string; tone: string; spin: boolean } {
  if (t.status === 'ok') return { label: 'готова', tone: 'bg-emerald-50 text-emerald-700', spin: false };
  if (t.status === 'pending') {
    return t.stale
      ? { label: 'прервалась', tone: 'bg-amber-50 text-amber-800', spin: false }
      : { label: 'пишется', tone: 'bg-violet-50 text-violet-700', spin: true };
  }
  return { label: t.error ? 'не написана' : 'не прошла проверку', tone: 'bg-red-50 text-red-700', spin: false };
}

/** Итог переписывания словами: что с цепочкой, куда делись ждавшие компании, сколько стоило. */
function summaryOutcome(s: RegenerateSummary, lang: 'ru' | 'en'): Outcome {
  const still = Number(s.stillDoubtful ?? s.stillReview ?? 0);
  const unfinished = Number(s.unfinished ?? 0);
  const head =
    s.status === 'ok'
      ? s.rewritten
        ? 'Цепочка переписана и прошла проверку.'
        : 'Цепочка уже была готова — письма собраны заново.'
      : s.error
        ? `ИИ снова не написал цепочку: ${s.error.replace(/\.$/, '')}.`
        : 'Цепочка снова не прошла автопроверку — замечания выше.';
  const parts = [head, `Готовы: ${s.promoted} из ${s.waiting}.`];
  if (still > 0) parts.push(`${lang === 'ru' ? 'Остались очень спорными' : 'Остались на ручной проверке'}: ${still}.`);
  if (s.limitReached > 0) parts.push(`Не вошли в лимит готовых: ${s.limitReached}.`);
  if (unfinished > 0) parts.push(`Не успели собрать: ${unfinished} — нажмите «Собрать письма» ещё раз.`);
  parts.push(`Потрачено на ИИ: ${fmtUsd(Number(s.costUsd) || 0)}.`);
  // Готовыми стали не все ждавшие (спорные, лимит, не успели) — это не провал, но и не «всё хорошо».
  return { tone: s.status !== 'ok' ? 'error' : s.promoted < s.waiting ? 'warn' : 'ok', text: parts.join(' ') };
}

/** Ответ без JSON — это прокси или обрыв, а не сервер портала: объясняем, что делать. */
function httpErrorText(status: number): string {
  if (status === 401) return 'Сессия истекла — обновите страницу и войдите снова.';
  if (status === 502 || status === 503 || status === 504) {
    return 'Сервер не дождался ответа. Цепочка могла переписаться — обновите экран через пару минут.';
  }
  return `Не удалось переписать цепочку (ошибка ${status}).`;
}

/** Текст шаблона: плейсхолдеры — цветными метками с подсказкой, остальное как есть. */
function TemplateText({ text }: { text: string }) {
  if (!text.trim()) return <span className="text-gray-400">пусто</span>;
  const parts: ReactNode[] = [];
  let last = 0;
  for (const m of text.matchAll(PLACEHOLDER_RE)) {
    const at = m.index ?? 0;
    if (at > last) parts.push(text.slice(last, at));
    const p = PLACEHOLDERS[m[1]];
    parts.push(
      <span
        key={at}
        title={p?.hint ?? 'Подставляется под компанию'}
        className="mx-px inline-block rounded bg-violet-100 px-1.5 text-xs font-medium leading-5 text-violet-800"
      >
        {p?.label ?? m[1]}
      </span>,
    );
    last = at + m[0].length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return <>{parts}</>;
}

interface Variant {
  label: string;
  hint: string;
  text: string;
}

interface LetterView {
  n: number;
  subject: string | null;
  variants: Variant[];
}

/**
 * Письма шаблона для показа: письмо 1 — лично и для общей почты, письмо 3 — с
 * кейсом и без. Варианта нет в шаблоне (у SDR-цепочки RU нет кейса) — нет и
 * колонки.
 */
function lettersView(letters: TemplateLetterJson[]): LetterView[] {
  const byN = new Map<number, TemplateLetterJson>();
  letters.forEach((l, i) => {
    if (!l || typeof l !== 'object') return;
    const n = Number(l.n ?? i + 1);
    if (!byN.has(n)) byN.set(n, l);
  });
  const variant = (label: string, hint: string, text: unknown): Variant[] => (typeof text === 'string' ? [{ label, hint, text }] : []);
  const [l1, l2, l3, l4] = [byN.get(1), byN.get(2), byN.get(3), byN.get(4)];
  const views: LetterView[] = [
    {
      n: 1,
      subject: typeof l1?.subject === 'string' ? l1.subject : null,
      variants: [
        ...variant('Лично', 'Почта человека или отдела продаж', l1?.body_direct),
        ...variant('Общая почта', 'Адрес вроде info@ — просим переслать ответственному', l1?.body_routing),
      ],
    },
    { n: 2, subject: null, variants: variant('Текст', '', l2?.body) },
    {
      n: 3,
      subject: null,
      variants: [
        ...variant('С кейсом', 'Есть утверждённый кейс из отрасли компании', l3?.body_with_case),
        ...variant('Без кейса', 'Кейса из отрасли компании нет', l3?.body_without_case),
      ],
    },
    { n: 4, subject: null, variants: variant('Текст', '', l4?.body) },
  ];
  return views.filter((v) => v.variants.length > 0 || v.subject !== null);
}

function TemplateLetters({ letters }: { letters: TemplateLetterJson[] }) {
  return (
    <div className="mt-3 space-y-3">
      {lettersView(letters).map((letter) => (
        <div key={letter.n} className="rounded-lg border border-gray-200 bg-gray-50 p-3">
          <div className="mb-2 flex flex-wrap items-center gap-2">
            <span className="rounded bg-violet-100 px-1.5 py-0.5 text-[11px] font-semibold text-violet-800">Письмо {letter.n}</span>
            {/* Тема только у письма 1: остальные уходят ответом в ту же ветку. */}
            {letter.n === 1 ? (
              <span className="text-sm text-gray-800">
                <span className="text-gray-500">Тема: </span>
                <TemplateText text={letter.subject ?? ''} />
              </span>
            ) : (
              <span className="text-xs text-gray-400">ответ в той же ветке</span>
            )}
          </div>
          <div className={`grid gap-3 ${letter.variants.length > 1 ? 'lg:grid-cols-2' : ''}`}>
            {letter.variants.map((v) => (
              <div key={v.label} className="min-w-0">
                {letter.variants.length > 1 ? (
                  <div className="mb-1 text-[11px] font-medium uppercase tracking-wide text-gray-500" title={v.hint}>
                    {v.label}
                  </div>
                ) : null}
                <div className="whitespace-pre-wrap break-words text-sm leading-relaxed text-gray-700">
                  <TemplateText text={v.text} />
                </div>
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

interface Props {
  /** Адрес запуска в API: /api/tools/polza-ru-outreach/{id} или /api/parsers/polza-outreach/{id}. */
  jobUrl: string;
  /** Запуск идёт: цепочки опрашиваются, а переписывать нельзя — сервер ответит 409. */
  running: boolean;
  /** Где ждут компании, чья цепочка не готова: у RU — «очень спорные», у EN — ручная проверка. */
  lang: 'ru' | 'en';
  /** После переписывания: перечитать запуск и таблицу — готовых и расход могло стать больше. */
  onChanged?: () => void;
}

export function ChainTemplates({ jobUrl, running, lang, onChanged }: Props) {
  const [templates, setTemplates] = useState<ChainTemplateItem[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [open, setOpen] = useState<Record<string, boolean>>({});
  /** Оффер, чья цепочка переписывается: по одной за раз — сервер всё равно пускает одну пересборку на запуск. */
  const [busy, setBusy] = useState<string | null>(null);
  const [elapsedMs, setElapsedMs] = useState(0);
  const [outcomes, setOutcomes] = useState<Record<string, Outcome>>({});

  const load = useCallback(async () => {
    try {
      const data = await authFetchJson<{ templates?: ChainTemplateItem[] }>(`${jobUrl}/templates`);
      // Служебные строки таблицы (маркер пересборки EN «_rebuild») — не цепочки.
      setTemplates((data.templates ?? []).filter((t) => !String(t.offer_key).startsWith('_')));
      setLoadError(null);
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : 'Не удалось загрузить цепочки');
    }
  }, [jobUrl]);

  // Первая загрузка и ещё одна, когда запуск закончился: цепочки в итоговом виде.
  useEffect(() => {
    // Загрузка при открытии запуска — запрос во внешнюю систему.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load, running]);

  useEffect(() => {
    if (!running) return undefined;
    const id = window.setInterval(() => void load(), POLL_MS);
    return () => window.clearInterval(id);
  }, [running, load]);

  // Секундомер ожидания: переписывание идёт минутами, без него кажется, что всё зависло.
  useEffect(() => {
    if (!busy) return undefined;
    const startedAt = Date.now();
    const id = window.setInterval(() => setElapsedMs(Date.now() - startedAt), 1000);
    return () => window.clearInterval(id);
  }, [busy]);

  const regenerate = async (t: ChainTemplateItem) => {
    const offer = t.offer_key;
    setElapsedMs(0);
    setBusy(offer);
    setOutcomes(({ [offer]: _previous, ...rest }) => rest);
    let outcome: Outcome;
    try {
      const res = await authFetch(`${jobUrl}/templates/${encodeURIComponent(offer)}/regenerate`, { method: 'POST' });
      const body: unknown = await res.json().catch(() => null);
      if (res.ok && body && typeof body === 'object') {
        outcome = summaryOutcome(body as RegenerateSummary, lang);
      } else {
        const message = (body as { error?: unknown } | null)?.error;
        // 409 — не сбой, а «сейчас нельзя»: запуск идёт, лимит набран, ждущих нет.
        outcome = { tone: res.status === 409 ? 'warn' : 'error', text: typeof message === 'string' && message ? message : httpErrorText(res.status) };
      }
    } catch {
      outcome = { tone: 'error', text: 'Связь с сервером прервалась. Цепочка могла переписаться — обновите экран через пару минут.' };
    }
    setOutcomes((prev) => ({ ...prev, [offer]: outcome }));
    setBusy(null);
    await load();
    onChanged?.();
  };

  if (templates === null) {
    return loadError ? (
      <div className="rounded-xl border border-gray-200 bg-white p-4 text-sm text-red-700 shadow-sm">Цепочки запуска не загрузились: {loadError}</div>
    ) : null;
  }
  // Цепочек нет: запуск до 26.09.2026 или ни одна компания ещё не дошла до писем.
  if (templates.length === 0) return null;

  const spent = templates.reduce((sum, t) => sum + (Number(t.cost_usd) || 0), 0);
  const waitingWhere = lang === 'ru' ? 'сейчас они в «Очень спорных»' : 'сейчас они на ручной проверке';

  return (
    <div className="rounded-xl border border-gray-200 bg-white p-4 shadow-sm">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div className="text-sm font-semibold text-gray-900">Цепочки запуска</div>
        <div className="text-xs text-gray-500">на цепочки потрачено {fmtUsd(spent)}</div>
      </div>
      <p className="mt-0.5 text-xs text-gray-500">
        ИИ пишет цепочку из четырёх писем один раз на каждый оффер. Выделенные слова — места, куда подставляются данные конкретной компании.
      </p>

      <ul className="mt-3 divide-y divide-gray-100">
        {templates.map((t) => {
          const status = statusView(t);
          const waiting = t.waiting;
          const hasWaiting = (waiting ?? 0) > 0;
          const needsRewrite = t.status === 'failed' || (t.status === 'pending' && Boolean(t.stale));
          const lettersPending = t.status === 'ok' && hasWaiting;
          const isBusy = busy === t.offer_key;
          const isOpen = Boolean(open[t.offer_key]);
          const hasLetters = Array.isArray(t.letters) && t.letters.length > 0;
          const notes = t.qa_flags_text?.length ? t.qa_flags_text : (t.qa_flags ?? []);
          const outcome = outcomes[t.offer_key];
          return (
            <li key={t.id} className="py-3 first:pt-0 last:pb-0">
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                <span className="text-sm font-medium text-gray-900">{t.offer_label}</span>
                <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium ${status.tone}`}>
                  {status.spin ? <Loader2 className="h-3 w-3 animate-spin" /> : null}
                  {status.label}
                </span>
                {t.status !== 'pending' || t.cost_usd > 0 ? (
                  <span
                    className="text-xs tabular-nums text-gray-500"
                    title={`Все попытки ИИ написать эту цепочку${t.model ? ` · ${t.model}` : ''}`}
                  >
                    {fmtUsd(Number(t.cost_usd) || 0)}
                  </span>
                ) : null}
                {hasLetters ? (
                  <button
                    type="button"
                    aria-expanded={isOpen}
                    onClick={() => setOpen((prev) => ({ ...prev, [t.offer_key]: !isOpen }))}
                    className="ml-auto inline-flex items-center gap-1 text-xs font-medium text-violet-700 hover:underline"
                  >
                    {isOpen ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
                    {/* У переписываемой (pending) в строке остаются письма прошлой попытки. */}
                    {isOpen
                      ? 'Скрыть письма'
                      : t.status === 'ok'
                        ? 'Показать письма'
                        : t.status === 'pending'
                          ? 'Показать прошлый вариант'
                          : 'Показать неудачный вариант'}
                  </button>
                ) : null}
              </div>

              {hasWaiting ? (
                <div className="mt-1 text-xs text-amber-700">
                  Ждут эту цепочку: {companies(waiting ?? 0)} — {waitingWhere}
                </div>
              ) : null}

              {t.status === 'failed' ? (
                t.error ? (
                  <div className="mt-1.5 text-xs text-red-700">ИИ не написал цепочку: {t.error}</div>
                ) : (
                  <div className="mt-1.5 text-xs text-red-700">
                    {notes.length ? (
                      <>
                        Замечания автопроверки:
                        <ul className="mt-0.5 list-disc space-y-0.5 pl-5">
                          {notes.map((note, i) => (
                            <li key={i}>{note}</li>
                          ))}
                        </ul>
                      </>
                    ) : (
                      'Цепочка не прошла автопроверку.'
                    )}
                  </div>
                )
              ) : null}
              {t.status === 'pending' && t.stale ? (
                <div className="mt-1.5 text-xs text-amber-800">ИИ не дописал цепочку — процесс прервался.</div>
              ) : null}

              {/* Кнопка — только когда сервер её примет: запуск закончен и есть кого пересобрать. */}
              {needsRewrite && running ? (
                <div className="mt-2 text-xs text-gray-500">Переписать цепочку можно после окончания запуска.</div>
              ) : null}
              {needsRewrite && !running && waiting === 0 ? (
                <div className="mt-2 text-xs text-gray-500">Эту цепочку сейчас не ждёт ни одна компания — переписывать незачем.</div>
              ) : null}
              {(needsRewrite || lettersPending) && !running && waiting !== 0 && !isBusy ? (
                <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1">
                  <button
                    type="button"
                    disabled={busy !== null}
                    onClick={() => void regenerate(t)}
                    className="inline-flex items-center rounded-lg bg-violet-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-violet-700 disabled:opacity-50"
                  >
                    <RefreshCw className="mr-1.5 h-4 w-4" />
                    {needsRewrite ? 'Переписать цепочку' : 'Собрать письма'}
                  </button>
                  <span className="text-xs text-gray-500">
                    {needsRewrite
                      ? 'ИИ напишет цепочку заново и соберёт письма ждущих компаний. Займёт до 4 минут, оплата — из лимита запуска на ИИ.'
                      : 'Цепочка готова, но письма этих компаний ещё не собраны. Займёт до 4 минут.'}
                  </span>
                </div>
              ) : null}
              {isBusy ? (
                <div className="mt-2 flex items-center gap-2 rounded-lg bg-violet-50 px-3 py-2 text-sm text-violet-700">
                  <Loader2 className="h-4 w-4 shrink-0 animate-spin" />
                  <span>
                    {needsRewrite ? 'Переписываем цепочку и собираем письма' : 'Собираем письма'} — это может занять до 4 минут. Прошло{' '}
                    <span className="tabular-nums">{fmtElapsed(elapsedMs)}</span>.
                  </span>
                </div>
              ) : null}
              {outcome ? <div className={`mt-2 rounded-lg px-3 py-2 text-sm ${OUTCOME_TONE[outcome.tone]}`}>{outcome.text}</div> : null}

              {isOpen && hasLetters ? <TemplateLetters letters={t.letters ?? []} /> : null}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
