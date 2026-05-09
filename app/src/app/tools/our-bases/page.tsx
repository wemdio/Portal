'use client';

import { useMemo, useState } from 'react';
import { Switch } from '@/components/Switch';
import { authFetch } from '@/lib/authFetch';
import { FEDERAL_DISTRICTS, ALL_REGION_CODES } from '@/lib/companiesSearch/regions';
import { ActivityTypesModal } from '@/components/ActivityTypesModal';

type Mode = 'activity' | 'inn';

const LEGAL_FORMS = [
  { code: 'ООО', label: 'ООО' },
  { code: 'АО', label: 'АО' },
  { code: 'ПАО', label: 'ПАО' },
  { code: 'НКО', label: 'НКО' },
];

export default function OurBasesPage() {
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
      const res = await authFetch('/api/tools/our-bases', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...buildFilters(), countOnly: true }),
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: 'Ошибка' }));
        setCalcError(err.error || `HTTP ${res.status}`);
        setCalcLoading(false);
        return;
      }

      const data = (await res.json()) as { count: number };
      setCalcResult({ count: data.count });
    } catch (err) {
      setCalcError(err instanceof Error ? err.message : 'Ошибка');
    } finally {
      setCalcLoading(false);
    }
  };

  const handleExport = async (format: 'csv' | 'xlsx') => {
    setExportLoading(format);
    setExportError(null);

    try {
      const res = await authFetch(`/api/tools/our-bases/export?format=${format}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(buildFilters()),
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: 'Ошибка' }));
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
      setExportError(err instanceof Error ? err.message : 'Ошибка');
    } finally {
      setExportLoading(null);
    }
  };

  return (
    <div className="space-y-6 text-left max-w-full">
      {/* Header */}
      <div className="flex flex-col gap-1">
        <h1 className="text-2xl font-bold text-gray-900">Наша база баз</h1>
        <p className="text-sm text-gray-500">
          Поиск компаний по реестру: регионы, виды деятельности, фильтры, ИНН.
        </p>
      </div>

      {/* Step 1 */}
      <div className="rounded-xl border border-gray-200 bg-white p-5 space-y-5">
        {/* Mode tabs */}
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setMode('activity')}
            className={`rounded-lg px-3.5 py-1.5 text-sm font-medium transition-colors ${mode === 'activity' ? 'bg-gray-900 text-white' : 'bg-gray-100 text-gray-700 hover:bg-gray-200'}`}
          >
            По видам деятельности
          </button>
          <button
            type="button"
            onClick={() => setMode('inn')}
            className={`rounded-lg px-3.5 py-1.5 text-sm font-medium transition-colors ${mode === 'inn' ? 'bg-gray-900 text-white' : 'bg-gray-100 text-gray-700 hover:bg-gray-200'}`}
          >
            По списку ИНН
          </button>
        </div>

        <div>
          <h2 className="text-base font-semibold text-gray-900 mb-4">
            <span className="inline-flex items-center justify-center w-6 h-6 rounded-full bg-gray-900 text-white text-xs font-bold mr-2">1</span>
            Выберите регионы и виды деятельности
          </h2>

          {mode === 'activity' ? (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <button
                type="button"
                onClick={() => setRegionsModalOpen(true)}
                className="group flex items-center gap-3 w-full border border-gray-200 rounded-xl px-5 py-4 bg-gray-50/50 hover:border-blue-400 hover:bg-white hover:shadow-sm transition-all text-left"
              >
                <div className="w-10 h-10 rounded-lg bg-blue-50 text-blue-600 flex items-center justify-center flex-shrink-0 group-hover:bg-blue-100 transition-colors">
                  <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M15 10.5a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z" />
                    <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 10.5c0 7.142-7.5 11.25-7.5 11.25S4.5 17.642 4.5 10.5a7.5 7.5 0 1 1 15 0Z" />
                  </svg>
                </div>
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-semibold text-gray-900">Регионы</div>
                  <div className="text-xs text-gray-500 mt-0.5">
                    {selectedRegionsCount === ALL_REGION_CODES.length
                      ? 'Выбраны все регионы РФ'
                      : selectedRegionsCount === 0
                        ? 'Не выбран ни один регион'
                        : `Выбрано: ${selectedRegionsCount}`}
                  </div>
                </div>
                <svg className="w-5 h-5 text-gray-400 group-hover:text-blue-500 flex-shrink-0 transition-colors" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="m19.5 8.25-7.5 7.5-7.5-7.5" />
                </svg>
              </button>

              <button
                type="button"
                onClick={() => setActivitiesModalOpen(true)}
                className="group flex items-center gap-3 w-full border border-gray-200 rounded-xl px-5 py-4 bg-gray-50/50 hover:border-blue-400 hover:bg-white hover:shadow-sm transition-all text-left"
              >
                <div className="w-10 h-10 rounded-lg bg-amber-50 text-amber-600 flex items-center justify-center flex-shrink-0 group-hover:bg-amber-100 transition-colors">
                  <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 12h16.5m-16.5 3.75h16.5M3.75 19.5h16.5M5.625 4.5h12.75a1.875 1.875 0 0 1 0 3.75H5.625a1.875 1.875 0 0 1 0-3.75Z" />
                  </svg>
                </div>
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-semibold text-gray-900">Виды деятельности</div>
                  <div className="text-xs text-gray-500 mt-0.5">
                    {selectedActivitiesCount === 0
                      ? 'Не выбрано (= все виды)'
                      : `Выбрано: ${selectedActivitiesCount}`}
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
                Список ИНН (через запятую, пробел или с новой строки):
              </label>
              <textarea
                value={innList}
                onChange={(e) => setInnList(e.target.value)}
                className="w-full border border-gray-200 rounded-lg p-3 font-mono text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-400 transition-shadow"
                rows={6}
                placeholder="7710641442&#10;5017074592"
              />
            </div>
          )}
        </div>
      </div>

      {/* Step 2: Filters */}
      <div className="rounded-xl border border-gray-200 bg-white p-5 space-y-5">
        <h2 className="text-base font-semibold text-gray-900">
          <span className="inline-flex items-center justify-center w-6 h-6 rounded-full bg-gray-900 text-white text-xs font-bold mr-2">2</span>
          Дополнительные фильтры
        </h2>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-x-10 gap-y-5">
          <div className="space-y-5">
            <div>
              <div className="text-sm font-medium text-gray-800 mb-2">Контакты</div>
              <div className="flex flex-wrap gap-5">
                <Switch
                  checked={hasPhone}
                  onCheckedChange={setHasPhone}
                  label={<span className="text-sm">Указан телефон</span>}
                />
                <Switch
                  checked={hasEmail}
                  onCheckedChange={setHasEmail}
                  label={<span className="text-sm">Указан email</span>}
                />
              </div>
            </div>

            <div>
              <div className="text-sm font-medium text-gray-800 mb-2">
                Организационно-правовая форма
              </div>
              <select
                value={legalForm}
                onChange={(e) => setLegalForm(e.target.value)}
                className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-400 transition-shadow"
              >
                <option value="">Все организации</option>
                {LEGAL_FORMS.map((f) => (
                  <option key={f.code} value={f.code}>
                    {f.label}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <div className="text-sm font-medium text-gray-800 mb-2">
                Численность сотрудников
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div className="flex items-center gap-2">
                  <span className="text-xs text-gray-500 uppercase tracking-wide">от</span>
                  <input
                    type="number"
                    min={0}
                    value={employeesFrom}
                    onChange={(e) => setEmployeesFrom(e.target.value)}
                    className="flex-1 border border-gray-200 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-400 transition-shadow"
                    placeholder="0"
                  />
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-xs text-gray-500 uppercase tracking-wide">до</span>
                  <input
                    type="number"
                    min={0}
                    value={employeesTo}
                    onChange={(e) => setEmployeesTo(e.target.value)}
                    className="flex-1 border border-gray-200 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-400 transition-shadow"
                  />
                </div>
              </div>
            </div>

            <div>
              <div className="text-sm font-medium text-gray-800 mb-2">
                Дополнительные данные
              </div>
              <div className="flex flex-col gap-2">
                <Switch
                  checked={hasWebsite}
                  onCheckedChange={setHasWebsite}
                  label={<span className="text-sm">Есть сайт</span>}
                />
                <Switch
                  checked={hasEdo}
                  onCheckedChange={setHasEdo}
                  label={<span className="text-sm">Есть идентификатор ЭДО</span>}
                />
                <Switch
                  checked={hasEgais}
                  onCheckedChange={setHasEgais}
                  label={<span className="text-sm">Есть ЕГАИС</span>}
                />
              </div>
            </div>
          </div>

          <div className="space-y-5">
            <div>
              <div className="text-sm font-medium text-gray-800 mb-2">Выручка, руб.</div>
              <div className="flex items-center gap-2">
                <span className="text-xs text-gray-500 uppercase tracking-wide">от</span>
                <input
                  type="number"
                  min={0}
                  value={revenueFrom}
                  onChange={(e) => setRevenueFrom(e.target.value)}
                  className="flex-1 border border-gray-200 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-400 transition-shadow"
                />
                <span className="text-xs text-gray-500 uppercase tracking-wide">до</span>
                <input
                  type="number"
                  min={0}
                  value={revenueTo}
                  onChange={(e) => setRevenueTo(e.target.value)}
                  className="flex-1 border border-gray-200 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-400 transition-shadow"
                />
              </div>
            </div>

            <div>
              <div className="text-sm font-medium text-gray-800 mb-2">
                Стоимость организации, руб.
              </div>
              <div className="flex items-center gap-2">
                <span className="text-xs text-gray-500 uppercase tracking-wide">от</span>
                <input
                  type="number"
                  min={0}
                  value={costFrom}
                  onChange={(e) => setCostFrom(e.target.value)}
                  className="flex-1 border border-gray-200 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-400 transition-shadow"
                />
                <span className="text-xs text-gray-500 uppercase tracking-wide">до</span>
                <input
                  type="number"
                  min={0}
                  value={costTo}
                  onChange={(e) => setCostTo(e.target.value)}
                  className="flex-1 border border-gray-200 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-400 transition-shadow"
                />
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Step 3: IP */}
      <div className="rounded-xl border border-gray-200 bg-white p-5 space-y-3">
        <h2 className="text-base font-semibold text-gray-900">
          <span className="inline-flex items-center justify-center w-6 h-6 rounded-full bg-gray-900 text-white text-xs font-bold mr-2">3</span>
          Данные по ИП
        </h2>
        <div className="pl-8">
          <Switch
            checked={includeIp}
            onCheckedChange={setIncludeIp}
            label={
              <span className="text-sm font-medium">
                Добавить данные по индивидуальным предпринимателям
              </span>
            }
          />
          <p className="text-xs text-gray-500 mt-3 leading-relaxed">
            Для ИП доступны только базовые поля (название, ИНН, адрес, контакты).
          </p>
        </div>
      </div>

      {/* Submit */}
      <div className="flex flex-col items-center gap-4 py-6">
        <button
          type="button"
          onClick={handleCalculate}
          disabled={calcLoading}
          className="rounded-2xl bg-emerald-600 hover:bg-emerald-700 disabled:opacity-50 text-white px-16 py-5 text-xl font-semibold transition-colors shadow-md"
        >
          {calcLoading ? 'Считаем...' : 'Собрать базу'}
        </button>

        {calcError && (
          <span className="text-sm text-red-600">{calcError}</span>
        )}

        {calcResult && (
          <span className="text-sm text-gray-700">
            Найдено: <span className="font-bold text-lg text-gray-900">{calcResult.count.toLocaleString('ru-RU')}</span>
          </span>
        )}

        {calcResult && calcResult.count > 0 && (
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={() => handleExport('xlsx')}
              disabled={exportLoading !== null}
              className="inline-flex items-center gap-1.5 rounded-lg border border-gray-200 bg-white hover:bg-gray-50 disabled:opacity-50 px-4 py-2.5 text-sm font-medium transition-colors"
            >
              <svg className="w-4 h-4 text-green-600" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 0 0-3.375-3.375h-1.5A1.125 1.125 0 0 1 13.5 7.125v-1.5a3.375 3.375 0 0 0-3.375-3.375H8.25m2.25 0H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 0 0-9-9Z" />
              </svg>
              {exportLoading === 'xlsx' ? 'Формируем...' : 'Excel'}
            </button>
            <button
              type="button"
              onClick={() => handleExport('csv')}
              disabled={exportLoading !== null}
              className="inline-flex items-center gap-1.5 rounded-lg border border-gray-200 bg-white hover:bg-gray-50 disabled:opacity-50 px-4 py-2.5 text-sm font-medium transition-colors"
            >
              <svg className="w-4 h-4 text-blue-600" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 0 0-3.375-3.375h-1.5A1.125 1.125 0 0 1 13.5 7.125v-1.5a3.375 3.375 0 0 0-3.375-3.375H8.25m.75 12 3 3m0 0 3-3m-3 3v-6m-1.5-9H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 0 0-9-9Z" />
              </svg>
              {exportLoading === 'csv' ? 'Формируем...' : 'CSV'}
            </button>
          </div>
        )}

        {exportError && (
          <span className="text-sm text-red-600">{exportError}</span>
        )}
      </div>

      {regionsModalOpen && (
        <RegionsModal
          selected={selectedRegions}
          onChange={setSelectedRegions}
          onClose={() => setRegionsModalOpen(false)}
        />
      )}
      {activitiesModalOpen && (
        <ActivityTypesModal
          apiUrl="/api/tools/our-bases/activity-types"
          selected={selectedActivities}
          onChange={setSelectedActivities}
          onClose={() => setActivitiesModalOpen(false)}
        />
      )}
    </div>
  );
}

function RegionsModal({
  selected,
  onChange,
  onClose,
}: {
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
          <h3 className="text-base font-semibold text-gray-900">Регионы и города</h3>
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
              placeholder="Быстрый поиск"
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
            Выбрано: {selected.size}
          </span>
          <div className="flex gap-3">
            <button
              type="button"
              onClick={() => onChange(new Set())}
              className="rounded-xl border border-gray-200 bg-white px-6 py-3 text-base font-medium text-gray-700 hover:bg-gray-50 transition-colors"
            >
              Очистить
            </button>
            <button
              type="button"
              onClick={() => onChange(new Set(ALL_REGION_CODES))}
              className="rounded-xl border border-gray-200 bg-white px-6 py-3 text-base font-medium text-gray-700 hover:bg-gray-50 transition-colors"
            >
              Все
            </button>
            <button
              type="button"
              onClick={onClose}
              className="rounded-xl bg-gray-900 px-8 py-3 text-base font-medium text-white hover:bg-gray-800 transition-colors"
            >
              Готово
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

