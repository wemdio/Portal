'use client';

import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent } from 'react';
import Link from 'next/link';
import type { Route } from 'next';
import {
  Upload, Trash2, Plus, Send, AlertTriangle, CheckCircle2, Loader2, ExternalLink, Mail, Settings, FileText, X,
} from 'lucide-react';
import { clientApiFetch } from '@/lib/clientFetcher';
import { readSpreadsheetFile } from '@/lib/spreadsheet/parseCSV';
import { CLIENT_LAUNCH_ROW_LIMIT } from '@/lib/clientLaunch/constants';
import type {
  ClientLaunchColumnMapping,
  ClientLaunchSequenceStep,
} from '@/lib/clientLaunch/types';

interface PresetSummary {
  id: string;
  email_account_ids: string[];
  daily_limit: number;
  daily_max_leads: number;
  schedule_from: string;
  schedule_to: string;
  schedule_days: number[];
  schedule_timezone: string;
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

const STANDARD_FIELDS: { key: keyof Omit<ClientLaunchColumnMapping, 'custom_variables_mapping'>; label: string; required?: boolean }[] = [
  { key: 'email', label: 'Email', required: true },
  { key: 'first_name', label: 'Имя' },
  { key: 'last_name', label: 'Фамилия' },
  { key: 'company_name', label: 'Компания' },
  { key: 'website', label: 'Сайт' },
  { key: 'phone', label: 'Телефон' },
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

  const [launching, setLaunching] = useState(false);
  const [launchError, setLaunchError] = useState('');
  const [result, setResult] = useState<LaunchResult | null>(null);

  const fileInputRef = useRef<HTMLInputElement>(null);

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
  }
  function removeStep(idx: number) {
    setSequenceSteps((prev) => prev.length > 1 ? prev.filter((_, i) => i !== idx) : prev);
  }
  function updateStep(idx: number, patch: Partial<ClientLaunchSequenceStep>) {
    setSequenceSteps((prev) => prev.map((s, i) => i === idx ? { ...s, ...patch } : s));
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
    for (let i = 0; i < sequenceSteps.length; i++) {
      const s = sequenceSteps[i];
      if (!s.subject.trim()) { setLaunchError(`Шаг ${i + 1}: укажите тему`); return; }
      if (!s.body.trim()) { setLaunchError(`Шаг ${i + 1}: укажите текст`); return; }
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
        <h1 className="text-xl sm:text-2xl font-extrabold mb-6 sm:mb-8">Запуск кампаний</h1>
        <div className="neu-inset rounded-2xl px-5 py-4 text-sm font-medium" style={{ color: 'var(--cp-danger)' }}>
          {presetError}
        </div>
      </div>
    );
  }

  if (!preset || preset.email_account_ids.length === 0) {
    return (
      <div className="mx-auto max-w-5xl">
        <h1 className="text-xl sm:text-2xl font-extrabold mb-6 sm:mb-8">Запуск кампаний</h1>
        <div className="neu-card py-16 sm:py-24 text-center px-6">
          <Settings className="mx-auto h-10 w-10 mb-4" style={{ color: 'var(--cp-text-l)' }} />
          <p className="text-sm sm:text-base font-semibold mb-2" style={{ color: 'var(--cp-text)' }}>
            Пресет ещё не настроен
          </p>
          <p className="text-xs sm:text-sm" style={{ color: 'var(--cp-text-m)' }}>
            Обратитесь к вашему менеджеру, чтобы он привязал email-аккаунты и настроил расписание.
          </p>
        </div>
      </div>
    );
  }

  // ─── Render: result screen ─────────────────────────────────────────────
  if (result) {
    return (
      <div className="mx-auto max-w-3xl">
        <h1 className="text-xl sm:text-2xl font-extrabold mb-6 sm:mb-8">Кампания запущена</h1>
        <div className="neu-card p-8 sm:p-10 text-center">
          <CheckCircle2 className="mx-auto h-14 w-14 mb-5" style={{ color: 'var(--cp-accent)' }} />
          <h2 className="text-lg sm:text-xl font-bold mb-2">{result.campaign_name}</h2>
          <p className="text-sm mb-6" style={{ color: 'var(--cp-text-m)' }}>
            Загружено {result.accepted_rows.toLocaleString('ru-RU')} лидов
            {result.skipped_rows > 0 && ` · пропущено ${result.skipped_rows.toLocaleString('ru-RU')}`}
          </p>
          <div className="flex flex-col sm:flex-row gap-3 justify-center">
            {result.instantly_campaign_id && (
              <Link
                href={{ pathname: '/client/campaigns/[id]', query: { id: result.instantly_campaign_id } }}
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
          <h1 className="text-xl sm:text-2xl font-extrabold">Запуск кампаний</h1>
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
          <Section number={3} title="Цепочка писем" subtitle="Используйте переменные {{first_name}}, {{company_name}} и кастомные.">
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
                <div key={idx} className="neu-sm p-4">
                  <div className="flex items-start gap-3 mb-3">
                    <div className="neu-well flex h-7 w-7 items-center justify-center text-xs font-bold shrink-0" style={{ color: 'var(--cp-accent)' }}>
                      {idx + 1}
                    </div>
                    <div className="flex-1 min-w-0">
                      <input
                        type="text"
                        value={step.subject}
                        onChange={(e) => updateStep(idx, { subject: e.target.value })}
                        placeholder="Тема письма"
                        className="neu-input w-full px-3 py-2 text-sm"
                      />
                    </div>
                    {idx > 0 && (
                      <div className="flex items-center gap-2 shrink-0">
                        <span className="text-xs" style={{ color: 'var(--cp-text-m)' }}>через</span>
                        <input
                          type="number"
                          min={0}
                          max={60}
                          value={step.wait_days}
                          onChange={(e) => updateStep(idx, { wait_days: Math.max(0, Math.min(60, Number(e.target.value) || 0)) })}
                          className="neu-input w-14 px-2 py-1.5 text-sm text-center"
                        />
                        <span className="text-xs" style={{ color: 'var(--cp-text-m)' }}>дн.</span>
                      </div>
                    )}
                    {sequenceSteps.length > 1 && (
                      <button type="button" onClick={() => removeStep(idx)} className="p-1.5 rounded-lg shrink-0" style={{ color: 'var(--cp-text-m)' }} aria-label="Удалить шаг">
                        <Trash2 className="h-4 w-4" />
                      </button>
                    )}
                  </div>
                  <textarea
                    value={step.body}
                    onChange={(e) => updateStep(idx, { body: e.target.value })}
                    placeholder="Текст письма (поддерживает HTML)"
                    rows={6}
                    className="neu-input w-full px-3 py-2 text-sm font-sans resize-y"
                  />
                </div>
              ))}
              <button type="button" onClick={addStep} className="neu-pill w-full py-3 text-sm font-semibold inline-flex items-center justify-center gap-2" style={{ color: 'var(--cp-accent)' }}>
                <Plus className="h-4 w-4" /> Добавить шаг
              </button>
            </div>
          </Section>
        )}

        {/* Step 4: Launch */}
        {fileHeaders.length > 0 && (
          <Section number={4} title="Запуск" subtitle="Кампания будет создана в Instantly и сразу же активирована.">
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
                    href={{ pathname: '/client/campaigns/[id]', query: { id: h.instantly_campaign_id } }}
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
        <div className="neu-well flex h-7 w-7 items-center justify-center text-xs font-bold shrink-0" style={{ color: 'var(--cp-accent)' }}>
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
  onChange,
}: {
  label: string;
  required?: boolean;
  headers: string[];
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <div>
      <label className="text-xs font-semibold block mb-1.5" style={{ color: 'var(--cp-text-m)' }}>
        {label} {required && <span style={{ color: 'var(--cp-danger)' }}>*</span>}
      </label>
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
