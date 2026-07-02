'use client';

import { useState, useEffect, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { supabase } from '@/lib/supabaseClient';
import Link from 'next/link';
import { UserProfile } from '@/types';
import { canCreateProjects, ROLE_LABELS } from '@/lib/roles';
import { useUser } from '@/lib/UserProvider';
import { logAudit, logError } from '@/lib/loggerClient';
import { buildAssigneeOptions } from '@/lib/projectAssignees';
import { ProjectBriefUploader } from '@/components/projects/ProjectBriefUploader';
import { SERVICE_OPTIONS } from '@/lib/projectServices';

const WORK_FORMAT_OPTIONS = ['Колди', 'Тригга', 'Инстантли'];
const LEAD_SOURCE_OPTIONS = ['Аутрич', 'Телеграм', 'Лидскан', 'ЛинкедИн', 'Перфоманс', 'Органика', 'Партнер'];
const PROJECT_TYPE_OPTIONS: { value: string; label: string }[] = [
  { value: 'Продажа', label: 'Продажа (новый клиент)' },
  { value: 'Продление', label: 'Продление' },
];

/* ── helpers for auto margin ── */
function parseBudgetValue(raw: string): number {
  if (!raw) return 0;
  const cleaned = raw.replace(/\s/g, '').replace(/[^0-9.,]/g, '').replace(',', '.');
  return parseFloat(cleaned) || 0;
}

function monthsBetween(startStr: string, endStr: string): number {
  if (!startStr || !endStr) return 0;
  const s = new Date(startStr);
  const e = new Date(endStr);
  if (isNaN(s.getTime()) || isNaN(e.getTime())) return 0;
  const diffMs = e.getTime() - s.getTime();
  if (diffMs <= 0) return 0;
  // calc full months + fractional part
  const months = (e.getFullYear() - s.getFullYear()) * 12 + (e.getMonth() - s.getMonth());
  const dayFraction = (e.getDate() - s.getDate()) / 30;
  const total = months + dayFraction;
  return Math.max(total, 0);
}

export default function NewProjectPage() {
  const router = useRouter();
  const { userRole } = useUser();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [assigneeOptions, setAssigneeOptions] = useState<string[]>([]);
  const [assigneeNameToId, setAssigneeNameToId] = useState<Map<string, string>>(new Map());

  useEffect(() => {
    void fetchAssigneeUsers();
  }, []);

  async function fetchAssigneeUsers() {
    try {
      const { data, error } = await supabase
        .from('profiles')
        .select('id, email, full_name');

      if (error) throw error;
      const profiles = (data ?? []) as Array<Pick<UserProfile, 'id' | 'email' | 'full_name'>>;
      setAssigneeOptions(buildAssigneeOptions(profiles));
      // Имя специалиста → id аккаунта, чтобы при СОЗДАНИИ проекта проставлялся
      // specialist_user_id. Без него лид-алерты и авто-передача по проекту молча
      // не работают (раньше линк ставился только в редактировании списка проектов).
      const nameIdMap = new Map<string, string>();
      for (const p of profiles) {
        const name = p.full_name?.trim() || p.email?.split('@')[0]?.trim() || '';
        if (name && p.id) nameIdMap.set(name, p.id);
      }
      setAssigneeNameToId(nameIdMap);
    } catch (fetchError) {
      void logError('projects.assignees.fetch.failed', fetchError);
    }
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
    contacts_obligation: '',
    work_format: '',
    comments: '',
    lead_source: '',
    project_type: '',

    payment_date: '',
    contract_date: '',
    launch_date: '',
  });

  /* brief PDF picked at creation time, uploaded after the project is inserted */
  const [briefFile, setBriefFile] = useState<File | null>(null);
  const [briefUploadStatus, setBriefUploadStatus] = useState<'idle' | 'uploading' | 'done' | 'error'>('idle');
  const [briefUploadError, setBriefUploadError] = useState<string | null>(null);

  /* monthly expense – used only for margin calculation, not persisted separately */
  const [monthlyExpense, setMonthlyExpense] = useState('');
  /* true while margin is driven by the auto formula; false if user overrides */
  const [marginAuto, setMarginAuto] = useState(true);

  /* recalculate margin whenever inputs change */
  const recalcMargin = useCallback(() => {
    if (!marginAuto) return;
    const budget = parseBudgetValue(formData.budget);
    const expense = parseBudgetValue(monthlyExpense);
    const months = monthsBetween(formData.launch_date, formData.deadline);

    if (budget > 0 && months > 0) {
      const totalCost = expense * months;
      const marginPct = ((budget - totalCost) / budget) * 100;
      const rounded = Math.round(marginPct * 10) / 10;          // one decimal
      setFormData((prev) => ({ ...prev, margin: `${rounded}%` }));
    }
  }, [formData.budget, monthlyExpense, formData.launch_date, formData.deadline, marginAuto]);

  useEffect(() => { recalcMargin(); }, [recalcMargin]);

  const statusOptions = [
    'В работе',
    'Тестирование',
    'На паузе',
    'Подготовка',
    'Завершен',
    'Отменен',
  ];

  const handleChange = (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) => {
    const { name, value } = e.target;
    // if user manually edits margin – disable auto-calculation
    if (name === 'margin') {
      setMarginAuto(false);
    }
    setFormData((prev) => ({ ...prev, [name]: value }));
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
          specialist_user_id: formData.specialist
            ? (assigneeNameToId.get(formData.specialist) ?? null)
            : null,
          budget: formData.budget || null,
          margin: formData.margin || null,
          contract_link: formData.contract_link || null,
          handoff_link: formData.handoff_link || null,
          deadline: formData.deadline || null,
          kpi_plan: formData.kpi_plan || null,
          contacts_obligation: formData.contacts_obligation || null,
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

      if (briefFile) {
        setBriefUploadStatus('uploading');
        try {
          const { data: { session } } = await supabase.auth.getSession();
          const formData = new FormData();
          formData.append('file', briefFile);
          const res = await fetch(`/api/projects/${data.id}/brief`, {
            method: 'POST',
            headers: session?.access_token ? { Authorization: `Bearer ${session.access_token}` } : {},
            body: formData,
          });
          if (!res.ok) {
            const payload = await res.json().catch(() => ({}));
            throw new Error(payload.error || `HTTP ${res.status}`);
          }
          setBriefUploadStatus('done');
        } catch (uploadErr) {
          void logError('projects.create.brief_upload_failed', uploadErr, { projectId: data.id });
          setBriefUploadStatus('error');
          setBriefUploadError(
            uploadErr instanceof Error
              ? uploadErr.message
              : 'Не удалось загрузить бриф (проект уже создан, попробуйте загрузить его на странице проекта)',
          );
          // не блокируем переход — бриф можно дозагрузить позже
        }
      }

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

  if (userRole === null) {
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
            <select
              name="manager"
              value={formData.manager}
              onChange={handleChange}
              className="w-full px-4 py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent bg-white"
            >
              <option value="">Не выбрано</option>
              {assigneeOptions.map((option) => (
                <option key={option} value={option}>
                  {option}
                </option>
              ))}
            </select>
            {assigneeOptions.length === 0 && (
              <p className="mt-1 text-xs text-gray-500">Нет зарегистрированных пользователей</p>
            )}
          </div>
        </div>

        {/* Specialist & Platform Row */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">
              Специалист
            </label>
            <select
              name="specialist"
              value={formData.specialist}
              onChange={handleChange}
              className="w-full px-4 py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent bg-white"
            >
              <option value="">Не выбрано</option>
              {assigneeOptions.map((option) => (
                <option key={option} value={option}>
                  {option}
                </option>
              ))}
            </select>
            {assigneeOptions.length === 0 && (
              <p className="mt-1 text-xs text-gray-500">Нет зарегистрированных пользователей</p>
            )}
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

        {/* Budget & Monthly Expense Row */}
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
              Расход в мес (факт)
            </label>
            <input
              type="text"
              value={monthlyExpense}
              onChange={(e) => {
                setMonthlyExpense(e.target.value);
                setMarginAuto(true); // re-enable auto when user edits expense
              }}
              className="w-full px-4 py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
              placeholder="Например: 500"
            />
            <p className="mt-1 text-xs text-gray-400">Ежемесячный расход на проект (инструменты, домены и т.д.)</p>
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

        {/* Contacts obligation */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">
              Обязательство по контактам
            </label>
            <input
              type="text"
              name="contacts_obligation"
              value={formData.contacts_obligation}
              onChange={handleChange}
              className="w-full px-4 py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
              placeholder="Например 4000"
            />
          </div>
        </div>

        {/* Margin (auto-calculated) */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
          <div className="relative">
            <label className="block text-sm font-medium text-gray-700 mb-2">
              Маржа
              {marginAuto && formData.margin && (
                <span className="ml-2 inline-flex items-center gap-1 text-xs font-normal text-green-600 bg-green-50 px-2 py-0.5 rounded-full">
                  <svg className="w-3 h-3" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" /></svg>
                  авто
                </span>
              )}
            </label>
            <input
              type="text"
              name="margin"
              value={formData.margin}
              onChange={handleChange}
              className={`w-full px-4 py-3 border rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent ${
                marginAuto && formData.margin ? 'border-green-300 bg-green-50/40' : 'border-gray-300'
              }`}
              placeholder="Автоматически или вручную"
            />
            {marginAuto && formData.margin ? (
              <p className="mt-1 text-xs text-green-600">
                Рассчитано: (Выручка − Расход × Мес.) / Выручка × 100
              </p>
            ) : !marginAuto ? (
              <button
                type="button"
                onClick={() => { setMarginAuto(true); }}
                className="mt-1 text-xs text-blue-600 hover:underline"
              >
                Вернуть автоматический расчёт
              </button>
            ) : (
              <p className="mt-1 text-xs text-gray-400">
                Заполните выручку, расход в мес, дату запуска и дедлайн для автоматического расчёта
              </p>
            )}
          </div>
          {/* Show breakdown when auto */}
          {marginAuto && formData.margin && formData.budget && (
            <div className="md:col-span-2 bg-gray-50 border border-gray-200 rounded-lg p-4 flex flex-wrap gap-x-8 gap-y-2 text-sm text-gray-600">
              <div>
                <span className="text-gray-400">Выручка:</span>{' '}
                <span className="font-medium text-gray-900">{parseBudgetValue(formData.budget).toLocaleString('ru-RU')} ₽</span>
              </div>
              <div>
                <span className="text-gray-400">Расход/мес:</span>{' '}
                <span className="font-medium text-gray-900">{parseBudgetValue(monthlyExpense).toLocaleString('ru-RU')} ₽</span>
              </div>
              <div>
                <span className="text-gray-400">Срок:</span>{' '}
                <span className="font-medium text-gray-900">{monthsBetween(formData.launch_date, formData.deadline).toFixed(1)} мес.</span>
              </div>
              <div>
                <span className="text-gray-400">Общий расход:</span>{' '}
                <span className="font-medium text-gray-900">
                  {(parseBudgetValue(monthlyExpense) * monthsBetween(formData.launch_date, formData.deadline)).toLocaleString('ru-RU')} ₽
                </span>
              </div>
              <div>
                <span className="text-gray-400">Прибыль:</span>{' '}
                <span className="font-medium text-green-700">
                  {(parseBudgetValue(formData.budget) - parseBudgetValue(monthlyExpense) * monthsBetween(formData.launch_date, formData.deadline)).toLocaleString('ru-RU')} ₽
                </span>
              </div>
            </div>
          )}
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
            Комментарий передачи
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

        {/* Client Brief PDF */}
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-2">
            Бриф клиента (PDF)
            <span className="ml-2 text-xs font-normal text-gray-400">опционально</span>
          </label>
          <ProjectBriefUploader
            file={briefFile}
            onFileChange={setBriefFile}
            disabled={saving}
            hint="После создания проекта бриф будет автоматически загружен и AI один раз сгенерирует гипотезы по сбору базы."
          />
          {briefUploadStatus === 'uploading' && (
            <p className="mt-2 text-xs text-blue-600">Загружаю PDF… AI сгенерирует гипотезы на странице проекта.</p>
          )}
          {briefUploadStatus === 'error' && briefUploadError && (
            <p className="mt-2 text-xs text-red-600">{briefUploadError}</p>
          )}
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
