'use client';

import { useEffect, useMemo, useState } from 'react';
import { ChevronDown, ChevronLeft, ChevronRight, RefreshCw } from 'lucide-react';
import {
  teamStatisticsIsoDate,
  normalizeStatistics,
  teamApiFetch,
  type TeamPeriodKind,
  type TeamPersonStatistics,
  type TeamProjectResult,
  type TeamStatisticsProjectRow,
  type TeamStatisticsResponse,
} from './teamApi';

type PeopleGroup = 'leads' | 'specialists';

const PERIODS: Array<{ value: TeamPeriodKind; label: string }> = [
  { value: 'month', label: 'Месяц' },
  { value: 'quarter', label: 'Квартал' },
  { value: 'half', label: 'Полугодие' },
  { value: 'year', label: 'Год' },
];

const SUMMARY_ITEMS: Array<{
  key: keyof TeamStatisticsResponse['summary'];
  label: string;
  tone: string;
}> = [
  { key: 'projects', label: 'Проектов за период', tone: 'text-gray-950' },
  { key: 'kpiMet', label: 'KPI выполнен', tone: 'text-emerald-700' },
  { key: 'kpiMissed', label: 'KPI не выполнен', tone: 'text-red-700' },
  { key: 'inProgress', label: 'В процессе', tone: 'text-amber-700' },
  { key: 'unclassified', label: 'Без оценки', tone: 'text-gray-600' },
  { key: 'leads', label: 'Лидов приведено', tone: 'text-gray-950' },
];

const RESULT_META: Record<TeamProjectResult, { label: string; dot: string; text: string }> = {
  met: { label: 'KPI выполнен', dot: 'bg-emerald-500', text: 'text-emerald-700' },
  missed: { label: 'KPI не выполнен', dot: 'bg-red-500', text: 'text-red-700' },
  in_progress: { label: 'В процессе', dot: 'bg-amber-500', text: 'text-amber-700' },
  unclassified: { label: 'Без оценки', dot: 'bg-gray-400', text: 'text-gray-500' },
};

function CoverageBadge({ coverage }: { coverage: TeamStatisticsResponse['coverage'] }) {
  const { status } = coverage;
  const meta = status === 'complete'
    ? { label: coverage.periodComplete ? 'Данные полные' : 'Данные по текущую дату', dot: 'bg-emerald-500', cls: 'text-emerald-700 bg-emerald-50 ring-emerald-600/20' }
    : status === 'partial'
      ? { label: 'Неполные данные', dot: 'bg-amber-500', cls: 'text-amber-800 bg-amber-50 ring-amber-600/20' }
      : { label: coverage.startsAt ? 'История не собиралась' : 'История пока не накоплена', dot: 'bg-gray-400', cls: 'text-gray-600 bg-gray-100 ring-gray-500/20' };

  return (
    <span className={`inline-flex min-h-7 items-center gap-1.5 rounded-lg px-2.5 py-1 text-xs font-medium ring-1 ring-inset ${meta.cls}`}>
      <span className={`h-1.5 w-1.5 rounded-full ${meta.dot}`} aria-hidden="true" />
      {meta.label}
    </span>
  );
}

function ResultLabel({ result }: { result: TeamProjectResult }) {
  const meta = RESULT_META[result];
  return (
    <span className={`inline-flex items-center gap-1.5 text-xs font-medium ${meta.text}`}>
      <span className={`h-1.5 w-1.5 rounded-full ${meta.dot}`} aria-hidden="true" />
      {meta.label}
    </span>
  );
}

function MetricValue({ value }: { value: number }) {
  return <span className="font-semibold tabular-nums text-gray-900">{value.toLocaleString('ru-RU')}</span>;
}

function projectTitle(project: TeamStatisticsProjectRow): string {
  return project.client?.trim() || project.name?.trim() || 'Без названия';
}

function shortCycleDate(value: string | null): string {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return '';
  return value.slice(8, 10) + '.' + value.slice(5, 7);
}

function projectCycleLabel(project: TeamStatisticsProjectRow): string {
  const start = shortCycleDate(project.periodStart);
  const end = shortCycleDate(project.periodEnd);
  if (start && end) return 'Цикл ' + start + '–' + end;
  if (start) return 'Цикл с ' + start;
  return '';
}

function ProjectDetails({ person }: { person: TeamPersonStatistics }) {
  if (person.projectRows.length === 0) {
    return <p className="px-4 py-4 text-sm text-gray-500">Для этого периода проекты не найдены.</p>;
  }

  return (
    <div className="divide-y divide-gray-100 bg-gray-50/70">
      {person.projectRows.map((project) => {
        const title = projectTitle(project);
        const services = project.client?.trim() && project.name?.trim() && project.client.trim() !== project.name.trim()
          ? project.name.trim()
          : '';
        const cycle = projectCycleLabel(project);
        return (
          <div
            key={project.id || `${person.name}:${title}`}
            className="grid gap-2 px-4 py-3 md:grid-cols-[minmax(220px,1fr)_150px_110px_110px] md:items-center md:px-6"
          >
            <div className="min-w-0">
              <p className="truncate text-sm font-medium text-gray-800">{title}</p>
              <p className="truncate text-xs text-gray-500">
                {[services, cycle, project.status].filter(Boolean).join(' · ') || 'Статус не указан'}
              </p>
            </div>
            <ResultLabel result={project.result} />
            <p className="text-xs text-gray-500 md:text-center">
              KPI: <span className="tabular-nums text-gray-700">{project.kpiFact ?? '—'} / {project.kpiPlan ?? '—'}</span>
            </p>
            <p className="text-xs text-gray-500 md:text-right">
              Лидов: <span className="font-medium tabular-nums text-gray-800">{project.leads}</span>
            </p>
          </div>
        );
      })}
    </div>
  );
}

function DesktopPeopleTable({
  people,
  expanded,
  onToggle,
}: {
  people: TeamPersonStatistics[];
  expanded: Set<string>;
  onToggle: (key: string) => void;
}) {
  return (
    <div className="hidden overflow-x-auto md:block">
      <table className="w-full min-w-[1020px] border-collapse">
        <thead>
          <tr className="border-b border-gray-100 bg-gray-50/70 text-left">
            <th className="px-5 py-3 text-xs font-semibold uppercase tracking-wide text-gray-500">Сотрудник</th>
            <th className="px-3 py-3 text-center text-xs font-semibold uppercase tracking-wide text-gray-500">Проектов</th>
            <th className="px-3 py-3 text-center text-xs font-semibold uppercase tracking-wide text-gray-500">KPI выполнен</th>
            <th className="px-3 py-3 text-center text-xs font-semibold uppercase tracking-wide text-gray-500">KPI не выполнен</th>
            <th className="px-3 py-3 text-center text-xs font-semibold uppercase tracking-wide text-gray-500">В процессе</th>
            <th className="px-3 py-3 text-center text-xs font-semibold uppercase tracking-wide text-gray-500">Без оценки</th>
            <th className="px-5 py-3 text-right text-xs font-semibold uppercase tracking-wide text-gray-500">Лидов приведено</th>
          </tr>
        </thead>
        <tbody>
          {people.map((person) => {
            const key = person.id || person.name;
            const open = expanded.has(key);
            const regionId = `team-stats-projects-${encodeURIComponent(key).replace(/%/g, '')}`;
            return (
              <FragmentRow
                key={key}
                person={person}
                open={open}
                regionId={regionId}
                onToggle={() => onToggle(key)}
              />
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function FragmentRow({
  person,
  open,
  regionId,
  onToggle,
}: {
  person: TeamPersonStatistics;
  open: boolean;
  regionId: string;
  onToggle: () => void;
}) {
  return (
    <>
      <tr className="border-b border-gray-100 bg-white transition-colors hover:bg-gray-50">
        <td className="p-0">
          <button
            type="button"
            onClick={onToggle}
            aria-expanded={open}
            aria-controls={regionId}
            className="flex min-h-14 w-full items-center gap-3 px-5 py-2.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-blue-500"
          >
            <ChevronDown
              className={`h-4 w-4 shrink-0 text-gray-400 transition-transform duration-200 ${open ? 'rotate-180' : ''}`}
              aria-hidden="true"
            />
            <span className="min-w-0">
              <span className="block truncate text-sm font-semibold text-gray-900">{person.name}</span>
              <span className="block text-xs text-gray-500">
                {person.projectRows.length > 0 ? 'Показать проекты' : 'Нет детализации'}
              </span>
            </span>
          </button>
        </td>
        <td className="px-3 py-3 text-center"><MetricValue value={person.projects} /></td>
        <td className="px-3 py-3 text-center"><MetricValue value={person.kpiMet} /></td>
        <td className="px-3 py-3 text-center"><MetricValue value={person.kpiMissed} /></td>
        <td className="px-3 py-3 text-center"><MetricValue value={person.inProgress} /></td>
        <td className="px-3 py-3 text-center"><MetricValue value={person.unclassified} /></td>
        <td className="px-5 py-3 text-right"><MetricValue value={person.leads} /></td>
      </tr>
      {open && (
        <tr id={regionId}>
          <td colSpan={7} className="p-0">
            <ProjectDetails person={person} />
          </td>
        </tr>
      )}
    </>
  );
}

function MobilePeopleList({
  people,
  expanded,
  onToggle,
}: {
  people: TeamPersonStatistics[];
  expanded: Set<string>;
  onToggle: (key: string) => void;
}) {
  return (
    <div className="divide-y divide-gray-100 md:hidden">
      {people.map((person) => {
        const key = person.id || person.name;
        const open = expanded.has(key);
        const regionId = `team-stats-mobile-projects-${encodeURIComponent(key).replace(/%/g, '')}`;
        return (
          <div key={key} className="bg-white">
            <button
              type="button"
              onClick={() => onToggle(key)}
              aria-expanded={open}
              aria-controls={regionId}
              className="min-h-11 w-full px-4 py-4 text-left outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-blue-500"
            >
              <span className="flex items-center justify-between gap-3">
                <span className="truncate text-sm font-semibold text-gray-900">{person.name}</span>
                <ChevronDown
                  className={`h-4 w-4 shrink-0 text-gray-400 transition-transform duration-200 ${open ? 'rotate-180' : ''}`}
                  aria-hidden="true"
                />
              </span>
              <span className="mt-3 grid grid-cols-2 gap-x-5 gap-y-2 text-xs text-gray-500">
                <span className="flex justify-between gap-2">Проектов <MetricValue value={person.projects} /></span>
                <span className="flex justify-between gap-2">KPI выполнен <MetricValue value={person.kpiMet} /></span>
                <span className="flex justify-between gap-2">KPI не выполнен <MetricValue value={person.kpiMissed} /></span>
                <span className="flex justify-between gap-2">В процессе <MetricValue value={person.inProgress} /></span>
                <span className="flex justify-between gap-2">Без оценки <MetricValue value={person.unclassified} /></span>
                <span className="flex justify-between gap-2">
                  Лидов приведено <MetricValue value={person.leads} />
                </span>
              </span>
            </button>
            {open && <div id={regionId}><ProjectDetails person={person} /></div>}
          </div>
        );
      })}
    </div>
  );
}

function StatisticsSkeleton() {
  return (
    <div className="space-y-4" aria-label="Загрузка статистики">
      <div className="h-24 animate-pulse rounded-2xl border border-gray-100 bg-gray-100" />
      <div className="overflow-hidden rounded-2xl border border-gray-200 bg-white">
        {[0, 1, 2, 3].map((item) => (
          <div key={item} className="flex h-16 items-center gap-4 border-b border-gray-100 px-5 last:border-0">
            <span className="h-4 w-1/3 animate-pulse rounded bg-gray-100" />
            <span className="ml-auto h-4 w-12 animate-pulse rounded bg-gray-100" />
            <span className="h-4 w-12 animate-pulse rounded bg-gray-100" />
          </div>
        ))}
      </div>
    </div>
  );
}

export default function TeamStatisticsPanel() {
  const [periodKind, setPeriodKind] = useState<TeamPeriodKind>('month');
  const [anchor, setAnchor] = useState(teamStatisticsIsoDate);
  const [group, setGroup] = useState<PeopleGroup>('leads');
  const [data, setData] = useState<TeamStatisticsResponse | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState('');
  const [requestVersion, setRequestVersion] = useState(0);


  useEffect(() => {
    let cancelled = false;
    const run = async () => {
      if (data) setRefreshing(true);
      else setLoading(true);
      setError('');
      try {
        const params = new URLSearchParams({ period: periodKind, anchor });
        const payload = await teamApiFetch(`/api/team/statistics?${params.toString()}`);
        if (!cancelled) {
          setData(normalizeStatistics(payload));
          setExpanded(new Set());
        }
      } catch (loadError) {
        if (!cancelled) {
          setError(loadError instanceof Error ? loadError.message : 'Не удалось загрузить статистику.');
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
          setRefreshing(false);
        }
      }
    };
    void run();
    return () => { cancelled = true; };
    // requestVersion intentionally triggers a retry with the same period.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [anchor, periodKind, requestVersion]);

  const people = data?.groups[group] ?? [];
  const periodLabel = data?.period.label
    || (data?.period.start && data?.period.end ? `${data.period.start} – ${data.period.end}` : 'Выбранный период');

  const togglePerson = (key: string) => {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const periodButtons = useMemo(() => PERIODS.map((period) => (
    <button
      key={period.value}
      type="button"
      aria-pressed={periodKind === period.value}
      onClick={() => {
        setPeriodKind(period.value);
        setAnchor(teamStatisticsIsoDate());
      }}
      className={`min-h-11 rounded-lg px-3 text-sm font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-1 ${
        periodKind === period.value
          ? 'bg-gray-900 text-white'
          : 'text-gray-600 hover:bg-gray-100 hover:text-gray-900'
      }`}
    >
      {period.label}
    </button>
  )), [periodKind]);

  return (
    <section className="space-y-5" aria-labelledby="team-statistics-title">
      <div className="flex flex-col gap-4 xl:flex-row xl:items-end xl:justify-between">
        <div>
          <h2 id="team-statistics-title" className="text-xl font-bold tracking-tight text-gray-900">Статистика команды</h2>
          <p className="mt-1 text-sm text-gray-500">Для лидов и специалистов подготовка входит в количество проектов и считается «В процессе»; в KPI и лиды она не входит. KPI оценивается только по завершённым циклам, лиды — по приросту KPI-факта за период.</p>
        </div>
        <div className="flex flex-col gap-2 sm:items-end">
          <div role="group" className="grid grid-cols-2 rounded-xl border border-gray-200 bg-white p-1 sm:grid-cols-4" aria-label="Период статистики">
            {periodButtons}
          </div>
          <div className="flex items-center justify-between gap-2 sm:justify-end">
            <button
              type="button"
              aria-label="Предыдущий период"
              disabled={!data?.period.previousAnchor || refreshing}
              onClick={() => data?.period.previousAnchor && setAnchor(data.period.previousAnchor)}
              className="flex h-11 w-11 items-center justify-center rounded-xl border border-gray-200 bg-white text-gray-600 outline-none hover:bg-gray-50 focus-visible:ring-2 focus-visible:ring-blue-500 disabled:cursor-not-allowed disabled:opacity-40"
            >
              <ChevronLeft className="h-4 w-4" aria-hidden="true" />
            </button>
            <div className="min-w-0 flex-1 text-center sm:min-w-[230px]">
              <p className="truncate text-sm font-semibold text-gray-900">{periodLabel}</p>
              {data && <p className="mt-0.5 text-xs text-gray-500">{data.period.start} – {data.period.end}</p>}
            </div>
            <button
              type="button"
              aria-label="Следующий период"
              disabled={!data?.period.nextAnchor || refreshing}
              onClick={() => data?.period.nextAnchor && setAnchor(data.period.nextAnchor)}
              className="flex h-11 w-11 items-center justify-center rounded-xl border border-gray-200 bg-white text-gray-600 outline-none hover:bg-gray-50 focus-visible:ring-2 focus-visible:ring-blue-500 disabled:cursor-not-allowed disabled:opacity-40"
            >
              <ChevronRight className="h-4 w-4" aria-hidden="true" />
            </button>
          </div>
        </div>
      </div>

      {error && (
        <div className="flex flex-col gap-3 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800 sm:flex-row sm:items-center sm:justify-between" role="alert">
          <span>{error}</span>
          <button
            type="button"
            onClick={() => {
              setRequestVersion((value) => value + 1);
            }}
            className="inline-flex min-h-11 items-center justify-center gap-2 rounded-lg border border-red-300 bg-white px-3 font-medium outline-none hover:bg-red-100 focus-visible:ring-2 focus-visible:ring-red-500"
          >
            <RefreshCw className="h-4 w-4" aria-hidden="true" />
            Повторить
          </button>
        </div>
      )}

      {loading && !data ? <StatisticsSkeleton /> : data && (
        <div className={`space-y-5 transition-opacity ${refreshing ? 'pointer-events-none opacity-60' : ''}`} aria-busy={refreshing}>
          <div className="flex flex-wrap items-start gap-3">
            <CoverageBadge coverage={data.coverage} />
            {data.coverage.message && (
              <p className="max-w-3xl pt-1 text-sm text-gray-600">{data.coverage.message}</p>
            )}
          </div>

          {data.coverage.status !== 'unavailable' && (
            <>
              <div className="hidden overflow-hidden rounded-2xl border border-gray-200 bg-white md:grid md:grid-cols-6 md:divide-x md:divide-gray-100">
                {SUMMARY_ITEMS.map((item) => (
                  <div key={item.key} className="px-5 py-4">
                    <p className="text-xs font-medium text-gray-500">{item.label}</p>
                    <p className={`mt-1 text-2xl font-bold tabular-nums ${item.tone}`}>
                      {data.summary[item.key].toLocaleString('ru-RU')}
                    </p>
                  </div>
                ))}
              </div>

              <div className="grid grid-cols-2 gap-2 md:hidden">
                {SUMMARY_ITEMS.map((item) => (
                  <div
                    key={item.key}
                    className="rounded-xl border border-gray-200 bg-white px-4 py-3"
                  >
                    <p className="text-xs font-medium text-gray-500">{item.label}</p>
                    <p className={`mt-1 text-xl font-bold tabular-nums ${item.tone}`}>
                      {data.summary[item.key].toLocaleString('ru-RU')}
                    </p>
                  </div>
                ))}
              </div>
            </>
          )}

          {data.coverage.status === 'unavailable' ? (
            <div className="rounded-2xl border border-gray-200 bg-white px-5 py-10 text-center">
              <p className="text-base font-semibold text-gray-900">
                {data.coverage.startsAt ? 'За этот период история не собиралась' : 'История пока не накоплена'}
              </p>
              <p className="mx-auto mt-1 max-w-xl text-sm text-gray-500">
                {data.coverage.startsAt
                  ? 'Выберите более новый период. Периоды после даты запуска будут считаться полностью.'
                  : 'Первый снимок появится после запуска сбора. Новые периоды будут считаться точно.'}
              </p>
            </div>
          ) : (
            <div className="overflow-hidden rounded-2xl border border-gray-200 bg-white">
              <div className="flex flex-col gap-3 border-b border-gray-100 bg-gray-50/60 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
                <div>
                  <p className="text-base font-bold text-gray-900">{group === 'leads' ? 'Лиды' : 'Специалисты'}</p>
                  <p className="text-xs text-gray-500">{people.length} сотрудников за период</p>
                </div>
                <div role="group" className="grid grid-cols-2 rounded-xl border border-gray-200 bg-white p-1" aria-label="Группа сотрудников">
                  <button
                    type="button"
                    aria-pressed={group === 'leads'}
                    onClick={() => {
                      setGroup('leads');
                      setExpanded(new Set());
                    }}
                    className={`min-h-11 rounded-lg px-4 text-sm font-medium outline-none focus-visible:ring-2 focus-visible:ring-blue-500 ${
                      group === 'leads' ? 'bg-gray-900 text-white' : 'text-gray-600 hover:bg-gray-100'
                    }`}
                  >
                    Лиды
                  </button>
                  <button
                    type="button"
                    aria-pressed={group === 'specialists'}
                    onClick={() => {
                      setGroup('specialists');
                      setExpanded(new Set());
                    }}
                    className={`min-h-11 rounded-lg px-4 text-sm font-medium outline-none focus-visible:ring-2 focus-visible:ring-blue-500 ${
                      group === 'specialists' ? 'bg-gray-900 text-white' : 'text-gray-600 hover:bg-gray-100'
                    }`}
                  >
                    Специалисты
                  </button>
                </div>
              </div>

              {people.length === 0 ? (
                <div className="px-5 py-10 text-center">
                  <p className="text-sm font-semibold text-gray-900">За период сотрудников с проектами нет</p>
                  <p className="mt-1 text-sm text-gray-500">Попробуйте соседний период или другую группу.</p>
                </div>
              ) : (
                <>
                  <DesktopPeopleTable people={people} expanded={expanded} onToggle={togglePerson} />
                  <MobilePeopleList people={people} expanded={expanded} onToggle={togglePerson} />
                </>
              )}
            </div>
          )}
        </div>
      )}
    </section>
  );
}
