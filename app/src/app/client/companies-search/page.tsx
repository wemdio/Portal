'use client';

import { useEffect, useMemo, useState } from 'react';
import { Switch } from '@/components/Switch';
import { supabase } from '@/lib/supabaseClient';
import { FEDERAL_DISTRICTS, ALL_REGION_CODES } from '@/lib/companiesSearch/regions';
import { OkvedTreeModal } from '@/components/OkvedTreeModal';
import { reduceToTopCodes } from '@/lib/companiesSearch/okved2';

type Mode = 'activity' | 'inn';
type L = 'ru' | 'en';

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
        <h1 className="text-2xl sm:text-3xl font-extrabold text-gray-900">
          {t('B2B-поиск компаний', 'B2B company search', locale)}
        </h1>
        <p className="mt-2 text-sm sm:text-base text-gray-500">
          {t(
            'Поиск российских юрлиц по ОКВЭД, регионам, выручке и контактам. Экспорт в CSV/XLSX.',
            'Russian legal entities by activity, region, revenue, and contacts. CSV/XLSX export.',
            locale,
          )}
        </p>
      </header>

      {/* Step 1 */}
      <div className="bg-white rounded-xl shadow-sm p-6">
        <div className="flex items-center gap-6 mb-6 text-sm">
          <button
            type="button"
            onClick={() => setMode('activity')}
            className={`flex items-center gap-2 ${mode === 'activity' ? 'font-bold text-gray-900' : 'text-blue-600'}`}
          >
            {mode === 'activity' && <span className="text-green-600">✓</span>}
            {t('По видам деятельности', 'By activity type', locale)}
          </button>
          <button
            type="button"
            onClick={() => setMode('inn')}
            className={`flex items-center gap-2 ${mode === 'inn' ? 'font-bold text-gray-900' : 'text-blue-600'}`}
          >
            {mode === 'inn' && <span className="text-green-600">✓</span>}
            {t('По списку ИНН', 'By TIN list', locale)}
          </button>
        </div>

        <h2 className="text-xl font-bold mb-4">
          {t('1. Выберите регионы и виды деятельности', '1. Select regions and activity types', locale)}
        </h2>

        {mode === 'activity' ? (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            <button
              type="button"
              onClick={() => setRegionsModalOpen(true)}
              className="group flex items-center gap-3 w-full border border-gray-200 rounded-xl px-5 py-4 bg-white hover:border-blue-400 hover:shadow-sm transition-all text-left"
            >
              <div className="w-10 h-10 rounded-lg bg-blue-50 text-blue-600 flex items-center justify-center flex-shrink-0 group-hover:bg-blue-100 transition-colors">
                <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M15 10.5a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z" />
                  <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 10.5c0 7.142-7.5 11.25-7.5 11.25S4.5 17.642 4.5 10.5a7.5 7.5 0 1 1 15 0Z" />
                </svg>
              </div>
              <div className="flex-1 min-w-0">
                <div className="text-sm font-semibold text-gray-900">{t('Регионы', 'Regions', locale)}</div>
                <div className="text-xs text-gray-500 mt-0.5">
                  {selectedRegionsCount === ALL_REGION_CODES.length
                    ? t('Выбраны все регионы РФ', 'All regions selected', locale)
                    : selectedRegionsCount === 0
                      ? t('Не выбран ни один регион', 'No regions selected', locale)
                      : t(`Выбрано: ${selectedRegionsCount}`, `Selected: ${selectedRegionsCount}`, locale)}
                </div>
              </div>
              <svg className="w-5 h-5 text-gray-400 group-hover:text-blue-500 flex-shrink-0 transition-colors" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="m19.5 8.25-7.5 7.5-7.5-7.5" />
              </svg>
            </button>

            <button
              type="button"
              onClick={() => setOkvedModalOpen(true)}
              className="group flex items-center gap-3 w-full border border-gray-200 rounded-xl px-5 py-4 bg-white hover:border-blue-400 hover:shadow-sm transition-all text-left"
            >
              <div className="w-10 h-10 rounded-lg bg-amber-50 text-amber-600 flex items-center justify-center flex-shrink-0 group-hover:bg-amber-100 transition-colors">
                <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 12h16.5m-16.5 3.75h16.5M3.75 19.5h16.5M5.625 4.5h12.75a1.875 1.875 0 0 1 0 3.75H5.625a1.875 1.875 0 0 1 0-3.75Z" />
                </svg>
              </div>
              <div className="flex-1 min-w-0">
                <div className="text-sm font-semibold text-gray-900">{t('Виды деятельности (ОКВЭД)', 'Activity types (OKVED)', locale)}</div>
                <div className="text-xs text-gray-500 mt-0.5">
                  {selectedOkveds.size === 0
                    ? t('Все виды деятельности', 'All activity types', locale)
                    : t(
                        `Выбрано: ${selectedOkveds.size}${selectedOkvedTopCount !== selectedOkveds.size ? ` (${selectedOkvedTopCount} групп)` : ''}`,
                        `Selected: ${selectedOkveds.size}${selectedOkvedTopCount !== selectedOkveds.size ? ` (${selectedOkvedTopCount} groups)` : ''}`,
                        locale,
                      )}
                </div>
              </div>
              <svg className="w-5 h-5 text-gray-400 group-hover:text-blue-500 flex-shrink-0 transition-colors" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="m19.5 8.25-7.5 7.5-7.5-7.5" />
              </svg>
            </button>
          </div>
        ) : (
          <div>
            <label className="text-sm text-gray-600 mb-2 block">
              {t(
                'Список ИНН (через запятую, пробел или с новой строки):',
                'TIN list (comma, space, or newline separated):',
                locale,
              )}
            </label>
            <textarea
              value={innList}
              onChange={(e) => setInnList(e.target.value)}
              className="w-full border border-gray-300 rounded p-3 font-mono text-sm"
              rows={6}
              placeholder="7710641442&#10;5017074592"
            />
          </div>
        )}
      </div>

      {/* Step 2 */}
      <div className="bg-white rounded-xl shadow-sm p-6">
        <h2 className="text-xl font-bold mb-6">
          {t('2. Дополнительные фильтры', '2. Additional filters', locale)}
        </h2>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-x-12 gap-y-6">
          <div className="space-y-6">
            <div>
              <div className="text-sm font-semibold text-gray-700 mb-2">
                {t('Контакты', 'Contacts', locale)}
              </div>
              <div className="flex flex-wrap gap-6">
                <Switch
                  checked={hasPhone}
                  onCheckedChange={setHasPhone}
                  label={<span className="text-sm">{t('Указан телефон', 'Has phone', locale)}</span>}
                />
                <Switch
                  checked={hasEmail}
                  onCheckedChange={setHasEmail}
                  label={<span className="text-sm">{t('Указан email', 'Has email', locale)}</span>}
                />
              </div>
            </div>

            <div>
              <div className="text-sm font-semibold text-gray-700 mb-2">
                {t('Организационно-правовая форма', 'Legal form', locale)}
              </div>
              <select
                value={legalForm}
                onChange={(e) => setLegalForm(e.target.value)}
                className="w-full border border-gray-300 rounded px-3 py-2 text-sm bg-white"
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
              <div className="text-sm font-semibold text-gray-700 mb-2">
                {t('Численность сотрудников', 'Number of employees', locale)}
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div className="flex items-center gap-2">
                  <span className="text-sm text-gray-500">{t('От', 'From', locale)}</span>
                  <input
                    type="number"
                    min={0}
                    value={employeesFrom}
                    onChange={(e) => setEmployeesFrom(e.target.value)}
                    className="flex-1 border-b border-gray-300 px-2 py-1.5 text-sm focus:outline-none focus:border-blue-500"
                    placeholder="0"
                  />
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-sm text-gray-500">{t('до', 'to', locale)}</span>
                  <input
                    type="number"
                    min={0}
                    value={employeesTo}
                    onChange={(e) => setEmployeesTo(e.target.value)}
                    className="flex-1 border-b border-gray-300 px-2 py-1.5 text-sm focus:outline-none focus:border-blue-500"
                  />
                </div>
              </div>
            </div>

            <div>
              <div className="text-sm font-semibold text-gray-700 mb-2">
                {t('Дополнительные данные', 'Additional data', locale)}
              </div>
              <div className="flex flex-col gap-2">
                <Switch
                  checked={hasWebsite}
                  onCheckedChange={setHasWebsite}
                  label={<span className="text-sm">{t('Есть сайт', 'Has website', locale)}</span>}
                />
                <Switch
                  checked={hasEdo}
                  onCheckedChange={setHasEdo}
                  label={<span className="text-sm">{t('Есть идентификатор ЭДО', 'Has EDI ID', locale)}</span>}
                />
                <Switch
                  checked={hasEgais}
                  onCheckedChange={setHasEgais}
                  label={<span className="text-sm">{t('Есть ЕГАИС', 'Has EGAIS', locale)}</span>}
                />
              </div>
            </div>
          </div>

          <div className="space-y-6">
            <div>
              <div className="text-sm font-semibold text-gray-700 mb-2">
                {t('Выручка, руб.', 'Revenue, RUB', locale)}
              </div>
              <div className="flex items-center gap-2">
                <span className="text-sm text-gray-500">{t('От', 'From', locale)}</span>
                <input
                  type="number"
                  min={0}
                  value={revenueFrom}
                  onChange={(e) => setRevenueFrom(e.target.value)}
                  className="flex-1 border-b border-gray-300 px-2 py-1.5 text-sm focus:outline-none focus:border-blue-500"
                />
                <span className="text-sm text-gray-500">{t('до', 'to', locale)}</span>
                <input
                  type="number"
                  min={0}
                  value={revenueTo}
                  onChange={(e) => setRevenueTo(e.target.value)}
                  className="flex-1 border-b border-gray-300 px-2 py-1.5 text-sm focus:outline-none focus:border-blue-500"
                />
              </div>
            </div>

            <div>
              <div className="text-sm font-semibold text-gray-700 mb-2">
                {t('Стоимость организации, руб.', 'Company cost, RUB', locale)}
              </div>
              <div className="flex items-center gap-2">
                <span className="text-sm text-gray-500">{t('От', 'From', locale)}</span>
                <input
                  type="number"
                  min={0}
                  value={costFrom}
                  onChange={(e) => setCostFrom(e.target.value)}
                  className="flex-1 border-b border-gray-300 px-2 py-1.5 text-sm focus:outline-none focus:border-blue-500"
                />
                <span className="text-sm text-gray-500">{t('до', 'to', locale)}</span>
                <input
                  type="number"
                  min={0}
                  value={costTo}
                  onChange={(e) => setCostTo(e.target.value)}
                  className="flex-1 border-b border-gray-300 px-2 py-1.5 text-sm focus:outline-none focus:border-blue-500"
                />
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Step 3 */}
      <div className="bg-white rounded-xl shadow-sm p-6">
        <h2 className="text-xl font-bold mb-4">
          {t('3. Данные по ИП', '3. Individual entrepreneurs', locale)}
        </h2>
        <Switch
          checked={includeIp}
          onCheckedChange={setIncludeIp}
          label={
            <span className="text-sm font-medium">
              {t(
                'Добавить данные по индивидуальным предпринимателям',
                'Include individual entrepreneurs',
                locale,
              )}
            </span>
          }
        />
        <p className="text-xs text-gray-500 mt-4 leading-relaxed">
          {t(
            'Для ИП доступны только базовые поля (название, ИНН, адрес, контакты).',
            'For individual entrepreneurs, only basic fields are available (name, TIN, address, contacts).',
            locale,
          )}
        </p>
      </div>

      {/* Action */}
      <div className="flex flex-col items-center gap-4">
        <button
          type="button"
          onClick={handleCalculate}
          disabled={calcLoading}
          className="bg-yellow-400 hover:bg-yellow-500 disabled:opacity-60 text-gray-900 font-semibold px-12 py-4 rounded-md text-base shadow-sm transition-colors"
        >
          {calcLoading
            ? t('Считаем...', 'Calculating...', locale)
            : t('Собрать базу', 'Build database', locale)}
        </button>

        {calcError && <div className="text-sm text-red-600">{calcError}</div>}

        {calcResult && (
          <div className="text-center">
            <div className="text-sm text-gray-700 mb-1">
              {t('Найдено компаний: ', 'Companies found: ', locale)}
              <span className="font-bold text-lg text-gray-900">
                {calcResult.count.toLocaleString(locale === 'en' ? 'en-US' : 'ru-RU')}
              </span>
              {calcResult.count > 0 && (
                <span className="text-xs text-gray-500 ml-2">
                  ({t(
                    `после скачивания ваш остаток по тарифу: ${Math.max(0, calcResult.remaining - calcResult.count).toLocaleString('ru-RU')}`,
                    `remaining after download: ${Math.max(0, calcResult.remaining - calcResult.count).toLocaleString('en-US')}`,
                    locale,
                  )})
                </span>
              )}
            </div>
          </div>
        )}

        {calcResult && calcResult.count > 0 && (
          <div className="bg-white rounded-xl shadow-sm p-6 w-full max-w-lg">
            <h3 className="text-sm font-semibold text-gray-700 mb-4 text-center">
              {t('Скачать базу', 'Download database', locale)}
            </h3>
            <div className="grid grid-cols-2 gap-3">
              <button
                type="button"
                onClick={() => handleExport('xlsx')}
                disabled={exportLoading !== null}
                className="flex flex-col items-center gap-2 border-2 border-green-500 bg-green-50 hover:bg-green-100 disabled:opacity-60 rounded-lg px-4 py-4 transition-colors"
              >
                <svg className="w-8 h-8 text-green-600" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 0 0-3.375-3.375h-1.5A1.125 1.125 0 0 1 13.5 7.125v-1.5a3.375 3.375 0 0 0-3.375-3.375H8.25m2.25 0H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 0 0-9-9Z" />
                  <path strokeLinecap="round" strokeLinejoin="round" d="M9 17.25h6m-3-3v3" />
                </svg>
                <span className="text-sm font-semibold text-green-700">
                  {exportLoading === 'xlsx'
                    ? t('Формируем...', 'Generating...', locale)
                    : 'Excel (.xlsx)'}
                </span>
                <span className="text-xs text-gray-500">
                  {t('Для работы в Excel', 'For Excel', locale)}
                </span>
              </button>

              <button
                type="button"
                onClick={() => handleExport('csv')}
                disabled={exportLoading !== null}
                className="flex flex-col items-center gap-2 border-2 border-blue-400 bg-blue-50 hover:bg-blue-100 disabled:opacity-60 rounded-lg px-4 py-4 transition-colors"
              >
                <svg className="w-8 h-8 text-blue-600" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 0 0-3.375-3.375h-1.5A1.125 1.125 0 0 1 13.5 7.125v-1.5a3.375 3.375 0 0 0-3.375-3.375H8.25m.75 12 3 3m0 0 3-3m-3 3v-6m-1.5-9H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 0 0-9-9Z" />
                </svg>
                <span className="text-sm font-semibold text-blue-700">
                  {exportLoading === 'csv'
                    ? t('Формируем...', 'Generating...', locale)
                    : 'CSV (.csv)'}
                </span>
                <span className="text-xs text-gray-500">
                  {t('Универсальный формат', 'Universal format', locale)}
                </span>
              </button>
            </div>
            {exportError && (
              <div className="text-sm text-red-600 text-center mt-3">{exportError}</div>
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
      <div className="absolute inset-0 bg-black/40 backdrop-blur-sm" onClick={onClose} />
      <div className="relative bg-white rounded-2xl shadow-2xl max-w-2xl w-full max-h-[80vh] flex flex-col animate-in fade-in zoom-in-95 duration-200">
        <div className="flex items-center justify-between px-8 pt-6 pb-3">
          <h3 className="text-base font-semibold text-gray-900">
            {t('Регионы и города', 'Regions and cities', locale)}
          </h3>
          <button
            onClick={onClose}
            className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-gray-400 hover:bg-gray-100 hover:text-gray-700 transition-colors"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18 18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
        <div className="px-8 pb-4">
          <div className="relative">
            <svg className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="m21 21-5.197-5.197m0 0A7.5 7.5 0 1 0 5.196 5.196a7.5 7.5 0 0 0 10.607 10.607Z" />
            </svg>
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={t('Быстрый поиск', 'Quick search', locale)}
              className="w-full border border-gray-200 rounded-lg pl-9 pr-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-400 transition-shadow"
            />
          </div>
        </div>
        <div className="flex-1 overflow-y-auto px-8 pb-4">
          {filtered.map((district) => {
            const codes = district.regions.map((r) => r.code);
            const selectedCount = codes.filter((c) => selected.has(c)).length;
            const allSelected = selectedCount === codes.length && codes.length > 0;
            const isOpen = expanded.has(district.name);
            return (
              <div key={district.name} className="mb-1">
                <div className="flex items-center gap-2 py-1 hover:bg-gray-50 rounded-lg px-1 -mx-1">
                  <button
                    type="button"
                    onClick={() => toggleExpand(district.name)}
                    className="w-6 h-6 flex items-center justify-center text-gray-400 hover:text-gray-700 flex-shrink-0"
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
                    className="w-4 h-4 accent-blue-600 flex-shrink-0"
                  />
                  <span className="text-sm font-medium">{district.name}</span>
                </div>
                {isOpen && (
                  <div className="ml-12 mt-0.5 space-y-0.5">
                    {district.regions.map((r) => (
                      <label key={r.code} className="flex items-center gap-2 cursor-pointer py-0.5 hover:bg-gray-50 rounded px-1 -mx-1">
                        <input
                          type="checkbox"
                          checked={selected.has(r.code)}
                          onChange={() => toggle(r.code)}
                          className="w-4 h-4 accent-blue-600 flex-shrink-0"
                        />
                        <span className="text-sm text-gray-500 font-semibold mr-1">{r.code}</span>
                        <span className="text-sm">{r.name}</span>
                      </label>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
        <div className="flex items-center justify-between px-8 py-5 border-t border-gray-100">
          <span className="text-sm text-gray-500">
            {t(`Выбрано: ${selected.size}`, `Selected: ${selected.size}`, locale)}
          </span>
          <div className="flex gap-3">
            <button
              type="button"
              onClick={() => onChange(new Set())}
              className="rounded-xl border border-gray-200 bg-white px-6 py-3 text-base font-medium text-gray-700 hover:bg-gray-50 transition-colors"
            >
              {t('Очистить', 'Clear', locale)}
            </button>
            <button
              type="button"
              onClick={() => onChange(new Set(ALL_REGION_CODES))}
              className="rounded-xl border border-gray-200 bg-white px-6 py-3 text-base font-medium text-gray-700 hover:bg-gray-50 transition-colors"
            >
              {t('Все', 'All', locale)}
            </button>
            <button
              type="button"
              onClick={onClose}
              className="rounded-xl bg-gray-900 px-8 py-3 text-base font-medium text-white hover:bg-gray-800 transition-colors"
            >
              {t('Готово', 'Done', locale)}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

