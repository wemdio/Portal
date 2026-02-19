'use client';

import { useState, useEffect } from 'react';
import { Project, ProjectStatus, Task, UserProfile } from '@/types';
import { supabase } from '@/lib/supabaseClient';
import Link from 'next/link';
import { getCurrentUserRole, canCreateProjects, canEditProjects, canDeleteProjects } from '@/lib/roles';
import { logAudit, logError } from '@/lib/loggerClient';
import { useIsTma } from '@/lib/useIsTma';
import { buildAssigneeOptions, ensureCurrentAssigneeOption } from '@/lib/projectAssignees';

type ViewMode = 'table' | 'cards' | 'kanban';

const WORK_FORMAT_OPTIONS = ['Колди', 'Тригга', 'Инстантли'];
const LEAD_SOURCE_OPTIONS = ['Аутрич', 'Телеграм', 'Лидскан', 'ЛинкедИн', 'Перфоманс', 'Органика'];
const SERVICE_OPTIONS = ['Аутрич', 'ТГ аутрич', 'Лидскан', 'ЛинкедИн', 'Перфоманс', 'Ретаргет'];
const PROJECT_TYPE_OPTIONS = ['Продажа', 'Продление'];
const STATUS_OPTIONS = ['В работе', 'Тестирование', 'На паузе', 'Подготовка', 'Завершен', 'Отменен'];

/** Parse comma-separated services string into array */
const parseServices = (value: string | undefined | null): string[] => {
  if (!value) return [];
  return value.split(',').map((s) => s.trim()).filter(Boolean);
};

function resolveWorkFormat(value: string) {
  if (!value) return '';
  const match = WORK_FORMAT_OPTIONS.find(
    (option) => option.toLowerCase() === value.toLowerCase(),
  );
  return match ?? value;
}

const STATUS_CONFIG: Record<string, { label: string; color: string; bg: string; border: string }> = {
  'в работе': { label: 'В работе', color: 'text-emerald-700', bg: 'bg-emerald-50', border: 'border-emerald-200' },
  'тестирование': { label: 'Тестирование', color: 'text-blue-700', bg: 'bg-blue-50', border: 'border-blue-200' },
  'на паузе': { label: 'На паузе', color: 'text-amber-700', bg: 'bg-amber-50', border: 'border-amber-200' },
  'подготовка': { label: 'Подготовка', color: 'text-purple-700', bg: 'bg-purple-50', border: 'border-purple-200' },
  'завершен': { label: 'Завершен', color: 'text-gray-600', bg: 'bg-gray-100', border: 'border-gray-200' },
  'отменен': { label: 'Отменен', color: 'text-red-700', bg: 'bg-red-50', border: 'border-red-200' },
};

function getStatusConfig(status: string | null | undefined) {
  if (!status) return STATUS_CONFIG['в работе'];
  const key = status.toLowerCase().replace(/ё/g, 'е');
  for (const [k, v] of Object.entries(STATUS_CONFIG)) {
    if (key.includes(k)) return v;
  }
  return { label: status, color: 'text-gray-600', bg: 'bg-gray-100', border: 'border-gray-200' };
}

function getDeadlineStatus(deadline: string | null | undefined): 'overdue' | 'soon' | 'ok' | null {
  if (!deadline) return null;
  try {
    const deadlineDate = new Date(deadline);
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const diffDays = Math.ceil((deadlineDate.getTime() - today.getTime()) / (1000 * 60 * 60 * 24));
    if (diffDays < 0) return 'overdue';
    if (diffDays <= 7) return 'soon';
    return 'ok';
  } catch {
    return null;
  }
}

function formatDate(dateStr: string | null | undefined): string {
  if (!dateStr) return '';
  try {
    const date = new Date(dateStr);
    return date.toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' });
  } catch {
    return dateStr;
  }
}

const PLATFORM_CONFIG: Record<string, { label: string; className: string }> = {
  колди: { label: 'Колди', className: 'bg-sky-100 text-sky-800' },
  тригга: { label: 'Тригга', className: 'bg-violet-100 text-violet-800' },
  инстантли: { label: 'Инстантли', className: 'bg-emerald-100 text-emerald-800' },
};

function getPlatformConfig(value: string | null | undefined) {
  if (!value) return null;
  const key = value.toLowerCase();
  for (const [platformKey, config] of Object.entries(PLATFORM_CONFIG)) {
    if (key.includes(platformKey)) return config;
  }
  return { label: value, className: 'bg-gray-100 text-gray-700' };
}

function normalizeUrl(value: string | null | undefined) {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  return `https://${trimmed}`;
}

function formatUrlLabel(value: string) {
  return value.replace(/^https?:\/\//i, '').replace(/^www\./i, '');
}

function parseMaterials(value: string | null | undefined) {
  if (!value) return [];
  return value
    .split(/\r?\n|,|;/)
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

function getKpiValue(project: Project) {
  if (project.kpi_plan && project.kpi_fact) {
    return `${project.kpi_plan} / ${project.kpi_fact}`;
  }
  return project.kpi_plan || project.kpi_fact || '';
}

function getCommentValue(project: Project) {
  return project.comments || project.comment_elvira || project.comment_anya || '';
}

export function ProjectList() {
  const isTma = useIsTma();
  const [projects, setProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchTerm, setSearchTerm] = useState('');
  const [viewMode] = useState<ViewMode>('table');
  const [statusFilter, setStatusFilter] = useState<string>('all');
  const [openMenuId, setOpenMenuId] = useState<string | null>(null);
  const [canCreate, setCanCreate] = useState(false);
  const [canEdit, setCanEdit] = useState(false);
  const [canDelete, setCanDelete] = useState(false);
  const [drafts, setDrafts] = useState<Record<string, Partial<Project>>>({});
  const [savingRows, setSavingRows] = useState<Record<string, boolean>>({});
  const [isTableEditing, setIsTableEditing] = useState(false);
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);
  const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [assigneeOptions, setAssigneeOptions] = useState<string[]>([]);
  const [showProjectSettings, setShowProjectSettings] = useState(false);
  const [editingContactsId, setEditingContactsId] = useState<string | null>(null);
  const [editingContactsValue, setEditingContactsValue] = useState('');
  const [projectTasks, setProjectTasks] = useState<Record<string, Task[]>>({});
  const [taskPopoverId, setTaskPopoverId] = useState<string | null>(null);
  const [newTaskTitle, setNewTaskTitle] = useState('');

  useEffect(() => {
    void fetchProjects();
    void checkPermissions();
    void fetchAssigneeOptions();
    void fetchAllTasks();
  }, []);

  async function checkPermissions() {
    const role = await getCurrentUserRole();
    setCanCreate(canCreateProjects(role));
    setCanEdit(canEditProjects(role));
    setCanDelete(canDeleteProjects(role));
  }

  async function fetchProjects() {
    try {
      setLoading(true);
      const { data, error } = await supabase
        .from('projects')
        .select('*')
        .order('created_at', { ascending: false });
      
      if (error) throw error;
      if (data) setProjects(data as Project[]);
    } catch (error) {
      void logError('projects.list.fetch.failed', error);
    } finally {
      setLoading(false);
    }
  }

  async function fetchAssigneeOptions() {
    try {
      const { data, error } = await supabase
        .from('profiles')
        .select('email, full_name');

      if (error) throw error;
      setAssigneeOptions(
        buildAssigneeOptions(
          ((data ?? []) as Array<Pick<UserProfile, 'email' | 'full_name'>>),
        ),
      );
    } catch (error) {
      void logError('projects.assignees.fetch.failed', error);
    }
  }

  async function fetchAllTasks() {
    try {
      const { data, error } = await supabase
        .from('tasks')
        .select('*')
        .order('created_at', { ascending: false });
      if (error) throw error;
      const grouped: Record<string, Task[]> = {};
      for (const t of (data ?? []) as Task[]) {
        if (!grouped[t.project_id]) grouped[t.project_id] = [];
        grouped[t.project_id].push(t);
      }
      setProjectTasks(grouped);
    } catch {
      // tasks table may not exist yet
    }
  }

  async function addTask(projectId: string, title: string, specialist?: string) {
    if (!title.trim()) return;
    const { data, error } = await supabase
      .from('tasks')
      .insert({ project_id: projectId, title: title.trim(), specialist: specialist || null })
      .select()
      .single();
    if (error) return;
    const task = data as Task;
    setProjectTasks((prev) => ({
      ...prev,
      [projectId]: [task, ...(prev[projectId] ?? [])],
    }));
    setNewTaskTitle('');
  }

  async function deleteTask(taskId: string, projectId: string) {
    await supabase.from('tasks').delete().eq('id', taskId);
    setProjectTasks((prev) => ({
      ...prev,
      [projectId]: (prev[projectId] ?? []).filter((t) => t.id !== taskId),
    }));
  }

  async function updateProjectStatus(id: string, newStatus: string) {
    try {
      const { error } = await supabase
        .from('projects')
        .update({ status: newStatus, updated_at: new Date().toISOString() })
        .eq('id', id);
      
      if (error) throw error;
      
      const updatedAt = new Date().toISOString();
      setProjects(prev => prev.map(p => 
        p.id === id ? { ...p, status: newStatus as ProjectStatus, updated_at: updatedAt } : p
      ));
      void logAudit('projects.status.update.success', 'Project status updated', {
        projectId: id,
        status: newStatus,
      });
    } catch (error) {
      void logError('projects.status.update.failed', error, { projectId: id, status: newStatus });
    }
    setOpenMenuId(null);
  }

  async function deleteProject(id: string) {
    setDeleting(true);
    setDeleteError(null);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      const token = session?.access_token;
      if (!token) {
        setDeleteError('Необходима авторизация');
        return;
      }

      const res = await fetch(`/api/projects/${id}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` },
      });

      if (!res.ok) {
        let message = 'Не удалось удалить проект';
        try {
          const payload = (await res.json()) as { error?: string };
          if (payload?.error) message = payload.error;
        } catch {
          // ignore JSON parse errors
        }
        throw new Error(message);
      }

      setProjects((prev) => prev.filter((p) => p.id !== id));
      if (selectedProjectId === id) setSelectedProjectId(null);
      void logAudit('projects.delete.success', 'Project deleted', { projectId: id });
      setDeleteConfirmId(null);
    } catch (error) {
      void logError('projects.delete.failed', error, { projectId: id });
      setDeleteError(error instanceof Error ? error.message : 'Не удалось удалить проект');
    } finally {
      setDeleting(false);
      setOpenMenuId(null);
    }
  }

  const requestDeleteProject = (id: string) => {
    setDeleteError(null);
    setDeleteConfirmId(id);
  };

  const setDraftValue = (id: string, field: keyof Project, value: string) => {
    setDrafts((prev) => ({
      ...prev,
      [id]: {
        ...prev[id],
        [field]: value,
      },
    }));
  };

  const clearDraftFields = (id: string, fields: Array<keyof Project>) => {
    setDrafts((prev) => {
      const entry = { ...(prev[id] || {}) };
      fields.forEach((field) => {
        delete entry[field];
      });
      if (Object.keys(entry).length === 0) {
        const next = { ...prev };
        delete next[id];
        return next;
      }
      return { ...prev, [id]: entry };
    });
  };

  const getDraftValue = (project: Project, field: keyof Project) => {
    const draft = drafts[project.id];
    if (draft && draft[field] !== undefined) {
      return String(draft[field] ?? '');
    }
    return String((project[field] as string | null | undefined) ?? '');
  };

  const getDraftValueWithFallback = (
    project: Project,
    field: keyof Project,
    fallback: string,
  ) => {
    const draft = drafts[project.id];
    if (draft && draft[field] !== undefined) {
      return String(draft[field] ?? '');
    }
    const currentValue = (project[field] as string | null | undefined) ?? '';
    return currentValue || fallback;
  };

  const commitProjectUpdate = async (project: Project, updates: Partial<Project>) => {
    if (!canEdit) return;

    const payload: Partial<Project> = {};
    Object.entries(updates).forEach(([key, value]) => {
      const field = key as keyof Project;
      const currentValue = (project[field] as string | null | undefined) ?? '';
      const nextValue = (value as string | null | undefined) ?? '';

      if (nextValue !== currentValue) {
        (payload as Record<string, string | null>)[field] = nextValue === '' ? null : nextValue;
      }
    });

    if (Object.keys(payload).length === 0) {
      clearDraftFields(project.id, Object.keys(updates) as Array<keyof Project>);
      return;
    }

    payload.updated_at = new Date().toISOString();
    setSavingRows((prev) => ({ ...prev, [project.id]: true }));

    try {
      const { error } = await supabase
        .from('projects')
        .update(payload)
        .eq('id', project.id);

      if (error) throw error;

      setProjects((prev) =>
        prev.map((item) => (item.id === project.id ? { ...item, ...payload } : item)),
      );
      clearDraftFields(project.id, Object.keys(updates) as Array<keyof Project>);
      void logAudit('projects.update.success', 'Project updated', {
        projectId: project.id,
        fields: Object.keys(payload).filter((field) => field !== 'updated_at'),
      });
    } catch (error) {
      void logError('projects.update.failed', error, { projectId: project.id });
    } finally {
      setSavingRows((prev) => ({ ...prev, [project.id]: false }));
    }
  };

  const commitAllDrafts = async () => {
    const entries = Object.entries(drafts);
    if (entries.length === 0) return;

    await Promise.all(
      entries.map(([id, updates]) => {
        const project = projects.find((item) => item.id === id);
        if (!project) return Promise.resolve();
        return commitProjectUpdate(project, updates);
      }),
    );
  };

  const handleToggleEditing = async () => {
    if (isTableEditing) {
      await commitAllDrafts();
    }
    setIsTableEditing((prev) => !prev);
  };

  const selectedProject = selectedProjectId
    ? projects.find((project) => project.id === selectedProjectId) || null
    : null;

  const filteredProjects = projects.filter((project) => {
    const normalizedSearch = searchTerm.trim().toLowerCase();
    const matchesSearch = !normalizedSearch
      || [
        project.client,
        project.name,
        project.budget,
        project.contract_link,
        project.handoff_link,
        project.deadline,
        project.kpi_plan,
        project.specialist,
        project.manager,
        project.comments,
        project.work_format,
      ]
        .filter(Boolean)
        .some((value) => value?.toLowerCase().includes(normalizedSearch));
    
    if (statusFilter === 'all') return matchesSearch;
    
    const status = project.status?.toLowerCase() || '';
    return matchesSearch && status.includes(statusFilter);
  });

  const statusCounts = {
    all: projects.length,
    'подготовка': projects.filter(p => p.status?.toLowerCase().includes('подготовк')).length,
    'в работе': projects.filter(p => p.status?.toLowerCase().includes('работ')).length,
    'тестирование': projects.filter(p => p.status?.toLowerCase().includes('тест')).length,
    'на паузе': projects.filter(p => p.status?.toLowerCase().includes('пауз')).length,
    'завершен': projects.filter(p => p.status?.toLowerCase().includes('заверш')).length,
  };

  const overdueCount = projects.filter(p => getDeadlineStatus(p.deadline) === 'overdue').length;
  const soonCount = projects.filter(p => getDeadlineStatus(p.deadline) === 'soon').length;

  const sortedProjects = filteredProjects;

  if (loading) {
    return (
      <div className="flex h-64 items-center justify-center">
        <div className="text-gray-400 text-sm">Загрузка...</div>
      </div>
    );
  }

  // Group projects by status for Kanban view
  const kanbanColumns = [
    { key: 'подготовка', ...STATUS_CONFIG['подготовка'] },
    { key: 'в работе', ...STATUS_CONFIG['в работе'] },
    { key: 'тестирование', ...STATUS_CONFIG['тестирование'] },
    { key: 'на паузе', ...STATUS_CONFIG['на паузе'] },
    { key: 'завершен', ...STATUS_CONFIG['завершен'] },
  ];

  const getProjectsForColumn = (columnKey: string) => {
    return filteredProjects.filter(p => {
      const status = p.status?.toLowerCase() || '';
      return status.includes(columnKey);
    });
  };

  return (
    <div className={isTma ? 'space-y-4' : 'space-y-4'}>
      {/* Header */}
      <div className={`flex flex-col sm:flex-row sm:items-center sm:justify-between pb-2 ${isTma ? 'gap-4' : 'gap-6'}`}>
        <div>
          <h1 className={`${isTma ? 'text-xl' : 'text-2xl'} font-bold tracking-tight text-gray-900`}>Проекты</h1>
          <p className="mt-1 text-sm text-gray-500 font-medium">{projects.length} проектов</p>
        </div>
        <div className={isTma ? 'flex w-full flex-col gap-3' : 'flex flex-wrap items-center gap-3'}>
          {canEdit && (
            <button
              type="button"
              onClick={() => void handleToggleEditing()}
              className={`inline-flex items-center justify-center rounded-lg px-4 py-2 text-sm font-medium transition-all duration-200 border ${isTma ? 'w-full' : ''} ${
                isTableEditing
                  ? 'bg-emerald-50 text-emerald-700 border-emerald-200 hover:bg-emerald-100'
                  : 'bg-white text-gray-700 border-gray-200 hover:bg-gray-50 shadow-sm'
              }`}
            >
              {isTableEditing ? 'Завершить' : 'Редактировать'}
            </button>
          )}
        {canCreate && (
          <Link 
            href="/projects/new"
              className={`inline-flex items-center justify-center rounded-lg bg-gray-900 px-4 py-2 text-sm font-medium text-white shadow-sm hover:bg-gray-800 transition-all duration-200 ${isTma ? 'w-full' : ''}`}
          >
            Новый проект
          </Link>
        )}
        </div>
      </div>

      {/* Controls */}
      <div className={isTma ? 'flex flex-col gap-3 bg-white p-3 rounded-xl shadow-sm border border-gray-200' : 'flex flex-col lg:flex-row gap-4 items-center bg-white p-2 rounded-xl shadow-sm border border-gray-200'}>
        {/* Search */}
        <div className="relative flex-1 w-full">
          <input
            type="text"
            className="w-full rounded-lg border-0 bg-gray-50 py-2.5 px-4 text-sm text-gray-900 placeholder-gray-400 focus:ring-0 focus:bg-white transition-colors"
            placeholder="Поиск..."
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
          />
      </div>

      {/* Status Filter Tabs */}
      {viewMode !== 'kanban' && (
          <div className={isTma ? 'flex w-full items-center gap-1 overflow-x-auto no-scrollbar border-t border-gray-100 pt-2' : 'flex items-center gap-1 overflow-x-auto no-scrollbar border-l border-gray-100 pl-4 py-1'}>
          {[
            { key: 'all', label: 'Все' },
            { key: 'подготовка', label: 'Подготовка' },
            { key: 'в работе', label: 'В работе' },
            { key: 'тестирование', label: 'Тест' },
            { key: 'на паузе', label: 'Пауза' },
            { key: 'завершен', label: 'Завершено' },
          ].map((tab) => (
            <button
              key={tab.key}
              onClick={() => setStatusFilter(tab.key)}
                className={`flex items-center px-3 py-1.5 rounded-md text-xs font-medium whitespace-nowrap transition-all duration-200 ${
                statusFilter === tab.key
                    ? 'bg-gray-100 text-gray-900'
                    : 'text-gray-500 hover:bg-gray-50 hover:text-gray-700'
              }`}
            >
              {tab.label}
                <span className={`ml-2 px-1.5 py-0.5 rounded-full text-[10px] ${
                  statusFilter === tab.key ? 'bg-white text-gray-700 shadow-sm' : 'bg-gray-100 text-gray-400'
              }`}>
                {statusCounts[tab.key as keyof typeof statusCounts] || 0}
              </span>
            </button>
          ))}
        </div>
      )}
      </div>

      {/* Empty State */}
      {filteredProjects.length === 0 && (
        <div className="text-center py-16 bg-white rounded-2xl border border-dashed border-gray-200">
          <h3 className="mt-4 text-lg font-medium text-gray-900">Нет проектов</h3>
          <p className="mt-2 text-sm text-gray-500">
            {searchTerm ? 'Попробуйте изменить поиск' : 'Создайте первый проект или импортируйте данные'}
          </p>
          {canCreate && (
            <Link 
              href="/projects/new"
              className="mt-4 inline-flex items-center text-sm font-medium text-blue-600 hover:text-blue-700"
            >
              Создать проект
            </Link>
          )}
        </div>
      )}

      {isTma && filteredProjects.length > 0 && (
        <div className="space-y-3">
          {sortedProjects.map((project) => (
            <ProjectCard 
              key={project.id} 
              project={project} 
              onStatusChange={updateProjectStatus}
              openMenuId={openMenuId}
              setOpenMenuId={setOpenMenuId}
              onDeleteRequest={requestDeleteProject}
              canDelete={canDelete}
            />
          ))}
        </div>
      )}

      {/* Cards View */}
      {!isTma && viewMode === 'cards' && filteredProjects.length > 0 && (
        <div className="space-y-4">
          {sortedProjects.map((project) => (
            <ProjectCard 
              key={project.id} 
              project={project} 
              onStatusChange={updateProjectStatus}
              openMenuId={openMenuId}
              setOpenMenuId={setOpenMenuId}
              onDeleteRequest={requestDeleteProject}
              canDelete={canDelete}
            />
          ))}
        </div>
      )}

      {/* Kanban View */}
      {!isTma && viewMode === 'kanban' && (
        <div className="flex gap-4 overflow-x-auto pb-4">
          {kanbanColumns.map((column) => (
            <div 
              key={column.key}
              className="flex-shrink-0 w-72 bg-gray-50 rounded-xl p-3 border border-gray-200"
            >
              <div className={`flex items-center justify-between mb-3 px-2`}>
                <div className="flex items-center">
                  <div className={`w-2 h-2 rounded-full mr-2 ${column.bg.replace('bg-', 'bg-').replace('-50', '-500')}`} 
                       style={{ backgroundColor: column.color.replace('text-', '').replace('-700', '') }} />
                  <h3 className={`text-sm font-semibold ${column.color}`}>{column.label}</h3>
                </div>
                <span className="text-xs text-gray-400 font-medium">
                  {getProjectsForColumn(column.key).length}
                </span>
              </div>
              <div className="space-y-2">
                {getProjectsForColumn(column.key).map((project) => (
                  <KanbanCard 
                    key={project.id} 
                    project={project}
                    onStatusChange={updateProjectStatus}
                    columns={kanbanColumns}
                    onDeleteRequest={requestDeleteProject}
                    canDelete={canDelete}
                  />
                ))}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Table View */}
      {!isTma && viewMode === 'table' && filteredProjects.length > 0 && (
        <div className="relative overflow-hidden rounded-xl border border-gray-200 bg-white shadow-sm">
          <div className="overflow-x-auto max-h-[calc(100vh-220px)]">
            <table className="min-w-full divide-y divide-gray-100 text-sm">
              <thead className="bg-gray-50 sticky top-0 z-10">
                <tr>
                  <th className="px-4 py-3.5 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">Проект</th>
                  <th className="px-4 py-3.5 text-center text-xs font-semibold text-gray-500 uppercase tracking-wider">Статус</th>
                  <th className="px-4 py-3.5 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">Сумма</th>
                  <th className="px-4 py-3.5 text-center text-xs font-semibold text-gray-500 uppercase tracking-wider">Договор</th>
                  <th className="px-4 py-3.5 text-center text-xs font-semibold text-gray-500 uppercase tracking-wider">Передача</th>
                  <th className="px-4 py-3.5 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">Дедлайн</th>
                  <th className="px-4 py-3.5 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">KPI План</th>
                  <th className="px-4 py-3.5 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">KPI Факт</th>
                  <th className="px-4 py-3.5 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider whitespace-nowrap">Контакты</th>
                  <th className="px-4 py-3.5 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">Специалист</th>
                  <th className="px-4 py-3.5 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">Лид (PM)</th>
                  <th className="px-4 py-3.5 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider whitespace-nowrap">Формат</th>
                  <th className="px-4 py-3.5 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider whitespace-nowrap">Комментарии/Задачи</th>
              </tr>
            </thead>
              <tbody className="divide-y divide-gray-50 bg-white">
                {sortedProjects.map((project) => {
                  const isSaving = Boolean(savingRows[project.id]);
                  const isDisabled = !canEdit || isSaving;
                  const nameValue = getDraftValue(project, 'name');
                  const budgetValue = getDraftValue(project, 'budget');
                  const contractValue = getDraftValue(project, 'contract_link');
                  const handoffValue = getDraftValue(project, 'handoff_link');
                  const deadlineValue = getDraftValue(project, 'deadline');
                  const kpiValue = getDraftValue(project, 'kpi_plan');
                  const kpiFactValue = getDraftValue(project, 'kpi_fact');
                  const specialistValue = getDraftValue(project, 'specialist');
                  const managerValue = getDraftValue(project, 'manager');
                  const specialistSelectOptions = ensureCurrentAssigneeOption(assigneeOptions, specialistValue);
                  const managerSelectOptions = ensureCurrentAssigneeOption(assigneeOptions, managerValue);
                  const commentsValue = getDraftValue(project, 'comments');
                  const workFormatValue = resolveWorkFormat(getDraftValue(project, 'work_format'));
                  const contractHref = normalizeUrl(project.contract_link);
                  const handoffHref = normalizeUrl(project.handoff_link);
                  const platformConfig = getPlatformConfig(project.work_format);
                  const readOnlyProjectTitle = project.client || '—';
                  const services = parseServices(project.name);
                  const readOnlyBudget = project.budget || '—';
                  const readOnlyDeadline = project.deadline || '—';
                  const readOnlyKpi = project.kpi_plan || '—';
                  const readOnlyKpiFact = project.kpi_fact || '—';
                  const readOnlySpecialist = project.specialist || '—';
                  const readOnlyManager = project.manager || '—';
                  const readOnlyComment = project.comments || '—';
                  
                return (
                    <tr key={project.id} className="hover:bg-gray-50 transition-colors group">
                      <td className="px-4 py-3 align-top min-w-[140px]">
                        {isTableEditing ? (
                          <div className="flex items-center gap-2">
                            <InlineInput
                              value={nameValue}
                              onChange={(value) => setDraftValue(project.id, 'name', value)}
                              onCommit={(value) => void commitProjectUpdate(project, { name: value })}
                              disabled={isDisabled}
                              placeholder="Название проекта"
                              className="font-medium"
                            />
                            <button
                              type="button"
                              onClick={() => setSelectedProjectId(project.id)}
                              className="p-1 text-gray-400 hover:text-blue-600 rounded hover:bg-blue-50 transition-colors"
                              title="Открыть карточку"
                            >
                              ↗
                            </button>
                          </div>
                        ) : (
                          <button
                            type="button"
                            onClick={() => setSelectedProjectId(project.id)}
                            className="text-left font-medium text-gray-900 hover:text-blue-600 transition-colors group/btn"
                          >
                            <div className="flex items-start gap-2">
                              <span className="break-words">{readOnlyProjectTitle}</span>
                              <span className="opacity-0 group-hover/btn:opacity-100 transition-opacity text-gray-400 mt-1 flex-shrink-0 text-xs">↗</span>
                            </div>
                            {services.length > 0 && (
                              <span className="flex flex-wrap gap-1 mt-1">
                                {services.map((s) => (
                                  <span key={s} className="inline-flex items-center bg-blue-50 text-blue-700 text-[10px] font-medium px-1.5 py-0.5 rounded">{s}</span>
                                ))}
                              </span>
                            )}
                          </button>
                      )}
                    </td>
                      <td className="px-4 py-3 align-top whitespace-nowrap text-center">
                        {(() => {
                          const cfg = getStatusConfig(project.status);
                          return canEdit ? (
                            <select
                              value={project.status || ''}
                              onChange={(e) => {
                                void commitProjectUpdate(project, { status: e.target.value as ProjectStatus });
                              }}
                              disabled={isSaving}
                              className={`appearance-none cursor-pointer text-xs font-medium px-2.5 py-1 rounded-full border-0 ring-1 ring-inset ring-black/5 ${cfg.bg} ${cfg.color} focus:outline-none focus:ring-2 focus:ring-blue-500/30`}
                            >
                              {STATUS_OPTIONS.map((s) => (
                                <option key={s} value={s}>{s}</option>
                              ))}
                            </select>
                          ) : (
                            <span className={`inline-flex items-center px-2.5 py-1 rounded-full text-xs font-medium ring-1 ring-inset ring-black/5 ${cfg.bg} ${cfg.color}`}>
                              {cfg.label}
                            </span>
                          );
                        })()}
                      </td>
                      <td className="px-4 py-3 align-top whitespace-nowrap">
                        {isTableEditing ? (
                          <InlineInput
                            value={budgetValue}
                            onChange={(value) => setDraftValue(project.id, 'budget', value)}
                            onCommit={(value) => void commitProjectUpdate(project, { budget: value })}
                            disabled={isDisabled}
                            placeholder="Сумма"
                          />
                        ) : (
                          <span className="text-gray-900 font-medium">{readOnlyBudget}</span>
                      )}
                    </td>
                      <td className="px-4 py-3 align-top whitespace-nowrap text-center">
                        {isTableEditing ? (
                          <InlineInput
                            value={contractValue}
                            onChange={(value) => setDraftValue(project.id, 'contract_link', value)}
                            onCommit={(value) => void commitProjectUpdate(project, { contract_link: value })}
                            disabled={isDisabled}
                            placeholder="https://..."
                          />
                        ) : contractHref ? (
                          <a href={contractHref} target="_blank" rel="noreferrer" className="inline-flex items-center justify-center w-8 h-8 rounded-lg bg-blue-50 text-blue-600 hover:bg-blue-100 transition-colors text-xs font-medium" title="Открыть договор">
                            Дог.
                          </a>
                        ) : (
                          <span className="text-gray-300">—</span>
                        )}
                      </td>
                      <td className="px-4 py-3 align-top whitespace-nowrap text-center">
                        {isTableEditing ? (
                          <InlineInput
                            value={handoffValue}
                            onChange={(value) => setDraftValue(project.id, 'handoff_link', value)}
                            onCommit={(value) => void commitProjectUpdate(project, { handoff_link: value })}
                            disabled={isDisabled}
                            placeholder="https://..."
                          />
                        ) : handoffHref ? (
                          <a href={handoffHref} target="_blank" rel="noreferrer" className="inline-flex items-center justify-center w-8 h-8 rounded-lg bg-indigo-50 text-indigo-600 hover:bg-indigo-100 transition-colors text-xs font-medium" title="Открыть передачу">
                            Пер.
                          </a>
                        ) : (
                          <span className="text-gray-300">—</span>
                        )}
                      </td>
                      <td className="px-4 py-3 align-top whitespace-nowrap">
                        {isTableEditing ? (
                          <InlineInput
                            value={deadlineValue}
                            onChange={(value) => setDraftValue(project.id, 'deadline', value)}
                            onCommit={(value) => void commitProjectUpdate(project, { deadline: value })}
                            disabled={isDisabled}
                            placeholder="DD.MM.YY"
                          />
                        ) : (() => {
                          const dlStatus = getDeadlineStatus(project.deadline);
                          return (
                            <span className={
                              dlStatus === 'overdue' ? 'text-red-600 font-semibold' :
                              dlStatus === 'soon' ? 'text-amber-600 font-medium' :
                              'text-gray-600'
                            }>
                              {readOnlyDeadline}
                              {dlStatus === 'overdue' && <span className="ml-1 text-[10px]">●</span>}
                            </span>
                          );
                        })()}
                      </td>
                      <td className="px-4 py-3 align-top whitespace-nowrap">
                        {isTableEditing ? (
                          <InlineInput
                            value={kpiValue}
                            onChange={(value) => setDraftValue(project.id, 'kpi_plan', value)}
                            onCommit={(value) => void commitProjectUpdate(project, { kpi_plan: value })}
                            disabled={isDisabled}
                            placeholder="KPI План"
                          />
                        ) : (
                          <span className="text-gray-900">{readOnlyKpi}</span>
                        )}
                      </td>
                      <td className="px-4 py-3 align-top whitespace-nowrap w-[90px]">
                        {isTableEditing ? (
                          <InlineStepper
                            value={kpiFactValue}
                            onChange={(value) => setDraftValue(project.id, 'kpi_fact', value)}
                            onCommit={(value) => void commitProjectUpdate(project, { kpi_fact: value })}
                            disabled={isDisabled}
                            placeholder="Факт"
                          />
                        ) : (
                          <div className="flex items-center gap-1">
                            <span className="text-gray-900 tabular-nums">{readOnlyKpiFact}</span>
                            {canEdit && (
                              <div className="flex flex-col gap-px ml-0.5">
                                <button
                                  type="button"
                                  disabled={isSaving}
                                  onClick={() => {
                                    const cur = parseInt(project.kpi_fact ?? '0', 10);
                                    const next = (isNaN(cur) ? 0 : cur) + 1;
                                    void commitProjectUpdate(project, { kpi_fact: next.toString() });
                                  }}
                                  className="flex items-center justify-center w-4 h-3 text-gray-300 hover:text-gray-600 transition-colors disabled:opacity-30 leading-none"
                                  style={{ fontSize: '8px' }}
                                  title="Увеличить"
                                >
                                  ▲
                                </button>
                                <button
                                  type="button"
                                  disabled={isSaving}
                                  onClick={() => {
                                    const cur = parseInt(project.kpi_fact ?? '0', 10);
                                    const next = (isNaN(cur) ? 0 : cur) - 1;
                                    void commitProjectUpdate(project, { kpi_fact: next.toString() });
                                  }}
                                  className="flex items-center justify-center w-4 h-3 text-gray-300 hover:text-gray-600 transition-colors disabled:opacity-30 leading-none"
                                  style={{ fontSize: '8px' }}
                                  title="Уменьшить"
                                >
                                  ▼
                                </button>
                              </div>
                            )}
                          </div>
                        )}
                      </td>
                      <td className="px-4 py-3 align-top whitespace-nowrap w-[140px]">
                        {(() => {
                          const obligation = parseInt(project.contacts_obligation ?? '0', 10) || 0;
                          const done = parseInt(project.contacts_done ?? '0', 10) || 0;
                          const pct = obligation > 0 ? Math.min(Math.round((done / obligation) * 100), 100) : 0;
                          const barColor = pct >= 100 ? 'bg-emerald-500' : pct >= 50 ? 'bg-blue-500' : 'bg-amber-500';
                          const isEditingThis = editingContactsId === project.id;

                          if (isEditingThis) {
                            return (
                              <input
                                type="text"
                                autoFocus
                                value={editingContactsValue}
                                onChange={(e) => setEditingContactsValue(e.target.value)}
                                onBlur={() => {
                                  void commitProjectUpdate(project, { contacts_done: editingContactsValue });
                                  setEditingContactsId(null);
                                }}
                                onKeyDown={(e) => {
                                  if (e.key === 'Enter') e.currentTarget.blur();
                                  if (e.key === 'Escape') setEditingContactsId(null);
                                }}
                                className="w-full rounded-md border border-blue-400 bg-white px-2 py-1 text-sm text-gray-900 outline-none ring-2 ring-blue-500/20"
                              />
                            );
                          }

                          return (
                            <div
                              className={canEdit ? 'cursor-pointer hover:bg-gray-100 rounded-md px-1 py-0.5 -mx-1 transition-colors' : ''}
                              onClick={() => {
                                if (!canEdit || isSaving) return;
                                setEditingContactsValue(project.contacts_done || '0');
                                setEditingContactsId(project.id);
                              }}
                            >
                              {obligation > 0 ? (
                                <>
                                  <div className="flex items-baseline gap-1 mb-1">
                                    <span className="text-sm font-medium text-gray-900 tabular-nums">{done.toLocaleString('ru-RU')}</span>
                                    <span className="text-xs text-gray-400">/ {obligation.toLocaleString('ru-RU')}</span>
                                  </div>
                                  <div className="w-full h-1.5 bg-gray-200 rounded-full overflow-hidden">
                                    <div className={`h-full rounded-full transition-all ${barColor}`} style={{ width: `${pct}%` }} />
                                  </div>
                                </>
                              ) : (
                                <span className="text-gray-300">—</span>
                              )}
                            </div>
                          );
                        })()}
                      </td>
                      <td className="px-4 py-3 align-top whitespace-nowrap">
                        {isTableEditing ? (
                          <InlineSelect
                            value={specialistValue}
                            options={specialistSelectOptions}
                            onChange={(value) => {
                              setDraftValue(project.id, 'specialist', value);
                              void commitProjectUpdate(project, { specialist: value });
                            }}
                            disabled={isDisabled}
                          />
                        ) : (
                          readOnlySpecialist !== '—' ? (
                             <div className="flex items-center">
                                <div className="w-6 h-6 rounded-full bg-emerald-100 text-emerald-700 flex items-center justify-center text-xs font-medium mr-2">
                                  {readOnlySpecialist.charAt(0).toUpperCase()}
                                </div>
                                <span className="text-gray-700">{readOnlySpecialist}</span>
                             </div>
                          ) : <span className="text-gray-300">—</span>
                        )}
                      </td>
                      <td className="px-4 py-3 align-top whitespace-nowrap">
                        {isTableEditing ? (
                          <InlineSelect
                            value={managerValue}
                            options={managerSelectOptions}
                            onChange={(value) => {
                              setDraftValue(project.id, 'manager', value);
                              void commitProjectUpdate(project, { manager: value });
                            }}
                            disabled={isDisabled}
                          />
                        ) : (
                           readOnlyManager !== '—' ? (
                             <div className="flex items-center">
                                <div className="w-6 h-6 rounded-full bg-blue-100 text-blue-700 flex items-center justify-center text-xs font-medium mr-2">
                                  {readOnlyManager.charAt(0).toUpperCase()}
                                </div>
                                <span className="text-gray-700">{readOnlyManager}</span>
                             </div>
                          ) : <span className="text-gray-300">—</span>
                        )}
                      </td>
                      <td className="px-4 py-3 align-top whitespace-nowrap">
                        {isTableEditing ? (
                          <InlineSelect
                            value={workFormatValue}
                            options={WORK_FORMAT_OPTIONS}
                            onChange={(value) => {
                              setDraftValue(project.id, 'work_format', value);
                              void commitProjectUpdate(project, { work_format: value });
                            }}
                            disabled={isDisabled}
                          />
                        ) : platformConfig?.label ? (
                          <span className={`inline-flex items-center rounded-md px-2 py-1 text-xs font-medium ${platformConfig.className} ring-1 ring-inset ring-black/5`}>
                            {platformConfig.label}
                          </span>
                        ) : (
                          <span className="text-gray-300">—</span>
                        )}
                    </td>
                      <td className="px-4 py-3 align-top min-w-[180px] relative">
                        {(() => {
                          const tasks = projectTasks[project.id] ?? [];
                          const latestTask = tasks[0];
                          const isOpen = taskPopoverId === project.id;
                          return (
                            <>
                              <div
                                className={`cursor-pointer rounded-md px-2 py-1 -mx-1 transition-colors ${isOpen ? 'bg-blue-50' : 'hover:bg-gray-100'}`}
                                onClick={() => setTaskPopoverId(isOpen ? null : project.id)}
                              >
                                {latestTask ? (
                                  <div>
                                    <p className="text-xs text-gray-900 line-clamp-2">{latestTask.title}</p>
                                    {tasks.length > 1 && (
                                      <p className="text-[10px] text-gray-400 mt-0.5">+{tasks.length - 1} ещё</p>
                                    )}
                                  </div>
                                ) : (
                                  <span className="text-gray-300 text-xs">{canEdit ? '+ задача' : '—'}</span>
                                )}
                              </div>
                              {isOpen && (
                                <div className="absolute right-0 top-full mt-1 z-30 w-72 bg-white rounded-xl border border-gray-200 shadow-xl p-3 space-y-2">
                                  <div className="flex items-center justify-between mb-1">
                                    <span className="text-xs font-bold text-gray-700">Задачи</span>
                                    <button type="button" onClick={() => setTaskPopoverId(null)} className="text-gray-400 hover:text-gray-600 text-sm">✕</button>
                                  </div>
                                  <div className="max-h-48 overflow-y-auto space-y-1.5">
                                    {tasks.map((t) => (
                                      <div key={t.id} className="flex items-start gap-2 rounded-lg bg-gray-50 p-2 text-xs group">
                                        <span className={`mt-0.5 w-1.5 h-1.5 rounded-full flex-shrink-0 ${t.status === 'done' ? 'bg-emerald-500' : t.status === 'in_progress' ? 'bg-blue-500' : 'bg-gray-300'}`} />
                                        <span className={`flex-1 ${t.status === 'done' ? 'line-through text-gray-400' : 'text-gray-800'}`}>{t.title}</span>
                                        {canEdit && (
                                          <button type="button" onClick={() => void deleteTask(t.id, project.id)} className="opacity-0 group-hover:opacity-100 text-red-400 hover:text-red-600 text-[10px] transition-opacity">✕</button>
                                        )}
                                      </div>
                                    ))}
                                    {tasks.length === 0 && <p className="text-xs text-gray-400 text-center py-2">Нет задач</p>}
                                  </div>
                                  {canEdit && (
                                    <div className="flex gap-1.5 pt-1 border-t border-gray-100">
                                      <input
                                        type="text"
                                        value={newTaskTitle}
                                        onChange={(e) => setNewTaskTitle(e.target.value)}
                                        onKeyDown={(e) => {
                                          if (e.key === 'Enter') void addTask(project.id, newTaskTitle, project.specialist);
                                        }}
                                        placeholder="Новая задача..."
                                        className="flex-1 text-xs border border-gray-200 rounded-lg px-2 py-1.5 outline-none focus:border-blue-400 focus:ring-1 focus:ring-blue-400/20"
                                      />
                                      <button
                                        type="button"
                                        onClick={() => void addTask(project.id, newTaskTitle, project.specialist)}
                                        className="text-xs bg-blue-600 text-white px-2.5 py-1.5 rounded-lg hover:bg-blue-700 transition-colors font-medium"
                                      >
                                        +
                                      </button>
                                    </div>
                                  )}
                                </div>
                              )}
                            </>
                          );
                        })()}
                      </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          </div>
        </div>
      )}

      {selectedProject && (
        <div className={isTma ? 'fixed inset-0 z-50 flex items-stretch justify-center p-0' : 'fixed inset-0 z-50 flex items-center justify-center p-4 sm:p-6'}>
          <div
            className="absolute inset-0 bg-gray-900/30 backdrop-blur-sm transition-opacity"
            onClick={() => setSelectedProjectId(null)}
          />
          <div className={isTma ? 'relative w-full h-[100dvh] overflow-y-auto rounded-none bg-white shadow-2xl ring-1 ring-gray-900/5 flex flex-col' : 'relative w-full max-w-4xl max-h-[90vh] overflow-y-auto rounded-3xl bg-white shadow-2xl ring-1 ring-gray-900/5 flex flex-col'}>
            <div className={isTma ? 'flex flex-col gap-4 border-b border-gray-100 px-4 py-4 sticky top-0 bg-white/95 backdrop-blur z-20 transition-all' : 'flex items-start justify-between border-b border-gray-100 px-8 py-6 sticky top-0 bg-white/95 backdrop-blur z-20 transition-all'}>
              <div className={isTma ? 'flex-1' : 'flex-1 pr-8'}>
                <div className="flex items-center gap-3 mb-2">
                  <h2 className={`${isTma ? 'text-xl' : 'text-2xl'} font-bold text-gray-900 leading-tight`}>
                    {selectedProject.client || 'Без названия'}
                  </h2>
                  {selectedProject.name && (
                    <div className="flex flex-wrap gap-1.5 mt-1">
                      {parseServices(selectedProject.name).map((service) => (
                        <span key={service} className="inline-flex items-center bg-blue-100 text-blue-800 text-xs font-medium px-2.5 py-0.5 rounded-full">{service}</span>
                      ))}
                    </div>
                  )}
                  {selectedProject.status && (
                     <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ring-1 ring-inset ${
                        getStatusConfig(selectedProject.status).bg.replace('bg-', 'bg-').replace('text-', 'text-').replace('border-', 'ring-')
                     } ${getStatusConfig(selectedProject.status).color}`}>
                       {getStatusConfig(selectedProject.status).label}
                     </span>
                  )}
                </div>
                <div className="flex items-center gap-4 text-sm text-gray-500">
                   <div className="flex items-center gap-1.5">
                     <span>Дедлайн: {selectedProject.deadline ? formatDate(selectedProject.deadline) : 'Не указан'}</span>
                   </div>
                   {selectedProject.budget && (
                     <div className="flex items-center gap-1.5">
                       <span className="font-semibold text-gray-700">{selectedProject.budget}</span>
                     </div>
                   )}
                </div>
              </div>
              <div className="flex items-center gap-2">
                {canDelete && (
                  <button
                    type="button"
                    onClick={() => requestDeleteProject(selectedProject.id)}
                    className="rounded-full p-2 text-gray-400 hover:bg-red-50 hover:text-red-500 transition-all"
                    title="Удалить проект"
                  >
                    <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" /></svg>
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => setSelectedProjectId(null)}
                  className="group relative rounded-full p-2 text-gray-400 hover:bg-gray-100 hover:text-gray-500 transition-all text-xl leading-none"
                >
                  &times;
                </button>
              </div>
            </div>

            <div className={isTma ? 'p-4 space-y-6 bg-white min-h-[500px]' : 'p-8 space-y-10 bg-white min-h-[500px]'}>
              
              <section className={`grid grid-cols-1 md:grid-cols-2 ${isTma ? 'gap-4' : 'gap-8'}`}>
                <div className="bg-gray-50 rounded-2xl p-5 border border-gray-200 transition-colors group hover:bg-gray-100/50">
                  <div className="flex items-center gap-3 mb-3">
                    <label className="text-sm font-bold text-gray-700 tracking-wide uppercase">Специалист</label>
                  </div>
                  <InlineSelect
                    value={getDraftValue(selectedProject, 'specialist')}
                    options={ensureCurrentAssigneeOption(
                      assigneeOptions,
                      getDraftValue(selectedProject, 'specialist'),
                    )}
                    onChange={(value) => {
                      setDraftValue(selectedProject.id, 'specialist', value);
                      void commitProjectUpdate(selectedProject, { specialist: value });
                    }}
                    disabled={!canEdit || Boolean(savingRows[selectedProject.id])}
                    className="bg-white border border-gray-300 shadow-sm focus:border-blue-500 px-3 py-2 text-sm font-medium rounded-lg text-gray-900 placeholder:text-gray-400"
                  />
                </div>
                
                <div className="bg-gray-50 rounded-2xl p-5 border border-gray-200 transition-colors group hover:bg-gray-100/50">
                  <div className="flex items-center gap-3 mb-3">
                    <label className="text-sm font-bold text-gray-700 tracking-wide uppercase">Лид (PM)</label>
                  </div>
                  <InlineSelect
                    value={getDraftValue(selectedProject, 'manager')}
                    options={ensureCurrentAssigneeOption(
                      assigneeOptions,
                      getDraftValue(selectedProject, 'manager'),
                    )}
                    onChange={(value) => {
                      setDraftValue(selectedProject.id, 'manager', value);
                      void commitProjectUpdate(selectedProject, { manager: value });
                    }}
                    disabled={!canEdit || Boolean(savingRows[selectedProject.id])}
                    className="bg-white border border-gray-300 shadow-sm focus:border-blue-500 px-3 py-2 text-sm font-medium rounded-lg text-gray-900 placeholder:text-gray-400"
                  />
                </div>
              </section>

              <section>
                <h3 className="text-lg font-bold text-gray-900 mb-4 flex items-center gap-2 tracking-tight">
                  ОБРАТНАЯ СВЯЗЬ
                </h3>
                <div className="relative group">
                   <div className="absolute -inset-1 rounded-xl bg-gray-100 opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none" />
                   <div className="relative">
                      <InlineTextarea
                        value={getDraftValue(selectedProject, 'client_feedback')}
                        onChange={(value) => setDraftValue(selectedProject.id, 'client_feedback', value)}
                        onCommit={(value) => void commitProjectUpdate(selectedProject, { client_feedback: value })}
                        disabled={!canEdit || Boolean(savingRows[selectedProject.id])}
                        placeholder="Добавьте обратную связь от заказчика..."
                        rows={3}
                        className="bg-white border border-gray-300 shadow-sm focus:border-blue-500 p-4 text-gray-700 leading-relaxed resize-none rounded-lg placeholder:text-gray-400"
                      />
                   </div>
                </div>
              </section>

              <section className={`grid grid-cols-1 md:grid-cols-2 ${isTma ? 'gap-4' : 'gap-6'}`}>
                <div className="flex flex-col h-full rounded-2xl bg-blue-50/30 border border-blue-100 p-6 transition-all hover:shadow-md hover:border-blue-200">
                   <h3 className="text-sm font-bold text-blue-900 uppercase tracking-wide mb-4 flex items-center gap-2">
                     <span className="w-2 h-2 rounded-full bg-blue-600 ring-2 ring-blue-100"></span>
                     Гипотезы и Задачи
                   </h3>
                   <InlineTextarea
                      value={getDraftValueWithFallback(
                        selectedProject,
                        'hypotheses',
                        selectedProject.weekly_tasks || '',
                      )}
                      onChange={(value) => setDraftValue(selectedProject.id, 'hypotheses', value)}
                      onCommit={(value) => void commitProjectUpdate(selectedProject, { hypotheses: value })}
                      disabled={!canEdit || Boolean(savingRows[selectedProject.id])}
                      placeholder="Опишите гипотезы и задачи..."
                      rows={8}
                      className="flex-1 bg-white border border-gray-200 shadow-sm focus:border-blue-500 text-gray-700 leading-relaxed rounded-xl placeholder:text-gray-400 p-4"
                   />
                </div>
                
                <div className="flex flex-col h-full rounded-2xl bg-emerald-50/30 border border-emerald-100 p-6 transition-all hover:shadow-md hover:border-emerald-200">
                   <h3 className="text-sm font-bold text-emerald-900 uppercase tracking-wide mb-4 flex items-center gap-2">
                     <span className="w-2 h-2 rounded-full bg-emerald-600 ring-2 ring-emerald-100"></span>
                     Результат
                   </h3>
                   <InlineTextarea
                      value={getDraftValue(selectedProject, 'hypotheses_result')}
                      onChange={(value) => setDraftValue(selectedProject.id, 'hypotheses_result', value)}
                      onCommit={(value) => void commitProjectUpdate(selectedProject, { hypotheses_result: value })}
                      disabled={!canEdit || Boolean(savingRows[selectedProject.id])}
                      placeholder="Каков результат?"
                      rows={8}
                      className="flex-1 bg-white border border-gray-200 shadow-sm focus:border-emerald-500 text-gray-700 leading-relaxed rounded-xl placeholder:text-gray-400 p-4"
                   />
                </div>
              </section>

              <section className={`grid grid-cols-1 md:grid-cols-2 ${isTma ? 'gap-4' : 'gap-8'}`}>
                 <div className="bg-gray-50 rounded-xl p-4 border border-gray-200">
                    <h3 className="text-sm font-bold text-gray-900 mb-2 pb-2 border-b border-gray-200">Подзадачи</h3>
                    <InlineTextarea
                      value={getDraftValue(selectedProject, 'subtasks')}
                      onChange={(value) => setDraftValue(selectedProject.id, 'subtasks', value)}
                      onCommit={(value) => void commitProjectUpdate(selectedProject, { subtasks: value })}
                      disabled={!canEdit || Boolean(savingRows[selectedProject.id])}
                      placeholder="Список подзадач..."
                      rows={4}
                      className="bg-white border border-gray-300 shadow-sm focus:border-blue-500 text-gray-700 rounded-lg placeholder:text-gray-400 p-3"
                    />
                 </div>
                 <div className="bg-gray-50 rounded-xl p-4 border border-gray-200">
                    <h3 className="text-sm font-bold text-gray-900 mb-2 pb-2 border-b border-gray-200">Комментарий передачи</h3>
                    <InlineTextarea
                      value={getDraftValue(selectedProject, 'comments')}
                      onChange={(value) => setDraftValue(selectedProject.id, 'comments', value)}
                      onCommit={(value) => void commitProjectUpdate(selectedProject, { comments: value })}
                      disabled={!canEdit || Boolean(savingRows[selectedProject.id])}
                      placeholder="Внутренний комментарий..."
                      rows={4}
                      className="bg-white border border-gray-300 shadow-sm focus:border-blue-500 text-gray-700 rounded-lg placeholder:text-gray-400 p-3"
                    />
                 </div>
              </section>

              <section>
                <div className="flex items-center justify-between mb-4">
                  <h3 className="text-lg font-bold text-gray-900">Материалы и ссылки</h3>
                </div>
                <div className="bg-gray-50/80 rounded-2xl p-6 border border-gray-100">
                  <InlineTextarea
                    value={getDraftValue(selectedProject, 'materials_links')}
                    onChange={(value) => setDraftValue(selectedProject.id, 'materials_links', value)}
                    onCommit={(value) => void commitProjectUpdate(selectedProject, { materials_links: value })}
                    disabled={!canEdit || Boolean(savingRows[selectedProject.id])}
                    placeholder="Вставьте ссылки (каждая с новой строки)..."
                    rows={2}
                    className="bg-white border border-gray-300 shadow-sm mb-6 focus:ring-2 focus:ring-blue-500/10 focus:border-blue-500 rounded-lg"
                  />
                  
                  {parseMaterials(getDraftValue(selectedProject, 'materials_links')).length > 0 && (
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                        {parseMaterials(getDraftValue(selectedProject, 'materials_links')).map((item, index) => {
                          const url = normalizeUrl(item);
                          return (
                            <div key={`${item}-${index}`} className="group relative flex items-center p-3 bg-white rounded-xl border border-gray-200 shadow-sm hover:border-blue-400 hover:shadow-md transition-all duration-200">
                              {url ? (
                                <a
                                  href={url}
                                  target="_blank"
                                  rel="noreferrer"
                                  className="flex items-center w-full min-w-0"
                                >
                                  <div className="flex-shrink-0 w-8 h-8 flex items-center justify-center rounded-lg bg-blue-50 text-blue-600 group-hover:bg-blue-600 group-hover:text-white transition-colors mr-3 text-xs font-bold">
                                    ↗
                                  </div>
                                  <div className="flex-1 min-w-0">
                                    <p className="text-sm font-medium text-gray-900 truncate group-hover:text-blue-600 transition-colors">
                                      {formatUrlLabel(url)}
                                    </p>
                                    <p className="text-xs text-gray-400 truncate">Открыть ссылку</p>
                                  </div>
                                </a>
                              ) : (
                                <div className="flex items-center w-full min-w-0">
                                  <div className="flex-shrink-0 w-8 h-8 flex items-center justify-center rounded-lg bg-gray-100 text-gray-500 mr-3 text-xs font-bold">
                                    TXT
                                  </div>
                                  <span className="text-sm font-medium text-gray-700 truncate">{item}</span>
                                </div>
                              )}
                            </div>
                          );
                        })}
                    </div>
                  )}
                </div>
              </section>

              {/* Collapsible Project Settings */}
              {canEdit && (
                <section className="border-t border-gray-200 pt-6">
                  <button
                    type="button"
                    onClick={() => setShowProjectSettings(!showProjectSettings)}
                    className="flex items-center gap-3 w-full px-4 py-3 bg-gray-100 hover:bg-gray-200 rounded-xl transition-colors"
                  >
                    <svg className={`w-5 h-5 text-gray-600 transition-transform ${showProjectSettings ? 'rotate-90' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                    </svg>
                    <span className="text-sm font-bold text-gray-700 uppercase tracking-wide">Настройки проекта</span>
                    <span className="text-xs text-gray-400 ml-auto">{showProjectSettings ? 'Свернуть' : 'Развернуть'}</span>
                  </button>

                  {showProjectSettings && (
                    <div className="mt-6 space-y-5">
                      {/* Client & Status */}
                      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                        <div>
                          <label className="block text-xs font-bold text-gray-500 uppercase tracking-wide mb-2">Клиент</label>
                          <InlineInput
                            value={getDraftValue(selectedProject, 'client')}
                            onChange={(value) => setDraftValue(selectedProject.id, 'client', value)}
                            onCommit={(value) => void commitProjectUpdate(selectedProject, { client: value })}
                            disabled={Boolean(savingRows[selectedProject.id])}
                            placeholder="Название компании"
                          />
                        </div>
                        <div>
                          <label className="block text-xs font-bold text-gray-500 uppercase tracking-wide mb-2">Статус</label>
                          <InlineSelect
                            value={getDraftValue(selectedProject, 'status')}
                            options={STATUS_OPTIONS}
                            onChange={(value) => {
                              setDraftValue(selectedProject.id, 'status', value);
                              void commitProjectUpdate(selectedProject, { status: value as ProjectStatus });
                            }}
                            disabled={Boolean(savingRows[selectedProject.id])}
                          />
                        </div>
                      </div>

                      {/* Services */}
                      <div>
                        <label className="block text-xs font-bold text-gray-500 uppercase tracking-wide mb-2">Услуги</label>
                        <div className="flex flex-wrap gap-2">
                          {SERVICE_OPTIONS.map((service) => {
                            const currentServices = parseServices(getDraftValue(selectedProject, 'name'));
                            const isSelected = currentServices.includes(service);
                            return (
                              <button
                                key={service}
                                type="button"
                                disabled={Boolean(savingRows[selectedProject.id])}
                                onClick={() => {
                                  const updated = isSelected
                                    ? currentServices.filter((s) => s !== service)
                                    : [...currentServices, service];
                                  const newValue = updated.join(', ');
                                  setDraftValue(selectedProject.id, 'name', newValue);
                                  void commitProjectUpdate(selectedProject, { name: newValue });
                                }}
                                className={`px-3 py-1.5 rounded-lg border text-sm font-medium transition-colors disabled:opacity-50 ${
                                  isSelected
                                    ? 'bg-blue-600 text-white border-blue-600'
                                    : 'bg-white text-gray-700 border-gray-300 hover:border-blue-400 hover:bg-blue-50'
                                }`}
                              >
                                {service}
                              </button>
                            );
                          })}
                        </div>
                      </div>

                      {/* Financial */}
                      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                        <div>
                          <label className="block text-xs font-bold text-gray-500 uppercase tracking-wide mb-2">Сумма договора</label>
                          <InlineInput
                            value={getDraftValue(selectedProject, 'budget')}
                            onChange={(value) => setDraftValue(selectedProject.id, 'budget', value)}
                            onCommit={(value) => void commitProjectUpdate(selectedProject, { budget: value })}
                            disabled={Boolean(savingRows[selectedProject.id])}
                            placeholder="150000"
                          />
                        </div>
                        <div>
                          <label className="block text-xs font-bold text-gray-500 uppercase tracking-wide mb-2">Маржа</label>
                          <InlineInput
                            value={getDraftValue(selectedProject, 'margin')}
                            onChange={(value) => setDraftValue(selectedProject.id, 'margin', value)}
                            onCommit={(value) => void commitProjectUpdate(selectedProject, { margin: value })}
                            disabled={Boolean(savingRows[selectedProject.id])}
                            placeholder="Маржа %"
                          />
                        </div>
                        <div>
                          <label className="block text-xs font-bold text-gray-500 uppercase tracking-wide mb-2">Тип проекта</label>
                          <InlineSelect
                            value={getDraftValue(selectedProject, 'project_type')}
                            options={PROJECT_TYPE_OPTIONS}
                            onChange={(value) => {
                              setDraftValue(selectedProject.id, 'project_type', value);
                              void commitProjectUpdate(selectedProject, { project_type: value as Project['project_type'] });
                            }}
                            disabled={Boolean(savingRows[selectedProject.id])}
                          />
                        </div>
                      </div>

                      {/* Platform & Source */}
                      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                        <div>
                          <label className="block text-xs font-bold text-gray-500 uppercase tracking-wide mb-2">Где ведется проект</label>
                          <InlineSelect
                            value={getDraftValue(selectedProject, 'work_format')}
                            options={WORK_FORMAT_OPTIONS}
                            onChange={(value) => {
                              setDraftValue(selectedProject.id, 'work_format', value);
                              void commitProjectUpdate(selectedProject, { work_format: value });
                            }}
                            disabled={Boolean(savingRows[selectedProject.id])}
                          />
                        </div>
                        <div>
                          <label className="block text-xs font-bold text-gray-500 uppercase tracking-wide mb-2">Источник лида</label>
                          <InlineSelect
                            value={getDraftValue(selectedProject, 'lead_source')}
                            options={LEAD_SOURCE_OPTIONS}
                            onChange={(value) => {
                              setDraftValue(selectedProject.id, 'lead_source', value);
                              void commitProjectUpdate(selectedProject, { lead_source: value });
                            }}
                            disabled={Boolean(savingRows[selectedProject.id])}
                          />
                        </div>
                      </div>

                      {/* Dates */}
                      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                        <div>
                          <label className="block text-xs font-bold text-gray-500 uppercase tracking-wide mb-2">Дата оплаты</label>
                          <InlineInput
                            value={getDraftValue(selectedProject, 'payment_date')}
                            onChange={(value) => setDraftValue(selectedProject.id, 'payment_date', value)}
                            onCommit={(value) => void commitProjectUpdate(selectedProject, { payment_date: value })}
                            disabled={Boolean(savingRows[selectedProject.id])}
                            type="date"
                          />
                        </div>
                        <div>
                          <label className="block text-xs font-bold text-gray-500 uppercase tracking-wide mb-2">Дата договора</label>
                          <InlineInput
                            value={getDraftValue(selectedProject, 'contract_date')}
                            onChange={(value) => setDraftValue(selectedProject.id, 'contract_date', value)}
                            onCommit={(value) => void commitProjectUpdate(selectedProject, { contract_date: value })}
                            disabled={Boolean(savingRows[selectedProject.id])}
                            type="date"
                          />
                        </div>
                      </div>

                      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                        <div>
                          <label className="block text-xs font-bold text-gray-500 uppercase tracking-wide mb-2">Дата запуска</label>
                          <InlineInput
                            value={getDraftValue(selectedProject, 'launch_date')}
                            onChange={(value) => setDraftValue(selectedProject.id, 'launch_date', value)}
                            onCommit={(value) => void commitProjectUpdate(selectedProject, { launch_date: value })}
                            disabled={Boolean(savingRows[selectedProject.id])}
                            type="date"
                          />
                        </div>
                        <div>
                          <label className="block text-xs font-bold text-gray-500 uppercase tracking-wide mb-2">Дедлайн</label>
                          <InlineInput
                            value={getDraftValue(selectedProject, 'deadline')}
                            onChange={(value) => setDraftValue(selectedProject.id, 'deadline', value)}
                            onCommit={(value) => void commitProjectUpdate(selectedProject, { deadline: value })}
                            disabled={Boolean(savingRows[selectedProject.id])}
                            type="date"
                          />
                        </div>
                      </div>

                      {/* Links */}
                      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                        <div>
                          <label className="block text-xs font-bold text-gray-500 uppercase tracking-wide mb-2">Ссылка на договор</label>
                          <InlineInput
                            value={getDraftValue(selectedProject, 'contract_link')}
                            onChange={(value) => setDraftValue(selectedProject.id, 'contract_link', value)}
                            onCommit={(value) => void commitProjectUpdate(selectedProject, { contract_link: value })}
                            disabled={Boolean(savingRows[selectedProject.id])}
                            placeholder="https://..."
                          />
                        </div>
                        <div>
                          <label className="block text-xs font-bold text-gray-500 uppercase tracking-wide mb-2">Ссылка на передачу</label>
                          <InlineInput
                            value={getDraftValue(selectedProject, 'handoff_link')}
                            onChange={(value) => setDraftValue(selectedProject.id, 'handoff_link', value)}
                            onCommit={(value) => void commitProjectUpdate(selectedProject, { handoff_link: value })}
                            disabled={Boolean(savingRows[selectedProject.id])}
                            placeholder="https://..."
                          />
                        </div>
                      </div>

                      {/* KPI */}
                      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                        <div>
                          <label className="block text-xs font-bold text-gray-500 uppercase tracking-wide mb-2">KPI План</label>
                          <InlineInput
                            value={getDraftValue(selectedProject, 'kpi_plan')}
                            onChange={(value) => setDraftValue(selectedProject.id, 'kpi_plan', value)}
                            onCommit={(value) => void commitProjectUpdate(selectedProject, { kpi_plan: value })}
                            disabled={Boolean(savingRows[selectedProject.id])}
                            placeholder="KPI план"
                          />
                        </div>
                        <div>
                          <label className="block text-xs font-bold text-gray-500 uppercase tracking-wide mb-2">KPI Факт</label>
                          <InlineInput
                            value={getDraftValue(selectedProject, 'kpi_fact')}
                            onChange={(value) => setDraftValue(selectedProject.id, 'kpi_fact', value)}
                            onCommit={(value) => void commitProjectUpdate(selectedProject, { kpi_fact: value })}
                            disabled={Boolean(savingRows[selectedProject.id])}
                            placeholder="KPI факт"
                          />
                        </div>
                      </div>

                      {/* Contacts */}
                      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                        <div>
                          <label className="block text-xs font-bold text-gray-500 uppercase tracking-wide mb-2">Обязательство по контактам</label>
                          <InlineInput
                            value={getDraftValue(selectedProject, 'contacts_obligation')}
                            onChange={(value) => setDraftValue(selectedProject.id, 'contacts_obligation', value)}
                            onCommit={(value) => void commitProjectUpdate(selectedProject, { contacts_obligation: value })}
                            disabled={Boolean(savingRows[selectedProject.id])}
                            placeholder="Например 4000"
                          />
                        </div>
                        <div>
                          <label className="block text-xs font-bold text-gray-500 uppercase tracking-wide mb-2">Контактов пройдено</label>
                          <InlineInput
                            value={getDraftValue(selectedProject, 'contacts_done')}
                            onChange={(value) => setDraftValue(selectedProject.id, 'contacts_done', value)}
                            onCommit={(value) => void commitProjectUpdate(selectedProject, { contacts_done: value })}
                            disabled={Boolean(savingRows[selectedProject.id])}
                            placeholder="0"
                          />
                        </div>
                      </div>
                    </div>
                  )}
                </section>
              )}
            </div>
            
             <div className={isTma ? 'bg-gray-50 px-4 py-4 border-t border-gray-100 flex flex-col gap-3' : 'bg-gray-50 px-8 py-5 rounded-b-3xl border-t border-gray-100 flex justify-between items-center'}>
               <span className="text-xs text-gray-400">
                  {selectedProject.updated_at ? `Последнее обновление: ${new Date(selectedProject.updated_at).toLocaleDateString()}` : ''}
               </span>
               <button
                  type="button"
                  onClick={() => setSelectedProjectId(null)}
                  className="px-6 py-2.5 bg-gray-900 text-white rounded-xl text-sm font-medium hover:bg-gray-800 hover:shadow-lg hover:shadow-gray-900/20 transition-all duration-200"
                >
                  Готово
                </button>
             </div>
          </div>
        </div>
      )}

      {/* Delete confirmation modal */}
      {deleteConfirmId && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center">
          <div
            className="fixed inset-0 bg-black/50"
            onClick={() => {
              if (!deleting) {
                setDeleteConfirmId(null);
                setDeleteError(null);
              }
            }}
          />
          <div className="relative bg-white rounded-2xl shadow-2xl max-w-md w-full mx-4 p-6">
            <div className="flex items-center justify-center w-12 h-12 mx-auto rounded-full bg-red-100 mb-4">
              <svg xmlns="http://www.w3.org/2000/svg" className="h-6 w-6 text-red-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4c-.77-.833-1.964-.833-2.732 0L4.082 16.5c-.77.833.192 2.5 1.732 2.5z" />
              </svg>
            </div>
            <h3 className="text-lg font-semibold text-gray-900 text-center">Удалить проект?</h3>
            <p className="mt-2 text-sm text-gray-500 text-center">
              Вы уверены, что хотите удалить проект{' '}
              <span className="font-medium text-gray-700">
                {projects.find((p) => p.id === deleteConfirmId)?.client || 'Без названия'}
              </span>
              ? Это действие нельзя отменить.
            </p>
            {deleteError && (
              <div className="mt-4 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
                {deleteError}
              </div>
            )}
            <div className="mt-6 flex gap-3">
              <button
                type="button"
                onClick={() => {
                  setDeleteConfirmId(null);
                  setDeleteError(null);
                }}
                disabled={deleting}
                className="flex-1 px-4 py-2.5 border border-gray-300 rounded-lg text-sm font-medium text-gray-700 hover:bg-gray-50 transition-colors disabled:opacity-50"
              >
                Отмена
              </button>
              <button
                type="button"
                onClick={() => deleteConfirmId && deleteProject(deleteConfirmId)}
                disabled={deleting}
                className="flex-1 px-4 py-2.5 bg-red-600 text-white rounded-lg text-sm font-medium hover:bg-red-700 transition-colors disabled:opacity-50"
              >
                {deleting ? 'Удаление...' : 'Да, удалить'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function InlineStepper({
  value,
  onChange,
  onCommit,
  disabled,
  placeholder,
  className,
}: {
  value: string;
  onChange: (value: string) => void;
  onCommit?: (value: string) => void;
  disabled?: boolean;
  placeholder?: string;
  className?: string;
}) {
  const numericValue = parseInt(value, 10);
  const isValidNumber = !isNaN(numericValue);

  const handleStep = (step: number) => {
    if (disabled) return;
    const current = isValidNumber ? numericValue : 0;
    const newValue = (current + step).toString();
    onChange(newValue);
    onCommit?.(newValue);
  };

  return (
    <div className={`relative flex items-center ${className || ''}`}>
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onBlur={(e) => onCommit?.(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.currentTarget.blur();
          }
        }}
        disabled={disabled}
        placeholder={placeholder}
        className="w-full rounded-lg border border-gray-200 bg-white pl-3 pr-8 py-2 text-sm text-gray-900 placeholder-gray-400 focus:border-blue-500 focus:ring-2 focus:ring-blue-500/20 outline-none transition-all disabled:bg-gray-50 disabled:text-gray-500 disabled:cursor-not-allowed"
      />
      <div className="absolute right-1 top-1/2 -translate-y-1/2 flex flex-col gap-0.5">
        <button
          type="button"
          onClick={(e) => {
            e.preventDefault(); // prevent focus loss
            handleStep(1);
          }}
          disabled={disabled}
          className="flex h-3.5 w-5 items-center justify-center rounded-sm bg-gray-100 text-gray-500 hover:bg-gray-200 hover:text-gray-700 disabled:opacity-50 text-[10px]"
        >
          ▲
        </button>
        <button
          type="button"
          onClick={(e) => {
             e.preventDefault();
             handleStep(-1);
          }}
          disabled={disabled}
          className="flex h-3.5 w-5 items-center justify-center rounded-sm bg-gray-100 text-gray-500 hover:bg-gray-200 hover:text-gray-700 disabled:opacity-50 text-[10px]"
        >
          ▼
        </button>
      </div>
    </div>
  );
}

function InlineInput({
  value,
  onChange,
  onCommit,
  disabled,
  placeholder,
  className,
  type = 'text',
}: {
  value: string;
  onChange: (value: string) => void;
  onCommit?: (value: string) => void;
  disabled?: boolean;
  placeholder?: string;
  className?: string;
  type?: string;
}) {
  return (
    <input
      type={type}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      onBlur={(e) => onCommit?.(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.currentTarget.blur();
        }
      }}
      disabled={disabled}
      placeholder={placeholder}
      className={`w-full rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm text-gray-900 placeholder-gray-400 focus:border-blue-500 focus:ring-2 focus:ring-blue-500/20 outline-none transition-all disabled:bg-gray-50 disabled:text-gray-500 disabled:cursor-not-allowed ${className || ''}`}
    />
  );
}

function InlineTextarea({
  value,
  onChange,
  onCommit,
  disabled,
  placeholder,
  rows = 2,
  className,
}: {
  value: string;
  onChange: (value: string) => void;
  onCommit?: (value: string) => void;
  disabled?: boolean;
  placeholder?: string;
  rows?: number;
  className?: string;
}) {
  return (
    <textarea
      rows={rows}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      onBlur={(e) => onCommit?.(e.target.value)}
      disabled={disabled}
      placeholder={placeholder}
      className={`w-full resize-none rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm text-gray-900 placeholder-gray-400 focus:border-blue-500 focus:ring-2 focus:ring-blue-500/20 outline-none transition-all disabled:bg-gray-50 disabled:text-gray-500 disabled:cursor-not-allowed ${className || ''}`}
    />
  );
}

function InlineSelect({
  value,
  onChange,
  options,
  disabled,
  className,
}: {
  value: string;
  onChange: (value: string) => void;
  options: string[];
  disabled?: boolean;
  className?: string;
}) {
  return (
    <div className="relative">
      <select
        value={value || ''}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled}
        className={`w-full appearance-none rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm text-gray-900 focus:border-blue-500 focus:ring-2 focus:ring-blue-500/20 outline-none transition-all disabled:bg-gray-50 disabled:text-gray-500 disabled:cursor-not-allowed ${className || ''}`}
      >
        <option value="">Не выбрано</option>
        {options.map((option) => (
          <option key={option} value={option}>
            {option}
          </option>
        ))}
      </select>
      <div className="pointer-events-none absolute inset-y-0 right-0 flex items-center px-2 text-gray-500 text-xs">
        ▼
      </div>
    </div>
  );
}

type InfoItemProps = {
  label: string;
  value?: string | null;
  href?: string | null;
  className?: string;
  valueClassName?: string;
};

function InfoItem({ label, value, href, className, valueClassName }: InfoItemProps) {
  const displayValue = value?.trim();
  const containerClassName = `flex flex-col gap-1 min-w-0${className ? ` ${className}` : ''}`;
  const baseValueClassName = valueClassName
    ? `text-sm ${valueClassName}`
    : 'text-sm text-gray-900';

  return (
    <div className={containerClassName}>
      <span className="text-[11px] uppercase tracking-wide text-gray-400">{label}</span>
      {displayValue ? (
        href ? (
          <a
            href={href}
            target="_blank"
            rel="noreferrer"
            className={`${baseValueClassName} text-blue-600 hover:underline`}
          >
            {displayValue}
          </a>
        ) : (
          <span className={baseValueClassName}>{displayValue}</span>
        )
      ) : (
        <span className="text-sm text-gray-400">—</span>
      )}
    </div>
  );
}

// Project Card Component
function ProjectCard({ 
  project, 
  onStatusChange,
  openMenuId,
  setOpenMenuId,
  onDeleteRequest,
  canDelete,
}: { 
  project: Project; 
  onStatusChange: (id: string, status: string) => void;
  openMenuId: string | null;
  setOpenMenuId: (id: string | null) => void;
  onDeleteRequest?: (id: string) => void;
  canDelete?: boolean;
}) {
  const isTma = useIsTma();
  const statusConfig = getStatusConfig(project.status);
  const deadlineStatus = getDeadlineStatus(project.deadline);
  const isMenuOpen = openMenuId === project.id;
  const platformConfig = getPlatformConfig(project.work_format);
  const kpiValue = getKpiValue(project);
  const commentValue = getCommentValue(project);
  const deadlineLabel = project.deadline ? formatDate(project.deadline) : '';
  const contractHref = normalizeUrl(project.contract_link);
  const handoffHref = normalizeUrl(project.handoff_link);
  const cardTitle = project.client || 'Без названия';
  const cardServices = parseServices(project.name);

  const deadlineClassName =
    deadlineStatus === 'overdue'
      ? 'inline-flex items-center rounded-full bg-red-100 px-2.5 py-1 text-xs font-semibold text-red-700'
      : deadlineStatus === 'soon'
        ? 'inline-flex items-center rounded-full bg-amber-100 px-2.5 py-1 text-xs font-semibold text-amber-700'
        : 'inline-flex items-center rounded-full bg-gray-100 px-2.5 py-1 text-xs font-semibold text-gray-700';

  return (
    <div
      className={`bg-white rounded-2xl border ${
        deadlineStatus === 'overdue'
          ? 'border-red-200 ring-2 ring-red-100'
          : deadlineStatus === 'soon'
            ? 'border-amber-200'
            : 'border-gray-200'
      } ${isTma ? 'p-4' : 'p-4 md:p-5'} hover:shadow-md transition-shadow`}
    >
      <div className="flex items-start justify-between gap-3">
        <Link href={`/projects/${project.id}`} className="flex-1 min-w-0">
          <h3 className="text-base font-semibold text-gray-900 hover:text-blue-600 transition-colors truncate">
            {cardTitle}
          </h3>
          {cardServices.length > 0 && (
            <div className="flex flex-wrap gap-1 mt-1">
              {cardServices.map((s) => (
                <span key={s} className="inline-flex items-center bg-blue-50 text-blue-700 text-[10px] font-medium px-1.5 py-0.5 rounded">{s}</span>
              ))}
            </div>
          )}
        </Link>
        <div className="flex items-center gap-2">
          <span className={`inline-flex px-2.5 py-1 rounded-lg text-xs font-medium ${statusConfig.bg} ${statusConfig.color}`}>
            {statusConfig.label}
          </span>
          <div className="relative">
          <button 
            onClick={() => setOpenMenuId(isMenuOpen ? null : project.id)}
            className="p-1.5 rounded-lg hover:bg-gray-100 text-gray-400 font-bold"
          >
            •••
          </button>
          {isMenuOpen && (
            <>
              <div className="fixed inset-0 z-10" onClick={() => setOpenMenuId(null)} />
              <div className="absolute right-0 top-8 z-20 w-48 bg-white rounded-xl shadow-xl border border-gray-200 py-1">
                <Link 
                  href={`/projects/${project.id}`}
                  className="flex items-center px-3 py-2 text-sm text-gray-700 hover:bg-gray-50"
                >
                  Открыть
                </Link>
                <Link 
                    href={`/projects/${project.id}?mode=edit`}
                  className="flex items-center px-3 py-2 text-sm text-gray-700 hover:bg-gray-50"
                >
                  Редактировать
                </Link>
                <div className="border-t border-gray-100 my-1" />
                <div className="px-3 py-1 text-xs text-gray-400 uppercase">Статус</div>
                {Object.entries(STATUS_CONFIG).map(([key, config]) => (
                  <button
                    key={key}
                    onClick={() => onStatusChange(project.id, config.label)}
                    className="w-full flex items-center px-3 py-2 text-sm text-gray-700 hover:bg-gray-50"
                  >
                    <span className={`w-2 h-2 rounded-full mr-2 ${config.bg.replace('-50', '-500')}`} />
                    {config.label}
                  </button>
                ))}
                {canDelete && onDeleteRequest && (
                  <>
                    <div className="border-t border-gray-100 my-1" />
                    <button
                      onClick={() => onDeleteRequest(project.id)}
                      className="w-full flex items-center px-3 py-2 text-sm text-red-600 hover:bg-red-50"
                    >
                      <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4 mr-2" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" /></svg>
                      Удалить
                    </button>
                  </>
                )}
              </div>
            </>
          )}
        </div>
      </div>
      </div>

      <div className={`mt-4 grid grid-cols-1 gap-4 ${isTma ? '' : 'md:grid-cols-2 xl:grid-cols-4'}`}>
        <InfoItem label="Сумма договора" value={project.budget} />
        <InfoItem
          label="Дедлайн"
          value={deadlineLabel}
          valueClassName={deadlineClassName}
        />
        <InfoItem
          label="Специалист"
          value={project.specialist}
          valueClassName="inline-flex items-center rounded-full bg-sky-100 px-2.5 py-1 text-xs font-semibold text-sky-800"
        />
        <InfoItem
          label="Лид"
          value={project.manager}
          valueClassName="inline-flex items-center rounded-full bg-lime-100 px-2.5 py-1 text-xs font-semibold text-lime-800"
        />
        {!isTma && (
          <>
            <InfoItem label="Маржа" value={project.margin} />
            <InfoItem label="KPI" value={kpiValue} />
            <InfoItem
              label="Ссылка на договор"
              value={contractHref ? formatUrlLabel(contractHref) : ''}
              href={contractHref}
            />
            <InfoItem
              label="Ссылка на передачу"
              value={handoffHref ? formatUrlLabel(handoffHref) : ''}
              href={handoffHref}
            />
            <InfoItem
              label="Где ведется проект"
              value={platformConfig?.label}
              valueClassName={
                platformConfig?.className
                  ? `inline-flex items-center rounded-full px-2.5 py-1 text-xs font-semibold ${platformConfig.className}`
                  : undefined
              }
            />
            <InfoItem
              label="Комментарий"
              value={commentValue}
              className="md:col-span-2 xl:col-span-4"
              valueClassName="text-gray-700 break-words"
            />
          </>
        )}
          </div>
    </div>
  );
}

// Kanban Card Component
function KanbanCard({ 
  project,
  onStatusChange,
  columns,
  onDeleteRequest,
  canDelete,
}: { 
  project: Project;
  onStatusChange: (id: string, status: string) => void;
  columns: Array<{ key: string; label: string }>;
  onDeleteRequest?: (id: string) => void;
  canDelete?: boolean;
}) {
  const [showMenu, setShowMenu] = useState(false);
  const deadlineStatus = getDeadlineStatus(project.deadline);

  return (
    <div className={`bg-white rounded-lg border ${
      deadlineStatus === 'overdue' ? 'border-red-200' :
      deadlineStatus === 'soon' ? 'border-amber-200' :
      'border-gray-200'
    } p-3 shadow-sm hover:shadow-md transition-shadow cursor-pointer group`}>
      <div className="flex items-start justify-between">
        <Link href={`/projects/${project.id}`} className="flex-1 min-w-0">
          <h4 className="text-sm font-medium text-gray-900 group-hover:text-blue-600 truncate">
            {project.client || 'Без названия'}
          </h4>
          {project.name && (
            <div className="flex flex-wrap gap-1 mt-0.5">
              {parseServices(project.name).map((s) => (
                <span key={s} className="inline-flex items-center bg-blue-50 text-blue-700 text-[9px] font-medium px-1 py-0.5 rounded">{s}</span>
              ))}
            </div>
          )}
        </Link>
        <div className="relative">
          <button 
            onClick={(e) => { e.stopPropagation(); setShowMenu(!showMenu); }}
            className="p-1 rounded hover:bg-gray-100 opacity-0 group-hover:opacity-100 transition-opacity font-bold text-xs text-gray-400"
          >
            •••
          </button>
          {showMenu && (
            <>
              <div className="fixed inset-0 z-10" onClick={() => setShowMenu(false)} />
              <div className="absolute right-0 top-6 z-20 w-36 bg-white rounded-lg shadow-lg border border-gray-200 py-1">
                {columns.map((col) => (
                  <button
                    key={col.key}
                    onClick={() => { onStatusChange(project.id, col.label); setShowMenu(false); }}
                    className="w-full text-left px-3 py-1.5 text-xs text-gray-700 hover:bg-gray-50"
                  >
                    {col.label}
                  </button>
                ))}
                {canDelete && onDeleteRequest && (
                  <>
                    <div className="border-t border-gray-100 my-1" />
                    <button
                      onClick={() => { onDeleteRequest(project.id); setShowMenu(false); }}
                      className="w-full text-left px-3 py-1.5 text-xs text-red-600 hover:bg-red-50"
                    >
                      Удалить
                    </button>
                  </>
                )}
              </div>
            </>
          )}
        </div>
      </div>
      
      <div className="mt-2 flex items-center gap-2 text-xs text-gray-500">
        {project.manager && (
          <span className="flex items-center">
            {project.manager.split(' ')[0]}
          </span>
        )}
        {project.deadline && (
          <span className={`flex items-center ${
            deadlineStatus === 'overdue' ? 'text-red-600' :
            deadlineStatus === 'soon' ? 'text-amber-600' : ''
          }`}>
            {formatDate(project.deadline)}
          </span>
        )}
      </div>
    </div>
  );
}
