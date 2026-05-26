'use client';

import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent } from 'react';
import Link from 'next/link';
import type { Route } from 'next';
import {
  Upload, Trash2, Plus, Send, AlertTriangle, CheckCircle2, Loader2, ExternalLink, Mail, Settings, FileText, X, Copy, Check, Info,
} from 'lucide-react';
import { clientApiFetch } from '@/lib/clientFetcher';
import { readSpreadsheetFile } from '@/lib/spreadsheet/parseCSV';
import { CLIENT_LAUNCH_ROW_LIMIT } from '@/lib/clientLaunch/constants';
import {
  CLIENT_LAUNCH_MAX_VARIANTS_PER_STEP,
  type ClientLaunchColumnMapping,
  type ClientLaunchScheduleOverride,
  type ClientLaunchSequenceStep,
  type ClientLaunchSequenceVariant,
} from '@/lib/clientLaunch/types';
import { INSTANTLY_TIMEZONE_OPTIONS, normalizeInstantlyTimezone } from '@/lib/clientLaunch/timezones';
import { ClientTariffUsageInline } from '@/components/client/ClientTariffUsageInline';
import { EmailBodyField } from '@/components/client/EmailBodyField';

interface PresetSummary {
  id: string;
  email_account_ids: string[];
  daily_limit: number;
  daily_max_leads: number;
  open_tracking: boolean;
  stop_on_reply: boolean;
  schedule_from: string;
  schedule_to: string;
  schedule_days: number[];
  schedule_timezone: string;
}

interface LaunchBehaviorSettings {
  open_tracking: boolean;
  stop_on_reply: boolean;
}

interface LaunchHistoryItem {
  id: string;
  campaign_name: string;
  instantly_campaign_id: string | null;
  status: 'uploading' | 'active' | 'paused' | 'failed' | 'completed';
  uploaded_rows: number;
  accepted_rows: number;
  skipped_rows: number;
  error_message: string | null;
  created_at: string;
}

interface LaunchResult {
  id: string;
  instantly_campaign_id: string | null;
  campaign_name: string;
  status: string;
  uploaded_rows: number;
  accepted_rows: number;
  skipped_rows: number;
}

/**
 * Persisted draft of the in-progress wizard (everything except the uploaded
 * file, which can't be programmatically restored). Saved to localStorage
 * with 500ms debounce on every state change; cleared on successful launch
 * or explicit «начать с нуля» action. Lets Olga survive a misclicked nav
 * or a tab refresh without losing 40 minutes of typing — the most
 * catastrophic failure mode flagged in /impeccable critique 2026-05-24.
 */
const DRAFT_KEY = 'client.launch.draft.v1';

interface DraftPayload {
  campaignName: string;
  sequenceSteps: ClientLaunchSequenceStep[];
  activeVariantIdx: number[];
  mapping: ClientLaunchColumnMapping;
  customVars: { key: string; header: string }[];
  schedule: ClientLaunchScheduleOverride;
  behavior: LaunchBehaviorSettings;
  /**
   * Subset of the preset's email_account_ids the client wants to use for
   * this campaign. Equal to full preset pool → "no override". Strict
   * subset → client picked specific mailboxes. Persisted in draft so
   * users don't lose their selection if they reload mid-flow.
   */
  selectedEmailAccountIds?: string[];
  savedAt: string;
}

// Стандартные плейсхолдеры в Instantly v2 используют camelCase, а НЕ
// snake_case (Instantly hr: см. их доки, пример subject: "Hello {{firstName}}").
// Раньше мы показывали клиенту `{{first_name}}` и `{{company_name}}` — клиент
// копировал их в body, при отправке Instantly не находил совпадения и
// плейсхолдер уходил литералом в письмо. Снизу в mapRowsToLeads мы также
// дублируем значение в custom_variables со snake_case ключом — это
// «лечит» уже запущенные кампании, где body набирался по старому чипу
// (новые лиды смогут подставиться в `{{company_name}}` через custom_var).
const STANDARD_FIELDS: { key: keyof Omit<ClientLaunchColumnMapping, 'custom_variables_mapping'>; label: string; required?: boolean; variable: string }[] = [
  { key: 'email', label: 'Email', required: true, variable: 'email' },
  { key: 'first_name', label: 'Имя', variable: 'firstName' },
  { key: 'last_name', label: 'Фамилия', variable: 'lastName' },
  { key: 'company_name', label: 'Компания', variable: 'companyName' },
  { key: 'website', label: 'Сайт', variable: 'website' },
  { key: 'phone', label: 'Телефон', variable: 'phone' },
];

const PREVIEW_ROW_COUNT = 3;

const WEEKDAYS: { value: number; label: string }[] = [
  { value: 1, label: 'Пн' },
  { value: 2, label: 'Вт' },
  { value: 3, label: 'Ср' },
  { value: 4, label: 'Чт' },
  { value: 5, label: 'Пт' },
  { value: 6, label: 'Сб' },
  { value: 0, label: 'Вс' },
];

function autoDetectMapping(headers: string[]): ClientLaunchColumnMapping {
  const lower = headers.map((h) => h.trim().toLowerCase());
  const find = (aliases: string[]): string | undefined => {
    for (const a of aliases) {
      const idx = lower.indexOf(a);
      if (idx >= 0) return headers[idx];
    }
    for (const a of aliases) {
      const idx = lower.findIndex((h) => h.includes(a));
      if (idx >= 0) return headers[idx];
    }
    return undefined;
  };
  return {
    email: find(['email', 'e-mail', 'почта', 'mail']) || '',
    first_name: find(['first_name', 'firstname', 'first name', 'имя', 'name']),
    last_name: find(['last_name', 'lastname', 'last name', 'фамилия', 'surname']),
    company_name: find(['company', 'company_name', 'organization', 'компания', 'организация']),
    website: find(['website', 'site', 'url', 'сайт', 'веб', 'домен']),
    phone: find(['phone', 'телефон', 'mobile', 'tel']),
  };
}

const STATUS_LABELS: Record<LaunchHistoryItem['status'], string> = {
  uploading: 'Загрузка',
  active: 'Активна',
  paused: 'Пауза',
  completed: 'Завершена',
  failed: 'Ошибка',
};

// Semantic dot per launch status. Same vocabulary as campaigns list and
// projects: amber = transient/needs-attention, paper-faint = neutral/done,
// green = active flow, red = failure.
const STATUS_DOT: Record<LaunchHistoryItem['status'], string> = {
  uploading: 'var(--cp-amber)',
  active: 'var(--cp-green)',
  paused: 'var(--cp-amber)',
  completed: 'var(--cp-paper-faint)',
  failed: 'var(--cp-red)',
};

function formatDate(iso: string) {
  return new Date(iso).toLocaleString('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}

// Shared header: small editorial eyebrow + plain h1. Replaces the four
// duplicated 'tinted-iconbox + extrabold h1' instances at the top of the
// file.
function LaunchHeader({ title, eyebrow = 'Запуск' }: { title: string; eyebrow?: string }) {
  return (
    <header className="mb-6 sm:mb-8">
      <p className="ds-eyebrow mb-2">
        01<span aria-hidden> → </span>{eyebrow}
      </p>
      <h1
        className="text-xl sm:text-2xl font-bold m-0"
        style={{ color: 'var(--cp-paper)' }}
      >
        {title}
      </h1>
    </header>
  );
}

export default function ClientLaunchPage() {
  const [presetLoading, setPresetLoading] = useState(true);
  const [preset, setPreset] = useState<PresetSummary | null>(null);
  const [presetError, setPresetError] = useState('');

  const [history, setHistory] = useState<LaunchHistoryItem[]>([]);
  const [historyLoading, setHistoryLoading] = useState(true);

  // Wizard state
  const [fileName, setFileName] = useState('');
  const [fileHeaders, setFileHeaders] = useState<string[]>([]);
  const [fileRows, setFileRows] = useState<string[][]>([]);
  const [parseError, setParseError] = useState('');
  const [parsing, setParsing] = useState(false);
  const [isDragOver, setIsDragOver] = useState(false);

  const [mapping, setMapping] = useState<ClientLaunchColumnMapping>({ email: '' });
  const [customVars, setCustomVars] = useState<{ key: string; header: string }[]>([]);

  const [campaignName, setCampaignName] = useState('');
  const [sequenceSteps, setSequenceSteps] = useState<ClientLaunchSequenceStep[]>([
    { subject: '', body: '', wait_days: 0 },
  ]);
  /** Active variant index per step. 0 = main step (Variant A), 1 = variants[0] (B), 2 = variants[1] (C). */
  const [activeVariantIdx, setActiveVariantIdx] = useState<number[]>([0]);

  // Schedule state — initialized from preset on load, editable per launch.
  const [schedule, setSchedule] = useState<ClientLaunchScheduleOverride>({
    from: '09:00',
    to: '18:00',
    days: [1, 2, 3, 4, 5],
    timezone: 'Europe/Kirov',
  });
  const [scheduleHydrated, setScheduleHydrated] = useState(false);
  const [behavior, setBehavior] = useState<LaunchBehaviorSettings>({
    open_tracking: true,
    stop_on_reply: true,
  });
  // Per-launch mailbox selection. NULL = «not yet hydrated from preset».
  // Once preset loads we initialize this to the FULL preset pool (default
  // behavior: send from all configured mailboxes). Client can untick
  // individual mailboxes to run a campaign on a hand-picked subset.
  const [selectedEmailAccountIds, setSelectedEmailAccountIds] = useState<string[] | null>(null);

  const [launching, setLaunching] = useState(false);
  const [launchError, setLaunchError] = useState('');
  const [result, setResult] = useState<LaunchResult | null>(null);

  const fileInputRef = useRef<HTMLInputElement>(null);

  // ─── Draft persistence (localStorage) ──────────────────────────────────
  // See DRAFT_KEY comment above for rationale.
  const [draftSavedAt, setDraftSavedAt] = useState<Date | null>(null);
  const [draftRestored, setDraftRestored] = useState(false);

  // Restore once on mount. Bad JSON / sandbox / no storage → silent skip.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(DRAFT_KEY);
      if (!raw) return;
      const draft = JSON.parse(raw) as Partial<DraftPayload> | null;
      if (!draft || typeof draft !== 'object') return;
      if (typeof draft.campaignName === 'string') setCampaignName(draft.campaignName);
      if (Array.isArray(draft.sequenceSteps) && draft.sequenceSteps.length > 0) {
        setSequenceSteps(draft.sequenceSteps);
      }
      if (Array.isArray(draft.activeVariantIdx)) setActiveVariantIdx(draft.activeVariantIdx);
      if (draft.mapping && typeof draft.mapping === 'object') setMapping(draft.mapping);
      if (Array.isArray(draft.customVars)) setCustomVars(draft.customVars);
      if (draft.schedule && typeof draft.schedule === 'object') setSchedule(draft.schedule);
      if (draft.behavior && typeof draft.behavior === 'object') setBehavior(draft.behavior);
      if (Array.isArray(draft.selectedEmailAccountIds)) {
        setSelectedEmailAccountIds(draft.selectedEmailAccountIds);
      }
      if (typeof draft.savedAt === 'string') {
        const d = new Date(draft.savedAt);
        if (!Number.isNaN(d.getTime())) setDraftSavedAt(d);
      }
      setDraftRestored(true);
    } catch {
      // bad JSON / sandbox / no storage — silent skip
    }
  }, []);

  // Debounced save on any tracked state change. Skip when state is the empty
  // default (no point in writing «empty draft» entries every mount).
  useEffect(() => {
    const isEmpty =
      !campaignName.trim() &&
      sequenceSteps.length === 1 &&
      !sequenceSteps[0].subject &&
      !sequenceSteps[0].body &&
      customVars.length === 0;
    if (isEmpty) return;
    const t = setTimeout(() => {
      try {
        const payload: DraftPayload = {
          campaignName,
          sequenceSteps,
          activeVariantIdx,
          mapping,
          customVars,
          schedule,
          behavior,
          ...(selectedEmailAccountIds !== null ? { selectedEmailAccountIds } : {}),
          savedAt: new Date().toISOString(),
        };
        window.localStorage.setItem(DRAFT_KEY, JSON.stringify(payload));
        setDraftSavedAt(new Date());
        // After first save, the draft is no longer "восстановленный" — it's a
        // fresh save. Flip the flag so microcopy switches from «восстановлен
        // черновик от HH:MM» to plain «черновик сохранён HH:MM» (re-critique
        // 2026-05-24 N3). File-gone hint stays — it's data-driven, not based
        // on this flag.
        setDraftRestored(false);
      } catch {
        // sandbox / quota / no storage — silent
      }
    }, 500);
    return () => clearTimeout(t);
  }, [campaignName, sequenceSteps, activeVariantIdx, mapping, customVars, schedule, behavior, selectedEmailAccountIds]);

  // Clear draft on successful launch.
  useEffect(() => {
    if (!result) return;
    try {
      window.localStorage.removeItem(DRAFT_KEY);
    } catch { /* ignore */ }
    setDraftSavedAt(null);
    setDraftRestored(false);
  }, [result]);

  // beforeunload guard while a draft is dirty — avoid silent loss to nav.
  useEffect(() => {
    const hasDirtyDraft =
      !!campaignName.trim() ||
      sequenceSteps.some((s) => s.subject || s.body) ||
      customVars.length > 0;
    if (!hasDirtyDraft || result) return;
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [campaignName, sequenceSteps, customVars, result]);

  // ─── Load preset + history ───────────────────────────────────────────────
  const loadPreset = useCallback(async () => {
    setPresetLoading(true);
    setPresetError('');
    try {
      const data = await clientApiFetch<{ preset: PresetSummary | null }>('/preset');
      setPreset(data.preset);
    } catch (err) {
      setPresetError(err instanceof Error ? err.message : 'Не удалось загрузить пресет');
    } finally {
      setPresetLoading(false);
    }
  }, []);

  // Hydrate schedule + behavior from preset on first load — but ONLY when
  // there's no restored draft to honor. Otherwise we'd silently clobber
  // Olga's custom schedule/behavior with preset defaults: race surfaced by
  // /impeccable re-critique 2026-05-24 (N1). Draft always wins on restore.
  useEffect(() => {
    if (!preset) return;
    if (draftRestored) return; // draft already populated schedule/behavior — keep them
    setSchedule({
      from: preset.schedule_from || '09:00',
      to: preset.schedule_to || '18:00',
      days: Array.isArray(preset.schedule_days) && preset.schedule_days.length > 0
        ? preset.schedule_days
        : [1, 2, 3, 4, 5],
      timezone: normalizeInstantlyTimezone(preset.schedule_timezone || 'Europe/Kirov'),
    });
    setBehavior({
      open_tracking: preset.open_tracking !== false,
      stop_on_reply: preset.stop_on_reply !== false,
    });
    // Default mailbox selection: all preset mailboxes. Same draft-wins
    // policy — if a draft already hydrated this state, leave it alone.
    setSelectedEmailAccountIds([...preset.email_account_ids]);
    setScheduleHydrated(true);
  }, [preset, draftRestored]);

  // If the preset's mailbox pool changes (e.g. admin removed a mailbox)
  // while client has already selected a subset, prune the selection to
  // stay a valid subset. Without this, runLaunch would reject the launch
  // with «не из вашего пресета» and the client wouldn't understand why.
  useEffect(() => {
    if (!preset) return;
    if (selectedEmailAccountIds === null) return;
    const pool = new Set(preset.email_account_ids);
    const pruned = selectedEmailAccountIds.filter((id) => pool.has(id));
    if (pruned.length !== selectedEmailAccountIds.length) {
      setSelectedEmailAccountIds(pruned);
    }
  }, [preset, selectedEmailAccountIds]);

  const loadHistory = useCallback(async () => {
    setHistoryLoading(true);
    try {
      const data = await clientApiFetch<{ launches: LaunchHistoryItem[] }>('/launches');
      setHistory(data.launches ?? []);
    } catch {
      setHistory([]);
    } finally {
      setHistoryLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadPreset();
    void loadHistory();
  }, [loadPreset, loadHistory]);

  // ─── File upload ────────────────────────────────────────────────────────
  async function handleFile(file: File) {
    setParsing(true);
    setParseError('');
    setFileName(file.name);
    try {
      const rows = await readSpreadsheetFile(file);
      if (rows.length < 2) {
        setParseError('Файл пустой или содержит только заголовок');
        return;
      }
      const dataRows = rows.slice(1);
      if (dataRows.length > CLIENT_LAUNCH_ROW_LIMIT) {
        setParseError(
          `Лимит ${CLIENT_LAUNCH_ROW_LIMIT.toLocaleString('ru-RU')} строк. В файле ${dataRows.length.toLocaleString('ru-RU')} строк.`,
        );
        return;
      }
      const headers = rows[0].map((h) => String(h ?? '').trim());
      setFileHeaders(headers);
      setFileRows(dataRows.map((r) => r.map((c) => String(c ?? ''))));
      setMapping(autoDetectMapping(headers));
      if (!campaignName) {
        const stem = file.name.replace(/\.[^.]+$/, '');
        setCampaignName(stem);
      }
    } catch (err) {
      setParseError(err instanceof Error ? err.message : 'Ошибка при чтении файла');
    } finally {
      setParsing(false);
    }
  }

  function handleDragOver(e: DragEvent) {
    e.preventDefault();
    setIsDragOver(true);
  }
  function handleDragLeave() { setIsDragOver(false); }
  function handleDrop(e: DragEvent) {
    e.preventDefault();
    setIsDragOver(false);
    const file = e.dataTransfer.files[0];
    if (file) void handleFile(file);
  }

  function clearFile() {
    setFileName('');
    setFileHeaders([]);
    setFileRows([]);
    setMapping({ email: '' });
    setCustomVars([]);
    setParseError('');
    if (fileInputRef.current) fileInputRef.current.value = '';
  }

  // ─── Sequence editor ────────────────────────────────────────────────────
  function addStep() {
    setSequenceSteps((prev) => [...prev, { subject: '', body: '', wait_days: 3 }]);
    setActiveVariantIdx((prev) => [...prev, 0]);
  }
  function removeStep(idx: number) {
    setSequenceSteps((prev) => prev.length > 1 ? prev.filter((_, i) => i !== idx) : prev);
    setActiveVariantIdx((prev) => prev.length > 1 ? prev.filter((_, i) => i !== idx) : prev);
  }
  function updateStep(idx: number, patch: Partial<ClientLaunchSequenceStep>) {
    setSequenceSteps((prev) => prev.map((s, i) => i === idx ? { ...s, ...patch } : s));
  }

  /** Update the currently active variant (Variant A = main step, B/C = variants[]). */
  function updateActiveVariant(stepIdx: number, patch: Partial<ClientLaunchSequenceVariant>) {
    const vIdx = activeVariantIdx[stepIdx] ?? 0;
    setSequenceSteps((prev) => prev.map((s, i) => {
      if (i !== stepIdx) return s;
      if (vIdx === 0) {
        return { ...s, ...patch };
      }
      const variants = [...(s.variants ?? [])];
      variants[vIdx - 1] = { ...variants[vIdx - 1], ...patch };
      return { ...s, variants };
    }));
  }

  function addVariant(stepIdx: number) {
    let newActiveIdx = 0;
    setSequenceSteps((prev) => prev.map((s, i) => {
      if (i !== stepIdx) return s;
      const current = s.variants ?? [];
      if (1 + current.length >= CLIENT_LAUNCH_MAX_VARIANTS_PER_STEP) {
        newActiveIdx = current.length;
        return s;
      }
      newActiveIdx = current.length + 1;
      return { ...s, variants: [...current, { subject: s.subject, body: '' }] };
    }));
    setActiveVariantIdx((prev) => prev.map((v, i) => i === stepIdx ? newActiveIdx : v));
  }

  function removeVariant(stepIdx: number, variantIdx: number) {
    setSequenceSteps((prev) => prev.map((s, i) => {
      if (i !== stepIdx) return s;
      const variants = [...(s.variants ?? [])];
      variants.splice(variantIdx, 1);
      return { ...s, variants: variants.length > 0 ? variants : undefined };
    }));
    setActiveVariantIdx((prev) => prev.map((v, i) => i === stepIdx ? 0 : v));
  }

  function setActiveVariant(stepIdx: number, vIdx: number) {
    setActiveVariantIdx((prev) => prev.map((v, i) => i === stepIdx ? vIdx : v));
  }

  // ─── Custom variables ───────────────────────────────────────────────────
  function addCustomVar() {
    setCustomVars((prev) => [...prev, { key: '', header: '' }]);
  }
  function updateCustomVar(idx: number, patch: Partial<{ key: string; header: string }>) {
    setCustomVars((prev) => prev.map((v, i) => i === idx ? { ...v, ...patch } : v));
  }
  function removeCustomVar(idx: number) {
    setCustomVars((prev) => prev.filter((_, i) => i !== idx));
  }

  // ─── Launch ─────────────────────────────────────────────────────────────
  const validLeadsCount = useMemo(() => {
    if (!mapping.email) return 0;
    const idx = fileHeaders.indexOf(mapping.email);
    if (idx < 0) return 0;
    return fileRows.filter((r) => {
      const e = (r[idx] ?? '').trim();
      return e && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);
    }).length;
  }, [fileRows, fileHeaders, mapping.email]);

  async function handleLaunch() {
    setLaunchError('');

    if (!preset) {
      setLaunchError('Пресет не настроен');
      return;
    }
    if (!fileRows.length) {
      setLaunchError('Загрузите файл');
      return;
    }
    if (!mapping.email) {
      setLaunchError('Сопоставьте колонку с email');
      return;
    }
    if (!campaignName.trim()) {
      setLaunchError('Укажите название кампании');
      return;
    }
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(schedule.from) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(schedule.to)) {
      setLaunchError('Расписание: некорректное время (используйте формат ЧЧ:ММ)');
      return;
    }
    if (schedule.from >= schedule.to) {
      setLaunchError('Расписание: время окончания должно быть позже времени начала');
      return;
    }
    if (!schedule.days || schedule.days.length === 0) {
      setLaunchError('Расписание: выберите хотя бы один день недели');
      return;
    }
    if (
      preset &&
      selectedEmailAccountIds !== null &&
      selectedEmailAccountIds.length === 0
    ) {
      setLaunchError('Почты отправки: выберите хотя бы один ящик из пула пресета');
      return;
    }
    for (let i = 0; i < sequenceSteps.length; i++) {
      const s = sequenceSteps[i];
      const isFirst = i === 0;
      if (isFirst && !s.subject.trim()) { setLaunchError(`Шаг ${i + 1}: укажите тему`); return; }
      if (!s.body.trim()) { setLaunchError(`Шаг ${i + 1}: укажите текст`); return; }
      if (s.variants && s.variants.length > 0) {
        for (let v = 0; v < s.variants.length; v++) {
          const variant = s.variants[v];
          const letter = String.fromCharCode(66 + v);
          if (isFirst && !(variant.subject ?? '').trim()) {
            setLaunchError(`Шаг ${i + 1}, вариант ${letter}: укажите тему`); return;
          }
          if (!variant.body.trim()) {
            setLaunchError(`Шаг ${i + 1}, вариант ${letter}: укажите текст`); return;
          }
        }
      }
    }

    const customMap: Record<string, string> = {};
    for (const cv of customVars) {
      const key = cv.key.trim().replace(/[^a-zA-Z0-9_]/g, '_');
      if (key && cv.header) customMap[key] = cv.header;
    }
    const finalMapping: ClientLaunchColumnMapping = {
      ...mapping,
      ...(Object.keys(customMap).length > 0 ? { custom_variables_mapping: customMap } : {}),
    };

    setLaunching(true);
    try {
      // Send `email_account_ids` only if the client picked a STRICT subset.
      // If they kept the default (all mailboxes from the preset) we omit the
      // field so the launch row stores NULL → semantic «track the full preset
      // pool», not a frozen snapshot of today's pool.
      const isExplicitSubset =
        preset !== null &&
        selectedEmailAccountIds !== null &&
        selectedEmailAccountIds.length > 0 &&
        selectedEmailAccountIds.length < preset.email_account_ids.length;
      const data = await clientApiFetch<{ launch: LaunchResult }>('/launches', {
        method: 'POST',
        body: JSON.stringify({
          campaign_name: campaignName.trim(),
          sequence_steps: sequenceSteps,
          mapping: finalMapping,
          headers: fileHeaders,
          rows: fileRows,
          schedule,
          behavior,
          ...(isExplicitSubset ? { email_account_ids: selectedEmailAccountIds } : {}),
        }),
      });
      setResult(data.launch);
      void loadHistory();
    } catch (err) {
      setLaunchError(err instanceof Error ? err.message : 'Не удалось запустить кампанию');
    } finally {
      setLaunching(false);
    }
  }

  function startNewLaunch() {
    clearFile();
    setCampaignName('');
    setSequenceSteps([{ subject: '', body: '', wait_days: 0 }]);
    setActiveVariantIdx([0]);
    setLaunchError('');
    setResult(null);
    // Also wipe any persisted draft — an explicit "start fresh" wins over
    // any saved draft from a prior session.
    setDraftSavedAt(null);
    setDraftRestored(false);
    try {
      window.localStorage.removeItem(DRAFT_KEY);
    } catch { /* ignore */ }
  }

  // ─── Render: preset gate ───────────────────────────────────────────────
  if (presetLoading) {
    return (
      <div className="mx-auto max-w-5xl">
        <div className="flex items-center justify-center py-32">
          <div className="neu-spinner animate-spin" />
        </div>
      </div>
    );
  }

  if (presetError) {
    return (
      <div className="mx-auto max-w-5xl">
        <LaunchHeader title="Запуск кампаний" />
        <div
          className="neu-inset rounded-lg px-5 py-4 text-sm font-medium flex items-start gap-2.5"
          role="alert"
        >
          <span
            aria-hidden
            className="ds-status-dot shrink-0"
            style={{ background: 'var(--cp-red)', marginTop: '7px' }}
          />
          <span style={{ color: 'var(--cp-paper)' }}>{presetError}</span>
        </div>
      </div>
    );
  }

  if (!preset || preset.email_account_ids.length === 0) {
    return (
      <div className="mx-auto max-w-5xl">
        <LaunchHeader title="Создать кампанию" />
        <div className="neu-card py-12 sm:py-16 text-center px-6">
          <Settings
            className="mx-auto h-8 w-8 mb-3"
            style={{ color: 'var(--cp-paper-faint)' }}
            aria-hidden
          />
          <p
            className="text-sm sm:text-base font-semibold mb-2"
            style={{ color: 'var(--cp-paper)' }}
          >
            Пресет ещё не настроен
          </p>
          <p
            className="text-xs sm:text-sm max-w-md mx-auto"
            style={{ color: 'var(--cp-paper-mute)' }}
          >
            Прежде чем вы запустите первую кампанию, ваш менеджер должен привязать
            к аккаунту email-почты для рассылки и общее расписание. Это разовая настройка.
          </p>
          <Link
            href={'/client/support' as Route}
            className="ds-btn-primary inline-flex items-center gap-2 px-5 mt-5"
          >
            <Mail className="h-4 w-4" aria-hidden />
            Связаться с менеджером
          </Link>
        </div>
      </div>
    );
  }

  // ─── Render: result screen ─────────────────────────────────────────────
  if (result) {
    return (
      <div className="mx-auto max-w-3xl">
        <LaunchHeader title="Кампания запущена" eyebrow="Готово" />
        <div className="neu-card p-8 sm:p-10 text-center">
          <CheckCircle2
            className="mx-auto h-10 w-10 mb-4"
            style={{ color: 'var(--cp-green)' }}
            aria-hidden
          />
          <h2
            className="text-lg sm:text-xl font-bold mb-2 m-0"
            style={{ color: 'var(--cp-paper)' }}
          >
            {result.campaign_name}
          </h2>
          <p
            className="ds-mono text-sm mb-6"
            style={{ color: 'var(--cp-paper-mute)' }}
          >
            {result.accepted_rows.toLocaleString('ru-RU')} лидов загружено
            {result.skipped_rows > 0 && ` · пропущено ${result.skipped_rows.toLocaleString('ru-RU')}`}
            <span className="block mt-1">
              <ClientTariffUsageInline
                metric="max_contacts"
                spent={result.accepted_rows}
                unit="контактов"
                refreshKey={result.id}
              />
            </span>
          </p>
          <div className="flex flex-col sm:flex-row gap-3 justify-center">
            {result.instantly_campaign_id && (
              <Link
                href={`/client/campaigns/${result.instantly_campaign_id}`}
                className="ds-btn-primary px-6 py-3 text-sm inline-flex items-center justify-center gap-2"
              >
                Перейти к кампании <ExternalLink className="h-4 w-4" aria-hidden />
              </Link>
            )}
            <button
              type="button"
              onClick={startNewLaunch}
              className="ds-btn-secondary px-6 py-3 text-sm"
            >
              Запустить ещё одну
            </button>
          </div>
        </div>
      </div>
    );
  }

  // ─── Render: wizard ────────────────────────────────────────────────────
  return (
    <div className="mx-auto max-w-5xl">
      <header className="mb-6 sm:mb-8 flex items-start justify-between gap-4 flex-wrap">
        <div>
          <p className="ds-eyebrow mb-2">
            01<span aria-hidden> → </span>Запуск
          </p>
          <h1
            className="text-xl sm:text-2xl font-bold m-0"
            style={{ color: 'var(--cp-paper)' }}
          >
            Запуск кампаний
          </h1>
          <p className="mt-1 text-xs sm:text-sm" style={{ color: 'var(--cp-paper-mute)' }}>
            Загрузите базу, напишите цепочку и запустите
          </p>
          {draftSavedAt && (
            <p className="mt-1 text-xs ds-mono" style={{ color: 'var(--cp-paper-faint)' }}>
              {draftRestored ? 'восстановлен черновик от ' : 'черновик сохранён '}
              {draftSavedAt.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })}
              {draftRestored && (
                <>
                  {' · '}
                  <button
                    type="button"
                    onClick={startNewLaunch}
                    className="underline"
                    style={{ color: 'var(--cp-paper)' }}
                  >
                    начать с нуля
                  </button>
                </>
              )}
            </p>
          )}
          {/* File-gone hint: when draft state references a file (mapping or
              sequence content) but no file is loaded, we're almost certainly
              post-restore — Step 2+ of the wizard gate on fileHeaders.length,
              so a fresh user can't reach mapping/sequence without uploading
              first. Data-driven, not based on draftRestored flag (which gets
              cleared after first save per N3 fix). Amber = action needed. */}
          {fileRows.length === 0 && (
            mapping.email !== ''
            || customVars.length > 0
            || sequenceSteps.some((s) => s.subject || s.body)
          ) && (
            <p className="mt-1 text-xs" style={{ color: 'var(--cp-amber)' }}>
              Файл базы нужно загрузить заново — браузеры не сохраняют файлы между сессиями. Цепочка, колонки и расписание восстановлены.
            </p>
          )}
        </div>
        <PresetBadge preset={preset} />
      </header>

      <div className="space-y-5 sm:space-y-6">
        {/* Step 1: Upload */}
        <Section number={1} title="Загрузите базу контактов" subtitle={`До ${CLIENT_LAUNCH_ROW_LIMIT.toLocaleString('ru-RU')} строк, форматы: CSV, XLSX`}>
          {fileRows.length === 0 ? (
            <label
              onDragOver={handleDragOver}
              onDragLeave={handleDragLeave}
              onDrop={handleDrop}
              className="rounded-md flex flex-col items-center justify-center cursor-pointer p-8 sm:p-10 transition-all"
              style={{
                background: 'var(--cp-surface-rest)',
                border: isDragOver
                  ? '1px solid var(--cp-paper)'
                  : '1px solid var(--cp-divider)',
              }}
            >
              {parsing ? (
                <Loader2
                  className="h-8 w-8 animate-spin"
                  style={{ color: 'var(--cp-paper)' }}
                  aria-hidden
                />
              ) : (
                <>
                  <Upload
                    className="h-8 w-8 mb-3"
                    style={{ color: 'var(--cp-paper-faint)' }}
                    aria-hidden
                  />
                  <p
                    className="text-sm font-semibold mb-1"
                    style={{ color: 'var(--cp-paper)' }}
                  >
                    Перетащите файл или нажмите
                  </p>
                  <p
                    className="ds-mono text-xs"
                    style={{ color: 'var(--cp-paper-faint)' }}
                  >
                    .csv .xlsx .xls .tsv
                  </p>
                </>
              )}
              <input
                ref={fileInputRef}
                type="file"
                accept=".csv,.tsv,.xlsx,.xls,.txt"
                className="hidden"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) void handleFile(file);
                  e.target.value = '';
                }}
              />
            </label>
          ) : (
            <>
              <div
                className="rounded-md px-4 sm:px-5 py-3.5 flex items-center gap-3"
                style={{
                  background: 'var(--cp-surface-rest)',
                  border: '1px solid var(--cp-divider)',
                }}
              >
                <FileText
                  className="h-5 w-5 shrink-0"
                  style={{ color: 'var(--cp-paper-faint)' }}
                  aria-hidden
                />
                <div className="min-w-0 flex-1">
                  <p
                    className="text-sm font-semibold truncate m-0"
                    style={{ color: 'var(--cp-paper)' }}
                  >
                    {fileName}
                  </p>
                  <p
                    className="ds-mono text-xs"
                    style={{ color: 'var(--cp-paper-mute)' }}
                  >
                    {fileRows.length.toLocaleString('ru-RU')} строк · {fileHeaders.length} колонок · валидных email: {validLeadsCount.toLocaleString('ru-RU')}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={clearFile}
                  className="ds-btn-ghost p-2"
                  aria-label="Удалить файл"
                >
                  <X className="h-4 w-4" aria-hidden />
                </button>
              </div>
              <BasePreview headers={fileHeaders} rows={fileRows.slice(0, PREVIEW_ROW_COUNT)} />
            </>
          )}
          {parseError && (
            <div className="mt-3 text-xs flex items-start gap-2.5">
              <span
                aria-hidden
                className="ds-status-dot shrink-0"
                style={{ background: 'var(--cp-red)', marginTop: '5px' }}
              />
              <span style={{ color: 'var(--cp-paper)' }}>{parseError}</span>
            </div>
          )}
        </Section>

        {/* Step 2: Mapping */}
        {fileHeaders.length > 0 && (
          <Section number={2} title="Сопоставьте колонки" subtitle="Email обязателен. Остальное — опционально, можно добавлять переменные.">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              {STANDARD_FIELDS.map((field) => (
                <MappingRow
                  key={field.key}
                  label={field.label}
                  required={field.required}
                  headers={fileHeaders}
                  value={mapping[field.key] ?? ''}
                  variable={field.variable}
                  onChange={(v) => setMapping({ ...mapping, [field.key]: v })}
                />
              ))}
            </div>

            <div
              className="mt-5 pt-5"
              style={{ borderTop: '1px solid var(--cp-divider)' }}
            >
              <div className="flex items-center justify-between mb-3">
                <p className="ds-eyebrow">кастомные переменные</p>
                <button
                  type="button"
                  onClick={addCustomVar}
                  className="ds-btn-ghost inline-flex items-center gap-1 px-3 py-1.5 text-xs"
                >
                  <Plus className="h-3 w-3" aria-hidden /> Добавить
                </button>
              </div>
              {customVars.length === 0 ? (
                <p className="text-xs" style={{ color: 'var(--cp-paper-faint)' }}>
                  Пример: переменная <code className="ds-mono">company_size</code> → колонка «Размер компании», в шаблоне используйте <code className="ds-mono">{'{{company_size}}'}</code>
                </p>
              ) : (
                <div className="space-y-2">
                  {customVars.map((cv, idx) => (
                    <div key={idx} className="flex gap-2 items-center">
                      <span
                        className="ds-mono text-xs shrink-0"
                        style={{ color: 'var(--cp-paper-faint)' }}
                      >
                        {'{{'}
                      </span>
                      <input
                        type="text"
                        value={cv.key}
                        onChange={(e) => updateCustomVar(idx, { key: e.target.value })}
                        placeholder="ключ"
                        className="ds-input ds-mono flex-1 text-xs"
                      />
                      <span
                        className="ds-mono text-xs shrink-0"
                        style={{ color: 'var(--cp-paper-faint)' }}
                      >
                        {'}}'}
                      </span>
                      <span
                        className="ds-mono text-xs shrink-0"
                        style={{ color: 'var(--cp-paper-faint)' }}
                      >
                        =
                      </span>
                      <select
                        value={cv.header}
                        onChange={(e) => updateCustomVar(idx, { header: e.target.value })}
                        className="ds-input flex-1 text-xs"
                      >
                        <option value="">Колонка…</option>
                        {fileHeaders.map((h) => <option key={h} value={h}>{h}</option>)}
                      </select>
                      <button
                        type="button"
                        onClick={() => removeCustomVar(idx)}
                        className="ds-btn-ghost p-1.5 shrink-0"
                        aria-label="Удалить переменную"
                      >
                        <Trash2 className="h-3.5 w-3.5" aria-hidden />
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </Section>
        )}

        {/* Step 3: Sequence */}
        {fileHeaders.length > 0 && (
          <Section number={3} title="Цепочка писем" subtitle="Используйте переменные ниже, чтобы персонализировать сообщения.">
            <VariableReference
              mapping={mapping}
              customVars={customVars}
              fileHeaders={fileHeaders}
              firstRow={fileRows[0]}
            />

            <div className="mb-4">
              <label className="ds-eyebrow block mb-2">название кампании</label>
              <input
                type="text"
                value={campaignName}
                onChange={(e) => setCampaignName(e.target.value)}
                placeholder="Например: Q2 Outreach IT-компании"
                className="ds-input w-full text-sm"
              />
            </div>

            <div className="space-y-4">
              {sequenceSteps.map((step, idx) => (
                <SequenceStepEditor
                  key={idx}
                  stepIdx={idx}
                  step={step}
                  isFirstStep={idx === 0}
                  canRemove={sequenceSteps.length > 1}
                  activeVariant={activeVariantIdx[idx] ?? 0}
                  onSetActiveVariant={(v) => setActiveVariant(idx, v)}
                  onUpdateActive={(patch) => updateActiveVariant(idx, patch)}
                  onUpdateStep={(patch) => updateStep(idx, patch)}
                  onRemoveStep={() => removeStep(idx)}
                  onAddVariant={() => addVariant(idx)}
                  onRemoveVariant={(vIdx) => removeVariant(idx, vIdx)}
                />
              ))}
              <button
                type="button"
                onClick={addStep}
                className="ds-btn-secondary w-full py-3 text-sm inline-flex items-center justify-center gap-2"
              >
                <Plus className="h-4 w-4" aria-hidden /> Добавить шаг
              </button>
            </div>
          </Section>
        )}

        {/* Step 4: Schedule */}
        {fileHeaders.length > 0 && (
          <Section number={4} title="Расписание" subtitle="Когда Instantly будет отправлять письма. По умолчанию — настройки вашего пресета.">
            <ScheduleEditor
              schedule={schedule}
              onChange={setSchedule}
              hydrated={scheduleHydrated}
            />
          </Section>
        )}

        {/* Step 5: Behavior */}
        {fileHeaders.length > 0 && (
          <Section number={5} title="Настройки отправки" subtitle="Эти параметры применятся только к этой кампании.">
            <BehaviorEditor
              behavior={behavior}
              onChange={setBehavior}
            />
          </Section>
        )}

        {/* Step 6: Mailbox subset picker — only meaningful if the preset has >=2 mailboxes.
            For a single-mailbox preset there's nothing to choose, so the section is hidden
            to reduce noise. Same when the preset hasn't loaded yet — Section 6 simply
            doesn't render. */}
        {fileHeaders.length > 0 && preset && preset.email_account_ids.length >= 2 && selectedEmailAccountIds !== null && (
          <Section
            number={6}
            title="Почты отправки"
            subtitle="С каких ящиков из вашего пресета отправлять ЭТУ кампанию. По умолчанию задействованы все. Снимите галочку, чтобы отправлять с подмножества (например, чтобы пустить параллельную кампанию по той же базе с другого пула)."
          >
            <EmailAccountsPicker
              pool={preset.email_account_ids}
              selected={selectedEmailAccountIds}
              onChange={setSelectedEmailAccountIds}
            />
          </Section>
        )}

        {/* Step 7: Launch */}
        {fileHeaders.length > 0 && (
          <Section number={7} title="Запуск" subtitle="Кампания будет создана в Instantly и сразу же активирована.">
            {launchError && (
              <div
                className="mb-4 neu-inset rounded-md px-4 py-3 text-sm flex items-start gap-2.5"
                role="alert"
              >
                <span
                  aria-hidden
                  className="ds-status-dot shrink-0"
                  style={{ background: 'var(--cp-red)', marginTop: '7px' }}
                />
                <span style={{ color: 'var(--cp-paper)' }}>{launchError}</span>
              </div>
            )}
            <div className="flex flex-col sm:flex-row gap-3 sm:items-center sm:justify-between">
              <div className="text-xs sm:text-sm" style={{ color: 'var(--cp-paper-mute)' }}>
                Будет загружено{' '}
                <span
                  className="ds-mono font-bold"
                  style={{ color: 'var(--cp-paper)' }}
                >
                  {validLeadsCount.toLocaleString('ru-RU')}
                </span>{' '}
                лидов · {sequenceSteps.length} {sequenceSteps.length === 1 ? 'шаг' : 'шага'} в цепочке
              </div>
              <button
                type="button"
                onClick={handleLaunch}
                disabled={launching || validLeadsCount === 0}
                className="ds-btn-primary px-6 py-3 text-sm inline-flex items-center justify-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {launching ? (
                  <><Loader2 className="h-4 w-4 animate-spin" aria-hidden /> Запускаем…</>
                ) : (
                  <><Send className="h-4 w-4" aria-hidden /> Запустить кампанию</>
                )}
              </button>
            </div>
          </Section>
        )}
      </div>

      {/* History */}
      <div className="mt-10">
        <p className="ds-eyebrow mb-4">история запусков</p>
        {historyLoading ? (
          <div className="neu-card py-8 flex items-center justify-center">
            <div className="neu-spinner animate-spin" />
          </div>
        ) : history.length === 0 ? (
          <div
            className="neu-card py-10 text-center text-sm"
            style={{ color: 'var(--cp-paper-mute)' }}
          >
            Запусков пока не было
          </div>
        ) : (
          <div className="space-y-2">
            {history.map((h) => (
              <div key={h.id} className="neu-sm px-4 py-3 flex items-center gap-3">
                <span
                  aria-hidden
                  className="ds-status-dot shrink-0"
                  style={{ background: STATUS_DOT[h.status] }}
                />
                <div className="min-w-0 flex-1">
                  <p
                    className="text-sm font-semibold truncate m-0"
                    style={{ color: 'var(--cp-paper)' }}
                  >
                    {h.campaign_name}
                  </p>
                  <p
                    className="ds-mono text-xs mt-0.5"
                    style={{ color: 'var(--cp-paper-faint)' }}
                  >
                    {formatDate(h.created_at)} · {h.accepted_rows.toLocaleString('ru-RU')} из {h.uploaded_rows.toLocaleString('ru-RU')}
                    {h.error_message && ` · ${h.error_message}`}
                  </p>
                </div>
                <span
                  className="ds-status-tag shrink-0"
                  style={{ color: 'var(--cp-paper-mute)' }}
                >
                  {STATUS_LABELS[h.status]}
                </span>
                {h.instantly_campaign_id && (
                  <Link
                    href={`/client/campaigns/${h.instantly_campaign_id}`}
                    className="ds-btn-ghost shrink-0 p-2"
                    aria-label="Открыть кампанию"
                  >
                    <ExternalLink className="h-4 w-4" aria-hidden />
                  </Link>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function PresetBadge({ preset }: { preset: PresetSummary }) {
  return (
    <Link
      href={'/client/launch' as Route}
      className="ds-mono text-xs flex items-center gap-2 max-w-xs px-3 py-2 rounded-md"
      style={{
        background: 'var(--cp-surface-rest)',
        border: '1px solid var(--cp-divider)',
        color: 'var(--cp-paper-mute)',
        textDecoration: 'none',
      }}
    >
      <Mail
        className="h-3.5 w-3.5 shrink-0"
        style={{ color: 'var(--cp-paper-faint)' }}
        aria-hidden
      />
      <span className="truncate">
        {preset.email_account_ids.length} {preset.email_account_ids.length === 1 ? 'аккаунт' : 'аккаунтов'} · {preset.daily_limit}/день
      </span>
    </Link>
  );
}

function Section({
  number,
  title,
  subtitle,
  children,
}: {
  number: number;
  title: string;
  subtitle?: string;
  children: React.ReactNode;
}) {
  const num = String(number).padStart(2, '0');
  return (
    <section className="neu-card overflow-hidden">
      <header
        className="px-5 sm:px-6 py-4 flex items-baseline gap-3"
        style={{
          borderBottom: '1px solid var(--cp-divider)',
          background: 'var(--cp-surface-elev)',
        }}
      >
        <span className="ds-eyebrow shrink-0">
          {num}<span aria-hidden> → </span>
        </span>
        <div className="min-w-0 flex-1">
          <h2
            className="text-sm sm:text-base font-semibold m-0"
            style={{ color: 'var(--cp-paper)' }}
          >
            {title}
          </h2>
          {subtitle && (
            <p className="text-xs mt-0.5" style={{ color: 'var(--cp-paper-mute)' }}>
              {subtitle}
            </p>
          )}
        </div>
      </header>
      <div className="px-5 sm:px-6 py-5">{children}</div>
    </section>
  );
}

function MappingRow({
  label,
  required,
  headers,
  value,
  variable,
  onChange,
}: {
  label: string;
  required?: boolean;
  headers: string[];
  value: string;
  variable: string;
  onChange: (v: string) => void;
}) {
  return (
    <div>
      <div className="flex items-center justify-between mb-1.5 gap-2">
        <label className="ds-eyebrow">
          {label.toLowerCase()}{' '}
          {required && (
            <span style={{ color: 'var(--cp-red)' }} aria-label="обязательное">
              *
            </span>
          )}
        </label>
        {value && <CopyVariableBadge variable={variable} />}
      </div>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="ds-input w-full text-sm"
      >
        <option value="">— не использовать —</option>
        {headers.map((h) => <option key={h} value={h}>{h}</option>)}
      </select>
    </div>
  );
}

function CopyVariableBadge({ variable }: { variable: string }) {
  const [copied, setCopied] = useState(false);
  const text = `{{${variable}}}`;
  return (
    <button
      type="button"
      onClick={async () => {
        try { await navigator.clipboard.writeText(text); setCopied(true); setTimeout(() => setCopied(false), 1500); } catch { /* noop */ }
      }}
      className="ds-mono inline-flex items-center gap-1 px-2 py-0.5 text-[10px] shrink-0 rounded"
      style={{
        background: 'var(--cp-surface-rest)',
        border: '1px solid var(--cp-divider)',
        color: copied ? 'var(--cp-green)' : 'var(--cp-paper-mute)',
      }}
      title="Скопировать переменную"
    >
      {copied ? <Check className="h-3 w-3" aria-hidden /> : <Copy className="h-3 w-3" aria-hidden />}
      {text}
    </button>
  );
}

function BasePreview({ headers, rows }: { headers: string[]; rows: string[][] }) {
  if (headers.length === 0 || rows.length === 0) return null;
  return (
    <div
      className="mt-3 rounded-md px-3 py-3"
      style={{
        background: 'var(--cp-surface-rest)',
        border: '1px solid var(--cp-divider)',
      }}
    >
      <p className="ds-eyebrow mb-2">превью первых {rows.length} строк</p>
      <div className="overflow-x-auto -mx-1 px-1">
        <table className="w-full text-xs" style={{ borderCollapse: 'separate', borderSpacing: 0 }}>
          <thead>
            <tr>
              {headers.map((h, i) => (
                <th
                  key={`${h}-${i}`}
                  className="ds-eyebrow text-left px-2 py-1.5 whitespace-nowrap"
                  style={{ borderBottom: '1px solid var(--cp-divider)' }}
                >
                  {h || <span style={{ color: 'var(--cp-paper-faint)' }}>(пусто)</span>}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, rowIdx) => (
              <tr key={rowIdx}>
                {headers.map((_, colIdx) => (
                  <td
                    key={colIdx}
                    className="ds-mono px-2 py-1.5 whitespace-nowrap"
                    style={{
                      color: 'var(--cp-paper)',
                      maxWidth: 200,
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                    }}
                    title={row[colIdx] ?? ''}
                  >
                    {(row[colIdx] ?? '').slice(0, 80) || (
                      <span style={{ color: 'var(--cp-paper-faint)' }}>—</span>
                    )}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

interface VariableEntry {
  variable: string;
  source: string;
  sample: string;
}

function buildAvailableVariables(
  mapping: ClientLaunchColumnMapping,
  customVars: { key: string; header: string }[],
  fileHeaders: string[],
  firstRow: string[] | undefined,
): VariableEntry[] {
  const entries: VariableEntry[] = [];
  const usedKeys = new Set<string>();
  const headerIdx = new Map<string, number>();
  fileHeaders.forEach((h, i) => headerIdx.set(h, i));
  const sampleFor = (header: string | undefined): string => {
    if (!header || !firstRow) return '';
    const idx = headerIdx.get(header);
    if (idx === undefined) return '';
    return (firstRow[idx] ?? '').toString().trim();
  };

  // camelCase — единственная форма, которую Instantly понимает для
  // стандартных полей в шаблонах. См. STANDARD_FIELDS наверху файла.
  const standardKeys: { var: string; header: string | undefined }[] = [
    { var: 'firstName', header: mapping.first_name },
    { var: 'lastName', header: mapping.last_name },
    { var: 'companyName', header: mapping.company_name },
    { var: 'website', header: mapping.website },
    { var: 'phone', header: mapping.phone },
  ];
  for (const { var: v, header } of standardKeys) {
    if (header) {
      entries.push({ variable: v, source: header, sample: sampleFor(header) });
      usedKeys.add(v);
    }
  }
  for (const cv of customVars) {
    const key = cv.key.trim().replace(/[^a-zA-Z0-9_]/g, '_');
    if (key && cv.header && !usedKeys.has(key)) {
      entries.push({ variable: key, source: cv.header, sample: sampleFor(cv.header) });
      usedKeys.add(key);
    }
  }
  // Headers that are valid identifiers and not already mapped become auto custom vars.
  const mappedHeaders = new Set<string>();
  for (const k of ['email', 'first_name', 'last_name', 'company_name', 'website', 'phone'] as const) {
    const h = mapping[k];
    if (h) mappedHeaders.add(h);
  }
  for (const cv of customVars) if (cv.header) mappedHeaders.add(cv.header);
  for (const h of fileHeaders) {
    if (mappedHeaders.has(h)) continue;
    if (!/^[a-zA-Z][a-zA-Z0-9_]*$/.test(h)) continue;
    if (usedKeys.has(h)) continue;
    entries.push({ variable: h, source: h, sample: sampleFor(h) });
    usedKeys.add(h);
  }
  return entries;
}

function VariableReference({
  mapping,
  customVars,
  fileHeaders,
  firstRow,
}: {
  mapping: ClientLaunchColumnMapping;
  customVars: { key: string; header: string }[];
  fileHeaders: string[];
  firstRow: string[] | undefined;
}) {
  const entries = useMemo(
    () => buildAvailableVariables(mapping, customVars, fileHeaders, firstRow),
    [mapping, customVars, fileHeaders, firstRow],
  );
  if (entries.length === 0) {
    return (
      <div
        className="rounded-md px-4 py-3 mb-4 text-xs flex items-start gap-2"
        style={{
          background: 'var(--cp-surface-rest)',
          border: '1px solid var(--cp-divider)',
          color: 'var(--cp-paper-mute)',
        }}
      >
        <Info
          className="h-3.5 w-3.5 shrink-0 mt-0.5"
          style={{ color: 'var(--cp-paper-faint)' }}
          aria-hidden
        />
        Сопоставьте колонки на шаге 2 — здесь появятся доступные переменные.
      </div>
    );
  }
  return (
    <div
      className="rounded-md px-4 py-3 mb-4"
      style={{
        background: 'var(--cp-surface-rest)',
        border: '1px solid var(--cp-divider)',
      }}
    >
      <div className="flex items-center gap-2 mb-2.5">
        <Info
          className="h-3.5 w-3.5 shrink-0"
          style={{ color: 'var(--cp-paper-faint)' }}
          aria-hidden
        />
        <p className="ds-eyebrow">
          доступные переменные · клик — копировать
        </p>
      </div>
      <div className="flex flex-wrap gap-1.5">
        {entries.map((entry) => (
          <VariableChip key={entry.variable} entry={entry} />
        ))}
      </div>
      <p
        className="text-[10px] mt-2.5"
        style={{ color: 'var(--cp-paper-faint)' }}
      >
        Если переменной нет у конкретного лида, Instantly подставит пустую строку.
      </p>
    </div>
  );
}

function VariableChip({ entry }: { entry: VariableEntry }) {
  const [copied, setCopied] = useState(false);
  const text = `{{${entry.variable}}}`;
  return (
    <button
      type="button"
      onClick={async () => {
        try { await navigator.clipboard.writeText(text); setCopied(true); setTimeout(() => setCopied(false), 1500); } catch { /* noop */ }
      }}
      className="ds-mono inline-flex items-center gap-1.5 px-2.5 py-1 text-[11px] rounded transition-colors"
      style={{
        background: 'var(--cp-ink)',
        border: '1px solid var(--cp-divider)',
        color: copied ? 'var(--cp-green)' : 'var(--cp-paper-mute)',
      }}
      title={entry.sample ? `Колонка «${entry.source}» · пример: ${entry.sample}` : `Колонка «${entry.source}»`}
    >
      {copied ? <Check className="h-3 w-3" aria-hidden /> : <Copy className="h-3 w-3" aria-hidden />}
      {text}
      {entry.sample && (
        <span
          className="text-[10px] truncate max-w-[120px]"
          style={{
            color: 'var(--cp-paper-faint)',
            fontFamily: 'var(--font-inter), Inter, ui-sans-serif',
          }}
        >
          · {entry.sample.slice(0, 24)}
        </span>
      )}
    </button>
  );
}

/**
 * Per-launch mailbox subset picker. Renders pool as toggleable pills.
 * Default state when section first renders: every mailbox selected
 * (initialized upstream from preset.email_account_ids). Counter and
 * Все/Очистить shortcuts above the pill grid for quick adjustments.
 *
 * Validation lives in handleLaunch (empty selection → blocking error)
 * and runLaunch (subset check). This component just owns the toggle.
 */
function EmailAccountsPicker({
  pool,
  selected,
  onChange,
}: {
  pool: string[];
  selected: string[];
  onChange: (next: string[]) => void;
}) {
  const selectedSet = new Set(selected);
  const allSelected = selectedSet.size === pool.length;

  const toggle = (id: string) => {
    if (selectedSet.has(id)) {
      onChange(selected.filter((s) => s !== id));
    } else {
      // Preserve pool order in the resulting array so journaling and
      // Instantly's email_list stay deterministic across re-renders.
      onChange(pool.filter((p) => p === id || selectedSet.has(p)));
    }
  };

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <p className="text-xs" style={{ color: 'var(--cp-paper-mute)' }}>
          Выбрано{' '}
          <span className="ds-mono font-bold" style={{ color: 'var(--cp-paper)' }}>
            {selected.length}
          </span>{' '}
          из {pool.length}
        </p>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => onChange([...pool])}
            disabled={allSelected}
            className="ds-btn-ghost px-3 py-1 text-[11px] disabled:opacity-40 disabled:cursor-not-allowed"
          >
            Выбрать все
          </button>
          <button
            type="button"
            onClick={() => onChange([])}
            disabled={selected.length === 0}
            className="ds-btn-ghost px-3 py-1 text-[11px] disabled:opacity-40 disabled:cursor-not-allowed"
          >
            Очистить
          </button>
        </div>
      </div>
      <div className="flex flex-wrap gap-1.5">
        {pool.map((email) => {
          const isSelected = selectedSet.has(email);
          return (
            <button
              key={email}
              type="button"
              onClick={() => toggle(email)}
              className="inline-flex items-center gap-1.5 px-2.5 py-1 text-[11px] rounded transition-colors"
              style={{
                background: isSelected ? 'var(--cp-paper)' : 'var(--cp-ink)',
                border: '1px solid var(--cp-divider)',
                color: isSelected ? 'var(--cp-ink)' : 'var(--cp-paper-mute)',
              }}
              aria-pressed={isSelected}
            >
              {isSelected ? (
                <Check className="h-3 w-3" aria-hidden />
              ) : (
                <span aria-hidden className="inline-block h-3 w-3" />
              )}
              <span className="ds-mono">{email}</span>
            </button>
          );
        })}
      </div>
      {selected.length === 0 && (
        <p className="text-[11px]" style={{ color: 'var(--cp-amber)' }}>
          Минимум один ящик — иначе Instantly не сможет отправить кампанию.
        </p>
      )}
    </div>
  );
}

function BehaviorEditor({
  behavior,
  onChange,
}: {
  behavior: LaunchBehaviorSettings;
  onChange: (next: LaunchBehaviorSettings) => void;
}) {
  const toggle = (key: keyof LaunchBehaviorSettings) => {
    onChange({ ...behavior, [key]: !behavior[key] });
  };

  return (
    <div className="space-y-3">
      <BehaviorToggle
        checked={behavior.open_tracking}
        label="Отслеживать открытия писем"
        description="Instantly будет считать открытия писем в статистике кампании."
        onToggle={() => toggle('open_tracking')}
      />
      <BehaviorToggle
        checked={behavior.stop_on_reply}
        label="Останавливать цепочку при ответе"
        description="Если получатель ответит, следующие письма цепочки для него не отправятся."
        onToggle={() => toggle('stop_on_reply')}
      />
    </div>
  );
}

function BehaviorToggle({
  checked,
  label,
  description,
  onToggle,
}: {
  checked: boolean;
  label: string;
  description: string;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      className="ds-card-pressable w-full p-4 text-left flex items-center justify-between gap-4 rounded-md"
      style={{
        background: 'var(--cp-surface-rest)',
        border: '1px solid var(--cp-divider)',
      }}
      aria-pressed={checked}
    >
      <span className="min-w-0">
        <span
          className="block text-sm font-semibold"
          style={{ color: 'var(--cp-paper)' }}
        >
          {label}
        </span>
        <span
          className="block text-xs mt-1"
          style={{ color: 'var(--cp-paper-mute)' }}
        >
          {description}
        </span>
      </span>
      <span
        className="relative h-6 w-11 shrink-0 rounded-full transition-colors"
        style={{
          background: checked ? 'var(--cp-paper)' : 'var(--cp-divider-strong)',
        }}
      >
        <span
          className="absolute top-0.5 h-5 w-5 rounded-full transition-transform"
          style={{
            left: checked ? '1.375rem' : '0.125rem',
            background: checked ? 'var(--cp-ink)' : 'var(--cp-paper-faint)',
          }}
        />
      </span>
    </button>
  );
}

function ScheduleEditor({
  schedule,
  onChange,
  hydrated,
}: {
  schedule: ClientLaunchScheduleOverride;
  onChange: (next: ClientLaunchScheduleOverride) => void;
  hydrated: boolean;
}) {
  const toggleDay = (day: number) => {
    const next = schedule.days.includes(day)
      ? schedule.days.filter((d) => d !== day)
      : [...schedule.days, day].sort((a, b) => a - b);
    onChange({ ...schedule, days: next });
  };

  const tzNormalized = normalizeInstantlyTimezone(schedule.timezone);
  const tzLabel = INSTANTLY_TIMEZONE_OPTIONS.find((o) => o.value === tzNormalized)?.label ?? tzNormalized;

  return (
    <div>
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mb-4">
        <div>
          <label className="ds-eyebrow block mb-1.5">время начала</label>
          <input
            type="time"
            value={schedule.from}
            onChange={(e) => onChange({ ...schedule, from: e.target.value })}
            className="ds-input ds-mono w-full text-sm"
          />
        </div>
        <div>
          <label className="ds-eyebrow block mb-1.5">время окончания</label>
          <input
            type="time"
            value={schedule.to}
            onChange={(e) => onChange({ ...schedule, to: e.target.value })}
            className="ds-input ds-mono w-full text-sm"
          />
        </div>
        <div>
          <label className="ds-eyebrow block mb-1.5">часовой пояс</label>
          <select
            value={tzNormalized}
            onChange={(e) => onChange({ ...schedule, timezone: e.target.value })}
            className="ds-input w-full text-sm"
          >
            {INSTANTLY_TIMEZONE_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
        </div>
      </div>
      <div>
        <label className="ds-eyebrow block mb-2">дни недели</label>
        <div className="flex flex-wrap gap-1.5">
          {WEEKDAYS.map((d) => {
            const checked = schedule.days.includes(d.value);
            return (
              <button
                key={d.value}
                type="button"
                onClick={() => toggleDay(d.value)}
                className={`ds-nav-item px-3 py-1.5 text-xs ${checked ? 'active' : ''}`}
                aria-pressed={checked}
              >
                {d.label}
              </button>
            );
          })}
        </div>
      </div>
      {hydrated && (
        <p
          className="ds-mono mt-3 text-[11px]"
          style={{ color: 'var(--cp-paper-faint)' }}
        >
          {schedule.days.length === 0
            ? 'выберите хотя бы один день — иначе кампания не будет отправляться'
            : `${schedule.from}–${schedule.to} (${tzLabel}) в выбранные дни`}
        </p>
      )}
    </div>
  );
}

function SequenceStepEditor({
  stepIdx,
  step,
  isFirstStep,
  canRemove,
  activeVariant,
  onSetActiveVariant,
  onUpdateActive,
  onUpdateStep,
  onRemoveStep,
  onAddVariant,
  onRemoveVariant,
}: {
  stepIdx: number;
  step: ClientLaunchSequenceStep;
  isFirstStep: boolean;
  canRemove: boolean;
  activeVariant: number;
  onSetActiveVariant: (v: number) => void;
  onUpdateActive: (patch: Partial<ClientLaunchSequenceVariant>) => void;
  onUpdateStep: (patch: Partial<ClientLaunchSequenceStep>) => void;
  onRemoveStep: () => void;
  onAddVariant: () => void;
  onRemoveVariant: (vIdx: number) => void;
}) {
  const variantsCount = 1 + (step.variants?.length ?? 0);
  const activeContent: ClientLaunchSequenceVariant = activeVariant === 0
    ? { subject: step.subject, body: step.body }
    : (step.variants?.[activeVariant - 1] ?? { subject: '', body: '' });
  const subjectRequired = isFirstStep;
  const customSubjectOnFollowUp = !isFirstStep && (activeContent.subject ?? '').trim() !== '';
  const canAddVariant = variantsCount < CLIENT_LAUNCH_MAX_VARIANTS_PER_STEP;

  return (
    <div
      className="rounded-md p-4"
      style={{
        background: 'var(--cp-surface-rest)',
        border: '1px solid var(--cp-divider)',
      }}
    >
      <div className="flex items-center gap-3 mb-3">
        <span
          className="ds-mono text-xs font-semibold shrink-0"
          style={{ color: 'var(--cp-paper-faint)' }}
        >
          {String(stepIdx + 1).padStart(2, '0')}
        </span>
        <span
          className="text-sm font-semibold"
          style={{ color: 'var(--cp-paper)' }}
        >
          {isFirstStep ? 'Первое письмо' : `Письмо ${stepIdx + 1}`}
        </span>
        <div className="flex-1" />
        {!isFirstStep && (
          <div className="flex items-center gap-2 shrink-0">
            <span
              className="text-xs"
              style={{ color: 'var(--cp-paper-mute)' }}
            >
              через
            </span>
            <input
              type="number"
              min={0}
              max={60}
              value={step.wait_days}
              onChange={(e) => onUpdateStep({ wait_days: Math.max(0, Math.min(60, Number(e.target.value) || 0)) })}
              className="ds-input ds-mono w-14 text-sm text-center"
            />
            <span
              className="text-xs"
              style={{ color: 'var(--cp-paper-mute)' }}
            >
              дн.
            </span>
          </div>
        )}
        {canRemove && (
          <button
            type="button"
            onClick={onRemoveStep}
            className="ds-btn-ghost p-1.5 shrink-0"
            aria-label="Удалить шаг"
          >
            <Trash2 className="h-4 w-4" aria-hidden />
          </button>
        )}
      </div>

      {/* Variant tabs */}
      <div className="flex items-center gap-1 mb-3 flex-wrap">
        {Array.from({ length: variantsCount }, (_, vIdx) => {
          const letter = String.fromCharCode(65 + vIdx);
          const isActive = vIdx === activeVariant;
          return (
            <div
              key={vIdx}
              className={`ds-nav-item inline-flex items-center gap-1 px-3 py-1 text-xs ${isActive ? 'active' : ''}`}
            >
              <button type="button" onClick={() => onSetActiveVariant(vIdx)}>
                Вариант {letter}
              </button>
              {vIdx > 0 && (
                <button
                  type="button"
                  onClick={() => onRemoveVariant(vIdx - 1)}
                  className="ml-0.5 -mr-1 p-0.5"
                  style={{ color: 'var(--cp-paper-faint)' }}
                  aria-label={`Удалить вариант ${letter}`}
                >
                  <X className="h-3 w-3" aria-hidden />
                </button>
              )}
            </div>
          );
        })}
        {canAddVariant && (
          <button
            type="button"
            onClick={onAddVariant}
            className="ds-btn-ghost inline-flex items-center gap-1 px-3 py-1 text-xs"
          >
            <Plus className="h-3 w-3" aria-hidden /> Вариант
          </button>
        )}
        {variantsCount > 1 && (
          <span
            className="ml-2 text-[10px]"
            style={{ color: 'var(--cp-paper-faint)' }}
          >
            Instantly случайно выберет один вариант для каждого лида
          </span>
        )}
      </div>

      <input
        type="text"
        value={activeContent.subject ?? ''}
        onChange={(e) => onUpdateActive({ subject: e.target.value })}
        placeholder={subjectRequired ? 'Тема письма' : 'Та же тема — продолжение ветки'}
        className="ds-input w-full text-sm"
      />
      {customSubjectOnFollowUp && (
        <div className="mt-1.5 text-[11px] flex items-start gap-1.5">
          <AlertTriangle
            className="h-3 w-3 shrink-0 mt-0.5"
            style={{ color: 'var(--cp-amber)' }}
            aria-hidden
          />
          <span style={{ color: 'var(--cp-paper-mute)' }}>
            Новая тема создаст отдельную ветку — получатель не увидит историю переписки. Оставьте пустым, чтобы продолжить ту же ветку.
          </span>
        </div>
      )}
      {!isFirstStep && (activeContent.subject ?? '').trim() === '' && (
        <div className="mt-1.5 text-[11px] flex items-start gap-1.5">
          <Info
            className="h-3 w-3 shrink-0 mt-0.5"
            style={{ color: 'var(--cp-paper-faint)' }}
            aria-hidden
          />
          <span style={{ color: 'var(--cp-paper-faint)' }}>
            Будет отправлено в той же ветке, что и предыдущее письмо.
          </span>
        </div>
      )}
      <div className="mt-2">
        <EmailBodyField
          value={activeContent.body}
          onChange={(v) => onUpdateActive({ body: v })}
          placeholder="Текст письма — обычный текст, HTML не используется"
          rows={6}
          className="ds-input w-full text-sm resize-y"
        />
      </div>
    </div>
  );
}
