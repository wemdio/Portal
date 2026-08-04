'use client';

import { useEffect, useMemo, useState, type Dispatch, type SetStateAction } from 'react';
import { supabase } from '@/lib/supabaseClient';
import { logError } from '@/lib/loggerClient';
import { useIsTma } from '@/lib/useIsTma';
import { UserProfile, UserRole } from '@/types';
import { getAssigneeDisplayName } from '@/lib/projectAssignees';
import { normalizePublicAvatarUrl } from '@/lib/publicAvatarUrl';
import { useUser } from '@/lib/UserProvider';
import { isLead } from '@/lib/roles';
import TeamStatisticsPanel from '@/components/team/TeamStatisticsPanel';
import TeamReviewsPanel from '@/components/team/TeamReviewsPanel';

interface ProjectData {
  id: string;
  client: string | null;
  name: string;
  status: string;
  manager: string | null;
  specialist: string | null;
  kpi_plan: string | null;
  kpi_fact: string | null;
}

/** Заголовок проекта в приложении — это client («Onescreen»); name хранит услуги («Аутрич, Лидскан»). */
function projectTitle(p: ProjectData): string {
  return p.client?.trim() || p.name?.trim() || 'Без названия';
}

function isFinishedStatus(status: string | null | undefined): boolean {
  const s = (status || '').toLowerCase();
  return s.includes('заверш') || s.includes('отмен');
}

function isPausedStatus(status: string | null | undefined): boolean {
  return (status || '').toLowerCase().includes('пауз');
}

type ProfileData = Pick<UserProfile, 'id' | 'email' | 'full_name' | 'role' | 'avatar_url'>;

const STORAGE_KEY_CAPACITY = 'portal:team-capacity';
const DEFAULT_CAPACITY = 4;
const LEAD_ROLES = new Set<UserRole>(['lead']);
const NO_SPEC = '— без специалиста';

type TeamWorkspaceView = 'load' | 'statistics' | 'reviews';
const TEAM_WORKSPACE_VIEWS = [
  ['load', 'Загрузка'],
  ['statistics', 'Статистика'],
  ['reviews', 'Ревью'],
] as const satisfies ReadonlyArray<readonly [TeamWorkspaceView, string]>;
type Segment = 'leads' | 'specs' | 'projects';
type SortKey = 'projects' | 'load' | 'result' | 'name';
type StatusFilter = 'all' | 'Перегруз' | 'Норма' | 'Свободен';
type ResultCat = 'delivered' | 'missed' | 'prep' | 'work' | 'other';
type ResultFilter = 'all' | ResultCat;

function normalizeAssigneeName(value: string | null | undefined): string {
  return value?.trim() || '';
}

function isWorkingStatus(status: string | null | undefined): boolean {
  const s = (status || '').toLowerCase();
  return s.includes('работ') || s.includes('тест');
}
function isPrepStatus(status: string | null | undefined): boolean {
  return (status || '').toLowerCase().includes('подготов');
}

/** Проекты, которые занимают ёмкость команды: уже в работе или ещё на подготовке. */
function countsTowardCapacity(status: string | null | undefined): boolean {
  return isWorkingStatus(status) || isPrepStatus(status);
}

/** kpi_plan / kpi_fact are free-text; pull the first number out. */
function parseNum(value: string | null | undefined): number | null {
  if (value == null) return null;
  const m = String(value).replace(/\s/g, '').match(/-?\d+([.,]\d+)?/);
  if (!m) return null;
  const n = parseFloat(m[0].replace(',', '.'));
  return Number.isNaN(n) ? null : n;
}

interface Result {
  cat: ResultCat;
  label: string;
  badgeCls: string;
  dotCls: string;
}

/**
 * Проектный «результат» из статуса + KPI (kpi_fact «доведено» / kpi_plan «цель»).
 * Совпадает с ручной колонкой «Результат проекта» в Excel: довели/не довели (X из Y).
 */
function deriveResult(p: ProjectData): Result {
  const st = (p.status || '').toLowerCase();
  if (isPrepStatus(st)) {
    return { cat: 'prep', label: 'Подготовка', badgeCls: 'bg-amber-50 text-amber-700 ring-amber-600/20', dotCls: 'bg-amber-500' };
  }
  const fact = parseNum(p.kpi_fact);
  const goal = parseNum(p.kpi_plan);
  // Есть числовая цель (в т.ч. извлечённая из текста «20 встреч»/«10 квалов» → 20/10): показываем вердикт.
  if (goal != null && goal > 0) {
    const f = fact ?? 0;
    const suffix = ` (${f} из ${goal})`;
    if (f < goal) {
      return { cat: 'missed', label: 'Не довели лидов' + suffix, badgeCls: 'bg-red-50 text-red-700 ring-red-600/20', dotCls: 'bg-red-500' };
    }
    return { cat: 'delivered', label: 'Довели лидов' + suffix, badgeCls: 'bg-emerald-50 text-emerald-700 ring-emerald-600/20', dotCls: 'bg-emerald-500' };
  }
  // Цели нет: если есть доведённые лиды — показываем просто их число (нейтрально, без ложного «довели»).
  if (fact != null && fact > 0) {
    return { cat: 'work', label: `${fact} ${pluralRu(fact, 'лид', 'лида', 'лидов')}`, badgeCls: 'bg-gray-100 text-gray-600 ring-gray-500/20', dotCls: 'bg-gray-400' };
  }
  if (st.includes('отмен')) {
    return { cat: 'other', label: 'Отменён', badgeCls: 'bg-gray-100 text-gray-500 ring-gray-500/20', dotCls: 'bg-gray-400' };
  }
  if (st.includes('пауз')) {
    return { cat: 'other', label: 'На паузе', badgeCls: 'bg-gray-100 text-gray-500 ring-gray-500/20', dotCls: 'bg-gray-400' };
  }
  if (st.includes('заверш')) {
    return { cat: 'other', label: 'Завершён', badgeCls: 'bg-gray-100 text-gray-500 ring-gray-500/20', dotCls: 'bg-gray-400' };
  }
  return { cat: 'work', label: 'в работе', badgeCls: 'bg-gray-100 text-gray-600 ring-gray-500/20', dotCls: 'bg-gray-400' };
}

interface Roll { delivered: number; missed: number; work: number; prep: number }
function rollup(projects: ProjectData[]): Roll {
  const r: Roll = { delivered: 0, missed: 0, work: 0, prep: 0 };
  for (const p of projects) {
    const c = deriveResult(p).cat;
    if (c === 'delivered' || c === 'missed' || c === 'work' || c === 'prep') r[c]++;
  }
  return r;
}

function getLoadStatus(occupied: number, plan: number): { label: StatusFilter; color: string } {
  if (plan === 0) return occupied > 0
    ? { label: 'Перегруз', color: 'text-red-700 bg-red-50 ring-red-600/20' }
    : { label: 'Свободен', color: 'text-emerald-700 bg-emerald-50 ring-emerald-600/20' };
  const ratio = occupied / plan;
  if (ratio > 1.1) return { label: 'Перегруз', color: 'text-red-700 bg-red-50 ring-red-600/20' };
  if (ratio < 0.7) return { label: 'Свободен', color: 'text-emerald-700 bg-emerald-50 ring-emerald-600/20' };
  return { label: 'Норма', color: 'text-blue-700 bg-blue-50 ring-blue-600/20' };
}
function loadPercent(occupied: number, plan: number): number {
  return plan > 0 ? Math.round((occupied / plan) * 100) : (occupied > 0 ? Number.POSITIVE_INFINITY : 0);
}

// The shared 7-column grid (name / status / all capacity projects / prep subset / plan / load / results).
const GRID = 'grid grid-cols-[minmax(230px,1fr)_116px_82px_78px_104px_196px_176px] items-center';

function TeamMemberAvatar({
  displayName,
  avatarUrl,
  signedUrl,
  variant,
  size = 'md',
}: {
  displayName: string;
  avatarUrl: string | null | undefined;
  signedUrl?: string | null;
  variant: 'manager' | 'specialist';
  size?: 'md' | 'sm';
}) {
  const [failedUrls, setFailedUrls] = useState<Set<string>>(new Set());
  const publicUrl = normalizePublicAvatarUrl(avatarUrl);
  const url = (signedUrl && !failedUrls.has(signedUrl)) ? signedUrl
    : (publicUrl && !failedUrls.has(publicUrl)) ? publicUrl
    : null;
  const initial = displayName.charAt(0).toUpperCase();
  const dim = size === 'sm' ? 'h-7 w-7 text-xs' : 'h-9 w-9 text-sm';
  const bgClass = variant === 'manager' ? 'bg-blue-50 border-blue-100 text-blue-600' : 'bg-gray-100 border-gray-200 text-gray-600';

  return (
    <div className={`${dim} rounded-full flex items-center justify-center overflow-hidden border flex-shrink-0 ${url ? '' : bgClass}`}>
      {url ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          key={url}
          src={url}
          alt=""
          className="h-full w-full object-cover"
          loading="lazy"
          decoding="async"
          fetchPriority="low"
          onError={() => setFailedUrls((prev) => new Set(prev).add(url))}
        />
      ) : (
        <span className="font-bold">{initial}</span>
      )}
    </div>
  );
}

function RollupStrip({ roll }: { roll: Roll }) {
  const items: { n: number; dot: string; text: string; title: string }[] = [];
  if (roll.delivered) items.push({ n: roll.delivered, dot: 'bg-emerald-500', text: 'text-emerald-700', title: 'Довели лидов' });
  if (roll.missed) items.push({ n: roll.missed, dot: 'bg-red-500', text: 'text-red-600', title: 'Не довели' });
  if (roll.work) items.push({ n: roll.work, dot: 'bg-gray-400', text: 'text-gray-500', title: 'В работе' });
  if (roll.prep) items.push({ n: roll.prep, dot: 'bg-amber-500', text: 'text-amber-600', title: 'Подготовка' });
  if (!items.length) return <span className="text-xs text-gray-400">—</span>;
  return (
    <div className="flex items-center gap-2.5 flex-wrap">
      {items.map((it, i) => (
        <span key={i} title={it.title} className={`inline-flex items-center gap-1 text-xs font-semibold tabular-nums ${it.text}`}>
          <span className={`h-1.5 w-1.5 rounded-full ${it.dot}`} />{it.n}
        </span>
      ))}
    </div>
  );
}

function LoadBar({ occupied, plan }: { occupied: number; plan: number }) {
  const pct = loadPercent(occupied, plan);
  const overloaded = pct > 110;
  const color = overloaded ? 'bg-red-500' : pct > 85 ? 'bg-amber-500' : 'bg-emerald-500';
  const label = Number.isFinite(pct) ? `${pct}%` : '>100%';
  return (
    <div className="flex items-center gap-3">
      <div className="flex-1 h-2 bg-gray-100 rounded-full overflow-hidden">
        <div className={`h-full rounded-full transition-all duration-500 ${color}`} style={{ width: `${Math.min(100, pct)}%` }} />
      </div>
      <span className="text-xs font-medium text-gray-600 w-11 text-right tabular-nums">{label}</span>
    </div>
  );
}

function ResultBadge({ p }: { p: ProjectData }) {
  const r = deriveResult(p);
  // KPI-вердикт перекрывает статус «На паузе» — показываем паузу отдельной припиской.
  const pausedNote = isPausedStatus(p.status) && r.label !== 'На паузе';
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs font-medium ring-1 ring-inset ${r.badgeCls}`}>
        <span className={`h-1.5 w-1.5 rounded-full ${r.dotCls}`} />{r.label}
      </span>
      {pausedNote && <span className="text-[11px] text-gray-400 whitespace-nowrap">· на паузе</span>}
    </span>
  );
}

function Caret({ open, hidden }: { open: boolean; hidden?: boolean }) {
  return (
    <span className={`flex items-center justify-center w-4 h-4 text-gray-400 transition-transform ${open ? 'rotate-90' : ''} ${hidden ? 'invisible' : ''}`}>
      <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3"><path d="M9 6l6 6-6 6" /></svg>
    </span>
  );
}

export default function TeamPage() {
  const isTma = useIsTma();
  const { userRole } = useUser();
  const canViewPrivateWorkspaces = isLead(userRole);
  const [workspaceView, setWorkspaceView] = useState<TeamWorkspaceView>('load');
  const [projects, setProjects] = useState<ProjectData[]>([]);
  const [profiles, setProfiles] = useState<ProfileData[]>([]);
  const [loading, setLoading] = useState(true);
  const [capacities, setCapacities] = useState<Record<string, number>>({});
  const [avatarSignedUrls, setAvatarSignedUrls] = useState<Record<string, string>>({});

  const [segment, setSegment] = useState<Segment>('leads');
  const [query, setQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [resultFilter, setResultFilter] = useState<ResultFilter>('all');
  const [sortKey, setSortKey] = useState<SortKey>('projects');
  const [openLeads, setOpenLeads] = useState<Set<string>>(new Set());
  const [openSpecInLead, setOpenSpecInLead] = useState<Set<string>>(new Set());
  const [openSpecs, setOpenSpecs] = useState<Set<string>>(new Set());
  const activeWorkspaceView = canViewPrivateWorkspaces ? workspaceView : 'load';

  const nameToAvatarUrl = useMemo(() => {
    const map = new Map<string, string>();
    for (const p of profiles) {
      const name = normalizeAssigneeName(getAssigneeDisplayName(p));
      const url = typeof p.avatar_url === 'string' ? p.avatar_url.trim() : '';
      if (name && url) map.set(name, url);
    }
    return map;
  }, [profiles]);

  useEffect(() => {
    if (profiles.length === 0) return;
    let cancelled = false;

    const fetchAvatars = async () => {
      try {
        const { data: { session } } = await supabase.auth.getSession();
        const token = session?.access_token;
        if (!token || cancelled) return;
        const res = await fetch('/api/avatars/batch-signed', {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (!res.ok || cancelled) return;
        const data = (await res.json()) as Record<string, string>;
        if (cancelled || typeof data !== 'object') return;
        setAvatarSignedUrls(data);
      } catch {
        // ignore
      }
    };

    void fetchAvatars();
    const interval = setInterval(() => void fetchAvatars(), 30 * 60 * 1000);
    const onVisibility = () => {
      if (document.visibilityState === 'visible') void fetchAvatars();
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      cancelled = true;
      clearInterval(interval);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [profiles.length]);

  const loadCapacities = () => {
    try {
      const stored = localStorage.getItem(STORAGE_KEY_CAPACITY);
      if (stored) setCapacities(JSON.parse(stored));
    } catch (e) {
      void logError('team.capacity.load.failed', e);
    }
  };

  const saveCapacity = (name: string, value: number) => {
    const newCapacities = { ...capacities, [name]: value };
    setCapacities(newCapacities);
    localStorage.setItem(STORAGE_KEY_CAPACITY, JSON.stringify(newCapacities));
  };

  async function fetchData() {
    try {
      const [projectsResult, profilesResult] = await Promise.all([
        supabase.from('projects').select('id, client, name, status, manager, specialist, kpi_plan, kpi_fact'),
        supabase.from('profiles').select('id, email, full_name, role, avatar_url'),
      ]);
      if (projectsResult.error) throw projectsResult.error;
      if (profilesResult.error) throw profilesResult.error;
      // Завершённые/отменённые не участвуют нигде: считаем только в работе/тест/подготовку (+пауза).
      setProjects(((projectsResult.data as ProjectData[]) || []).filter((p) => !isFinishedStatus(p.status)));
      setProfiles((profilesResult.data as ProfileData[]) || []);
    } catch (error) {
      void logError('team.data.fetch.failed', error);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    // Initial state is synchronized once from Supabase and localStorage.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void fetchData();
    loadCapacities();
  }, []);

  // ---- derived model ----
  const model = useMemo(() => {
    const projByManager = new Map<string, ProjectData[]>();
    const projBySpec = new Map<string, ProjectData[]>();
    for (const p of projects) {
      const m = normalizeAssigneeName(p.manager);
      if (m) { const a = projByManager.get(m) || []; a.push(p); projByManager.set(m, a); }
      const s = normalizeAssigneeName(p.specialist);
      if (s) { const a = projBySpec.get(s) || []; a.push(p); projBySpec.set(s, a); }
    }

    const leadNames = new Set<string>();
    const specNames = new Set<string>();
    profiles.forEach((profile) => {
      const name = normalizeAssigneeName(getAssigneeDisplayName(profile));
      if (!name || profile.role === 'client') return;
      if (profile.role && LEAD_ROLES.has(profile.role)) leadNames.add(name);
      else if (profile.role) specNames.add(name);
    });
    projByManager.forEach((_, name) => leadNames.add(name));
    projBySpec.forEach((_, name) => specNames.add(name));

    const specStat = (name: string) => {
      const list = projBySpec.get(name) || [];
      const occupied = list.filter((p) => countsTowardCapacity(p.status)).length;
      const prep = list.filter((p) => isPrepStatus(p.status)).length;
      const plan = capacities[`specialist:${name}`] ?? DEFAULT_CAPACITY;
      return { name, occupied, prep, plan, projects: list, roll: rollup(list) };
    };

    const leads = Array.from(leadNames).map((name) => {
      const list = projByManager.get(name) || [];
      const occupied = list.filter((p) => countsTowardCapacity(p.status)).length;
      const prep = list.filter((p) => isPrepStatus(p.status)).length;
      const plan = capacities[`manager:${name}`] ?? DEFAULT_CAPACITY;
      return { name, occupied, prep, plan, projects: list, roll: rollup(list) };
    });

    const specialists = Array.from(specNames).map(specStat);

    return { leads, specialists, specStat };
  }, [projects, profiles, capacities]);

  // ---- top KPI ----
  const kpi = useMemo(() => {
    const occupied = projects.filter((p) => countsTowardCapacity(p.status)).length;
    const totalPlan = model.specialists.reduce((s, x) => s + x.plan, 0);
    const totalOccupied = model.specialists.reduce((s, x) => s + x.occupied, 0);
    const free = Math.max(0, totalPlan - totalOccupied);
    const load = totalPlan > 0
      ? Math.round((totalOccupied / totalPlan) * 100)
      : (totalOccupied > 0 ? Number.POSITIVE_INFINITY : 0);
    const r = rollup(projects);
    const totalLeads = projects.reduce(
      (sum, project) => isPrepStatus(project.status) ? sum : sum + (parseNum(project.kpi_fact) ?? 0),
      0,
    );
    return { occupied, totalPlan, free, load, delivered: r.delivered, missed: r.missed, totalLeads };
  }, [projects, model.specialists]);

  const q = query.trim().toLowerCase();
  const matchProject = (p: ProjectData) =>
    projectTitle(p).toLowerCase().includes(q) ||
    (p.name || '').toLowerCase().includes(q) ||
    normalizeAssigneeName(p.specialist).toLowerCase().includes(q) ||
    normalizeAssigneeName(p.manager).toLowerCase().includes(q);

  const sortPeople = <T extends { name: string; occupied: number; plan: number; roll: Roll }>(list: T[]): T[] => {
    const arr = [...list];
    arr.sort((a, b) => {
      switch (sortKey) {
        case 'name': return a.name.localeCompare(b.name, 'ru-RU');
        case 'load': return (loadPercent(b.occupied, b.plan) - loadPercent(a.occupied, a.plan)) || a.name.localeCompare(b.name, 'ru-RU');
        case 'result': return (b.roll.delivered - a.roll.delivered) || (b.roll.missed - a.roll.missed) || (b.occupied - a.occupied);
        default: return (b.occupied - a.occupied) || a.name.localeCompare(b.name, 'ru-RU');
      }
    });
    return arr;
  };


  const isProjectsView = segment === 'projects';

  const kpiCards = [
    { label: 'Проектов в загрузке', value: kpi.occupied, suf: 'работа + подготовка' },
    { label: 'Мест у специалистов', value: kpi.totalPlan, suf: 'план' },
    { label: 'Свободно у специалистов', value: kpi.free, suf: 'можно взять' },
    { label: 'Загрузка специалистов', value: Number.isFinite(kpi.load) ? `${kpi.load}%` : '>100%', suf: 'от плана' },
  ];

  const segButton = (key: Segment, label: string) => (
    <button
      type="button"
      onClick={() => setSegment(key)}
      className={`h-8 px-3.5 rounded-lg text-sm font-semibold transition-colors ${segment === key ? 'bg-gray-100 text-gray-900 shadow-sm' : 'text-gray-500 hover:text-gray-800'}`}
    >
      {label}
    </button>
  );

  const statusChip = (key: StatusFilter, label: string, dot?: string) => (
    <button
      type="button"
      onClick={() => setStatusFilter(key)}
      className={`h-8 px-3 rounded-lg text-sm font-medium inline-flex items-center gap-1.5 transition-colors ${statusFilter === key ? 'bg-gray-100 text-gray-900' : 'text-gray-500 hover:text-gray-800'}`}
    >
      {dot && <span className={`h-1.5 w-1.5 rounded-full ${dot}`} />}{label}
    </button>
  );

  const resultChip = (key: ResultFilter, label: string, dot?: string) => {
    const count = key === 'all' ? projects.length : projects.filter((p) => deriveResult(p).cat === key).length;
    return (
      <button
        type="button"
        onClick={() => setResultFilter(key)}
        className={`h-8 px-3 rounded-lg text-sm font-medium inline-flex items-center gap-1.5 transition-colors ${resultFilter === key ? 'bg-gray-100 text-gray-900' : 'text-gray-500 hover:text-gray-800'}`}
      >
        {dot && <span className={`h-1.5 w-1.5 rounded-full ${dot}`} />}{label}
        <span className="text-xs text-gray-400 tabular-nums">{count}</span>
      </button>
    );
  };

  // ---- capacity row (lead in tree, or specialist in specs tab) ----
  const capacityRow = (
    person: { name: string; occupied: number; prep: number; plan: number; roll: Roll; projects: ProjectData[] },
    opts: { planKey: string; variant: 'manager' | 'specialist'; expandable: boolean; open: boolean; onToggle: () => void },
  ) => {
    const status = getLoadStatus(person.occupied, person.plan);
    return (
      <div
        className={`${GRID} border-b border-gray-100 last:border-0 transition-colors ${opts.expandable ? 'cursor-pointer hover:bg-gray-50' : ''}`}
        onClick={opts.expandable ? opts.onToggle : undefined}
      >
        <div className="px-4 py-3 flex items-center gap-2 min-w-0">
          <Caret open={opts.open} hidden={!opts.expandable} />
          <TeamMemberAvatar displayName={person.name} avatarUrl={nameToAvatarUrl.get(person.name)} signedUrl={avatarSignedUrls[person.name]} variant={opts.variant} />
          <div className="min-w-0">
            <p className="text-sm font-semibold text-gray-900 truncate">{person.name}</p>
            <p className="text-xs text-gray-500">
              {(() => {
                let work = 0, prep = 0, paused = 0;
                for (const p of person.projects) {
                  if (isWorkingStatus(p.status)) work++;
                  else if (isPrepStatus(p.status)) prep++;
                  else if (isPausedStatus(p.status)) paused++;
                }
                const parts: string[] = [];
                if (work) parts.push(`${work} в работе`);
                if (prep) parts.push(`${prep} в подготовке`);
                if (paused) parts.push(`${paused} на паузе`);
                return parts.length ? parts.join(' · ') : 'нет активных проектов';
              })()}
            </p>
          </div>
        </div>
        <div className="px-2 flex justify-center">
          <span className={`inline-flex items-center px-2.5 py-1 rounded-full text-xs font-medium ring-1 ring-inset ${status.color}`}>{status.label}</span>
        </div>
        <div className="px-2 text-center"><span className="text-lg font-bold text-gray-900 tabular-nums">{person.occupied}</span></div>
        <div className="px-2 text-center"><span className={`text-sm font-medium tabular-nums ${person.prep > 0 ? 'text-gray-900' : 'text-gray-400'}`}>{person.prep}</span></div>
        <div className="px-2 flex items-center justify-center gap-2" onClick={(e) => e.stopPropagation()}>
          <button onClick={() => saveCapacity(opts.planKey, Math.max(0, person.plan - 1))} className="p-1 rounded hover:bg-gray-100 text-gray-400 hover:text-gray-600 text-[10px] leading-none">▼</button>
          <span className="text-sm font-bold text-gray-900 w-4 text-center tabular-nums">{person.plan}</span>
          <button onClick={() => saveCapacity(opts.planKey, person.plan + 1)} className="p-1 rounded hover:bg-gray-100 text-gray-400 hover:text-gray-600 text-[10px] leading-none">▲</button>
        </div>
        <div className="px-2"><LoadBar occupied={person.occupied} plan={person.plan} /></div>
        <div className="px-3"><RollupStrip roll={person.roll} /></div>
      </div>
    );
  };

  // Specialist sub-row: global load and results, with the current lead scope stated explicitly.
  const specSubRow = (lead: string, sname: string, list: ProjectData[], open: boolean, onToggle: () => void) => {
    const isPlaceholder = sname === NO_SPEC;
    const s = model.specStat(sname);
    const status = getLoadStatus(s.occupied, s.plan);
    const roll = isPlaceholder ? rollup(list) : s.roll;
    const dash = <span className="text-sm text-gray-300">—</span>;
    return (
      <div className={`${GRID} border-b border-gray-100 bg-gray-50/60 hover:bg-gray-100/60 cursor-pointer transition-colors`} onClick={onToggle}>
        <div className="pl-11 pr-4 py-2.5 flex items-center gap-2 min-w-0">
          <Caret open={open} />
          <TeamMemberAvatar displayName={isPlaceholder ? '?' : sname} avatarUrl={isPlaceholder ? null : nameToAvatarUrl.get(sname)} signedUrl={isPlaceholder ? null : avatarSignedUrls[sname]} variant="specialist" size="sm" />
          <div className="min-w-0">
            <p className={`text-sm font-medium truncate ${isPlaceholder ? 'text-gray-500 italic' : 'text-gray-900'}`}>{isPlaceholder ? 'Без специалиста' : sname}</p>
            <p className="text-xs text-gray-500">{isPlaceholder ? `${list.length} ${plural(list.length)} без спеца` : `проекты: ${list.length} у этого лида, ${s.projects.length} всего`}</p>
          </div>
        </div>
        {isPlaceholder ? (
          <>
            <div className="px-2 flex justify-center">{dash}</div>
            <div className="px-2 text-center">{dash}</div>
            <div className="px-2 text-center">{dash}</div>
            <div className="px-2 text-center">{dash}</div>
            <div className="px-2 flex justify-center">{dash}</div>
            <div className="px-3"><RollupStrip roll={roll} /></div>
          </>
        ) : (
          <>
            <div className="px-2 flex justify-center">
              <span className={`inline-flex items-center px-2.5 py-1 rounded-full text-xs font-medium ring-1 ring-inset ${status.color}`}>{status.label}</span>
            </div>
            <div className="px-2 text-center"><span className="text-base font-bold text-gray-900 tabular-nums">{s.occupied}</span></div>
            <div className="px-2 text-center"><span className={`text-sm font-medium tabular-nums ${s.prep > 0 ? 'text-gray-900' : 'text-gray-400'}`}>{s.prep}</span></div>
            <div className="px-2 text-center"><span className="text-sm font-semibold text-gray-500 tabular-nums">{s.plan}</span></div>
            <div className="px-2"><LoadBar occupied={s.occupied} plan={s.plan} /></div>
            <div className="px-3"><RollupStrip roll={roll} /></div>
          </>
        )}
      </div>
    );
  };

  const projectRow = (p: ProjectData, showLead: boolean) => {
    const title = projectTitle(p);
    const services = p.client?.trim() && p.name?.trim() && p.name.trim() !== p.client.trim() ? p.name.trim() : null;
    return (
      <div key={p.id} className={`${GRID} border-b border-gray-100 bg-white hover:bg-gray-50 transition-colors`}>
        <div className="pl-[68px] pr-4 py-2.5 flex items-center gap-2 min-w-0 col-span-1">
          <span className="h-px w-3 bg-gray-200 flex-shrink-0" />
          <span className="text-sm text-gray-800 truncate">{title}</span>
          {services && <span className="text-xs text-gray-400 truncate flex-shrink min-w-0">· {services}</span>}
          {showLead && normalizeAssigneeName(p.manager) && <span className="text-xs text-gray-400 flex-shrink-0">· лид {normalizeAssigneeName(p.manager)}</span>}
        </div>
        <div className="col-start-7 px-3 py-2.5"><ResultBadge p={p} /></div>
      </div>
    );
  };

  // ---- column header ----
  const columnHeader = (firstLabel: string) => (
    <div className={`${GRID} border-b border-gray-100 bg-gray-50/50 sticky top-0 z-10`}>
      <div className="px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wider">{firstLabel}</div>
      <div className="px-2 py-3 text-center text-xs font-semibold text-gray-500 uppercase tracking-wider">Статус</div>
      <div className="px-2 py-3 text-center text-xs font-semibold text-gray-500 uppercase tracking-wider leading-tight">Проекты<span className="block text-[10px] normal-case font-normal text-gray-400">всего</span></div>
      <div className="px-2 py-3 text-center text-xs font-semibold text-gray-500 uppercase tracking-wider leading-tight">Из них<span className="block text-[10px] normal-case font-normal text-gray-400">подготовка</span></div>
      <div className="px-2 py-3 text-center text-xs font-semibold text-gray-500 uppercase tracking-wider leading-tight">План<span className="block text-[10px] normal-case font-normal text-gray-400">max</span></div>
      <div className="px-2 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wider">Загрузка</div>
      <div className="px-3 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wider">Результаты</div>
    </div>
  );

  // ---- LEADS view ----
  const renderLeads = () => {
    let leads = model.leads;
    if (statusFilter !== 'all') leads = leads.filter((L) => getLoadStatus(L.occupied, L.plan).label === statusFilter);
    if (q) leads = leads.filter((L) => L.name.toLowerCase().includes(q) || L.projects.some(matchProject));
    leads = sortPeople(leads);

    return (
      <>
        {columnHeader('Лид')}
        {leads.map((L) => {
          const open = q ? true : openLeads.has(L.name);
          const visibleProjects = q && !L.name.toLowerCase().includes(q) ? L.projects.filter(matchProject) : L.projects;
          const bySpec = new Map<string, ProjectData[]>();
          for (const p of visibleProjects) {
            const s = normalizeAssigneeName(p.specialist) || NO_SPEC;
            const a = bySpec.get(s) || []; a.push(p); bySpec.set(s, a);
          }
          return (
            <div key={L.name}>
              {capacityRow(L, {
                planKey: `manager:${L.name}`,
                variant: 'manager',
                expandable: L.projects.length > 0,
                open,
                onToggle: () => toggle(setOpenLeads, L.name),
              })}
              {open && (
                visibleProjects.length === 0 ? (
                  <div className="pl-[68px] py-3 text-sm text-gray-400 italic bg-gray-50/40 border-b border-gray-100">Нет проектов у этого лида</div>
                ) : (
                  Array.from(bySpec.entries()).map(([sname, list]) => {
                    const key = `${L.name}||${sname}`;
                    const sOpen = q ? true : openSpecInLead.has(key);
                    return (
                      <div key={key}>
                        {specSubRow(L.name, sname, list, sOpen, () => toggle(setOpenSpecInLead, key))}
                        {sOpen && list.map((p) => projectRow(p, false))}
                      </div>
                    );
                  })
                )
              )}
            </div>
          );
        })}
        {leads.length === 0 && <div className="px-4 py-8 text-center text-sm text-gray-400">Ничего не найдено</div>}
      </>
    );
  };

  // ---- SPECIALISTS view ----
  const renderSpecs = () => {
    let specs = model.specialists.filter((s) => s.projects.length > 0);
    if (statusFilter !== 'all') specs = specs.filter((s) => getLoadStatus(s.occupied, s.plan).label === statusFilter);
    if (q) specs = specs.filter((s) => s.name.toLowerCase().includes(q) || s.projects.some(matchProject));
    specs = sortPeople(specs);

    return (
      <>
        {columnHeader('Специалист')}
        {specs.map((S) => {
          const open = q ? true : openSpecs.has(S.name);
          const visibleProjects = q && !S.name.toLowerCase().includes(q) ? S.projects.filter(matchProject) : S.projects;
          return (
            <div key={S.name}>
              {capacityRow(S, {
                planKey: `specialist:${S.name}`,
                variant: 'specialist',
                expandable: S.projects.length > 0,
                open,
                onToggle: () => toggle(setOpenSpecs, S.name),
              })}
              {open && visibleProjects.map((p) => projectRow(p, true))}
            </div>
          );
        })}
        {specs.length === 0 && <div className="px-4 py-8 text-center text-sm text-gray-400">Ничего не найдено</div>}
      </>
    );
  };

  // ---- PROJECTS (flat / Excel) view ----
  const renderProjects = () => {
    let rows = projects.slice();
    if (resultFilter !== 'all') rows = rows.filter((p) => deriveResult(p).cat === resultFilter);
    if (q) rows = rows.filter(matchProject);
    if (sortKey === 'name') rows.sort((a, b) => projectTitle(a).localeCompare(projectTitle(b), 'ru-RU'));
    else if (sortKey === 'result') rows.sort((a, b) => resultRank(b) - resultRank(a));
    else rows.sort((a, b) => normalizeAssigneeName(a.manager).localeCompare(normalizeAssigneeName(b.manager), 'ru-RU') || projectTitle(a).localeCompare(projectTitle(b), 'ru-RU'));

    const PGRID = 'grid grid-cols-[minmax(180px,1.4fr)_minmax(130px,1fr)_minmax(130px,1fr)_minmax(190px,1fr)] items-center';
    return (
      <>
        <div className={`${PGRID} border-b border-gray-100 bg-gray-50/50 sticky top-0 z-10`}>
          <div className="px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wider">Проект</div>
          <div className="px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wider">Лид</div>
          <div className="px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wider">Специалист</div>
          <div className="px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wider">Результат</div>
        </div>
        {rows.map((p) => (
          <div key={p.id} className={`${PGRID} border-b border-gray-100 bg-white hover:bg-gray-50 transition-colors`}>
            <div className="px-4 py-3 min-w-0">
              <p className="text-sm font-medium text-gray-900 truncate">{projectTitle(p)}</p>
              {p.client?.trim() && p.name?.trim() && p.name.trim() !== p.client.trim() && (
                <p className="text-xs text-gray-400 truncate">{p.name.trim()}</p>
              )}
            </div>
            <div className="px-4 py-3 min-w-0">
              {normalizeAssigneeName(p.manager)
                ? <span className="inline-flex items-center gap-2 min-w-0"><TeamMemberAvatar displayName={normalizeAssigneeName(p.manager)} avatarUrl={nameToAvatarUrl.get(normalizeAssigneeName(p.manager))} signedUrl={avatarSignedUrls[normalizeAssigneeName(p.manager)]} variant="manager" size="sm" /><span className="text-sm text-gray-700 truncate">{normalizeAssigneeName(p.manager)}</span></span>
                : <span className="text-sm text-gray-400">—</span>}
            </div>
            <div className="px-4 py-3 min-w-0">
              {normalizeAssigneeName(p.specialist)
                ? <span className="inline-flex items-center gap-2 min-w-0"><TeamMemberAvatar displayName={normalizeAssigneeName(p.specialist)} avatarUrl={nameToAvatarUrl.get(normalizeAssigneeName(p.specialist))} signedUrl={avatarSignedUrls[normalizeAssigneeName(p.specialist)]} variant="specialist" size="sm" /><span className="text-sm text-gray-700 truncate">{normalizeAssigneeName(p.specialist)}</span></span>
                : <span className="text-sm text-gray-400">—</span>}
            </div>
            <div className="px-4 py-3"><ResultBadge p={p} /></div>
          </div>
        ))}
        {rows.length === 0 && <div className="px-4 py-8 text-center text-sm text-gray-400">Ничего не найдено</div>}
      </>
    );
  };

  const sectionTitle = segment === 'leads' ? 'Лиды' : segment === 'specs' ? 'Специалисты' : 'Проекты';
  const sectionCount = segment === 'leads'
    ? `${model.leads.length} человек`
    : segment === 'specs'
      ? `${model.specialists.filter((s) => s.projects.length > 0).length} с проектами`
      : `${projects.length} всего`;

  return (
    <div className={`${isTma ? 'space-y-5' : 'space-y-6'} max-w-[1600px] mx-auto`}>
      <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className={`${isTma ? 'text-2xl' : 'text-3xl'} font-bold tracking-tight text-gray-900`}>Команда</h1>
          <p className="mt-1 text-sm text-gray-500">
            {activeWorkspaceView === 'load'
              ? 'Текущая загрузка, распределение по проектам и результаты'
              : activeWorkspaceView === 'statistics'
                ? 'Показатели команды за выбранный календарный период'
                : 'Итоги встреч и рекомендации по развитию сотрудников'}
          </p>
        </div>
        {canViewPrivateWorkspaces && (
          <div role="group" aria-label="Разделы команды" className="inline-flex min-h-11 w-fit gap-1 rounded-xl border border-gray-200 bg-white p-1 shadow-sm">
            {TEAM_WORKSPACE_VIEWS.map(([key, label]) => (
              <button
                key={key}
                type="button"
                aria-pressed={activeWorkspaceView === key}
                onClick={() => setWorkspaceView(key)}
                className={`min-h-11 rounded-lg px-4 text-sm font-semibold transition-colors ${activeWorkspaceView === key ? 'bg-gray-900 text-white' : 'text-gray-500 hover:bg-gray-50 hover:text-gray-900'}`}
              >
                {label}
              </button>
            ))}
          </div>
        )}
      </div>

      {activeWorkspaceView === 'load' ? (
        loading ? (
          <div className="flex h-64 items-center justify-center rounded-2xl border border-gray-200 bg-white">
            <div className="text-sm text-gray-400">Загрузка...</div>
          </div>
        ) : (
          <div className={isTma ? 'space-y-5' : 'space-y-6'}>
      {/* KPI cards */}
      <div className={`grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 ${isTma ? 'gap-3' : 'gap-4'}`}>
        {kpiCards.map((c) => (
          <div key={c.label} className={`bg-white rounded-2xl border border-gray-200 shadow-sm ${isTma ? 'p-4' : 'p-5'}`}>
            <p className="text-sm font-medium text-gray-500">{c.label}</p>
            <div className="flex items-baseline gap-2 mt-1">
              <span className="text-2xl font-bold text-gray-900 tabular-nums">{c.value}</span>
              <span className="text-sm text-gray-400">{c.suf}</span>
            </div>
          </div>
        ))}
        <div className={`bg-white rounded-2xl border border-gray-200 shadow-sm ${isTma ? 'p-4' : 'p-5'}`}>
          <p className="text-sm font-medium text-gray-500">Лидов доведено</p>
          <div className="flex items-baseline gap-2 mt-1">
            <span className="text-2xl font-bold text-emerald-700 tabular-nums">{kpi.totalLeads}</span>
            <span className="text-sm text-gray-400">всего</span>
          </div>
          <div className="mt-2 flex items-center gap-3 text-xs">
            <span className="inline-flex items-center gap-1.5 text-gray-500"><span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />{kpi.delivered} довели цель</span>
            <span className="inline-flex items-center gap-1.5 text-gray-500"><span className="h-1.5 w-1.5 rounded-full bg-red-500" />{kpi.missed} не довели</span>
          </div>
        </div>
      </div>

      {/* toolbar */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative flex-1 min-w-[200px] max-w-[340px]">
          <svg className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="11" cy="11" r="7" /><path d="M21 21l-4-4" /></svg>
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Поиск по имени или проекту"
            className="w-full h-9 rounded-xl border border-gray-200 bg-white pl-9 pr-3 text-sm text-gray-900 placeholder-gray-400 focus:outline-none focus:border-blue-400 focus:ring-2 focus:ring-blue-100"
          />
        </div>
        <div className="flex gap-1 bg-white border border-gray-200 rounded-xl p-1">
          {segButton('leads', 'Лиды')}
          {segButton('specs', 'Специалисты')}
          {segButton('projects', 'Проекты')}
        </div>
        <div className="flex gap-0.5 bg-white border border-gray-200 rounded-xl p-1">
          {isProjectsView ? (
            <>
              {resultChip('all', 'Все')}
              {resultChip('delivered', 'Довели', 'bg-emerald-500')}
              {resultChip('missed', 'Не довели', 'bg-red-500')}
              {resultChip('work', 'В работе', 'bg-gray-400')}
              {resultChip('prep', 'Подготовка', 'bg-amber-500')}
              {resultChip('other', 'На паузе', 'bg-gray-300')}
            </>
          ) : (
            <>
              {statusChip('all', 'Все')}
              {statusChip('Перегруз', 'Перегруз', 'bg-red-500')}
              {statusChip('Норма', 'Норма', 'bg-blue-500')}
              {statusChip('Свободен', 'Свободен', 'bg-emerald-500')}
            </>
          )}
        </div>
        <div className="flex-1" />
        <select
          value={sortKey}
          onChange={(e) => setSortKey(e.target.value as SortKey)}
          className="h-9 rounded-xl border border-gray-200 bg-white px-3 text-sm text-gray-600 focus:outline-none focus:border-blue-400"
        >
          <option value="projects">Сортировка: по проектам</option>
          <option value="load">по загрузке</option>
          <option value="result">по результатам</option>
          <option value="name">по имени</option>
        </select>
      </div>

      {/* panel */}
      <div className="bg-white rounded-2xl border border-gray-200 shadow-sm overflow-hidden">
        <div className={`${isTma ? 'px-4 py-3' : 'px-6 py-4'} border-b border-gray-100 bg-gray-50/50 flex items-center gap-3 flex-wrap`}>
          <h2 className="text-lg font-bold text-gray-900">{sectionTitle}</h2>
          <span className="text-xs font-medium px-2.5 py-1 rounded-full bg-gray-100 text-gray-600">{sectionCount}</span>
          <div className="ml-auto flex items-center gap-3 text-xs text-gray-500">
            <span className="inline-flex items-center gap-1.5"><span className="h-2 w-2 rounded-full bg-emerald-500" />Довели</span>
            <span className="inline-flex items-center gap-1.5"><span className="h-2 w-2 rounded-full bg-red-500" />Не довели</span>
            <span className="inline-flex items-center gap-1.5"><span className="h-2 w-2 rounded-full bg-gray-400" />В работе</span>
            <span className="inline-flex items-center gap-1.5"><span className="h-2 w-2 rounded-full bg-amber-500" />Подготовка</span>
          </div>
        </div>
        <div className="overflow-x-auto">
          <div className="min-w-[980px]">
            {segment === 'leads' && renderLeads()}
            {segment === 'specs' && renderSpecs()}
            {segment === 'projects' && renderProjects()}
          </div>
        </div>
      </div>
          </div>
        )
      ) : activeWorkspaceView === 'statistics' ? (
        <TeamStatisticsPanel />
      ) : (
        <TeamReviewsPanel />
      )}
    </div>
  );
}

function toggle(setter: Dispatch<SetStateAction<Set<string>>>, key: string) {
  setter((prev) => {
    const next = new Set(prev);
    if (next.has(key)) next.delete(key); else next.add(key);
    return next;
  });
}

function resultRank(p: ProjectData): number {
  const cat = deriveResult(p).cat;
  if (cat === 'delivered') return 4;
  if (cat === 'missed') return 3;
  if (cat === 'work') return 2;
  return 1; // prep
}

function pluralRu(n: number, one: string, few: string, many: string): string {
  const a = n % 10, b = n % 100;
  if (a === 1 && b !== 11) return one;
  if (a >= 2 && a <= 4 && (b < 10 || b >= 20)) return few;
  return many;
}
function plural(n: number): string {
  return pluralRu(n, 'проект', 'проекта', 'проектов');
}
