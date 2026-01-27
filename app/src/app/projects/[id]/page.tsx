'use client';

import { useEffect, useState } from 'react';
import { useRouter, useParams } from 'next/navigation';
import { supabase } from '@/lib/supabaseClient';
import { Project, ProjectStatus, UserRole } from '@/types';
import { ArrowLeft, Save, Loader2, Calendar, User, DollarSign, Lock } from 'lucide-react';
import Link from 'next/link';
import { getCurrentUserRole, canEditProjects, ROLE_LABELS } from '@/lib/roles';

export default function ProjectPage() {
  const router = useRouter();
  const params = useParams();
  const id = params?.id as string;
  
  const [project, setProject] = useState<Project | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState('');
  const [userRole, setUserRole] = useState<UserRole | null>(null);
  const [canEdit, setCanEdit] = useState(false);

  useEffect(() => {
    if (id) {
      fetchProject(id);
      checkPermissions();
    }
  }, [id]);

  async function checkPermissions() {
    const role = await getCurrentUserRole();
    setUserRole(role);
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
      setProject(data);
    } catch (error) {
      console.error('Error fetching project:', error);
      setMessage('Ошибка загрузки проекта');
    } finally {
      setLoading(false);
    }
  }

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    if (!project) return;

    setSaving(true);
    setMessage('');

    try {
      // Remove id from update payload
      const { id: _, ...updates } = project as any;
      
      const { error } = await supabase
        .from('projects')
        .update(updates)
        .eq('id', project.id);

      if (error) throw error;
      setMessage('Изменения сохранены');
      
      // Auto-hide success message
      setTimeout(() => setMessage(''), 3000);
    } catch (error) {
      console.error('Error updating project:', error);
      setMessage('Ошибка при сохранении');
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return (
      <div className="flex h-screen items-center justify-center">
        <Loader2 className="h-8 w-8 animate-spin text-blue-600" />
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

  return (
    <div className="max-w-5xl mx-auto py-8 px-4">
      <div className="mb-6 flex items-center justify-between">
        <div className="flex items-center gap-4">
          <Link href="/" className="p-2 hover:bg-gray-100 rounded-full transition-colors">
            <ArrowLeft className="h-6 w-6 text-gray-600" />
          </Link>
          <div>
            <h1 className="text-2xl font-bold text-gray-900">{project.name}</h1>
            <p className="text-sm text-gray-500">{project.description}</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
            {!canEdit && (
              <span className="text-sm px-3 py-1 rounded-full bg-gray-100 text-gray-600 flex items-center">
                <Lock className="h-3 w-3 mr-1" />
                Только просмотр
              </span>
            )}
            {message && (
                <span className={`text-sm px-3 py-1 rounded-full ${message.includes('Error') || message.includes('Ошибка') ? 'bg-red-100 text-red-700' : 'bg-green-100 text-green-700'}`}>
                    {message}
                </span>
            )}
            {canEdit && (
              <button
                onClick={handleSave}
                disabled={saving}
                className="flex items-center gap-2 bg-blue-600 text-white px-4 py-2 rounded-md hover:bg-blue-700 disabled:opacity-50"
              >
                {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
                Сохранить
              </button>
            )}
        </div>
      </div>

      <form onSubmit={handleSave} className="grid grid-cols-1 md:grid-cols-3 gap-6">
        {/* Main Info Column */}
        <div className="md:col-span-2 space-y-6">
          
          {/* Status & Basic Info Card */}
          <div className="bg-white p-6 rounded-xl border border-gray-200 shadow-sm">
            <h3 className="text-lg font-semibold mb-4 text-gray-900">Основная информация</h3>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Статус</label>
                <select
                  value={project.status}
                  onChange={(e) => setProject({ ...project, status: e.target.value as ProjectStatus })}
                  disabled={!canEdit}
                  className="w-full rounded-md border-gray-300 shadow-sm focus:border-blue-500 focus:ring-blue-500 p-2 border text-gray-900 disabled:bg-gray-100 disabled:cursor-not-allowed"
                >
                  <option value="New">Новый</option>
                  <option value="Тест">Тест</option>
                  <option value="В работе">В работе</option>
                  <option value="На паузе">На паузе</option>
                  <option value="Подготовка">Подготовка</option>
                  <option value="Completed">Завершен</option>
                </select>
              </div>
              
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Бюджет</label>
                <div className="relative">
                    <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
                        <DollarSign className="h-4 w-4 text-gray-400" />
                    </div>
                    <input
                    type="text"
                    value={project.budget}
                    onChange={(e) => setProject({ ...project, budget: e.target.value })}
                    disabled={!canEdit}
                    className="w-full pl-10 rounded-md border-gray-300 shadow-sm focus:border-blue-500 focus:ring-blue-500 p-2 border text-gray-900 disabled:bg-gray-100 disabled:cursor-not-allowed"
                    />
                </div>
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

          {/* Tasks & Comments */}
          <div className="bg-white p-6 rounded-xl border border-gray-200 shadow-sm">
             <h3 className="text-lg font-semibold mb-4 text-gray-900">Задачи и Комментарии</h3>
             
             <div className="space-y-4">
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
                <User className="h-5 w-5 mr-2 text-gray-500" />
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
                <Calendar className="h-5 w-5 mr-2 text-gray-500" />
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
    </div>
  );
}
