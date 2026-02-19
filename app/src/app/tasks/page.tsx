'use client';

import { useEffect, useMemo, useState, useCallback } from 'react';
import { supabase } from '@/lib/supabaseClient';
import { Project, Task, TaskStatus, UserRole } from '@/types';
import { logError } from '@/lib/loggerClient';
import { useIsTma } from '@/lib/useIsTma';
import { isLead as checkIsLead } from '@/lib/roles';

const TASK_STATUS_CONFIG: Record<TaskStatus, { label: string; className: string }> = {
  pending: { label: 'Ожидает', className: 'bg-gray-100 text-gray-600 border-gray-200' },
  in_progress: { label: 'В работе', className: 'bg-blue-50 text-blue-700 border-blue-200' },
  done: { label: 'Завершено', className: 'bg-emerald-50 text-emerald-700 border-emerald-200' },
};

const splitLegacyTasks = (value: string | null | undefined) => {
  if (!value) return [];
  return value
    .split(/\r?\n|•|;+/)
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
};

type EnrichedTask = Task & {
  projectName: string;
  specialistName: string;
  isLegacy?: boolean;
};

export default function TasksPage() {
  const isTma = useIsTma();
  const [projects, setProjects] = useState<Project[]>([]);
  const [dbTasks, setDbTasks] = useState<Task[]>([]);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState<'tasks' | 'hypotheses'>('tasks');
  const [view, setView] = useState<'specialists' | 'projects'>('specialists');
  const [editingResultId, setEditingResultId] = useState<string | null>(null);
  const [editingResultValue, setEditingResultValue] = useState('');

  const [currentUserRole, setCurrentUserRole] = useState<UserRole | null>(null);
  const [currentUserName, setCurrentUserName] = useState<string | null>(null);

  const [showAddForm, setShowAddForm] = useState(false);
  const [newTitle, setNewTitle] = useState('');
  const [newProjectId, setNewProjectId] = useState('');
  const [newSpecialist, setNewSpecialist] = useState('');
  const [addingSaving, setAddingSaving] = useState(false);

  const userIsLead = checkIsLead(currentUserRole);

  useEffect(() => {
    void loadData();
  }, []);

  async function loadData() {
    try {
      setLoading(true);
      const { data: { session } } = await supabase.auth.getSession();
      if (session?.user?.id) {
        const { data: profile } = await supabase
          .from('profiles')
          .select('role, full_name')
          .eq('id', session.user.id)
          .single();
        if (profile) {
          setCurrentUserRole(profile.role as UserRole);
          setCurrentUserName(profile.full_name as string);
        }
      }

      const [projRes, taskRes] = await Promise.all([
        supabase.from('projects').select('*'),
        supabase.from('tasks').select('*').order('created_at', { ascending: false }),
      ]);
      if (projRes.error) throw projRes.error;
      setProjects((projRes.data ?? []) as Project[]);
      setDbTasks((taskRes.data ?? []) as Task[]);
    } catch (error) {
      void logError('tasks.fetch.failed', error);
    } finally {
      setLoading(false);
    }
  }

  const updateTaskStatus = useCallback(async (taskId: string, newStatus: TaskStatus) => {
    setDbTasks((prev) => prev.map((t) => (t.id === taskId ? { ...t, status: newStatus } : t)));
    await supabase.from('tasks').update({ status: newStatus, updated_at: new Date().toISOString() }).eq('id', taskId);
  }, []);

  const updateTaskResult = useCallback(async (taskId: string, result: string) => {
    setDbTasks((prev) => prev.map((t) => (t.id === taskId ? { ...t, result } : t)));
    await supabase.from('tasks').update({ result, updated_at: new Date().toISOString() }).eq('id', taskId);
    setEditingResultId(null);
  }, []);

  const projectMap = useMemo(() => {
    const m = new Map<string, Project>();
    projects.forEach((p) => m.set(p.id, p));
    return m;
  }, [projects]);

  const promoteLegacyTask = useCallback(async (legacyTask: EnrichedTask, newStatus: TaskStatus) => {
    const p = projectMap.get(legacyTask.project_id);
    const { data, error } = await supabase
      .from('tasks')
      .insert({
        project_id: legacyTask.project_id,
        title: legacyTask.title,
        status: newStatus,
        specialist: p?.specialist || null,
      })
      .select()
      .single();
    if (!error && data) {
      setDbTasks((prev) => [data as Task, ...prev]);
    }
  }, [projectMap]);

  const shouldFilterByUser = !userIsLead && currentUserName;

  const regularTasks = useMemo<EnrichedTask[]>(() => {
    let tasks = dbTasks;
    if (shouldFilterByUser) {
      tasks = tasks.filter((t) => {
        if (t.specialist && t.specialist === currentUserName) return true;
        const p = projectMap.get(t.project_id);
        return p?.specialist === currentUserName;
      });
    }
    return tasks.map((t) => {
      const p = projectMap.get(t.project_id);
      return {
        ...t,
        projectName: p?.client || 'Без проекта',
        specialistName: t.specialist || p?.specialist || 'Без специалиста',
      };
    });
  }, [dbTasks, projectMap, shouldFilterByUser, currentUserName]);

  const existingTaskTitles = useMemo(() => {
    const set = new Set<string>();
    dbTasks.forEach((t) => set.add(`${t.project_id}::${t.title}`));
    return set;
  }, [dbTasks]);

  const hypothesisTasks = useMemo<EnrichedTask[]>(() => {
    const enriched: EnrichedTask[] = [];
    const relevantProjects = shouldFilterByUser
      ? projects.filter((p) => p.specialist === currentUserName)
      : projects;

    relevantProjects.forEach((project) => {
      const legacy = splitLegacyTasks(project.hypotheses || project.weekly_tasks);
      legacy.forEach((title, idx) => {
        if (existingTaskTitles.has(`${project.id}::${title}`)) return;
        enriched.push({
          id: `legacy-${project.id}-${idx}`,
          project_id: project.id,
          title,
          status: 'pending' as TaskStatus,
          projectName: project.client || 'Без названия',
          specialistName: project.specialist || 'Без специалиста',
          isLegacy: true,
        });
      });
    });
    return enriched;
  }, [projects, shouldFilterByUser, currentUserName, existingTaskTitles]);

  const currentTasks = activeTab === 'tasks' ? regularTasks : hypothesisTasks;

  const tasksBySpecialist = useMemo(() => {
    const map = new Map<string, EnrichedTask[]>();
    currentTasks.forEach((t) => {
      const key = t.specialistName;
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(t);
    });
    return Array.from(map.entries()).sort((a, b) => b[1].length - a[1].length);
  }, [currentTasks]);

  const tasksByProject = useMemo(() => {
    const map = new Map<string, { projectName: string; tasks: EnrichedTask[] }>();
    currentTasks.forEach((t) => {
      if (!map.has(t.project_id)) map.set(t.project_id, { projectName: t.projectName, tasks: [] });
      map.get(t.project_id)!.tasks.push(t);
    });
    return Array.from(map.values()).filter((e) => e.tasks.length > 0);
  }, [currentTasks]);

  const specialistOptions = useMemo(() => {
    const set = new Set<string>();
    projects.forEach((p) => {
      if (p.specialist) set.add(p.specialist);
    });
    return Array.from(set).sort();
  }, [projects]);

  async function handleAddTask() {
    if (!newTitle.trim() || !newSpecialist) return;
    setAddingSaving(true);
    try {
      const payload: Record<string, string | null> = {
        title: newTitle.trim(),
        specialist: newSpecialist,
        project_id: newProjectId || null,
        status: 'pending',
      };
      if (!newProjectId) {
        const { data: fallback } = await supabase
          .from('projects')
          .select('id')
          .eq('specialist', newSpecialist)
          .limit(1)
          .single();
        if (fallback) payload.project_id = fallback.id;
        else {
          setAddingSaving(false);
          return;
        }
      }
      const { data, error } = await supabase.from('tasks').insert(payload).select().single();
      if (error) throw error;
      setDbTasks((prev) => [data as Task, ...prev]);
      setNewTitle('');
      setNewProjectId('');
      setNewSpecialist('');
      setShowAddForm(false);
    } catch (error) {
      void logError('tasks.add.failed', error);
    } finally {
      setAddingSaving(false);
    }
  }

  function renderTaskCard(task: EnrichedTask) {
    const statusCfg = TASK_STATUS_CONFIG[task.status];
    const isEditingResult = editingResultId === task.id;
    const statusOptions: TaskStatus[] = ['pending', 'in_progress', 'done'];

    return (
      <div key={task.id} className={`rounded-lg border p-3 transition-colors ${task.status === 'done' ? 'bg-gray-50 border-gray-200' : 'bg-white border-gray-200'}`}>
        <div className="flex items-start justify-between gap-2">
          <div className="flex-1 min-w-0">
            <p className="text-xs text-gray-500">{task.projectName}</p>
            <p className={`text-sm font-medium mt-0.5 ${task.status === 'done' ? 'text-gray-400 line-through' : 'text-gray-900'}`}>
              {task.title}
            </p>
          </div>
          <div className="flex items-center gap-1.5 flex-shrink-0">
            <select
              value={task.status}
              onChange={(e) => {
                const newStatus = e.target.value as TaskStatus;
                if (task.isLegacy) {
                  void promoteLegacyTask(task, newStatus);
                } else {
                  void updateTaskStatus(task.id, newStatus);
                }
              }}
              className={`appearance-none cursor-pointer rounded-full border px-2.5 py-0.5 text-[10px] font-semibold outline-none ${statusCfg.className}`}
            >
              {statusOptions.map((s) => (
                <option key={s} value={s}>{TASK_STATUS_CONFIG[s].label}</option>
              ))}
            </select>
          </div>
        </div>

        {!task.isLegacy && (
          <div className="mt-2 pt-2 border-t border-gray-100">
            {isEditingResult ? (
              <div className="flex gap-1.5">
                <input
                  type="text"
                  autoFocus
                  value={editingResultValue}
                  onChange={(e) => setEditingResultValue(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') void updateTaskResult(task.id, editingResultValue);
                    if (e.key === 'Escape') setEditingResultId(null);
                  }}
                  className="flex-1 text-xs border border-gray-200 rounded-lg px-2 py-1 outline-none focus:border-blue-400"
                  placeholder="Результат задачи..."
                />
                <button
                  type="button"
                  onClick={() => void updateTaskResult(task.id, editingResultValue)}
                  className="text-xs bg-blue-600 text-white px-2 py-1 rounded-lg hover:bg-blue-700"
                >
                  ✓
                </button>
              </div>
            ) : (
              <div
                className="cursor-pointer hover:bg-gray-50 rounded px-1 py-0.5 -mx-1 transition-colors"
                onClick={() => {
                  setEditingResultId(task.id);
                  setEditingResultValue(task.result || '');
                }}
              >
                {task.result ? (
                  <p className="text-xs text-gray-700"><span className="font-medium text-gray-500">Результат:</span> {task.result}</p>
                ) : (
                  <p className="text-xs text-gray-400">+ Добавить результат</p>
                )}
              </div>
            )}
          </div>
        )}
      </div>
    );
  }

  if (loading) {
    return (
      <div className="flex h-64 items-center justify-center">
        <div className="text-gray-500">Загрузка...</div>
      </div>
    );
  }

  return (
    <div className={isTma ? 'space-y-4' : 'space-y-6'}>
      <div className={isTma ? 'flex flex-col gap-3' : 'flex flex-wrap items-center justify-between gap-4'}>
        <div>
          <p className="text-sm text-gray-400">Главная / задачи</p>
          <h1 className={`${isTma ? 'text-xl' : 'text-2xl'} font-semibold text-gray-900`}>Задачи</h1>
          <p className="mt-1 text-sm text-gray-500">
            {shouldFilterByUser ? 'Ваши задачи.' : 'Задачи специалистов и проектов в одном месте.'}
          </p>
        </div>
        {userIsLead && (
          <button
            type="button"
            onClick={() => setShowAddForm((v) => !v)}
            className="flex items-center gap-1.5 rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 transition-colors"
          >
            + Добавить задачу
          </button>
        )}
      </div>

      {showAddForm && userIsLead && (
        <div className="rounded-xl border border-gray-200 bg-white p-4 shadow-sm space-y-3">
          <h3 className="text-sm font-semibold text-gray-900">Новая задача</h3>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            <div>
              <label className="block text-xs font-medium text-gray-500 mb-1">Специалист *</label>
              <select
                value={newSpecialist}
                onChange={(e) => setNewSpecialist(e.target.value)}
                className="w-full text-sm border border-gray-200 rounded-lg px-3 py-2 outline-none focus:border-blue-400"
              >
                <option value="">Выберите специалиста</option>
                {specialistOptions.map((s) => (
                  <option key={s} value={s}>{s}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-500 mb-1">Проект</label>
              <select
                value={newProjectId}
                onChange={(e) => setNewProjectId(e.target.value)}
                className="w-full text-sm border border-gray-200 rounded-lg px-3 py-2 outline-none focus:border-blue-400"
              >
                <option value="">Без проекта</option>
                {projects.map((p) => (
                  <option key={p.id} value={p.id}>{p.client || 'Без названия'}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-500 mb-1">Задача *</label>
              <input
                type="text"
                value={newTitle}
                onChange={(e) => setNewTitle(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void handleAddTask();
                }}
                placeholder="Описание задачи..."
                className="w-full text-sm border border-gray-200 rounded-lg px-3 py-2 outline-none focus:border-blue-400"
              />
            </div>
          </div>
          <div className="flex items-center gap-2 pt-1">
            <button
              type="button"
              disabled={addingSaving || !newTitle.trim() || !newSpecialist}
              onClick={() => void handleAddTask()}
              className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 transition-colors disabled:opacity-50"
            >
              {addingSaving ? 'Сохранение...' : 'Создать'}
            </button>
            <button
              type="button"
              onClick={() => setShowAddForm(false)}
              className="rounded-lg border border-gray-200 px-4 py-2 text-sm font-medium text-gray-600 hover:bg-gray-50 transition-colors"
            >
              Отмена
            </button>
          </div>
        </div>
      )}

      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className={isTma ? 'flex w-full items-center rounded-full bg-gray-100 p-1' : 'flex items-center rounded-full bg-gray-100 p-1'}>
          <button
            type="button"
            onClick={() => setActiveTab('tasks')}
            className={`${isTma ? 'flex flex-1 items-center justify-center gap-2 rounded-full px-3 py-1.5 text-xs font-medium transition' : 'flex items-center gap-2 rounded-full px-4 py-2 text-sm font-medium transition'} ${
              activeTab === 'tasks' ? 'bg-lime-300 text-gray-900' : 'text-gray-500 hover:text-gray-700'
            }`}
          >
            Задачи
            <span className={`text-xs ${activeTab === 'tasks' ? 'text-gray-600' : 'text-gray-400'}`}>
              {regularTasks.length}
            </span>
          </button>
          <button
            type="button"
            onClick={() => setActiveTab('hypotheses')}
            className={`${isTma ? 'flex flex-1 items-center justify-center gap-2 rounded-full px-3 py-1.5 text-xs font-medium transition' : 'flex items-center gap-2 rounded-full px-4 py-2 text-sm font-medium transition'} ${
              activeTab === 'hypotheses' ? 'bg-lime-300 text-gray-900' : 'text-gray-500 hover:text-gray-700'
            }`}
          >
            Задачи по гипотезам
            <span className={`text-xs ${activeTab === 'hypotheses' ? 'text-gray-600' : 'text-gray-400'}`}>
              {hypothesisTasks.length}
            </span>
          </button>
        </div>

        <div className="flex items-center rounded-full bg-gray-100 p-1">
          <button
            type="button"
            onClick={() => setView('specialists')}
            className={`flex items-center gap-2 rounded-full px-3 py-1.5 text-xs font-medium transition ${
              view === 'specialists' ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500 hover:text-gray-700'
            }`}
          >
            по специалистам
          </button>
          <button
            type="button"
            onClick={() => setView('projects')}
            className={`flex items-center gap-2 rounded-full px-3 py-1.5 text-xs font-medium transition ${
              view === 'projects' ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500 hover:text-gray-700'
            }`}
          >
            по проектам
          </button>
        </div>
      </div>

      {view === 'specialists' && (
        <div className={isTma ? 'grid grid-cols-1 gap-4' : 'grid grid-cols-1 gap-6 lg:grid-cols-3'}>
          {tasksBySpecialist.map(([specialist, list]) => (
            <div key={specialist} className={`rounded-xl border border-gray-200 bg-white shadow-sm ${isTma ? 'p-4' : 'p-5'}`}>
              <div className="flex items-center justify-between">
                <div>
                  <h3 className="text-lg font-semibold text-gray-900">{specialist}</h3>
                  <p className="text-xs text-gray-500">{list.length} задач</p>
                </div>
              </div>
              <div className="mt-4 space-y-3">
                {list.map(renderTaskCard)}
                {list.length === 0 && (
                  <div className="rounded-lg border border-dashed border-gray-200 p-3 text-center text-sm text-gray-400">
                    Нет задач
                  </div>
                )}
              </div>
            </div>
          ))}
          {tasksBySpecialist.length === 0 && (
            <div className={`rounded-xl border border-dashed border-gray-200 text-center text-sm text-gray-500 col-span-full ${isTma ? 'p-5' : 'p-6'}`}>
              Задачи пока не добавлены.
            </div>
          )}
        </div>
      )}

      {view === 'projects' && (
        <div className={isTma ? 'grid grid-cols-1 gap-4' : 'grid grid-cols-1 gap-6 lg:grid-cols-3'}>
          {tasksByProject.map(({ projectName, tasks: list }) => (
            <div key={projectName} className={`rounded-xl border border-gray-200 bg-white shadow-sm ${isTma ? 'p-4' : 'p-5'}`}>
              <div>
                <h3 className="text-lg font-semibold text-gray-900">{projectName}</h3>
                <p className="text-xs text-gray-500">{list.length} задач</p>
              </div>
              <div className="mt-4 space-y-3">
                {list.map(renderTaskCard)}
              </div>
            </div>
          ))}
          {tasksByProject.length === 0 && (
            <div className={`rounded-xl border border-dashed border-gray-200 text-center text-sm text-gray-500 col-span-full ${isTma ? 'p-5' : 'p-6'}`}>
              Нет проектов для отображения.
            </div>
          )}
        </div>
      )}
    </div>
  );
}
