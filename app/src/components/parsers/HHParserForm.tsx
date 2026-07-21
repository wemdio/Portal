'use client';

import { useMemo, useState } from 'react';
import { Info, Play, Loader2, Briefcase } from 'lucide-react';
import type { HHSearchConfig } from '@/types';
import { hasHhSearchTerms, shouldUseStrictHhTitleMatch } from '@/lib/parsers/hhRelevance';
import { RegionPicker } from './RegionPicker';

type Props = {
  onStart: (config: HHSearchConfig) => Promise<void>;
  busy: boolean;
  /** Client portal: render the simplified, jargon-free form. Operators keep the full one. */
  clientMode?: boolean;
};

function parseArea(value: string): string | string[] | undefined {
  const cleaned = value.trim();
  if (!cleaned) return undefined;
  if (cleaned.includes(',')) {
    const parts = cleaned.split(',').map((p) => p.trim()).filter(Boolean);
    return parts.length > 0 ? parts : undefined;
  }
  return cleaned;
}

function formatDateInput(value: string) {
  const digits = value.replace(/\D/g, '').slice(0, 8);
  const year = digits.slice(0, 4);
  const month = digits.slice(4, 6);
  const day = digits.slice(6, 8);

  let result = year;
  if (digits.length >= 4) result += '-';
  if (month) result += month;
  if (digits.length >= 6) result += '-';
  if (day) result += day;
  return result;
}

type LinkParseResult = {
  config?: HHSearchConfig;
  error?: string;
  extraKeys?: string[];
};

function parseNumberParam(value: string | null): number | undefined {
  if (!value) return undefined;
  const normalized = value.replace(/\s/g, '');
  const num = Number(normalized);
  return Number.isFinite(num) ? num : undefined;
}

function normalizeDateParam(value: string | null): string | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  const match = trimmed.match(/\d{4}-\d{2}-\d{2}/);
  return match ? match[0] : trimmed;
}

function parseAreaParams(params: URLSearchParams): string | string[] | undefined {
  const all = params
    .getAll('area')
    .flatMap((entry) => entry.split(','))
    .map((entry) => entry.trim())
    .filter(Boolean);

  if (all.length === 0) return undefined;
  return all.length === 1 ? all[0] : all;
}

function paramsToRecord(params: URLSearchParams): Record<string, string | string[]> | undefined {
  const record: Record<string, string | string[]> = {};
  params.forEach((value, key) => {
    const existing = record[key];
    if (existing === undefined) {
      record[key] = value;
      return;
    }
    if (Array.isArray(existing)) {
      existing.push(value);
      return;
    }
    record[key] = [existing, value];
  });

  return Object.keys(record).length > 0 ? record : undefined;
}

function extractHhSubdomain(hostname: string): string | undefined {
  const match = hostname.match(/^(.+)\.hh\.ru$/i);
  return match ? match[1].toLowerCase() : undefined;
}

function parseHhSearchLink(value: string): LinkParseResult {
  const raw = value.trim();
  if (!raw) return {};

  const withScheme = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    return { error: 'Неверный формат ссылки.' };
  }

  if (!url.hostname.endsWith('hh.ru')) {
    return { error: 'Ссылка должна вести на hh.ru.' };
  }

  if (!url.pathname.includes('/search/vacancy')) {
    return { error: 'Нужна ссылка на поиск вакансий (/search/vacancy).' };
  }

  const params = url.searchParams;
  const text = (params.get('text') ?? '').trim();
  const subdomain = extractHhSubdomain(url.hostname);

  const area = parseAreaParams(params);
  const salaryFrom = parseNumberParam(params.get('salary') ?? params.get('salary_from'));
  const currency = (params.get('currency') ?? params.get('currency_code') ?? '').trim() || undefined;
  const date_from = normalizeDateParam(params.get('date_from'));
  const date_to = normalizeDateParam(params.get('date_to'));
  const per_page = parseNumberParam(params.get('per_page') ?? params.get('items_on_page'));

  const knownKeys = new Set([
    'text',
    'area',
    'salary',
    'salary_from',
    'currency',
    'date_from',
    'date_to',
    'per_page',
    'items_on_page',
    'page',
  ]);
  const extraKeys = Array.from(new Set(Array.from(params.keys()).filter((key) => !knownKeys.has(key))));
  const paramsRecord = paramsToRecord(params);

  return {
    config: {
      text,
      area,
      salary_from: salaryFrom,
      currency,
      date_from,
      date_to,
      per_page,
      subdomain,
      params: paramsRecord,
    },
    extraKeys: extraKeys.length > 0 ? extraKeys : undefined,
  };
}

export function HHParserForm({ onStart, busy, clientMode }: Props) {
  // Clients default to the friendly fields; operators keep the link-first flow.
  const [mode, setMode] = useState<'link' | 'manual'>(clientMode ? 'manual' : 'link');
  const [searchLink, setSearchLink] = useState('');
  const [text, setText] = useState('');
  const [area, setArea] = useState('');
  // clientMode region selection (area ids). Empty = all Russia (113), per HH default.
  const [areas, setAreas] = useState<string[]>([]);
  const [salaryFrom, setSalaryFrom] = useState('');
  const [currency, setCurrency] = useState('RUR');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [perPage, setPerPage] = useState('50');
  const [showHowItWorks, setShowHowItWorks] = useState(false);

  const manualConfig: HHSearchConfig = useMemo(() => {
    const salary_from = salaryFrom.trim() ? Number(salaryFrom) : undefined;
    const per_page = perPage.trim() ? Number(perPage) : undefined;

    return {
      text,
      area: parseArea(area),
      salary_from: Number.isFinite(salary_from) ? salary_from : undefined,
      currency: currency || undefined,
      date_from: dateFrom || undefined,
      date_to: dateTo || undefined,
      per_page: Number.isFinite(per_page) ? per_page : undefined,
      fetch_employers: true,
      strict_title_match: shouldUseStrictHhTitleMatch(text),
    };
  }, [area, currency, dateFrom, dateTo, perPage, salaryFrom, text]);

  const linkParse = useMemo(() => parseHhSearchLink(searchLink), [searchLink]);
  const linkConfig = linkParse.config;
  const linkError = linkParse.error;
  const linkReady = Boolean(linkConfig && !linkError);

  const canStart = mode === 'link' ? linkReady : hasHhSearchTerms(text);
  const activeConfig = useMemo(() => {
    if (mode === 'link') {
      return linkConfig ? { ...linkConfig, fetch_employers: true } : undefined;
    }
    return { ...manualConfig, fetch_employers: true };
  }, [linkConfig, manualConfig, mode]);

  // Client form config: just role text + picked regions. No URL paste, no
  // salary/date/per-page knobs.
  const clientConfig: HHSearchConfig = useMemo(
    () => ({
      text,
      area: areas.length === 0 ? undefined : areas.length === 1 ? areas[0] : areas,
      fetch_employers: true,
      strict_title_match: shouldUseStrictHhTitleMatch(text),
    }),
    [text, areas],
  );

  // Client portal: a small, jargon-free form. The operator form defaults to
  // pasting a raw HH.ru URL or typing an "area id"; both are hostile to a
  // non-technical client. Here: friendly fields by default, plus the link
  // option kept (clients asked for it) behind a toggle. Operators untouched.
  if (clientMode) {
    const manualReady = hasHhSearchTerms(text);
    const ready = mode === 'link' ? linkReady : manualReady;
    const cfg: HHSearchConfig | undefined =
      mode === 'link'
        ? (linkConfig ? { ...linkConfig, fetch_employers: true } : undefined)
        : clientConfig;
    const submit = () => {
      if (!busy && ready && cfg) void onStart(cfg);
    };

    return (
      <div className="neu-card p-5 sm:p-6">
        <div className="mb-4">
          <h2 className="text-base font-semibold m-0" style={{ color: 'var(--cp-paper)' }}>
            Найти компании по вакансиям
          </h2>
          <p className="mt-1 text-xs" style={{ color: 'var(--cp-paper-mute)' }}>
            Компании, которые сейчас нанимают, растут и имеют бюджет: хорошие цели для рассылки.
          </p>
        </div>

        {/* Two ways in: fill simple fields (default) or paste a ready HH.ru link. */}
        <div
          className="inline-flex rounded-md p-0.5 mb-4"
          style={{ background: 'var(--cp-surface-rest)', border: '1px solid var(--cp-divider)' }}
        >
          {([['manual', 'Заполнить поля'], ['link', 'Вставить ссылку HH.ru']] as const).map(([m, label]) => {
            const on = mode === m;
            return (
              <button
                key={m}
                type="button"
                onClick={() => setMode(m)}
                className="rounded px-3 py-1.5 text-xs font-medium transition-colors"
                style={on ? { background: 'var(--cp-paper)', color: 'var(--cp-ink)' } : { color: 'var(--cp-paper-mute)' }}
              >
                {label}
              </button>
            );
          })}
        </div>

        {mode === 'manual' ? (
          <div className="space-y-4">
            <div>
              <label className="ds-eyebrow mb-1.5 block">кого ищете</label>
              <input
                value={text}
                onChange={(e) => setText(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') submit(); }}
                placeholder="например: менеджер по продажам"
                className="ds-input w-full text-sm"
              />
              <p className="mt-1.5 text-[11px]" style={{ color: 'var(--cp-paper-faint)' }}>
                Роль или должность, по ней ищем открытые вакансии.
              </p>
            </div>
            <div>
              <label className="ds-eyebrow mb-1.5 block">регион</label>
              <RegionPicker value={areas} onChange={setAreas} clientMode />
            </div>
          </div>
        ) : (
          <div className="space-y-2">
            <label className="ds-eyebrow block">ссылка на поиск hh.ru</label>
            <input
              value={searchLink}
              onChange={(e) => setSearchLink(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') submit(); }}
              placeholder="https://hh.ru/search/vacancy?text=…"
              className="ds-input w-full text-sm"
            />
            <p className="text-[11px]" style={{ color: 'var(--cp-paper-faint)' }}>
              Откройте нужный поиск на hh.ru и скопируйте ссылку из адресной строки браузера.
            </p>
            {linkError ? (
              <p className="text-[11px]" style={{ color: 'var(--cp-red)' }}>{linkError}</p>
            ) : linkConfig ? (
              <p className="ds-mono text-[11px]" style={{ color: 'var(--cp-paper-mute)' }}>
                распознано: «{linkConfig.text || 'без запроса'}»
                {linkConfig.area
                  ? `, регион ${Array.isArray(linkConfig.area) ? linkConfig.area.join(', ') : linkConfig.area}`
                  : ''}
              </p>
            ) : null}
          </div>
        )}

        <div className="flex flex-wrap items-center gap-3 pt-4">
          <button
            type="button"
            onClick={submit}
            disabled={busy || !ready}
            className="ds-btn-primary inline-flex items-center gap-2 px-5 disabled:opacity-40"
          >
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
            Запустить
          </button>
          <span className="text-xs" style={{ color: 'var(--cp-paper-faint)' }}>
            На выходе: компании с сайтами и описанием.
          </span>
        </div>
      </div>
    );
  }

  return (
    <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-6" style={{ borderTop: '3px solid #6366F1' }}>
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-lg font-semibold text-gray-900 flex items-center gap-2">
            <span className="inline-flex items-center justify-center w-7 h-7 rounded-lg bg-indigo-100 text-indigo-600">
              <Briefcase className="h-4 w-4" />
            </span>
            HH.ru парсер
          </h2>
          <p className="text-sm text-gray-500 mt-1">Запуск поиска вакансий через официальный API HH.ru.</p>
        </div>
        <div className="flex flex-col items-end gap-2">
          {mode === 'manual' ? (
            <button
              onClick={() => (activeConfig ? onStart(activeConfig) : undefined)}
              disabled={busy || !canStart}
              className="inline-flex items-center rounded-xl bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
            >
              {busy ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Play className="h-4 w-4 mr-2" />}
              Запустить
            </button>
          ) : null}
          <button
            type="button"
            onClick={() => setShowHowItWorks(true)}
            className="inline-flex items-center rounded-full bg-amber-50 px-2.5 py-1 text-[11px] font-medium text-amber-800 border border-amber-200 hover:bg-amber-100 hover:border-amber-300 focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-400 focus-visible:ring-offset-1"
          >
            <Info className="h-3.5 w-3.5 mr-1" />
            <span>Как работает парсер</span>
          </button>
        </div>
      </div>

      <div className="mt-5 flex flex-wrap items-center gap-3">
        <div className="inline-flex rounded-lg border border-gray-200 bg-gray-50 p-1">
          <button
            type="button"
            onClick={() => setMode('link')}
            className={`px-3 py-1.5 text-sm rounded-md font-medium transition ${
              mode === 'link' ? 'parser-mode-active bg-indigo-600 text-white shadow-sm' : 'text-gray-500 hover:text-gray-900'
            }`}
          >
            По ссылке HH.ru
          </button>
          <button
            type="button"
            onClick={() => setMode('manual')}
            className={`px-3 py-1.5 text-sm rounded-md font-medium transition ${
              mode === 'manual' ? 'parser-mode-active bg-indigo-600 text-white shadow-sm' : 'text-gray-500 hover:text-gray-900'
            }`}
          >
            Ручной ввод
          </button>
        </div>
      </div>

      {mode === 'link' ? (
        <div className="mt-6 space-y-3">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Ссылка поиска HH.ru*</label>
            <div className="flex items-center gap-2">
              <div className="relative w-full">
                <input
                  value={searchLink}
                  onChange={(e) => setSearchLink(e.target.value)}
                  className="w-full rounded-lg border border-gray-300 px-3 py-2 pr-9 text-sm focus:outline-none focus:ring-1 focus:ring-blue-400 focus:border-blue-400"
                  placeholder="https://spb.hh.ru/search/vacancy?text=маркетолог&area=2"
                />
                <button
                  type="button"
                  onClick={() => setSearchLink('')}
                  disabled={!searchLink}
                  aria-label="Очистить"
                  className="absolute right-2 top-1/2 -translate-y-1/2 rounded-full p-1 text-gray-400 hover:text-gray-600 disabled:opacity-50"
                >
                  ×
                </button>
              </div>
              <button
                onClick={() => (activeConfig ? onStart(activeConfig) : undefined)}
                disabled={busy || !canStart}
                className="inline-flex items-center rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
              >
                {busy ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Play className="h-4 w-4 mr-2" />}
                Запустить
              </button>
            </div>
            {linkError ? <div className="mt-2 text-xs text-red-600">{linkError}</div> : null}
          </div>

          {linkConfig && !linkError ? (
            <div className="rounded-lg border border-gray-200 bg-gray-50 p-3 text-xs text-gray-600">
              <div className="font-medium text-gray-700">Распознано из ссылки</div>
              <div className="mt-2 grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-2">
                <div>
                  <span className="text-gray-500">Запрос:</span> {linkConfig.text || '—'}
                </div>
                <div>
                  <span className="text-gray-500">Регион:</span>{' '}
                  {Array.isArray(linkConfig.area) ? linkConfig.area.join(', ') : (linkConfig.area ?? 'любой')}
                </div>
                <div>
                  <span className="text-gray-500">Зарплата от:</span> {linkConfig.salary_from ?? '—'}
                </div>
                <div>
                  <span className="text-gray-500">Валюта:</span> {linkConfig.currency ?? '—'}
                </div>
                <div>
                  <span className="text-gray-500">Дата от:</span> {linkConfig.date_from ?? '—'}
                </div>
                <div>
                  <span className="text-gray-500">Дата до:</span> {linkConfig.date_to ?? '—'}
                </div>
                <div>
                  <span className="text-gray-500">Per page:</span> {linkConfig.per_page ?? '—'}
                </div>
              </div>
              {linkParse.extraKeys?.length ? (
                <div className="mt-2 text-xs text-gray-600">
                  Доп. параметры (также будут учтены): {linkParse.extraKeys.join(', ')}
                </div>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : (
        <>
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4 mt-6">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Текст поиска *</label>
              <input
                value={text}
                onChange={(e) => setText(e.target.value)}
                className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-blue-400 focus:border-blue-400"
                placeholder="например: sales, маркетолог, b2b"
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Регион (area id)</label>
              <input
                value={area}
                onChange={(e) => setArea(e.target.value)}
                className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-blue-400 focus:border-blue-400"
                placeholder="например: 1 или 1,2,3"
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Зарплата от</label>
              <input
                value={salaryFrom}
                onChange={(e) => setSalaryFrom(e.target.value)}
                inputMode="numeric"
                className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-blue-400 focus:border-blue-400"
                placeholder="например: 150000"
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Валюта</label>
              <select
                value={currency}
                onChange={(e) => setCurrency(e.target.value)}
                className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-blue-400 focus:border-blue-400 bg-white"
              >
                <option value="RUR">RUR</option>
                <option value="USD">USD</option>
                <option value="EUR">EUR</option>
              </select>
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Дата от (YYYY-MM-DD)</label>
              <input
                value={dateFrom}
                onChange={(e) => setDateFrom(formatDateInput(e.target.value))}
                inputMode="numeric"
                maxLength={10}
                className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-blue-400 focus:border-blue-400"
                placeholder="2026-01-01"
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Дата до (YYYY-MM-DD)</label>
              <input
                value={dateTo}
                onChange={(e) => setDateTo(formatDateInput(e.target.value))}
                inputMode="numeric"
                maxLength={10}
                className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-blue-400 focus:border-blue-400"
                placeholder="2026-01-28"
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Per page</label>
              <input
                value={perPage}
                onChange={(e) => setPerPage(e.target.value)}
                inputMode="numeric"
                className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-blue-400 focus:border-blue-400"
                placeholder="50"
              />
            </div>
          </div>
        </>
      )}

      {showHowItWorks && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4">
          <div className="w-full max-w-lg rounded-2xl bg-white shadow-xl">
            <div className="px-6 py-5 border-b border-gray-100">
              <h3 className="text-lg font-semibold text-gray-900">Как работает HH.ru парсер</h3>
            </div>
            <div className="px-6 py-4 space-y-3 text-sm text-gray-700">
              <p>
                Парсер ходит в <span className="font-semibold">официальный API HH.ru</span> по заданным параметрам поиска
                и собирает вакансии вместе c данными о компаниях (employers).
              </p>
              <p>
                Есть два режима запуска:
                <span className="font-semibold"> по ссылке HH</span> (всю конфигурацию берём из URL поиска) или
                <span className="font-semibold"> ручной ввод</span> (вы задаёте текст, регионы, зарплату и даты).
              </p>
              <p>
                Для каждой вакансии инструмент подтягивает компанию, фильтрует дубликаты и строит результирующую базу:
                название компании, ссылка на страницу, город, метки из поиска и др.
              </p>
              <p>
                Чтобы получить <span className="font-semibold">релевантную выборку</span>:
              </p>
              <ul className="list-disc list-inside space-y-1 text-sm text-gray-700">
                <li>в запросе используйте конкретные роли и стек (например, «SDR b2b sales», а не просто «менеджер»);</li>
                <li>ограничивайте регионы (area) и период дат — так меньше шума и старых вакансий;</li>
                <li>не ставьте слишком большой per_page без необходимости — объём лучше добрать несколькими запусками.</li>
              </ul>
              <p className="text-xs text-gray-500 pt-1">
                Если парсер ругается на ссылку — убедитесь, что это страница /search/vacancy на hh.ru и параметры передаются
                в query-строке.
              </p>
            </div>
            <div className="flex items-center justify-end gap-3 border-t border-gray-100 px-6 py-4">
              <button
                type="button"
                onClick={() => setShowHowItWorks(false)}
                className="rounded-lg border border-gray-200 bg-white px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50"
              >
                Понятно
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

