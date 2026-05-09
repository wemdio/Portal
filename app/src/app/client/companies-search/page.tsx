'use client';

import { useEffect, useMemo, useState } from 'react';
import { Switch } from '@/components/Switch';
import { supabase } from '@/lib/supabaseClient';
import { FEDERAL_DISTRICTS, ALL_REGION_CODES, getRegionByCode } from '@/lib/companiesSearch/regions';

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
  const [activitiesModalOpen, setActivitiesModalOpen] = useState(false);
  const [selectedRegions, setSelectedRegions] = useState<Set<string>>(
    new Set(ALL_REGION_CODES),
  );
  const [selectedActivities, setSelectedActivities] = useState<Set<string>>(new Set());
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
  const [calcResult, setCalcResult] = useState<{ count: number } | null>(null);
  const [calcError, setCalcError] = useState<string | null>(null);

  const [exportLoading, setExportLoading] = useState<'csv' | 'xlsx' | null>(null);
  const [exportError, setExportError] = useState<string | null>(null);

  const [activityTypes, setActivityTypes] = useState<string[]>([]);
  const [activityTypesLoading, setActivityTypesLoading] = useState(true);
  const [activityTypesError, setActivityTypesError] = useState<string | null>(null);

  // Грузим виды деятельности один раз при монтировании страницы — чтобы
  // при открытии модалки список уже был готов и не было задержки.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const { data: { session } } = await supabase.auth.getSession();
        const token = session?.access_token;
        if (!token) {
          if (!cancelled) {
            setActivityTypesError(t('Требуется авторизация', 'Authorization required', locale));
            setActivityTypesLoading(false);
          }
          return;
        }
        const res = await fetch('/api/client/companies-search/activity-types', {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (cancelled) return;
        if (!res.ok) {
          const err = await res.json().catch(() => ({ error: t('Ошибка', 'Error', locale) }));
          setActivityTypesError(err.error || `HTTP ${res.status}`);
          setActivityTypesLoading(false);
          return;
        }
        const data = (await res.json()) as { types: string[] };
        setActivityTypes(data.types);
        setActivityTypesLoading(false);
      } catch (err) {
        if (!cancelled) {
          setActivityTypesError(err instanceof Error ? err.message : t('Ошибка', 'Error', locale));
          setActivityTypesLoading(false);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [locale]);

  const selectedRegionsCount = selectedRegions.size;
  const selectedActivitiesCount = selectedActivities.size;

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
      activityTypes:
        mode === 'activity' && selectedActivitiesCount > 0
          ? Array.from(selectedActivities)
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

      const data = (await res.json()) as { count: number };
      setCalcResult({ count: data.count });
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
    <div className="max-w-5xl mx-auto space-y-6 pb-20">
      <header>
        <h1 className="text-2xl sm:text-3xl font-extrabold" style={{ color: 'var(--cp-text)' }}>
          {t('B2B-поиск компаний', 'B2B company search', locale)}
        </h1>
        <p className="mt-2 text-sm sm:text-base" style={{ color: 'var(--cp-text-m)' }}>
          {t(
            'Поиск российских юрлиц по ОКВЭД, регионам, выручке и контактам. Экспорт в CSV/XLSX.',
            'Russian legal entities by activity, region, revenue, and contacts. CSV/XLSX export.',
            locale,
          )}
        </p>
      </header>

      {/* Step 1 */}
      <div className="neu-card p-5 sm:p-6">
        <div className="flex items-center gap-2 mb-5 flex-wrap">
          <button
            type="button"
            onClick={() => setMode('activity')}
            className={`neu-pill px-3 py-1.5 text-xs sm:text-sm font-semibold ${mode === 'activity' ? 'active' : ''}`}
            style={mode !== 'activity' ? { color: 'var(--cp-text-m)' } : undefined}
          >
            {t('По видам деятельности', 'By activity type', locale)}
          </button>
          <button
            type="button"
            onClick={() => setMode('inn')}
            className={`neu-pill px-3 py-1.5 text-xs sm:text-sm font-semibold ${mode === 'inn' ? 'active' : ''}`}
            style={mode !== 'inn' ? { color: 'var(--cp-text-m)' } : undefined}
          >
            {t('По списку ИНН', 'By TIN list', locale)}
          </button>
        </div>

        <h2 className="text-base sm:text-lg font-bold mb-4" style={{ color: 'var(--cp-text)' }}>
          {t('1. Выберите регионы и виды деятельности', '1. Select regions and activity types', locale)}
        </h2>

        {mode === 'activity' ? (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
            <div>
              <button
                type="button"
                onClick={() => setRegionsModalOpen(true)}
                className="neu-btn px-4 py-2.5 text-sm font-semibold inline-flex items-center gap-2"
              >
                {t('Регионы', 'Regions', locale)} <span aria-hidden>▾</span>
              </button>
              <div className="text-xs sm:text-sm mt-3 font-semibold" style={{ color: 'var(--cp-text-m)' }}>
                {selectedRegionsCount === ALL_REGION_CODES.length
                  ? t('Выбраны все регионы РФ', 'All regions selected', locale)
                  : selectedRegionsCount === 0
                    ? t('Не выбран ни один регион', 'No regions selected', locale)
                    : t(`Выбрано регионов: ${selectedRegionsCount}`, `Regions selected: ${selectedRegionsCount}`, locale)}
              </div>
            </div>

            <div>
              <button
                type="button"
                onClick={() => setActivitiesModalOpen(true)}
                className="neu-btn px-4 py-2.5 text-sm font-semibold inline-flex items-center gap-2"
              >
                {t('Виды деятельности', 'Activity types', locale)} <span aria-hidden>▾</span>
              </button>
              <div className="text-xs sm:text-sm mt-3" style={{ color: 'var(--cp-text-l)' }}>
                {selectedActivitiesCount === 0
                  ? t('Не выбран ни один вид деятельности (= все)', 'No activity types selected (= all)', locale)
                  : t(`Выбрано: ${selectedActivitiesCount}`, `Selected: ${selectedActivitiesCount}`, locale)}
              </div>
            </div>
          </div>
        ) : (
          <div>
            <label className="text-xs sm:text-sm mb-2 block" style={{ color: 'var(--cp-text-m)' }}>
              {t(
                'Список ИНН (через запятую, пробел или с новой строки):',
                'TIN list (comma, space, or newline separated):',
                locale,
              )}
            </label>
            <textarea
              value={innList}
              onChange={(e) => setInnList(e.target.value)}
              className="neu-input w-full p-3 font-mono text-sm"
              rows={6}
              placeholder="7710641442&#10;5017074592"
            />
          </div>
        )}
      </div>

      {/* Step 2 */}
      <div className="neu-card p-5 sm:p-6">
        <h2 className="text-base sm:text-lg font-bold mb-5" style={{ color: 'var(--cp-text)' }}>
          {t('2. Дополнительные фильтры', '2. Additional filters', locale)}
        </h2>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-x-10 gap-y-6">
          <div className="space-y-6">
            <div>
              <div className="text-xs sm:text-sm font-semibold mb-2" style={{ color: 'var(--cp-text-m)' }}>
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
              <div className="text-xs sm:text-sm font-semibold mb-2" style={{ color: 'var(--cp-text-m)' }}>
                {t('Организационно-правовая форма', 'Legal form', locale)}
              </div>
              <select
                value={legalForm}
                onChange={(e) => setLegalForm(e.target.value)}
                className="neu-input w-full px-3 py-2 text-sm"
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
              <div className="text-xs sm:text-sm font-semibold mb-2" style={{ color: 'var(--cp-text-m)' }}>
                {t('Численность сотрудников', 'Number of employees', locale)}
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div className="flex items-center gap-2">
                  <span className="text-xs" style={{ color: 'var(--cp-text-l)' }}>{t('От', 'From', locale)}</span>
                  <input
                    type="number"
                    min={0}
                    value={employeesFrom}
                    onChange={(e) => setEmployeesFrom(e.target.value)}
                    className="neu-input flex-1 px-3 py-2 text-sm"
                    placeholder="0"
                  />
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-xs" style={{ color: 'var(--cp-text-l)' }}>{t('до', 'to', locale)}</span>
                  <input
                    type="number"
                    min={0}
                    value={employeesTo}
                    onChange={(e) => setEmployeesTo(e.target.value)}
                    className="neu-input flex-1 px-3 py-2 text-sm"
                  />
                </div>
              </div>
            </div>

            <div>
              <div className="text-xs sm:text-sm font-semibold mb-2" style={{ color: 'var(--cp-text-m)' }}>
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
              <div className="text-xs sm:text-sm font-semibold mb-2" style={{ color: 'var(--cp-text-m)' }}>
                {t('Выручка, руб.', 'Revenue, RUB', locale)}
              </div>
              <div className="flex items-center gap-2">
                <span className="text-xs" style={{ color: 'var(--cp-text-l)' }}>{t('От', 'From', locale)}</span>
                <input
                  type="number"
                  min={0}
                  value={revenueFrom}
                  onChange={(e) => setRevenueFrom(e.target.value)}
                  className="neu-input flex-1 px-3 py-2 text-sm"
                />
                <span className="text-xs" style={{ color: 'var(--cp-text-l)' }}>{t('до', 'to', locale)}</span>
                <input
                  type="number"
                  min={0}
                  value={revenueTo}
                  onChange={(e) => setRevenueTo(e.target.value)}
                  className="neu-input flex-1 px-3 py-2 text-sm"
                />
              </div>
            </div>

            <div>
              <div className="text-xs sm:text-sm font-semibold mb-2" style={{ color: 'var(--cp-text-m)' }}>
                {t('Стоимость организации, руб.', 'Company cost, RUB', locale)}
              </div>
              <div className="flex items-center gap-2">
                <span className="text-xs" style={{ color: 'var(--cp-text-l)' }}>{t('От', 'From', locale)}</span>
                <input
                  type="number"
                  min={0}
                  value={costFrom}
                  onChange={(e) => setCostFrom(e.target.value)}
                  className="neu-input flex-1 px-3 py-2 text-sm"
                />
                <span className="text-xs" style={{ color: 'var(--cp-text-l)' }}>{t('до', 'to', locale)}</span>
                <input
                  type="number"
                  min={0}
                  value={costTo}
                  onChange={(e) => setCostTo(e.target.value)}
                  className="neu-input flex-1 px-3 py-2 text-sm"
                />
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Step 3 */}
      <div className="neu-card p-5 sm:p-6">
        <h2 className="text-base sm:text-lg font-bold mb-4" style={{ color: 'var(--cp-text)' }}>
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
        <p className="text-xs mt-4 leading-relaxed" style={{ color: 'var(--cp-text-l)' }}>
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
          className="neu-btn px-10 py-3.5 text-sm sm:text-base font-bold"
        >
          {calcLoading
            ? t('Считаем...', 'Calculating...', locale)
            : t('Посчитать и собрать базу', 'Calculate and build', locale)}
        </button>

        {calcError && (
          <div className="text-sm" style={{ color: 'var(--cp-danger)' }}>{calcError}</div>
        )}

        {calcResult && (
          <div className="text-center">
            <div className="text-sm" style={{ color: 'var(--cp-text-m)' }}>
              {t('Найдено компаний: ', 'Companies found: ', locale)}
              <span className="font-bold text-lg" style={{ color: 'var(--cp-text)' }}>
                {calcResult.count.toLocaleString(locale === 'en' ? 'en-US' : 'ru-RU')}
              </span>
            </div>
          </div>
        )}

        {calcResult && calcResult.count > 0 && (
          <div className="neu-card p-5 sm:p-6 w-full max-w-lg">
            <h3 className="text-sm font-bold mb-4 text-center" style={{ color: 'var(--cp-text)' }}>
              {t('Скачать базу', 'Download database', locale)}
            </h3>
            <div className="grid grid-cols-2 gap-3">
              <button
                type="button"
                onClick={() => handleExport('xlsx')}
                disabled={exportLoading !== null}
                className="neu-sm flex flex-col items-center gap-2 px-4 py-4 disabled:opacity-60"
              >
                <svg className="w-7 h-7" style={{ color: 'var(--cp-accent)' }} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 0 0-3.375-3.375h-1.5A1.125 1.125 0 0 1 13.5 7.125v-1.5a3.375 3.375 0 0 0-3.375-3.375H8.25m2.25 0H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 0 0-9-9Z" />
                  <path strokeLinecap="round" strokeLinejoin="round" d="M9 17.25h6m-3-3v3" />
                </svg>
                <span className="text-sm font-bold" style={{ color: 'var(--cp-text)' }}>
                  {exportLoading === 'xlsx'
                    ? t('Формируем...', 'Generating...', locale)
                    : 'Excel (.xlsx)'}
                </span>
                <span className="text-[11px]" style={{ color: 'var(--cp-text-l)' }}>
                  {t('Для работы в Excel', 'For Excel', locale)}
                </span>
              </button>

              <button
                type="button"
                onClick={() => handleExport('csv')}
                disabled={exportLoading !== null}
                className="neu-sm flex flex-col items-center gap-2 px-4 py-4 disabled:opacity-60"
              >
                <svg className="w-7 h-7" style={{ color: 'var(--cp-accent)' }} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 0 0-3.375-3.375h-1.5A1.125 1.125 0 0 1 13.5 7.125v-1.5a3.375 3.375 0 0 0-3.375-3.375H8.25m.75 12 3 3m0 0 3-3m-3 3v-6m-1.5-9H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 0 0-9-9Z" />
                </svg>
                <span className="text-sm font-bold" style={{ color: 'var(--cp-text)' }}>
                  {exportLoading === 'csv'
                    ? t('Формируем...', 'Generating...', locale)
                    : 'CSV (.csv)'}
                </span>
                <span className="text-[11px]" style={{ color: 'var(--cp-text-l)' }}>
                  {t('Универсальный формат', 'Universal format', locale)}
                </span>
              </button>
            </div>
            {exportError && (
              <div className="text-sm text-center mt-3" style={{ color: 'var(--cp-danger)' }}>{exportError}</div>
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
      {activitiesModalOpen && (
        <ActivitiesModal
          locale={locale}
          selected={selectedActivities}
          onChange={setSelectedActivities}
          onClose={() => setActivitiesModalOpen(false)}
          types={activityTypes}
          loading={activityTypesLoading}
          error={activityTypesError}
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
    <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4" onClick={onClose}>
      <div
        className="neu-card max-w-2xl w-full max-h-[80vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
        style={{ background: 'var(--cp-bg)' }}
      >
        <div className="flex items-center justify-between px-5 py-4">
          <h3 className="text-base sm:text-lg font-bold" style={{ color: 'var(--cp-text)' }}>
            {t('Регионы и города', 'Regions and cities', locale)}
          </h3>
          <button
            onClick={onClose}
            className="neu-pill p-1.5"
            aria-label={t('Закрыть', 'Close', locale)}
            style={{ color: 'var(--cp-text-l)' }}
          >
            ×
          </button>
        </div>
        <div className="px-5 pb-3">
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={t('Быстрый поиск', 'Quick search', locale)}
            className="neu-input w-full px-3 py-2 text-sm"
          />
        </div>
        <div className="flex-1 overflow-y-auto px-5 pb-5">
          {filtered.map((district) => {
            const codes = district.regions.map((r) => r.code);
            const selectedCount = codes.filter((c) => selected.has(c)).length;
            const allSelected = selectedCount === codes.length && codes.length > 0;
            const isOpen = expanded.has(district.name);
            return (
              <div key={district.name} className="mb-2">
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => toggleExpand(district.name)}
                    className="w-6 h-6 flex items-center justify-center"
                    style={{ color: 'var(--cp-text-l)' }}
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
                    className="w-4 h-4"
                    style={{ accentColor: 'var(--cp-accent)' }}
                  />
                  <span className="text-sm" style={{ color: 'var(--cp-text)' }}>{district.name}</span>
                </div>
                {isOpen && (
                  <div className="ml-12 mt-1 space-y-1">
                    {district.regions.map((r) => (
                      <label key={r.code} className="flex items-center gap-2 cursor-pointer">
                        <input
                          type="checkbox"
                          checked={selected.has(r.code)}
                          onChange={() => toggle(r.code)}
                          className="w-4 h-4"
                          style={{ accentColor: 'var(--cp-accent)' }}
                        />
                        <span className="text-sm font-bold mr-1" style={{ color: 'var(--cp-text-m)' }}>{r.code}</span>
                        <span className="text-sm" style={{ color: 'var(--cp-text)' }}>{r.name}</span>
                      </label>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
        <div className="flex items-center justify-between p-4 gap-2 flex-wrap">
          <span className="text-xs sm:text-sm" style={{ color: 'var(--cp-text-m)' }}>
            {t(`Выбрано: ${selected.size}`, `Selected: ${selected.size}`, locale)}
          </span>
          <div className="flex gap-2 flex-wrap">
            <button
              type="button"
              onClick={() => onChange(new Set())}
              className="neu-pill px-3 py-1.5 text-xs font-semibold"
              style={{ color: 'var(--cp-text-m)' }}
            >
              {t('Очистить', 'Clear', locale)}
            </button>
            <button
              type="button"
              onClick={() => onChange(new Set(ALL_REGION_CODES))}
              className="neu-pill px-3 py-1.5 text-xs font-semibold"
              style={{ color: 'var(--cp-text-m)' }}
            >
              {t('Все', 'All', locale)}
            </button>
            <button
              type="button"
              onClick={onClose}
              className="neu-btn px-4 py-1.5 text-xs font-semibold"
            >
              {t('Готово', 'Done', locale)}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Activities modal ──────────────────────────────────────────────────
function ActivitiesModal({
  locale,
  selected,
  onChange,
  onClose,
  types,
  loading,
  error,
}: {
  locale: L;
  selected: Set<string>;
  onChange: (s: Set<string>) => void;
  onClose: () => void;
  types: string[];
  loading: boolean;
  error: string | null;
}) {
  const [search, setSearch] = useState('');

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return types;
    return types.filter((tp) => tp.toLowerCase().includes(q));
  }, [types, search]);

  const toggle = (tp: string) => {
    const next = new Set(selected);
    if (next.has(tp)) next.delete(tp);
    else next.add(tp);
    onChange(next);
  };

  return (
    <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4" onClick={onClose}>
      <div
        className="neu-card max-w-2xl w-full max-h-[80vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
        style={{ background: 'var(--cp-bg)' }}
      >
        <div className="flex items-center justify-between px-5 py-4">
          <h3 className="text-base sm:text-lg font-bold" style={{ color: 'var(--cp-text)' }}>
            {t('Виды деятельности', 'Activity types', locale)}
          </h3>
          <button
            onClick={onClose}
            className="neu-pill p-1.5"
            aria-label={t('Закрыть', 'Close', locale)}
            style={{ color: 'var(--cp-text-l)' }}
          >
            ×
          </button>
        </div>
        <div className="px-5 pb-3">
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={t('Быстрый поиск', 'Quick search', locale)}
            className="neu-input w-full px-3 py-2 text-sm"
          />
        </div>
        <div className="flex-1 overflow-y-auto px-5 pb-5">
          {loading && <div className="text-sm" style={{ color: 'var(--cp-text-l)' }}>{t('Загрузка...', 'Loading...', locale)}</div>}
          {error && <div className="text-sm" style={{ color: 'var(--cp-danger)' }}>{error}</div>}
          {!loading && !error && filtered.length === 0 && (
            <div className="text-sm" style={{ color: 'var(--cp-text-l)' }}>
              {types.length === 0
                ? t('В базе пока нет данных. Список заполнится после импорта.', 'No data yet. The list will populate after import.', locale)
                : t('Ничего не найдено', 'Nothing found', locale)}
            </div>
          )}
          <div className="space-y-1">
            {filtered.map((tp) => (
              <label key={tp} className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={selected.has(tp)}
                  onChange={() => toggle(tp)}
                  className="w-4 h-4"
                  style={{ accentColor: 'var(--cp-accent)' }}
                />
                <span className="text-sm" style={{ color: 'var(--cp-text)' }}>{tp}</span>
              </label>
            ))}
          </div>
        </div>
        <div className="flex items-center justify-between p-4 gap-2 flex-wrap">
          <span className="text-xs sm:text-sm" style={{ color: 'var(--cp-text-m)' }}>
            {t(`Выбрано: ${selected.size}`, `Selected: ${selected.size}`, locale)}
          </span>
          <div className="flex gap-2 flex-wrap">
            <button
              type="button"
              onClick={() => onChange(new Set())}
              className="neu-pill px-3 py-1.5 text-xs font-semibold"
              style={{ color: 'var(--cp-text-m)' }}
            >
              {t('Очистить', 'Clear', locale)}
            </button>
            <button
              type="button"
              onClick={onClose}
              className="neu-btn px-4 py-1.5 text-xs font-semibold"
            >
              {t('Готово', 'Done', locale)}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
