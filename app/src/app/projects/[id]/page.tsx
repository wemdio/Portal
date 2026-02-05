'use client';

import { useEffect, useState, type ReactNode } from 'react';
import { useParams, usePathname, useRouter, useSearchParams } from 'next/navigation';
import { supabase } from '@/lib/supabaseClient';
import { Project, ProjectStatus } from '@/types';
import Link from 'next/link';
import { getCurrentUserRole, canEditProjects } from '@/lib/roles';

const WORK_FORMAT_OPTIONS = ['Колди', 'Тригга', 'Инстантли'];

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
}: {
  label: string;
  value?: string | null;
  onChange: (value: string) => void;
  disabled: boolean;
  placeholder?: string;
}) {
  return (
    <div className="rounded-xl border border-gray-200 bg-white p-4 shadow-sm">
      <label className="text-xs uppercase tracking-wide text-gray-400">{label}</label>
      <input
        type="text"
        value={value || ''}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled}
        placeholder={placeholder}
        className="mt-2 w-full rounded-md border border-gray-200 px-3 py-2 text-sm text-gray-900 focus:border-blue-500 focus:ring-blue-500 disabled:bg-gray-100 disabled:cursor-not-allowed"
      />
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
  
  const [project, setProject] = useState<Project | null>(null);
  const [initialProject, setInitialProject] = useState<Project | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState('');
  const [canEdit, setCanEdit] = useState(false);

  useEffect(() => {
    if (id) {
      fetchProject(id);
      checkPermissions();
    }
  }, [id]);

  async function checkPermissions() {
    const role = await getCurrentUserRole();
    setCanEdit(canEditProjects(role));
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
      console.error('Error fetching project:', error);
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
      router.replace(pathname);
      
      // Auto-hide success message
      setTimeout(() => setMessage(''), 3000);
    } catch (error) {
      console.error('Error updating project:', error);
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
    router.replace(pathname);
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

  return (
    <div className="max-w-5xl mx-auto py-8 px-4">
      <div className="mb-6 flex items-center justify-between">
        <div className="flex items-center gap-4">
          <Link href="/" className="text-sm text-gray-600 hover:text-gray-900 transition-colors">
            ← Назад
          </Link>
          <div>
            <h1 className="text-2xl font-bold text-gray-900">{project.client || project.name}</h1>
            <p className="text-sm text-gray-500">
              {project.client ? project.name : project.description}
            </p>
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
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Проект / услуга</label>
                <input
                  type="text"
                  value={project.name}
                  onChange={(e) => setProject({ ...project, name: e.target.value })}
                  disabled={!canEdit}
                  className="w-full rounded-md border-gray-300 shadow-sm focus:border-blue-500 focus:ring-blue-500 p-2 border text-gray-900 disabled:bg-gray-100 disabled:cursor-not-allowed"
                />
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

              <div className="md:col-span-2">
                <label className="block text-sm font-medium text-gray-700 mb-1">Описание услуги</label>
                <textarea
                  rows={3}
                  value={project.description}
                  onChange={(e) => setProject({ ...project, description: e.target.value })}
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
                <input
                  type="text"
                  value={project.lead_source}
                  onChange={(e) => setProject({ ...project, lead_source: e.target.value })}
                  disabled={!canEdit}
                  className="w-full rounded-md border-gray-300 shadow-sm focus:border-blue-500 focus:ring-blue-500 p-2 border text-gray-900 disabled:bg-gray-100 disabled:cursor-not-allowed"
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Регион</label>
                <input
                  type="text"
                  value={project.region}
                  onChange={(e) => setProject({ ...project, region: e.target.value })}
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
                    <input
                    type="text"
                    value={project.manager}
                    onChange={(e) => setProject({ ...project, manager: e.target.value })}
                    disabled={!canEdit}
                    className="w-full rounded-md border-gray-300 shadow-sm focus:border-blue-500 focus:ring-blue-500 p-2 border text-gray-900 disabled:bg-gray-100 disabled:cursor-not-allowed"
                    />
                </div>
                 <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">Специалист</label>
                    <input
                    type="text"
                    value={project.specialist}
                    onChange={(e) => setProject({ ...project, specialist: e.target.value })}
                    disabled={!canEdit}
                    className="w-full rounded-md border-gray-300 shadow-sm focus:border-blue-500 focus:ring-blue-500 p-2 border text-gray-900 disabled:bg-gray-100 disabled:cursor-not-allowed"
                    />
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
              placeholder="Имя специалиста"
            />
            <EditableTile
              label="Лид (контролирует)"
              value={project.manager}
              onChange={(value) => setProject({ ...project, manager: value })}
              disabled={!canEdit}
              placeholder="Имя лида"
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
    </div>
  );
}
