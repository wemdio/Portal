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

import { useRef, useState, type JSX } from 'react';
import { Play, RotateCcw } from 'lucide-react';
import type { VeStage } from '@/lib/verticalEngineV2/types';
import { Badge, StatusBox } from '../ui';
import { HE, Spinner, StatusDot } from '../design';
import { ClientBriefBlock } from './ClientBriefBlock';
import {
  VE_API,
  veEngineDelete,
  veEnginePatch,
  veEnginePost,
  type VeCaseCreateResponse,
  type VeCaseDeleteResponse,
  type VeCaseEntry,
  type VeJobSummary,
  type VeProjectDetailResponse,
  type VeProjectResponse,
} from '../api';

/** line — строка в чек-листе прогресса; name — короткое имя для сообщения об ошибке. */
const RESEARCH_STAGES: Array<{ stage: VeStage; line: string; name: string }> = [
  { stage: 'site_profile', line: 'Изучаем сайт клиента', name: 'Изучение сайта' },
  { stage: 'competitors', line: 'Ищем конкурентов', name: 'Поиск конкурентов' },
  { stage: 'brand_cloud', line: 'Разбираем клиентов конкурентов', name: 'Разбор клиентов конкурентов' },
  { stage: 'hypotheses', line: 'Генерируем гипотезы рынков', name: 'Генерация гипотез' },
  { stage: 'evidence', line: 'Проверяем каждую гипотезу источниками', name: 'Проверка гипотез' },
  { stage: 'clustering', line: 'Собираем вертикали', name: 'Сборка вертикалей' },
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
  offerValue,
  onSaveOffer,
  styleValue,
  onStyleSaved,
  cases,
  onCasesChanged,
}: Step1ResearchProps): JSX.Element {
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

  if (running) {
    return (
      <section className={`max-w-3xl ${HE.card} ${HE.cardPad}`}>
        <h2 className={`mb-4 ${HE.secTitle}`}>Идёт исследование…</h2>
        <StageChecklist jobs={jobs} running />
        {failedStages.length > 0 ? (
          <FailureNote failedStages={failedStages} jobs={jobs} busy={busy} onRetry={onStartResearch} />
        ) : null}
        <p className={`mt-4 text-xs ${HE.muted}`}>
          Это займёт несколько минут, страницу можно не держать открытой.
        </p>
      </section>
    );
  }

  if (failed) {
    return (
      <section className={`max-w-3xl ${HE.card} ${HE.cardPad}`}>
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
      <section className="max-w-5xl">
        <div className={`flex items-start gap-3 px-4 py-3 ${HE.successPanel}`}>
          <StatusDot tone="ok" className="mt-1.5" />
          <div>
            <p className="text-sm font-semibold text-emerald-800">Исследование готово</p>
            <p className="mt-0.5 text-sm text-emerald-700">
              Вертикали собраны — переходим к выбору направления.
            </p>
          </div>
        </div>
        {siteThin ? (
          <div className="mt-4">
            <BusinessBlock
              projectId={project?.id ?? null}
              businessValue={resolvedBusinessValue}
              emphasized
            />
          </div>
        ) : null}
        {/* Бриф доступен и после исследования: дозаполненные поля уходят в
            цепочки и шаблон, а перезапуск подхватит их в гипотезы. */}
        <ClientBriefBlock projectId={project?.id ?? null} onBriefChanged={onCasesChanged} />
        <div className="mt-5 flex justify-start">
          <button
            type="button"
            disabled={busy}
            onClick={() => {
              if (
                window.confirm(
                  'Перезапустить исследование? Движок заново пройдёт все стадии — это займёт 10–20 минут.',
                )
              ) {
                onStartResearch();
              }
            }}
            className={`${HE.btnGhost} h-9`}
          >
            <RotateCcw aria-hidden className="h-3.5 w-3.5" />
            Перезапустить исследование
          </button>
        </div>
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
      <div className="grid gap-6 border-b border-gray-200 pb-7 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-center">
        <div>
          <h2 className="text-xl font-semibold text-gray-900">Подготовить карту рынка</h2>
          <p className={`mt-2 max-w-2xl ${HE.lead}`}>
            Движок изучит сайт и бриф, найдёт конкурентов и соберёт 25–40 проверенных гипотез.
            Результат появится в виде сравнимых вертикалей.
          </p>
          <p className="mt-3 text-xs text-gray-500">Обычно 10–20 минут. Страницу можно закрыть.</p>
        </div>
        <button type="button" onClick={onStartResearch} disabled={busy} className={HE.btnPrimary}>
          {busy ? <Spinner className="h-4 w-4" /> : <Play aria-hidden className="h-4 w-4 fill-current" />}
          Запустить исследование
        </button>
      </div>

      <div className="mt-7">
        <h3 className={HE.sectionTitle}>Контекст для исследования</h3>
        <p className={`mt-1 ${HE.muted}`}>
          Чем точнее исходные данные, тем меньше лишних гипотез придётся отсеивать после генерации.
        </p>
        <div className="grid items-start gap-x-5 lg:grid-cols-2">
          <div>
            <OfferBlock offerValue={offerValue} onSaveOffer={onSaveOffer} />
            <BusinessBlock projectId={projectId} businessValue={businessValue} emphasized={siteThin} />
            <SignatureBlock projectId={projectId} signatureValue={signatureValue} />
          </div>
          <div>
            <ClientBriefBlock projectId={projectId} onBriefChanged={onCasesChanged} />
            <StyleBlock projectId={projectId} styleValue={styleValue} onSaved={onStyleSaved} />
            <CasesBlock projectId={projectId} cases={cases} onCasesChanged={onCasesChanged} />
          </div>
        </div>
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
        <button
          type="button"
          onClick={() => void handleSave()}
          disabled={saving || !dirty}
          className={HE.btnSmall}
        >
          {saving ? <Spinner className="h-3.5 w-3.5" /> : null}
          Сохранить
        </button>
        {saved ? <span className="text-xs text-emerald-600">Сохранено</span> : null}
      </div>
    </div>
  );
}

/** Подпись отправителя: ставится дословно в конце каждого письма. Сохраняет сам через PATCH. */
function SignatureBlock({
  projectId,
  signatureValue,
}: {
  projectId: string | null;
  signatureValue: string;
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
      <label
        htmlFor="he-step1-signature"
        className={HE.eyebrow}
      >
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
        <button
          type="button"
          onClick={() => void handleSave()}
          disabled={saving || !dirty}
          className={HE.btnSmall}
        >
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
    <div
      className={`mt-4 rounded-lg border p-4 text-left ${
        emphasized ? 'border-amber-300 bg-amber-50/60' : 'border-gray-200 bg-gray-50/50'
      }`}
    >
      <label
        htmlFor="he-step1-business"
        className={HE.eyebrow}
      >
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
        <button
          type="button"
          onClick={() => void handleSave()}
          disabled={saving || !dirty}
          className={HE.btnSmall}
        >
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
        Вставьте 1–2 письма, которые считаете идеальными. Движок будет писать в этой манере — факты и имена не
        копирует.
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
        <button
          type="button"
          onClick={() => void handleSave()}
          disabled={saving || !dirty}
          className={HE.btnSmall}
        >
          {saving ? <Spinner className="h-3.5 w-3.5" /> : null}
          Сохранить
        </button>
        {saved ? <span className="text-xs text-emerald-600">Сохранено</span> : null}
      </div>
      {error ? <p className="mt-2 text-xs text-red-600">{error}</p> : null}
    </div>
  );
}

/** Банк кейсов клиента: список (сайт/файл) + ручное добавление текста из PDF/презентации. */
function CasesBlock({
  projectId,
  cases,
  onCasesChanged,
}: {
  projectId: string | null;
  cases: VeCaseEntry[];
  onCasesChanged?: () => void;
}) {
  const [text, setText] = useState('');
  const [filename, setFilename] = useState('');
  const [saving, setSaving] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [error, setError] = useState('');

  const handleAdd = async () => {
    const value = text.trim();
    if (!projectId || !value || saving) return;
    setSaving(true);
    setError('');
    try {
      const { ok, data } = await veEnginePost<VeCaseCreateResponse>(`${VE_API}/projects/${projectId}/cases`, {
        text: value,
        filename: filename.trim() || undefined,
      });
      if (!ok) {
        setError(data.error || 'Не удалось добавить кейс');
        return;
      }
      setText('');
      setFilename('');
      onCasesChanged?.();
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (id: string) => {
    if (!projectId || deletingId) return;
    if (!window.confirm('Удалить этот кейс?')) return;
    setDeletingId(id);
    setError('');
    try {
      const { ok, data } = await veEngineDelete<VeCaseDeleteResponse>(`${VE_API}/projects/${projectId}/cases`, { id });
      if (!ok) {
        setError(data.error || 'Не удалось удалить кейс');
        return;
      }
      onCasesChanged?.();
    } finally {
      setDeletingId(null);
    }
  };

  return (
    <details className={`group mt-4 text-left ${HE.formPanel}`}>
      <summary
        className={`flex cursor-pointer select-none items-center gap-2 transition hover:text-gray-600 ${HE.eyebrow}`}
      >
        Кейсы клиента ({cases.length})
      </summary>
      <p className={`mt-2 text-xs leading-relaxed ${HE.muted}`}>
        Кейсы с сайта собираются автоматически. Можно добавить вручную — текст из PDF/презентации;
        используются как доказательство в письмах.
      </p>

      {cases.length > 0 ? (
        <ul className="mt-3 space-y-2">
          {cases.map((c) => (
            <li
              key={c.id}
              className="flex items-start gap-2 rounded-lg border border-gray-200 bg-white px-3 py-2"
            >
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-1.5">
                  <Badge tone={c.source === 'site' ? 'blue' : 'violet'}>
                    {c.source === 'site' ? 'сайт' : 'файл'}
                  </Badge>
                  {c.industry ? <span className="text-xs font-medium text-gray-700">{c.industry}</span> : null}
                  {c.client_type ? <span className="text-xs text-gray-500">{c.client_type}</span> : null}
                  {c.filename ? <span className="truncate text-[11px] text-gray-500">{c.filename}</span> : null}
                </div>
                {c.result ? <p className="mt-1 line-clamp-2 text-xs text-gray-600">{c.result}</p> : null}
              </div>
              {c.source === 'upload' ? (
                <button
                  type="button"
                  onClick={() => void handleDelete(c.id)}
                  disabled={deletingId === c.id}
                  title="Удалить кейс"
                  className="shrink-0 text-[11px] font-medium text-gray-500 transition hover:text-red-600 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {deletingId === c.id ? <Spinner className="h-3.5 w-3.5" /> : 'Удалить'}
                </button>
              ) : null}
            </li>
          ))}
        </ul>
      ) : (
        <p className={`mt-3 text-xs ${HE.muted}`}>Кейсов пока нет.</p>
      )}

      <div className="mt-3">
        <textarea
          rows={3}
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Вставьте текст кейса…"
          aria-label="Текст кейса"
          className={`resize-y ${HE.input}`}
        />
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <input
            type="text"
            value={filename}
            onChange={(e) => setFilename(e.target.value)}
            placeholder="Имя файла (необязательно)"
            aria-label="Имя файла"
            className={`h-9 min-w-0 flex-1 ${HE.input}`}
          />
          <button
            type="button"
            onClick={() => void handleAdd()}
            disabled={saving || !text.trim()}
            className={HE.btnSmall}
          >
            {saving ? <Spinner className="h-3.5 w-3.5" /> : null}
            Добавить кейс
          </button>
        </div>
        {error ? <p className="mt-2 text-xs text-red-600">{error}</p> : null}
      </div>
    </details>
  );
}

type StageState = 'done' | 'current' | 'upcoming' | 'failed';

/** Текст живого счётчика стадии: «14/33 · проверяем гипотезу» (из ve_jobs.progress). */
function progressText(job: VeJobSummary | undefined): string | null {
  const p = job?.progress;
  if (!p) return null;
  const counter =
    typeof p.done === 'number' && typeof p.total === 'number' && p.total > 0
      ? `${p.done}/${p.total}`
      : null;
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
              <StatusDot tone={STAGE_DOT_TONE[state]} className={state === 'current' ? 'motion-safe:animate-pulse' : ''} />
            </span>
            <span>
              {line}
              {progress ? <span className="block text-xs font-normal text-blue-500">— {progress}</span> : null}
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
