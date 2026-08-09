'use client';

import {
  CalendarDays,
  ChevronLeft,
  ChevronRight,
  Pencil,
  Plus,
  RefreshCw,
  Trash2,
  X,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  buildTeamActivityPlanWrite,
  formatTeamActivityPlanMonth,
  formatRussianDate,
  localIsoDate,
  normalizeActivityPlan,
  shiftTeamActivityPlanMonth,
  TeamApiError,
  teamApiFetch,
  type TeamActivityPlanInput,
  type TeamActivityPlanItem,
  type TeamActivityPlanResponse,
  type TeamActivityPlanStatus,
  type TeamActivityPlanTimingType,
  type TeamActivityPlanWrite,
} from './teamApi';

interface ActivityFormState {
  timingType: TeamActivityPlanTimingType;
  periodicity: string;
  activity: string;
  format: string;
  plannedDate: string;
  plannedTime: string;
  scheduleNote: string;
  note: string;
  budgetAmount: string;
  budgetNote: string;
  status: TeamActivityPlanStatus;
}

interface EditorState {
  item: TeamActivityPlanItem;
  conflicted: boolean;
}

const EMPTY_FORM: ActivityFormState = {
  timingType: 'date',
  periodicity: '',
  activity: '',
  format: '',
  plannedDate: '',
  plannedTime: '',
  scheduleNote: '',
  note: '',
  budgetAmount: '',
  budgetNote: '',
  status: 'planned',
};

const INPUT_CLASS = 'h-11 w-full rounded-xl border border-gray-200 bg-white px-3 text-sm text-gray-900 outline-none placeholder:text-gray-500 focus:border-blue-500 focus:ring-2 focus:ring-blue-500/20 disabled:cursor-not-allowed disabled:opacity-60';
const TEXTAREA_CLASS = 'w-full resize-y rounded-xl border border-gray-200 bg-white px-3 py-2.5 text-sm leading-6 text-gray-900 outline-none placeholder:text-gray-500 focus:border-blue-500 focus:ring-2 focus:ring-blue-500/20 disabled:cursor-not-allowed disabled:opacity-60';
const ACTIVITY_CONFLICT_MESSAGE = 'Эту активность уже изменили. Ваш черновик остался в форме. Скопируйте нужные изменения, затем нажмите «Отмена», чтобы загрузить актуальную версию.';

function itemFormState(item: TeamActivityPlanItem): ActivityFormState {
  return {
    timingType: item.plannedDate ? 'date' : item.scheduleNote ? 'schedule' : 'none',
    periodicity: item.periodicity,
    activity: item.activity,
    format: item.format || '',
    plannedDate: item.plannedDate || '',
    plannedTime: item.plannedTime || '',
    scheduleNote: item.scheduleNote || '',
    note: item.note || '',
    budgetAmount: item.budgetAmount === null ? '' : String(item.budgetAmount),
    budgetNote: item.budgetNote || '',
    status: item.status,
  };
}

function budgetLabel(amount: number): string {
  return `${new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 2 }).format(amount)} ₽`;
}

function plannedWhen(item: TeamActivityPlanItem): string {
  if (item.plannedDate) {
    const date = formatRussianDate(item.plannedDate);
    return item.plannedTime ? `${date}, ${item.plannedTime}` : date;
  }
  return item.scheduleNote || 'Не указано';
}

function isOverdue(item: TeamActivityPlanItem, today: string): boolean {
  return item.status === 'planned'
    && Boolean(item.plannedDate)
    && String(item.plannedDate) < today;
}

function statusPresentation(item: TeamActivityPlanItem, today: string) {
  if (item.status === 'completed') {
    return { label: 'Выполнено', className: 'bg-emerald-50 text-emerald-700' };
  }
  if (item.status === 'cancelled') {
    return { label: 'Отменено', className: 'bg-gray-100 text-gray-600' };
  }
  if (isOverdue(item, today)) {
    return { label: 'Просрочено', className: 'bg-amber-50 text-amber-800' };
  }
  return { label: 'В плане', className: 'bg-blue-50 text-blue-700' };
}

function ActivityStatus({ item, today }: { item: TeamActivityPlanItem; today: string }) {
  const status = statusPresentation(item, today);
  return (
    <span className={`inline-flex whitespace-nowrap rounded-full px-2.5 py-1 text-xs font-semibold ${status.className}`}>
      {status.label}
    </span>
  );
}

function ActivityForm({
  initial,
  mode,
  saving,
  error,
  onCancel,
  onSubmit,
  onDelete,
}: {
  initial: ActivityFormState;
  mode: 'create' | 'edit';
  saving: boolean;
  error: string;
  onCancel: () => void;
  onSubmit: (values: ActivityFormState) => Promise<void>;
  onDelete?: () => Promise<void>;
}) {
  const [values, setValues] = useState(initial);
  const [validationError, setValidationError] = useState('');
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const deleteButtonRef = useRef<HTMLButtonElement>(null);
  const confirmDeleteButtonRef = useRef<HTMLButtonElement>(null);
  const restoreDeleteFocusRef = useRef(false);

  useEffect(() => {
    if (confirmingDelete) {
      confirmDeleteButtonRef.current?.focus();
      return;
    }
    if (restoreDeleteFocusRef.current) {
      restoreDeleteFocusRef.current = false;
      deleteButtonRef.current?.focus();
    }
  }, [confirmingDelete]);

  const update = <K extends keyof ActivityFormState>(key: K, value: ActivityFormState[K]) => {
    setValues((current) => ({ ...current, [key]: value }));
  };

  const submit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!values.periodicity.trim() || !values.activity.trim()) {
      setValidationError('Заполните периодичность и название активности.');
      return;
    }
    if (values.timingType === 'date' && !values.plannedDate) {
      setValidationError('Укажите плановую дату.');
      return;
    }
    if (values.timingType === 'schedule' && !values.scheduleNote.trim()) {
      setValidationError('Опишите расписание активности.');
      return;
    }
    if (values.budgetAmount && Number(values.budgetAmount) < 0) {
      setValidationError('Бюджет не может быть отрицательным.');
      return;
    }
    setValidationError('');
    await onSubmit(values);
  };

  return (
    <form
      aria-label={mode === 'create' ? 'Создание активности' : 'Редактирование активности'}
      onSubmit={submit}
      className="w-full min-w-0 space-y-5 rounded-xl bg-gray-50 p-4 sm:p-5"
    >
      <div className="flex items-start justify-between gap-4">
        <div>
          <h3 className="text-base font-semibold text-gray-900">
            {mode === 'create' ? 'Новая активность' : 'Редактирование'}
          </h3>
          <p className="mt-1 text-sm text-gray-500">
            Дата может находиться за пределами выбранного месяца.
          </p>
        </div>
        <button
          type="button"
          onClick={onCancel}
          disabled={saving}
          aria-label="Закрыть форму"
          className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-lg text-gray-500 outline-none hover:bg-gray-200 focus-visible:ring-2 focus-visible:ring-blue-500 disabled:opacity-50"
        >
          <X aria-hidden="true" size={18} />
        </button>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <label className="block">
          <span className="mb-1.5 block text-sm font-medium text-gray-700">Периодичность</span>
          <input
            autoFocus
            required
            maxLength={100}
            value={values.periodicity}
            onChange={(event) => update('periodicity', event.target.value)}
            disabled={saving}
            placeholder="Например, еженедельно"
            className={INPUT_CLASS}
          />
        </label>
        <label className="block">
          <span className="mb-1.5 block text-sm font-medium text-gray-700">Активность</span>
          <input
            required
            maxLength={500}
            value={values.activity}
            onChange={(event) => update('activity', event.target.value)}
            disabled={saving}
            placeholder="Что планируем"
            className={INPUT_CLASS}
          />
        </label>
        <label className="block lg:col-span-2">
          <span className="mb-1.5 block text-sm font-medium text-gray-700">Формат</span>
          <input
            maxLength={500}
            value={values.format}
            onChange={(event) => update('format', event.target.value)}
            disabled={saving}
            placeholder="Телемост, пост в чате, онлайн-встреча"
            className={INPUT_CLASS}
          />
        </label>
      </div>

      <fieldset disabled={saving}>
        <legend className="mb-2 text-sm font-medium text-gray-700">Когда состоится</legend>
        <div className="mb-3 flex flex-wrap gap-x-6 gap-y-2">
          {([['date', 'Точная дата'], ['schedule', 'Расписание'], ['none', 'Без даты']] as const).map(([value, label]) => (
            <label key={value} className="inline-flex min-h-11 cursor-pointer items-center gap-2 text-sm font-medium text-gray-700">
              <input
                type="radio"
                name="activity-timing-type"
                value={value}
                checked={values.timingType === value}
                onChange={() => update('timingType', value)}
                className="h-4 w-4 accent-blue-600 focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2"
              />
              {label}
            </label>
          ))}
        </div>
        {values.timingType === 'date' ? (
          <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_10rem]">
            <label className="block">
              <span className="mb-1.5 block text-sm font-medium text-gray-700">Плановая дата</span>
              <input
                type="date"
                required
                value={values.plannedDate}
                onChange={(event) => update('plannedDate', event.target.value)}
                className={INPUT_CLASS}
              />
            </label>
            <label className="block">
              <span className="mb-1.5 block text-sm font-medium text-gray-700">Время</span>
              <input
                type="time"
                value={values.plannedTime}
                onChange={(event) => update('plannedTime', event.target.value)}
                className={INPUT_CLASS}
              />
            </label>
          </div>
        ) : values.timingType === 'schedule' ? (
          <label className="block">
            <span className="mb-1.5 block text-sm font-medium text-gray-700">Расписание</span>
            <input
              required
              maxLength={500}
              value={values.scheduleNote}
              onChange={(event) => update('scheduleNote', event.target.value)}
              placeholder="Например, каждую среду, 14:00"
              className={INPUT_CLASS}
            />
          </label>
        ) : (
          <p className="text-sm text-gray-500">
            Активность останется в плане, а дату можно добавить позже.
          </p>
        )}
      </fieldset>

      <div className="grid gap-4 lg:grid-cols-2">
        <label className="block lg:col-span-2">
          <span className="mb-1.5 block text-sm font-medium text-gray-700">Примечание</span>
          <textarea
            rows={3}
            maxLength={5000}
            value={values.note}
            onChange={(event) => update('note', event.target.value)}
            disabled={saving}
            placeholder="Контекст, ответственные, ожидаемый результат"
            className={TEXTAREA_CLASS}
          />
        </label>
        <label className="block">
          <span className="mb-1.5 block text-sm font-medium text-gray-700">Бюджет, ₽</span>
          <input
            type="number"
            min="0"
            step="0.01"
            value={values.budgetAmount}
            onChange={(event) => update('budgetAmount', event.target.value)}
            disabled={saving}
            placeholder="0"
            className={INPUT_CLASS}
          />
        </label>
        <label className="block">
          <span className="mb-1.5 block text-sm font-medium text-gray-700">Комментарий к бюджету</span>
          <input
            maxLength={500}
            value={values.budgetNote}
            onChange={(event) => update('budgetNote', event.target.value)}
            disabled={saving}
            placeholder="Например, две премии по 700 ₽"
            className={INPUT_CLASS}
          />
        </label>
        {mode === 'edit' && (
          <label className="block">
            <span className="mb-1.5 block text-sm font-medium text-gray-700">Статус</span>
            <select
              value={values.status}
              onChange={(event) => update('status', event.target.value as TeamActivityPlanStatus)}
              disabled={saving}
              className={INPUT_CLASS}
            >
              <option value="planned">В плане</option>
              <option value="completed">Выполнено</option>
              <option value="cancelled">Отменено</option>
            </select>
          </label>
        )}
      </div>

      {(validationError || error) && (
        <p role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">
          {validationError || error}
        </p>
      )}

      <div className="flex flex-wrap items-center justify-end gap-2 border-t border-gray-200 pt-4">
        {mode === 'edit' && onDelete && (
          confirmingDelete ? (
            <div className="mr-auto flex flex-wrap items-center gap-2" role="group" aria-label="Подтверждение удаления">
              <span className="text-sm text-gray-600">Удалить эту активность?</span>
              <button
                ref={confirmDeleteButtonRef}
                type="button"
                disabled={saving}
                onClick={() => void onDelete()}
                className="min-h-11 rounded-lg bg-red-600 px-3 text-sm font-semibold text-white outline-none hover:bg-red-700 focus-visible:ring-2 focus-visible:ring-red-500 disabled:opacity-50"
              >
                Да, удалить
              </button>
              <button
                type="button"
                disabled={saving}
                onClick={() => {
                  restoreDeleteFocusRef.current = true;
                  setConfirmingDelete(false);
                }}
                className="min-h-11 rounded-lg px-3 text-sm font-medium text-gray-600 outline-none hover:bg-gray-200 focus-visible:ring-2 focus-visible:ring-blue-500"
              >
                Не удалять
              </button>
            </div>
          ) : (
            <button
              ref={deleteButtonRef}
              type="button"
              disabled={saving}
              onClick={() => setConfirmingDelete(true)}
              className="mr-auto inline-flex min-h-11 items-center gap-2 rounded-lg px-3 text-sm font-medium text-red-700 outline-none hover:bg-red-50 focus-visible:ring-2 focus-visible:ring-red-500 disabled:opacity-50"
            >
              <Trash2 aria-hidden="true" size={16} />
              Удалить
            </button>
          )
        )}
        <button
          type="button"
          onClick={onCancel}
          disabled={saving}
          className="min-h-11 rounded-lg border border-gray-200 bg-white px-4 text-sm font-medium text-gray-700 outline-none hover:bg-gray-100 focus-visible:ring-2 focus-visible:ring-blue-500 disabled:opacity-50"
        >
          Отмена
        </button>
        <button
          type="submit"
          disabled={saving}
          className="inline-flex min-h-11 items-center justify-center rounded-lg bg-gray-900 px-4 text-sm font-semibold text-white outline-none hover:bg-gray-800 focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2 disabled:cursor-wait disabled:opacity-60"
        >
          {saving ? 'Сохраняем…' : mode === 'create' ? 'Добавить' : 'Сохранить изменения'}
        </button>
      </div>
    </form>
  );
}

function Summary({ response }: { response: TeamActivityPlanResponse }) {
  const values = [
    ['Всего', response.summary.total],
    ['В плане', response.summary.planned],
    ['Выполнено', response.summary.completed],
    ['Просрочено', response.summary.overdue],
  ] as const;

  return (
    <section aria-label="Итоги месяца" role="region" className="border-y border-gray-200">
      <dl className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-6">
        {values.map(([label, value]) => (
          <div key={label} className="border-b border-gray-100 px-4 py-3 last:border-b-0 md:border-b-0 md:border-r">
            <dt className="text-xs font-medium uppercase tracking-wide text-gray-500">{label}</dt>
            <dd className="mt-1 text-lg font-semibold tabular-nums text-gray-900">{value}</dd>
          </div>
        ))}
        <div className="border-b border-gray-100 px-4 py-3 md:border-b-0 md:border-r">
          <dt className="text-xs font-medium uppercase tracking-wide text-gray-500">Бюджет</dt>
          <dd className="mt-1 text-lg font-semibold tabular-nums text-gray-900">
            {budgetLabel(response.summary.budgetAmount)}
          </dd>
        </div>
        <div className="px-4 py-3">
          <dt className="text-xs font-medium uppercase tracking-wide text-gray-500">Без суммы</dt>
          <dd className="mt-1 text-lg font-semibold tabular-nums text-gray-900">
            {response.summary.budgetUnspecified}
          </dd>
        </div>
      </dl>
    </section>
  );
}

function buildWrite(
  values: ActivityFormState,
  planMonth: string,
  position: number,
): TeamActivityPlanWrite {
  const input: TeamActivityPlanInput = {
    ...values,
    planMonth,
    position,
  };
  return buildTeamActivityPlanWrite(input);
}

export default function TeamActivityPlanPanel() {
  const browserToday = localIsoDate();
  const [selectedMonth, setSelectedMonth] = useState(() => browserToday.slice(0, 7));
  const [response, setResponse] = useState<TeamActivityPlanResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [createOpen, setCreateOpen] = useState(false);
  const [editor, setEditor] = useState<EditorState | null>(null);
  const [saving, setSaving] = useState(false);
  const [submitError, setSubmitError] = useState('');
  const requestSequence = useRef(0);
  const createButtonRef = useRef<HTMLButtonElement>(null);
  const editButtonRefs = useRef(new Map<string, HTMLButtonElement>());

  const load = useCallback(async () => {
    const requestId = ++requestSequence.current;
    setLoading(true);
    setLoadError('');
    try {
      const payload = await teamApiFetch(`/api/team/activity-plan?month=${selectedMonth}`);
      if (requestId !== requestSequence.current) return;
      setResponse(normalizeActivityPlan(payload));
    } catch {
      if (requestId !== requestSequence.current) return;
      setLoadError('Не удалось загрузить план активностей. Проверьте соединение и попробуйте снова.');
    } finally {
      if (requestId === requestSequence.current) setLoading(false);
    }
  }, [selectedMonth]);

  useEffect(() => {
    let cancelled = false;
    queueMicrotask(() => {
      if (!cancelled) void load();
    });
    return () => {
      cancelled = true;
    };
  }, [load]);

  const nextPosition = useMemo(() => (
    (response?.items.reduce((maximum, item) => Math.max(maximum, item.position), -1) ?? -1) + 1
  ), [response?.items]);

  const restoreCreateFocus = () => {
    queueMicrotask(() => createButtonRef.current?.focus());
  };

  const restoreEditFocus = (itemId: string) => {
    queueMicrotask(() => editButtonRefs.current.get(itemId)?.focus());
  };

  const closeCreate = () => {
    if (saving) return;
    setCreateOpen(false);
    setSubmitError('');
    restoreCreateFocus();
  };

  const closeEditor = async () => {
    if (!editor || saving) return;
    const { item, conflicted } = editor;
    setEditor(null);
    setSubmitError('');
    if (conflicted) await load();
    restoreEditFocus(item.id);
  };

  const createItem = async (values: ActivityFormState) => {
    setSaving(true);
    setSubmitError('');
    try {
      await teamApiFetch('/api/team/activity-plan', {
        method: 'POST',
        body: JSON.stringify(buildWrite(values, selectedMonth, nextPosition)),
      });
      setCreateOpen(false);
      await load();
      restoreCreateFocus();
    } catch (error) {
      setSubmitError(error instanceof Error ? error.message : 'Не удалось сохранить активность.');
    } finally {
      setSaving(false);
    }
  };

  const updateItem = async (values: ActivityFormState) => {
    if (!editor) return;
    const current = editor.item;
    setSaving(true);
    setSubmitError('');
    try {
      await teamApiFetch(`/api/team/activity-plan/${current.id}`, {
        method: 'PATCH',
        body: JSON.stringify({
          ...buildWrite(values, current.planMonth, current.position),
          expectedUpdatedAt: current.updatedAt,
        }),
      });
      setEditor(null);
      await load();
      restoreEditFocus(current.id);
    } catch (error) {
      if (error instanceof TeamApiError && error.code === 'activity_plan_conflict') {
        setEditor((active) => active ? { ...active, conflicted: true } : active);
        setSubmitError(ACTIVITY_CONFLICT_MESSAGE);
      } else {
        setSubmitError(error instanceof Error ? error.message : 'Не удалось сохранить изменения.');
      }
    } finally {
      setSaving(false);
    }
  };

  const deleteItem = async () => {
    if (!editor) return;
    const current = editor.item;
    setSaving(true);
    setSubmitError('');
    try {
      await teamApiFetch(`/api/team/activity-plan/${current.id}`, {
        method: 'DELETE',
        body: JSON.stringify({ expectedUpdatedAt: current.updatedAt }),
      });
      setEditor(null);
      await load();
      restoreCreateFocus();
    } catch (error) {
      if (error instanceof TeamApiError && error.code === 'activity_plan_conflict') {
        setEditor((active) => active ? { ...active, conflicted: true } : active);
        setSubmitError(ACTIVITY_CONFLICT_MESSAGE);
      } else {
        setSubmitError(error instanceof Error ? error.message : 'Не удалось удалить активность.');
      }
    } finally {
      setSaving(false);
    }
  };

  const openCreate = () => {
    setEditor(null);
    setSubmitError('');
    setCreateOpen(true);
  };

  const openEditor = (item: TeamActivityPlanItem) => {
    setCreateOpen(false);
    setSubmitError('');
    setEditor({ item, conflicted: false });
  };

  const canManage = response?.canManage === true;
  const items = response?.items || [];
  const asOf = response?.asOf || browserToday;
  const selectedMonthLabel = response?.period.month === selectedMonth && response.period.label
    ? response.period.label
    : formatTeamActivityPlanMonth(selectedMonth);
  const activeFormMode = createOpen ? 'create' : editor ? 'edit' : null;
  const activeFormItem = editor?.item ?? null;

  return (
    <section
      role="region"
      aria-label="План активностей"
      aria-busy={loading || saving}
      className="min-w-0 overflow-hidden rounded-2xl border border-gray-200 bg-white text-gray-900"
    >
      <header className="flex flex-col gap-4 px-4 py-5 sm:px-6 lg:flex-row lg:items-center lg:justify-between">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <CalendarDays aria-hidden="true" className="text-gray-400" size={19} />
            <h2 className="text-xl font-bold tracking-tight">План активностей</h2>
          </div>
          <p className="mt-1 max-w-[70ch] text-sm text-gray-500">
            Регулярные встречи, внутренние события и бюджет в одном месячном плане.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <nav aria-label="Месяцы плана" className="flex min-h-11 items-center rounded-xl border border-gray-200 bg-gray-50 p-1">
            <button
              type="button"
              aria-label="Предыдущий месяц"
              disabled={loading || !response || activeFormMode !== null}
              onClick={() => setSelectedMonth((month) => shiftTeamActivityPlanMonth(month, -1))}
              className="inline-flex h-9 w-9 items-center justify-center rounded-lg text-gray-500 outline-none hover:bg-white hover:text-gray-900 focus-visible:ring-2 focus-visible:ring-blue-500 disabled:opacity-40"
            >
              <ChevronLeft aria-hidden="true" size={18} />
            </button>
            <span className="min-w-36 px-2 text-center text-sm font-semibold text-gray-800">
              {selectedMonthLabel || 'Месяц'}
            </span>
            <button
              type="button"
              aria-label="Следующий месяц"
              disabled={loading || !response || activeFormMode !== null}
              onClick={() => setSelectedMonth((month) => shiftTeamActivityPlanMonth(month, 1))}
              className="inline-flex h-9 w-9 items-center justify-center rounded-lg text-gray-500 outline-none hover:bg-white hover:text-gray-900 focus-visible:ring-2 focus-visible:ring-blue-500 disabled:opacity-40"
            >
              <ChevronRight aria-hidden="true" size={18} />
            </button>
          </nav>
          {canManage && !createOpen && !editor && (
            <button
              ref={createButtonRef}
              type="button"
              onClick={openCreate}
              className="inline-flex min-h-11 items-center justify-center gap-2 rounded-xl bg-gray-900 px-4 text-sm font-semibold text-white outline-none hover:bg-gray-800 focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2"
            >
              <Plus aria-hidden="true" size={17} />
              Добавить активность
            </button>
          )}
        </div>
      </header>

      {activeFormMode && (
        <div className="min-w-0 max-w-full border-t border-gray-200 px-3 py-4 sm:px-6">
          <ActivityForm
            key={activeFormItem ? `edit-${activeFormItem.id}-${activeFormItem.updatedAt}` : 'create'}
            initial={activeFormItem ? itemFormState(activeFormItem) : EMPTY_FORM}
            mode={activeFormMode}
            saving={saving}
            error={submitError}
            onCancel={activeFormMode === 'create' ? closeCreate : () => void closeEditor()}
            onSubmit={activeFormMode === 'create' ? createItem : updateItem}
            onDelete={activeFormMode === 'edit' ? deleteItem : undefined}
          />
        </div>
      )}

      {loading && !response ? (
        <div role="status" aria-live="polite" className="flex min-h-48 items-center justify-center gap-2 border-t border-gray-200 text-sm text-gray-500">
          <RefreshCw aria-hidden="true" className="animate-spin" size={17} />
          Загружаем план активностей
        </div>
      ) : loadError ? (
        <div className="border-t border-gray-200 px-4 py-10 text-center sm:px-6">
          <p role="alert" className="text-sm text-red-700">{loadError}</p>
          <button
            type="button"
            onClick={() => void load()}
            className="mt-4 inline-flex min-h-11 items-center gap-2 rounded-lg border border-gray-200 bg-white px-4 text-sm font-semibold text-gray-700 outline-none hover:bg-gray-100 focus-visible:ring-2 focus-visible:ring-blue-500"
          >
            <RefreshCw aria-hidden="true" size={16} />
            Попробовать снова
          </button>
        </div>
      ) : response ? (
        <>
          <Summary response={response} />
          {items.length === 0 ? (
            <div className="px-4 py-14 text-center sm:px-6">
              <CalendarDays aria-hidden="true" className="mx-auto text-gray-300" size={28} />
              <h3 className="mt-3 text-base font-semibold text-gray-900">
                В этом месяце пока нет активностей
              </h3>
              <p className="mx-auto mt-1 max-w-md text-sm text-gray-500">
                Добавьте первую встречу, событие или регулярную инициативу.
              </p>
            </div>
          ) : (
            <div
              role="region"
              aria-label="Таблица активностей"
              tabIndex={0}
              className="max-w-full overflow-x-auto overscroll-x-contain outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-blue-500"
            >
              <table aria-label={`Активности за ${selectedMonthLabel}`} className="min-w-[1180px] w-full border-collapse text-left text-sm">
                <thead className="bg-gray-50 text-xs uppercase tracking-wide text-gray-500">
                  <tr>
                    <th scope="col" className="w-36 px-4 py-3 font-semibold">Периодичность</th>
                    <th scope="col" className="min-w-64 px-4 py-3 font-semibold">Активность</th>
                    <th scope="col" className="w-48 px-4 py-3 font-semibold">Формат</th>
                    <th scope="col" className="w-52 px-4 py-3 font-semibold">Дата или расписание</th>
                    <th scope="col" className="min-w-64 px-4 py-3 font-semibold">Примечание</th>
                    <th scope="col" className="w-44 px-4 py-3 font-semibold">Бюджет</th>
                    <th scope="col" className="w-32 px-4 py-3 font-semibold">Статус</th>
                    <th scope="col" className="w-16 px-4 py-3 font-semibold"><span className="sr-only">Действия</span></th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {items.map((item) => {
                    const editing = editor?.item.id === item.id;
                    return (
                      <tr
                        key={item.id}
                        aria-current={editing ? 'true' : undefined}
                        className={`align-top hover:bg-gray-50/70 ${editing ? 'bg-gray-50' : ''}`}
                      >
                            <td className="px-4 py-4 font-medium text-gray-700">{item.periodicity}</td>
                            <td className="px-4 py-4">
                              <p className="font-semibold text-gray-900 [overflow-wrap:anywhere]">{item.activity}</p>
                            </td>
                            <td className="px-4 py-4 text-gray-600 [overflow-wrap:anywhere]">{item.format || 'Не указано'}</td>
                            <td className="px-4 py-4 font-medium text-gray-700">{plannedWhen(item)}</td>
                            <td className="px-4 py-4 text-gray-600 [overflow-wrap:anywhere]">{item.note || 'Не указано'}</td>
                            <td className="px-4 py-4">
                              <p className="font-semibold tabular-nums text-gray-800">
                                {item.budgetAmount === null ? 'Сумма не указана' : budgetLabel(item.budgetAmount)}
                              </p>
                              {item.budgetNote && <p className="mt-1 text-xs text-gray-500 [overflow-wrap:anywhere]">{item.budgetNote}</p>}
                            </td>
                            <td className="px-4 py-4"><ActivityStatus item={item} today={asOf} /></td>
                            <td className="px-4 py-3 text-right">
                              {canManage && (
                                <button
                                  ref={(node) => {
                                    if (node) editButtonRefs.current.set(item.id, node);
                                    else editButtonRefs.current.delete(item.id);
                                  }}
                                  type="button"
                                  aria-label={`Редактировать активность ${item.activity}`}
                                  onClick={() => openEditor(item)}
                                  className="inline-flex h-11 w-11 items-center justify-center rounded-lg text-gray-500 outline-none hover:bg-gray-100 hover:text-gray-900 focus-visible:ring-2 focus-visible:ring-blue-500"
                                >
                                  <Pencil aria-hidden="true" size={16} />
                                </button>
                              )}
                            </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </>
      ) : null}
    </section>
  );
}
