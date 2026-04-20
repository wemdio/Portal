'use client';

import { useEffect, useState, type ReactNode } from 'react';
import type { Route } from 'next';
import { useParams, usePathname, useRouter, useSearchParams } from 'next/navigation';
import { supabase } from '@/lib/supabaseClient';
import { Project, ProjectStatus, UserProfile } from '@/types';
import Link from 'next/link';
import { canEditProjects } from '@/lib/roles';
import { useUser } from '@/lib/UserProvider';
import { logAudit, logError } from '@/lib/loggerClient';
import { buildAssigneeOptions, ensureCurrentAssigneeOption } from '@/lib/projectAssignees';

const WORK_FORMAT_OPTIONS = ['Колди', 'Тригга', 'Инстантли'];
const LEAD_SOURCE_OPTIONS = ['Аутрич', 'Телеграм', 'Лидскан', 'ЛинкедИн', 'Перфоманс', 'Органика', 'Партнер'];
const SERVICE_OPTIONS = ['Аутрич', 'ТГ аутрич', 'Лидскан', 'ЛинкедИн', 'Перфоманс', 'Ретаргет'];

/** Parse a comma-separated services string into an array */
const parseServices = (value: string | undefined | null): string[] => {
  if (!value) return [];
  return value.split(',').map((s) => s.trim()).filter(Boolean);
};
const PROJECT_TYPE_OPTIONS: { value: string; label: string }[] = [
  { value: 'Продажа', label: 'Продажа (новый клиент)' },
  { value: 'Продление', label: 'Продление' },
];

const parseMaterials = (value: string | null | undefined) => {
  if (!value) return [];
  return value
    .split(/\r?\n|,|;/)
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
};

const normalizeUrl = (value: string) => {
  if (/^https?:\/\//i.test(value)) return value;
  if (/^[\w.-]+\.[a-z]{2,}/i.test(value)) return `https://${value}`;
  return null;
};

const formatUrlLabel = (value: string) =>
  value.replace(/^https?:\/\//i, '').replace(/^www\./i, '');

function SectionCard({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="rounded-xl border border-gray-200 bg-white p-6 shadow-sm">
      <h3 className="text-sm font-semibold uppercase tracking-wide text-gray-400">{title}</h3>
      <div className="mt-3">{children}</div>
    </div>
  );
}

function EditableTile({
  label,
  value,
  onChange,
  disabled,
  placeholder,
  options,
}: {
  label: string;
  value?: string | null;
  onChange: (value: string) => void;
  disabled: boolean;
  placeholder?: string;
  options?: string[];
}) {
  return (
    <div className="rounded-xl border border-gray-200 bg-white p-4 shadow-sm">
      <label className="text-xs uppercase tracking-wide text-gray-400">{label}</label>
      {options ? (
        <select
          value={value || ''}
          onChange={(e) => onChange(e.target.value)}
          disabled={disabled}
          className="mt-2 w-full rounded-md border border-gray-200 px-3 py-2 text-sm text-gray-900 focus:border-blue-500 focus:ring-blue-500 disabled:bg-gray-100 disabled:cursor-not-allowed bg-white"
        >
          <option value="">{placeholder || 'Не выбрано'}</option>
          {options.map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </select>
      ) : (
        <input
          type="text"
          value={value || ''}
          onChange={(e) => onChange(e.target.value)}
          disabled={disabled}
          placeholder={placeholder}
          className="mt-2 w-full rounded-md border border-gray-200 px-3 py-2 text-sm text-gray-900 focus:border-blue-500 focus:ring-blue-500 disabled:bg-gray-100 disabled:cursor-not-allowed"
        />
      )}
    </div>
  );
}

function EditableTextarea({
  value,
  onChange,
  disabled,
  placeholder,
  rows = 4,
}: {
  value?: string | null;
  onChange: (value: string) => void;
  disabled: boolean;
  placeholder?: string;
  rows?: number;
}) {
  return (
    <textarea
      rows={rows}
      value={value || ''}
      onChange={(e) => onChange(e.target.value)}
      disabled={disabled}
      placeholder={placeholder}
      className="w-full rounded-md border border-gray-200 px-3 py-2 text-sm text-gray-900 focus:border-blue-500 focus:ring-blue-500 disabled:bg-gray-100 disabled:cursor-not-allowed"
    />
  );
}

export default function ProjectPage() {
  const params = useParams();
  const id = params?.id as string;
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const isEditing = searchParams.get('mode') === 'edit';
  const { userRole } = useUser();
  
  const [project, setProject] = useState<Project | null>(null);
  const [initialProject, setInitialProject] = useState<Project | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState('');
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [assigneeOptions, setAssigneeOptions] = useState<string[]>([]);
  const [clientUsers, setClientUsers] = useState<Array<{ id: string; label: string }>>([]);

  const canEdit = canEditProjects(userRole);

  useEffect(() => {
    if (id) {
      void fetchProject(id);
      void fetchAssigneeUsers();
      void fetchClientUsers();
    }
  }, [id]);

  async function fetchAssigneeUsers() {
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
    } catch (fetchError) {
      void logError('projects.assignees.fetch.failed', fetchError);
    }
  }

  async function fetchClientUsers() {
    try {
      const { data, error } = await supabase
        .from('profiles')
        .select('id, email, full_name')
        .eq('role', 'client')
        .order('full_name', { ascending: true });

      if (error) throw error;
      const rows = ((data ?? []) as Array<Pick<UserProfile, 'id' | 'email' | 'full_name'>>);
      setClientUsers(
        rows.map((row) => ({
          id: row.id,
          label: row.full_name?.trim() || row.email || row.id,
        })),
      );
    } catch (fetchError) {
      void logError('projects.client_users.fetch.failed', fetchError);
    }
  }

  async function fetchProject(projectId: string) {
    try {
      const { data, error } = await supabase
        .from('projects')
        .select('*')
        .eq('id', projectId)
        .single();

      if (error) throw error;
      const normalized = {
        ...(data as Project),
        client: data?.client || data?.name || '',
        hypotheses: data?.hypotheses || data?.weekly_tasks || '',
      } as Project;
      setProject(normalized);
      setInitialProject(normalized);
    } catch (error) {
      void logError('projects.fetch.failed', error, { projectId });
      setMessage('Ошибка загрузки проекта');
    } finally {
      setLoading(false);
    }
  }

  async function handleSave(e?: React.FormEvent) {
    if (e) e.preventDefault();
    if (!project) return;

    setSaving(true);
    setMessage('');

    try {
      const { id, ...updates } = project;
      if (!updates.client && updates.name) {
        updates.client = updates.name;
      }
      updates.updated_at = new Date().toISOString();

      const { error } = await supabase
        .from('projects')
        .update(updates)
        .eq('id', id);

      if (error) throw error;
      setInitialProject(project);
      setMessage('Изменения сохранены');
      router.replace(pathname as Route);
      void logAudit('projects.update.success', 'Project updated', { projectId: project.id });
      
      // Auto-hide success message
      setTimeout(() => setMessage(''), 3000);
    } catch (error) {
      void logError('projects.update.failed', error, { projectId: project.id });
      setMessage('Ошибка при сохранении');
    } finally {
      setSaving(false);
    }
  }

  function handleCancelEdit() {
    if (initialProject) {
      setProject(initialProject);
    }
    setMessage('');
    router.replace(pathname as Route);
  }

  async function handleDelete() {
    if (!project) return;
    setDeleting(true);
    try {
      const { error } = await supabase
        .from('projects')
        .delete()
        .eq('id', project.id);

      if (error) throw error;
      void logAudit('projects.delete.success', 'Project deleted', { projectId: project.id });
      router.push('/projects' as Route);
    } catch (error) {
      void logError('projects.delete.failed', error, { projectId: project.id });
      setMessage('Ошибка при удалении проекта');
      setDeleting(false);
      setShowDeleteConfirm(false);
    }
  }

  if (loading) {
    return (
      <div className="flex h-screen items-center justify-center">
        <div className="text-gray-500">Загрузка...</div>
      </div>
    );
  }

  if (!project) {
    return (
      <div className="p-8 text-center">
        <h1 className="text-2xl font-bold">Проект не найден</h1>
        <Link href="/" className="text-blue-600 hover:underline mt-4 inline-block">Вернуться назад</Link>
      </div>
    );
  }

  const materials = parseMaterials(project.materials_links);
  const specialistOptions = ensureCurrentAssigneeOption(assigneeOptions, project.specialist);
  const managerOptions = ensureCurrentAssigneeOption(assigneeOptions, project.manager);

  return (
    <div className="max-w-5xl mx-auto py-8 px-4">
      <div className="mb-6 flex items-center justify-between">
        <div className="flex items-center gap-4">
          <Link href="/" className="text-sm text-gray-600 hover:text-gray-900 transition-colors">
            ← Назад
          </Link>
          <div>
            <h1 className="text-2xl font-bold text-gray-900">{project.client || 'Без названия'}</h1>
            {project.name && (
              <div className="flex flex-wrap gap-1.5 mt-1">
                {parseServices(project.name).map((service) => (
                  <span
                    key={service}
                    className="inline-flex items-center bg-blue-100 text-blue-800 text-xs font-medium px-2.5 py-0.5 rounded-full"
                  >
                    {service}
                  </span>
                ))}
              </div>
            )}
          </div>
        </div>
        <div className="flex items-center gap-2">
            {!canEdit && (
              <span className="text-sm px-3 py-1 rounded-full bg-gray-100 text-gray-600 flex items-center">
                Только просмотр
              </span>
            )}
            {message && (
                <span className={`text-sm px-3 py-1 rounded-full ${message.includes('Error') || message.includes('Ошибка') ? 'bg-red-100 text-red-700' : 'bg-green-100 text-green-700'}`}>
                    {message}
                </span>
            )}
            {canEdit && !isEditing && (
              <>
                <button
                  type="button"
                  onClick={() => router.push(`${pathname}?mode=edit` as Route)}
                  className="flex items-center gap-2 bg-gray-900 text-white px-4 py-2 rounded-md hover:bg-gray-800 transition-colors"
                >
                  <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z" /></svg>
                  Редактировать
                </button>
                <button
                  type="button"
                  onClick={handleCancelEdit}
                  className="flex items-center gap-2 border border-gray-200 px-4 py-2 rounded-md text-gray-700 hover:bg-gray-50"
                >
                  Сбросить
                </button>
                <button
                  type="button"
                  onClick={handleSave}
                  disabled={saving}
                  className="flex items-center gap-2 bg-blue-600 text-white px-4 py-2 rounded-md hover:bg-blue-700 disabled:opacity-50"
                >
                  {saving ? 'Сохранение...' : 'Сохранить'}
                </button>
                <button
                  type="button"
                  onClick={() => setShowDeleteConfirm(true)}
                  className="flex items-center gap-2 border border-red-200 text-red-600 px-4 py-2 rounded-md hover:bg-red-50 transition-colors"
                >
                  <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" /></svg>
                  Удалить
                </button>
              </>
            )}
            {canEdit && isEditing && (
              <>
                <button
                  type="button"
                  onClick={handleCancelEdit}
                  className="flex items-center gap-2 border border-gray-200 px-4 py-2 rounded-md text-gray-700 hover:bg-gray-50"
                >
                  Отмена
                </button>
                <button
                  type="button"
                  onClick={handleSave}
                  disabled={saving}
                  className="flex items-center gap-2 bg-blue-600 text-white px-4 py-2 rounded-md hover:bg-blue-700 disabled:opacity-50"
                >
                  {saving ? 'Сохранение...' : 'Сохранить'}
                </button>
                <button
                  type="button"
                  onClick={() => setShowDeleteConfirm(true)}
                  className="flex items-center gap-2 border border-red-200 text-red-600 px-4 py-2 rounded-md hover:bg-red-50 transition-colors"
                >
                  <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" /></svg>
                  Удалить
                </button>
              </>
            )}
        </div>
      </div>

      {isEditing ? (
        <form onSubmit={handleSave} className="grid grid-cols-1 md:grid-cols-3 gap-6">
        {/* Main Info Column */}
        <div className="md:col-span-2 space-y-6">
          
          {/* Status & Basic Info Card */}
          <div className="bg-white p-6 rounded-xl border border-gray-200 shadow-sm">
            <h3 className="text-lg font-semibold mb-4 text-gray-900">Основная информация</h3>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Клиент</label>
                <input
                  type="text"
                  value={project.client || ''}
                  onChange={(e) => setProject({ ...project, client: e.target.value })}
                  disabled={!canEdit}
                  className="w-full rounded-md border-gray-300 shadow-sm focus:border-blue-500 focus:ring-blue-500 p-2 border text-gray-900 disabled:bg-gray-100 disabled:cursor-not-allowed"
                />
              </div>
              <div className="md:col-span-2">
                <label className="block text-sm font-medium text-gray-700 mb-1">Услуга</label>
                <div className="flex flex-wrap gap-2 mt-1">
                  {SERVICE_OPTIONS.map((service) => {
                    const services = parseServices(project.name);
                    const isSelected = services.includes(service);
                    return (
                      <button
                        key={service}
                        type="button"
                        disabled={!canEdit}
                        onClick={() => {
                          const current = parseServices(project.name);
                          const updated = current.includes(service)
                            ? current.filter((s) => s !== service)
                            : [...current, service];
                          setProject({ ...project, name: updated.join(', ') });
                        }}
                        className={`px-3 py-1.5 rounded-lg border text-sm font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed ${
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
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Статус</label>
                <select
                  value={project.status}
                  onChange={(e) => setProject({ ...project, status: e.target.value as ProjectStatus })}
                  disabled={!canEdit}
                  className="w-full rounded-md border-gray-300 shadow-sm focus:border-blue-500 focus:ring-blue-500 p-2 border text-gray-900 disabled:bg-gray-100 disabled:cursor-not-allowed"
                >
                  <option value="В работе">В работе</option>
                  <option value="Тестирование">Тестирование</option>
                  <option value="На паузе">На паузе</option>
                  <option value="Подготовка">Подготовка</option>
                  <option value="Завершен">Завершен</option>
                  <option value="Отменен">Отменен</option>
                </select>
              </div>
              
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Сумма договора</label>
                <div className="relative">
                    <input
                    type="text"
                    value={project.budget}
                    onChange={(e) => setProject({ ...project, budget: e.target.value })}
                    disabled={!canEdit}
                    className="w-full rounded-md border-gray-300 shadow-sm focus:border-blue-500 focus:ring-blue-500 p-2 border text-gray-900 disabled:bg-gray-100 disabled:cursor-not-allowed"
                    />
                </div>
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Маржа</label>
                <input
                  type="text"
                  value={project.margin || ''}
                  onChange={(e) => setProject({ ...project, margin: e.target.value })}
                  disabled={!canEdit}
                  className="w-full rounded-md border-gray-300 shadow-sm focus:border-blue-500 focus:ring-blue-500 p-2 border text-gray-900 disabled:bg-gray-100 disabled:cursor-not-allowed"
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Где ведется проект</label>
                <select
                  value={project.work_format || ''}
                  onChange={(e) => setProject({ ...project, work_format: e.target.value })}
                  disabled={!canEdit}
                  className="w-full rounded-md border-gray-300 shadow-sm focus:border-blue-500 focus:ring-blue-500 p-2 border text-gray-900 disabled:bg-gray-100 disabled:cursor-not-allowed bg-white"
                >
                  <option value="">Не выбрано</option>
                  {WORK_FORMAT_OPTIONS.map((option) => (
                    <option key={option} value={option}>
                      {option}
                    </option>
                  ))}
                </select>
              </div>

               <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Источник лида</label>
                <select
                  value={project.lead_source || ''}
                  onChange={(e) => setProject({ ...project, lead_source: e.target.value })}
                  disabled={!canEdit}
                  className="w-full rounded-md border-gray-300 shadow-sm focus:border-blue-500 focus:ring-blue-500 p-2 border text-gray-900 disabled:bg-gray-100 disabled:cursor-not-allowed bg-white"
                >
                  <option value="">Не выбрано</option>
                  {LEAD_SOURCE_OPTIONS.map((option) => (
                    <option key={option} value={option}>{option}</option>
                  ))}
                </select>
              </div>

            </div>
          </div>

          {/* Finance */}
          <div className="bg-white p-6 rounded-xl border border-gray-200 shadow-sm">
            <h3 className="text-lg font-semibold mb-4 text-gray-900">Финансы</h3>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Тип проекта</label>
                <select
                  value={project.project_type || ''}
                  onChange={(e) => setProject({ ...project, project_type: (e.target.value || null) as Project['project_type'] })}
                  disabled={!canEdit}
                  className="w-full rounded-md border-gray-300 shadow-sm focus:border-blue-500 focus:ring-blue-500 p-2 border text-gray-900 disabled:bg-gray-100 disabled:cursor-not-allowed bg-white"
                >
                  <option value="">Не выбрано</option>
                  {PROJECT_TYPE_OPTIONS.map((opt) => (
                    <option key={opt.value} value={opt.value}>{opt.label}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Дата оплаты</label>
                <input
                  type="date"
                  value={project.payment_date || ''}
                  onChange={(e) => setProject({ ...project, payment_date: e.target.value })}
                  disabled={!canEdit}
                  className="w-full rounded-md border-gray-300 shadow-sm focus:border-blue-500 focus:ring-blue-500 p-2 border text-gray-900 disabled:bg-gray-100 disabled:cursor-not-allowed"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Дата договора</label>
                <input
                  type="date"
                  value={project.contract_date || ''}
                  onChange={(e) => setProject({ ...project, contract_date: e.target.value })}
                  disabled={!canEdit}
                  className="w-full rounded-md border-gray-300 shadow-sm focus:border-blue-500 focus:ring-blue-500 p-2 border text-gray-900 disabled:bg-gray-100 disabled:cursor-not-allowed"
                />
              </div>
            </div>
          </div>

          {/* Links */}
          <div className="bg-white p-6 rounded-xl border border-gray-200 shadow-sm">
            <h3 className="text-lg font-semibold mb-4 text-gray-900">Ссылки</h3>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Ссылка на договор</label>
                <input
                  type="text"
                  value={project.contract_link}
                  onChange={(e) => setProject({ ...project, contract_link: e.target.value })}
                  disabled={!canEdit}
                  className="w-full rounded-md border-gray-300 shadow-sm focus:border-blue-500 focus:ring-blue-500 p-2 border text-gray-900 disabled:bg-gray-100 disabled:cursor-not-allowed"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Ссылка на передачу</label>
                <input
                  type="text"
                  value={project.handoff_link}
                  onChange={(e) => setProject({ ...project, handoff_link: e.target.value })}
                  disabled={!canEdit}
                  className="w-full rounded-md border-gray-300 shadow-sm focus:border-blue-500 focus:ring-blue-500 p-2 border text-gray-900 disabled:bg-gray-100 disabled:cursor-not-allowed"
                />
              </div>
            </div>
          </div>

          {/* Tasks & Comments */}
          <div className="bg-white p-6 rounded-xl border border-gray-200 shadow-sm">
             <h3 className="text-lg font-semibold mb-4 text-gray-900">Задачи и Комментарии</h3>
             
             <div className="space-y-4">
                <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">Комментарий</label>
                    <textarea
                    rows={3}
                    value={project.comments}
                    onChange={(e) => setProject({ ...project, comments: e.target.value })}
                    disabled={!canEdit}
                    className="w-full rounded-md border-gray-300 shadow-sm focus:border-blue-500 focus:ring-blue-500 p-2 border text-gray-900 disabled:bg-gray-100 disabled:cursor-not-allowed"
                    />
                </div>
                <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">Задачи на неделю</label>
                    <textarea
                    rows={3}
                    value={project.weekly_tasks}
                    onChange={(e) => setProject({ ...project, weekly_tasks: e.target.value })}
                    disabled={!canEdit}
                    className="w-full rounded-md border-gray-300 shadow-sm focus:border-blue-500 focus:ring-blue-500 p-2 border text-gray-900 disabled:bg-gray-100 disabled:cursor-not-allowed"
                    />
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    <div>
                        <label className="block text-sm font-medium text-gray-700 mb-1">Комментарий (Эльвира)</label>
                        <textarea
                        rows={3}
                        value={project.comment_elvira}
                        onChange={(e) => setProject({ ...project, comment_elvira: e.target.value })}
                        disabled={!canEdit}
                        className="w-full rounded-md border-gray-300 shadow-sm focus:border-blue-500 focus:ring-blue-500 p-2 border bg-purple-50 text-gray-900 disabled:bg-gray-100 disabled:cursor-not-allowed"
                        />
                    </div>
                    <div>
                        <label className="block text-sm font-medium text-gray-700 mb-1">Комментарий (Аня)</label>
                        <textarea
                        rows={3}
                        value={project.comment_anya}
                        onChange={(e) => setProject({ ...project, comment_anya: e.target.value })}
                        disabled={!canEdit}
                        className="w-full rounded-md border-gray-300 shadow-sm focus:border-blue-500 focus:ring-blue-500 p-2 border bg-blue-50 text-gray-900 disabled:bg-gray-100 disabled:cursor-not-allowed"
                        />
                    </div>
                </div>
             </div>
          </div>

          {/* Project Screen Content */}
          <div className="bg-white p-6 rounded-xl border border-gray-200 shadow-sm">
            <h3 className="text-lg font-semibold mb-4 text-gray-900">Экран проекта</h3>

            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Обратная связь заказчика</label>
                <textarea
                  rows={3}
                  value={project.client_feedback}
                  onChange={(e) => setProject({ ...project, client_feedback: e.target.value })}
                  disabled={!canEdit}
                  className="w-full rounded-md border-gray-300 shadow-sm focus:border-blue-500 focus:ring-blue-500 p-2 border text-gray-900 disabled:bg-gray-100 disabled:cursor-not-allowed"
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Гипотезы (задачи)</label>
                <textarea
                  rows={3}
                  value={project.hypotheses}
                  onChange={(e) => setProject({ ...project, hypotheses: e.target.value })}
                  disabled={!canEdit}
                  className="w-full rounded-md border-gray-300 shadow-sm focus:border-blue-500 focus:ring-blue-500 p-2 border text-gray-900 disabled:bg-gray-100 disabled:cursor-not-allowed"
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Результат</label>
                <textarea
                  rows={3}
                  value={project.hypotheses_result}
                  onChange={(e) => setProject({ ...project, hypotheses_result: e.target.value })}
                  disabled={!canEdit}
                  className="w-full rounded-md border-gray-300 shadow-sm focus:border-blue-500 focus:ring-blue-500 p-2 border text-gray-900 disabled:bg-gray-100 disabled:cursor-not-allowed"
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Подзадачи</label>
                <textarea
                  rows={3}
                  value={project.subtasks}
                  onChange={(e) => setProject({ ...project, subtasks: e.target.value })}
                  disabled={!canEdit}
                  className="w-full rounded-md border-gray-300 shadow-sm focus:border-blue-500 focus:ring-blue-500 p-2 border text-gray-900 disabled:bg-gray-100 disabled:cursor-not-allowed"
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Материалы и файлы (ссылки)
                </label>
                <textarea
                  rows={3}
                  value={project.materials_links}
                  onChange={(e) => setProject({ ...project, materials_links: e.target.value })}
                  disabled={!canEdit}
                  placeholder="Каждая ссылка с новой строки"
                  className="w-full rounded-md border-gray-300 shadow-sm focus:border-blue-500 focus:ring-blue-500 p-2 border text-gray-900 disabled:bg-gray-100 disabled:cursor-not-allowed"
                />
              </div>
            </div>
          </div>

           {/* KPI Section */}
           <div className="bg-white p-6 rounded-xl border border-gray-200 shadow-sm">
            <h3 className="text-lg font-semibold mb-4 text-gray-900">KPI</h3>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                 <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">KPI План</label>
                    <input
                    type="text"
                    value={project.kpi_plan}
                    onChange={(e) => setProject({ ...project, kpi_plan: e.target.value })}
                    disabled={!canEdit}
                    className="w-full rounded-md border-gray-300 shadow-sm focus:border-blue-500 focus:ring-blue-500 p-2 border text-gray-900 disabled:bg-gray-100 disabled:cursor-not-allowed"
                    />
                </div>
                 <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">KPI Факт</label>
                    <input
                    type="text"
                    value={project.kpi_fact}
                    onChange={(e) => setProject({ ...project, kpi_fact: e.target.value })}
                    disabled={!canEdit}
                    className="w-full rounded-md border-gray-300 shadow-sm focus:border-blue-500 focus:ring-blue-500 p-2 border font-bold text-gray-900 disabled:bg-gray-100 disabled:cursor-not-allowed"
                    />
                </div>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mt-4">
                 <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">Обязательство по контактам</label>
                    <input
                    type="text"
                    value={project.contacts_obligation ?? ''}
                    onChange={(e) => setProject({ ...project, contacts_obligation: e.target.value })}
                    disabled={!canEdit}
                    className="w-full rounded-md border-gray-300 shadow-sm focus:border-blue-500 focus:ring-blue-500 p-2 border text-gray-900 disabled:bg-gray-100 disabled:cursor-not-allowed"
                    placeholder="Например 4000"
                    />
                </div>
                 <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">Контактов пройдено</label>
                    <input
                    type="text"
                    value={project.contacts_done ?? ''}
                    onChange={(e) => setProject({ ...project, contacts_done: e.target.value })}
                    disabled={!canEdit}
                    className="w-full rounded-md border-gray-300 shadow-sm focus:border-blue-500 focus:ring-blue-500 p-2 border font-bold text-gray-900 disabled:bg-gray-100 disabled:cursor-not-allowed"
                    placeholder="0"
                    />
                </div>
            </div>
          </div>
        </div>

        {/* Sidebar Column */}
        <div className="space-y-6">
           {/* Team Card */}
           <div className="bg-white p-6 rounded-xl border border-gray-200 shadow-sm">
            <h3 className="text-lg font-semibold mb-4 text-gray-900 flex items-center">
                Команда
            </h3>
            <div className="space-y-4">
                <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">Менеджер</label>
                    <select
                      value={project.manager || ''}
                      onChange={(e) => setProject({ ...project, manager: e.target.value })}
                      disabled={!canEdit}
                      className="w-full rounded-md border-gray-300 shadow-sm focus:border-blue-500 focus:ring-blue-500 p-2 border text-gray-900 disabled:bg-gray-100 disabled:cursor-not-allowed bg-white"
                    >
                      <option value="">Не выбрано</option>
                      {managerOptions.map((option) => (
                        <option key={option} value={option}>
                          {option}
                        </option>
                      ))}
                    </select>
                </div>
                 <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">Специалист</label>
                    <select
                      value={project.specialist || ''}
                      onChange={(e) => setProject({ ...project, specialist: e.target.value })}
                      disabled={!canEdit}
                      className="w-full rounded-md border-gray-300 shadow-sm focus:border-blue-500 focus:ring-blue-500 p-2 border text-gray-900 disabled:bg-gray-100 disabled:cursor-not-allowed bg-white"
                    >
                      <option value="">Не выбрано</option>
                      {specialistOptions.map((option) => (
                        <option key={option} value={option}>
                          {option}
                        </option>
                      ))}
                    </select>
                </div>
                <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">Доступ клиента (ЛК)</label>
                    <select
                      value={project.client_user_id ?? ''}
                      onChange={(e) =>
                        setProject({
                          ...project,
                          client_user_id: e.target.value ? e.target.value : null,
                        })
                      }
                      disabled={!canEdit}
                      className="w-full rounded-md border-gray-300 shadow-sm focus:border-blue-500 focus:ring-blue-500 p-2 border text-gray-900 disabled:bg-gray-100 disabled:cursor-not-allowed bg-white"
                    >
                      <option value="">Не привязан</option>
                      {clientUsers.map((option) => (
                        <option key={option.id} value={option.id}>
                          {option.label}
                        </option>
                      ))}
                    </select>
                    <p className="mt-1 text-[11px] text-gray-500">
                      Выберите пользователя клиента — он увидит этот проект в личном кабинете.
                    </p>
                </div>
            </div>
           </div>

           {/* Dates Card */}
           <div className="bg-white p-6 rounded-xl border border-gray-200 shadow-sm">
            <h3 className="text-lg font-semibold mb-4 text-gray-900 flex items-center">
                Сроки
            </h3>
             <div className="space-y-4">
                <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">Дата запуска</label>
                    <input
                    type="text"
                    value={project.launch_date}
                    onChange={(e) => setProject({ ...project, launch_date: e.target.value })}
                    disabled={!canEdit}
                    className="w-full rounded-md border-gray-300 shadow-sm focus:border-blue-500 focus:ring-blue-500 p-2 border text-gray-900 disabled:bg-gray-100 disabled:cursor-not-allowed"
                    placeholder="DD.MM.YY"
                    />
                </div>
                 <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">Дедлайн</label>
                    <input
                    type="text"
                    value={project.deadline}
                    onChange={(e) => setProject({ ...project, deadline: e.target.value })}
                    disabled={!canEdit}
                    className="w-full rounded-md border-gray-300 shadow-sm focus:border-blue-500 focus:ring-blue-500 p-2 border text-red-600 disabled:bg-gray-100 disabled:cursor-not-allowed"
                    placeholder="DD.MM.YY"
                    />
                </div>
            </div>
           </div>
        </div>
        </form>
      ) : (
        <div className="space-y-6">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <EditableTile
              label="Специалист"
              value={project.specialist}
              onChange={(value) => setProject({ ...project, specialist: value })}
              disabled={!canEdit}
              options={specialistOptions}
              placeholder="Не назначен"
            />
            <EditableTile
              label="Лид (контролирует)"
              value={project.manager}
              onChange={(value) => setProject({ ...project, manager: value })}
              disabled={!canEdit}
              options={managerOptions}
              placeholder="Не назначен"
            />
          </div>

          <SectionCard title="ОС заказчика">
            <EditableTextarea
              value={project.client_feedback}
              onChange={(value) => setProject({ ...project, client_feedback: value })}
              disabled={!canEdit}
              placeholder="Введите обратную связь заказчика"
              rows={4}
            />
          </SectionCard>

          <SectionCard title="Гипотезы (задачи) и результат">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <p className="text-xs uppercase tracking-wide text-gray-400">Гипотезы (задачи)</p>
                <div className="mt-2">
                  <EditableTextarea
                    value={project.hypotheses || project.weekly_tasks}
                    onChange={(value) => setProject({ ...project, hypotheses: value })}
                    disabled={!canEdit}
                    placeholder="Список гипотез/задач"
                    rows={4}
                  />
                </div>
              </div>
              <div>
                <p className="text-xs uppercase tracking-wide text-gray-400">Результат</p>
                <div className="mt-2">
                  <EditableTextarea
                    value={project.hypotheses_result}
                    onChange={(value) => setProject({ ...project, hypotheses_result: value })}
                    disabled={!canEdit}
                    placeholder="Результат выполнения"
                    rows={4}
                  />
                </div>
              </div>
            </div>
          </SectionCard>

          <SectionCard title="Подзадачи">
            <EditableTextarea
              value={project.subtasks}
              onChange={(value) => setProject({ ...project, subtasks: value })}
              disabled={!canEdit}
              placeholder="Подзадачи"
              rows={4}
            />
          </SectionCard>

          <SectionCard title="Комментарий">
            <EditableTextarea
              value={project.comments}
              onChange={(value) => setProject({ ...project, comments: value })}
              disabled={!canEdit}
              placeholder="Комментарий"
              rows={4}
            />
          </SectionCard>

          <SectionCard title="Материалы и файлы (ссылки)">
            <div className="space-y-3">
              <EditableTextarea
                value={project.materials_links}
                onChange={(value) => setProject({ ...project, materials_links: value })}
                disabled={!canEdit}
                placeholder="Каждая ссылка с новой строки"
                rows={4}
              />
              {materials.length > 0 && (
                <ul className="space-y-1 text-sm">
                  {materials.map((item, index) => {
                    const url = normalizeUrl(item);
                    return (
                      <li key={`${item}-${index}`}>
                        {url ? (
                          <a
                            href={url}
                            target="_blank"
                            rel="noreferrer"
                            className="text-blue-600 hover:underline"
                          >
                            {formatUrlLabel(url)}
                          </a>
                        ) : (
                          <span className="text-gray-700">{item}</span>
                        )}
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          </SectionCard>
        </div>
      )}

      {/* Delete confirmation modal */}
      {showDeleteConfirm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center">
          <div className="fixed inset-0 bg-black/50" onClick={() => !deleting && setShowDeleteConfirm(false)} />
          <div className="relative bg-white rounded-2xl shadow-2xl max-w-md w-full mx-4 p-6">
            <div className="flex items-center justify-center w-12 h-12 mx-auto rounded-full bg-red-100 mb-4">
              <svg xmlns="http://www.w3.org/2000/svg" className="h-6 w-6 text-red-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4c-.77-.833-1.964-.833-2.732 0L4.082 16.5c-.77.833.192 2.5 1.732 2.5z" />
              </svg>
            </div>
            <h3 className="text-lg font-semibold text-gray-900 text-center">Удалить проект?</h3>
            <p className="mt-2 text-sm text-gray-500 text-center">
              Вы уверены, что хотите удалить проект <span className="font-medium text-gray-700">{project?.client || 'Без названия'}</span>? Это действие нельзя отменить.
            </p>
            <div className="mt-6 flex gap-3">
              <button
                type="button"
                onClick={() => setShowDeleteConfirm(false)}
                disabled={deleting}
                className="flex-1 px-4 py-2.5 border border-gray-300 rounded-lg text-sm font-medium text-gray-700 hover:bg-gray-50 transition-colors disabled:opacity-50"
              >
                Отмена
              </button>
              <button
                type="button"
                onClick={handleDelete}
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
