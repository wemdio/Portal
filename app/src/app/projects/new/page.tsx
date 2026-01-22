'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { supabase } from '@/lib/supabaseClient';
import { ArrowLeft, Save, Briefcase } from 'lucide-react';
import Link from 'next/link';

export default function NewProjectPage() {
  const router = useRouter();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  
  const [formData, setFormData] = useState({
    project_name: '',
    status: 'В работе',
    manager: '',
    specialist: '',
    budget: '',
    kpi: '',
    start_date: '',
    test_end_date: '',
    current_tasks: '',
    comments: '',
  });

  const statusOptions = [
    'В работе',
    'Тестирование',
    'На паузе',
    'Завершен',
    'Отменен',
  ];

  const handleChange = (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) => {
    setFormData({ ...formData, [e.target.name]: e.target.value });
  };

  const handleSave = async () => {
    if (!formData.project_name.trim()) {
      setError('Название проекта обязательно');
      return;
    }

    setSaving(true);
    setError('');

    try {
      const { data, error } = await supabase
        .from('projects')
        .insert([{
          project_name: formData.project_name,
          status: formData.status,
          manager: formData.manager || null,
          specialist: formData.specialist || null,
          budget: formData.budget || null,
          kpi: formData.kpi || null,
          start_date: formData.start_date || null,
          test_end_date: formData.test_end_date || null,
          current_tasks: formData.current_tasks || null,
          comments: formData.comments || null,
        }])
        .select()
        .single();

      if (error) throw error;

      router.push(`/projects/${data.id}`);
    } catch (error: any) {
      console.error('Error creating project:', error);
      setError(error.message || 'Ошибка при создании проекта');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="max-w-4xl mx-auto">
      {/* Header */}
      <div className="mb-6">
        <Link 
          href="/" 
          className="inline-flex items-center text-sm text-gray-500 hover:text-gray-700 mb-4"
        >
          <ArrowLeft className="h-4 w-4 mr-1" />
          Назад к проектам
        </Link>
        <div className="flex items-center">
          <div className="p-3 rounded-xl bg-gradient-to-br from-blue-500 to-blue-600 text-white mr-4">
            <Briefcase className="h-6 w-6" />
          </div>
          <div>
            <h1 className="text-2xl font-semibold text-gray-900">Новый проект</h1>
            <p className="text-sm text-gray-500">Заполните информацию о проекте</p>
          </div>
        </div>
      </div>

      {error && (
        <div className="mb-6 p-4 bg-red-50 border border-red-200 rounded-lg text-red-700">
          {error}
        </div>
      )}

      {/* Form */}
      <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-6 space-y-6">
        {/* Project Name */}
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-2">
            Название проекта *
          </label>
          <input
            type="text"
            name="project_name"
            value={formData.project_name}
            onChange={handleChange}
            className="w-full px-4 py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
            placeholder="Например: Маркетинг для ООО Рога и Копыта"
          />
        </div>

        {/* Status & Manager Row */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">
              Статус
            </label>
            <select
              name="status"
              value={formData.status}
              onChange={handleChange}
              className="w-full px-4 py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent bg-white"
            >
              {statusOptions.map((status) => (
                <option key={status} value={status}>{status}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">
              Менеджер (контролирует)
            </label>
            <input
              type="text"
              name="manager"
              value={formData.manager}
              onChange={handleChange}
              className="w-full px-4 py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
              placeholder="Имя менеджера"
            />
          </div>
        </div>

        {/* Specialist & Budget Row */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">
              Специалист проекта
            </label>
            <input
              type="text"
              name="specialist"
              value={formData.specialist}
              onChange={handleChange}
              className="w-full px-4 py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
              placeholder="Имя специалиста"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">
              Бюджет
            </label>
            <input
              type="text"
              name="budget"
              value={formData.budget}
              onChange={handleChange}
              className="w-full px-4 py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
              placeholder="Например: 150000"
            />
          </div>
        </div>

        {/* KPI */}
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-2">
            KPI
          </label>
          <input
            type="text"
            name="kpi"
            value={formData.kpi}
            onChange={handleChange}
            className="w-full px-4 py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
            placeholder="Ключевые показатели эффективности"
          />
        </div>

        {/* Dates Row */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">
              Дата начала
            </label>
            <input
              type="date"
              name="start_date"
              value={formData.start_date}
              onChange={handleChange}
              className="w-full px-4 py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">
              Дата окончания теста / Дедлайн
            </label>
            <input
              type="date"
              name="test_end_date"
              value={formData.test_end_date}
              onChange={handleChange}
              className="w-full px-4 py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
            />
          </div>
        </div>

        {/* Current Tasks */}
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-2">
            Текущие задачи
          </label>
          <textarea
            name="current_tasks"
            value={formData.current_tasks}
            onChange={handleChange}
            rows={3}
            className="w-full px-4 py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent resize-none"
            placeholder="Опишите текущие задачи по проекту"
          />
        </div>

        {/* Comments */}
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-2">
            Комментарии
          </label>
          <textarea
            name="comments"
            value={formData.comments}
            onChange={handleChange}
            rows={3}
            className="w-full px-4 py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent resize-none"
            placeholder="Дополнительные заметки"
          />
        </div>

        {/* Save Button */}
        <div className="flex justify-end pt-4 border-t border-gray-200">
          <button
            onClick={handleSave}
            disabled={saving}
            className="inline-flex items-center px-6 py-3 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed font-medium transition-colors"
          >
            {saving ? (
              <>
                <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-white mr-2"></div>
                Создание...
              </>
            ) : (
              <>
                <Save className="h-4 w-4 mr-2" />
                Создать проект
              </>
            )}
          </button>
        </div>
      </div>
    </div>
  );
}


