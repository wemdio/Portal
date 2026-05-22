'use client';

import { useEffect, useMemo, useState } from 'react';
import { Building2, FileSpreadsheet, FileText, Search, X } from 'lucide-react';
import { Switch } from '@/components/Switch';
import { supabase } from '@/lib/supabaseClient';
import { FEDERAL_DISTRICTS, ALL_REGION_CODES } from '@/lib/companiesSearch/regions';
import { OkvedTreeModal } from '@/components/OkvedTreeModal';
import { reduceToTopCodes } from '@/lib/companiesSearch/okved2';
import type { Locale } from '@/lib/i18n';

type Mode = 'activity' | 'inn';
type L = Locale;

// Falls back to Russian for any non-EN locale; the runtime translator
// then converts to DE/FR/ES/IT via the LLM cache.
const t = (ru: string, en: string, locale: L) => (locale === 'en' ? en : ru);

const LEGAL_FORMS = [
  { code: 'ООО', label: 'ООО' },
  { code: 'АО', label: 'АО' },
  { code: 'ПАО', label: 'ПАО' },
  { code: 'НКО', label: 'НКО' },
];

function useLocale(): L {
  const [locale, setLocale] = useState<L>('ru');
  useEffect(() => {
    const update = () => {
      const lang = document.documentElement.lang;
      setLocale(lang === 'en' ? 'en' : 'ru');
    };
    update();
    const observer = new MutationObserver(update);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['lang'] });
    return () => observer.disconnect();
  }, []);
  return locale;
}

export default function CompaniesSearchPage() {
  const locale = useLocale();
  const [mode, setMode] = useState<Mode>('activity');

  const [regionsModalOpen, setRegionsModalOpen] = useState(false);
  const [okvedModalOpen, setOkvedModalOpen] = useState(false);
  const [selectedRegions, setSelectedRegions] = useState<Set<string>>(
    new Set(ALL_REGION_CODES),
  );
  const [selectedOkveds, setSelectedOkveds] = useState<Set<string>>(new Set());
  const [innList, setInnList] = useState('');

  const [hasPhone, setHasPhone] = useState(false);
  const [hasEmail, setHasEmail] = useState(false);
  const [legalForm, setLegalForm] = useState<string>('');
  const [employeesFrom, setEmployeesFrom] = useState('');
  const [employeesTo, setEmployeesTo] = useState('');
  const [revenueFrom, setRevenueFrom] = useState('');
  const [revenueTo, setRevenueTo] = useState('');
  const [costFrom, setCostFrom] = useState('');
  const [costTo, setCostTo] = useState('');
  const [hasWebsite, setHasWebsite] = useState(false);
  const [hasEdo, setHasEdo] = useState(false);
  const [hasEgais, setHasEgais] = useState(false);

  const [includeIp, setIncludeIp] = useState(false);

  const [calcLoading, setCalcLoading] = useState(false);
  const [calcResult, setCalcResult] = useState<{ count: number; remaining: number } | null>(null);
  const [calcError, setCalcError] = useState<string | null>(null);

  const [exportLoading, setExportLoading] = useState<'csv' | 'xlsx' | null>(null);
  const [exportError, setExportError] = useState<string | null>(null);

  const selectedRegionsCount = selectedRegions.size;
  const selectedOkvedTopCount = useMemo(
    () => reduceToTopCodes(selectedOkveds).length,
    [selectedOkveds],
  );

  const buildFilters = () => {
    const parsedInnList =
      mode === 'inn'
        ? innList
            .split(/[\s,;]+/)
            .map((s) => s.trim())
            .filter((s) => /^\d{10,12}$/.test(s))
        : undefined;

    return {
      regionCodes:
        mode === 'activity' && selectedRegionsCount !== ALL_REGION_CODES.length
          ? Array.from(selectedRegions)
          : undefined,
      okvedCodes:
        mode === 'activity' && selectedOkveds.size > 0
          ? Array.from(selectedOkveds)
          : undefined,
      hasPhone,
      hasEmail,
      legalForms: legalForm ? [legalForm] : undefined,
      employeesFrom: employeesFrom ? Number(employeesFrom) : null,
      employeesTo: employeesTo ? Number(employeesTo) : null,
      revenueFrom: revenueFrom ? Number(revenueFrom) : null,
      revenueTo: revenueTo ? Number(revenueTo) : null,
      costFrom: costFrom ? Number(costFrom) : null,
      costTo: costTo ? Number(costTo) : null,
      hasWebsite,
      hasEdo,
      hasEgais,
      includeIp,
      innList: parsedInnList && parsedInnList.length > 0 ? parsedInnList : undefined,
    };
  };

  const handleCalculate = async () => {
    setCalcLoading(true);
    setCalcError(null);
    setCalcResult(null);

    try {
      const { data: { session } } = await supabase.auth.getSession();
      const token = session?.access_token;
      if (!token) {
        setCalcError(t('Требуется авторизация', 'Authorization required', locale));
        setCalcLoading(false);
        return;
      }

      const res = await fetch('/api/client/companies-search', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ ...buildFilters(), countOnly: true }),
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: t('Ошибка', 'Error', locale) }));
        setCalcError(err.error || `HTTP ${res.status}`);
        setCalcLoading(false);
        return;
      }

      const data = (await res.json()) as { count: number; remaining: number };
      setCalcResult({ count: data.count, remaining: data.remaining });
    } catch (err) {
      setCalcError(err instanceof Error ? err.message : t('Ошибка', 'Error', locale));
    } finally {
      setCalcLoading(false);
    }
  };

  const handleExport = async (format: 'csv' | 'xlsx') => {
    setExportLoading(format);
    setExportError(null);

    try {
      const { data: { session } } = await supabase.auth.getSession();
      const token = session?.access_token;
      if (!token) {
        setExportError(t('Требуется авторизация', 'Authorization required', locale));
        setExportLoading(null);
        return;
      }

      const res = await fetch(`/api/client/companies-search/export?format=${format}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(buildFilters()),
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: t('Ошибка', 'Error', locale) }));
        setExportError(err.error || `HTTP ${res.status}`);
        setExportLoading(null);
        return;
      }

      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `companies_${new Date().toISOString().slice(0, 10)}.${format}`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (err) {
      setExportError(err instanceof Error ? err.message : t('Ошибка', 'Error', locale));
    } finally {
      setExportLoading(null);
    }
  };

  return (
    <div className="max-w-6xl mx-auto space-y-6 pb-20">
      <header>
        <p className="ds-eyebrow mb-2">
          <Building2 className="inline-block h-3 w-3 mr-1" aria-hidden />
          {t('Сбор баз', 'Database collection', locale)}
        </p>
        <h1
          className="text-xl sm:text-2xl font-bold m-0"
          style={{ color: 'var(--cp-paper)' }}
        >
          {t('B2B-поиск компаний', 'B2B company search', locale)}
        </h1>
        <p className="mt-1 text-xs sm:text-sm" style={{ color: 'var(--cp-paper-mute)' }}>
          {t(
            'Поиск российских юрлиц по ОКВЭД, регионам, выручке и контактам. Экспорт в CSV/XLSX.',
            'Russian legal entities by activity, region, revenue, and contacts. CSV/XLSX export.',
            locale,
          )}
        </p>
      </header>

      {/* ── 01 → Регионы и виды деятельности ─────────────────────────── */}
      <section className="neu-card p-5 sm:p-6">
        <div className="flex items-center gap-4 mb-5">
          <button
            type="button"
            onClick={() => setMode('activity')}
            className={`ds-nav-item px-3 py-1.5 text-xs ${mode === 'activity' ? 'active' : ''}`}
            aria-current={mode === 'activity' ? 'page' : undefined}
          >
            {t('По видам деятельности', 'By activity type', locale)}
          </button>
          <button
            type="button"
            onClick={() => setMode('inn')}
            className={`ds-nav-item px-3 py-1.5 text-xs ${mode === 'inn' ? 'active' : ''}`}
            aria-current={mode === 'inn' ? 'page' : undefined}
          >
            {t('По списку ИНН', 'By TIN list', locale)}
          </button>
        </div>

        <p className="ds-eyebrow mb-3">
          01<span aria-hidden> → </span>
          {t('Регионы и виды деятельности', 'Regions and activity types', locale)}
        </p>

        {mode === 'activity' ? (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <button
              type="button"
              onClick={() => setRegionsModalOpen(true)}
              className="ds-card-pressable flex items-center gap-3 w-full rounded-md px-5 py-4 text-left"
              style={{
                background: 'var(--cp-surface-rest)',
                border: '1px solid var(--cp-divider)',
              }}
            >
              <svg
                className="w-5 h-5 shrink-0"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                strokeWidth={1.5}
                style={{ color: 'var(--cp-paper-faint)' }}
                aria-hidden
              >
                <path strokeLinecap="round" strokeLinejoin="round" d="M15 10.5a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z" />
                <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 10.5c0 7.142-7.5 11.25-7.5 11.25S4.5 17.642 4.5 10.5a7.5 7.5 0 1 1 15 0Z" />
              </svg>
              <div className="flex-1 min-w-0">
                <div className="text-sm font-semibold" style={{ color: 'var(--cp-paper)' }}>
                  {t('Регионы', 'Regions', locale)}
                </div>
                <div className="ds-mono text-[11px] mt-0.5" style={{ color: 'var(--cp-paper-faint)' }}>
                  {selectedRegionsCount === ALL_REGION_CODES.length
                    ? t('все регионы РФ', 'all regions selected', locale)
                    : selectedRegionsCount === 0
                      ? t('не выбран ни один регион', 'no regions selected', locale)
                      : t(`выбрано: ${selectedRegionsCount}`, `selected: ${selectedRegionsCount}`, locale)}
                </div>
              </div>
              <svg
                className="w-4 h-4 shrink-0"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                strokeWidth={2}
                style={{ color: 'var(--cp-paper-faint)' }}
                aria-hidden
              >
                <path strokeLinecap="round" strokeLinejoin="round" d="m19.5 8.25-7.5 7.5-7.5-7.5" />
              </svg>
            </button>

            <button
              type="button"
              onClick={() => setOkvedModalOpen(true)}
              className="ds-card-pressable flex items-center gap-3 w-full rounded-md px-5 py-4 text-left"
              style={{
                background: 'var(--cp-surface-rest)',
                border: '1px solid var(--cp-divider)',
              }}
            >
              <svg
                className="w-5 h-5 shrink-0"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                strokeWidth={1.5}
                style={{ color: 'var(--cp-paper-faint)' }}
                aria-hidden
              >
                <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 12h16.5m-16.5 3.75h16.5M3.75 19.5h16.5M5.625 4.5h12.75a1.875 1.875 0 0 1 0 3.75H5.625a1.875 1.875 0 0 1 0-3.75Z" />
              </svg>
              <div className="flex-1 min-w-0">
                <div className="text-sm font-semibold" style={{ color: 'var(--cp-paper)' }}>
                  {t('Виды деятельности (ОКВЭД)', 'Activity types (OKVED)', locale)}
                </div>
                <div className="ds-mono text-[11px] mt-0.5" style={{ color: 'var(--cp-paper-faint)' }}>
                  {selectedOkveds.size === 0
                    ? t('все виды деятельности', 'all activity types', locale)
                    : t(
                        `выбрано: ${selectedOkveds.size}${selectedOkvedTopCount !== selectedOkveds.size ? ` (${selectedOkvedTopCount} групп)` : ''}`,
                        `selected: ${selectedOkveds.size}${selectedOkvedTopCount !== selectedOkveds.size ? ` (${selectedOkvedTopCount} groups)` : ''}`,
                        locale,
                      )}
                </div>
              </div>
              <svg
                className="w-4 h-4 shrink-0"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                strokeWidth={2}
                style={{ color: 'var(--cp-paper-faint)' }}
                aria-hidden
              >
                <path strokeLinecap="round" strokeLinejoin="round" d="m19.5 8.25-7.5 7.5-7.5-7.5" />
              </svg>
            </button>
          </div>
        ) : (
          <div>
            <label className="ds-eyebrow block mb-2">
              {t(
                'список ИНН (через запятую, пробел или с новой строки)',
                'TIN list (comma, space, or newline separated)',
                locale,
              )}
            </label>
            <textarea
              value={innList}
              onChange={(e) => setInnList(e.target.value)}
              className="ds-input w-full ds-mono"
              rows={6}
              placeholder="7710641442&#10;5017074592"
            />
          </div>
        )}
      </section>

      {/* ── 02 → Дополнительные фильтры ──────────────────────────────── */}
      <section className="neu-card p-5 sm:p-6">
        <p className="ds-eyebrow mb-4">
          02<span aria-hidden> → </span>
          {t('Дополнительные фильтры', 'Additional filters', locale)}
        </p>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-x-12 gap-y-6">
          <div className="space-y-6">
            <div>
              <p className="ds-eyebrow mb-2">{t('контакты', 'contacts', locale)}</p>
              <div className="flex flex-wrap gap-6">
                <Switch
                  checked={hasPhone}
                  onCheckedChange={setHasPhone}
                  label={
                    <span className="text-sm" style={{ color: 'var(--cp-paper)' }}>
                      {t('Указан телефон', 'Has phone', locale)}
                    </span>
                  }
                />
                <Switch
                  checked={hasEmail}
                  onCheckedChange={setHasEmail}
                  label={
                    <span className="text-sm" style={{ color: 'var(--cp-paper)' }}>
                      {t('Указан email', 'Has email', locale)}
                    </span>
                  }
                />
              </div>
            </div>

            <div>
              <p className="ds-eyebrow mb-2">{t('организационно-правовая форма', 'legal form', locale)}</p>
              <select
                value={legalForm}
                onChange={(e) => setLegalForm(e.target.value)}
                className="ds-input w-full text-sm"
              >
                <option value="">{t('Все организации', 'All organizations', locale)}</option>
                {LEGAL_FORMS.map((f) => (
                  <option key={f.code} value={f.code}>
                    {f.label}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <p className="ds-eyebrow mb-2">{t('численность сотрудников', 'number of employees', locale)}</p>
              <div className="grid grid-cols-2 gap-3">
                <div className="flex items-center gap-2">
                  <span
                    className="ds-mono text-[11px]"
                    style={{ color: 'var(--cp-paper-faint)' }}
                  >
                    {t('от', 'from', locale)}
                  </span>
                  <input
                    type="number"
                    min={0}
                    value={employeesFrom}
                    onChange={(e) => setEmployeesFrom(e.target.value)}
                    className="ds-input flex-1 text-sm"
                    placeholder="0"
                  />
                </div>
                <div className="flex items-center gap-2">
                  <span
                    className="ds-mono text-[11px]"
                    style={{ color: 'var(--cp-paper-faint)' }}
                  >
                    {t('до', 'to', locale)}
                  </span>
                  <input
                    type="number"
                    min={0}
                    value={employeesTo}
                    onChange={(e) => setEmployeesTo(e.target.value)}
                    className="ds-input flex-1 text-sm"
                  />
                </div>
              </div>
            </div>

            <div>
              <p className="ds-eyebrow mb-2">{t('дополнительные данные', 'additional data', locale)}</p>
              <div className="flex flex-col gap-2">
                <Switch
                  checked={hasWebsite}
                  onCheckedChange={setHasWebsite}
                  label={
                    <span className="text-sm" style={{ color: 'var(--cp-paper)' }}>
                      {t('Есть сайт', 'Has website', locale)}
                    </span>
                  }
                />
                <Switch
                  checked={hasEdo}
                  onCheckedChange={setHasEdo}
                  label={
                    <span className="text-sm" style={{ color: 'var(--cp-paper)' }}>
                      {t('Есть идентификатор ЭДО', 'Has EDI ID', locale)}
                    </span>
                  }
                />
                <Switch
                  checked={hasEgais}
                  onCheckedChange={setHasEgais}
                  label={
                    <span className="text-sm" style={{ color: 'var(--cp-paper)' }}>
                      {t('Есть ЕГАИС', 'Has EGAIS', locale)}
                    </span>
                  }
                />
              </div>
            </div>
          </div>

          <div className="space-y-6">
            <div>
              <p className="ds-eyebrow mb-2">{t('выручка, руб.', 'revenue, RUB', locale)}</p>
              <div className="flex items-center gap-2">
                <span
                  className="ds-mono text-[11px]"
                  style={{ color: 'var(--cp-paper-faint)' }}
                >
                  {t('от', 'from', locale)}
                </span>
                <input
                  type="number"
                  min={0}
                  value={revenueFrom}
                  onChange={(e) => setRevenueFrom(e.target.value)}
                  className="ds-input flex-1 text-sm"
                />
                <span
                  className="ds-mono text-[11px]"
                  style={{ color: 'var(--cp-paper-faint)' }}
                >
                  {t('до', 'to', locale)}
                </span>
                <input
                  type="number"
                  min={0}
                  value={revenueTo}
                  onChange={(e) => setRevenueTo(e.target.value)}
                  className="ds-input flex-1 text-sm"
                />
              </div>
            </div>

            <div>
              <p className="ds-eyebrow mb-2">
                {t('стоимость организации, руб.', 'company cost, RUB', locale)}
              </p>
              <div className="flex items-center gap-2">
                <span
                  className="ds-mono text-[11px]"
                  style={{ color: 'var(--cp-paper-faint)' }}
                >
                  {t('от', 'from', locale)}
                </span>
                <input
                  type="number"
                  min={0}
                  value={costFrom}
                  onChange={(e) => setCostFrom(e.target.value)}
                  className="ds-input flex-1 text-sm"
                />
                <span
                  className="ds-mono text-[11px]"
                  style={{ color: 'var(--cp-paper-faint)' }}
                >
                  {t('до', 'to', locale)}
                </span>
                <input
                  type="number"
                  min={0}
                  value={costTo}
                  onChange={(e) => setCostTo(e.target.value)}
                  className="ds-input flex-1 text-sm"
                />
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* ── 03 → Данные по ИП ────────────────────────────────────────── */}
      <section className="neu-card p-5 sm:p-6">
        <p className="ds-eyebrow mb-3">
          03<span aria-hidden> → </span>
          {t('Данные по ИП', 'Individual entrepreneurs', locale)}
        </p>
        <Switch
          checked={includeIp}
          onCheckedChange={setIncludeIp}
          label={
            <span className="text-sm font-medium" style={{ color: 'var(--cp-paper)' }}>
              {t(
                'Добавить данные по индивидуальным предпринимателям',
                'Include individual entrepreneurs',
                locale,
              )}
            </span>
          }
        />
        <p className="text-xs mt-3 leading-relaxed" style={{ color: 'var(--cp-paper-mute)' }}>
          {t(
            'Для ИП доступны только базовые поля (название, ИНН, адрес, контакты).',
            'For individual entrepreneurs, only basic fields are available (name, TIN, address, contacts).',
            locale,
          )}
        </p>
      </section>

      {/* ── Action: calculate + download ─────────────────────────────── */}
      <div className="flex flex-col items-center gap-4">
        <button
          type="button"
          onClick={handleCalculate}
          disabled={calcLoading}
          className="ds-btn-primary px-12 py-4 text-base disabled:opacity-60"
        >
          {calcLoading
            ? t('Считаем…', 'Calculating…', locale)
            : t('Собрать базу', 'Build database', locale)}
        </button>

        {calcError && (
          <div className="flex items-start gap-2.5 text-sm">
            <span
              aria-hidden
              className="ds-status-dot shrink-0"
              style={{ background: 'var(--cp-red)', marginTop: '7px' }}
            />
            <span style={{ color: 'var(--cp-paper)' }}>{calcError}</span>
          </div>
        )}

        {calcResult && (
          <div className="text-center">
            <div className="text-sm" style={{ color: 'var(--cp-paper-mute)' }}>
              {t('Найдено компаний: ', 'Companies found: ', locale)}
              <span
                className="ds-mono font-bold text-lg"
                style={{ color: 'var(--cp-paper)' }}
              >
                {calcResult.count.toLocaleString(locale === 'en' ? 'en-US' : 'ru-RU')}
              </span>
              {calcResult.count > 0 && (
                <span
                  className="ds-mono text-xs ml-2"
                  style={{ color: 'var(--cp-paper-faint)' }}
                >
                  ({t(
                    `остаток по тарифу после скачивания: ${Math.max(0, calcResult.remaining - calcResult.count).toLocaleString('ru-RU')}`,
                    `remaining after download: ${Math.max(0, calcResult.remaining - calcResult.count).toLocaleString('en-US')}`,
                    locale,
                  )})
                </span>
              )}
            </div>
          </div>
        )}

        {calcResult && calcResult.count > 0 && (
          <div className="neu-card p-6 w-full max-w-lg">
            <p className="ds-eyebrow text-center mb-4">
              {t('скачать базу', 'download database', locale)}
            </p>
            <div className="grid grid-cols-2 gap-3">
              <button
                type="button"
                onClick={() => handleExport('xlsx')}
                disabled={exportLoading !== null}
                className="ds-card-pressable flex flex-col items-center gap-2 rounded-md px-4 py-4 disabled:opacity-60"
                style={{
                  background: 'var(--cp-surface-rest)',
                  border: '1px solid var(--cp-divider)',
                }}
              >
                <FileSpreadsheet
                  className="h-7 w-7"
                  style={{ color: 'var(--cp-paper-faint)' }}
                  aria-hidden
                />
                <span
                  className="ds-mono text-xs font-semibold"
                  style={{ color: 'var(--cp-paper)' }}
                >
                  {exportLoading === 'xlsx'
                    ? t('Формируем…', 'Generating…', locale)
                    : 'XLSX'}
                </span>
                <span className="text-[11px]" style={{ color: 'var(--cp-paper-faint)' }}>
                  {t('Для работы в Excel', 'For Excel', locale)}
                </span>
              </button>

              <button
                type="button"
                onClick={() => handleExport('csv')}
                disabled={exportLoading !== null}
                className="ds-card-pressable flex flex-col items-center gap-2 rounded-md px-4 py-4 disabled:opacity-60"
                style={{
                  background: 'var(--cp-surface-rest)',
                  border: '1px solid var(--cp-divider)',
                }}
              >
                <FileText
                  className="h-7 w-7"
                  style={{ color: 'var(--cp-paper-faint)' }}
                  aria-hidden
                />
                <span
                  className="ds-mono text-xs font-semibold"
                  style={{ color: 'var(--cp-paper)' }}
                >
                  {exportLoading === 'csv'
                    ? t('Формируем…', 'Generating…', locale)
                    : 'CSV'}
                </span>
                <span className="text-[11px]" style={{ color: 'var(--cp-paper-faint)' }}>
                  {t('Универсальный формат', 'Universal format', locale)}
                </span>
              </button>
            </div>
            {exportError && (
              <div className="flex items-start gap-2.5 text-sm mt-3 justify-center">
                <span
                  aria-hidden
                  className="ds-status-dot shrink-0"
                  style={{ background: 'var(--cp-red)', marginTop: '7px' }}
                />
                <span style={{ color: 'var(--cp-paper)' }}>{exportError}</span>
              </div>
            )}
          </div>
        )}
      </div>

      {regionsModalOpen && (
        <RegionsModal
          locale={locale}
          selected={selectedRegions}
          onChange={setSelectedRegions}
          onClose={() => setRegionsModalOpen(false)}
        />
      )}
      {okvedModalOpen && (
        <OkvedTreeModal
          selected={selectedOkveds}
          onChange={setSelectedOkveds}
          onClose={() => setOkvedModalOpen(false)}
          locale={locale}
        />
      )}
    </div>
  );
}

// ── Regions modal ──────────────────────────────────────────────────────
function RegionsModal({
  locale,
  selected,
  onChange,
  onClose,
}: {
  locale: L;
  selected: Set<string>;
  onChange: (s: Set<string>) => void;
  onClose: () => void;
}) {
  const [search, setSearch] = useState('');
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const toggle = (code: string) => {
    const next = new Set(selected);
    if (next.has(code)) next.delete(code);
    else next.add(code);
    onChange(next);
  };

  const toggleDistrict = (districtName: string) => {
    const district = FEDERAL_DISTRICTS.find((d) => d.name === districtName);
    if (!district) return;
    const codes = district.regions.map((r) => r.code);
    const next = new Set(selected);
    const allSelected = codes.every((c) => next.has(c));
    if (allSelected) {
      for (const c of codes) next.delete(c);
    } else {
      for (const c of codes) next.add(c);
    }
    onChange(next);
  };

  const toggleExpand = (name: string) => {
    const next = new Set(expanded);
    if (next.has(name)) next.delete(name);
    else next.add(name);
    setExpanded(next);
  };

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return FEDERAL_DISTRICTS;
    return FEDERAL_DISTRICTS.map((d) => ({
      ...d,
      regions: d.regions.filter((r) => r.name.toLowerCase().includes(q)),
    })).filter((d) => d.regions.length > 0);
  }, [search]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div
        className="absolute inset-0"
        style={{ background: 'rgba(0, 0, 0, 0.6)' }}
        onClick={onClose}
      />
      <div
        className="relative rounded-lg max-w-2xl w-full max-h-[80vh] flex flex-col"
        style={{
          background: 'var(--cp-surface-elev)',
          border: '1px solid var(--cp-divider-strong)',
        }}
      >
        <div
          className="flex items-center justify-between px-6 pt-5 pb-3"
          style={{ borderBottom: '1px solid var(--cp-divider)' }}
        >
          <h3
            className="text-base font-semibold m-0"
            style={{ color: 'var(--cp-paper)' }}
          >
            {t('Регионы и города', 'Regions and cities', locale)}
          </h3>
          <button
            onClick={onClose}
            className="ds-btn-ghost inline-flex h-8 w-8 items-center justify-center px-0"
            aria-label={t('Закрыть', 'Close', locale)}
          >
            <X className="w-4 h-4" aria-hidden />
          </button>
        </div>
        <div className="px-6 py-4" style={{ borderBottom: '1px solid var(--cp-divider)' }}>
          <div className="relative">
            <Search
              className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4"
              style={{ color: 'var(--cp-paper-faint)' }}
              aria-hidden
            />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={t('Быстрый поиск', 'Quick search', locale)}
              className="ds-input w-full pl-9 text-sm"
            />
          </div>
        </div>
        <div className="flex-1 overflow-y-auto px-6 py-3">
          {filtered.map((district) => {
            const codes = district.regions.map((r) => r.code);
            const selectedCount = codes.filter((c) => selected.has(c)).length;
            const allSelected = selectedCount === codes.length && codes.length > 0;
            const isOpen = expanded.has(district.name);
            return (
              <div key={district.name} className="mb-0.5">
                <div className="flex items-center gap-2 py-1.5 px-1 -mx-1 rounded hover:bg-[var(--cp-surface-rest)] transition-colors">
                  <button
                    type="button"
                    onClick={() => toggleExpand(district.name)}
                    className="ds-mono w-6 h-6 flex items-center justify-center shrink-0"
                    style={{ color: 'var(--cp-paper-faint)' }}
                    aria-label={isOpen ? t('Свернуть', 'Collapse', locale) : t('Развернуть', 'Expand', locale)}
                  >
                    {isOpen ? '−' : '+'}
                  </button>
                  <input
                    type="checkbox"
                    checked={allSelected}
                    ref={(el) => {
                      if (el) el.indeterminate = !allSelected && selectedCount > 0;
                    }}
                    onChange={() => toggleDistrict(district.name)}
                    className="w-4 h-4 shrink-0"
                  />
                  <span className="text-sm font-medium" style={{ color: 'var(--cp-paper)' }}>
                    {district.name}
                  </span>
                </div>
                {isOpen && (
                  <div className="ml-12 mt-0.5 space-y-0.5">
                    {district.regions.map((r) => (
                      <label
                        key={r.code}
                        className="flex items-center gap-2 cursor-pointer py-1 px-1 -mx-1 rounded hover:bg-[var(--cp-surface-rest)] transition-colors"
                      >
                        <input
                          type="checkbox"
                          checked={selected.has(r.code)}
                          onChange={() => toggle(r.code)}
                          className="w-4 h-4 shrink-0"
                        />
                        <span
                          className="ds-mono text-[11px] font-semibold mr-1"
                          style={{ color: 'var(--cp-paper-faint)' }}
                        >
                          {r.code}
                        </span>
                        <span className="text-sm" style={{ color: 'var(--cp-paper)' }}>
                          {r.name}
                        </span>
                      </label>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
        <div
          className="flex items-center justify-between px-6 py-4"
          style={{ borderTop: '1px solid var(--cp-divider)' }}
        >
          <span
            className="ds-mono text-xs"
            style={{ color: 'var(--cp-paper-faint)' }}
          >
            {t(`выбрано: ${selected.size}`, `selected: ${selected.size}`, locale)}
          </span>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => onChange(new Set())}
              className="ds-btn-secondary px-4 py-2 text-sm"
            >
              {t('Очистить', 'Clear', locale)}
            </button>
            <button
              type="button"
              onClick={() => onChange(new Set(ALL_REGION_CODES))}
              className="ds-btn-secondary px-4 py-2 text-sm"
            >
              {t('Все', 'All', locale)}
            </button>
            <button
              type="button"
              onClick={onClose}
              className="ds-btn-primary px-6 py-2 text-sm"
            >
              {t('Готово', 'Done', locale)}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
