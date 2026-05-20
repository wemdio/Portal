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

const STANDARD_FIELDS: { key: keyof Omit<ClientLaunchColumnMapping, 'custom_variables_mapping'>; label: string; required?: boolean; variable: string }[] = [
  { key: 'email', label: 'Email', required: true, variable: 'email' },
  { key: 'first_name', label: 'Имя', variable: 'first_name' },
  { key: 'last_name', label: 'Фамилия', variable: 'last_name' },
  { key: 'company_name', label: 'Компания', variable: 'company_name' },
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

const STATUS_COLORS: Record<LaunchHistoryItem['status'], string> = {
  uploading: 'var(--cp-text-l)',
  active: 'var(--cp-accent)',
  paused: '#C49B4A',
  completed: 'var(--cp-text-m)',
  failed: 'var(--cp-danger)',
};

function formatDate(iso: string) {
  return new Date(iso).toLocaleString('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
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

  const [launching, setLaunching] = useState(false);
  const [launchError, setLaunchError] = useState('');
  const [result, setResult] = useState<LaunchResult | null>(null);

  // Brief status drives an inline tip in Step 3. Null until first fetch.
  const [briefFilled, setBriefFilled] = useState<boolean | null>(null);

  const fileInputRef = useRef<HTMLInputElement>(null);

  // ─── Load preset + history ───────────────────────────────────────────────
  const loadPreset = useCallback(async () => {
    setPresetLoading(true);
    setPresetError('');
    try {
      const data = await clientApiFetch<{ preset: PresetSummary | null }>('/preset');
      setPreset(data.preset);
      if (data.preset) {
        setSchedule({
          from: data.preset.schedule_from || '09:00',
          to: data.preset.schedule_to || '18:00',
          days: Array.isArray(data.preset.schedule_days) && data.preset.schedule_days.length > 0
            ? data.preset.schedule_days
            : [1, 2, 3, 4, 5],
          timezone: normalizeInstantlyTimezone(data.preset.schedule_timezone || 'Europe/Kirov'),
        });
        setBehavior({
          open_tracking: data.preset.open_tracking !== false,
          stop_on_reply: data.preset.stop_on_reply !== false,
        });
        setScheduleHydrated(true);
      }
    } catch (err) {
      setPresetError(err instanceof Error ? err.message : 'Не удалось загрузить пресет');
    } finally {
      setPresetLoading(false);
    }
  }, []);

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

  // Fire-and-forget: fetch onboarding status to know whether the brief is
  // filled. Drives the inline tip shown in the Sequence step. Failures are
  // silent — the tip just won't show.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await clientApiFetch<{ items: { id: string; done: boolean }[] }>(
          '/onboarding/status',
        );
        if (cancelled) return;
        const brief = res.items.find((i) => i.id === 'brief');
        setBriefFilled(brief?.done ?? null);
      } catch { /* ignore — non-critical */ }
    })();
    return () => { cancelled = true; };
  }, []);

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
        <h1 className="text-xl sm:text-2xl font-extrabold mb-6 sm:mb-8 flex items-center gap-2.5"><span className="inline-flex items-center justify-center w-8 h-8 rounded-xl" style={{ background: 'rgba(16,185,129,0.12)', color: '#10B981' }}><Send className="h-4.5 w-4.5" /></span>Запуск кампаний</h1>
        <div className="neu-inset rounded-2xl px-5 py-4 text-sm font-medium" style={{ color: 'var(--cp-danger)' }}>
          {presetError}
        </div>
      </div>
    );
  }

  if (!preset || preset.email_account_ids.length === 0) {
    return (
      <div className="mx-auto max-w-5xl">
        <h1 className="text-xl sm:text-2xl font-extrabold mb-6 sm:mb-8 flex items-center gap-2.5"><span className="inline-flex items-center justify-center w-8 h-8 rounded-xl" style={{ background: 'rgba(16,185,129,0.12)', color: '#10B981' }}><Send className="h-4.5 w-4.5" /></span>Создать кампанию</h1>
        <div className="neu-card py-12 sm:py-16 text-center px-6">
          <Settings className="mx-auto h-10 w-10 mb-4" style={{ color: 'var(--cp-text-l)' }} />
          <p className="text-sm sm:text-base font-semibold mb-2" style={{ color: 'var(--cp-text)' }}>
            Пресет ещё не настроен
          </p>
          <p className="text-xs sm:text-sm max-w-md mx-auto" style={{ color: 'var(--cp-text-m)' }}>
            Прежде чем вы запустите первую кампанию, ваш менеджер должен привязать
            к аккаунту email-почты для рассылки и общее расписание. Это разовая настройка.
          </p>
          <Link
            href={'/client/support' as Route}
            className="neu-btn inline-flex items-center gap-2 px-5 py-2.5 mt-6 text-sm font-semibold"
          >
            <Mail className="h-4 w-4" />
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
        <h1 className="text-xl sm:text-2xl font-extrabold mb-6 sm:mb-8 flex items-center gap-2.5"><span className="inline-flex items-center justify-center w-8 h-8 rounded-xl" style={{ background: 'rgba(16,185,129,0.12)', color: '#10B981' }}><CheckCircle2 className="h-4.5 w-4.5" /></span>Кампания запущена</h1>
        <div className="neu-card p-8 sm:p-10 text-center">
          <CheckCircle2 className="mx-auto h-14 w-14 mb-5" style={{ color: 'var(--cp-accent)' }} />
          <h2 className="text-lg sm:text-xl font-bold mb-2">{result.campaign_name}</h2>
          <p className="text-sm mb-6" style={{ color: 'var(--cp-text-m)' }}>
            Загружено {result.accepted_rows.toLocaleString('ru-RU')} лидов
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
                className="neu-btn px-6 py-3 text-sm font-semibold inline-flex items-center justify-center gap-2"
              >
                Перейти к кампании <ExternalLink className="h-4 w-4" />
              </Link>
            )}
            <button
              type="button"
              onClick={startNewLaunch}
              className="neu-pill px-6 py-3 text-sm font-semibold"
              style={{ color: 'var(--cp-text-m)' }}
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
      <div className="mb-6 sm:mb-8 flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-xl sm:text-2xl font-extrabold flex items-center gap-2.5"><span className="inline-flex items-center justify-center w-8 h-8 rounded-xl" style={{ background: 'rgba(16,185,129,0.12)', color: '#10B981' }}><Send className="h-4.5 w-4.5" /></span>Запуск кампаний</h1>
          <p className="mt-1 text-xs sm:text-sm" style={{ color: 'var(--cp-text-m)' }}>
            Загрузите базу, напишите цепочку и запустите
          </p>
        </div>
        <PresetBadge preset={preset} />
      </div>

      <div className="space-y-5 sm:space-y-6">
        {/* Step 1: Upload */}
        <Section number={1} title="Загрузите базу контактов" subtitle={`До ${CLIENT_LAUNCH_ROW_LIMIT.toLocaleString('ru-RU')} строк, форматы: CSV, XLSX`}>
          {fileRows.length === 0 ? (
            <label
              onDragOver={handleDragOver}
              onDragLeave={handleDragLeave}
              onDrop={handleDrop}
              className={`neu-inset rounded-2xl flex flex-col items-center justify-center cursor-pointer p-8 sm:p-10 transition-all ${isDragOver ? 'ring-2 ring-offset-2' : ''}`}
              style={isDragOver ? { boxShadow: 'inset 2px 2px 5px var(--cp-shadow-d), inset -2px -2px 5px var(--cp-shadow-l), 0 0 0 2px var(--cp-accent)' } : undefined}
            >
              {parsing ? (
                <Loader2 className="h-8 w-8 animate-spin" style={{ color: 'var(--cp-accent)' }} />
              ) : (
                <>
                  <Upload className="h-10 w-10 mb-3" style={{ color: 'var(--cp-text-l)' }} />
                  <p className="text-sm font-semibold mb-1" style={{ color: 'var(--cp-text)' }}>
                    Перетащите файл или нажмите
                  </p>
                  <p className="text-xs" style={{ color: 'var(--cp-text-m)' }}>
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
              <div className="neu-inset rounded-2xl px-4 sm:px-5 py-3.5 flex items-center gap-3">
                <FileText className="h-5 w-5 shrink-0" style={{ color: 'var(--cp-accent)' }} />
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-semibold truncate">{fileName}</p>
                  <p className="text-xs" style={{ color: 'var(--cp-text-m)' }}>
                    {fileRows.length.toLocaleString('ru-RU')} строк · {fileHeaders.length} колонок · валидных email: {validLeadsCount.toLocaleString('ru-RU')}
                  </p>
                </div>
                <button type="button" onClick={clearFile} className="p-2 rounded-lg" aria-label="Удалить файл" style={{ color: 'var(--cp-text-m)' }}>
                  <X className="h-4 w-4" />
                </button>
              </div>
              <BasePreview headers={fileHeaders} rows={fileRows.slice(0, PREVIEW_ROW_COUNT)} />
            </>
          )}
          {parseError && (
            <div className="mt-3 text-xs flex items-start gap-2" style={{ color: 'var(--cp-danger)' }}>
              <AlertTriangle className="h-3.5 w-3.5 mt-0.5 shrink-0" />
              {parseError}
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

            <div className="mt-5 pt-5 border-t" style={{ borderColor: 'rgba(180,173,164,0.2)' }}>
              <div className="flex items-center justify-between mb-3">
                <p className="text-xs font-semibold uppercase tracking-wider" style={{ color: 'var(--cp-text-m)' }}>
                  Кастомные переменные
                </p>
                <button type="button" onClick={addCustomVar} className="neu-pill inline-flex items-center gap-1 px-3 py-1.5 text-xs font-semibold" style={{ color: 'var(--cp-accent)' }}>
                  <Plus className="h-3 w-3" /> Добавить
                </button>
              </div>
              {customVars.length === 0 ? (
                <p className="text-xs" style={{ color: 'var(--cp-text-l)' }}>
                  Пример: переменная <code className="font-mono">company_size</code> → колонка «Размер компании», в шаблоне используйте <code className="font-mono">{'{{company_size}}'}</code>
                </p>
              ) : (
                <div className="space-y-2">
                  {customVars.map((cv, idx) => (
                    <div key={idx} className="flex gap-2 items-center">
                      <span className="text-xs font-mono shrink-0" style={{ color: 'var(--cp-text-m)' }}>{'{{'}</span>
                      <input
                        type="text"
                        value={cv.key}
                        onChange={(e) => updateCustomVar(idx, { key: e.target.value })}
                        placeholder="ключ"
                        className="neu-input flex-1 px-3 py-1.5 text-xs font-mono"
                      />
                      <span className="text-xs font-mono shrink-0" style={{ color: 'var(--cp-text-m)' }}>{'}}'}</span>
                      <span className="text-xs shrink-0" style={{ color: 'var(--cp-text-l)' }}>=</span>
                      <select
                        value={cv.header}
                        onChange={(e) => updateCustomVar(idx, { header: e.target.value })}
                        className="neu-input flex-1 px-3 py-1.5 text-xs"
                      >
                        <option value="">Колонка...</option>
                        {fileHeaders.map((h) => <option key={h} value={h}>{h}</option>)}
                      </select>
                      <button type="button" onClick={() => removeCustomVar(idx)} className="p-1.5 rounded-lg shrink-0" style={{ color: 'var(--cp-text-m)' }} aria-label="Удалить переменную">
                        <Trash2 className="h-3.5 w-3.5" />
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
            {briefFilled === false && (
              <div
                className="neu-inset rounded-2xl px-4 py-3 sm:px-5 sm:py-3.5 mb-4 flex items-start gap-3 text-xs sm:text-sm"
                style={{ color: 'var(--cp-text-m)' }}
              >
                <Info className="h-4 w-4 shrink-0 mt-0.5" style={{ color: 'var(--cp-accent)' }} />
                <div className="flex-1 min-w-0">
                  <strong style={{ color: 'var(--cp-text)' }}>Совет.</strong>{' '}
                  Заполните <Link href={'/client/brief' as Route} className="font-semibold" style={{ color: 'var(--cp-accent)' }}>бриф</Link> —
                  AI-инструменты (Цепочки писем, Оценка ЦА, персонализация) сработают точнее под вашу аудиторию.
                </div>
              </div>
            )}

            <VariableReference
              mapping={mapping}
              customVars={customVars}
              fileHeaders={fileHeaders}
              firstRow={fileRows[0]}
            />

            <div className="mb-4">
              <label className="text-xs font-semibold uppercase tracking-wider block mb-2" style={{ color: 'var(--cp-text-m)' }}>
                Название кампании
              </label>
              <input
                type="text"
                value={campaignName}
                onChange={(e) => setCampaignName(e.target.value)}
                placeholder="Например: Q2 Outreach IT-компании"
                className="neu-input w-full px-4 py-2.5 text-sm"
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
              <button type="button" onClick={addStep} className="neu-pill w-full py-3 text-sm font-semibold inline-flex items-center justify-center gap-2" style={{ color: 'var(--cp-accent)' }}>
                <Plus className="h-4 w-4" /> Добавить шаг
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

        {/* Step 6: Launch */}
        {fileHeaders.length > 0 && (
          <Section number={6} title="Запуск" subtitle="Кампания будет создана в Instantly и сразу же активирована.">
            {launchError && (
              <div className="mb-4 neu-inset rounded-2xl px-4 py-3 text-sm flex items-start gap-2" style={{ color: 'var(--cp-danger)' }}>
                <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5" />
                {launchError}
              </div>
            )}
            <div className="flex flex-col sm:flex-row gap-3 sm:items-center sm:justify-between">
              <div className="text-xs sm:text-sm" style={{ color: 'var(--cp-text-m)' }}>
                Будет загружено <span className="font-bold" style={{ color: 'var(--cp-text)' }}>{validLeadsCount.toLocaleString('ru-RU')}</span> лидов
                · {sequenceSteps.length} {sequenceSteps.length === 1 ? 'шаг' : 'шага'} в цепочке
              </div>
              <button
                type="button"
                onClick={handleLaunch}
                disabled={launching || validLeadsCount === 0}
                className="neu-btn px-6 py-3 text-sm font-semibold inline-flex items-center justify-center gap-2"
              >
                {launching ? (
                  <><Loader2 className="h-4 w-4 animate-spin" /> Запускаем...</>
                ) : (
                  <><Send className="h-4 w-4" /> Запустить кампанию</>
                )}
              </button>
            </div>
          </Section>
        )}
      </div>

      {/* History */}
      <div className="mt-10">
        <h2 className="text-sm font-bold uppercase tracking-wider mb-4" style={{ color: 'var(--cp-text-m)' }}>
          История запусков
        </h2>
        {historyLoading ? (
          <div className="neu-card py-8 flex items-center justify-center">
            <div className="neu-spinner animate-spin" />
          </div>
        ) : history.length === 0 ? (
          <div className="neu-card py-10 text-center text-sm" style={{ color: 'var(--cp-text-m)' }}>
            Запусков пока не было
          </div>
        ) : (
          <div className="space-y-2">
            {history.map((h) => (
              <div key={h.id} className="neu-sm px-4 py-3 flex items-center gap-3">
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-semibold truncate">{h.campaign_name}</p>
                  <p className="text-xs mt-0.5" style={{ color: 'var(--cp-text-l)' }}>
                    {formatDate(h.created_at)} · {h.accepted_rows.toLocaleString('ru-RU')} из {h.uploaded_rows.toLocaleString('ru-RU')}
                    {h.error_message && ` · ${h.error_message}`}
                  </p>
                </div>
                <span className="shrink-0 text-xs font-semibold px-2 py-1 rounded-full neu-well" style={{ color: STATUS_COLORS[h.status] }}>
                  {STATUS_LABELS[h.status]}
                </span>
                {h.instantly_campaign_id && (
                  <Link
                    href={`/client/campaigns/${h.instantly_campaign_id}`}
                    className="shrink-0 p-2 rounded-lg" aria-label="Открыть кампанию"
                    style={{ color: 'var(--cp-accent)' }}
                  >
                    <ExternalLink className="h-4 w-4" />
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
      className="neu-well px-3 py-2 text-xs flex items-center gap-2 max-w-xs"
      style={{ color: 'var(--cp-text-m)' }}
    >
      <Mail className="h-3.5 w-3.5 shrink-0" style={{ color: 'var(--cp-accent)' }} />
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
  return (
    <section className="neu-card overflow-hidden">
      <header className="px-5 sm:px-6 py-4 flex items-start gap-3" style={{ borderBottom: '1px solid rgba(180,173,164,0.15)' }}>
        <div className="flex h-7 w-7 items-center justify-center text-xs font-bold shrink-0 rounded-full text-white" style={{ background: 'linear-gradient(135deg, #10B981, #059669)' }}>
          {number}
        </div>
        <div className="min-w-0 flex-1">
          <h2 className="text-sm sm:text-base font-bold">{title}</h2>
          {subtitle && <p className="text-xs mt-0.5" style={{ color: 'var(--cp-text-m)' }}>{subtitle}</p>}
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
        <label className="text-xs font-semibold" style={{ color: 'var(--cp-text-m)' }}>
          {label} {required && <span style={{ color: 'var(--cp-danger)' }}>*</span>}
        </label>
        {value && <CopyVariableBadge variable={variable} />}
      </div>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="neu-input w-full px-3 py-2 text-sm"
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
      className="neu-pill inline-flex items-center gap-1 px-2 py-0.5 text-[10px] font-mono shrink-0"
      style={{ color: copied ? 'var(--cp-accent)' : 'var(--cp-text-m)' }}
      title="Скопировать переменную"
    >
      {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
      {text}
    </button>
  );
}

function BasePreview({ headers, rows }: { headers: string[]; rows: string[][] }) {
  if (headers.length === 0 || rows.length === 0) return null;
  return (
    <div className="mt-3 neu-inset rounded-2xl px-3 py-3">
      <p className="text-[10px] font-semibold uppercase tracking-wider mb-2" style={{ color: 'var(--cp-text-l)' }}>
        Превью первых {rows.length} строк
      </p>
      <div className="overflow-x-auto -mx-1 px-1">
        <table className="w-full text-xs" style={{ borderCollapse: 'separate', borderSpacing: 0 }}>
          <thead>
            <tr>
              {headers.map((h, i) => (
                <th
                  key={`${h}-${i}`}
                  className="text-left font-semibold px-2 py-1.5 whitespace-nowrap"
                  style={{ color: 'var(--cp-text-m)', borderBottom: '1px solid rgba(180,173,164,0.25)' }}
                >
                  {h || <span style={{ color: 'var(--cp-text-l)' }}>(пусто)</span>}
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
                    className="px-2 py-1.5 whitespace-nowrap font-mono"
                    style={{ color: 'var(--cp-text)', maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis' }}
                    title={row[colIdx] ?? ''}
                  >
                    {(row[colIdx] ?? '').slice(0, 80) || <span className="font-sans" style={{ color: 'var(--cp-text-l)' }}>—</span>}
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

  const standardKeys: { var: string; header: string | undefined }[] = [
    { var: 'first_name', header: mapping.first_name },
    { var: 'last_name', header: mapping.last_name },
    { var: 'company_name', header: mapping.company_name },
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
      <div className="neu-inset rounded-2xl px-4 py-3 mb-4 text-xs flex items-start gap-2" style={{ color: 'var(--cp-text-m)' }}>
        <Info className="h-3.5 w-3.5 shrink-0 mt-0.5" />
        Сопоставьте колонки на шаге 2 — здесь появятся доступные переменные.
      </div>
    );
  }
  return (
    <div className="neu-inset rounded-2xl px-4 py-3 mb-4">
      <div className="flex items-center gap-2 mb-2.5">
        <Info className="h-3.5 w-3.5 shrink-0" style={{ color: 'var(--cp-accent)' }} />
        <p className="text-[10px] font-semibold uppercase tracking-wider" style={{ color: 'var(--cp-text-m)' }}>
          Доступные переменные · клик — копировать
        </p>
      </div>
      <div className="flex flex-wrap gap-1.5">
        {entries.map((entry) => (
          <VariableChip key={entry.variable} entry={entry} />
        ))}
      </div>
      <p className="text-[10px] mt-2.5" style={{ color: 'var(--cp-text-l)' }}>
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
      className="neu-pill inline-flex items-center gap-1.5 px-2.5 py-1 text-[11px] font-mono"
      style={{ color: copied ? 'var(--cp-accent)' : 'var(--cp-text-m)' }}
      title={entry.sample ? `Колонка «${entry.source}» · пример: ${entry.sample}` : `Колонка «${entry.source}»`}
    >
      {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
      {text}
      {entry.sample && (
        <span className="font-sans text-[10px] truncate max-w-[120px]" style={{ color: 'var(--cp-text-l)' }}>
          · {entry.sample.slice(0, 24)}
        </span>
      )}
    </button>
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
      className="neu-sm w-full p-4 text-left flex items-center justify-between gap-4"
      aria-pressed={checked}
    >
      <span className="min-w-0">
        <span className="block text-sm font-semibold" style={{ color: 'var(--cp-text)' }}>
          {label}
        </span>
        <span className="block text-xs mt-1" style={{ color: 'var(--cp-text-m)' }}>
          {description}
        </span>
      </span>
      <span
        className="relative h-6 w-11 shrink-0 rounded-full transition-colors"
        style={{ background: checked ? 'var(--cp-accent)' : 'rgba(148,163,184,0.35)' }}
      >
        <span
          className="absolute top-0.5 h-5 w-5 rounded-full bg-white shadow-sm transition-transform"
          style={{ left: checked ? '1.375rem' : '0.125rem' }}
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
          <label className="text-xs font-semibold uppercase tracking-wider block mb-1.5" style={{ color: 'var(--cp-text-m)' }}>
            Время начала
          </label>
          <input
            type="time"
            value={schedule.from}
            onChange={(e) => onChange({ ...schedule, from: e.target.value })}
            className="neu-input w-full px-3 py-2 text-sm"
          />
        </div>
        <div>
          <label className="text-xs font-semibold uppercase tracking-wider block mb-1.5" style={{ color: 'var(--cp-text-m)' }}>
            Время окончания
          </label>
          <input
            type="time"
            value={schedule.to}
            onChange={(e) => onChange({ ...schedule, to: e.target.value })}
            className="neu-input w-full px-3 py-2 text-sm"
          />
        </div>
        <div>
          <label className="text-xs font-semibold uppercase tracking-wider block mb-1.5" style={{ color: 'var(--cp-text-m)' }}>
            Часовой пояс
          </label>
          <select
            value={tzNormalized}
            onChange={(e) => onChange({ ...schedule, timezone: e.target.value })}
            className="neu-input w-full px-3 py-2 text-sm"
          >
            {INSTANTLY_TIMEZONE_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
        </div>
      </div>
      <div>
        <label className="text-xs font-semibold uppercase tracking-wider block mb-2" style={{ color: 'var(--cp-text-m)' }}>
          Дни недели
        </label>
        <div className="flex flex-wrap gap-1.5">
          {WEEKDAYS.map((d) => {
            const checked = schedule.days.includes(d.value);
            return (
              <button
                key={d.value}
                type="button"
                onClick={() => toggleDay(d.value)}
                className={`neu-pill px-3 py-1.5 text-xs font-semibold ${checked ? 'active' : ''}`}
                style={!checked ? { color: 'var(--cp-text-m)' } : undefined}
              >
                {d.label}
              </button>
            );
          })}
        </div>
      </div>
      {hydrated && (
        <p className="mt-3 text-[10px]" style={{ color: 'var(--cp-text-l)' }}>
          {schedule.days.length === 0
            ? 'Выберите хотя бы один день — иначе кампания не будет отправляться.'
            : `Письма будут уходить ${schedule.from}–${schedule.to} (${tzLabel}) в выбранные дни.`}
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
    <div className="neu-sm p-4">
      <div className="flex items-center gap-3 mb-3">
        <div className="neu-well flex h-7 w-7 items-center justify-center text-xs font-bold shrink-0" style={{ color: 'var(--cp-accent)' }}>
          {stepIdx + 1}
        </div>
        <span className="text-sm font-semibold" style={{ color: 'var(--cp-text)' }}>
          {isFirstStep ? 'Первое письмо' : `Письмо ${stepIdx + 1}`}
        </span>
        <div className="flex-1" />
        {!isFirstStep && (
          <div className="flex items-center gap-2 shrink-0">
            <span className="text-xs" style={{ color: 'var(--cp-text-m)' }}>через</span>
            <input
              type="number"
              min={0}
              max={60}
              value={step.wait_days}
              onChange={(e) => onUpdateStep({ wait_days: Math.max(0, Math.min(60, Number(e.target.value) || 0)) })}
              className="neu-input w-14 px-2 py-1.5 text-sm text-center"
            />
            <span className="text-xs" style={{ color: 'var(--cp-text-m)' }}>дн.</span>
          </div>
        )}
        {canRemove && (
          <button type="button" onClick={onRemoveStep} className="p-1.5 rounded-lg shrink-0" style={{ color: 'var(--cp-text-m)' }} aria-label="Удалить шаг">
            <Trash2 className="h-4 w-4" />
          </button>
        )}
      </div>

      {/* Variant tabs */}
      <div className="flex items-center gap-1 mb-3 flex-wrap">
        {Array.from({ length: variantsCount }, (_, vIdx) => {
          const letter = String.fromCharCode(65 + vIdx);
          const isActive = vIdx === activeVariant;
          return (
            <div key={vIdx} className={`neu-pill inline-flex items-center gap-1 px-3 py-1 text-xs font-semibold ${isActive ? 'active' : ''}`} style={!isActive ? { color: 'var(--cp-text-m)' } : undefined}>
              <button type="button" onClick={() => onSetActiveVariant(vIdx)}>
                Вариант {letter}
              </button>
              {vIdx > 0 && (
                <button
                  type="button"
                  onClick={() => onRemoveVariant(vIdx - 1)}
                  className="ml-0.5 -mr-1 p-0.5 rounded-full hover:bg-black/5"
                  style={{ color: 'var(--cp-text-l)' }}
                  aria-label={`Удалить вариант ${letter}`}
                >
                  <X className="h-3 w-3" />
                </button>
              )}
            </div>
          );
        })}
        {canAddVariant && (
          <button
            type="button"
            onClick={onAddVariant}
            className="neu-pill inline-flex items-center gap-1 px-3 py-1 text-xs font-semibold"
            style={{ color: 'var(--cp-accent)' }}
          >
            <Plus className="h-3 w-3" /> Вариант
          </button>
        )}
        {variantsCount > 1 && (
          <span className="ml-2 text-[10px]" style={{ color: 'var(--cp-text-l)' }}>
            Instantly случайно выберет один вариант для каждого лида
          </span>
        )}
      </div>

      <input
        type="text"
        value={activeContent.subject ?? ''}
        onChange={(e) => onUpdateActive({ subject: e.target.value })}
        placeholder={subjectRequired ? 'Тема письма' : 'Та же тема — продолжение ветки'}
        className="neu-input w-full px-3 py-2 text-sm"
      />
      {customSubjectOnFollowUp && (
        <div className="mt-1.5 text-[11px] flex items-start gap-1.5" style={{ color: '#C49B4A' }}>
          <AlertTriangle className="h-3 w-3 shrink-0 mt-0.5" />
          Новая тема создаст отдельную ветку — получатель не увидит историю переписки. Оставьте пустым, чтобы продолжить ту же ветку.
        </div>
      )}
      {!isFirstStep && (activeContent.subject ?? '').trim() === '' && (
        <div className="mt-1.5 text-[11px] flex items-start gap-1.5" style={{ color: 'var(--cp-text-l)' }}>
          <Info className="h-3 w-3 shrink-0 mt-0.5" />
          Будет отправлено в той же ветке, что и предыдущее письмо.
        </div>
      )}
      <EmailBodyField
        value={activeContent.body}
        onChange={(v) => onUpdateActive({ body: v })}
        placeholder="Текст письма — обычный текст, HTML не используется"
        rows={6}
        className="neu-input w-full px-3 py-2 text-sm font-sans resize-y"
      />
    </div>
  );
}
