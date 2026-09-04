'use client';

/**
 * Шаг 1 мастера «Движка вертикалей» — «Исследование».
 * Три состояния: пустое (объяснение + запуск + оффер + подпись отправителя +
 * эталон стиля), прогресс по стадиям
 * research-пайплайна человеческими формулировками (без технических деталей)
 * и компактное «готово». Навигация между шагами — забота оболочки (ProjectDetail).
 * Питается от массива jobs проекта: состояние стадии = статус её последней джобы.
 * Визуал — токены design.ts: рабочая поверхность, статусы и ясные действия.
 */

import { useEffect, useRef, useState, type JSX } from 'react';
import { Play, RotateCcw } from 'lucide-react';
import type { VeStage } from '@/lib/verticalEngineV2/types';
import { StatusBox } from '../ui';
import { HE, Spinner, StatusDot } from '../design';
import { ClientBriefBlock } from './ClientBriefBlock';
import { CasesBlock } from './CasesBlock';
import {
  VE_API,
  veEnginePatch,
  type VeCaseEntry,
  type VeJobSummary,
  type VeProjectDetailResponse,
  type VeProjectResponse,
} from '../api';

/** line — строка в чек-листе прогресса; name — короткое имя для сообщения об ошибке. */
const RESEARCH_STAGES: Array<{ stage: VeStage; line: string; name: string }> = [
  {
    stage: 'site_profile',
    line: 'Изучаем сайт клиента',
    name: 'Изучение сайта',
  },
  { stage: 'competitors', line: 'Ищем конкурентов', name: 'Поиск конкурентов' },
  {
    stage: 'brand_cloud',
    line: 'Разбираем клиентов конкурентов',
    name: 'Разбор клиентов конкурентов',
  },
  {
    stage: 'hypotheses',
    line: 'Генерируем гипотезы рынков',
    name: 'Генерация гипотез',
  },
  {
    stage: 'evidence',
    line: 'Проверяем каждую гипотезу источниками',
    name: 'Проверка гипотез',
  },
  {
    stage: 'clustering',
    line: 'Собираем вертикали',
    name: 'Сборка вертикалей',
  },
];

const RESEARCH_STAGE_SET: ReadonlySet<VeStage> = new Set(RESEARCH_STAGES.map((s) => s.stage));

/** Последняя (по порядку в выдаче) джоба данной стадии. */
function latestJobOf(jobs: VeJobSummary[], stage: VeStage): VeJobSummary | undefined {
  for (let i = jobs.length - 1; i >= 0; i -= 1) {
    if (jobs[i].stage === stage) return jobs[i];
  }
  return undefined;
}

export interface Step1ResearchProps {
  project: VeProjectDetailResponse['project'];
  jobs: VeJobSummary[];
  busy: boolean;
  onStartResearch: () => void;
  onGoToVerticals?: () => void;
  offerValue: string;
  onSaveOffer: (v: string) => Promise<void> | void;
  /** Эталон стиля (brief.style_override). Если не передан — читаем из project.brief. */
  styleValue?: string;
  /** Колбэк после сохранения эталона стиля — обычно тихая перезагрузка деталей. */
  onStyleSaved?: () => void;
  /** Банк кейсов клиента (сайт + ручные загрузки). */
  cases?: VeCaseEntry[];
  /** Колбэк после добавления/удаления кейса — обычно тихая перезагрузка деталей. */
  onCasesChanged?: () => void;
}

export function Step1Research({
  project,
  jobs,
  busy,
  onStartResearch,
  onGoToVerticals,
  offerValue,
  onSaveOffer,
  styleValue,
  onStyleSaved,
  cases,
  onCasesChanged,
}: Step1ResearchProps): JSX.Element {
  const [restartConfirmOpen, setRestartConfirmOpen] = useState(false);
  const restartTriggerRef = useRef<HTMLButtonElement>(null);
  const restartConfirmRef = useRef<HTMLButtonElement>(null);
  const runningStatusRef = useRef<HTMLElement>(null);
  const focusRunningAfterRestartRef = useRef(false);
  const status = project?.status;
  // Эталон стиля: приоритет у пропа, иначе — напрямую из brief проекта
  // (ProjectDetail может не передавать styleValue).
  const briefStyle = project?.brief?.style_override;
  const resolvedStyleValue = styleValue ?? (typeof briefStyle === 'string' ? briefStyle : '');
  // Подпись отправителя — тем же паттерном из brief (signature_override).
  const briefSignature = project?.brief?.signature_override;
  const resolvedSignatureValue = typeof briefSignature === 'string' ? briefSignature : '';
  // Ручное описание бизнеса (business_override) + флаг «тонкого» сайта:
  // site_profile помечает brief.site_thin, когда текст сайта не извлечь.
  const briefBusiness = project?.brief?.business_override;
  const resolvedBusinessValue = typeof briefBusiness === 'string' ? briefBusiness : '';
  const siteThin = (project?.brief as { site_thin?: unknown } | null | undefined)?.site_thin === true;
  const researchJobs = jobs.filter((j) => RESEARCH_STAGE_SET.has(j.stage));
  const hasActiveResearch = researchJobs.some((j) => j.status === 'pending' || j.status === 'running');
  const failedStages = RESEARCH_STAGES.filter(({ stage }) => latestJobOf(jobs, stage)?.status === 'failed');

  const running = busy || hasActiveResearch || status === 'researching';
  const done = !running && status === 'researched';
  const failed = !running && !done && (failedStages.length > 0 || status === 'failed');

  useEffect(() => {
    if (restartConfirmOpen) restartConfirmRef.current?.focus();
  }, [restartConfirmOpen]);

  useEffect(() => {
    if (!running || !focusRunningAfterRestartRef.current) return;
    focusRunningAfterRestartRef.current = false;
    runningStatusRef.current?.focus();
  }, [running]);

  const closeRestartConfirm = () => {
    setRestartConfirmOpen(false);
    restartTriggerRef.current?.focus();
  };

  if (running) {
    return (
      <section
        ref={runningStatusRef}
        role="region"
        aria-labelledby="ve2-research-running-title"
        tabIndex={-1}
        className="ve2-panel max-w-[640px] p-6"
      >
        <div className="mb-2 flex items-baseline justify-between gap-3">
          <h2 id="ve2-research-running-title" className={HE.secTitle}>
            Идёт исследование…
          </h2>
          <span className="ve2-faint">прогресс обновляется автоматически</span>
        </div>
        <StageChecklist jobs={jobs} running />
        {failedStages.length > 0 ? (
          <FailureNote failedStages={failedStages} jobs={jobs} busy={busy} onRetry={onStartResearch} />
        ) : null}
        <p className={`mt-4 text-xs ${HE.muted}`}>Это займёт несколько минут, страницу можно не держать открытой.</p>
      </section>
    );
  }

  if (failed) {
    return (
      <section className="ve2-panel max-w-[640px] p-6">
        <h2 className={`mb-4 ${HE.secTitle}`}>Исследование остановилось</h2>
        <StageChecklist jobs={jobs} running={false} />
        <FailureNote
          failedStages={failedStages}
          jobs={jobs}
          projectError={failedStages.length === 0 ? project?.error : undefined}
          busy={busy}
          onRetry={onStartResearch}
        />
      </section>
    );
  }

  if (done) {
    return (
      <section>
        <div className={`flex items-start gap-3 px-4 py-3 ${HE.successPanel}`}>
          <StatusDot tone="ok" className="mt-1.5" />
          <div>
            <p className="text-sm font-semibold">Исследование готово</p>
            <p className={`mt-0.5 text-sm ${HE.muted}`}>Вертикали собраны — переходим к выбору направления.</p>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              {onGoToVerticals ? (
                <button type="button" onClick={onGoToVerticals} className="ve2-btn ve2-b-sec ve2-b-sm">
                  К выбору направления
                </button>
              ) : null}
              <button
                ref={restartTriggerRef}
                type="button"
                disabled={busy}
                onClick={() => setRestartConfirmOpen(true)}
                className="ve2-b-quiet"
              >
                <RotateCcw aria-hidden className="h-3.5 w-3.5" />
                Перезапустить
              </button>
            </div>
          </div>
        </div>
        {restartConfirmOpen ? (
          <div
            className="ve2-confirm"
            role="alertdialog"
            aria-label="Подтверждение перезапуска"
            onKeyDown={(event) => {
              if (event.key !== 'Escape') return;
              event.preventDefault();
              event.stopPropagation();
              closeRestartConfirm();
            }}
          >
            <span className={HE.muted}>
              Перезапустить исследование? Готовые результаты останутся, новые списания начнутся заново.
            </span>
            <button
              ref={restartConfirmRef}
              type="button"
              className="ve2-btn ve2-b-dan ve2-b-sm"
              onClick={() => {
                focusRunningAfterRestartRef.current = true;
                setRestartConfirmOpen(false);
                restartTriggerRef.current?.focus();
                onStartResearch();
              }}
            >
              Да, перезапустить
            </button>
            <button type="button" className="ve2-b-quiet" onClick={closeRestartConfirm}>
              Отмена
            </button>
          </div>
        ) : null}
        <ResearchContextGrid
          offerValue={offerValue}
          onSaveOffer={onSaveOffer}
          styleValue={resolvedStyleValue}
          onStyleSaved={onStyleSaved}
          signatureValue={resolvedSignatureValue}
          businessValue={resolvedBusinessValue}
          siteThin={siteThin}
          projectId={project?.id ?? null}
          cases={cases ?? []}
          onCasesChanged={onCasesChanged}
        />
      </section>
    );
  }

  return (
    <NotStarted
      busy={busy}
      onStartResearch={onStartResearch}
      offerValue={offerValue}
      onSaveOffer={onSaveOffer}
      styleValue={resolvedStyleValue}
      onStyleSaved={onStyleSaved}
      signatureValue={resolvedSignatureValue}
      businessValue={resolvedBusinessValue}
      siteThin={siteThin}
      projectId={project?.id ?? null}
      cases={cases ?? []}
      onCasesChanged={onCasesChanged}
    />
  );
}

/* ─────────────────────────── Состояния ─────────────────────────── */

function NotStarted({
  busy,
  onStartResearch,
  offerValue,
  onSaveOffer,
  styleValue,
  onStyleSaved,
  signatureValue,
  businessValue = '',
  siteThin = false,
  projectId,
  cases,
  onCasesChanged,
}: {
  busy: boolean;
  onStartResearch: () => void;
  offerValue: string;
  onSaveOffer: (v: string) => Promise<void> | void;
  styleValue: string;
  onStyleSaved?: () => void;
  signatureValue: string;
  businessValue?: string;
  siteThin?: boolean;
  projectId: string | null;
  cases: VeCaseEntry[];
  onCasesChanged?: () => void;
}) {
  return (
    <section className="max-w-5xl">
      <div className="ve2-panel p-7">
        <p className="ve2-eb">01 → Старт</p>
        <div>
          <h2 className="mt-2 text-xl font-semibold">Подготовить карту рынка</h2>
          <p className={`mt-2 max-w-2xl ${HE.lead}`}>
            Движок изучит сайт и бриф, найдёт конкурентов и соберёт 25–40 проверенных гипотез. Результат появится в виде
            сравнимых вертикалей.
          </p>
        </div>
        <div className="ve2-step-footer">
          <button type="button" onClick={onStartResearch} disabled={busy} className={HE.btnPrimary}>
            {busy ? <Spinner className="h-4 w-4" /> : <Play aria-hidden className="h-4 w-4 fill-current" />}
            Запустить исследование
          </button>
          <span className="ve2-faint">Обычно 10–20 минут. Страницу можно закрыть.</span>
        </div>
      </div>

      <ResearchContextGrid
        offerValue={offerValue}
        onSaveOffer={onSaveOffer}
        styleValue={styleValue}
        onStyleSaved={onStyleSaved}
        signatureValue={signatureValue}
        businessValue={businessValue}
        siteThin={siteThin}
        projectId={projectId}
        cases={cases}
        onCasesChanged={onCasesChanged}
      />
    </section>
  );
}

function ResearchContextGrid({
  offerValue,
  onSaveOffer,
  styleValue,
  onStyleSaved,
  signatureValue,
  businessValue,
  siteThin,
  projectId,
  cases,
  onCasesChanged,
}: {
  offerValue: string;
  onSaveOffer: (v: string) => Promise<void> | void;
  styleValue: string;
  onStyleSaved?: () => void;
  signatureValue: string;
  businessValue: string;
  siteThin: boolean;
  projectId: string | null;
  cases: VeCaseEntry[];
  onCasesChanged?: () => void;
}) {
  return (
    <section className="ve2-sec">
      <div className="ve2-sec-head">
        <div>
          <p className="ve2-eb">01 → Контекст для исследования</p>
          <p className={`mt-1 ${HE.muted}`}>Эти ответы усиливают гипотезы. Всё можно править до перезапуска.</p>
        </div>
      </div>
      <div className="ve2-context-grid">
        <OfferBlock offerValue={offerValue} onSaveOffer={onSaveOffer} />
        <ClientBriefBlock projectId={projectId} onBriefChanged={onCasesChanged} />
        <BusinessBlock projectId={projectId} businessValue={businessValue} emphasized={siteThin} />
        <SignatureBlock projectId={projectId} signatureValue={signatureValue} />
        <StyleBlock projectId={projectId} styleValue={styleValue} onSaved={onStyleSaved} />
      </div>
      <div className="mt-4">
        <CasesBlock projectId={projectId} cases={cases} onCasesChanged={onCasesChanged} />
      </div>
    </section>
  );
}

/** Оффер: необязательная формулировка, которую движок использует в письмах. */
function OfferBlock({
  offerValue,
  onSaveOffer,
}: {
  offerValue: string;
  onSaveOffer: (v: string) => Promise<void> | void;
}) {
  const taRef = useRef<HTMLTextAreaElement>(null);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  const handleSave = async () => {
    if (saving) return;
    setSaving(true);
    try {
      await onSaveOffer(taRef.current?.value ?? '');
      setSaved(true);
      setDirty(false);
      window.setTimeout(() => setSaved(false), 2000);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className={`mt-8 text-left ${HE.formPanel}`}>
      <label htmlFor="he-step1-offer" className={HE.eyebrow}>
        Оффер (необязательно)
      </label>
      <p className={`mt-1 text-xs leading-relaxed ${HE.muted}`}>
        Как именно продаём: кому, что и в какие сроки — движок использует эту формулировку в письмах
      </p>
      <textarea
        id="he-step1-offer"
        ref={taRef}
        rows={2}
        defaultValue={offerValue}
        onChange={() => {
          setDirty(true);
          setSaved(false);
        }}
        placeholder="Например: 3–5 встреч в месяц с HRD крупных работодателей, тест за 2 недели"
        className={`mt-2 resize-y ${HE.input}`}
      />
      <div className="mt-2 flex items-center gap-2">
        <button type="button" onClick={() => void handleSave()} disabled={saving || !dirty} className={HE.btnSmall}>
          {saving ? <Spinner className="h-3.5 w-3.5" /> : null}
          Сохранить
        </button>
        {saved ? <span className="text-xs text-emerald-600">Сохранено</span> : null}
      </div>
    </div>
  );
}

/** Подпись отправителя: ставится дословно в конце каждого письма. Сохраняет сам через PATCH. */
function SignatureBlock({ projectId, signatureValue }: { projectId: string | null; signatureValue: string }) {
  const taRef = useRef<HTMLTextAreaElement>(null);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState('');

  const handleSave = async () => {
    if (saving || !projectId) return;
    setSaving(true);
    setError('');
    try {
      const { ok, data } = await veEnginePatch<VeProjectResponse>(`${VE_API}/projects/${projectId}`, {
        signature_override: taRef.current?.value ?? '',
      });
      if (!ok) {
        setError(data.error || 'Не удалось сохранить подпись');
        return;
      }
      setSaved(true);
      setDirty(false);
      window.setTimeout(() => setSaved(false), 2000);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className={`mt-4 text-left ${HE.formPanel}`}>
      <label htmlFor="he-step1-signature" className={HE.eyebrow}>
        Отправитель (подпись в письмах)
      </label>
      <p className={`mt-1 text-xs leading-relaxed ${HE.muted}`}>
        Как подписываемся в письмах: имя, роль, сайт. Пример: Иван Иванов, руководитель направления, Polza,
        polzaagency.ru. Пусто: подпишемся командой компании из брифа.
      </p>
      <textarea
        id="he-step1-signature"
        ref={taRef}
        rows={2}
        defaultValue={signatureValue}
        onChange={() => {
          setDirty(true);
          setSaved(false);
        }}
        placeholder="Иван Иванов, руководитель направления, Polza, polzaagency.ru"
        className={`mt-2 resize-y ${HE.input}`}
      />
      <div className="mt-2 flex items-center gap-2">
        <button type="button" onClick={() => void handleSave()} disabled={saving || !dirty} className={HE.btnSmall}>
          {saving ? <Spinner className="h-3.5 w-3.5" /> : null}
          Сохранить
        </button>
        {saved ? <span className="text-xs text-emerald-600">Сохранено</span> : null}
      </div>
      {error ? <p className="mt-2 text-xs text-red-600">{error}</p> : null}
    </div>
  );
}

/** Ручное описание бизнеса: спасение, когда сайт слабый/на JS (site_thin). Сохраняет сам через PATCH. */
function BusinessBlock({
  projectId,
  businessValue,
  emphasized,
}: {
  projectId: string | null;
  businessValue: string;
  emphasized?: boolean;
}) {
  const taRef = useRef<HTMLTextAreaElement>(null);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState('');

  const handleSave = async () => {
    if (saving || !projectId) return;
    setSaving(true);
    setError('');
    try {
      const { ok, data } = await veEnginePatch<VeProjectResponse>(`${VE_API}/projects/${projectId}`, {
        business_override: taRef.current?.value ?? '',
      });
      if (!ok) {
        setError(data.error || 'Не удалось сохранить описание');
        return;
      }
      setSaved(true);
      setDirty(false);
      window.setTimeout(() => setSaved(false), 2000);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className={`mt-4 rounded-lg border p-4 text-left ${emphasized ? 've2-warn-soft' : 've2-soft'}`}>
      <label htmlFor="he-step1-business" className={HE.eyebrow}>
        Описание бизнеса (если сайт не раскрывает)
      </label>
      <p className={`mt-1 text-xs leading-relaxed ${HE.muted}`}>
        {emphasized
          ? 'Сайт прочитался слабо (мало текста или нужен JavaScript). Заполните описание сами и перезапустите исследование — иначе вертикали будут догадками.'
          : 'Что продаём, кому и чем сильны — своими словами. Идёт в генерацию вертикалей поверх профиля сайта; особенно важно, если сайт лаконичный или на JavaScript.'}
      </p>
      <textarea
        id="he-step1-business"
        ref={taRef}
        rows={3}
        defaultValue={businessValue}
        onChange={() => {
          setDirty(true);
          setSaved(false);
        }}
        placeholder="Например: продаём корпоративное обучение по продажам для производственных компаний, сильны программами для В2Г-сектора…"
        className={`mt-2 resize-y ${HE.input}`}
      />
      <div className="mt-2 flex items-center gap-2">
        <button type="button" onClick={() => void handleSave()} disabled={saving || !dirty} className={HE.btnSmall}>
          {saving ? <Spinner className="h-3.5 w-3.5" /> : null}
          Сохранить
        </button>
        {saved ? <span className="text-xs text-emerald-600">Сохранено</span> : null}
      </div>
      {error ? <p className="mt-2 text-xs text-red-600">{error}</p> : null}
    </div>
  );
}

/** Эталон стиля: 1–2 «идеальных» письма, чью манеру имитирует генерация. Сохраняет сам через PATCH. */
function StyleBlock({
  projectId,
  styleValue,
  onSaved,
}: {
  projectId: string | null;
  styleValue: string;
  onSaved?: () => void;
}) {
  const taRef = useRef<HTMLTextAreaElement>(null);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState('');

  const handleSave = async () => {
    if (saving || !projectId) return;
    setSaving(true);
    setError('');
    try {
      const { ok, data } = await veEnginePatch<VeProjectResponse>(`${VE_API}/projects/${projectId}`, {
        style_override: taRef.current?.value ?? '',
      });
      if (!ok) {
        setError(data.error || 'Не удалось сохранить эталон стиля');
        return;
      }
      setSaved(true);
      setDirty(false);
      window.setTimeout(() => setSaved(false), 2000);
      onSaved?.();
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className={`mt-4 text-left ${HE.formPanel}`}>
      <label htmlFor="he-step1-style" className={HE.eyebrow}>
        Эталон стиля (необязательно)
      </label>
      <p className={`mt-1 text-xs leading-relaxed ${HE.muted}`}>
        Вставьте 1–2 письма, которые считаете идеальными. Движок будет писать в этой манере — факты и имена не копирует.
      </p>
      <textarea
        id="he-step1-style"
        ref={taRef}
        rows={4}
        defaultValue={styleValue}
        onChange={() => {
          setDirty(true);
          setSaved(false);
        }}
        placeholder="Пример письма, которое нравится…"
        className={`mt-2 resize-y ${HE.input}`}
      />
      <div className="mt-2 flex items-center gap-2">
        <button type="button" onClick={() => void handleSave()} disabled={saving || !dirty} className={HE.btnSmall}>
          {saving ? <Spinner className="h-3.5 w-3.5" /> : null}
          Сохранить
        </button>
        {saved ? <span className="text-xs text-emerald-600">Сохранено</span> : null}
      </div>
      {error ? <p className="mt-2 text-xs text-red-600">{error}</p> : null}
    </div>
  );
}

type StageState = 'done' | 'current' | 'upcoming' | 'failed';

/** Текст живого счётчика стадии: «14/33 · проверяем гипотезу» (из ve_jobs.progress). */
function progressText(job: VeJobSummary | undefined): string | null {
  const p = job?.progress;
  if (!p) return null;
  const counter =
    typeof p.done === 'number' && typeof p.total === 'number' && p.total > 0 ? `${p.done}/${p.total}` : null;
  const label = p.label?.trim() ? p.label.trim() : null;
  if (!counter && !label) return null;
  return [counter, label].filter(Boolean).join(' · ');
}

/** Тон статусной точки для состояния стадии. */
const STAGE_DOT_TONE: Record<StageState, 'ok' | 'info' | 'muted' | 'err'> = {
  done: 'ok',
  current: 'info',
  upcoming: 'muted',
  failed: 'err',
};

/** Вертикальный чек-лист стадий: сделано / идёт / впереди / не удалось. У активной — живой счётчик. */
function StageChecklist({ jobs, running }: { jobs: VeJobSummary[]; running: boolean }) {
  const states: StageState[] = RESEARCH_STAGES.map(({ stage }) => {
    const job = latestJobOf(jobs, stage);
    if (!job) return 'upcoming';
    switch (job.status) {
      case 'done':
        return 'done';
      case 'failed':
        return 'failed';
      case 'running':
      case 'pending':
        return 'current';
      default:
        return 'upcoming';
    }
  });
  // Исследование идёт, но активной джобы ещё нет в выдаче (между стадиями) —
  // подсвечиваем первую несделанную как текущую.
  if (running && !states.includes('current') && !states.includes('failed')) {
    const idx = states.indexOf('upcoming');
    if (idx >= 0) states[idx] = 'current';
  }

  return (
    <ol className="space-y-2.5">
      {RESEARCH_STAGES.map(({ stage, line }, i) => {
        const state = states[i];
        const progress = state === 'current' ? progressText(latestJobOf(jobs, stage)) : null;
        return (
          <li
            key={stage}
            className={`flex items-center gap-2.5 text-sm ${
              state === 'current'
                ? 'font-semibold text-gray-900'
                : state === 'done'
                  ? 'text-gray-600'
                  : state === 'failed'
                    ? 'text-red-600'
                    : 'text-gray-500'
            }`}
          >
            <span className="flex h-4 w-4 shrink-0 items-center justify-center">
              <StatusDot
                tone={STAGE_DOT_TONE[state]}
                className={state === 'current' ? 'motion-safe:animate-pulse' : ''}
              />
            </span>
            <span>
              {line}
              {progress ? <span className="ve2-faint block">— {progress}</span> : null}
            </span>
          </li>
        );
      })}
    </ol>
  );
}

/** Ошибки стадий простым русским языком + кнопка повтора. Без id/попыток/стека. */
function FailureNote({
  failedStages,
  jobs,
  projectError,
  busy,
  onRetry,
}: {
  failedStages: Array<{ stage: VeStage; line: string; name: string }>;
  jobs: VeJobSummary[];
  projectError?: string | null;
  busy: boolean;
  onRetry: () => void;
}) {
  return (
    <div className="mt-4 space-y-2">
      {failedStages.map(({ stage, name }) => {
        const job = latestJobOf(jobs, stage);
        return (
          <StatusBox key={stage} tone="error">
            Стадия „{name}“ не удалась: {job?.error || 'неизвестная ошибка'}
          </StatusBox>
        );
      })}
      {failedStages.length === 0 && projectError ? (
        <StatusBox tone="error">Исследование не удалось: {projectError}</StatusBox>
      ) : null}
      <button type="button" onClick={onRetry} disabled={busy} className={HE.btnPrimary}>
        {busy ? <Spinner className="h-4 w-4" /> : null}
        Попробовать снова
      </button>
    </div>
  );
}
