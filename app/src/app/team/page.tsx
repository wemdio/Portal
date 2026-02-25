'use client';

import { useEffect, useMemo, useState } from 'react';
import { supabase } from '@/lib/supabaseClient';
import { logError } from '@/lib/loggerClient';
import { useIsTma } from '@/lib/useIsTma';
import { UserProfile, UserRole } from '@/types';
import { getAssigneeDisplayName } from '@/lib/projectAssignees';
import { normalizePublicAvatarUrl } from '@/lib/publicAvatarUrl';

interface ProjectData {
  id: string;
  name: string;
  status: string;
  manager: string | null;
  specialist: string | null;
}

type ProfileData = Pick<UserProfile, 'id' | 'email' | 'full_name' | 'role' | 'avatar_url'>;

interface SpecialistStats {
  name: string;
  fact: number; // В работе + Тестирование
  prep: number; // Подготовка
  plan: number; // Capacity (user defined)
  activeProjects: ProjectData[];
}

interface ManagerStats {
  name: string;
  fact: number;
  prep: number;
  plan: number;
  activeProjects: ProjectData[];
}

const STORAGE_KEY_CAPACITY = 'portal:team-capacity';
const DEFAULT_CAPACITY = 4;
const MANAGER_ROLES = new Set<UserRole>(['manager', 'director', 'admin']);
const SPECIALIST_ROLES = new Set<UserRole>(['technician', 'marketer', 'sales']);

type SortDir = 'asc' | 'desc';
type SpecialistSortKey = 'name' | 'status' | 'fact' | 'prep' | 'plan' | 'load';
type ManagerSortKey = SpecialistSortKey;

type SortState<K extends string> = { key: K; dir: SortDir } | null;

function normalizeAssigneeName(value: string | null | undefined): string {
  return value?.trim() || '';
}

function nextSort<K extends string>(prev: SortState<K>, key: K, defaultDir: SortDir): SortState<K> {
  if (!prev || prev.key !== key) return { key, dir: defaultDir };
  return { key, dir: prev.dir === 'asc' ? 'desc' : 'asc' };
}

function TeamMemberAvatar({
  displayName,
  avatarUrl,
  signedUrl,
  variant,
}: {
  displayName: string;
  avatarUrl: string | null | undefined;
  signedUrl?: string | null;
  variant: 'manager' | 'specialist';
}) {
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  const publicUrl = normalizePublicAvatarUrl(avatarUrl);
  const url = signedUrl ?? publicUrl;
  const initial = displayName.charAt(0).toUpperCase();
  const showImage = Boolean(url && failedUrl !== url);

  const bgClass = variant === 'manager' ? 'bg-blue-50 border-blue-100 text-blue-600' : 'bg-gray-100 border-gray-200 text-gray-600';

  return (
    <div className={`h-9 w-9 rounded-full flex items-center justify-center overflow-hidden border flex-shrink-0 mr-3 ${showImage ? '' : bgClass}`}>
      {showImage && url ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          key={url}
          src={url}
          alt=""
          className="h-full w-full object-cover"
          onError={() => setFailedUrl(url)}
        />
      ) : (
        <span className="text-sm font-bold">{initial}</span>
      )}
    </div>
  );
}

export default function TeamPage() {
  const isTma = useIsTma();
  const [projects, setProjects] = useState<ProjectData[]>([]);
  const [profiles, setProfiles] = useState<ProfileData[]>([]);
  const [loading, setLoading] = useState(true);
  const [capacities, setCapacities] = useState<Record<string, number>>({});
  const [avatarSignedUrls, setAvatarSignedUrls] = useState<Record<string, string>>({});
  const [specialistSort, setSpecialistSort] = useState<SortState<SpecialistSortKey>>({ key: 'fact', dir: 'desc' });
  const [managerSort, setManagerSort] = useState<SortState<ManagerSortKey>>({ key: 'fact', dir: 'desc' });

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
    void fetchData();
    loadCapacities();
  }, []);

  useEffect(() => {
    if (profiles.length === 0) return;
    let cancelled = false;
    void (async () => {
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
    })();
    return () => { cancelled = true; };
  }, [profiles.length]);

  const loadCapacities = () => {
    try {
      const stored = localStorage.getItem(STORAGE_KEY_CAPACITY);
      if (stored) {
        setCapacities(JSON.parse(stored));
      }
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
        supabase
          .from('projects')
          .select('id, name, status, manager, specialist'),
        supabase
          .from('profiles')
          .select('id, email, full_name, role, avatar_url'),
      ]);

      if (projectsResult.error) throw projectsResult.error;
      if (profilesResult.error) throw profilesResult.error;

      setProjects((projectsResult.data as ProjectData[]) || []);
      setProfiles((profilesResult.data as ProfileData[]) || []);
    } catch (error) {
      void logError('team.data.fetch.failed', error);
    } finally {
      setLoading(false);
    }
  }

  const specialistStats = useMemo(() => {
    const statsMap = new Map<string, SpecialistStats>();
    const managerMap = new Map<string, ManagerStats>();

    // Seed stats with registered users so users with zero active projects are visible.
    profiles.forEach((profile) => {
      const name = normalizeAssigneeName(getAssigneeDisplayName(profile));
      if (!name) return;

      if (profile.role && MANAGER_ROLES.has(profile.role)) {
        managerMap.set(name, {
          name,
          fact: 0,
          prep: 0,
          plan: capacities[`manager:${name}`] || DEFAULT_CAPACITY,
          activeProjects: [],
        });
      }

      if (profile.role && SPECIALIST_ROLES.has(profile.role)) {
        statsMap.set(name, {
          name,
          fact: 0,
          prep: 0,
          plan: capacities[`specialist:${name}`] || DEFAULT_CAPACITY,
          activeProjects: [],
        });
      }
    });

    projects.forEach((p) => {
      const status = p.status?.toLowerCase() || '';
      const isWorking = status.includes('работ') || status.includes('тест');
      const isPrep = status.includes('подготов');

      // Process Specialist
      const specialistName = normalizeAssigneeName(p.specialist);
      if (specialistName) {
        const name = specialistName;
        const existing = statsMap.get(name) || {
          name,
          fact: 0,
          prep: 0,
          plan: capacities[`specialist:${name}`] || DEFAULT_CAPACITY,
          activeProjects: []
        };

        if (isWorking) {
          existing.fact++;
          existing.activeProjects.push(p);
        } else if (isPrep) {
          existing.prep++;
        }
        existing.plan = capacities[`specialist:${name}`] || DEFAULT_CAPACITY;
        statsMap.set(name, existing);
      }

      // Process Manager
      const managerName = normalizeAssigneeName(p.manager);
      if (managerName) {
        const name = managerName;
        const existing = managerMap.get(name) || {
          name,
          fact: 0,
          prep: 0,
          plan: capacities[`manager:${name}`] || DEFAULT_CAPACITY,
          activeProjects: []
        };

        if (isWorking) {
          existing.fact++;
          existing.activeProjects.push(p);
        } else if (isPrep) {
          existing.prep++;
        }
        existing.plan = capacities[`manager:${name}`] || DEFAULT_CAPACITY;
        managerMap.set(name, existing);
      }
    });

    const specialists = Array.from(statsMap.values());
    const managers = Array.from(managerMap.values());

    return { specialists, managers };
  }, [projects, profiles, capacities]);

  const totalFact = specialistStats.specialists.reduce((sum, s) => sum + s.fact, 0);
  const totalPlan = specialistStats.specialists.reduce((sum, s) => sum + s.plan, 0);
  const totalLoad = totalPlan > 0 ? Math.round((totalFact / totalPlan) * 100) : 0;
  const freeSpots = Math.max(0, totalPlan - totalFact);

  const getLoadStatus = (fact: number, plan: number) => {
    const ratio = fact / plan;
    if (ratio > 1.1) return { label: 'Перегруз', color: 'text-red-700 bg-red-50 ring-red-600/20' };
    if (ratio < 0.7) return { label: 'Свободен', color: 'text-emerald-700 bg-emerald-50 ring-emerald-600/20' };
    return { label: 'Норма', color: 'text-blue-700 bg-blue-50 ring-blue-600/20' };
  };

  const getLoadScore = (fact: number, plan: number) => {
    const ratio = fact / plan;
    if (ratio > 1.1) return 2; // Перегруз
    if (ratio < 0.7) return 0; // Свободен
    return 1; // Норма
  };

  const sortedManagers = useMemo(() => {
    const base = [...specialistStats.managers];
    const s = managerSort;
    if (!s) return base;

    const dirMul = s.dir === 'asc' ? 1 : -1;
    base.sort((a, b) => {
      switch (s.key) {
        case 'name':
          return dirMul * a.name.localeCompare(b.name, 'ru-RU');
        case 'fact':
          return dirMul * (a.fact - b.fact) || a.name.localeCompare(b.name, 'ru-RU');
        case 'prep':
          return dirMul * (a.prep - b.prep) || a.name.localeCompare(b.name, 'ru-RU');
        case 'plan':
          return dirMul * (a.plan - b.plan) || a.name.localeCompare(b.name, 'ru-RU');
        case 'load': {
          const la = a.plan > 0 ? a.fact / a.plan : 0;
          const lb = b.plan > 0 ? b.fact / b.plan : 0;
          return dirMul * (la - lb) || a.name.localeCompare(b.name, 'ru-RU');
        }
        case 'status':
          return dirMul * (getLoadScore(a.fact, a.plan) - getLoadScore(b.fact, b.plan)) || a.name.localeCompare(b.name, 'ru-RU');
        default:
          return 0;
      }
    });
    return base;
  }, [specialistStats.managers, managerSort]);

  const sortedSpecialists = useMemo(() => {
    const base = [...specialistStats.specialists];
    const s = specialistSort;
    if (!s) return base;

    const dirMul = s.dir === 'asc' ? 1 : -1;
    base.sort((a, b) => {
      switch (s.key) {
        case 'name':
          return dirMul * a.name.localeCompare(b.name, 'ru-RU');
        case 'fact':
          return dirMul * (a.fact - b.fact) || a.name.localeCompare(b.name, 'ru-RU');
        case 'prep':
          return dirMul * (a.prep - b.prep) || a.name.localeCompare(b.name, 'ru-RU');
        case 'plan':
          return dirMul * (a.plan - b.plan) || a.name.localeCompare(b.name, 'ru-RU');
        case 'load': {
          const la = a.plan > 0 ? a.fact / a.plan : 0;
          const lb = b.plan > 0 ? b.fact / b.plan : 0;
          return dirMul * (la - lb) || a.name.localeCompare(b.name, 'ru-RU');
        }
        case 'status':
          return dirMul * (getLoadScore(a.fact, a.plan) - getLoadScore(b.fact, b.plan)) || a.name.localeCompare(b.name, 'ru-RU');
        default:
          return 0;
      }
    });
    return base;
  }, [specialistStats.specialists, specialistSort]);

  const sortIndicator = (active: boolean, dir: SortDir) => {
    if (!active) return null;
    return (
      <span aria-hidden="true" className="ml-1 text-[10px] text-gray-400">
        {dir === 'asc' ? '▲' : '▼'}
      </span>
    );
  };

  const headerButtonClass =
    'inline-flex items-center gap-1 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider hover:text-gray-700 select-none';

  if (loading) {
    return (
      <div className="flex h-64 items-center justify-center">
        <div className="text-gray-400 text-sm">Загрузка...</div>
      </div>
    );
  }

  return (
    <div className={`${isTma ? 'space-y-6' : 'space-y-8'} max-w-[1600px] mx-auto`}>
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h1 className={`${isTma ? 'text-2xl' : 'text-3xl'} font-bold tracking-tight text-gray-900`}>Нагрузка команды</h1>
          <p className="mt-1 text-sm text-gray-500">
            Мониторинг занятости специалистов и планирование ресурсов
          </p>
        </div>
      </div>

      {/* Metrics Cards */}
      <div className={`grid grid-cols-1 md:grid-cols-4 ${isTma ? 'gap-3' : 'gap-4'}`}>
        <div className={`bg-white rounded-2xl border border-gray-200 shadow-sm ${isTma ? 'p-4' : 'p-5'}`}>
          <div className="flex items-center gap-3">
            <div>
              <p className="text-sm font-medium text-gray-500">Проектов в работе</p>
              <div className="flex items-baseline gap-2">
                <span className="text-2xl font-bold text-gray-900">{totalFact}</span>
                <span className="text-sm text-gray-400">активных</span>
              </div>
            </div>
          </div>
        </div>

        <div className={`bg-white rounded-2xl border border-gray-200 shadow-sm ${isTma ? 'p-4' : 'p-5'}`}>
          <div className="flex items-center gap-3">
            <div>
              <p className="text-sm font-medium text-gray-500">Всего мест</p>
              <div className="flex items-baseline gap-2">
                <span className="text-2xl font-bold text-gray-900">{totalPlan}</span>
                <span className="text-sm text-gray-400">план</span>
              </div>
            </div>
          </div>
        </div>

        <div className={`bg-white rounded-2xl border border-gray-200 shadow-sm ${isTma ? 'p-4' : 'p-5'}`}>
          <div className="flex items-center gap-3">
            <div>
              <p className="text-sm font-medium text-gray-500">Свободно мест</p>
              <div className="flex items-baseline gap-2">
                <span className="text-2xl font-bold text-gray-900">{freeSpots}</span>
                <span className="text-sm text-gray-400">можно взять</span>
              </div>
            </div>
          </div>
        </div>

        <div className={`bg-white rounded-2xl border border-gray-200 shadow-sm ${isTma ? 'p-4' : 'p-5'}`}>
          <div className="flex items-center gap-3">
            <div>
              <p className="text-sm font-medium text-gray-500">Общая загрузка</p>
              <div className="flex items-baseline gap-2">
                <span className="text-2xl font-bold text-gray-900">{totalLoad}%</span>
                <span className="text-sm text-gray-400">от плана</span>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Managers Table */}
      <div className="bg-white rounded-2xl border border-gray-200 shadow-sm overflow-hidden">
        <div className={`${isTma ? 'px-4 py-3' : 'px-6 py-4'} border-b border-gray-100 bg-gray-50/50 flex items-center justify-between`}>
          <h2 className="text-lg font-bold text-gray-900">Лиды (Менеджеры)</h2>
          <span className="text-xs font-medium px-2.5 py-1 rounded-full bg-gray-100 text-gray-600">
            {specialistStats.managers.length} человек
          </span>
        </div>
        <div className="overflow-x-auto">
          <table className="min-w-full divide-y divide-gray-100">
            <thead className="bg-gray-50/50">
              <tr>
                <th className={`${isTma ? 'px-4 py-3' : 'px-6 py-4'} text-left`}>
                  <button
                    type="button"
                    onClick={() => setManagerSort((prev) => nextSort(prev, 'name', 'asc'))}
                    className={headerButtonClass}
                  >
                    Лид
                    {sortIndicator(managerSort?.key === 'name', managerSort?.dir ?? 'asc')}
                  </button>
                </th>
                <th className={`${isTma ? 'px-4 py-3' : 'px-6 py-4'} text-center`}>
                  <button
                    type="button"
                    onClick={() => setManagerSort((prev) => nextSort(prev, 'status', 'desc'))}
                    className={headerButtonClass}
                  >
                    Статус
                    {sortIndicator(managerSort?.key === 'status', managerSort?.dir ?? 'desc')}
                  </button>
                </th>
                <th className={`${isTma ? 'px-4 py-3' : 'px-6 py-4'} text-center`}>
                  <div className="flex flex-col items-center gap-1">
                    <button
                      type="button"
                      onClick={() => setManagerSort((prev) => nextSort(prev, 'fact', 'desc'))}
                      className={headerButtonClass}
                    >
                      Факт
                      {sortIndicator(managerSort?.key === 'fact', managerSort?.dir ?? 'desc')}
                    </button>
                    <span className="text-[10px] normal-case text-gray-400">В работе</span>
                  </div>
                </th>
                <th className={`${isTma ? 'px-4 py-3' : 'px-6 py-4'} text-center`}>
                  <div className="flex flex-col items-center gap-1">
                    <button
                      type="button"
                      onClick={() => setManagerSort((prev) => nextSort(prev, 'prep', 'desc'))}
                      className={headerButtonClass}
                    >
                      Преп
                      {sortIndicator(managerSort?.key === 'prep', managerSort?.dir ?? 'desc')}
                    </button>
                    <span className="text-[10px] normal-case text-gray-400">Подготовка</span>
                  </div>
                </th>
                <th className={`${isTma ? 'px-4 py-3' : 'px-6 py-4'} text-center`}>
                  <button
                    type="button"
                    onClick={() => setManagerSort((prev) => nextSort(prev, 'plan', 'desc'))}
                    className={headerButtonClass}
                  >
                    План (Max)
                    {sortIndicator(managerSort?.key === 'plan', managerSort?.dir ?? 'desc')}
                  </button>
                </th>
                <th className={`${isTma ? 'px-4 py-3' : 'px-6 py-4'} text-left w-48`}>
                  <button
                    type="button"
                    onClick={() => setManagerSort((prev) => nextSort(prev, 'load', 'desc'))}
                    className={headerButtonClass}
                  >
                    Загрузка
                    {sortIndicator(managerSort?.key === 'load', managerSort?.dir ?? 'desc')}
                  </button>
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-50 bg-white">
              {sortedManagers.map((stat) => {
                const status = getLoadStatus(stat.fact, stat.plan);
                const loadPercent = Math.min(100, Math.round((stat.fact / stat.plan) * 100));
                
                return (
                  <tr key={stat.name} className="hover:bg-gray-50 transition-colors">
                    <td className={`${isTma ? 'px-4 py-3' : 'px-6 py-4'}`}>
                      <div className="flex items-center">
                        <TeamMemberAvatar
                          displayName={stat.name}
                          avatarUrl={nameToAvatarUrl.get(stat.name)}
                          signedUrl={avatarSignedUrls[stat.name]}
                          variant="manager"
                        />
                        <div>
                          <p className="text-sm font-semibold text-gray-900">{stat.name}</p>
                          <p className="text-xs text-gray-500">{stat.activeProjects.length} активных</p>
                        </div>
                      </div>
                    </td>
                    <td className={`${isTma ? 'px-4 py-3' : 'px-6 py-4'} text-center`}>
                      <span className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium ring-1 ring-inset ${status.color}`}>
                        {status.label}
                      </span>
                    </td>
                    <td className={`${isTma ? 'px-4 py-3' : 'px-6 py-4'} text-center`}>
                      <span className="text-lg font-bold text-gray-900">{stat.fact}</span>
                    </td>
                    <td className={`${isTma ? 'px-4 py-3' : 'px-6 py-4'} text-center`}>
                      <span className={`text-sm font-medium ${stat.prep > 0 ? 'text-gray-900' : 'text-gray-400'}`}>
                        {stat.prep}
                      </span>
                    </td>
                    <td className={`${isTma ? 'px-4 py-3' : 'px-6 py-4'}`}>
                      <div className="flex items-center justify-center gap-2">
                        <button 
                          onClick={() => saveCapacity(`manager:${stat.name}`, Math.max(1, stat.plan - 1))}
                          className="p-1 rounded hover:bg-gray-100 text-gray-400 hover:text-gray-600 text-[10px]"
                        >
                          ▼
                        </button>
                        <span className="text-sm font-bold text-gray-900 w-4 text-center">{stat.plan}</span>
                        <button 
                          onClick={() => saveCapacity(`manager:${stat.name}`, stat.plan + 1)}
                          className="p-1 rounded hover:bg-gray-100 text-gray-400 hover:text-gray-600 text-[10px]"
                        >
                          ▲
                        </button>
                      </div>
                    </td>
                    <td className={`${isTma ? 'px-4 py-3' : 'px-6 py-4'}`}>
                      <div className="flex items-center gap-3">
                        <div className="flex-1 h-2 bg-gray-100 rounded-full overflow-hidden">
                          <div 
                            className={`h-full rounded-full transition-all duration-500 ${
                              loadPercent > 100 ? 'bg-red-500' : 
                              loadPercent > 85 ? 'bg-orange-500' : 
                              'bg-emerald-500'
                            }`}
                            style={{ width: `${loadPercent}%` }}
                          />
                        </div>
                        <span className="text-xs font-medium text-gray-600 w-9 text-right">{loadPercent}%</span>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      {/* Specialists Table */}
      <div className="bg-white rounded-2xl border border-gray-200 shadow-sm overflow-hidden">
        <div className={`${isTma ? 'px-4 py-3' : 'px-6 py-4'} border-b border-gray-100 bg-gray-50/50 flex items-center justify-between`}>
          <h2 className="text-lg font-bold text-gray-900">Специалисты</h2>
          <span className="text-xs font-medium px-2.5 py-1 rounded-full bg-gray-100 text-gray-600">
            {specialistStats.specialists.length} человек
          </span>
        </div>
        <div className="overflow-x-auto">
          <table className="min-w-full divide-y divide-gray-100">
            <thead className="bg-gray-50/50">
              <tr>
                <th className={`${isTma ? 'px-4 py-3' : 'px-6 py-4'} text-left`}>
                  <button
                    type="button"
                    onClick={() => setSpecialistSort((prev) => nextSort(prev, 'name', 'asc'))}
                    className={headerButtonClass}
                  >
                    Специалист
                    {sortIndicator(specialistSort?.key === 'name', specialistSort?.dir ?? 'asc')}
                  </button>
                </th>
                <th className={`${isTma ? 'px-4 py-3' : 'px-6 py-4'} text-center`}>
                  <button
                    type="button"
                    onClick={() => setSpecialistSort((prev) => nextSort(prev, 'status', 'desc'))}
                    className={headerButtonClass}
                  >
                    Статус
                    {sortIndicator(specialistSort?.key === 'status', specialistSort?.dir ?? 'desc')}
                  </button>
                </th>
                <th className={`${isTma ? 'px-4 py-3' : 'px-6 py-4'} text-center`}>
                  <div className="flex flex-col items-center gap-1">
                    <button
                      type="button"
                      onClick={() => setSpecialistSort((prev) => nextSort(prev, 'fact', 'desc'))}
                      className={headerButtonClass}
                    >
                      Факт
                      {sortIndicator(specialistSort?.key === 'fact', specialistSort?.dir ?? 'desc')}
                    </button>
                    <span className="text-[10px] normal-case text-gray-400">В работе</span>
                  </div>
                </th>
                <th className={`${isTma ? 'px-4 py-3' : 'px-6 py-4'} text-center`}>
                  <div className="flex flex-col items-center gap-1">
                    <button
                      type="button"
                      onClick={() => setSpecialistSort((prev) => nextSort(prev, 'prep', 'desc'))}
                      className={headerButtonClass}
                    >
                      Преп
                      {sortIndicator(specialistSort?.key === 'prep', specialistSort?.dir ?? 'desc')}
                    </button>
                    <span className="text-[10px] normal-case text-gray-400">Подготовка</span>
                  </div>
                </th>
                <th className={`${isTma ? 'px-4 py-3' : 'px-6 py-4'} text-center`}>
                  <button
                    type="button"
                    onClick={() => setSpecialistSort((prev) => nextSort(prev, 'plan', 'desc'))}
                    className={headerButtonClass}
                  >
                    План (Max)
                    {sortIndicator(specialistSort?.key === 'plan', specialistSort?.dir ?? 'desc')}
                  </button>
                </th>
                <th className={`${isTma ? 'px-4 py-3' : 'px-6 py-4'} text-left w-48`}>
                  <button
                    type="button"
                    onClick={() => setSpecialistSort((prev) => nextSort(prev, 'load', 'desc'))}
                    className={headerButtonClass}
                  >
                    Загрузка
                    {sortIndicator(specialistSort?.key === 'load', specialistSort?.dir ?? 'desc')}
                  </button>
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-50 bg-white">
              {sortedSpecialists.map((stat) => {
                const status = getLoadStatus(stat.fact, stat.plan);
                const loadPercent = Math.min(100, Math.round((stat.fact / stat.plan) * 100));
                
                return (
                  <tr key={stat.name} className="hover:bg-gray-50 transition-colors">
                    <td className={`${isTma ? 'px-4 py-3' : 'px-6 py-4'}`}>
                      <div className="flex items-center">
                        <TeamMemberAvatar
                          displayName={stat.name}
                          avatarUrl={nameToAvatarUrl.get(stat.name)}
                          signedUrl={avatarSignedUrls[stat.name]}
                          variant="specialist"
                        />
                        <div>
                          <p className="text-sm font-semibold text-gray-900">{stat.name}</p>
                          <p className="text-xs text-gray-500">{stat.activeProjects.length} активных</p>
                        </div>
                      </div>
                    </td>
                    <td className={`${isTma ? 'px-4 py-3' : 'px-6 py-4'} text-center`}>
                      <span className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium ring-1 ring-inset ${status.color}`}>
                        {status.label}
                      </span>
                    </td>
                    <td className={`${isTma ? 'px-4 py-3' : 'px-6 py-4'} text-center`}>
                      <span className="text-lg font-bold text-gray-900">{stat.fact}</span>
                    </td>
                    <td className={`${isTma ? 'px-4 py-3' : 'px-6 py-4'} text-center`}>
                      <span className={`text-sm font-medium ${stat.prep > 0 ? 'text-gray-900' : 'text-gray-400'}`}>
                        {stat.prep}
                      </span>
                    </td>
                    <td className={`${isTma ? 'px-4 py-3' : 'px-6 py-4'}`}>
                      <div className="flex items-center justify-center gap-2">
                        <button 
                          onClick={() => saveCapacity(`specialist:${stat.name}`, Math.max(1, stat.plan - 1))}
                          className="p-1 rounded hover:bg-gray-100 text-gray-400 hover:text-gray-600 text-[10px]"
                        >
                          ▼
                        </button>
                        <span className="text-sm font-bold text-gray-900 w-4 text-center">{stat.plan}</span>
                        <button 
                          onClick={() => saveCapacity(`specialist:${stat.name}`, stat.plan + 1)}
                          className="p-1 rounded hover:bg-gray-100 text-gray-400 hover:text-gray-600 text-[10px]"
                        >
                          ▲
                        </button>
                      </div>
                    </td>
                    <td className={`${isTma ? 'px-4 py-3' : 'px-6 py-4'}`}>
                      <div className="flex items-center gap-3">
                        <div className="flex-1 h-2 bg-gray-100 rounded-full overflow-hidden">
                          <div 
                            className={`h-full rounded-full transition-all duration-500 ${
                              loadPercent > 100 ? 'bg-red-500' : 
                              loadPercent > 85 ? 'bg-orange-500' : 
                              'bg-emerald-500'
                            }`}
                            style={{ width: `${loadPercent}%` }}
                          />
                        </div>
                        <span className="text-xs font-medium text-gray-600 w-9 text-right">{loadPercent}%</span>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
