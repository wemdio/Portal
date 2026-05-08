'use client';

import { useMemo, useState } from 'react';
import { Switch } from '@/components/Switch';
import { authFetch } from '@/lib/authFetch';
import { FEDERAL_DISTRICTS, ALL_REGION_CODES, getRegionByCode } from '@/lib/companiesSearch/regions';
import { OkvedTreeModal } from '@/components/OkvedTreeModal';

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
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-gray-900">Наша база баз</h1>
        <p className="text-sm text-gray-500">
          Поиск компаний по реестру: регионы, виды деятельности, фильтры, ИНН.
        </p>
      </div>

      {/* Mode selector */}
      <div className="rounded-2xl border border-gray-200 bg-white p-6">
        <div className="flex items-center gap-6 mb-6 text-sm">
          <button
            type="button"
            onClick={() => setMode('activity')}
            className={`flex items-center gap-2 ${mode === 'activity' ? 'font-bold text-gray-900' : 'text-blue-600 hover:text-blue-700'}`}
          >
            {mode === 'activity' && <span className="text-green-600">✓</span>}
            По видам деятельности
          </button>
          <button
            type="button"
            onClick={() => setMode('inn')}
            className={`flex items-center gap-2 ${mode === 'inn' ? 'font-bold text-gray-900' : 'text-blue-600 hover:text-blue-700'}`}
          >
            {mode === 'inn' && <span className="text-green-600">✓</span>}
            По списку ИНН
          </button>
        </div>

        <h2 className="text-lg font-bold mb-4">
          1. Выберите регионы и виды деятельности
        </h2>

        {mode === 'activity' ? (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            <div>
              <button
                type="button"
                onClick={() => setRegionsModalOpen(true)}
                className="bg-blue-600 hover:bg-blue-700 text-white font-semibold px-4 py-2.5 rounded inline-flex items-center gap-2"
              >
                Регионы <span>▼</span>
              </button>
              <div className="text-sm text-gray-700 mt-3 font-semibold">
                {selectedRegionsCount === ALL_REGION_CODES.length
                  ? 'Выбраны все регионы РФ'
                  : selectedRegionsCount === 0
                    ? 'Не выбран ни один регион'
                    : `Выбрано регионов: ${selectedRegionsCount}`}
              </div>
            </div>

            <div>
              <button
                type="button"
                onClick={() => setActivitiesModalOpen(true)}
                className="bg-blue-600 hover:bg-blue-700 text-white font-semibold px-4 py-2.5 rounded inline-flex items-center gap-2"
              >
                Виды деятельности <span>▼</span>
              </button>
              <div className="text-sm text-gray-500 mt-3">
                {selectedActivitiesCount === 0
                  ? 'Не выбран ни один вид деятельности (= все)'
                  : `Выбрано: ${selectedActivitiesCount}`}
              </div>
            </div>
          </div>
        ) : (
          <div>
            <label className="text-sm text-gray-600 mb-2 block">
              Список ИНН (через запятую, пробел или с новой строки):
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

      {/* Filters */}
      <div className="rounded-2xl border border-gray-200 bg-white p-6">
        <h2 className="text-lg font-bold mb-6">
          2. Дополнительные фильтры
        </h2>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-x-12 gap-y-6">
          <div className="space-y-6">
            <div>
              <div className="text-sm font-semibold text-gray-700 mb-2">Контакты</div>
              <div className="flex flex-wrap gap-6">
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
              <div className="text-sm font-semibold text-gray-700 mb-2">
                Организационно-правовая форма
              </div>
              <select
                value={legalForm}
                onChange={(e) => setLegalForm(e.target.value)}
                className="w-full border border-gray-300 rounded px-3 py-2 text-sm bg-white"
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
              <div className="text-sm font-semibold text-gray-700 mb-2">
                Численность сотрудников
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div className="flex items-center gap-2">
                  <span className="text-sm text-gray-500">От</span>
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
                  <span className="text-sm text-gray-500">до</span>
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

          <div className="space-y-6">
            <div>
              <div className="text-sm font-semibold text-gray-700 mb-2">Выручка, руб.</div>
              <div className="flex items-center gap-2">
                <span className="text-sm text-gray-500">От</span>
                <input
                  type="number"
                  min={0}
                  value={revenueFrom}
                  onChange={(e) => setRevenueFrom(e.target.value)}
                  className="flex-1 border-b border-gray-300 px-2 py-1.5 text-sm focus:outline-none focus:border-blue-500"
                />
                <span className="text-sm text-gray-500">до</span>
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
                Стоимость организации, руб.
              </div>
              <div className="flex items-center gap-2">
                <span className="text-sm text-gray-500">От</span>
                <input
                  type="number"
                  min={0}
                  value={costFrom}
                  onChange={(e) => setCostFrom(e.target.value)}
                  className="flex-1 border-b border-gray-300 px-2 py-1.5 text-sm focus:outline-none focus:border-blue-500"
                />
                <span className="text-sm text-gray-500">до</span>
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

      {/* IP section */}
      <div className="rounded-2xl border border-gray-200 bg-white p-6">
        <h2 className="text-lg font-bold mb-4">3. Данные по ИП</h2>
        <Switch
          checked={includeIp}
          onCheckedChange={setIncludeIp}
          label={
            <span className="text-sm font-medium">
              Добавить данные по индивидуальным предпринимателям
            </span>
          }
        />
        <p className="text-xs text-gray-500 mt-4 leading-relaxed">
          Для ИП доступны только базовые поля (название, ИНН, адрес, контакты).
        </p>
      </div>

      {/* Submit */}
      <div className="flex flex-col items-center gap-3">
        <button
          type="button"
          onClick={handleCalculate}
          disabled={calcLoading}
          className="bg-blue-600 hover:bg-blue-700 disabled:opacity-60 text-white font-semibold px-12 py-3 rounded-lg text-sm shadow-sm transition-colors"
        >
          {calcLoading ? 'Считаем...' : 'Собрать базу'}
        </button>
        {calcError && <div className="text-sm text-red-600">{calcError}</div>}
        {calcResult && (
          <div className="text-sm text-gray-700">
            Найдено компаний:{' '}
            <span className="font-bold">{calcResult.count.toLocaleString('ru-RU')}</span>
          </div>
        )}

        {calcResult && calcResult.count > 0 && (
          <div className="rounded-2xl border border-gray-200 bg-white p-6 w-full max-w-lg">
            <h3 className="text-sm font-semibold text-gray-700 mb-4 text-center">
              Скачать базу
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
                  {exportLoading === 'xlsx' ? 'Формируем...' : 'Excel (.xlsx)'}
                </span>
                <span className="text-xs text-gray-500">Для работы в Excel</span>
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
                  {exportLoading === 'csv' ? 'Формируем...' : 'CSV (.csv)'}
                </span>
                <span className="text-xs text-gray-500">Универсальный формат</span>
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
          selected={selectedRegions}
          onChange={setSelectedRegions}
          onClose={() => setRegionsModalOpen(false)}
        />
      )}
      {activitiesModalOpen && (
        <OkvedTreeModal
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
    <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4">
      <div className="bg-white rounded-lg max-w-2xl w-full max-h-[80vh] flex flex-col">
        <div className="flex items-center justify-between p-5">
          <h3 className="text-lg font-bold">Регионы и города</h3>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-700 text-xl">
            ×
          </button>
        </div>
        <div className="px-5 pb-4">
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Быстрый поиск"
            className="w-full border-b border-gray-200 px-2 py-2 text-sm focus:outline-none focus:border-blue-400"
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
                    className="w-6 h-6 flex items-center justify-center text-gray-400 hover:text-gray-700"
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
                    className="w-4 h-4 accent-green-500"
                  />
                  <span className="text-sm">{district.name}</span>
                </div>
                {isOpen && (
                  <div className="ml-12 mt-1 space-y-1">
                    {district.regions.map((r) => (
                      <label key={r.code} className="flex items-center gap-2 cursor-pointer">
                        <input
                          type="checkbox"
                          checked={selected.has(r.code)}
                          onChange={() => toggle(r.code)}
                          className="w-4 h-4 accent-green-500"
                        />
                        <span className="text-sm font-bold mr-1">{r.code}</span>
                        <span className="text-sm">{r.name}</span>
                      </label>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
        <div
          className="flex items-center justify-between p-4"
          style={{ boxShadow: '0 -1px 0 rgba(0,0,0,0.06)' }}
        >
          <span className="text-sm text-gray-600">
            Выбрано регионов и городов: {selected.size}
          </span>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => onChange(new Set())}
              className="px-4 py-2 text-sm bg-gray-100 hover:bg-gray-200 rounded"
            >
              Очистить
            </button>
            <button
              type="button"
              onClick={() => onChange(new Set(ALL_REGION_CODES))}
              className="px-4 py-2 text-sm bg-gray-100 hover:bg-gray-200 rounded"
            >
              Все
            </button>
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 text-sm bg-blue-600 text-white rounded hover:bg-blue-700"
            >
              Готово
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

