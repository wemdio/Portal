'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { supabase } from '@/lib/supabaseClient';
import Link from 'next/link';
import { UserRole } from '@/types';
import { getCurrentUserRole, canCreateProjects, ROLE_LABELS } from '@/lib/roles';
import { logAudit, logError } from '@/lib/loggerClient';

const WORK_FORMAT_OPTIONS = ['Колди', 'Тригга', 'Инстантли'];
const LEAD_SOURCE_OPTIONS = ['Аутрич', 'Телеграм', 'Лидскан', 'ЛинкедИн', 'Перфоманс'];
const SERVICE_OPTIONS = ['Аутрич', 'ТГ аутрич', 'Лидскан', 'ЛинкедИн', 'Перфоманс', 'Ретаргет'];
const PROJECT_TYPE_OPTIONS: { value: string; label: string }[] = [
  { value: 'Продажа', label: 'Продажа (новый клиент)' },
  { value: 'Продление', label: 'Продление' },
];

export default function NewProjectPage() {
  const router = useRouter();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [userRole, setUserRole] = useState<UserRole | null>(null);
  const [checkingAccess, setCheckingAccess] = useState(true);
  
  useEffect(() => {
    checkAccess();
  }, []);

  async function checkAccess() {
    const role = await getCurrentUserRole();
    setUserRole(role);
    setCheckingAccess(false);
  }

  const [selectedServices, setSelectedServices] = useState<string[]>([]);

  const toggleService = (service: string) => {
    setSelectedServices((prev) =>
      prev.includes(service) ? prev.filter((s) => s !== service) : [...prev, service]
    );
  };

  const [formData, setFormData] = useState({
    client: '',
    name: '',
    status: 'В работе',
    manager: '',
    specialist: '',
    budget: '',
    margin: '',
    contract_link: '',
    handoff_link: '',
    deadline: '',
    kpi_plan: '',
    work_format: '',
    comments: '',
    lead_source: '',
    project_type: '',

    payment_date: '',
    contract_date: '',
    launch_date: '',
  });

  const statusOptions = [
    'В работе',
    'Тестирование',
    'На паузе',
    'Подготовка',
    'Завершен',
    'Отменен',
  ];

  const handleChange = (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) => {
    setFormData({ ...formData, [e.target.name]: e.target.value });
  };

  const handleSave = async () => {
    if (!formData.client.trim()) {
      setError('Клиент обязателен');
      return;
    }

    if (selectedServices.length === 0) {
      setError('Выберите хотя бы одну услугу');
      return;
    }

    setSaving(true);
    setError('');

    try {
      const { data, error } = await supabase
        .from('projects')
        .insert([{
          name: selectedServices.join(', '),
          client: formData.client || null,
          status: formData.status,
          manager: formData.manager || null,
          specialist: formData.specialist || null,
          budget: formData.budget || null,
          margin: formData.margin || null,
          contract_link: formData.contract_link || null,
          handoff_link: formData.handoff_link || null,
          deadline: formData.deadline || null,
          kpi_plan: formData.kpi_plan || null,
          work_format: formData.work_format || null,
          comments: formData.comments || null,
          lead_source: formData.lead_source || null,
          project_type: formData.project_type || null,

          payment_date: formData.payment_date || null,
          contract_date: formData.contract_date || null,
          launch_date: formData.launch_date || null,
        }])
        .select()
        .single();

      if (error) throw error;

      void logAudit('projects.create.success', 'Project created', { projectId: data.id });
      router.push(`/projects/${data.id}`);
    } catch (caughtError) {
      void logError('projects.create.failed', caughtError);
      const errorMessage =
        caughtError instanceof Error
          ? caughtError.message
          : typeof caughtError === 'object' && caughtError !== null && 'message' in caughtError && typeof (caughtError as { message: unknown }).message === 'string'
            ? ((caughtError as { message: string }).message)
            : 'Ошибка при создании проекта';

      setError(errorMessage);
    } finally {
      setSaving(false);
    }
  };

  if (checkingAccess) {
    return (
      <div className="flex h-64 items-center justify-center">
        <div className="text-gray-500">Загрузка...</div>
      </div>
    );
  }

  if (!canCreateProjects(userRole)) {
    return (
      <div className="max-w-4xl mx-auto py-10">
        <Link 
          href="/" 
          className="inline-flex items-center text-sm text-gray-500 hover:text-gray-700 mb-4"
        >
          ← Назад к проектам
        </Link>
        <div className="bg-red-50 border border-red-200 rounded-lg p-6 flex items-center">
          <div>
            <h2 className="text-lg font-semibold text-red-800">Доступ запрещен</h2>
            <p className="text-red-600">
              У вас нет прав для создания проектов. 
              {userRole && ` Ваша роль: ${ROLE_LABELS[userRole]}.`}
            </p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-4xl mx-auto">
      {/* Header */}
      <div className="mb-6">
        <Link 
          href="/" 
          className="inline-flex items-center text-sm text-gray-500 hover:text-gray-900 mb-4 transition-colors"
        >
          ← Назад к проектам
        </Link>
        <div className="flex items-center">
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
        {/* Client */}
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-2">
            Клиент *
          </label>
          <input
            type="text"
            name="client"
            value={formData.client}
            onChange={handleChange}
            className="w-full px-4 py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
            placeholder="Название компании или клиента"
          />
        </div>

        {/* Services multi-select */}
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-2">
            Услуга *
          </label>
          <div className="flex flex-wrap gap-2">
            {SERVICE_OPTIONS.map((service) => {
              const isSelected = selectedServices.includes(service);
              return (
                <button
                  key={service}
                  type="button"
                  onClick={() => toggleService(service)}
                  className={`px-4 py-2 rounded-lg border text-sm font-medium transition-colors ${
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
          {selectedServices.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-1.5">
              {selectedServices.map((service) => (
                <span
                  key={service}
                  className="inline-flex items-center gap-1 bg-blue-100 text-blue-800 text-xs font-medium px-2.5 py-1 rounded-full"
                >
                  {service}
                  <button
                    type="button"
                    onClick={() => toggleService(service)}
                    className="text-blue-600 hover:text-blue-800"
                  >
                    ×
                  </button>
                </span>
              ))}
            </div>
          )}
        </div>

        {/* Status & Lead Row */}
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
              Лид (контролирует)
            </label>
            <input
              type="text"
              name="manager"
              value={formData.manager}
              onChange={handleChange}
              className="w-full px-4 py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
              placeholder="Имя лида"
            />
          </div>
        </div>

        {/* Specialist & Platform Row */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">
              Специалист
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
              Где ведется проект
            </label>
            <select
              name="work_format"
              value={formData.work_format}
              onChange={handleChange}
              className="w-full px-4 py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent bg-white"
            >
              <option value="">Не выбрано</option>
              {WORK_FORMAT_OPTIONS.map((option) => (
                <option key={option} value={option}>{option}</option>
              ))}
            </select>
          </div>
        </div>

        {/* Source & Type Row */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">
              Тип проекта
            </label>
            <select
              name="project_type"
              value={formData.project_type}
              onChange={handleChange}
              className="w-full px-4 py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent bg-white"
            >
              <option value="">Не выбрано</option>
              {PROJECT_TYPE_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>{opt.label}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">
              Источник лида
            </label>
            <select
              name="lead_source"
              value={formData.lead_source}
              onChange={handleChange}
              className="w-full px-4 py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent bg-white"
            >
              <option value="">Не выбрано</option>
              {LEAD_SOURCE_OPTIONS.map((option) => (
                <option key={option} value={option}>{option}</option>
              ))}
            </select>
          </div>
        </div>

        {/* Budget, Margin & KPI Row */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">
              Выручка / сумма договора
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
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">
              Маржа
            </label>
            <input
              type="text"
              name="margin"
              value={formData.margin}
              onChange={handleChange}
              className="w-full px-4 py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
              placeholder="Например: 45%"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">
              KPI
            </label>
            <input
              type="text"
              name="kpi_plan"
              value={formData.kpi_plan}
              onChange={handleChange}
              className="w-full px-4 py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
              placeholder="Ключевые показатели эффективности"
            />
          </div>
        </div>

        {/* Payment Date */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">
              Дата оплаты
            </label>
            <input
              type="date"
              name="payment_date"
              value={formData.payment_date}
              onChange={handleChange}
              className="w-full px-4 py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
            />
          </div>
        </div>

        {/* Dates */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">
              Дата договора
            </label>
            <input
              type="date"
              name="contract_date"
              value={formData.contract_date}
              onChange={handleChange}
              className="w-full px-4 py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">
              Дата запуска
            </label>
            <input
              type="date"
              name="launch_date"
              value={formData.launch_date}
              onChange={handleChange}
              className="w-full px-4 py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">
              Дедлайн
            </label>
            <input
              type="date"
              name="deadline"
              value={formData.deadline}
              onChange={handleChange}
              className="w-full px-4 py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
            />
          </div>
        </div>

        {/* Links Row */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">
              Ссылка на договор
            </label>
            <input
              type="text"
              name="contract_link"
              value={formData.contract_link}
              onChange={handleChange}
              className="w-full px-4 py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
              placeholder="https://..."
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">
              Ссылка на передачу
            </label>
            <input
              type="text"
              name="handoff_link"
              value={formData.handoff_link}
              onChange={handleChange}
              className="w-full px-4 py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
              placeholder="https://t.me/..."
            />
          </div>
        </div>

        {/* Comments */}
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-2">
            Комментарий
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
            {saving ? 'Создание...' : 'Создать проект'}
          </button>
        </div>
      </div>
    </div>
  );
}
