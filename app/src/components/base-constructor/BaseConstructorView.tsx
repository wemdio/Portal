'use client';

import { useState, useEffect, useRef, useCallback, useMemo, type DragEvent } from 'react';
import { supabase } from '@/lib/supabaseClient';
import { authFetch } from '@/lib/authFetch';
import { buildDatabasesImportUrl, writePendingDbImport } from '@/lib/databases/pendingImport';
import { ClientTariffUsageInline } from '@/components/client/ClientTariffUsageInline';
import {
  ALWAYS_ON_STEPS_FOR_CLIENT,
  CLIENT_ROW_LIMIT,
} from '@/lib/tools/baseConstructorClientGuard';
import { parseCSV, readXlsxRows } from '@/lib/spreadsheet/parseCSV';
import {
  estimateProcessingMinutes,
  formatProcessingTimeBand,
} from '@/lib/tools/baseConstructorEta';
import { getMappingContentWarnings } from '@/lib/tools/columnMappingWarnings';
import {
  Eraser, CopyMinus, MailMinus, MailX, Sparkles, MailSearch, MailCheck,
  Globe, FileText, Target, PenLine, Upload, Play, X, Check,
  Download, ArrowRight, Loader2, ChevronDown, ChevronUp, RotateCcw,
  AlertTriangle, Zap, CircleDollarSign, Brain, Split, FileUp, Lock,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

const ALWAYS_ON_SET = new Set<StepKey>(ALWAYS_ON_STEPS_FOR_CLIENT as readonly StepKey[]);

/**
 * Сколько активных задач (pending + processing) у ОДНОГО юзера разрешено
 * одновременно (per-user cap). Дублирует MAX_ACTIVE_JOBS_PER_USER в
 * app/src/app/api/tools/base-constructor/route.ts — UI блокирует кнопку
 * «Запустить» при достижении лимита, бэк защищает от обхода через прямой POST.
 * Это НЕ глобальная параллельность обработки — та задаётся
 * BASE_CONSTRUCTOR_CONCURRENCY в воркере (docker-compose.prod.yml). Если меняешь
 * этот per-user лимит — поменяй и в route.ts.
 */
const MAX_ACTIVE_JOBS = 6;

function isActiveJobStatus(status: string): boolean {
  return status === 'pending' || status === 'processing';
}

/* ═══════════════════════════════════════════
   TYPES
   ═══════════════════════════════════════════ */

type StepKey =
  | 'remove_empty' | 'dedup_full' | 'dedup_email' | 'clean_names'
  | 'find_emails' | 'split_emails' | 'remove_support_emails' | 'validate_emails' | 'check_sites'
  | 'enrich_descriptions' | 'ta_scoring' | 'personalization';

type CostTier = 'free' | 'cheap' | 'api' | 'ai';

interface BenefitsFrom {
  step: StepKey;
  columns: string[];
  hint: string;
}

interface StepDef {
  key: StepKey;
  label: string;
  description: string;
  icon: LucideIcon;
  needsConfig?: 'brief' | 'prompt';
  category: 'clean' | 'enrich' | 'ai';
  cost: CostTier;
  priority: number;
  requiresColumns?: string[][];
  producesColumns?: string[];
  recommendedAfter?: StepKey[];
  benefitsFrom?: BenefitsFrom[];
  /** Steps that MUST be included when this step is selected (auto-added). */
  autoAdds?: StepKey[];
}

interface ConstructorJob {
  id: string;
  status: string;
  file_name: string | null;
  selected_steps: StepKey[];
  current_step: number;
  current_step_key: string;
  current_step_progress: number;
  total_steps: number;
  initial_row_count: number;
  result_stats?: {
    total_rows: number;
    emails_found: number;
    avg_ta_score: number;
    columns: number;
    /** ta_scoring телеметрия — заполняется только когда был шаг ta_scoring. */
    ta_scoring_pre_filter_rows?: number;
    ta_scoring_filtered_out?: number;
    ta_scoring_pre_filter_avg?: number;
  };
  error_message?: string;
  created_at: string;
  completed_at?: string;
}

/* ═══════════════════════════════════════════
   CONSTANTS
   ═══════════════════════════════════════════ */

const STEPS: StepDef[] = [
  { key: 'remove_empty', label: 'Удалить пустые', description: 'Удаляет пустые строки и столбцы', icon: Eraser, category: 'clean', cost: 'free', priority: 10 },
  { key: 'dedup_full', label: 'Убрать дубликаты', description: 'Удаляет полностью идентичные строки', icon: CopyMinus, category: 'clean', cost: 'free', priority: 20 },
  { key: 'check_sites', label: 'Проверить сайты', description: 'Удаляет строки с мертвыми сайтами', icon: Globe, category: 'enrich', cost: 'cheap', priority: 30, requiresColumns: [['сайт', 'site', 'website', 'url', 'домен', 'domain']] },
  { key: 'find_emails', label: 'Найти Email', description: 'Ищет все email по сайту компании', icon: MailSearch, category: 'enrich', cost: 'cheap', priority: 40, requiresColumns: [['сайт', 'site', 'website', 'url', 'домен', 'domain']], producesColumns: ['email'], recommendedAfter: ['check_sites'] },
  { key: 'split_emails', label: 'Разделить почты', description: 'Каждый email — отдельная строка', icon: Split, category: 'clean', cost: 'free', priority: 45, requiresColumns: [['email', 'e-mail', 'почта', 'mail']], recommendedAfter: ['find_emails'] },
  { key: 'remove_support_emails', label: 'Убрать почты поддержки', description: 'Удаляет почты поддержки (support@, help@, zakaz@…); info@/sales@ оставляет', icon: MailX, category: 'clean', cost: 'free', priority: 47, requiresColumns: [['email', 'e-mail', 'почта', 'mail']], recommendedAfter: ['split_emails'] },
  { key: 'dedup_email', label: 'Дедуп по Email', description: 'Одна строка на уникальный email', icon: MailMinus, category: 'clean', cost: 'free', priority: 50, requiresColumns: [['email', 'e-mail', 'почта', 'mail']], recommendedAfter: ['split_emails'], autoAdds: ['split_emails'] },
  { key: 'validate_emails', label: 'Валидация Email', description: 'SMTP-проверка, удаляет невалидные и одноразовые', icon: MailCheck, category: 'enrich', cost: 'api', priority: 55, requiresColumns: [['email', 'e-mail', 'почта', 'mail']], recommendedAfter: ['split_emails', 'dedup_email'], autoAdds: ['split_emails'] },
  { key: 'clean_names', label: 'Очистить названия', description: 'AI убирает мусор из названий (ООО, LLC...)', icon: Sparkles, category: 'clean', cost: 'ai', priority: 60, requiresColumns: [['компания', 'company', 'name', 'название']] },
  { key: 'enrich_descriptions', label: 'Обогатить описаниями', description: 'Парсит описание компании с сайта', icon: FileText, category: 'enrich', cost: 'cheap', priority: 65, requiresColumns: [['сайт', 'site', 'website', 'url', 'домен', 'domain']], recommendedAfter: ['check_sites'] },
  { key: 'ta_scoring', label: 'Оценка ЦА', description: 'AI оценивает релевантность по брифу, оставляет 7–10', icon: Target, needsConfig: 'brief', category: 'ai', cost: 'ai', priority: 80, recommendedAfter: ['enrich_descriptions'], autoAdds: ['enrich_descriptions'] },
  { key: 'personalization', label: 'Персонализация', description: 'AI пишет персональное предложение', icon: PenLine, needsConfig: 'prompt', category: 'ai', cost: 'ai', priority: 90, recommendedAfter: ['enrich_descriptions', 'clean_names'], autoAdds: ['enrich_descriptions'] },
];

const STEP_MAP = new Map(STEPS.map((s) => [s.key, s]));

const CATEGORIES: { key: string; label: string; color: string }[] = [
  { key: 'clean', label: 'Очистка', color: 'bg-amber-50 text-amber-700 border-amber-200' },
  { key: 'enrich', label: 'Обогащение', color: 'bg-blue-50 text-blue-700 border-blue-200' },
  { key: 'ai', label: 'AI Обработка', color: 'bg-violet-50 text-violet-700 border-violet-200' },
];

const COST_BADGES: Record<CostTier, { label: string; color: string; icon: LucideIcon }> = {
  free: { label: 'Бесплатно', color: 'bg-emerald-50 text-emerald-600 border-emerald-200', icon: Zap },
  cheap: { label: 'Дёшево', color: 'bg-sky-50 text-sky-600 border-sky-200', icon: Globe },
  api: { label: 'API', color: 'bg-amber-50 text-amber-600 border-amber-200', icon: CircleDollarSign },
  ai: { label: 'AI', color: 'bg-violet-50 text-violet-600 border-violet-200', icon: Brain },
};

/* ═══════════════════════════════════════════
   COLUMN MAPPING
   ═══════════════════════════════════════════ */

interface ColumnRole {
  key: string;
  label: string;
  canonical: string;
  aliases: string[];
  neededBy: StepKey[];
}

const COLUMN_ROLES: ColumnRole[] = [
  {
    key: 'company',
    label: 'Название компании',
    canonical: 'компания',
    aliases: ['компания', 'company', 'name', 'название', 'наименование', 'организация', 'фирма', 'компании'],
    neededBy: ['clean_names'],
  },
  {
    key: 'site',
    label: 'Сайт / домен',
    canonical: 'сайт',
    aliases: ['сайт', 'site', 'website', 'url', 'домен', 'domain', 'web', 'www', 'сайты', 'веб-сайт'],
    neededBy: ['check_sites', 'find_emails', 'enrich_descriptions'],
  },
  {
    key: 'email',
    label: 'Email',
    canonical: 'email',
    aliases: ['email', 'e-mail', 'почта', 'mail', 'электронная почта', 'емейл', 'имейл'],
    neededBy: ['split_emails', 'dedup_email', 'validate_emails'],
  },
];

const ROLE_MAP = new Map(COLUMN_ROLES.map((r) => [r.key, r]));

function autoDetectMapping(header: string[]): Record<string, string> {
  const mapping: Record<string, string> = {};
  const lower = header.map((h) => h.trim().toLowerCase());
  const used = new Set<number>();

  for (const role of COLUMN_ROLES) {
    let found = -1;
    for (const alias of role.aliases) {
      const idx = lower.indexOf(alias.toLowerCase());
      if (idx >= 0 && !used.has(idx)) { found = idx; break; }
    }
    if (found < 0) {
      for (const alias of role.aliases) {
        const idx = lower.findIndex((h, i) => !used.has(i) && h.includes(alias.toLowerCase()));
        if (idx >= 0) { found = idx; break; }
      }
    }
    if (found >= 0) {
      mapping[role.key] = header[found];
      used.add(found);
    }
  }

  return mapping;
}

function getNeededRoles(steps: StepKey[]): ColumnRole[] {
  const stepSet = new Set(steps);
  const producedCols = new Set<string>();
  for (const key of steps) {
    const def = STEP_MAP.get(key);
    if (def?.producesColumns) {
      for (const c of def.producesColumns) producedCols.add(c.toLowerCase());
    }
  }

  return COLUMN_ROLES.filter((role) => {
    const isNeeded = role.neededBy.some((s) => stepSet.has(s));
    if (!isNeeded) return false;
    const isProduced = producedCols.has(role.canonical.toLowerCase());
    const producerSelected = STEPS.some(
      (s) => s.producesColumns?.some((c) => c.toLowerCase() === role.canonical.toLowerCase()) && stepSet.has(s.key),
    );
    if (isProduced && producerSelected) return false;
    return true;
  });
}

/**
 * Topological sort respecting both priority and recommendedAfter constraints.
 * Guarantees that if step A recommends running after step B,
 * B will always come before A (when both are selected).
 */
function sortByPriority(steps: StepKey[]): StepKey[] {
  const selected = new Set(steps);
  const stepMap = new Map(STEPS.map((s) => [s.key, s]));

  const effectivePriority = new Map<StepKey, number>();
  for (const key of steps) {
    effectivePriority.set(key, stepMap.get(key)?.priority ?? 999);
  }

  let changed = true;
  while (changed) {
    changed = false;
    for (const key of steps) {
      const def = stepMap.get(key);
      if (!def?.recommendedAfter) continue;
      for (const dep of def.recommendedAfter) {
        if (!selected.has(dep)) continue;
        const depPri = effectivePriority.get(dep) ?? 0;
        const myPri = effectivePriority.get(key) ?? 999;
        if (myPri <= depPri) {
          effectivePriority.set(key, depPri + 1);
          changed = true;
        }
      }
    }
  }

  return [...steps].sort((a, b) =>
    (effectivePriority.get(a) ?? 999) - (effectivePriority.get(b) ?? 999),
  );
}

function getColumnWarnings(steps: StepKey[], header: string[], mapping: Record<string, string>): Map<StepKey, string> {
  const available = new Set(header.map((h) => h.trim().toLowerCase()));
  for (const role of COLUMN_ROLES) {
    if (mapping[role.key]) available.add(role.canonical.toLowerCase());
  }
  const warnings = new Map<StepKey, string>();
  for (const key of steps) {
    const def = STEP_MAP.get(key);
    if (def?.requiresColumns) {
      for (const colGroup of def.requiresColumns) {
        if (!colGroup.some((name) => available.has(name.toLowerCase()))) {
          warnings.set(key, `Нужна колонка «${colGroup[0]}»`);
          break;
        }
      }
    }
    if (def?.producesColumns) {
      for (const col of def.producesColumns) available.add(col.toLowerCase());
    }
  }
  return warnings;
}

function getStepHints(steps: StepKey[], header: string[]): Map<StepKey, string> {
  const lowerHeader = new Set(header.map((h) => h.trim().toLowerCase()));
  const stepSet = new Set(steps);
  const hints = new Map<StepKey, string>();

  for (const key of steps) {
    const def = STEP_MAP.get(key);
    if (!def?.benefitsFrom) continue;
    for (const bf of def.benefitsFrom) {
      const hasStep = stepSet.has(bf.step);
      const hasCol = bf.columns.some((c) => lowerHeader.has(c.toLowerCase()));
      if (!hasStep && !hasCol) {
        hints.set(key, bf.hint);
        break;
      }
    }
  }

  return hints;
}

/* ═══════════════════════════════════════════
   HELPERS
   ═══════════════════════════════════════════ */

function formatDate(iso: string) {
  return new Date(iso).toLocaleString('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}

/* ═══════════════════════════════════════════
   COMPONENT
   ═══════════════════════════════════════════ */

interface BaseConstructorViewProps {
  /**
   * When true, applies client-portal restrictions:
   *   - the "always-on" cleaning/enrichment steps are auto-selected and locked
   *     (the user can see them but can't deselect)
   *   - file uploads above CLIENT_ROW_LIMIT rows are rejected on the client
   *     (server enforces the same limit via applyClientGuard)
   *   - the "Открыть в базах" action is hidden (internal /tools/databases)
   *   - the "Обогатить описаниями" step gets an extra hint about dirty output
   *
   * The server-side guard in /api/tools/base-constructor will also enforce
   * these rules for any user with role === 'client', regardless of this flag.
   */
  clientMode?: boolean;
}

export function BaseConstructorView({ clientMode = false }: BaseConstructorViewProps = {}) {
  const [fileData, setFileData] = useState<string[][] | null>(null);
  const [fileName, setFileName] = useState('');
  const [parsing, setParsing] = useState(false);
  const [parseError, setParseError] = useState('');

  const [selectedSteps, setSelectedSteps] = useState<StepKey[]>([]);
  // clientMode only: when ON, the client picks steps manually — the always-on
  // steps stop being force-added/locked (parity with specialists). Default OFF
  // keeps the legacy locked pipeline. Server honors this via `free_steps`.
  const [freeStepMode, setFreeStepMode] = useState(false);
  const [brief, setBrief] = useState('');
  const [keepAllScored, setKeepAllScored] = useState(false);
  const [briefInputMode, setBriefInputMode] = useState<'pdf' | 'text' | 'saved'>(
    clientMode ? 'saved' : 'pdf',
  );
  const [briefFileName, setBriefFileName] = useState('');
  const [briefUploading, setBriefUploading] = useState(false);
  const [savedBriefLoading, setSavedBriefLoading] = useState(false);
  const [savedBriefAvailable, setSavedBriefAvailable] = useState<boolean | null>(null);
  const [savedBriefError, setSavedBriefError] = useState('');
  const [savedBriefText, setSavedBriefText] = useState('');
  const [prompt, setPrompt] = useState('');
  const [columnMapping, setColumnMapping] = useState<Record<string, string>>({});
  // Email-pipeline target options. Дефолты выставлены так, чтобы при наличии
  // в файле существующей email-колонки поведение было «безопасным»:
  //   - find_emails не перетирает исходные email, пишет в отдельную колонку;
  //   - validate валидирует исходные (т.к. они «свои», легко проверить).
  // Юзер может переключить через UI в секции «Настройки».
  const [findEmailsTarget, setFindEmailsTarget] = useState<'same' | 'separate'>('separate');
  const [validateTarget, setValidateTarget] = useState<'original' | 'found' | 'both'>('original');
  const [showPreview, setShowPreview] = useState(true);
  const briefFileRef = useRef<HTMLInputElement | null>(null);

  const [submitting, setSubmitting] = useState(false);
  // Секунды, прошедшие с момента нажатия «Запустить». Используется ТОЛЬКО
  // во время `submitting=true` для дружелюбного hint'а под кнопкой («идёт
  // загрузка большого файла, обычно до минуты»). Без этого юзер на больших
  // базах (несколько мегабайт jsonb-payload в POST'е) видит крутящееся «Запуск...»
  // и думает что зависло — жалоба клиента polza@polza.ru от 26 мая.
  const [submittingElapsedSec, setSubmittingElapsedSec] = useState(0);
  const [error, setError] = useState('');

  const [activeJob, setActiveJob] = useState<ConstructorJob | null>(null);
  // Full result blob, cached lazily for the admin "Открыть в базах" flow. Keyed by
  // job id so a job switch during an in-flight fetch can't hand back another job's rows.
  const fullDataCacheRef = useRef<{ id: string; rows: string[][] } | null>(null);
  const [previewData, setPreviewData] = useState<string[][] | null>(null);
  const [downloading, setDownloading] = useState(false);
  const [loadingFull, setLoadingFull] = useState(false);
  const [history, setHistory] = useState<ConstructorJob[]>([]);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [isDragOver, setIsDragOver] = useState(false);

  /* ─── Load history ─── */

  const loadHistory = useCallback(async () => {
    const res = await authFetch('/api/tools/base-constructor');
    if (!res.ok) return null;
    const { jobs } = await res.json();
    setHistory(jobs || []);
    return (jobs ?? []) as ConstructorJob[];
  }, []);

  // Initial mount: подтянуть историю и, если есть незавершённая задача,
  // открыть её на экране прогресса (юзер вернулся на страницу пока
  // что-то ещё считается). Этот авто-jump только при первом монтировании —
  // после этого юзер свободно ходит между формой и job'ами через кнопку
  // «Поставить ещё базу» и клики по истории.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const jobs = await loadHistory();
      if (cancelled || !jobs) return;
      const running = jobs.find((j) => isActiveJobStatus(j.status));
      if (running) setActiveJob(running);
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Пока в истории есть хоть одна активная задача (pending/processing) —
  // поллим историю раз в 5 сек, чтобы статусы в списке (и счётчик активных
  // для лимита) были живые, даже когда юзер не открыт ни на одной из них.
  const anyJobActive = history.some((j) => isActiveJobStatus(j.status));
  useEffect(() => {
    if (!anyJobActive) return;
    const id = setInterval(() => { void loadHistory(); }, 5000);
    return () => clearInterval(id);
  }, [anyJobActive, loadHistory]);

  /* ─── Client mode: auto-include always-on steps when a file is uploaded ─── */

  useEffect(() => {
    // Skip in manual mode — the client controls the selection themselves.
    if (!clientMode || !fileData || freeStepMode) return;
    setSelectedSteps((prev) => {
      const set = new Set<StepKey>(prev);
      for (const key of ALWAYS_ON_STEPS_FOR_CLIENT) set.add(key as StepKey);
      return sortByPriority([...set]);
    });
  }, [clientMode, fileData, freeStepMode]);

  /* ─── Client mode: auto-fetch saved brief on mount (used when user picks 'saved' tab) ─── */

  useEffect(() => {
    if (!clientMode) return;
    let cancelled = false;
    void (async () => {
      setSavedBriefLoading(true);
      setSavedBriefError('');
      try {
        const res = await authFetch('/api/client/brief');
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = (await res.json()) as { compiled_brief_text?: string };
        if (cancelled) return;
        const text = (data.compiled_brief_text ?? '').trim();
        setSavedBriefText(text);
        setSavedBriefAvailable(text.length > 0);
        if (text && briefInputMode === 'saved') setBrief(text);
      } catch (err) {
        if (!cancelled) {
          setSavedBriefAvailable(false);
          setSavedBriefError(err instanceof Error ? err.message : 'Не удалось загрузить сохранённый бриф');
        }
      } finally {
        if (!cancelled) setSavedBriefLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
    // briefInputMode intentionally excluded — we only fetch once per mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clientMode]);

  // Sync `brief` to the cached saved text every time user switches into 'saved' mode.
  useEffect(() => {
    if (briefInputMode === 'saved' && savedBriefText) {
      setBrief(savedBriefText);
    }
  }, [briefInputMode, savedBriefText]);

  /* ─── Polling ─── */

  useEffect(() => {
    if (!activeJob || ['completed', 'failed', 'cancelled'].includes(activeJob.status)) {
      if (pollRef.current) clearInterval(pollRef.current);
      return;
    }

    async function poll() {
      if (!activeJob) return;
      // Запоминаем id на момент старта запроса. Пока ответ едет (≈0.5s),
      // юзер мог нажать «Поставить ещё базу» (activeJob → null) или
      // кликнуть другой job в истории (activeJob → другой id). Если так —
      // ответ от устаревшего poll'a нельзя коммитить, иначе экран мигнёт
      // в форму и тут же откатится обратно на прогресс старой базы
      // (баг 2026-06-18: «на 5 раз получается загрузить исходный файл»).
      const jobIdAtStart = activeJob.id;
      const res = await authFetch(`/api/tools/base-constructor/${jobIdAtStart}`);
      if (!res.ok) return;
      const { job } = await res.json();
      // Stale-guard: коммитим свежие данные ТОЛЬКО если юзер всё ещё на
      // той же задаче. Функциональный setState видит current на момент
      // выполнения, а не на момент старта poll'a.
      let committed = false;
      setActiveJob((current) => {
        if (!current || current.id !== jobIdAtStart) return current;
        committed = true;
        return job;
      });
      if (!committed) return;

      if (['completed', 'failed', 'cancelled'].includes(job.status)) {
        if (pollRef.current) clearInterval(pollRef.current);
        loadHistory();
        if (job.status === 'completed') loadJobPreview(job.id);
      }
    }

    pollRef.current = setInterval(poll, 3000);
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, [activeJob, loadHistory]);

  /* ─── Submitting elapsed timer ──────────────────────────────────────
   *
   * Пока submitting=true (юзер нажал «Запустить» и ждёт ответа POST'а),
   * тикаем секундомер раз в секунду. Используется UI-кнопкой для показа
   * дружелюбного hint'а («загружаем большой файл, обычно до минуты»).
   *
   * Сбрасывается в 0 как только submitting=false.
   */
  useEffect(() => {
    if (!submitting) {
      setSubmittingElapsedSec(0);
      return;
    }
    const startedAt = Date.now();
    const id = setInterval(() => {
      setSubmittingElapsedSec(Math.floor((Date.now() - startedAt) / 1000));
    }, 1000);
    return () => clearInterval(id);
  }, [submitting]);

  /* ─── Polling fallback while submitting ─────────────────────────────
   *
   * Сценарий клиента polza@polza.ru: загрузил 4297 строк CSV (6.5 МБ jsonb
   * payload в POST'е), фронт повис на «Запуск...» больше минуты — backend
   * принимал большой body и не успевал ответить ДО того как worker уже
   * создал job в БД и начал его обрабатывать. Юзер видит «Запуск...»,
   * думает что зависло, паникует.
   *
   * Защита: после 25 секунд ожидания начинаем фоном поллить активный
   * job через GET /api/tools/base-constructor (loadHistory). Если в БД
   * уже появилась running/pending запись этого юзера (POST успел дойти,
   * просто ответ ещё едет) — переключаем UI в processing view, не дожидаясь
   * ответа POST'а. POST потом ответит, но мы уже в правильном состоянии.
   */
  useEffect(() => {
    if (!submitting || submittingElapsedSec < 25) return;
    let cancelled = false;
    const checkActiveJob = async () => {
      try {
        const res = await authFetch('/api/tools/base-constructor');
        if (!res.ok || cancelled) return;
        const { jobs } = (await res.json()) as { jobs?: ConstructorJob[] };
        const running = (jobs ?? []).find((j) =>
          ['pending', 'processing'].includes(j.status),
        );
        if (running && !cancelled) {
          setActiveJob(running);
          setSubmitting(false);
        }
      } catch {
        // Игнорируем — следующий тик попробует ещё раз.
      }
    };
    void checkActiveJob();
    const id = setInterval(() => { void checkActiveJob(); }, 5000);
    return () => { cancelled = true; clearInterval(id); };
  }, [submitting, submittingElapsedSec]);

  /* ─── Load job result data ─── */

  // Preview = first ~20 rows only. The result blob can be tens of MB, so we never
  // pull the whole thing just to render the preview table or enable download.
  async function loadJobPreview(jobId: string) {
    fullDataCacheRef.current = null;
    setPreviewData(null);
    const res = await authFetch(`/api/tools/base-constructor/${jobId}/data?preview=21`);
    if (!res.ok) return;
    const { data } = await res.json();
    setPreviewData(data || null);
  }

  // Full result, fetched lazily — only the admin "Открыть в базах" flow needs all rows.
  async function ensureFullData(jobId: string): Promise<string[][] | null> {
    // Cache is keyed by job id — never return another job's rows if the user
    // switched jobs while a previous full fetch was still in flight.
    const cached = fullDataCacheRef.current;
    if (cached && cached.id === jobId) return cached.rows;
    const res = await authFetch(`/api/tools/base-constructor/${jobId}/data`);
    if (!res.ok) return null;
    const { data } = await res.json();
    const rows = (data as string[][]) || null;
    if (rows) fullDataCacheRef.current = { id: jobId, rows };
    return rows;
  }

  /* ─── File handling ─── */

  async function handleFile(file: File) {
    setParsing(true);
    setParseError('');
    setFileName(file.name);

    try {
      const ext = file.name.split('.').pop()?.toLowerCase();

      if (ext === 'csv' || ext === 'tsv' || ext === 'txt') {
        const text = await file.text();
        const rows = parseCSV(text);
        if (rows.length < 2) { setParseError('Файл пустой или содержит только заголовок'); return; }
        if (clientMode && rows.length - 1 > CLIENT_ROW_LIMIT) {
          setParseError(`Лимит ${CLIENT_ROW_LIMIT.toLocaleString('ru-RU')} строк для клиентского доступа. В файле ${(rows.length - 1).toLocaleString('ru-RU')} строк.`);
          return;
        }
        setFileData(rows);
        setColumnMapping(autoDetectMapping(rows[0]));
      } else if (ext === 'xlsx' || ext === 'xls') {
        const buffer = await file.arrayBuffer();
        const rows = await readXlsxRows(buffer);
        if (rows.length < 2) { setParseError('Файл пустой или содержит только заголовок'); return; }
        if (clientMode && rows.length - 1 > CLIENT_ROW_LIMIT) {
          setParseError(`Лимит ${CLIENT_ROW_LIMIT.toLocaleString('ru-RU')} строк для клиентского доступа. В файле ${(rows.length - 1).toLocaleString('ru-RU')} строк.`);
          return;
        }
        setFileData(rows);
        setColumnMapping(autoDetectMapping(rows[0]));
      } else {
        setParseError('Поддерживаются форматы: CSV, TSV, XLSX, XLS');
      }
    } catch (err) {
      setParseError(err instanceof Error ? err.message : 'Ошибка при чтении файла');
    } finally {
      setParsing(false);
    }
  }

  function handleDragOver(e: DragEvent) { e.preventDefault(); setIsDragOver(true); }
  function handleDragLeave() { setIsDragOver(false); }
  function handleDrop(e: DragEvent) {
    e.preventDefault();
    setIsDragOver(false);
    const file = e.dataTransfer.files[0];
    if (file) void handleFile(file);
  }

  /* ─── Step toggling (auto-sorted by optimal order) ─── */

  function getStepsThatRequire(dep: StepKey, selected: StepKey[]): StepKey[] {
    return selected.filter((k) => STEP_MAP.get(k)?.autoAdds?.includes(dep));
  }

  function toggleStep(key: StepKey) {
    if (clientMode && !freeStepMode && ALWAYS_ON_SET.has(key)) return;
    setSelectedSteps((prev) => {
      if (prev.includes(key)) {
        const dependents = getStepsThatRequire(key, prev);
        if (dependents.length > 0) return prev;
        return sortByPriority(prev.filter((k) => k !== key));
      }
      const next = new Set([...prev, key]);
      const def = STEP_MAP.get(key);
      if (def?.autoAdds) {
        for (const dep of def.autoAdds) next.add(dep);
      }
      return sortByPriority([...next]);
    });
  }

  function isRequiredByOther(key: StepKey): string | null {
    const dependents = getStepsThatRequire(key, selectedSteps);
    if (dependents.length === 0) return null;
    const labels = dependents.map((k) => STEP_MAP.get(k)?.label ?? k).join(', ');
    return `Нужен для: ${labels}`;
  }

  function selectPreset(preset: 'clean' | 'full') {
    if (preset === 'clean') {
      setSelectedSteps(sortByPriority(['remove_empty', 'dedup_full', 'clean_names']));
    } else {
      setSelectedSteps(sortByPriority([
        'remove_empty', 'dedup_full', 'check_sites', 'find_emails',
        'split_emails', 'dedup_email', 'clean_names', 'enrich_descriptions',
      ]));
    }
  }

  const columnWarnings = fileData ? getColumnWarnings(selectedSteps, fileData[0] || [], columnMapping) : new Map();
  const stepHints = fileData ? getStepHints(selectedSteps, fileData[0] || []) : new Map();
  // Предупреждения по СОДЕРЖИМОМУ сопоставленных колонок (сайт=email/hh-ссылки,
  // компания=сайт и т.п.) — ловим неправильный маппинг ДО долгого прогона.
  // Семплируем по первым строкам внутри функции, поэтому memo по fileData+mapping.
  const mappingContentWarnings = useMemo(
    () =>
      fileData && fileData.length > 1
        ? getMappingContentWarnings(fileData[0] || [], fileData.slice(1), columnMapping)
        : [],
    [fileData, columnMapping],
  );
  const contentWarnByRole = new Map(mappingContentWarnings.map((w) => [w.role as string, w]));

  /* ─── Brief PDF upload ─── */

  const BRIEF_BUCKET = process.env.NEXT_PUBLIC_BRIEF_STORAGE_BUCKET ?? 'briefs';
  const MAX_BRIEF_FILE = 20 * 1024 * 1024;

  /**
   * Supabase Storage отбивает ключи с кириллицей/пробелами/скобками
   * с ошибкой "Invalid key". Поэтому в путь идёт только санитизированное
   * имя — оригинальное `file.name` сохраняем отдельно для UI и для
   * fileName-параметра в parse-pdf API.
   */
  function safeStorageName(name: string): string {
    const cleaned = name.replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 200);
    return cleaned || 'brief.pdf';
  }

  async function handleBriefPdfUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    e.target.value = '';
    setBriefUploading(true);

    if (!file.name.toLowerCase().endsWith('.pdf')) {
      setError('Бриф должен быть в формате PDF');
      setBriefUploading(false);
      return;
    }
    if (file.size > MAX_BRIEF_FILE) {
      setError('Файл брифа слишком большой (макс. 20MB)');
      setBriefUploading(false);
      return;
    }

    try {
      const uploadPath = `brief-scoring/${Date.now()}_${safeStorageName(file.name)}`;
      const { error: upErr } = await supabase.storage.from(BRIEF_BUCKET).upload(uploadPath, file);
      if (upErr) throw upErr;

      const res = await authFetch('/api/brief-scoring/parse-pdf', {
        method: 'POST',
        body: JSON.stringify({ bucket: BRIEF_BUCKET, path: uploadPath, fileName: file.name }),
      });
      if (!res.ok) throw new Error(`Ошибка обработки PDF (${res.status})`);
      const data = await res.json();
      setBrief(data.text ?? '');
      setBriefFileName(file.name);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Ошибка загрузки PDF');
    } finally {
      setBriefUploading(false);
    }
  }

  /* ─── Submit ─── */

  async function handleSubmit() {
    if (!fileData || selectedSteps.length === 0) return;
    setSubmitting(true);
    setError('');
    try {
      // step_config принимает в БД произвольный jsonb — кладём смешанные типы.
      const stepConfig: Record<string, unknown> = {};
      if (selectedSteps.includes('ta_scoring') && brief.trim()) stepConfig.brief = brief.trim();
      if (selectedSteps.includes('ta_scoring') && keepAllScored) stepConfig.keepAllScored = true;
      if (selectedSteps.includes('personalization') && prompt.trim()) stepConfig.prompt = prompt.trim();
      if (Object.keys(columnMapping).length > 0) stepConfig.column_mapping = JSON.stringify(columnMapping);
      // Передаём настройки email-пайплайна ТОЛЬКО когда они релевантны
      // (соответствующий шаг выбран). Иначе worker применит свои дефолты.
      if (selectedSteps.includes('find_emails')) {
        stepConfig.find_emails_target = findEmailsTarget;
      }
      if (selectedSteps.includes('validate_emails')) {
        stepConfig.validate_target = validateTarget;
      }

      const res = await authFetch('/api/tools/base-constructor', {
        method: 'POST',
        body: JSON.stringify({
          data: fileData,
          selected_steps: selectedSteps,
          step_config: stepConfig,
          file_name: fileName,
          free_steps: clientMode && freeStepMode,
        }),
      });
      const json = await res.json();
      if (!res.ok) { setError(json.error || 'Ошибка'); return; }
      setActiveJob(json.job);
      // Сразу подтянуть свежую историю — чтобы счётчик активных задач
      // (для блокировки кнопки при 5+) и список «В очереди / В работе»
      // учитывали только что созданную запись, а не ждали ближайший
      // тик 5-секундного поллинга.
      void loadHistory();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Ошибка сети');
    } finally {
      setSubmitting(false);
    }
  }

  /* ─── Cancel ─── */

  async function handleCancel() {
    if (!activeJob) return;
    await authFetch(`/api/tools/base-constructor/${activeJob.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ action: 'cancel' }),
    });
    setActiveJob((j) => j ? { ...j, status: 'cancelled' } : null);
  }

  /* ─── Download CSV ─── */

  async function downloadCSV() {
    if (!activeJob || activeJob.status !== 'completed' || downloading) return;
    setDownloading(true);
    try {
      // CSV is built server-side and streamed as a file \u2014 the browser no longer
      // fetches/parses the full (up to tens of MB) result blob just to download.
      const res = await authFetch(`/api/tools/base-constructor/${activeJob.id}/download`);
      if (!res.ok) { setError('\u041D\u0435 \u0443\u0434\u0430\u043B\u043E\u0441\u044C \u0441\u043A\u0430\u0447\u0430\u0442\u044C \u0444\u0430\u0439\u043B'); return; }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `constructor_${new Date().toISOString().slice(0, 10)}.csv`;
      a.click();
      URL.revokeObjectURL(url);
    } catch {
      setError('\u041D\u0435 \u0443\u0434\u0430\u043B\u043E\u0441\u044C \u0441\u043A\u0430\u0447\u0430\u0442\u044C \u0444\u0430\u0439\u043B');
    } finally {
      setDownloading(false);
    }
  }

  /* ─── Load to spreadsheet ─── */

  function loadToSpreadsheet(rows: string[][]) {
    try {
      const { id } = writePendingDbImport({
        title: `Конструктор ${new Date().toLocaleDateString('ru-RU')}`,
        rows,
      });
      window.open(buildDatabasesImportUrl(id), '_blank');
    } catch (err) {
      console.error('Failed to load to spreadsheet:', err);
      if (activeJob?.id) {
        window.open(`/tools/databases?constructorJobId=${activeJob.id}`, '_blank');
      } else {
        setError('Данные слишком большие для передачи через браузер. Скачайте CSV и загрузите вручную в "Базы".');
      }
    }
  }

  // Admin-only: fetches the full result on demand (it isn't loaded for preview),
  // then hands it to the spreadsheet importer.
  async function handleOpenInDatabases() {
    if (!activeJob || activeJob.status !== 'completed' || loadingFull) return;
    setLoadingFull(true);
    try {
      const rows = await ensureFullData(activeJob.id);
      if (!rows) { setError('Не удалось загрузить данные'); return; }
      loadToSpreadsheet(rows);
    } finally {
      setLoadingFull(false);
    }
  }

  /* ─── Reset ─── */

  function resetForm() {
    setActiveJob(null);
    fullDataCacheRef.current = null;
    setPreviewData(null);
    setFileData(null);
    setFileName('');
    setSelectedSteps([]);
    setFreeStepMode(false);
    setBrief('');
    setPrompt('');
    setError('');
  }

  /* ═══════════════════════════════════════════
     RENDER
     ═══════════════════════════════════════════ */

  const isRunning = activeJob && ['pending', 'processing'].includes(activeJob.status);
  const isComplete = activeJob?.status === 'completed';
  const isFailed = activeJob?.status === 'failed';

  // Сколько у юзера активных задач (pending + processing) в очереди.
  // Используется для блокировки сабмита при лимите MAX_ACTIVE_JOBS.
  // history обновляется и при первичной загрузке, и сразу после успешного
  // submit (см. handleSubmit), и в фоне раз в 5 сек пока что-то крутится —
  // значит число живое.
  const activeJobsCount = history.filter((j) => isActiveJobStatus(j.status)).length;
  const atActiveLimit = activeJobsCount >= MAX_ACTIVE_JOBS;

  const overallProgress = activeJob && activeJob.total_steps > 0
    ? Math.round(((activeJob.current_step - 1 + activeJob.current_step_progress / 100) / activeJob.total_steps) * 100)
    : 0;

  const needsBrief = selectedSteps.includes('ta_scoring');
  const needsPrompt = selectedSteps.includes('personalization');
  const neededRoles = fileData ? getNeededRoles(selectedSteps) : [];
  const unmappedRoles = neededRoles.filter((r) => !columnMapping[r.key]);
  // Есть ли в файле колонка с email — определяется по column_mapping
  // (туда autoDetectMapping положил при загрузке, либо юзер ткнул вручную).
  const hasExistingEmailCol = !!columnMapping.email;
  // Показывать ли radio «куда писать найденные» — только когда есть смысл
  // (выбран find_emails И в файле уже есть email-колонка → выбор между
  // «дополнить ту же» и «отдельная»; иначе нечего «отделять»).
  const showFindEmailsTargetOption =
    selectedSteps.includes('find_emails') && hasExistingEmailCol;
  // Показывать ли radio «что валидировать» — только когда в результате
  // будет 2 колонки (find_emails выбран в режиме separate ИЛИ юзер уже
  // зафиксировал отдельную через previous run — для текущего сабмита считаем
  // что 2 колонки только если find_emails+separate).
  const showValidateTargetOption =
    selectedSteps.includes('validate_emails') &&
    showFindEmailsTargetOption &&
    findEmailsTarget === 'separate';
  // Auto-correct: если опции скрыты, держим в state дефолт. Без этого юзер
  // мог переключить showFindEmailsTargetOption на false (выключив find_emails)
  // и валидация бы продолжала использовать прошлое значение target='found'.
  useEffect(() => {
    if (!showFindEmailsTargetOption && findEmailsTarget !== 'separate') {
      setFindEmailsTarget('separate');
    }
  }, [showFindEmailsTargetOption, findEmailsTarget]);
  useEffect(() => {
    if (!showValidateTargetOption && validateTarget !== 'original') {
      setValidateTarget('original');
    }
  }, [showValidateTargetOption, validateTarget]);

  const canSubmit = fileData && selectedSteps.length > 0 && !submitting
    && unmappedRoles.length === 0
    && (!needsBrief || brief.trim())
    && (!needsPrompt || prompt.trim())
    && !atActiveLimit;

  return (
    // clientMode: страница /client/base-constructor сама даёт фон (.client-portal),
    // ширину (max-w-5xl) и заголовок — свой светлый фон/отступы не дублируем,
    // иначе контент съезжает относительно шапки. Admin (/tools) — как было.
    <div className={clientMode ? '' : 'min-h-screen bg-gray-50/60 px-4 py-6 sm:px-6 lg:px-8'}>
      <div className={clientMode ? 'space-y-6' : 'max-w-[1000px] mx-auto space-y-6'}>
        {/* Header — admin-only. /client/base-constructor wraps this view
            with its own client-friendly h1 «Подготовить базу к запуску»;
            rendering both produced the duplicate-titles anti-pattern the
            user flagged on the 2026-05-26 screenshot. Admin /tools/our-bases
            keeps the «Конструктор баз» header because it has no wrapper. */}
        {!clientMode && (
          <div>
            <h1 className="text-3xl font-bold tracking-tight text-gray-900">Конструктор баз</h1>
            <p className="mt-1 text-sm text-gray-500">
              Загрузите базу, выберите шаги обработки — всё выполнится автоматически
            </p>
          </div>
        )}

        {/* ═══════════ UPLOAD + CONSTRUCTOR ═══════════ */}
        {!isRunning && !isComplete && !isFailed && (
          <>
            {/* File Upload */}
            <div className={clientMode ? 'neu-card overflow-hidden' : 'bg-white rounded-2xl border border-gray-200 shadow-sm overflow-hidden'}>
              <div className={clientMode ? 'px-6 py-4 border-b border-[var(--cp-divider)]' : 'px-6 py-4 border-b border-gray-100 bg-gray-50/50'}>
                <h2 className={clientMode ? 'text-base font-semibold m-0 text-[var(--cp-paper)]' : 'text-base font-bold text-gray-900'}>1. Загрузите базу</h2>
              </div>
              <div className="px-6 py-5">
                {!fileData ? (
                  <label
                    onDragOver={handleDragOver}
                    onDragLeave={handleDragLeave}
                    onDrop={handleDrop}
                    className={`flex flex-col items-center justify-center w-full py-10 border-2 border-dashed rounded-xl cursor-pointer transition ${
                      clientMode
                        ? isDragOver
                          ? 'border-[var(--cp-paper)] bg-[var(--cp-surface-elev)] scale-[1.01]'
                          : parsing
                            ? 'border-[var(--cp-divider-strong)] bg-[var(--cp-surface-elev)]'
                            : 'border-[var(--cp-divider-strong)] bg-[var(--cp-surface-rest)] hover:bg-[var(--cp-surface-elev)]'
                        : isDragOver
                          ? 'border-blue-400 bg-blue-50/60 scale-[1.01]'
                          : parsing
                            ? 'border-blue-300 bg-blue-50/50'
                            : 'border-gray-200 bg-gray-50 hover:bg-gray-100 hover:border-gray-300'
                    }`}
                  >
                    {parsing ? (
                      <div className="text-center">
                        <Loader2 className={`w-8 h-8 animate-spin mx-auto mb-3 ${clientMode ? 'text-[var(--cp-paper-mute)]' : 'text-blue-500'}`} />
                        <p className={`text-sm font-medium ${clientMode ? 'text-[var(--cp-paper-mute)]' : 'text-blue-600'}`}>Разбор файла...</p>
                      </div>
                    ) : (
                      <div className="text-center">
                        <Upload className={`w-8 h-8 mx-auto mb-3 ${clientMode ? 'text-[var(--cp-paper-faint)]' : 'text-gray-400'}`} />
                        <p className={`text-sm font-medium ${clientMode ? 'text-[var(--cp-paper-mute)]' : 'text-gray-600'}`}>Перетащите файл или нажмите для выбора</p>
                        <p className={`text-xs mt-1 ${clientMode ? 'text-[var(--cp-paper-faint)]' : 'text-gray-400'}`}>CSV, TSV, XLSX, XLS</p>
                      </div>
                    )}
                    <input
                      ref={fileInputRef}
                      type="file"
                      accept=".csv,.tsv,.txt,.xlsx,.xls"
                      className="hidden"
                      onChange={(e) => {
                        const file = e.target.files?.[0];
                        if (file) void handleFile(file);
                        e.target.value = '';
                      }}
                    />
                  </label>
                ) : (
                  <div className="space-y-3">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-3">
                        <div className={`w-10 h-10 rounded-xl flex items-center justify-center ${clientMode ? 'bg-[var(--cp-surface-active)]' : 'bg-emerald-50'}`}>
                          <Check className={`w-5 h-5 ${clientMode ? 'text-[var(--cp-green)]' : 'text-emerald-600'}`} />
                        </div>
                        <div>
                          <p className={`text-sm font-medium ${clientMode ? 'text-[var(--cp-paper)]' : 'text-gray-900'}`}>{fileName}</p>
                          <p className="text-xs text-gray-500">
                            {fileData.length - 1} строк, {fileData[0]?.length || 0} колонок
                            {clientMode ? (
                              <>
                                {' '}
                                (<ClientTariffUsageInline metric="max_rows" remainingOnly refreshKey={fileData.length} />)
                              </>
                            ) : null}
                          </p>
                        </div>
                      </div>
                      <button
                        onClick={() => { setFileData(null); setFileName(''); setColumnMapping({}); }}
                        className="p-2 rounded-lg hover:bg-gray-100 transition text-gray-400 hover:text-gray-600"
                      >
                        <X className="w-4 h-4" />
                      </button>
                    </div>

                    {/* Preview toggle */}
                    <button
                      onClick={() => setShowPreview(!showPreview)}
                      className="flex items-center gap-1.5 text-xs font-medium text-gray-500 hover:text-gray-700 transition"
                    >
                      {showPreview ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
                      Предпросмотр
                    </button>

                    {showPreview && (
                      <div className="overflow-x-auto rounded-lg border border-gray-100">
                        <table className="min-w-full divide-y divide-gray-100 text-xs">
                          <thead className="bg-gray-50/80">
                            <tr>
                              {fileData[0]?.map((h, i) => (
                                <th key={i} className="px-3 py-2 text-left font-semibold text-gray-500 whitespace-nowrap">
                                  {h || `Col ${i + 1}`}
                                </th>
                              ))}
                            </tr>
                          </thead>
                          <tbody className="divide-y divide-gray-50">
                            {fileData.slice(1, 6).map((row, rIdx) => (
                              <tr key={rIdx} className="hover:bg-gray-50/50">
                                {row.map((cell, cIdx) => (
                                  <td key={cIdx} className="px-3 py-1.5 text-gray-600 max-w-[160px] truncate" title={cell}>
                                    {cell}
                                  </td>
                                ))}
                              </tr>
                            ))}
                          </tbody>
                        </table>
                        {fileData.length > 6 && (
                          <div className="px-3 py-1.5 text-xs text-gray-400 bg-gray-50/50 text-center">
                            ... ещё {fileData.length - 6} строк
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                )}

                {parseError && <p className="mt-3 text-sm text-red-600">{parseError}</p>}
              </div>
            </div>

            {/* Step Constructor */}
            {fileData && (
              <div className={clientMode ? 'neu-card overflow-hidden' : 'bg-white rounded-2xl border border-gray-200 shadow-sm overflow-hidden'}>
                <div className={clientMode ? 'px-6 py-4 border-b border-[var(--cp-divider)] flex items-center justify-between' : 'px-6 py-4 border-b border-gray-100 bg-gray-50/50 flex items-center justify-between'}>
                  <h2 className={clientMode ? 'text-base font-semibold m-0 text-[var(--cp-paper)]' : 'text-base font-bold text-gray-900'}>2. Выберите шаги обработки</h2>
                  {!clientMode && (
                    <div className="flex gap-2">
                      <button
                        onClick={() => selectPreset('clean')}
                        className="px-3 py-1 text-xs font-medium rounded-lg bg-amber-50 text-amber-700 hover:bg-amber-100 transition border border-amber-200"
                      >
                        Быстрая очистка
                      </button>
                      <button
                        onClick={() => selectPreset('full')}
                        className="px-3 py-1 text-xs font-medium rounded-lg bg-blue-50 text-blue-700 hover:bg-blue-100 transition border border-blue-200"
                      >
                        Полная обработка
                      </button>
                    </div>
                  )}
                  {clientMode && (
                    <button
                      type="button"
                      role="switch"
                      aria-checked={freeStepMode}
                      onClick={() => {
                        setFreeStepMode((v) => !v);
                        // Clear on BOTH transitions so each mode starts pristine:
                        //  - entering manual → empty, client builds their own (e.g. one step);
                        //  - leaving manual  → empty, then the auto-include effect re-adds
                        //    EXACTLY the always-on steps (effect dep: freeStepMode), so the
                        //    default pipeline is restored cleanly, not as a superset of leftovers.
                        setSelectedSteps([]);
                      }}
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-lg border transition-all shrink-0"
                      style={{
                        color: freeStepMode ? 'var(--cp-green)' : 'var(--cp-paper-mute)',
                        borderColor: freeStepMode ? 'var(--cp-green)' : 'var(--cp-divider-strong)',
                        background: freeStepMode ? 'var(--cp-surface-active)' : 'var(--cp-surface-elev)',
                      }}
                      title="Самостоятельно выбрать, какие шаги выполнить"
                    >
                      <span
                        aria-hidden
                        className="inline-block w-2 h-2 rounded-full"
                        style={{ background: freeStepMode ? 'var(--cp-green)' : 'var(--cp-paper-faint)' }}
                      />
                      {freeStepMode ? 'Ручной выбор включён' : 'Выбрать шаги вручную'}
                    </button>
                  )}
                </div>
                <div className="px-6 py-5 space-y-5">
                  {/*
                    In clientMode 9 of 11 steps are always-on and locked
                    (ALWAYS_ON_STEPS_FOR_CLIENT). Per /impeccable critique
                    2026-05-25 (P1 identical-card-grid), rendering them as
                    9 disabled cards forces Olga to scan a wall of locked
                    chrome to find the 2 toggleable steps. Collapse them
                    into a single editorial summary row + render only the
                    AI category (with the 2 interactive cards) below.
                  */}
                  {clientMode && !freeStepMode && (
                    /* Bridge #5: flatten the «автоматически» inner box. The
                       framed wrapper inside an already-bordered outer card
                       was the hairline-on-hairline anti-pattern visible in
                       the 2026-05-26 screenshot review. The eyebrow + tight
                       paragraph speak for themselves; the outer section card
                       already provides the frame. clientMode-gated → admin
                       (/tools/our-bases) unaffected. */
                    <div className="px-1 py-2">
                      <p
                        className="ds-eyebrow mb-1"
                        style={{ color: 'var(--cp-paper-mute)' }}
                      >
                        автоматически
                      </p>
                      <p className="text-xs leading-relaxed" style={{ color: 'var(--cp-paper)' }}>
                        Очистка пустых, дедуп строк/email, разделение почт, очистка названий,
                        проверка сайтов, поиск email, валидация и обогащение описаниями —
                        выполняются по умолчанию для каждой базы.
                      </p>
                    </div>
                  )}
                  {CATEGORIES.map((cat) => {
                    const visibleSteps = clientMode && !freeStepMode
                      ? STEPS.filter((s) => s.category === cat.key && !ALWAYS_ON_SET.has(s.key))
                      : STEPS.filter((s) => s.category === cat.key);
                    if (visibleSteps.length === 0) return null;
                    return (
                    <div key={cat.key}>
                      <div className="flex items-center gap-2 mb-3">
                        <span className={clientMode
                          ? 'ds-eyebrow'
                          : `px-2.5 py-0.5 text-xs font-semibold rounded-md border ${cat.color}`}>
                          {clientMode ? cat.label.toLowerCase() : cat.label}
                        </span>
                      </div>
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
                        {visibleSteps.map((step) => {
                          const isSelected = selectedSteps.includes(step.key);
                          const lockedReason = isSelected ? isRequiredByOther(step.key) : null;
                          const isAlwaysOn = clientMode && !freeStepMode && ALWAYS_ON_SET.has(step.key);
                          // Client gate: «Оценка ЦА» (ta_scoring) requires a saved
                          // brief. We only block in client mode and only after the
                          // brief check finished (savedBriefAvailable !== null) —
                          // otherwise we'd briefly disable the step on first paint.
                          const taBriefMissing = clientMode
                            && step.key === 'ta_scoring'
                            && savedBriefAvailable === false
                            && !isSelected;
                          const Icon = step.icon;
                          const showAsActive = isSelected || isAlwaysOn;
                          const clientHint = clientMode && step.key === 'enrich_descriptions'
                            ? 'Парсинг выдаёт «грязное» описание, но полезно для оценки ЦА'
                            : null;
                          const disabledForBrief = taBriefMissing;
                          return (
                            <button
                              key={step.key}
                              onClick={() => toggleStep(step.key)}
                              disabled={isAlwaysOn || disabledForBrief}
                              title={
                                isAlwaysOn
                                  ? 'Выполняется автоматически'
                                  : disabledForBrief
                                  ? 'Сначала заполните бриф'
                                  : (lockedReason ?? undefined)
                              }
                              className={`group relative flex items-start gap-3 p-3.5 text-left transition-all ${
                                clientMode
                                  ? `rounded-lg border ${
                                      disabledForBrief
                                        ? 'border-[var(--cp-divider)] bg-[var(--cp-surface-rest)] cursor-not-allowed opacity-60'
                                        : showAsActive
                                        ? 'border-[var(--cp-paper-faint)] bg-[var(--cp-surface-active)]'
                                        : 'border-[var(--cp-divider)] bg-[var(--cp-surface-rest)] cursor-pointer hover:border-[var(--cp-divider-strong)] hover:bg-[var(--cp-surface-elev)]'
                                    }`
                                  : `rounded-xl border-2 ${
                                      isAlwaysOn
                                        ? 'border-emerald-200 bg-emerald-50/50 cursor-default'
                                        : disabledForBrief
                                        ? 'border-gray-100 bg-gray-50 cursor-not-allowed opacity-60'
                                        : showAsActive
                                        ? lockedReason ? 'border-gray-900 bg-gray-100 shadow-sm opacity-80' : 'border-gray-900 bg-gray-50 shadow-sm'
                                        : 'border-gray-100 bg-white hover:border-gray-300 hover:shadow-sm'
                                    }`
                              }`}
                            >
                              <div className={`flex-shrink-0 w-9 h-9 rounded-lg flex items-center justify-center transition ${
                                clientMode
                                  ? showAsActive ? 'bg-[var(--cp-paper)] text-[var(--cp-ink)]' : 'bg-[var(--cp-surface-elev)] text-[var(--cp-paper-faint)]'
                                  : isAlwaysOn ? 'bg-emerald-600 text-white' : showAsActive ? 'bg-gray-900 text-white' : 'bg-gray-100 text-gray-400 group-hover:bg-gray-200 group-hover:text-gray-600'
                              }`}>
                                <Icon className="w-4.5 h-4.5" />
                              </div>
                              <div className="min-w-0 flex-1">
                                <div className="flex items-center gap-2 flex-wrap">
                                  <p className={`text-sm font-semibold transition ${
                                    clientMode
                                      ? showAsActive ? 'text-[var(--cp-paper)]' : 'text-[var(--cp-paper-mute)]'
                                      : showAsActive ? 'text-gray-900' : 'text-gray-700'
                                  }`}>
                                    {step.label}
                                  </p>
                                  {isAlwaysOn ? (
                                    <span className="inline-flex items-center gap-0.5 px-1.5 py-0.5 text-[10px] font-semibold rounded border bg-emerald-50 text-emerald-700 border-emerald-200">
                                      <Lock className="w-2.5 h-2.5" />
                                      Будет выполнено
                                    </span>
                                  ) : (clientMode && step.cost !== 'ai') ? null : (
                                    (() => {
                                      const badge = COST_BADGES[step.cost];
                                      const CostIcon = badge.icon;
                                      return (
                                        <span className={`inline-flex items-center gap-0.5 px-1.5 py-0.5 text-[10px] font-semibold rounded border ${
                                          clientMode ? 'border-[var(--cp-divider-strong)] text-[var(--cp-paper-mute)]' : badge.color
                                        }`}>
                                          <CostIcon className="w-2.5 h-2.5" />
                                          {badge.label}
                                        </span>
                                      );
                                    })()
                                  )}
                                </div>
                                <p className={`text-xs mt-0.5 leading-relaxed ${clientMode ? 'text-[var(--cp-paper-faint)]' : 'text-gray-400'}`}>{step.description}</p>
                                {clientHint && (
                                  <p className="text-[11px] text-emerald-700 mt-1 flex items-start gap-1">
                                    <Zap className="w-3 h-3 mt-0.5 flex-shrink-0" />
                                    {clientHint}
                                  </p>
                                )}
                                {disabledForBrief && (
                                  <p className="text-[11px] text-blue-600 mt-1 flex items-start gap-1">
                                    <Lock className="w-3 h-3 mt-0.5 flex-shrink-0" />
                                    Сначала заполните&nbsp;
                                    <a
                                      href="/client/brief"
                                      onClick={(e) => e.stopPropagation()}
                                      className="font-semibold underline hover:text-blue-800"
                                    >
                                      бриф
                                    </a>
                                    &nbsp;— нужен для AI-оценки релевантности
                                  </p>
                                )}
                                {showAsActive && columnWarnings.has(step.key) && (
                                  <p className="text-[11px] text-amber-600 mt-1 flex items-center gap-1">
                                    <AlertTriangle className="w-3 h-3 flex-shrink-0" />
                                    {columnWarnings.get(step.key)}
                                  </p>
                                )}
                                {isSelected && lockedReason && !isAlwaysOn && (
                                  <p className="text-[11px] text-gray-500 mt-1 flex items-center gap-1">
                                    <Lock className="w-3 h-3 flex-shrink-0" />
                                    {lockedReason}
                                  </p>
                                )}
                                {showAsActive && !columnWarnings.has(step.key) && stepHints.has(step.key) && !clientHint && (
                                  <p className="text-[11px] text-blue-500 mt-1 flex items-center gap-1">
                                    <Zap className="w-3 h-3 flex-shrink-0" />
                                    {stepHints.get(step.key)}
                                  </p>
                                )}
                              </div>
                              {showAsActive ? (
                                <div className={`absolute top-2 right-2 w-5 h-5 rounded-full ${
                                  clientMode ? 'bg-[var(--cp-paper)]' : isAlwaysOn ? 'bg-emerald-600' : 'bg-gray-900'
                                } flex items-center justify-center`}>
                                  <Check className={`w-3 h-3 ${clientMode ? 'text-[var(--cp-ink)]' : 'text-white'}`} />
                                </div>
                              ) : (!isAlwaysOn && !disabledForBrief) ? (
                                /* Empty selection circle → signals the card is a selectable toggle. */
                                <div className={`absolute top-2 right-2 w-5 h-5 rounded-full border-2 transition ${
                                  clientMode
                                    ? 'border-[var(--cp-divider-strong)] group-hover:border-[var(--cp-paper-faint)]'
                                    : 'border-gray-200 group-hover:border-gray-400'
                                }`} />
                              ) : null}
                            </button>
                          );
                        })}
                      </div>
                    </div>
                    );
                  })}

                  {/* Selected order */}
                  {selectedSteps.length > 0 && (
                    <div className={`pt-3 border-t ${clientMode ? 'border-[var(--cp-divider)]' : 'border-gray-100'}`}>
                      <p className={clientMode ? 'ds-eyebrow mb-2' : 'text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2'}>{clientMode ? 'порядок выполнения' : 'Порядок выполнения'}</p>
                      <div className="flex flex-wrap gap-1.5">
                        {selectedSteps.map((key, idx) => {
                          const step = STEP_MAP.get(key);
                          if (!step) return null;
                          const hasWarning = columnWarnings.has(key);
                          const hasHint = !hasWarning && stepHints.has(key);
                          const locked = isRequiredByOther(key);
                          return (
                            <span
                              key={key}
                              title={locked ?? undefined}
                              className={`inline-flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium ${
                                clientMode
                                  ? 'rounded-md border border-[var(--cp-divider-strong)] bg-[var(--cp-surface-elev)] text-[var(--cp-paper-mute)]'
                                  : `rounded-lg ${
                                      hasWarning ? 'bg-amber-50 text-amber-700 border border-amber-200'
                                      : hasHint ? 'bg-blue-50 text-blue-700 border border-blue-200'
                                      : 'bg-gray-100 text-gray-700'
                                    }`
                              }`}
                            >
                              <span className={`w-4 h-4 rounded-full text-[10px] font-bold flex items-center justify-center flex-shrink-0 ${
                                clientMode ? 'bg-[var(--cp-paper)] text-[var(--cp-ink)]' : 'bg-gray-900 text-white'
                              }`}>
                                {idx + 1}
                              </span>
                              {step.label}
                              {hasWarning && <AlertTriangle className="w-3 h-3 text-amber-500" />}
                              {hasHint && <Zap className="w-3 h-3 text-blue-500" />}
                              {locked || (clientMode && !freeStepMode && ALWAYS_ON_SET.has(key)) ? (
                                <span
                                  className="ml-0.5 text-gray-300 cursor-not-allowed inline-flex items-center"
                                  title={locked ?? 'Выполняется автоматически'}
                                >
                                  <Lock className="w-3 h-3" />
                                </span>
                              ) : (
                              <button
                                onClick={(e) => { e.stopPropagation(); toggleStep(key); }}
                                className="ml-0.5 text-gray-400 hover:text-gray-600"
                              >
                                <X className="w-3 h-3" />
                              </button>
                              )}
                            </span>
                          );
                        })}
                      </div>
                      {columnWarnings.size > 0 && (
                        <p className="text-[11px] text-amber-600 mt-2 flex items-center gap-1">
                          <AlertTriangle className="w-3 h-3" />
                          Некоторые шаги могут быть пропущены — в файле нет нужных колонок
                        </p>
                      )}
                      {stepHints.size > 0 && (
                        <div className="mt-2 space-y-1">
                          {[...stepHints.entries()].map(([key, hint]) => (
                            <p key={key} className="text-[11px] text-blue-500 flex items-center gap-1">
                              <Zap className="w-3 h-3 flex-shrink-0" />
                              {hint}
                            </p>
                          ))}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* Column mapping */}
            {fileData && selectedSteps.length > 0 && neededRoles.length > 0 && (
              <div className={clientMode ? 'neu-card overflow-hidden' : 'bg-white rounded-2xl border border-gray-200 shadow-sm overflow-hidden'}>
                <div className={clientMode ? 'px-6 py-4 border-b border-[var(--cp-divider)]' : 'px-6 py-4 border-b border-gray-100 bg-gray-50/50'}>
                  <h2 className={clientMode ? 'text-base font-semibold m-0 text-[var(--cp-paper)]' : 'text-base font-bold text-gray-900'}>3. Укажите колонки</h2>
                  <p className="text-xs text-gray-500 mt-0.5">Выберите, какая колонка в файле соответствует каждому полю</p>
                </div>
                <div className="px-6 py-5 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                  {neededRoles.map((role) => {
                    const mapped = columnMapping[role.key] || '';
                    const contentWarn = contentWarnByRole.get(role.key);
                    return (
                      <div key={role.key}>
                        <label className={clientMode ? 'ds-eyebrow mb-1.5 block' : 'block text-sm font-semibold text-gray-700 mb-1.5'}>
                          {role.label}
                          {!mapped && <span className={clientMode ? 'text-[var(--cp-red)] ml-1' : 'text-red-400 ml-1'}>*</span>}
                        </label>
                        <select
                          value={mapped}
                          onChange={(e) => setColumnMapping((prev) => {
                            const next = { ...prev };
                            if (e.target.value) next[role.key] = e.target.value;
                            else delete next[role.key];
                            return next;
                          })}
                          className={clientMode
                            ? `ds-input w-full ${!mapped ? 'border-[var(--cp-red)]' : ''}`
                            : `w-full px-3 py-2 text-sm border rounded-xl bg-gray-50 outline-none transition hover:bg-gray-100 focus:border-gray-400 focus:bg-white ${
                                !mapped ? 'border-red-300' : 'border-gray-200'
                              }`}
                        >
                          <option value="">— Не выбрано —</option>
                          {(fileData[0] || []).map((col, idx) => (
                            <option key={idx} value={col}>{col}</option>
                          ))}
                        </select>
                        {mapped && (
                          <p className={`text-[11px] mt-1 flex items-center gap-1 ${clientMode ? 'text-[var(--cp-green)]' : 'text-emerald-600'}`}>
                            <Check className="w-3 h-3" /> {mapped}
                          </p>
                        )}
                        {contentWarn && (
                          <p className={`text-[11px] mt-1 flex items-start gap-1 ${clientMode ? 'text-amber-400' : 'text-amber-600'}`}>
                            <AlertTriangle className="w-3 h-3 mt-0.5 shrink-0" />
                            <span>
                              {contentWarn.message}
                              {contentWarn.sample.length > 0 && (
                                <span className="opacity-70"> Напр.: {contentWarn.sample.join(', ')}</span>
                              )}
                            </span>
                          </p>
                        )}
                      </div>
                    );
                  })}
                </div>
                {unmappedRoles.length > 0 && (
                  <div className="px-6 pb-4">
                    <p className="text-[11px] text-red-500 flex items-center gap-1">
                      <AlertTriangle className="w-3 h-3" />
                      Укажите все обязательные колонки для запуска
                    </p>
                  </div>
                )}
              </div>
            )}

            {/* Settings: brief, prompt, email pipeline target options */}
            {fileData && (needsBrief || needsPrompt || showFindEmailsTargetOption || showValidateTargetOption) && (
              <div className={clientMode ? 'neu-card overflow-hidden' : 'bg-white rounded-2xl border border-gray-200 shadow-sm overflow-hidden'}>
                <div className={clientMode ? 'px-6 py-4 border-b border-[var(--cp-divider)]' : 'px-6 py-4 border-b border-gray-100 bg-gray-50/50'}>
                  <h2 className={clientMode ? 'text-base font-semibold m-0 text-[var(--cp-paper)]' : 'text-base font-bold text-gray-900'}>{neededRoles.length > 0 ? '4' : '3'}. Настройки</h2>
                </div>
                <div className="px-6 py-5 space-y-4">
                  {(showFindEmailsTargetOption || showValidateTargetOption) && (
                    <div className="space-y-3 pb-1">
                      <h3 className={`text-sm font-semibold flex items-center gap-2 ${clientMode ? 'text-[var(--cp-paper)]' : 'text-gray-700'}`}>
                        <MailSearch className={`w-4 h-4 ${clientMode ? 'text-[var(--cp-paper-faint)]' : 'text-gray-500'}`} />
                        Email пайплайн
                      </h3>

                      {showFindEmailsTargetOption && (
                        <fieldset className={clientMode ? 'border border-[var(--cp-divider)] rounded-md p-4 space-y-2' : 'border border-gray-200 rounded-xl p-4 space-y-2'}>
                          <legend className={clientMode ? 'ds-eyebrow px-1' : 'text-xs font-semibold text-gray-700 px-1'}>
                            Куда писать найденные email
                          </legend>
                          <p className="text-[11px] text-gray-500 mb-2">
                            В вашем файле уже есть колонка email. Выберите, как поступить с теми, что найдутся со скрейпа сайтов.
                          </p>
                          <label className="flex items-start gap-2 cursor-pointer select-none">
                            <input
                              type="radio"
                              name="find-emails-target"
                              value="separate"
                              checked={findEmailsTarget === 'separate'}
                              onChange={() => setFindEmailsTarget('separate')}
                              className={clientMode ? 'mt-0.5 w-4 h-4 accent-[var(--cp-paper)]' : 'mt-0.5 w-4 h-4 text-violet-600 focus:ring-violet-400'}
                            />
                            <span className={clientMode ? 'text-xs text-[var(--cp-paper-mute)] leading-snug' : 'text-xs text-gray-700 leading-snug'}>
                              В отдельную колонку «Найденный Email»
                              <span className={clientMode ? 'block text-[11px] text-[var(--cp-paper-faint)] mt-0.5' : 'block text-[11px] text-gray-500 mt-0.5'}>
                                Исходные email не трогаются. В итоговом файле колонки сольются в одну с дедупом.
                              </span>
                            </span>
                          </label>
                          <label className="flex items-start gap-2 cursor-pointer select-none">
                            <input
                              type="radio"
                              name="find-emails-target"
                              value="same"
                              checked={findEmailsTarget === 'same'}
                              onChange={() => setFindEmailsTarget('same')}
                              className={clientMode ? 'mt-0.5 w-4 h-4 accent-[var(--cp-paper)]' : 'mt-0.5 w-4 h-4 text-violet-600 focus:ring-violet-400'}
                            />
                            <span className={clientMode ? 'text-xs text-[var(--cp-paper-mute)] leading-snug' : 'text-xs text-gray-700 leading-snug'}>
                              Дополнять ту же колонку
                              <span className={clientMode ? 'block text-[11px] text-[var(--cp-paper-faint)] mt-0.5' : 'block text-[11px] text-gray-500 mt-0.5'}>
                                Найденные email вписываются только в пустые ячейки. Существующие не перезаписываются.
                              </span>
                            </span>
                          </label>
                        </fieldset>
                      )}

                      {showValidateTargetOption && (
                        <fieldset className={clientMode ? 'border border-[var(--cp-divider)] rounded-md p-4 space-y-2' : 'border border-gray-200 rounded-xl p-4 space-y-2'}>
                          <legend className={clientMode ? 'ds-eyebrow px-1' : 'text-xs font-semibold text-gray-700 px-1'}>
                            Что валидировать
                          </legend>
                          <p className="text-[11px] text-gray-500 mb-2">
                            После шага «Найти email» у вас будет 2 email-колонки. Выберите какие проверить SMTP-валидацией.
                          </p>
                          <label className="flex items-start gap-2 cursor-pointer select-none">
                            <input
                              type="radio"
                              name="validate-target"
                              value="original"
                              checked={validateTarget === 'original'}
                              onChange={() => setValidateTarget('original')}
                              className={clientMode ? 'mt-0.5 w-4 h-4 accent-[var(--cp-paper)]' : 'mt-0.5 w-4 h-4 text-violet-600 focus:ring-violet-400'}
                            />
                            <span className={clientMode ? 'text-xs text-[var(--cp-paper-mute)] leading-snug' : 'text-xs text-gray-700 leading-snug'}>
                              Только исходные
                              <span className={clientMode ? 'block text-[11px] text-[var(--cp-paper-faint)] mt-0.5' : 'block text-[11px] text-gray-500 mt-0.5'}>
                                Email из загруженного файла. Найденные scrape-результаты не валидируем.
                              </span>
                            </span>
                          </label>
                          <label className="flex items-start gap-2 cursor-pointer select-none">
                            <input
                              type="radio"
                              name="validate-target"
                              value="found"
                              checked={validateTarget === 'found'}
                              onChange={() => setValidateTarget('found')}
                              className={clientMode ? 'mt-0.5 w-4 h-4 accent-[var(--cp-paper)]' : 'mt-0.5 w-4 h-4 text-violet-600 focus:ring-violet-400'}
                            />
                            <span className={clientMode ? 'text-xs text-[var(--cp-paper-mute)] leading-snug' : 'text-xs text-gray-700 leading-snug'}>
                              Только найденные
                              <span className={clientMode ? 'block text-[11px] text-[var(--cp-paper-faint)] mt-0.5' : 'block text-[11px] text-gray-500 mt-0.5'}>
                                Email со скрейпа сайтов. Исходные считаем доверенными.
                              </span>
                            </span>
                          </label>
                          <label className="flex items-start gap-2 cursor-pointer select-none">
                            <input
                              type="radio"
                              name="validate-target"
                              value="both"
                              checked={validateTarget === 'both'}
                              onChange={() => setValidateTarget('both')}
                              className={clientMode ? 'mt-0.5 w-4 h-4 accent-[var(--cp-paper)]' : 'mt-0.5 w-4 h-4 text-violet-600 focus:ring-violet-400'}
                            />
                            <span className={clientMode ? 'text-xs text-[var(--cp-paper-mute)] leading-snug' : 'text-xs text-gray-700 leading-snug'}>
                              Обе
                              <span className={clientMode ? 'block text-[11px] text-[var(--cp-paper-faint)] mt-0.5' : 'block text-[11px] text-gray-500 mt-0.5'}>
                                Каждая колонка валидируется независимо. Невалидные email очищаются, строка вылетает только если все колонки пустые/невалидные.
                              </span>
                            </span>
                          </label>
                        </fieldset>
                      )}
                    </div>
                  )}
                  {needsBrief && (
                    <div>
                      <label className={clientMode ? 'ds-eyebrow mb-2 block' : 'block text-sm font-semibold text-gray-700 mb-2'}>
                        {clientMode ? 'бриф для оценки ЦА' : 'Бриф для оценки ЦА'}
                      </label>
                      <div className={clientMode ? 'flex gap-1 p-0.5 rounded-md mb-3 w-fit border border-[var(--cp-divider)] bg-[var(--cp-surface-rest)]' : 'flex gap-1 p-1 bg-gray-100 rounded-lg mb-3 w-fit'}>
                        {clientMode && (
                          <button
                            type="button"
                            onClick={() => {
                              setBriefInputMode('saved');
                              setBriefFileName('');
                            }}
                            className={`px-3 py-1.5 text-xs font-medium rounded transition-all ${
                              clientMode
                                ? briefInputMode === 'saved' ? 'bg-[var(--cp-paper)] text-[var(--cp-ink)]' : 'text-[var(--cp-paper-mute)]'
                                : briefInputMode === 'saved'
                                  ? 'bg-white text-gray-900 shadow-sm'
                                  : 'text-gray-500 hover:text-gray-700'
                            }`}
                          >
                            Сохранённый бриф
                          </button>
                        )}
                        <button
                          type="button"
                          onClick={() => setBriefInputMode('pdf')}
                          className={`px-3 py-1.5 text-xs font-medium rounded transition-all ${
                            clientMode
                              ? briefInputMode === 'pdf' ? 'bg-[var(--cp-paper)] text-[var(--cp-ink)]' : 'text-[var(--cp-paper-mute)]'
                              : briefInputMode === 'pdf'
                                ? 'bg-white text-gray-900 shadow-sm'
                                : 'text-gray-500 hover:text-gray-700'
                          }`}
                        >
                          PDF файл
                        </button>
                        <button
                          type="button"
                          onClick={() => setBriefInputMode('text')}
                          className={`px-3 py-1.5 text-xs font-medium rounded transition-all ${
                            clientMode
                              ? briefInputMode === 'text' ? 'bg-[var(--cp-paper)] text-[var(--cp-ink)]' : 'text-[var(--cp-paper-mute)]'
                              : briefInputMode === 'text'
                                ? 'bg-white text-gray-900 shadow-sm'
                                : 'text-gray-500 hover:text-gray-700'
                          }`}
                        >
                          Текст
                        </button>
                      </div>
                      {clientMode && briefInputMode === 'saved' ? (
                        <div>
                          {savedBriefLoading ? (
                            <div className={clientMode
                              ? 'flex items-center gap-2 px-3 py-3 text-sm border border-[var(--cp-divider)] bg-[var(--cp-surface-rest)] rounded-md text-[var(--cp-paper-mute)]'
                              : 'flex items-center gap-2 px-3 py-3 text-sm border border-gray-200 bg-gray-50 rounded-xl text-gray-500'}>
                              <Loader2 size={14} className="animate-spin" />
                              Загружаем сохранённый бриф…
                            </div>
                          ) : savedBriefAvailable ? (
                            <div className="space-y-2">
                              <div className={clientMode ? 'flex items-center gap-2 px-3 py-2.5 text-sm border border-[var(--cp-divider-strong)] bg-[var(--cp-surface-rest)] rounded-md' : 'flex items-center gap-2 px-3 py-2.5 text-sm border border-emerald-200 bg-emerald-50 rounded-xl'}>
                                <Check size={14} className={clientMode ? 'text-[var(--cp-green)] shrink-0' : 'text-emerald-600 shrink-0'} />
                                <span className={clientMode ? 'text-[var(--cp-paper)]' : 'text-emerald-800'}>Сохранённый бриф будет использован</span>
                                <a
                                  href="/client/brief"
                                  className={clientMode ? 'ml-auto text-xs text-[var(--cp-paper-mute)] underline hover:text-[var(--cp-paper)]' : 'ml-auto text-xs text-emerald-700 underline hover:text-emerald-900'}
                                >
                                  Открыть и отредактировать
                                </a>
                              </div>
                              <p className="text-[11px] text-gray-500">
                                Хотите подгрузить разовый бриф вместо сохранённого — переключитесь на «PDF файл» или «Текст».
                              </p>
                            </div>
                          ) : (
                            <div className={clientMode
                              ? 'flex items-center gap-2 px-3 py-3 text-sm border border-[var(--cp-divider-strong)] bg-[var(--cp-surface-rest)] rounded-md text-[var(--cp-amber)]'
                              : 'flex items-center gap-2 px-3 py-3 text-sm border border-amber-200 bg-amber-50 rounded-xl text-amber-800'}>
                              Бриф ещё не заполнен.{' '}
                              <a href="/client/brief" className="underline hover:text-amber-900">
                                Заполнить сейчас
                              </a>
                              {savedBriefError && (
                                <span className="ml-2 text-[11px] text-amber-700">({savedBriefError})</span>
                              )}
                            </div>
                          )}
                        </div>
                      ) : briefInputMode === 'pdf' ? (
                        <div>
                          <input
                            ref={briefFileRef}
                            type="file"
                            accept=".pdf"
                            className="hidden"
                            onChange={(e) => void handleBriefPdfUpload(e)}
                          />
                          {briefFileName && brief ? (
                            <div className={clientMode ? 'flex items-center gap-2 px-3 py-2.5 text-sm border border-[var(--cp-divider-strong)] bg-[var(--cp-surface-rest)] rounded-md' : 'flex items-center gap-2 px-3 py-2.5 text-sm border border-emerald-200 bg-emerald-50 rounded-xl'}>
                              <Check size={14} className={clientMode ? 'text-[var(--cp-green)] shrink-0' : 'text-emerald-600 shrink-0'} />
                              <span className="text-emerald-800 truncate">{briefFileName}</span>
                              <button
                                type="button"
                                onClick={() => { setBrief(''); setBriefFileName(''); }}
                                className="ml-auto text-gray-400 hover:text-gray-600"
                              >
                                <X size={14} />
                              </button>
                            </div>
                          ) : (
                            <button
                              type="button"
                              disabled={briefUploading}
                              onClick={() => briefFileRef.current?.click()}
                              className={clientMode
                                ? 'w-full flex items-center justify-center gap-2 px-3 py-3 text-sm border border-dashed border-[var(--cp-divider-strong)] rounded-md text-[var(--cp-paper-mute)] transition hover:border-[var(--cp-paper-faint)] hover:text-[var(--cp-paper)] disabled:opacity-40'
                                : 'w-full flex items-center justify-center gap-2 px-3 py-3 text-sm border-2 border-dashed border-gray-200 rounded-xl text-gray-500 transition hover:border-gray-400 hover:text-gray-700 disabled:opacity-50'}
                            >
                              {briefUploading ? (
                                <><Loader2 size={16} className="animate-spin" /> Обработка PDF…</>
                              ) : (
                                <><FileUp size={16} /> Загрузить PDF бриф</>
                              )}
                            </button>
                          )}
                        </div>
                      ) : (
                        <textarea
                          value={brief}
                          onChange={(e) => setBrief(e.target.value)}
                          rows={8}
                          placeholder="Опишите вашу целевую аудиторию, продукт, идеального клиента..."
                          className={clientMode
                            ? 'ds-input w-full min-h-[12rem] resize-y leading-relaxed'
                            : 'w-full min-h-[12rem] resize-y px-3 py-2.5 text-sm leading-relaxed border border-gray-200 rounded-xl bg-gray-50 outline-none transition hover:bg-gray-100 focus:border-gray-400 focus:bg-white'}
                        />
                      )}
                      <label className="mt-3 flex items-start gap-2 cursor-pointer select-none">
                        <input
                          type="checkbox"
                          checked={keepAllScored}
                          onChange={(e) => setKeepAllScored(e.target.checked)}
                          className="mt-0.5 w-4 h-4 rounded border-gray-300 text-violet-600 focus:ring-violet-400"
                        />
                        <span className={clientMode ? 'text-xs text-[var(--cp-paper-mute)] leading-snug' : 'text-xs text-gray-700 leading-snug'}>
                          Сохранить все оценённые компании (без фильтра 7+)
                          <span className={clientMode ? 'block text-[11px] text-[var(--cp-paper-faint)] mt-0.5' : 'block text-[11px] text-gray-500 mt-0.5'}>
                            По умолчанию AI оставляет только баллы 7–10. Включите, чтобы получить файл со всеми компаниями и их оценками — сами решите кого взять.
                          </span>
                        </span>
                      </label>
                    </div>
                  )}
                  {needsPrompt && (
                    <div>
                      <label className={clientMode ? 'ds-eyebrow mb-1.5 block' : 'block text-sm font-semibold text-gray-700 mb-1.5'}>
                        {clientMode ? 'промпт для персонализации' : 'Промпт для персонализации'}
                      </label>
                      <p className={clientMode ? 'text-xs text-[var(--cp-paper-faint)] mb-2' : 'text-xs text-gray-500 mb-2'}>
                        AI будет использовать все данные из каждой строки (название, сайт, описание и т.д.) для генерации.
                      </p>
                      <textarea
                        value={prompt}
                        onChange={(e) => setPrompt(e.target.value)}
                        rows={3}
                        placeholder="Что AI должен написать? Например: 'Напиши приветствие с упоминанием деятельности компании'"
                        className={clientMode ? 'ds-input w-full resize-none' : 'w-full px-3 py-2.5 text-sm border border-gray-200 rounded-xl bg-gray-50 outline-none transition hover:bg-gray-100 focus:border-gray-400 focus:bg-white resize-none'}
                      />
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* Submit */}
            {fileData && selectedSteps.length > 0 && (
              <div className="space-y-3">
                {error && <p className="text-sm text-red-600">{error}</p>}
                {atActiveLimit && !error && (
                  <div
                    className={clientMode
                      ? 'flex items-start gap-2 p-3 border border-[var(--cp-amber)] rounded-md text-xs text-[var(--cp-paper)]'
                      : 'flex items-start gap-2 p-3 bg-amber-50 border border-amber-200 rounded-xl text-xs text-amber-900'}
                  >
                    <AlertTriangle className={clientMode ? 'w-4 h-4 mt-0.5 flex-shrink-0 text-[var(--cp-amber)]' : 'w-4 h-4 mt-0.5 flex-shrink-0 text-amber-600'} />
                    <span>
                      Нельзя поставить больше {MAX_ACTIVE_JOBS} активных баз одновременно.
                      {' '}Подождите, пока какая-нибудь из предыдущих задач завершится.
                    </span>
                  </div>
                )}
                <button
                  onClick={() => void handleSubmit()}
                  disabled={!canSubmit}
                  className={clientMode
                    ? 'w-full py-3 text-sm font-medium rounded-md bg-[var(--cp-paper)] text-[var(--cp-ink)] transition hover:bg-[var(--cp-paper-mute)] disabled:opacity-40 disabled:cursor-not-allowed flex items-center justify-center gap-2'
                    : 'w-full py-3 text-sm font-medium rounded-xl bg-gray-900 text-white shadow-sm transition hover:bg-gray-800 disabled:bg-gray-300 disabled:cursor-not-allowed flex items-center justify-center gap-2'}
                >
                  {submitting ? (
                    <>
                      <Loader2 className="w-4 h-4 animate-spin" />
                      {submittingElapsedSec < 5 && 'Запуск...'}
                      {submittingElapsedSec >= 5 && submittingElapsedSec < 20 && 'Загружаем базу...'}
                      {submittingElapsedSec >= 20 && submittingElapsedSec < 60 && `Сохраняем... ${submittingElapsedSec}s`}
                      {submittingElapsedSec >= 60 && `Большой файл, ещё немного... ${submittingElapsedSec}s`}
                    </>
                  ) : (
                    <>
                      <Play className="w-4 h-4" />
                      Запустить обработку ({selectedSteps.length} {selectedSteps.length === 1 ? 'шаг' : selectedSteps.length < 5 ? 'шага' : 'шагов'})
                    </>
                  )}
                </button>
                {/* Фазированный hint под кнопкой — синхронизируется с таймером
                    выше. До 5s — ничего (быстрый ответ выглядит как обычная
                    форма). 5-30s — мягкое объяснение что нормально. 30s+ —
                    подсказка что фоновый polling уже работает (см. useEffect
                    в начале файла, который ловит активный job через GET).
                    60s+ — финальный совет про F5 если совсем хочется
                    подействовать. */}
                {submitting && submittingElapsedSec >= 5 && (
                  <p className={`text-xs leading-relaxed ${clientMode ? 'text-[var(--cp-paper-faint)]' : 'text-gray-500'}`}>
                    {submittingElapsedSec < 30 && (
                      <>Загружаем базу на сервер. На больших файлах (несколько мегабайт) это занимает до минуты — это нормально.</>
                    )}
                    {submittingElapsedSec >= 30 && submittingElapsedSec < 90 && (
                      <>Файл большой, продолжаем сохранение. Задача наверняка уже запущена на сервере — если ответ долго не приходит, мы переключим экран автоматически.</>
                    )}
                    {submittingElapsedSec >= 90 && (
                      <>Сохранение затянулось. Обновите страницу (F5) — задача почти наверняка уже запущена и появится в «Прогрессе».</>
                    )}
                  </p>
                )}
                {/* Pre-flight summary — facts the user can verify, plus a
                    rough time band based on per-step empirical timings
                    (see estimateProcessingMinutes below).
                    History: earlier formula ignored `cheap` cost (site-scrape
                    steps like find_emails, check_sites, enrich_descriptions)
                    and only counted `ai`/`api`. For polza@polza.ru job on
                    4297 rows it predicted «5–15 минут» but actual was 2h —
                    because the 3 cheap site-scraping steps dominated, and
                    they weren't in the formula at all. Now `cheap` is the
                    biggest coefficient. */}
                {!submitting && (() => {
                  const rows = Math.max(0, (fileData?.length ?? 0) - 1);
                  const aiSteps = selectedSteps.filter((k) => STEP_MAP.get(k)?.cost === 'ai').length;
                  const apiSteps = selectedSteps.filter((k) => STEP_MAP.get(k)?.cost === 'api').length;
                  const cheapSteps = selectedSteps.filter((k) => STEP_MAP.get(k)?.cost === 'cheap').length;
                  const timeLabel = formatProcessingTimeBand(
                    estimateProcessingMinutes({ rows, cheapSteps, apiSteps, aiSteps }),
                  );
                  return (
                    <p
                      className="ds-mono text-xs text-center"
                      style={{ color: 'var(--cp-paper-mute)' }}
                    >
                      ≈ {timeLabel}
                      <span style={{ color: 'var(--cp-paper-faint)' }}> · </span>
                      <span style={{ color: 'var(--cp-paper)' }}>
                        {rows.toLocaleString('ru-RU')}
                      </span>{' '}
                      строк в обработке
                      {aiSteps > 0 && (
                        <>
                          <span style={{ color: 'var(--cp-paper-faint)' }}> · </span>
                          <span style={{ color: 'var(--cp-paper)' }}>
                            {(aiSteps * rows).toLocaleString('ru-RU')}
                          </span>{' '}
                          AI-обработок
                        </>
                      )}
                    </p>
                  );
                })()}
              </div>
            )}
          </>
        )}

        {/* ═══════════ PROGRESS ═══════════ */}
        {isRunning && activeJob && (
          <div className={clientMode ? 'neu-card overflow-hidden' : 'bg-white rounded-2xl border border-gray-200 shadow-sm overflow-hidden'}>
            <div className={clientMode ? 'px-6 py-4 border-b border-[var(--cp-divider)] flex items-center justify-between' : 'px-6 py-4 border-b border-gray-100 bg-gray-50/50 flex items-center justify-between'}>
              <div>
                <h2 className={clientMode ? 'text-base font-semibold m-0 text-[var(--cp-paper)]' : 'text-base font-bold text-gray-900'}>Обработка базы</h2>
                <p className={`text-xs mt-0.5 ${clientMode ? 'text-[var(--cp-paper-mute)]' : 'text-gray-500'}`}>
                  {activeJob.file_name || 'Файл'} — {activeJob.initial_row_count} строк
                </p>
              </div>
              <div className="flex items-center gap-2">
                {/* «Поставить ещё базу» — выход из карточки прогресса
                    в форму загрузки. Текущий job продолжает крутиться
                    в фоне, виден в истории ниже. Если у юзера уже
                    {MAX_ACTIVE_JOBS} активных задач — кнопка показывается,
                    но на форме будет дисейблнутый submit с подсказкой. */}
                <button
                  onClick={() => { resetForm(); }}
                  className={clientMode
                    ? 'ds-btn-ghost text-xs inline-flex items-center gap-1'
                    : 'px-3 py-1.5 text-xs font-medium rounded-lg bg-gray-100 text-gray-700 hover:bg-gray-200 transition inline-flex items-center gap-1'}
                  title="Поставить ещё одну базу в очередь — текущая продолжит обрабатываться"
                >
                  <Upload className="w-3.5 h-3.5" />
                  Поставить ещё базу
                </button>
                <button
                  onClick={() => void handleCancel()}
                  className={clientMode
                    ? 'ds-btn-ghost text-xs text-[var(--cp-red)]'
                    : 'px-3 py-1.5 text-xs font-medium rounded-lg bg-red-50 text-red-600 hover:bg-red-100 transition'}
                >
                  Отменить
                </button>
              </div>
            </div>
            <div className="px-6 py-5 space-y-5">
              {/* Overall progress bar */}
              <div>
                <div className="flex items-center justify-between text-sm mb-2">
                  <span className={`font-medium ${clientMode ? 'text-[var(--cp-paper)]' : 'text-gray-900'}`}>
                    {STEP_MAP.get(activeJob.current_step_key as StepKey)?.label || 'Обработка...'}
                  </span>
                  <span className={`tabular-nums ${clientMode ? 'text-[var(--cp-paper-mute)]' : 'text-gray-500'}`}>{Math.max(0, overallProgress)}%</span>
                </div>
                <div className={`w-full rounded-full h-2.5 ${clientMode ? 'bg-[var(--cp-surface-elev)]' : 'bg-gray-100'}`}>
                  <div
                    className={`h-2.5 rounded-full transition-all duration-700 ease-out ${clientMode ? 'bg-[var(--cp-paper)]' : 'bg-gray-900'}`}
                    style={{ width: `${Math.max(0, overallProgress)}%` }}
                  />
                </div>
              </div>

              {/* Step-by-step indicators */}
              <div className="space-y-2">
                {activeJob.selected_steps.map((stepKey, idx) => {
                  const step = STEP_MAP.get(stepKey);
                  if (!step) return null;
                  const Icon = step.icon;
                  const stepNum = idx + 1;
                  const isCurrent = activeJob.current_step === stepNum;
                  const isDone = activeJob.current_step > stepNum || activeJob.status === 'completed';
                  const isPending = !isCurrent && !isDone;

                  return (
                    <div
                      key={stepKey}
                      className={`flex items-center gap-3 px-4 py-2.5 transition-all ${
                        clientMode
                          ? `rounded-md ${
                              isCurrent
                                ? 'bg-[var(--cp-surface-active)] border border-[var(--cp-divider-strong)]'
                                : isDone
                                  ? 'bg-[var(--cp-surface-rest)] border border-[var(--cp-divider)]'
                                  : 'border border-transparent'
                            }`
                          : `rounded-xl ${
                              isCurrent
                                ? 'bg-blue-50 border border-blue-200'
                                : isDone
                                  ? 'bg-emerald-50/50 border border-emerald-100'
                                  : 'bg-gray-50/50 border border-transparent'
                            }`
                      }`}
                    >
                      <div className={`flex-shrink-0 w-8 h-8 rounded-lg flex items-center justify-center ${
                        clientMode
                          ? isDone
                            ? 'bg-[var(--cp-surface-elev)] text-[var(--cp-green)]'
                            : isCurrent
                              ? 'bg-[var(--cp-paper)] text-[var(--cp-ink)] animate-pulse'
                              : 'bg-[var(--cp-surface-elev)] text-[var(--cp-paper-faint)]'
                          : isDone
                            ? 'bg-emerald-100 text-emerald-700'
                            : isCurrent
                              ? 'bg-blue-500 text-white animate-pulse'
                              : 'bg-gray-100 text-gray-400'
                      }`}>
                        {isDone ? <Check className="w-4 h-4" /> : <Icon className="w-4 h-4" />}
                      </div>
                      <div className="flex-1 min-w-0">
                        <p className={`text-sm font-medium ${
                          clientMode
                            ? isDone ? 'text-[var(--cp-paper-mute)]' : isCurrent ? 'text-[var(--cp-paper)]' : 'text-[var(--cp-paper-faint)]'
                            : isDone ? 'text-emerald-700' : isCurrent ? 'text-blue-700' : 'text-gray-400'
                        }`}>
                          {step.label}
                        </p>
                      </div>
                      {isCurrent && activeJob.current_step_progress > 0 && (
                        <span className={`text-xs font-medium tabular-nums ${clientMode ? 'text-[var(--cp-paper)]' : 'text-blue-600'}`}>
                          {activeJob.current_step_progress}%
                        </span>
                      )}
                      {isDone && (
                        <Check className={`w-4 h-4 flex-shrink-0 ${clientMode ? 'text-[var(--cp-green)]' : 'text-emerald-500'}`} />
                      )}
                      {isPending && (
                        <span className={`text-xs ${clientMode ? 'text-[var(--cp-paper-faint)]' : 'text-gray-300'}`}>ожидание</span>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        )}

        {/* ═══════════ FAILED ═══════════ */}
        {isFailed && activeJob && (
          <div className={clientMode ? 'neu-card overflow-hidden' : 'bg-white rounded-2xl border border-red-200 shadow-sm overflow-hidden'}>
            <div className={clientMode ? 'px-6 py-4 border-b border-[var(--cp-divider)]' : 'px-6 py-4 border-b border-red-100 bg-red-50/50'}>
              <h2 className={`text-base ${clientMode ? 'font-semibold m-0 text-[var(--cp-red)]' : 'font-bold text-red-700'}`}>Ошибка</h2>
            </div>
            <div className="px-6 py-5 space-y-3">
              <p className={`text-sm ${clientMode ? 'text-[var(--cp-red)]' : 'text-red-600'}`}>{activeJob.error_message || 'Неизвестная ошибка'}</p>
              <button
                onClick={resetForm}
                className={clientMode
                  ? 'ds-btn-secondary inline-flex items-center gap-2'
                  : 'px-4 py-2 text-sm font-medium rounded-lg bg-gray-100 text-gray-700 hover:bg-gray-200 transition inline-flex items-center gap-2'}
              >
                <RotateCcw className="w-3.5 h-3.5" />
                Попробовать снова
              </button>
            </div>
          </div>
        )}

        {/* ═══════════ RESULTS ═══════════ */}
        {isComplete && activeJob && (
          <div className="space-y-4">
            {/* Stats — clientMode: editorial portfolio sentence (one headline +
                secondary metrics inline). Admin (/tools/our-bases): legacy 4-card
                grid preserved verbatim. */}
            {clientMode ? (
              <div className="neu-card p-5 space-y-2">
                <div className="flex items-baseline flex-wrap gap-x-2">
                  <span className="ds-mono tabular-nums text-3xl font-semibold text-[var(--cp-paper)]">
                    {activeJob.result_stats?.total_rows ?? 0}
                  </span>
                  <span className="text-sm text-[var(--cp-paper-mute)]">
                    строк из {activeJob.initial_row_count} обработано
                    {' '}
                    (<ClientTariffUsageInline
                      metric="max_rows"
                      spent={activeJob.initial_row_count}
                      remainingOnly
                      refreshKey={`${activeJob.id}:${activeJob.completed_at ?? activeJob.status}`}
                    />)
                  </span>
                </div>
                <p className="text-sm text-[var(--cp-paper-mute)]">
                  <span className="ds-mono tabular-nums font-semibold text-[var(--cp-green)]">
                    {activeJob.result_stats?.emails_found ?? 0}
                  </span>
                  {' email найдено'}
                  {(activeJob.result_stats?.avg_ta_score ?? 0) > 0 && (
                    <>
                      {' · средний ЦА '}
                      <span className="ds-mono tabular-nums font-semibold text-[var(--cp-paper)]">
                        {activeJob.result_stats?.avg_ta_score ?? 0}
                      </span>
                    </>
                  )}
                  {' · '}
                  <span className="ds-mono tabular-nums font-semibold text-[var(--cp-paper)]">
                    {activeJob.result_stats?.columns ?? 0}
                  </span>
                  {' колонок'}
                </p>
              </div>
            ) : (
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                <div className="bg-white rounded-2xl border border-gray-200 shadow-sm p-5">
                  <p className="text-xs font-medium text-gray-500 uppercase tracking-wide">Строк</p>
                  <p className="mt-2 text-2xl font-bold text-gray-900">
                    {activeJob.result_stats?.total_rows ?? 0}
                  </p>
                  <p className="text-xs text-gray-400 mt-0.5">
                    из {activeJob.initial_row_count}
                  </p>
                </div>
                <div className="bg-white rounded-2xl border border-gray-200 shadow-sm p-5">
                  <p className="text-xs font-medium text-gray-500 uppercase tracking-wide">Email найдено</p>
                  <p className="mt-2 text-2xl font-bold text-emerald-600">
                    {activeJob.result_stats?.emails_found ?? 0}
                  </p>
                </div>
                {(activeJob.result_stats?.avg_ta_score ?? 0) > 0 && (
                  <div className="bg-white rounded-2xl border border-gray-200 shadow-sm p-5">
                    <p className="text-xs font-medium text-gray-500 uppercase tracking-wide">Средний ЦА</p>
                    <p className="mt-2 text-2xl font-bold text-blue-600">
                      {activeJob.result_stats?.avg_ta_score ?? 0}
                    </p>
                  </div>
                )}
                <div className="bg-white rounded-2xl border border-gray-200 shadow-sm p-5">
                  <p className="text-xs font-medium text-gray-500 uppercase tracking-wide">Колонок</p>
                  <p className="mt-2 text-2xl font-bold text-gray-700">
                    {activeJob.result_stats?.columns ?? 0}
                  </p>
                </div>
              </div>
            )}

            {/* TA scoring telemetry — отдельным блоком, чтобы пользователь видел
                что AI оценил, какие средние, и сколько отфильтровалось */}
            {typeof activeJob.result_stats?.ta_scoring_pre_filter_rows === 'number' && (
              <div className={clientMode ? 'neu-card p-5' : 'bg-blue-50 rounded-2xl border border-blue-200 p-5'}>
                <p className={`text-sm font-semibold mb-2 ${clientMode ? 'text-[var(--cp-paper)]' : 'text-blue-900'}`}>Оценка ЦА — детали</p>
                <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 text-sm">
                  <div>
                    <p className={clientMode ? 'text-xs text-[var(--cp-paper-faint)]' : 'text-xs text-blue-700'}>AI оценил</p>
                    <p className={clientMode ? 'font-bold text-[var(--cp-paper)]' : 'font-bold text-blue-900'}>
                      {activeJob.result_stats.ta_scoring_pre_filter_rows} компаний
                    </p>
                  </div>
                  <div>
                    <p className={clientMode ? 'text-xs text-[var(--cp-paper-faint)]' : 'text-xs text-blue-700'}>Средний балл (до фильтра)</p>
                    <p className={clientMode ? 'font-bold text-[var(--cp-paper)]' : 'font-bold text-blue-900'}>
                      {activeJob.result_stats.ta_scoring_pre_filter_avg ?? 0}
                    </p>
                  </div>
                  <div>
                    <p className={clientMode ? 'text-xs text-[var(--cp-paper-faint)]' : 'text-xs text-blue-700'}>Отфильтровано (ниже 7)</p>
                    <p className={clientMode ? 'font-bold text-[var(--cp-paper)]' : 'font-bold text-blue-900'}>
                      {activeJob.result_stats.ta_scoring_filtered_out ?? 0}
                    </p>
                  </div>
                </div>
                {activeJob.result_stats.total_rows === 0 && (activeJob.result_stats.ta_scoring_filtered_out ?? 0) > 0 && (
                  <p className={clientMode ? 'mt-3 text-xs text-[var(--cp-paper-mute)]' : 'mt-3 text-xs text-blue-800'}>
                    Все компании AI оценил ниже 7 — это значит, что либо бриф не подходит к базе,
                    либо описаний компаний (шаг «Обогатить описаниями») мало для уверенной оценки.
                    Можно перезапустить с галкой «Сохранить все оценённые», чтобы получить файл со всеми
                    компаниями и их баллами и решить вручную.
                  </p>
                )}
              </div>
            )}

            {/* Actions */}
            <div className="flex items-center gap-3 flex-wrap">
              <button
                onClick={downloadCSV}
                disabled={downloading}
                className={clientMode
                  ? 'ds-btn-primary inline-flex items-center gap-2 px-4 disabled:opacity-40'
                  : 'px-4 py-2.5 text-sm font-medium rounded-xl bg-gray-900 text-white shadow-sm transition hover:bg-gray-800 disabled:bg-gray-300 inline-flex items-center gap-2'}
              >
                {downloading ? (
                  <span className="w-4 h-4 rounded-full border-2 border-white/40 border-t-transparent animate-spin" />
                ) : (
                  <Download className="w-4 h-4" />
                )}
                {downloading ? 'Готовим файл…' : 'Скачать CSV'}
              </button>
              {!clientMode && (
                <button
                  onClick={handleOpenInDatabases}
                  disabled={loadingFull}
                  className="px-4 py-2.5 text-sm font-medium rounded-xl bg-blue-600 text-white shadow-sm transition hover:bg-blue-700 disabled:bg-gray-300 inline-flex items-center gap-2"
                >
                  <ArrowRight className="w-4 h-4" />
                  {loadingFull ? 'Загрузка…' : 'Открыть в базах'}
                </button>
              )}
              <button
                onClick={resetForm}
                className={clientMode
                  ? 'ds-btn-secondary inline-flex items-center gap-2'
                  : 'px-4 py-2.5 text-sm font-medium rounded-xl bg-white text-gray-700 border border-gray-200 transition hover:bg-gray-50 inline-flex items-center gap-2'}
              >
                <RotateCcw className="w-4 h-4" />
                Новая обработка
              </button>
            </div>

            {/* Preview table */}
            {previewData && previewData.length > 1 && (
              <div className={clientMode ? 'neu-card overflow-hidden' : 'bg-white rounded-2xl border border-gray-200 shadow-sm overflow-hidden'}>
                <div className={clientMode ? 'px-6 py-4 border-b border-[var(--cp-divider)]' : 'px-6 py-4 border-b border-gray-100 bg-gray-50/50'}>
                  <h3 className={clientMode ? 'text-base font-semibold m-0 text-[var(--cp-paper)]' : 'text-base font-bold text-gray-900'}>
                    Результат <span className={clientMode ? 'text-[var(--cp-paper-faint)] font-normal text-sm' : 'text-gray-400 font-normal text-sm'}>(первые 20 строк)</span>
                  </h3>
                </div>
                <div className={clientMode ? 'overflow-auto max-h-[420px]' : 'overflow-x-auto'}>
                  <table className={clientMode ? 'min-w-full divide-y divide-gray-100 cp-dense-table' : 'min-w-full divide-y divide-gray-100 text-sm'}>
                    <thead className="bg-gray-50/50">
                      <tr>
                        {previewData[0].map((h, i) => (
                          <th key={i} className="px-3 py-2 text-left font-semibold text-gray-500 whitespace-nowrap">
                            {h}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-50">
                      {previewData.slice(1, 21).map((row, rIdx) => (
                        <tr key={rIdx} className="hover:bg-gray-50/50">
                          {row.map((cell, cIdx) => (
                            <td key={cIdx} className="px-3 py-2 text-gray-600 max-w-[200px] truncate" title={cell}>
                              {cell}
                            </td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
          </div>
        )}

        {/* ═══════════ HISTORY ═══════════ */}
        {/* Раньше история пряталась пока есть активная задача (`!isRunning`) —
            теперь юзеры могут держать в очереди до {MAX_ACTIVE_JOBS} баз и им
            нужно видеть весь список (включая «В очереди» и «В работе»),
            чтобы понимать, сколько свободных слотов осталось и какие
            файлы уже сданы. */}
        {history.length > 0 && (
          <div className={clientMode ? 'neu-card overflow-hidden' : 'bg-white rounded-2xl border border-gray-200 shadow-sm overflow-hidden'}>
            <div className={clientMode ? 'px-6 py-4 border-b border-[var(--cp-divider)] flex items-center justify-between' : 'px-6 py-4 border-b border-gray-100 bg-gray-50/50 flex items-center justify-between'}>
              <h3 className={clientMode ? 'text-base font-semibold m-0 text-[var(--cp-paper)]' : 'text-base font-bold text-gray-900'}>История</h3>
              {anyJobActive && (
                <span className={`text-xs ${clientMode ? 'text-[var(--cp-paper-mute)]' : 'text-gray-500'}`}>
                  Активных: {activeJobsCount} / {MAX_ACTIVE_JOBS}
                </span>
              )}
            </div>
            <div className="divide-y divide-gray-50">
              {history.map((j) => (
                <div
                  key={j.id}
                  className={clientMode
                    ? 'px-6 py-3 flex items-center justify-between cursor-pointer hover:bg-[var(--cp-surface-elev)] transition'
                    : 'px-6 py-3 flex items-center justify-between cursor-pointer hover:bg-gray-50/50 transition'}
                  onClick={() => {
                    setActiveJob(j);
                    if (j.status === 'completed') loadJobPreview(j.id);
                  }}
                >
                  <div className="flex items-center gap-3">
                    <div>
                      <span className={`text-sm font-medium ${clientMode ? 'text-[var(--cp-paper)]' : 'text-gray-900'}`}>
                        {j.file_name || 'Без имени'}
                      </span>
                      <span className={`text-xs ml-2 ${clientMode ? 'text-[var(--cp-paper-faint)]' : 'text-gray-400'}`}>{formatDate(j.created_at)}</span>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="text-xs text-gray-400">
                      {j.selected_steps?.length || 0} шагов
                    </span>
                    <span
                      className={`text-xs font-medium px-2 py-0.5 rounded-full ${
                        clientMode
                          ? `border border-[var(--cp-divider-strong)] ${
                              j.status === 'completed'
                                ? 'text-[var(--cp-green)]'
                                : j.status === 'failed'
                                  ? 'text-[var(--cp-red)]'
                                  : j.status === 'cancelled'
                                    ? 'text-[var(--cp-paper-faint)]'
                                    : 'text-[var(--cp-amber)]'
                            }`
                          : j.status === 'completed'
                            ? 'bg-emerald-50 text-emerald-700'
                            : j.status === 'failed'
                              ? 'bg-red-50 text-red-700'
                              : j.status === 'cancelled'
                                ? 'bg-gray-100 text-gray-500'
                                : 'bg-amber-50 text-amber-700'
                      }`}
                    >
                      {j.status === 'completed'
                        ? `${j.result_stats?.total_rows ?? 0} строк`
                        : j.status === 'failed'
                          ? 'Ошибка'
                          : j.status === 'cancelled'
                            ? 'Отменена'
                            : j.status === 'pending'
                              ? 'В очереди'
                              : 'В работе'}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
