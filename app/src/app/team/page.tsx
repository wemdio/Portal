'use client';

import { useEffect, useState, useMemo } from 'react';
import { supabase } from '@/lib/supabaseClient';
import { logError } from '@/lib/loggerClient';

interface ProjectData {
  id: string;
  name: string;
  status: string;
  manager: string | null;
  specialist: string | null;
}

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

export default function TeamPage() {
  const [projects, setProjects] = useState<ProjectData[]>([]);
  const [loading, setLoading] = useState(true);
  const [capacities, setCapacities] = useState<Record<string, number>>({});

  useEffect(() => {
    fetchData();
    loadCapacities();
  }, []);

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
      const { data, error } = await supabase
        .from('projects')
        .select('id, name, status, manager, specialist');

      if (error) throw error;
      setProjects(data || []);
    } catch (error) {
      void logError('team.data.fetch.failed', error);
    } finally {
      setLoading(false);
    }
  }

  const specialistStats = useMemo(() => {
    const statsMap = new Map<string, SpecialistStats>();
    const managerMap = new Map<string, ManagerStats>();

    projects.forEach((p) => {
      const status = p.status?.toLowerCase() || '';
      const isWorking = status.includes('работ') || status.includes('тест');
      const isPrep = status.includes('подготов');

      // Process Specialist
      if (p.specialist) {
        const name = p.specialist;
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
      if (p.manager) {
        const name = p.manager;
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

    const specialists = Array.from(statsMap.values()).sort((a, b) => b.fact - a.fact);
    const managers = Array.from(managerMap.values()).sort((a, b) => b.fact - a.fact);

    return { specialists, managers };
  }, [projects, capacities]);

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

  if (loading) {
    return (
      <div className="flex h-64 items-center justify-center">
        <div className="text-gray-400 text-sm">Загрузка...</div>
      </div>
    );
  }

  return (
    <div className="space-y-8 max-w-[1600px] mx-auto">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight text-gray-900">Нагрузка команды</h1>
          <p className="mt-1 text-sm text-gray-500">
            Мониторинг занятости специалистов и планирование ресурсов
          </p>
        </div>
      </div>

      {/* Metrics Cards */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <div className="bg-white p-5 rounded-2xl border border-gray-200 shadow-sm">
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

        <div className="bg-white p-5 rounded-2xl border border-gray-200 shadow-sm">
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

        <div className="bg-white p-5 rounded-2xl border border-gray-200 shadow-sm">
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

        <div className="bg-white p-5 rounded-2xl border border-gray-200 shadow-sm">
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
        <div className="px-6 py-4 border-b border-gray-100 bg-gray-50/50 flex items-center justify-between">
          <h2 className="text-lg font-bold text-gray-900">Лиды (Менеджеры)</h2>
          <span className="text-xs font-medium px-2.5 py-1 rounded-full bg-gray-100 text-gray-600">
            {specialistStats.managers.length} человек
          </span>
        </div>
        <div className="overflow-x-auto">
          <table className="min-w-full divide-y divide-gray-100">
            <thead className="bg-gray-50/50">
              <tr>
                <th className="px-6 py-4 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">Лид</th>
                <th className="px-6 py-4 text-center text-xs font-semibold text-gray-500 uppercase tracking-wider">Статус</th>
                <th className="px-6 py-4 text-center text-xs font-semibold text-gray-500 uppercase tracking-wider">
                  <div className="flex flex-col items-center gap-1">
                    <span>Факт</span>
                    <span className="text-[10px] normal-case text-gray-400">В работе</span>
                  </div>
                </th>
                <th className="px-6 py-4 text-center text-xs font-semibold text-gray-500 uppercase tracking-wider">
                  <div className="flex flex-col items-center gap-1">
                    <span>Преп</span>
                    <span className="text-[10px] normal-case text-gray-400">Подготовка</span>
                  </div>
                </th>
                <th className="px-6 py-4 text-center text-xs font-semibold text-gray-500 uppercase tracking-wider">План (Max)</th>
                <th className="px-6 py-4 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider w-48">Загрузка</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-50 bg-white">
              {specialistStats.managers.map((stat) => {
                const status = getLoadStatus(stat.fact, stat.plan);
                const loadPercent = Math.min(100, Math.round((stat.fact / stat.plan) * 100));
                
                return (
                  <tr key={stat.name} className="hover:bg-gray-50 transition-colors">
                    <td className="px-6 py-4">
                      <div className="flex items-center">
                        <div className="h-9 w-9 rounded-full bg-blue-50 flex items-center justify-center text-blue-600 text-sm font-bold mr-3 border border-blue-100">
                          {stat.name.charAt(0).toUpperCase()}
                        </div>
                        <div>
                          <p className="text-sm font-semibold text-gray-900">{stat.name}</p>
                          <p className="text-xs text-gray-500">{stat.activeProjects.length} активных</p>
                        </div>
                      </div>
                    </td>
                    <td className="px-6 py-4 text-center">
                      <span className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium ring-1 ring-inset ${status.color}`}>
                        {status.label}
                      </span>
                    </td>
                    <td className="px-6 py-4 text-center">
                      <span className="text-lg font-bold text-gray-900">{stat.fact}</span>
                    </td>
                    <td className="px-6 py-4 text-center">
                      <span className={`text-sm font-medium ${stat.prep > 0 ? 'text-gray-900' : 'text-gray-400'}`}>
                        {stat.prep}
                      </span>
                    </td>
                    <td className="px-6 py-4">
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
                    <td className="px-6 py-4">
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
        <div className="px-6 py-4 border-b border-gray-100 bg-gray-50/50 flex items-center justify-between">
          <h2 className="text-lg font-bold text-gray-900">Специалисты</h2>
          <span className="text-xs font-medium px-2.5 py-1 rounded-full bg-gray-100 text-gray-600">
            {specialistStats.specialists.length} человек
          </span>
        </div>
        <div className="overflow-x-auto">
          <table className="min-w-full divide-y divide-gray-100">
            <thead className="bg-gray-50/50">
              <tr>
                <th className="px-6 py-4 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">Специалист</th>
                <th className="px-6 py-4 text-center text-xs font-semibold text-gray-500 uppercase tracking-wider">Статус</th>
                <th className="px-6 py-4 text-center text-xs font-semibold text-gray-500 uppercase tracking-wider">
                  <div className="flex flex-col items-center gap-1">
                    <span>Факт</span>
                    <span className="text-[10px] normal-case text-gray-400">В работе</span>
                  </div>
                </th>
                <th className="px-6 py-4 text-center text-xs font-semibold text-gray-500 uppercase tracking-wider">
                  <div className="flex flex-col items-center gap-1">
                    <span>Преп</span>
                    <span className="text-[10px] normal-case text-gray-400">Подготовка</span>
                  </div>
                </th>
                <th className="px-6 py-4 text-center text-xs font-semibold text-gray-500 uppercase tracking-wider">План (Max)</th>
                <th className="px-6 py-4 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider w-48">Загрузка</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-50 bg-white">
              {specialistStats.specialists.map((stat) => {
                const status = getLoadStatus(stat.fact, stat.plan);
                const loadPercent = Math.min(100, Math.round((stat.fact / stat.plan) * 100));
                
                return (
                  <tr key={stat.name} className="hover:bg-gray-50 transition-colors">
                    <td className="px-6 py-4">
                      <div className="flex items-center">
                        <div className="h-9 w-9 rounded-full bg-gray-100 flex items-center justify-center text-gray-600 text-sm font-bold mr-3 border border-gray-200">
                          {stat.name.charAt(0).toUpperCase()}
                        </div>
                        <div>
                          <p className="text-sm font-semibold text-gray-900">{stat.name}</p>
                          <p className="text-xs text-gray-500">{stat.activeProjects.length} активных</p>
                        </div>
                      </div>
                    </td>
                    <td className="px-6 py-4 text-center">
                      <span className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium ring-1 ring-inset ${status.color}`}>
                        {status.label}
                      </span>
                    </td>
                    <td className="px-6 py-4 text-center">
                      <span className="text-lg font-bold text-gray-900">{stat.fact}</span>
                    </td>
                    <td className="px-6 py-4 text-center">
                      <span className={`text-sm font-medium ${stat.prep > 0 ? 'text-gray-900' : 'text-gray-400'}`}>
                        {stat.prep}
                      </span>
                    </td>
                    <td className="px-6 py-4">
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
                    <td className="px-6 py-4">
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
