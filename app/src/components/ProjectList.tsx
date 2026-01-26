'use client';

import { useState, useEffect } from 'react';
import { Project, ProjectStatus, UserRole } from '@/types';
import { supabase } from '@/lib/supabaseClient';
import { 
  Search, Plus, Calendar, DollarSign, User, Loader2, FolderKanban, 
  AlertTriangle, Clock, LayoutGrid, List, Columns3, ChevronDown,
  MoreHorizontal, Edit2, Trash2, Archive, Eye
} from 'lucide-react';
import Link from 'next/link';
import { getCurrentUserRole, canCreateProjects, canEditProjects } from '@/lib/roles';

type ViewMode = 'table' | 'cards' | 'kanban';

const STATUS_CONFIG: Record<string, { label: string; color: string; bg: string; border: string }> = {
  'в работе': { label: 'В работе', color: 'text-emerald-700', bg: 'bg-emerald-50', border: 'border-emerald-200' },
  'тестирование': { label: 'Тестирование', color: 'text-blue-700', bg: 'bg-blue-50', border: 'border-blue-200' },
  'на паузе': { label: 'На паузе', color: 'text-amber-700', bg: 'bg-amber-50', border: 'border-amber-200' },
  'подготовка': { label: 'Подготовка', color: 'text-purple-700', bg: 'bg-purple-50', border: 'border-purple-200' },
  'завершен': { label: 'Завершён', color: 'text-gray-600', bg: 'bg-gray-100', border: 'border-gray-200' },
  'отменен': { label: 'Отменён', color: 'text-red-700', bg: 'bg-red-50', border: 'border-red-200' },
};

function getStatusConfig(status: string | null | undefined) {
  if (!status) return STATUS_CONFIG['в работе'];
  const key = status.toLowerCase();
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

export function ProjectList() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchTerm, setSearchTerm] = useState('');
  const [viewMode, setViewMode] = useState<ViewMode>('cards');
  const [statusFilter, setStatusFilter] = useState<string>('all');
  const [openMenuId, setOpenMenuId] = useState<number | null>(null);
  const [userRole, setUserRole] = useState<UserRole | null>(null);
  const [canCreate, setCanCreate] = useState(false);
  const [canEdit, setCanEdit] = useState(false);

  useEffect(() => {
    fetchProjects();
    checkPermissions();
  }, []);

  async function checkPermissions() {
    const role = await getCurrentUserRole();
    setUserRole(role);
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

  async function updateProjectStatus(id: number, newStatus: string) {
    try {
      const { error } = await supabase
        .from('projects')
        .update({ status: newStatus })
        .eq('id', id);
      
      if (error) throw error;
      
      setProjects(prev => prev.map(p => 
        p.id === id ? { ...p, status: newStatus as ProjectStatus } : p
      ));
    } catch (error) {
      console.error('Error updating status:', error);
    }
    setOpenMenuId(null);
  }

  const filteredProjects = projects.filter(project => {
    const matchesSearch = 
      (project.name?.toLowerCase().includes(searchTerm.toLowerCase())) ||
      (project.manager?.toLowerCase().includes(searchTerm.toLowerCase())) ||
      (project.specialist?.toLowerCase().includes(searchTerm.toLowerCase()));
    
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

  if (loading) {
    return (
      <div className="flex h-64 items-center justify-center">
        <Loader2 className="h-8 w-8 animate-spin text-blue-500" />
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
        <div className={`rounded-xl p-4 ${overdueCount > 0 ? 'bg-gradient-to-r from-red-50 to-orange-50 border border-red-200' : 'bg-gradient-to-r from-amber-50 to-yellow-50 border border-amber-200'}`}>
          <div className="flex items-center">
            <div className={`p-2 rounded-lg ${overdueCount > 0 ? 'bg-red-100' : 'bg-amber-100'}`}>
              <AlertTriangle className={`h-5 w-5 ${overdueCount > 0 ? 'text-red-600' : 'text-amber-600'}`} />
            </div>
            <div className="ml-3">
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
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Проекты</h1>
          <p className="text-sm text-gray-500">{projects.length} проектов</p>
        </div>
        {canCreate && (
          <Link 
            href="/projects/new"
            className="inline-flex items-center justify-center rounded-xl bg-blue-600 px-5 py-2.5 text-sm font-medium text-white shadow-lg shadow-blue-500/30 hover:bg-blue-700 transition-all hover:shadow-blue-500/40 hover:scale-[1.02]"
          >
            <Plus className="mr-2 h-4 w-4" />
            Новый проект
          </Link>
        )}
      </div>

      {/* Controls */}
      <div className="flex flex-col lg:flex-row gap-4">
        {/* Search */}
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-5 w-5 text-gray-400" />
          <input
            type="text"
            className="w-full rounded-xl border border-gray-200 bg-white py-2.5 pl-10 pr-4 text-sm focus:border-blue-500 focus:ring-2 focus:ring-blue-500/20 outline-none transition-all"
            placeholder="Поиск по названию, менеджеру..."
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
          />
        </div>

        {/* View Toggle */}
        <div className="flex items-center bg-gray-100 rounded-xl p-1">
          <button
            onClick={() => setViewMode('cards')}
            className={`flex items-center px-3 py-2 rounded-lg text-sm font-medium transition-all ${
              viewMode === 'cards' ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500 hover:text-gray-700'
            }`}
          >
            <LayoutGrid className="h-4 w-4 mr-1.5" />
            Карточки
          </button>
          <button
            onClick={() => setViewMode('kanban')}
            className={`flex items-center px-3 py-2 rounded-lg text-sm font-medium transition-all ${
              viewMode === 'kanban' ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500 hover:text-gray-700'
            }`}
          >
            <Columns3 className="h-4 w-4 mr-1.5" />
            Канбан
          </button>
          <button
            onClick={() => setViewMode('table')}
            className={`flex items-center px-3 py-2 rounded-lg text-sm font-medium transition-all ${
              viewMode === 'table' ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500 hover:text-gray-700'
            }`}
          >
            <List className="h-4 w-4 mr-1.5" />
            Таблица
          </button>
        </div>
      </div>

      {/* Status Filter Tabs */}
      {viewMode !== 'kanban' && (
        <div className="flex items-center gap-2 overflow-x-auto pb-2">
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
              className={`flex items-center px-4 py-2 rounded-full text-sm font-medium whitespace-nowrap transition-all ${
                statusFilter === tab.key
                  ? 'bg-gray-900 text-white'
                  : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
              }`}
            >
              {tab.label}
              <span className={`ml-2 px-1.5 py-0.5 rounded-full text-xs ${
                statusFilter === tab.key ? 'bg-white/20' : 'bg-gray-200'
              }`}>
                {statusCounts[tab.key as keyof typeof statusCounts] || 0}
              </span>
            </button>
          ))}
        </div>
      )}

      {/* Empty State */}
      {filteredProjects.length === 0 && (
        <div className="text-center py-16 bg-white rounded-2xl border-2 border-dashed border-gray-200">
          <FolderKanban className="mx-auto h-12 w-12 text-gray-300" />
          <h3 className="mt-4 text-lg font-medium text-gray-900">Нет проектов</h3>
          <p className="mt-2 text-sm text-gray-500">
            {searchTerm ? 'Попробуйте изменить поиск' : 'Создайте первый проект или импортируйте данные'}
          </p>
          {canCreate && (
            <Link 
              href="/projects/new"
              className="mt-4 inline-flex items-center text-sm font-medium text-blue-600 hover:text-blue-700"
            >
              <Plus className="mr-1 h-4 w-4" />
              Создать проект
            </Link>
          )}
        </div>
      )}

      {/* Cards View */}
      {viewMode === 'cards' && filteredProjects.length > 0 && (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
          {filteredProjects.map((project) => (
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
              className="flex-shrink-0 w-72 bg-gray-50 rounded-xl p-3"
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
        <div className="overflow-hidden rounded-xl border border-gray-200 bg-white">
          <table className="min-w-full divide-y divide-gray-200">
            <thead className="bg-gray-50">
              <tr>
                <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-gray-500">Проект</th>
                <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-gray-500">Статус</th>
                <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-gray-500">Менеджер</th>
                <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-gray-500">Дедлайн</th>
                <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-gray-500">KPI</th>
                <th className="px-4 py-3"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {filteredProjects.map((project) => {
                const statusConfig = getStatusConfig(project.status);
                const deadlineStatus = getDeadlineStatus(project.deadline);
                return (
                  <tr key={project.id} className="hover:bg-gray-50 transition-colors">
                    <td className="px-4 py-3">
                      <Link href={`/projects/${project.id}`} className="font-medium text-gray-900 hover:text-blue-600">
                        {project.name}
                      </Link>
                      {project.budget && (
                        <p className="text-xs text-gray-400 mt-0.5">{project.budget}</p>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      <span className={`inline-flex px-2.5 py-1 rounded-lg text-xs font-medium ${statusConfig.bg} ${statusConfig.color}`}>
                        {statusConfig.label}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-sm text-gray-600">{project.manager || '—'}</td>
                    <td className="px-4 py-3">
                      {project.deadline ? (
                        <span className={`inline-flex items-center text-sm ${
                          deadlineStatus === 'overdue' ? 'text-red-600 font-medium' :
                          deadlineStatus === 'soon' ? 'text-amber-600 font-medium' :
                          'text-gray-600'
                        }`}>
                          {deadlineStatus === 'overdue' && <AlertTriangle className="h-3.5 w-3.5 mr-1" />}
                          {deadlineStatus === 'soon' && <Clock className="h-3.5 w-3.5 mr-1" />}
                          {formatDate(project.deadline)}
                        </span>
                      ) : (
                        <span className="text-gray-400">—</span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-sm text-gray-600">{project.kpi_fact || '—'}</td>
                    <td className="px-4 py-3">
                      <Link 
                        href={`/projects/${project.id}`}
                        className="p-1.5 rounded-lg hover:bg-gray-100 text-gray-400 hover:text-gray-600 inline-flex"
                      >
                        <Edit2 className="h-4 w-4" />
                      </Link>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// Project Card Component
function ProjectCard({ 
  project, 
  onStatusChange,
  openMenuId,
  setOpenMenuId
}: { 
  project: Project; 
  onStatusChange: (id: number, status: string) => void;
  openMenuId: number | null;
  setOpenMenuId: (id: number | null) => void;
}) {
  const statusConfig = getStatusConfig(project.status);
  const deadlineStatus = getDeadlineStatus(project.deadline);
  const isMenuOpen = openMenuId === project.id;

  return (
    <div className={`bg-white rounded-xl border ${
      deadlineStatus === 'overdue' ? 'border-red-200 ring-2 ring-red-100' :
      deadlineStatus === 'soon' ? 'border-amber-200' :
      'border-gray-200'
    } p-4 hover:shadow-lg transition-all group`}>
      {/* Header */}
      <div className="flex items-start justify-between mb-3">
        <Link href={`/projects/${project.id}`} className="flex-1 min-w-0">
          <h3 className="font-semibold text-gray-900 group-hover:text-blue-600 transition-colors truncate">
            {project.name}
          </h3>
        </Link>
        <div className="relative ml-2">
          <button 
            onClick={() => setOpenMenuId(isMenuOpen ? null : project.id)}
            className="p-1.5 rounded-lg hover:bg-gray-100 text-gray-400"
          >
            <MoreHorizontal className="h-4 w-4" />
          </button>
          {isMenuOpen && (
            <>
              <div className="fixed inset-0 z-10" onClick={() => setOpenMenuId(null)} />
              <div className="absolute right-0 top-8 z-20 w-48 bg-white rounded-xl shadow-xl border border-gray-200 py-1">
                <Link 
                  href={`/projects/${project.id}`}
                  className="flex items-center px-3 py-2 text-sm text-gray-700 hover:bg-gray-50"
                >
                  <Eye className="h-4 w-4 mr-2 text-gray-400" />
                  Открыть
                </Link>
                <Link 
                  href={`/projects/${project.id}`}
                  className="flex items-center px-3 py-2 text-sm text-gray-700 hover:bg-gray-50"
                >
                  <Edit2 className="h-4 w-4 mr-2 text-gray-400" />
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

      {/* Status Badge */}
      <div className="mb-3">
        <span className={`inline-flex px-2.5 py-1 rounded-lg text-xs font-medium ${statusConfig.bg} ${statusConfig.color}`}>
          {statusConfig.label}
        </span>
        {deadlineStatus === 'overdue' && (
          <span className="ml-2 inline-flex items-center px-2 py-1 rounded-lg text-xs font-medium bg-red-100 text-red-700">
            <AlertTriangle className="h-3 w-3 mr-1" />
            Просрочен
          </span>
        )}
        {deadlineStatus === 'soon' && (
          <span className="ml-2 inline-flex items-center px-2 py-1 rounded-lg text-xs font-medium bg-amber-100 text-amber-700">
            <Clock className="h-3 w-3 mr-1" />
            Скоро
          </span>
        )}
      </div>

      {/* Info */}
      <div className="space-y-2 text-sm">
        {project.manager && (
          <div className="flex items-center text-gray-600">
            <User className="h-4 w-4 mr-2 text-gray-400" />
            <span className="truncate">{project.manager}</span>
          </div>
        )}
        {project.deadline && (
          <div className={`flex items-center ${
            deadlineStatus === 'overdue' ? 'text-red-600' :
            deadlineStatus === 'soon' ? 'text-amber-600' :
            'text-gray-600'
          }`}>
            <Calendar className="h-4 w-4 mr-2 opacity-60" />
            <span>{formatDate(project.deadline)}</span>
          </div>
        )}
        {project.budget && (
          <div className="flex items-center text-gray-600">
            <DollarSign className="h-4 w-4 mr-2 text-gray-400" />
            <span>{project.budget}</span>
          </div>
        )}
      </div>

      {/* Tasks preview */}
      {project.weekly_tasks && (
        <div className="mt-3 pt-3 border-t border-gray-100">
          <p className="text-xs text-gray-500 line-clamp-2">{project.weekly_tasks}</p>
        </div>
      )}
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
  onStatusChange: (id: number, status: string) => void;
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
            className="p-1 rounded hover:bg-gray-100 opacity-0 group-hover:opacity-100 transition-opacity"
          >
            <MoreHorizontal className="h-3.5 w-3.5 text-gray-400" />
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
            <User className="h-3 w-3 mr-1" />
            {project.manager.split(' ')[0]}
          </span>
        )}
        {project.deadline && (
          <span className={`flex items-center ${
            deadlineStatus === 'overdue' ? 'text-red-600' :
            deadlineStatus === 'soon' ? 'text-amber-600' : ''
          }`}>
            {deadlineStatus === 'overdue' ? <AlertTriangle className="h-3 w-3 mr-1" /> : <Calendar className="h-3 w-3 mr-1" />}
            {formatDate(project.deadline)}
          </span>
        )}
      </div>
    </div>
  );
}
