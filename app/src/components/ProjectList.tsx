'use client';

import { useState, useEffect } from 'react';
import { Project, ProjectStatus } from '@/types';
import { supabase } from '@/lib/supabaseClient';
import Link from 'next/link';
import { getCurrentUserRole, canCreateProjects, canEditProjects } from '@/lib/roles';

type ViewMode = 'table' | 'cards' | 'kanban';

const WORK_FORMAT_OPTIONS = ['Колди', 'Тригга', 'Инстантли'];

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
  const [projects, setProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchTerm, setSearchTerm] = useState('');
  const [viewMode] = useState<ViewMode>('table');
  const [statusFilter, setStatusFilter] = useState<string>('all');
  const [openMenuId, setOpenMenuId] = useState<string | null>(null);
  const [canCreate, setCanCreate] = useState(false);
  const [canEdit, setCanEdit] = useState(false);
  const [drafts, setDrafts] = useState<Record<string, Partial<Project>>>({});
  const [savingRows, setSavingRows] = useState<Record<string, boolean>>({});
  const [isTableEditing, setIsTableEditing] = useState(false);
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);

  useEffect(() => {
    fetchProjects();
    checkPermissions();
  }, []);

  async function checkPermissions() {
    const role = await getCurrentUserRole();
    setCanCreate(canCreateProjects(role));
    setCanEdit(canEditProjects(role));
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
      console.error('Error fetching projects:', error);
    } finally {
      setLoading(false);
    }
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
    } catch (error) {
      console.error('Error updating status:', error);
    }
    setOpenMenuId(null);
  }

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
    } catch (error) {
      console.error('Error updating project:', error);
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
        project.name,
        project.description,
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
    <div className="space-y-4">
      {/* Deadline Alert */}
      {(overdueCount > 0 || soonCount > 0) && (
        <div className={`rounded-xl p-4 ${overdueCount > 0 ? 'bg-red-50 border border-red-100' : 'bg-amber-50 border border-amber-100'}`}>
          <div className="flex items-center">
            <div className="ml-1">
              <p className={`text-sm font-medium ${overdueCount > 0 ? 'text-red-800' : 'text-amber-800'}`}>
                {overdueCount > 0 && <span>🔴 {overdueCount} просрочено</span>}
                {overdueCount > 0 && soonCount > 0 && ' · '}
                {soonCount > 0 && <span>🟠 {soonCount} скоро дедлайн</span>}
              </p>
            </div>
          </div>
        </div>
      )}

      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-6 pb-2">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-gray-900">Проекты</h1>
          <p className="mt-1 text-sm text-gray-500 font-medium">{projects.length} проектов</p>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          {canEdit && (
            <button
              type="button"
              onClick={() => void handleToggleEditing()}
              className={`inline-flex items-center justify-center rounded-lg px-4 py-2 text-sm font-medium transition-all duration-200 border ${
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
              className="inline-flex items-center justify-center rounded-lg bg-gray-900 px-4 py-2 text-sm font-medium text-white shadow-sm hover:bg-gray-800 transition-all duration-200"
          >
            Новый проект
          </Link>
        )}
        </div>
      </div>

      {/* Controls */}
      <div className="flex flex-col lg:flex-row gap-4 items-center bg-white p-2 rounded-xl shadow-sm border border-gray-200">
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
          <div className="flex items-center gap-1 overflow-x-auto no-scrollbar border-l border-gray-100 pl-4 py-1">
          {[
            { key: 'all', label: 'Все' },
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

      {/* Cards View */}
      {viewMode === 'cards' && filteredProjects.length > 0 && (
        <div className="space-y-4">
          {sortedProjects.map((project) => (
            <ProjectCard 
              key={project.id} 
              project={project} 
              onStatusChange={updateProjectStatus}
              openMenuId={openMenuId}
              setOpenMenuId={setOpenMenuId}
            />
          ))}
        </div>
      )}

      {/* Kanban View */}
      {viewMode === 'kanban' && (
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
                  />
                ))}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Table View */}
      {viewMode === 'table' && filteredProjects.length > 0 && (
        <div className="relative overflow-hidden rounded-xl border border-gray-200 bg-white shadow-sm">
          <div className="overflow-x-auto max-h-[calc(100vh-220px)]">
            <table className="min-w-full divide-y divide-gray-100 text-sm">
              <thead className="bg-gray-50 sticky top-0 z-10">
                <tr>
                  <th className="px-4 py-3.5 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">Проект</th>
                  <th className="px-4 py-3.5 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">Описание услуги</th>
                  <th className="px-4 py-3.5 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">Сумма</th>
                  <th className="px-4 py-3.5 text-center text-xs font-semibold text-gray-500 uppercase tracking-wider">Договор</th>
                  <th className="px-4 py-3.5 text-center text-xs font-semibold text-gray-500 uppercase tracking-wider">Передача</th>
                  <th className="px-4 py-3.5 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">Дедлайн</th>
                  <th className="px-4 py-3.5 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">KPI План</th>
                  <th className="px-4 py-3.5 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">KPI Факт</th>
                  <th className="px-4 py-3.5 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">Специалист</th>
                  <th className="px-4 py-3.5 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">Лид (PM)</th>
                  <th className="px-4 py-3.5 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">Комментарий</th>
                  <th className="px-4 py-3.5 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider whitespace-nowrap">Формат</th>
              </tr>
            </thead>
              <tbody className="divide-y divide-gray-50 bg-white">
                {sortedProjects.map((project) => {
                  const isSaving = Boolean(savingRows[project.id]);
                  const isDisabled = !canEdit || isSaving;
                  const nameValue = getDraftValue(project, 'name');
                  const descriptionValue = getDraftValue(project, 'description');
                  const budgetValue = getDraftValue(project, 'budget');
                  const contractValue = getDraftValue(project, 'contract_link');
                  const handoffValue = getDraftValue(project, 'handoff_link');
                  const deadlineValue = getDraftValue(project, 'deadline');
                  const kpiValue = getDraftValue(project, 'kpi_plan');
                  const kpiFactValue = getDraftValue(project, 'kpi_fact');
                  const specialistValue = getDraftValue(project, 'specialist');
                  const managerValue = getDraftValue(project, 'manager');
                  const commentsValue = getDraftValue(project, 'comments');
                  const workFormatValue = resolveWorkFormat(getDraftValue(project, 'work_format'));
                  const contractHref = normalizeUrl(project.contract_link);
                  const handoffHref = normalizeUrl(project.handoff_link);
                  const platformConfig = getPlatformConfig(project.work_format);
                  const readOnlyName = project.name || '—';
                  const readOnlyDescription = project.description || '—';
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
                            className="text-left font-medium text-gray-900 hover:text-blue-600 transition-colors flex items-start gap-2 group/btn"
                          >
                            <span className="break-words">{readOnlyName}</span>
                            <span className="opacity-0 group-hover/btn:opacity-100 transition-opacity text-gray-400 mt-1 flex-shrink-0 text-xs">↗</span>
                          </button>
                      )}
                    </td>
                      <td className="px-4 py-3 align-top min-w-[180px]">
                        {isTableEditing ? (
                          <InlineTextarea
                            value={descriptionValue}
                            onChange={(value) => setDraftValue(project.id, 'description', value)}
                            onCommit={(value) => void commitProjectUpdate(project, { description: value })}
                            disabled={isDisabled}
                            placeholder="Описание услуги"
                            rows={2}
                          />
                        ) : (
                          <span className="text-gray-600 line-clamp-3 leading-relaxed break-words text-xs" title={readOnlyDescription}>{readOnlyDescription}</span>
                        )}
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
                        ) : (
                          <div className="flex items-center text-gray-600">
                             <span>{readOnlyDeadline}</span>
                          </div>
                        )}
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
                      <td className="px-4 py-3 align-top whitespace-nowrap w-[120px]">
                        {isTableEditing ? (
                          <InlineStepper
                            value={kpiFactValue}
                            onChange={(value) => setDraftValue(project.id, 'kpi_fact', value)}
                            onCommit={(value) => void commitProjectUpdate(project, { kpi_fact: value })}
                            disabled={isDisabled}
                            placeholder="Факт"
                          />
                        ) : (
                          <span className="text-gray-900">{readOnlyKpiFact}</span>
                        )}
                      </td>
                      <td className="px-4 py-3 align-top whitespace-nowrap">
                        {isTableEditing ? (
                          <InlineInput
                            value={specialistValue}
                            onChange={(value) => setDraftValue(project.id, 'specialist', value)}
                            onCommit={(value) => void commitProjectUpdate(project, { specialist: value })}
                            disabled={isDisabled}
                            placeholder="Специалист"
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
                          <InlineInput
                            value={managerValue}
                            onChange={(value) => setDraftValue(project.id, 'manager', value)}
                            onCommit={(value) => void commitProjectUpdate(project, { manager: value })}
                            disabled={isDisabled}
                            placeholder="Лид (PM)"
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
                      <td className="px-4 py-3 align-top min-w-[160px]">
                        {isTableEditing ? (
                          <InlineTextarea
                            value={commentsValue}
                            onChange={(value) => setDraftValue(project.id, 'comments', value)}
                            onCommit={(value) => void commitProjectUpdate(project, { comments: value })}
                            disabled={isDisabled}
                            placeholder="Комментарий"
                            rows={2}
                          />
                        ) : (
                          <span className="text-gray-500 text-xs leading-relaxed line-clamp-3 break-words">{readOnlyComment}</span>
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
                  </tr>
                );
              })}
            </tbody>
          </table>
          </div>
        </div>
      )}

      {selectedProject && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 sm:p-6">
          <div
            className="absolute inset-0 bg-gray-900/30 backdrop-blur-sm transition-opacity"
            onClick={() => setSelectedProjectId(null)}
          />
          <div className="relative w-full max-w-4xl max-h-[90vh] overflow-y-auto rounded-3xl bg-white shadow-2xl ring-1 ring-gray-900/5 flex flex-col">
            <div className="flex items-start justify-between border-b border-gray-100 px-8 py-6 sticky top-0 bg-white/95 backdrop-blur z-20 transition-all">
              <div className="flex-1 pr-8">
                <div className="flex items-center gap-3 mb-2">
                  <h2 className="text-2xl font-bold text-gray-900 leading-tight">
                    {selectedProject.name || 'Без названия'}
                  </h2>
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
              <button
                type="button"
                onClick={() => setSelectedProjectId(null)}
                className="group relative rounded-full p-2 text-gray-400 hover:bg-gray-100 hover:text-gray-500 transition-all text-xl leading-none"
              >
                &times;
              </button>
            </div>

            <div className="p-8 space-y-10 bg-white min-h-[500px]">
              
              <section className="grid grid-cols-1 md:grid-cols-2 gap-8">
                <div className="bg-gray-50 rounded-2xl p-5 border border-gray-200 transition-colors group hover:bg-gray-100/50">
                  <div className="flex items-center gap-3 mb-3">
                    <label className="text-sm font-bold text-gray-700 tracking-wide uppercase">Специалист</label>
                  </div>
                  <InlineInput
                    value={getDraftValue(selectedProject, 'specialist')}
                    onChange={(value) => setDraftValue(selectedProject.id, 'specialist', value)}
                    onCommit={(value) => void commitProjectUpdate(selectedProject, { specialist: value })}
                    disabled={!canEdit || Boolean(savingRows[selectedProject.id])}
                    placeholder="Не назначен"
                    className="bg-white border border-gray-300 shadow-sm focus:border-blue-500 px-3 py-2 text-sm font-medium rounded-lg text-gray-900 placeholder:text-gray-400"
                  />
                </div>
                
                <div className="bg-gray-50 rounded-2xl p-5 border border-gray-200 transition-colors group hover:bg-gray-100/50">
                  <div className="flex items-center gap-3 mb-3">
                    <label className="text-sm font-bold text-gray-700 tracking-wide uppercase">Лид (PM)</label>
                  </div>
                  <InlineInput
                    value={getDraftValue(selectedProject, 'manager')}
                    onChange={(value) => setDraftValue(selectedProject.id, 'manager', value)}
                    onCommit={(value) => void commitProjectUpdate(selectedProject, { manager: value })}
                    disabled={!canEdit || Boolean(savingRows[selectedProject.id])}
                    placeholder="Не назначен"
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

              <section className="grid grid-cols-1 md:grid-cols-2 gap-6">
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

              <section className="grid grid-cols-1 md:grid-cols-2 gap-8">
                 <div>
                    <h3 className="text-sm font-bold text-gray-600 mb-3 uppercase tracking-wide flex items-center gap-2">
                      Подзадачи
                    </h3>
                    <div className="bg-gray-50 rounded-xl p-4 border border-gray-200 shadow-inner">
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
                 </div>
                 <div>
                    <h3 className="text-sm font-bold text-gray-600 mb-3 uppercase tracking-wide flex items-center gap-2">
                      Комментарий
                    </h3>
                    <div className="bg-gray-50 rounded-xl p-4 border border-gray-200 shadow-inner">
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
            </div>
            
             <div className="bg-gray-50 px-8 py-5 rounded-b-3xl border-t border-gray-100 flex justify-between items-center">
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
}: {
  value: string;
  onChange: (value: string) => void;
  onCommit?: (value: string) => void;
  disabled?: boolean;
  placeholder?: string;
  className?: string;
}) {
  return (
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
}: { 
  project: Project; 
  onStatusChange: (id: string, status: string) => void;
  openMenuId: string | null;
  setOpenMenuId: (id: string | null) => void;
}) {
  const statusConfig = getStatusConfig(project.status);
  const deadlineStatus = getDeadlineStatus(project.deadline);
  const isMenuOpen = openMenuId === project.id;
  const platformConfig = getPlatformConfig(project.work_format);
  const kpiValue = getKpiValue(project);
  const commentValue = getCommentValue(project);
  const deadlineLabel = project.deadline ? formatDate(project.deadline) : '';
  const contractHref = normalizeUrl(project.contract_link);
  const handoffHref = normalizeUrl(project.handoff_link);
  const cardTitle = project.client || project.name || 'Без названия';
  const cardSubtitle =
    project.client && project.name && project.client !== project.name ? project.name : '';

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
      } p-4 md:p-5 hover:shadow-md transition-shadow`}
    >
      <div className="flex items-start justify-between gap-3">
        <Link href={`/projects/${project.id}`} className="flex-1 min-w-0">
          <h3 className="text-base font-semibold text-gray-900 hover:text-blue-600 transition-colors truncate">
            {cardTitle}
          </h3>
          {cardSubtitle && (
            <p className="text-xs text-gray-400 truncate mt-0.5">{cardSubtitle}</p>
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
              </div>
            </>
          )}
        </div>
      </div>
      </div>

      <div className="mt-4 grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-4">
        <InfoItem
          label="Описание услуги"
          value={project.description}
          className="md:col-span-2 xl:col-span-2"
          valueClassName="text-gray-700"
        />
        <InfoItem label="Сумма договора" value={project.budget} />
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
          </div>
    </div>
  );
}

// Kanban Card Component
function KanbanCard({ 
  project,
  onStatusChange,
  columns
}: { 
  project: Project;
  onStatusChange: (id: string, status: string) => void;
  columns: Array<{ key: string; label: string }>;
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
            {project.name}
          </h4>
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
