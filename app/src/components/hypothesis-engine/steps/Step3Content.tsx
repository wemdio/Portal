'use client';

/**
 * Шаг 3 мастера «Движка вертикалей» — «Контент вертикали»: черновая цепочка
 * писем (мастер-черновик) и вокабуляр для сбора базы. Поглощает старые
 * ChainView/VocabView. Занятость/ошибки джоб выводятся из jobs по stage.
 */

import { useCallback, useEffect, useMemo, useRef, useState, type JSX } from 'react';
import {
  ArrowRight,
  BarChart3,
  BookOpen,
  Check,
  Copy,
  Mail,
  Pencil,
  Plus,
  Search,
} from 'lucide-react';
import type {
  HeChainLanguage,
  HeCompanyType,
  HeCompanyTypeKind,
  HeJobTitle,
  HeVocab,
  HeVertical,
} from '@/lib/hypothesisEngine/types';
import {
  decideEditorExit,
  EDITOR_EXIT_MESSAGE,
  type EditorExitIntent,
} from '@/lib/hypothesisEngine/editorDirtyGuard';
import { HE_API, hePatch } from '../api';
import type {
  HeChainDto,
  HeChainLetterDto,
  HeChainPatchResponse,
  HeDossier,
  HeDossierData,
  HeJobSummary,
  HeLetterVariant,
} from '../api';
import { Badge, PotentialBadge, Spinner, StatusBox, type BadgeTone } from '../ui';

const LANG_OPTIONS: Array<{ value: HeChainLanguage; label: string }> = [
  { value: 'ru', label: 'RU' },
  { value: 'en', label: 'EN' },
  { value: 'pl', label: 'PL' },
];

const LANG_LABEL: Record<string, string> = { ru: 'RU', en: 'EN', pl: 'PL' };

const KIND_ORDER: HeCompanyTypeKind[] = ['canonical', 'synonym', 'geo_variant', 'adjacent', 'slang'];

const KIND_META: Record<HeCompanyTypeKind, { label: string; tone: BadgeTone }> = {
  canonical: { label: 'Каноническое', tone: 'emerald' },
  synonym: { label: 'Синоним', tone: 'blue' },
  geo_variant: { label: 'Гео-вариант', tone: 'amber' },
  adjacent: { label: 'Смежное', tone: 'violet' },
  slang: { label: 'Сленг', tone: 'gray' },
};

/** Вердикт досье «покупает ли сегмент каналы продаж» → лейбл и тон бейджа. */
const BUYS_CHANNELS_META: Record<'yes' | 'likely' | 'unknown', { label: string; tone: BadgeTone }> = {
  yes: { label: 'Сегмент покупает каналы продаж', tone: 'emerald' },
  likely: { label: 'Вероятно покупает', tone: 'amber' },
  unknown: { label: 'Про покупку каналов данных нет', tone: 'gray' },
};

/** На новых данных должность может нести audience_side; на старых поля нет. */
type JobTitleRow = HeJobTitle & { audience_side?: string };

/** Объектные A/B-варианты письма; легаси-строки старого формата отбрасываем. */
function abVariants(letter: HeChainLetterDto): HeLetterVariant[] {
  if (!Array.isArray(letter.variants)) return [];
  return (letter.variants as unknown[]).filter(
    (v): v is HeLetterVariant =>
      typeof v === 'object' && v !== null && typeof (v as HeLetterVariant).body === 'string',
  );
}

/** Русская словоформа «день/дня/дней». */
function daysWord(n: number): string {
  const abs = Math.abs(n) % 100;
  const d = abs % 10;
  if (abs > 10 && abs < 20) return 'дней';
  if (d === 1) return 'день';
  if (d >= 2 && d <= 4) return 'дня';
  return 'дней';
}

/** Сумма wait_days писем 0..idx включительно (для подписи «от старта» в редакторе). */
function cumulativeWaitDays(letters: HeChainLetterDto[], idx: number): number {
  let total = 0;
  for (let i = 0; i <= idx && i < letters.length; i += 1) {
    total += Math.max(0, letters[i]?.wait_days ?? 0);
  }
  return total;
}

function latestByCreatedAt<T extends { created_at: string }>(items: T[]): T | undefined {
  let best: T | undefined;
  for (const item of items) {
    if (!best || item.created_at > best.created_at) best = item;
  }
  return best;
}

/** Последняя джоба стадии (по started_at; записи без started_at считаются старыми). */
function latestStageJob(jobs: HeJobSummary[], stage: string): HeJobSummary | undefined {
  let best: HeJobSummary | undefined;
  for (const job of jobs) {
    // Сравниваем как строки: свежие стадии (напр. 'dossier') могут отставать в HeStage.
    if ((job.stage as string) !== stage) continue;
    if (!best || (job.started_at ?? '') >= (best.started_at ?? '')) best = job;
  }
  return best;
}

function jobActive(job: HeJobSummary | undefined): boolean {
  return job?.status === 'pending' || job?.status === 'running';
}

/** Нормализация источника поискового запроса в короткий лейбл группы. */
function sourceLabel(source: string): string {
  const s = source.toLowerCase();
  if (s.includes('hh')) return 'HH';
  if (s.includes('linkedin')) return 'LinkedIn';
  if (s.includes('реестр') || s.includes('registr')) return 'Реестры';
  if (s.includes('карт') || s.includes('map') || s.includes('gis')) return 'Карты';
  return source;
}

export function Step3Content(props: {
  vertical: HeVertical;
  chains: HeChainDto[];
  vocabs: HeVocab[];
  jobs: HeJobSummary[];
  onGenerateChain: (language: 'ru' | 'en' | 'pl') => void;
  onGenerateVocab: () => void;
  onGoToBase: () => void;
  /** Досье вертикалей проекта (из GET /projects/[id]). */
  dossiers?: HeDossier[];
  /** Запуск сборки досье выбранной вертикали (POST /verticals/[id]/dossier). */
  onBuildDossier?: () => void;
}): JSX.Element {
  const {
    vertical,
    chains,
    vocabs,
    jobs,
    onGenerateChain,
    onGenerateVocab,
    onGoToBase,
    dossiers,
    onBuildDossier,
  } = props;
  const [language, setLanguage] = useState<HeChainLanguage>('ru');

  const chain = useMemo(
    () => latestByCreatedAt(chains.filter((c) => c.vertical_id === vertical.id)),
    [chains, vertical.id],
  );

  // A/B-просмотр писем: какая сторона показана по каждому письму (0 = основной/A, 1 = вариант/B).
  // Состояние ключируется цепочкой (id + updated_at): свежие данные с сервера
  // (другая цепочка, перегенерация, подтверждённый PATCH после поллинга)
  // автоматически возвращают вид к основному варианту — без эффекта-сброса.
  const chainKey = chain ? `${chain.id}:${chain.updated_at}` : '';
  const [variantView, setVariantView] = useState<{ key: string; map: Record<number, number> }>({
    key: '',
    map: {},
  });
  const viewMap = variantView.key === chainKey ? variantView.map : {};
  // Оптимистично подменённые письма после «сделать основным» (до перезагрузки с сервера).
  const [lettersOverride, setLettersOverride] = useState<{
    chainKey: string;
    letters: HeChainLetterDto[];
  } | null>(null);
  const [variantBusy, setVariantBusy] = useState<number | null>(null);
  const [variantError, setVariantError] = useState('');

  // Инлайн-редактор письма: какое письмо открыто. Ключуется цепочкой, как
  // variantView: свежие данные с сервера автоматически закрывают редактор.
  const [editorState, setEditorState] = useState<{ key: string; idx: number } | null>(null);
  const editorIdx = editorState && editorState.key === chainKey ? editorState.idx : null;
  // Несохранённые правки открытого редактора (репорт из ChainLetterEditor в ref —
  // мутация ref из дочернего рендера безопасна, setState родителя — нет).
  const editorDirtyRef = useRef(false);
  const [lettersSaving, setLettersSaving] = useState(false);
  const [copiedIdx, setCopiedIdx] = useState<number | null>(null);

  // Свежие данные цепочки закрыли редактор — сбрасываем и dirty-флаг,
  // иначе он протухнет и даст ложный confirm при следующем действии.
  useEffect(() => {
    editorDirtyRef.current = false;
  }, [chainKey]);

  // Единая политика выхода из редактора при несохранённых правках (см.
  // editorDirtyGuard). true = действие продолжается; при clear редактор
  // закрывается, а правки отменяются.
  const requestEditorExit = useCallback(
    (intent: EditorExitIntent): boolean => {
      const { confirm, clear } = decideEditorExit(intent, editorDirtyRef.current);
      if (confirm && !window.confirm(EDITOR_EXIT_MESSAGE)) return false;
      if (clear) {
        editorDirtyRef.current = false;
        setEditorState(null);
      }
      return true;
    },
    [],
  );

  const letters = chain
    ? lettersOverride?.chainKey === chainKey
      ? lettersOverride.letters
      : chain.letters
    : [];

  // Полная замена писем цепочки (редактирование/добавление): PATCH {letters},
  // нормализованный сервером массив из ответа кладём в override.
  const saveLetters = async (nextLetters: HeChainLetterDto[]): Promise<boolean> => {
    if (!chain || lettersSaving) return false;
    setVariantError('');
    setLettersSaving(true);
    try {
      const { ok, data } = await hePatch<HeChainPatchResponse>(`${HE_API}/chains/${chain.id}`, {
        letters: nextLetters,
      });
      if (ok && data.letters) {
        setLettersOverride({ chainKey, letters: data.letters });
        return true;
      }
      setVariantError(data.error || 'Не удалось сохранить письма');
      return false;
    } finally {
      setLettersSaving(false);
    }
  };

  // «✎»: открыть редактор письма. Открытый dirty-редактор другого письма —
  // через подтверждение (правки будут отменены).
  const openEditor = (idx: number) => {
    if (editorIdx === idx) return;
    if (!requestEditorExit('switchLetter')) return;
    setEditorState({ key: chainKey, idx });
  };

  // «Сохранить» в редакторе: правим ТОЛЬКО основной вариант письма
  // (variants/segment_variants пересылаем как есть — сервер их сохранит).
  const saveEditedLetter = async (
    idx: number,
    patch: { subject: string | null; body: string; wait_days: number },
  ): Promise<void> => {
    const next = letters.map((l, i) => (i === idx ? { ...l, ...patch } : l));
    const saved = await saveLetters(next);
    if (saved) {
      editorDirtyRef.current = false;
      setEditorState(null);
    }
  };

  // «+ Добавить письмо»: новое письмо в конец со стартовым текстом,
  // пауза = пауза предыдущего + 2; после сохранения открываем его в редакторе.
  const addLetter = async () => {
    if (!chain || letters.length === 0 || letters.length >= 6 || lettersSaving) return;
    // Добавление откроет редактор нового письма — это замена открытого редактора.
    if (editorIdx !== null && !requestEditorExit('switchLetter')) return;
    const prevWait = Math.max(0, letters[letters.length - 1]?.wait_days ?? 0);
    const next: HeChainLetterDto[] = [
      ...letters,
      { subject: null, body: 'Здравствуйте!\n\n', wait_days: Math.min(90, prevWait + 2) },
    ];
    const saved = await saveLetters(next);
    if (saved) setEditorState({ key: chainKey, idx: next.length - 1 });
  };

  // Копирование показанной стороны письма: «{subject}\n\n{body}», краткое «✓».
  const copyLetter = (idx: number, subject: string | null, body: string) => {
    if (typeof navigator === 'undefined' || !navigator.clipboard) return;
    const text = subject ? `${subject}\n\n${body}` : body;
    void navigator.clipboard.writeText(text).then(() => {
      setCopiedIdx(idx);
      setTimeout(() => setCopiedIdx((cur) => (cur === idx ? null : cur)), 1500);
    });
  };

  // «Сделать основным»: оптимистично меняем местами основное письмо и вариант B,
  // затем PATCH; при ошибке — откат к серверным данным и плашка с ошибкой.
  const makeVariantPrimary = async (letterIdx: number) => {
    if (!chain || variantBusy !== null || lettersSaving) return;
    if (!requestEditorExit('swapVariant')) return;
    const letter = letters[letterIdx];
    const variant = letter ? abVariants(letter)[0] : undefined;
    if (!letter || !variant) return;
    setVariantError('');
    setVariantView({ key: chainKey, map: { ...viewMap, [letterIdx]: 0 } });
    setLettersOverride({
      chainKey,
      letters: letters.map((l, i) =>
        i === letterIdx
          ? {
              ...l,
              subject: variant.subject,
              body: variant.body,
              variants: [{ subject: l.subject, body: l.body }, ...abVariants(l).slice(1)],
            }
          : l,
      ),
    });
    setVariantBusy(letterIdx);
    try {
      const { ok, data } = await hePatch<HeChainPatchResponse>(`${HE_API}/chains/${chain.id}`, {
        letter_index: letterIdx,
        variant_index: 0,
      });
      if (ok && data.letters) {
        setLettersOverride({ chainKey, letters: data.letters });
      } else {
        // Откат: показываем серверные письма из пропсов, вид — как был (вариант B).
        setLettersOverride(null);
        setVariantView({ key: chainKey, map: { ...viewMap, [letterIdx]: 1 } });
        setVariantError(data.error || 'Не удалось сделать вариант основным');
      }
    } finally {
      setVariantBusy(null);
    }
  };
  const vocab = useMemo(
    () => latestByCreatedAt(vocabs.filter((v) => v.vertical_id === vertical.id)),
    [vocabs, vertical.id],
  );

  const chainJob = useMemo(() => latestStageJob(jobs, 'chain'), [jobs]);
  const vocabJob = useMemo(() => latestStageJob(jobs, 'vocab'), [jobs]);
  const chainBusy =
    jobActive(chainJob) || chain?.status === 'generating' || chain?.status === 'pending';
  const vocabBusy = jobActive(vocabJob);
  const chainFailed = !chainBusy && (chainJob?.status === 'failed' || chain?.status === 'failed');
  const vocabFailed = !vocabBusy && vocabJob?.status === 'failed';

  // Досье выбранной вертикали — последняя запись в выдаче.
  const dossier = useMemo(() => {
    let found: HeDossier | undefined;
    for (const d of dossiers ?? []) {
      if (d.vertical_id === vertical.id) found = d;
    }
    return found;
  }, [dossiers, vertical.id]);
  // Джоба досье привязана к вертикали через payload.vertical_id: без фильтра
  // чужая dossier-джоба показывала бы busy/error на карточке этой вертикали.
  // Джобы без payload (старые строки) вертикали не соответствуют.
  const dossierJob = useMemo(
    () => latestStageJob(jobs.filter((j) => j.payload?.vertical_id === vertical.id), 'dossier'),
    [jobs, vertical.id],
  );
  // Дедупликация: кнопка выключена, пока джоба досье pending/running (или строка ещё draft).
  const dossierBusy = jobActive(dossierJob) || dossier?.status === 'draft';
  const dossierFailed = !dossierBusy && (dossierJob?.status === 'failed' || dossier?.status === 'failed');
  const dossierReady = !dossierBusy && dossier?.status === 'ready' && dossier.data ? dossier.data : null;

  return (
    <div className="space-y-5">
      {/* Контекст шага */}
      <header>
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="text-lg font-bold text-gray-900">{vertical.name}</h2>
          <PotentialBadge pct={vertical.potential_pct} />
        </div>
        <p className="mt-1 text-sm text-gray-400">
          Черновые материалы под это направление. Боевой текст собирается на шаге 4–5 из загруженной
          базы.
        </p>
      </header>

      {/* Блок A: цепочка писем (черновик) */}
      <section className="rounded-2xl border border-gray-200 bg-white p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <Mail className="h-4 w-4 text-gray-400" aria-hidden />
              <h3 className="text-sm font-semibold text-gray-800">Цепочка писем (черновик)</h3>
              {chain ? (
                <Badge tone="blue">{LANG_LABEL[chain.language] ?? chain.language.toUpperCase()}</Badge>
              ) : null}
            </div>
            <p className="mt-1 text-xs text-gray-400">
              Мастер-черновик. В рассылку не идёт — основа для шаблона.
            </p>
          </div>
          <div className="inline-flex shrink-0 items-center overflow-hidden rounded-lg border border-gray-200">
            <select
              value={language}
              onChange={(e) => setLanguage(e.target.value as HeChainLanguage)}
              disabled={chainBusy}
              aria-label="Язык цепочки"
              className="h-9 border-r border-gray-200 bg-gray-50 px-2 text-xs font-medium text-gray-600 focus:outline-none disabled:opacity-50"
            >
              {LANG_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>
            <button
              type="button"
              onClick={() => {
                if (requestEditorExit('regenerate')) onGenerateChain(language);
              }}
              disabled={chainBusy}
              className="inline-flex h-9 items-center gap-1.5 bg-white px-3 text-xs font-medium text-gray-600 transition hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {chainBusy ? (
                <Spinner className="h-3.5 w-3.5" />
              ) : (
                <Mail className="h-3.5 w-3.5" aria-hidden />
              )}
              {chainFailed ? 'Попробовать снова' : chain ? 'Перегенерировать' : 'Сгенерировать'}
            </button>
          </div>
        </div>

        {chainFailed ? (
          <div className="mt-3">
            <StatusBox tone="error">
              {chainJob?.error || 'Генерация цепочки завершилась ошибкой.'} Нажмите «Попробовать
              снова».
            </StatusBox>
          </div>
        ) : null}
        {chainBusy ? (
          <div className="mt-3">
            <StatusBox tone="info">
              Генерируем цепочку — обычно 1–3 минуты. Страницу можно не закрывать: доделается
              сама.
            </StatusBox>
          </div>
        ) : null}

        {variantError ? (
          <div className="mt-3">
            <StatusBox tone="error">{variantError}</StatusBox>
          </div>
        ) : null}

        {chain && letters.length > 0 ? (
          <ol className="mt-4 space-y-3">
            {letters.map((letter, idx) => {
              // Открытый редактор заменяет карточку письма (правится только
              // основной вариант; A/B-показ других писем — read-only).
              if (editorIdx === idx) {
                return (
                  <li key={idx}>
                    <ChainLetterEditor
                      letterIndex={idx}
                      letter={letter}
                      baseDays={cumulativeWaitDays(letters, idx - 1)}
                      saving={lettersSaving}
                      onSave={(patch) => saveEditedLetter(idx, patch)}
                      onCancel={() => {
                        editorDirtyRef.current = false;
                        setEditorState(null);
                      }}
                      onDirtyChange={(d) => {
                        editorDirtyRef.current = d;
                      }}
                    />
                  </li>
                );
              }
              const variants = abVariants(letter);
              const view = viewMap[idx] ?? 0;
              const shown =
                view > 0 && variants[0]
                  ? variants[0]
                  : { subject: letter.subject, body: letter.body };
              return (
                <li key={idx} className="rounded-lg border border-gray-200 bg-gray-50/50 p-4">
                  <div className="mb-2 flex flex-wrap items-center gap-2">
                    <span className="flex h-6 w-6 items-center justify-center rounded-full bg-blue-100 text-[11px] font-bold text-blue-700">
                      {idx + 1}
                    </span>
                    {shown.subject ? (
                      <p className="text-sm font-semibold text-gray-900">{shown.subject}</p>
                    ) : (
                      <p className="text-sm italic text-gray-400">Без темы</p>
                    )}
                    {letter.wait_days > 0 ? (
                      <span className="text-[11px] text-gray-400">через {letter.wait_days} дн.</span>
                    ) : null}
                    <span className="ml-auto inline-flex items-center gap-1">
                      <button
                        type="button"
                        onClick={() => copyLetter(idx, shown.subject, shown.body)}
                        title="Скопировать письмо"
                        aria-label="Скопировать письмо"
                        className="inline-flex h-7 w-7 items-center justify-center rounded-md text-gray-400 transition hover:bg-gray-100 hover:text-gray-600"
                      >
                        {copiedIdx === idx ? (
                          <Check className="h-3.5 w-3.5 text-emerald-600" aria-hidden />
                        ) : (
                          <Copy className="h-3.5 w-3.5" aria-hidden />
                        )}
                      </button>
                      <button
                        type="button"
                        onClick={() => openEditor(idx)}
                        disabled={lettersSaving || chainBusy}
                        title="Редактировать письмо"
                        aria-label="Редактировать письмо"
                        className="inline-flex h-7 w-7 items-center justify-center rounded-md text-gray-400 transition hover:bg-gray-100 hover:text-gray-600 disabled:opacity-50"
                      >
                        <Pencil className="h-3.5 w-3.5" aria-hidden />
                      </button>
                    </span>
                  </div>
                  {variants.length > 0 ? (
                    <div className="mb-2 flex flex-wrap items-center gap-1.5">
                      <div className="inline-flex items-center overflow-hidden rounded-md border border-gray-200">
                        {(['A', 'B'] as const).map((side, sideIdx) => (
                          <button
                            key={side}
                            type="button"
                            aria-pressed={view === sideIdx}
                            disabled={variantBusy === idx}
                            onClick={() => {
                              if (!requestEditorExit('swapVariant')) return;
                              setVariantView({ key: chainKey, map: { ...viewMap, [idx]: sideIdx } });
                            }}
                            className={`px-2 py-0.5 text-[11px] font-semibold transition disabled:opacity-50 ${
                              view === sideIdx
                                ? 'bg-blue-600 text-white'
                                : 'bg-white text-gray-500 hover:bg-gray-100'
                            }`}
                          >
                            {side}
                          </button>
                        ))}
                      </div>
                      {view === 0 ? (
                        <span className="text-[10px] font-medium uppercase tracking-wide text-gray-400">
                          основной
                        </span>
                      ) : (
                        <>
                          <span className="text-[10px] text-gray-400">основной: A</span>
                          <button
                            type="button"
                            disabled={variantBusy !== null}
                            onClick={() => void makeVariantPrimary(idx)}
                            className="text-[11px] font-medium text-blue-600 transition hover:text-blue-700 disabled:opacity-50"
                          >
                            {variantBusy === idx ? 'Сохраняем…' : 'сделать основным'}
                          </button>
                        </>
                      )}
                    </div>
                  ) : null}
                  <p className="whitespace-pre-wrap text-sm leading-relaxed text-gray-700">
                    {shown.body}
                  </p>
                </li>
              );
            })}
          </ol>
        ) : null}
        {chain && letters.length > 0 ? (
          <div className="mt-3">
            <button
              type="button"
              onClick={() => void addLetter()}
              disabled={lettersSaving || chainBusy || letters.length >= 6}
              className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-dashed border-gray-300 bg-white px-3 text-xs font-medium text-gray-600 transition hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {lettersSaving ? (
                <Spinner className="h-3.5 w-3.5" />
              ) : (
                <Plus className="h-3.5 w-3.5" aria-hidden />
              )}
              Добавить письмо
            </button>
          </div>
        ) : null}
        {!chain && !chainBusy && !chainFailed ? (
          <p className="mt-4 text-xs text-gray-400">
            Цепочки пока нет — выберите язык и нажмите «Сгенерировать».
          </p>
        ) : null}
      </section>

      {/* Блок B: вокабуляр для сбора базы */}
      <section className="rounded-2xl border border-gray-200 bg-white p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <BookOpen className="h-4 w-4 text-gray-400" aria-hidden />
              <h3 className="text-sm font-semibold text-gray-800">Вокабуляр для сбора базы</h3>
            </div>
            <p className="mt-1 text-xs text-gray-400">
              Технический слой: по этим терминам ищем компании и должности в HH/картах/реестрах. В
              письмах не используется.
            </p>
          </div>
          <button
            type="button"
            onClick={onGenerateVocab}
            disabled={vocabBusy}
            className="inline-flex h-9 shrink-0 items-center gap-1.5 rounded-lg border border-gray-200 bg-white px-3 text-xs font-medium text-gray-600 transition hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {vocabBusy ? (
              <Spinner className="h-3.5 w-3.5" />
            ) : (
              <BookOpen className="h-3.5 w-3.5" aria-hidden />
            )}
            {vocabFailed ? 'Попробовать снова' : vocab ? 'Перегенерировать' : 'Сгенерировать'}
          </button>
        </div>

        {vocabFailed ? (
          <div className="mt-3">
            <StatusBox tone="error">
              {vocabJob?.error || 'Генерация вокабуляра завершилась ошибкой.'} Нажмите «Попробовать
              снова».
            </StatusBox>
          </div>
        ) : null}
        {vocabBusy && !vocab ? (
          <div className="mt-3">
            <StatusBox tone="info">Собираем вокабуляр — обычно 1–2 минуты…</StatusBox>
          </div>
        ) : null}

        {vocab ? (
          <div className="mt-4 grid gap-4 xl:grid-cols-2">
            <div className="xl:col-span-2">
              <JobTitlesCard jobTitles={(vocab.job_titles ?? []) as JobTitleRow[]} />
            </div>
            <CompanyTypesCard companyTypes={vocab.company_types ?? []} />
            <QueriesCard queries={vocab.search_queries ?? []} />
          </div>
        ) : null}
        {!vocab && !vocabBusy && !vocabFailed ? (
          <p className="mt-4 text-xs text-gray-400">Вокабуляра пока нет — нажмите «Сгенерировать».</p>
        ) : null}
      </section>

      {/* Блок C: досье вертикали — объективные числа сегмента */}
      <section className="rounded-2xl border border-gray-200 bg-white p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <BarChart3 className="h-4 w-4 text-gray-400" aria-hidden />
              <h3 className="text-sm font-semibold text-gray-800">Досье вертикали</h3>
            </div>
            <p className="mt-1 text-xs text-gray-400">
              Объективные числа сегмента: наша директория, hh.ru, статистика наших кампаний.
            </p>
          </div>
          {onBuildDossier ? (
            <button
              type="button"
              onClick={onBuildDossier}
              disabled={dossierBusy}
              className="inline-flex h-9 shrink-0 items-center gap-1.5 rounded-lg border border-gray-200 bg-white px-3 text-xs font-medium text-gray-600 transition hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {dossierBusy ? (
                <Spinner className="h-3.5 w-3.5" />
              ) : (
                <BarChart3 className="h-3.5 w-3.5" aria-hidden />
              )}
              {dossierFailed ? 'Попробовать снова' : dossierReady ? 'Пересобрать' : 'Собрать досье'}
            </button>
          ) : null}
        </div>

        {dossierFailed ? (
          <div className="mt-3">
            <StatusBox tone="error">
              {dossier?.error || dossierJob?.error || 'Сборка досье завершилась ошибкой.'} Нажмите
              «Попробовать снова».
            </StatusBox>
          </div>
        ) : null}
        {dossierBusy && !dossierReady ? (
          <div className="mt-3">
            <StatusBox tone="info">Собираем досье — обычно 2–5 минут…</StatusBox>
          </div>
        ) : null}

        {dossierReady ? (
          <div className="mt-4 grid gap-4 lg:grid-cols-3">
            <DossierSegmentCard data={dossierReady} />
            <DossierSignalsCard data={dossierReady} />
            <DossierDatasetCard data={dossierReady} />
          </div>
        ) : null}
        {!dossier && !dossierBusy && !dossierFailed ? (
          <p className="mt-4 text-xs text-gray-400">Досье пока нет — нажмите «Собрать досье».</p>
        ) : null}
      </section>

      {/* Переход к шагу «База» — всегда доступен */}
      <div className="flex justify-end">
        <button
          type="button"
          onClick={() => {
            if (requestEditorExit('leaveStep')) onGoToBase();
          }}
          className="inline-flex h-11 items-center justify-center gap-2 rounded-lg bg-blue-600 px-5 text-sm font-medium text-white transition hover:bg-blue-700"
        >
          Далее: загрузить базу
          <ArrowRight className="h-4 w-4" aria-hidden />
        </button>
      </div>
    </div>
  );
}

/* ─────────────────────────── Редактор письма ─────────────────────────── */

/**
 * Инлайн-редактор основного письма цепочки (шаг 3). Правит ТОЛЬКО основной
 * вариант: A/B-варианты в редактор не попадают и после сохранения остаются
 * как были. Паттерн — как LetterEditor в email-sequence-v2: ленивый сброс
 * формы по versionKey (без useEffect), репорт dirty наверх в ref родителя.
 */
function ChainLetterEditor({
  letterIndex,
  letter,
  baseDays,
  saving,
  onSave,
  onCancel,
  onDirtyChange,
}: {
  letterIndex: number;
  letter: HeChainLetterDto;
  /** Сумма wait_days писем ДО этого — для подписи «через N дней от старта». */
  baseDays: number;
  saving: boolean;
  onSave: (patch: { subject: string | null; body: string; wait_days: number }) => Promise<void>;
  onCancel: () => void;
  onDirtyChange: (dirty: boolean) => void;
}) {
  // Сбрасываем локальное состояние формы, когда меняется содержимое письма
  // на сервере (после сохранения/перегенерации/смены письма). Ленивая
  // инициализация без useEffect (правило react-hooks/set-state-in-effect).
  const versionKey = `${letterIndex}|${letter.subject ?? ''}|${letter.body}|${letter.wait_days}`;
  const [storedVersionKey, setStoredVersionKey] = useState(versionKey);
  const [subject, setSubject] = useState(letter.subject ?? '');
  const [body, setBody] = useState(letter.body);
  const [waitDays, setWaitDays] = useState<number>(letter.wait_days ?? 0);
  const [dirty, setDirty] = useState(false);
  if (storedVersionKey !== versionKey) {
    setStoredVersionKey(versionKey);
    setSubject(letter.subject ?? '');
    setBody(letter.body);
    setWaitDays(letter.wait_days ?? 0);
    setDirty(false);
    // Мутация ref родителя во время рендера безопасна (не setState).
    onDirtyChange(false);
  }

  const markDirty = () => {
    setDirty(true);
    onDirtyChange(true);
  };

  const isFirst = letterIndex === 0;
  // Кумулятивная подпись «от старта»: сумма пауз предыдущих писем + текущая.
  const totalDays = baseDays + (isFirst ? 0 : waitDays);
  const startCaption =
    totalDays === 0 ? 'Сразу' : `через ${totalDays} ${daysWord(totalDays)} от старта`;

  return (
    <div className="rounded-lg border border-blue-200 bg-white p-4">
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <span className="flex h-6 w-6 items-center justify-center rounded-full bg-blue-100 text-[11px] font-bold text-blue-700">
          {letterIndex + 1}
        </span>
        <p className="text-sm font-semibold text-gray-900">Редактирование письма</p>
        {isFirst ? (
          <span className="text-xs text-gray-400">Отправка: сразу</span>
        ) : (
          <label className="inline-flex items-center gap-1.5 text-xs text-gray-500">
            Отправка: через
            <input
              type="number"
              min={0}
              max={90}
              value={waitDays}
              onChange={(e) => {
                const v = Math.min(90, Math.max(0, Math.trunc(Number(e.target.value) || 0)));
                setWaitDays(v);
                markDirty();
              }}
              className="w-16 rounded-lg border border-gray-300 px-2 py-1 text-center text-sm"
            />
            {daysWord(waitDays)} после предыдущего
          </label>
        )}
        <span className="text-[11px] text-gray-400">({startCaption})</span>
      </div>

      <label className="block">
        <span className="mb-1 block text-[11px] font-semibold uppercase tracking-widest text-gray-400">
          Тема письма
        </span>
        <input
          value={subject}
          onChange={(e) => {
            setSubject(e.target.value);
            markDirty();
          }}
          placeholder="Тема письма"
          className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-blue-400 focus:outline-none"
        />
      </label>
      <label className="mt-3 block">
        <span className="mb-1 block text-[11px] font-semibold uppercase tracking-widest text-gray-400">
          Текст письма
        </span>
        <textarea
          value={body}
          onChange={(e) => {
            setBody(e.target.value);
            markDirty();
          }}
          rows={Math.min(20, Math.max(8, body.split('\n').length + 1))}
          className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm leading-relaxed focus:border-blue-400 focus:outline-none"
        />
      </label>
      <div className="mt-3 flex items-center justify-end gap-2">
        <button
          type="button"
          onClick={onCancel}
          disabled={saving}
          className="inline-flex h-9 items-center rounded-lg border border-gray-200 bg-white px-3 text-xs font-medium text-gray-600 transition hover:bg-gray-50 disabled:opacity-50"
        >
          Отмена
        </button>
        <button
          type="button"
          onClick={() =>
            void onSave({
              subject: subject.trim() === '' ? null : subject,
              body,
              wait_days: isFirst ? 0 : waitDays,
            })
          }
          disabled={!dirty || saving}
          className="inline-flex h-9 items-center rounded-lg bg-blue-600 px-4 text-xs font-medium text-white transition hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {saving ? 'Сохраняем…' : 'Сохранить'}
        </button>
      </div>
    </div>
  );
}

/* ─────────────────────────── Карточки досье ─────────────────────────── */

/** Крупная цифра с подписью — «.num»-статистика карточек досье. */
function DossierNum({ value, caption }: { value: string; caption: string }) {
  return (
    <div>
      <p className="text-2xl font-bold tabular-nums text-gray-900">{value}</p>
      <p className="text-[11px] text-gray-400">{caption}</p>
    </div>
  );
}

/** «Сегмент в цифрах»: компании директории, вакансии hh, оценка размера сегмента. */
function DossierSegmentCard({ data }: { data: HeDossierData }) {
  const { counters, interpretation } = data;
  return (
    <div className="rounded-xl border border-gray-200 bg-gray-50/50 p-3">
      <p className="mb-2 text-xs font-semibold uppercase tracking-widest text-gray-400">Сегмент в цифрах</p>
      <div className="space-y-3">
        {counters.companies_total != null ? (
          <div>
            <DossierNum
              value={`~${counters.companies_total.toLocaleString('ru-RU')}`}
              caption="компаний в директории"
            />
            {counters.companies_note ? (
              <p className="mt-0.5 text-[11px] text-gray-400">{counters.companies_note}</p>
            ) : null}
          </div>
        ) : null}
        {counters.hh_vacancies_total != null ? (
          <div>
            <DossierNum
              value={counters.hh_vacancies_total.toLocaleString('ru-RU')}
              caption="вакансий на hh.ru"
            />
            {counters.hh_vacancies_sample.length > 0 ? (
              <details className="group mt-1">
                <summary className="cursor-pointer list-none text-[11px] font-medium text-gray-500 hover:text-gray-700">
                  Примеры вакансий ({counters.hh_vacancies_sample.length})
                </summary>
                <ul className="mt-1 space-y-0.5 border-l-2 border-gray-100 pl-2 text-[11px] text-gray-500">
                  {counters.hh_vacancies_sample.map((title, i) => (
                    <li key={i}>{title}</li>
                  ))}
                </ul>
              </details>
            ) : null}
          </div>
        ) : null}
        {interpretation.segment_size_assessment ? (
          <SegmentSizeBadge value={interpretation.segment_size_assessment} />
        ) : null}
      </div>
    </div>
  );
}

/** Бейдж размера сегмента: «LARGE — пояснение» → пилюля размера + текст под ней. */
const SEGMENT_SIZE_META: Record<string, { label: string; tone: 'emerald' | 'amber' | 'gray' }> = {
  large: { label: 'Крупный сегмент', tone: 'emerald' },
  medium: { label: 'Средний сегмент', tone: 'amber' },
  niche: { label: 'Нишевый сегмент', tone: 'gray' },
};

function SegmentSizeBadge({ value }: { value: string }) {
  const [rawSize, ...rest] = value.split('—');
  const sizeKey = (rawSize ?? '').trim().toLowerCase();
  const meta = SEGMENT_SIZE_META[sizeKey];
  const note = rest.join('—').trim();
  return (
    <div>
      <Badge tone={meta?.tone ?? 'blue'}>{meta?.label ?? (rawSize ?? '').trim()}</Badge>
      {note ? <p className="mt-1 text-[11px] leading-relaxed text-gray-400">{note}</p> : null}
    </div>
  );
}

/** «Сигналы боли»: список сигналов из счётчиков (метка + значение). */
function DossierSignalsCard({ data }: { data: HeDossierData }) {
  const { signals } = data.counters;
  // У старых досье поля вердикта нет — тогда блок не рендерим вообще.
  const buysChannels = data.interpretation.buys_sales_channels;
  const buysMeta = buysChannels ? BUYS_CHANNELS_META[buysChannels] : undefined;
  return (
    <div className="rounded-xl border border-gray-200 bg-gray-50/50 p-3">
      <p className="mb-2 text-xs font-semibold uppercase tracking-widest text-gray-400">Сигналы боли</p>
      {signals.length === 0 ? (
        <p className="text-xs text-gray-400">Сигналов не найдено.</p>
      ) : (
        <ul className="space-y-1.5">
          {signals.map((s, i) => (
            <li key={i} className="flex items-baseline justify-between gap-2 text-xs">
              <span className="min-w-0 text-gray-600" title={s.source}>
                {s.label}
              </span>
              <span className="shrink-0 font-semibold tabular-nums text-gray-900">{s.value}</span>
            </li>
          ))}
        </ul>
      )}
      {buysMeta ? (
        <div className="mt-3 border-t border-gray-200 pt-2">
          <Badge tone={buysMeta.tone}>{buysMeta.label}</Badge>
          {data.interpretation.buys_sales_channels_reason ? (
            <p className="mt-1 text-[11px] leading-relaxed text-gray-400">
              {data.interpretation.buys_sales_channels_reason}
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/** «Наши кампании»: reply против базового, охват, сегменты, лучшие темы, выводы. */
function DossierDatasetCard({ data }: { data: HeDossierData }) {
  const { dataset_stats: ds, interpretation } = data;
  return (
    <div className="rounded-xl border border-gray-200 bg-gray-50/50 p-3">
      <p className="mb-2 text-xs font-semibold uppercase tracking-widest text-gray-400">Наши кампании</p>
      {ds.reply_pct != null || ds.baseline_pct != null ? (
        <div className="flex flex-wrap gap-6">
          {ds.reply_pct != null ? <DossierNum value={`${ds.reply_pct}%`} caption="reply в вертикали" /> : null}
          {ds.baseline_pct != null ? (
            <DossierNum value={`${ds.baseline_pct}%`} caption="в среднем по базе" />
          ) : null}
        </div>
      ) : null}
      <p className="mt-2 text-[11px] text-gray-400">
        {ds.campaigns.toLocaleString('ru-RU')} кампаний · {ds.sent.toLocaleString('ru-RU')} отправлено ·{' '}
        {ds.replies.toLocaleString('ru-RU')} ответов
      </p>
      {ds.note ? <p className="mt-1 text-[11px] text-gray-400">{ds.note}</p> : null}
      {ds.matched_segments.length > 0 ? (
        <div className="mt-2 flex flex-wrap gap-1">
          {ds.matched_segments.map((seg) => (
            <span key={seg} className="rounded bg-white px-1.5 py-0.5 text-[11px] text-gray-600 ring-1 ring-gray-200">
              {seg}
            </span>
          ))}
        </div>
      ) : null}
      {ds.top_subjects.length > 0 ? (
        <details className="group mt-2">
          <summary className="cursor-pointer list-none text-[11px] font-medium text-gray-500 hover:text-gray-700">
            Лучшие темы ({ds.top_subjects.length})
          </summary>
          <ul className="mt-1 space-y-0.5 border-l-2 border-gray-100 pl-2 text-[11px] text-gray-500">
            {ds.top_subjects.map((subj, i) => (
              <li key={i}>{subj}</li>
            ))}
          </ul>
        </details>
      ) : null}
      {interpretation.dataset_verdict ? (
        <details className="group mt-2">
          <summary className="cursor-pointer list-none text-[11px] font-medium text-gray-500 hover:text-gray-700">
            Вывод по кампаниям
          </summary>
          <p className="mt-1 text-xs leading-relaxed text-gray-500">{interpretation.dataset_verdict}</p>
        </details>
      ) : null}
      {interpretation.market_summary ? (
        <details className="group mt-1.5">
          <summary className="cursor-pointer list-none text-[11px] font-medium text-gray-500 hover:text-gray-700">
            Резюме рынка
          </summary>
          <p className="mt-1 text-xs leading-relaxed text-gray-400">{interpretation.market_summary}</p>
        </details>
      ) : null}
    </div>
  );
}

/* ─────────────────────────── Карточки вокабуляра ─────────────────────────── */

function CompanyTypesCard({ companyTypes }: { companyTypes: HeCompanyType[] }) {
  const grouped = useMemo(() => {
    const map = new Map<HeCompanyTypeKind, HeCompanyType[]>();
    for (const ct of companyTypes) {
      const list = map.get(ct.kind) ?? [];
      list.push(ct);
      map.set(ct.kind, list);
    }
    const ordered = KIND_ORDER.filter((k) => map.has(k));
    for (const k of map.keys()) {
      if (!ordered.includes(k)) ordered.push(k);
    }
    return ordered.map((kind) => ({ kind, items: map.get(kind)! }));
  }, [companyTypes]);

  return (
    <div className="rounded-xl border border-gray-200 bg-gray-50/50 p-3">
      <p className="mb-2 text-xs font-semibold uppercase tracking-widest text-gray-400">
        Типы компаний ({companyTypes.length})
      </p>
      {grouped.length === 0 ? (
        <p className="text-xs text-gray-400">Пусто.</p>
      ) : (
        <div className="space-y-2.5">
          {grouped.map(({ kind, items }) => {
            const meta = KIND_META[kind] ?? KIND_META.synonym;
            return (
              <div key={kind}>
                <p className="mb-1">
                  <Badge tone={meta.tone}>{meta.label}</Badge>
                </p>
                <div className="flex flex-wrap gap-1">
                  {items.map((ct, i) => (
                    <span
                      key={`${ct.term}-${i}`}
                      title={ct.notes}
                      className="rounded bg-white px-1.5 py-0.5 text-[11px] text-gray-600 ring-1 ring-gray-200"
                    >
                      {ct.term}
                    </span>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function JobTitlesCard({ jobTitles }: { jobTitles: JobTitleRow[] }) {
  const hasSide = jobTitles.some((jt) => jt.audience_side);
  const buyerRows = hasSide
    ? jobTitles.filter((jt) => jt.audience_side !== 'campaign_target')
    : jobTitles;
  const targetRows = hasSide ? jobTitles.filter((jt) => jt.audience_side === 'campaign_target') : [];

  return (
    <div className="rounded-xl border border-gray-200 bg-gray-50/50 p-3">
      <p className="mb-2 text-xs font-semibold uppercase tracking-widest text-gray-400">
        Должности ({jobTitles.length})
      </p>
      {jobTitles.length === 0 ? (
        <p className="text-xs text-gray-400">Пусто.</p>
      ) : hasSide ? (
        <div className="space-y-3">
          <JobTitlesTable title="Кому продаём" rows={buyerRows} />
          <JobTitlesTable title="Кого достаём клиенту" rows={targetRows} />
        </div>
      ) : (
        <JobTitlesTable rows={jobTitles} />
      )}
    </div>
  );
}

function JobTitlesTable({ title, rows }: { title?: string; rows: JobTitleRow[] }) {
  if (rows.length === 0) return null;
  return (
    <div>
      {title ? <p className="mb-1 text-[11px] font-semibold text-gray-500">{title}</p> : null}
      <div className="overflow-x-auto rounded-lg border border-gray-200 bg-white">
        <table className="min-w-full divide-y divide-gray-200 text-xs">
          <thead className="bg-gray-50">
            <tr>
              <th className="px-2 py-1.5 text-left font-semibold text-gray-500">Должность</th>
              <th className="px-2 py-1.5 text-left font-semibold text-gray-500">Грейд</th>
              <th className="px-2 py-1.5 text-left font-semibold text-gray-500">Функция</th>
              <th className="px-2 py-1.5 text-left font-semibold text-gray-500">Другие названия</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {rows.map((jt, i) => (
              <tr key={`${jt.title}-${i}`}>
                <td className="px-2 py-1.5 align-top font-medium text-gray-900">{jt.title}</td>
                <td className="px-2 py-1.5 align-top text-gray-600">{jt.seniority || '—'}</td>
                <td className="px-2 py-1.5 align-top text-gray-600">{jt.function || '—'}</td>
                <td className="px-2 py-1.5 align-top">
                  {jt.alt_names && jt.alt_names.length > 0 ? (
                    <span className="flex flex-wrap gap-1">
                      {jt.alt_names.map((alt) => (
                        <span
                          key={alt}
                          className="rounded bg-gray-100 px-1.5 py-0.5 text-[11px] text-gray-600"
                        >
                          {alt}
                        </span>
                      ))}
                    </span>
                  ) : (
                    '—'
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function QueriesCard({ queries }: { queries: HeVocab['search_queries'] }) {
  const grouped = useMemo(() => {
    const map = new Map<string, HeVocab['search_queries']>();
    for (const q of queries) {
      const key = sourceLabel(q.source || 'Прочее');
      const list = map.get(key) ?? [];
      list.push(q);
      map.set(key, list);
    }
    return [...map.entries()];
  }, [queries]);

  return (
    <div className="rounded-xl border border-gray-200 bg-gray-50/50 p-3">
      <p className="mb-2 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-widest text-gray-400">
        <Search className="h-3.5 w-3.5" aria-hidden />
        Поисковые запросы ({queries.length})
      </p>
      {grouped.length === 0 ? (
        <p className="text-xs text-gray-400">Пусто.</p>
      ) : (
        <div className="space-y-2.5">
          {grouped.map(([source, list]) => (
            <div key={source}>
              <p className="mb-1">
                <Badge tone="blue">{source}</Badge>
              </p>
              <div className="flex flex-wrap gap-1">
                {list.map((q, qi) => (
                  <code
                    key={qi}
                    title={q.purpose}
                    className="rounded bg-white px-1.5 py-0.5 font-mono text-[11px] text-gray-700 ring-1 ring-gray-200"
                  >
                    {q.query}
                  </code>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
