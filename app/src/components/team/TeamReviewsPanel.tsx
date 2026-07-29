'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown, Pencil, Plus, RefreshCw, Search, X } from 'lucide-react';
import { ROLE_LABELS } from '@/lib/roles';
import type { UserRole } from '@/types';
import {
  buildTeamReviewWrite,
  formatRussianDate,
  localIsoDate,
  normalizeReviews,
  teamApiFetch,
  type TeamReviewEmployee,
  type TeamReviewsResponse,
  type TeamReviewWrite,
} from './teamApi';

interface ReviewFormState {
  reviewDate: string;
  employeeUserId: string;
  outcomes: string;
  problems: string;
  recommendations: string;
}

const EMPTY_FORM: ReviewFormState = {
  reviewDate: '',
  employeeUserId: '',
  outcomes: '',
  problems: '',
  recommendations: '',
};

function employeeRole(employee: TeamReviewEmployee): string {
  const role = employee.role as UserRole | null;
  return role && role in ROLE_LABELS ? ROLE_LABELS[role] : employee.role || 'Сотрудник';
}

function EmployeeAvatar({ employee }: { employee: TeamReviewEmployee }) {
  const [failed, setFailed] = useState(false);
  const initial = employee.name.trim().charAt(0).toUpperCase() || '?';
  return (
    <span className="flex h-9 w-9 shrink-0 items-center justify-center overflow-hidden rounded-full border border-gray-200 bg-gray-100 text-sm font-semibold text-gray-600">
      {employee.avatarUrl && !failed ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={employee.avatarUrl}
          alt=""
          className="h-full w-full object-cover"
          loading="lazy"
          decoding="async"
          onError={() => setFailed(true)}
        />
      ) : initial}
    </span>
  );
}

function ReviewForm({
  employees,
  initial,
  mode,
  saving,
  error,
  onCancel,
  onSubmit,
}: {
  employees: TeamReviewEmployee[];
  initial?: ReviewFormState;
  mode: 'create' | 'edit';
  saving: boolean;
  error: string;
  onCancel: () => void;
  onSubmit: (values: ReviewFormState) => Promise<void>;
}) {
  const [values, setValues] = useState<ReviewFormState>(() => initial || {
    ...EMPTY_FORM,
    reviewDate: localIsoDate(),
  });
  const [validationError, setValidationError] = useState('');

  const update = <K extends keyof ReviewFormState>(key: K, value: ReviewFormState[K]) => {
    setValues((current) => ({ ...current, [key]: value }));
  };

  const submit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!values.reviewDate || !values.employeeUserId || !values.outcomes.trim()) {
      setValidationError('Укажите дату, сотрудника и основные итоги.');
      return;
    }
    setValidationError('');
    await onSubmit(values);
  };

  return (
    <form onSubmit={submit} className="space-y-5" aria-label={mode === 'create' ? 'Новое ревью' : 'Редактирование ревью'}>
      <div className="grid gap-4 lg:grid-cols-2">
        <label className="block">
          <span className="mb-1.5 block text-sm font-medium text-gray-700">Дата ревью</span>
          <input
            type="date"
            autoFocus
            value={values.reviewDate}
            onChange={(event) => update('reviewDate', event.target.value)}
            required
            className="h-11 w-full rounded-xl border border-gray-200 bg-white px-3 text-sm text-gray-900 outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-100"
          />
        </label>
        <label className="block">
          <span className="mb-1.5 block text-sm font-medium text-gray-700">Сотрудник</span>
          <select
            value={values.employeeUserId}
            onChange={(event) => update('employeeUserId', event.target.value)}
            required
            className="h-11 w-full rounded-xl border border-gray-200 bg-white px-3 text-sm text-gray-900 outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-100"
          >
            <option value="">Выберите сотрудника</option>
            {employees.map((employee) => (
              <option key={employee.id} value={employee.id}>
                {employee.name}{employee.email ? `, ${employee.email}` : ''}
              </option>
            ))}
          </select>
        </label>
      </div>

      <label className="block">
        <span className="mb-1.5 block text-sm font-medium text-gray-700">Основные итоги</span>
        <textarea
          value={values.outcomes}
          onChange={(event) => update('outcomes', event.target.value)}
          required
          rows={4}
          maxLength={5000}
          placeholder="Что получилось, какой прогресс заметен"
          className="w-full resize-y rounded-xl border border-gray-200 bg-white px-3 py-2.5 text-sm leading-6 text-gray-900 outline-none placeholder:text-gray-400 focus:border-blue-500 focus:ring-2 focus:ring-blue-100"
        />
      </label>

      <div className="grid gap-4 lg:grid-cols-2">
        <label className="block">
          <span className="mb-1.5 block text-sm font-medium text-gray-700">Зоны внимания</span>
          <textarea
            value={values.problems}
            onChange={(event) => update('problems', event.target.value)}
            rows={4}
            maxLength={5000}
            placeholder="Что мешает работе или требует поддержки"
            className="w-full resize-y rounded-xl border border-gray-200 bg-white px-3 py-2.5 text-sm leading-6 text-gray-900 outline-none placeholder:text-gray-400 focus:border-blue-500 focus:ring-2 focus:ring-blue-100"
          />
        </label>
        <label className="block">
          <span className="mb-1.5 block text-sm font-medium text-gray-700">Рекомендации</span>
          <textarea
            value={values.recommendations}
            onChange={(event) => update('recommendations', event.target.value)}
            rows={4}
            maxLength={5000}
            placeholder="Следующие шаги, поддержка и договорённости"
            className="w-full resize-y rounded-xl border border-gray-200 bg-white px-3 py-2.5 text-sm leading-6 text-gray-900 outline-none placeholder:text-gray-400 focus:border-blue-500 focus:ring-2 focus:ring-blue-100"
          />
        </label>
      </div>

      {(validationError || error) && (
        <p className="text-sm text-red-700" role="alert">{validationError || error}</p>
      )}

      <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
        <button
          type="button"
          onClick={onCancel}
          disabled={saving}
          className="min-h-11 rounded-xl border border-gray-200 bg-white px-4 text-sm font-medium text-gray-700 outline-none hover:bg-gray-50 focus-visible:ring-2 focus-visible:ring-blue-500 disabled:opacity-50"
        >
          Отмена
        </button>
        <button
          type="submit"
          disabled={saving}
          className="inline-flex min-h-11 items-center justify-center rounded-xl bg-gray-900 px-4 text-sm font-semibold text-white outline-none hover:bg-gray-800 focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2 disabled:cursor-wait disabled:opacity-60"
        >
          {saving ? 'Сохраняем…' : mode === 'create' ? 'Сохранить ревью' : 'Сохранить изменения'}
        </button>
      </div>
    </form>
  );
}

function ReviewSection({ title, text }: { title: string; text: string }) {
  return (
    <section>
      <h4 className="text-xs font-semibold uppercase tracking-wide text-gray-500">{title}</h4>
      <p className={`mt-1.5 whitespace-pre-wrap text-sm leading-6 ${text ? 'text-gray-800' : 'text-gray-400'}`}>
        {text || 'Не указано'}
      </p>
    </section>
  );
}

function ReviewSkeleton() {
  return (
    <div className="overflow-hidden rounded-2xl border border-gray-200 bg-white" aria-label="Загрузка ревью">
      {[0, 1, 2].map((item) => (
        <div key={item} className="flex h-20 items-center gap-3 border-b border-gray-100 px-5 last:border-0">
          <span className="h-9 w-9 animate-pulse rounded-full bg-gray-100" />
          <span className="h-4 w-40 animate-pulse rounded bg-gray-100" />
          <span className="ml-auto h-4 w-24 animate-pulse rounded bg-gray-100" />
        </div>
      ))}
    </div>
  );
}

export default function TeamReviewsPanel() {
  const [data, setData] = useState<TeamReviewsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [actionError, setActionError] = useState('');
  const [saving, setSaving] = useState(false);
  const [creating, setCreating] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [query, setQuery] = useState('');
  const [employeeFilter, setEmployeeFilter] = useState('all');
  const [yearFilter, setYearFilter] = useState('all');
  const [requestVersion, setRequestVersion] = useState(0);
  const createButtonRef = useRef<HTMLButtonElement>(null);
  const reviewButtonRefs = useRef(new Map<string, HTMLButtonElement>());

  const restoreFocus = (reviewId?: string) => {
    window.requestAnimationFrame(() => {
      if (reviewId) reviewButtonRefs.current.get(reviewId)?.focus();
      else createButtonRef.current?.focus();
    });
  };

  const load = useCallback(async () => {
    setError('');
    try {
      const payload = await teamApiFetch('/api/team/reviews');
      setData(normalizeReviews(payload));
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : 'Не удалось загрузить ревью.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    // Loading starts from an external API boundary; the callback owns all state updates.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load, requestVersion]);

  const years = useMemo(() => {
    const values = new Set<number>([new Date().getFullYear()]);
    data?.reviews.forEach((review) => {
      const year = Number(review.reviewDate.slice(0, 4));
      if (Number.isFinite(year) && year > 2000) values.add(year);
    });
    return Array.from(values).sort((a, b) => b - a);
  }, [data?.reviews]);

  const filteredReviews = useMemo(() => {
    const normalizedQuery = query.trim().toLocaleLowerCase('ru-RU');
    return (data?.reviews || []).filter((review) => {
      if (employeeFilter !== 'all' && review.employee.id !== employeeFilter) return false;
      if (yearFilter !== 'all' && review.reviewDate.slice(0, 4) !== yearFilter) return false;
      if (!normalizedQuery) return true;
      return [
        review.employee.name,
        review.employee.email || '',
        review.outcomes,
        review.problems,
        review.recommendations,
      ].some((value) => value.toLocaleLowerCase('ru-RU').includes(normalizedQuery));
    });
  }, [data?.reviews, employeeFilter, query, yearFilter]);

  const submitReview = async (values: ReviewFormState, reviewId?: string) => {
    setSaving(true);
    setActionError('');
    const body: TeamReviewWrite = buildTeamReviewWrite(values);
    try {
      await teamApiFetch(reviewId ? `/api/team/reviews/${reviewId}` : '/api/team/reviews', {
        method: reviewId ? 'PATCH' : 'POST',
        body: JSON.stringify(body),
      });
      await load();
      setCreating(false);
      setEditingId(null);
      if (reviewId) {
        setExpanded((current) => new Set(current).add(reviewId));
      }
      restoreFocus(reviewId);
    } catch (submitError) {
      setActionError(submitError instanceof Error ? submitError.message : 'Не удалось сохранить ревью.');
    } finally {
      setSaving(false);
    }
  };

  const toggleReview = (id: string) => {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  return (
    <section className="space-y-5" aria-labelledby="team-reviews-title">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h2 id="team-reviews-title" className="text-xl font-bold tracking-tight text-gray-900">Ревью сотрудников</h2>
          <p className="mt-1 text-sm text-gray-500">Итоги, зоны внимания и следующие договорённости в одном месте.</p>
        </div>
        {data?.canManage && !creating && (
          <button
            ref={createButtonRef}
            type="button"
            onClick={() => {
              setCreating(true);
              setEditingId(null);
              setActionError('');
            }}
            className="inline-flex min-h-11 items-center justify-center gap-2 rounded-xl bg-gray-900 px-4 text-sm font-semibold text-white outline-none hover:bg-gray-800 focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2"
          >
            <Plus className="h-4 w-4" aria-hidden="true" />
            Добавить ревью
          </button>
        )}
      </div>

      {creating && data?.canManage && (
        <div className="rounded-2xl border border-gray-200 bg-gray-50/70 p-4 sm:p-6">
          <div className="mb-5 flex items-center justify-between gap-3">
            <div>
              <h3 className="text-base font-bold text-gray-900">Новое ревью</h3>
              <p className="mt-0.5 text-sm text-gray-500">Имя сотрудника выбирается из профилей Portal.</p>
            </div>
            <button
              type="button"
              onClick={() => {
                setCreating(false);
                setActionError('');
                restoreFocus();
              }}
              aria-label="Закрыть форму"
              className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl text-gray-500 outline-none hover:bg-gray-200/70 focus-visible:ring-2 focus-visible:ring-blue-500"
            >
              <X className="h-4 w-4" aria-hidden="true" />
            </button>
          </div>
          <ReviewForm
            employees={data.employees}
            mode="create"
            saving={saving}
            error={actionError}
            onCancel={() => {
              setCreating(false);
              setActionError('');
              restoreFocus();
            }}
            onSubmit={(values) => submitReview(values)}
          />
        </div>
      )}

      {error && (
        <div className="flex flex-col gap-3 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800 sm:flex-row sm:items-center sm:justify-between" role="alert">
          <span>{error}</span>
          <button
            type="button"
            onClick={() => {
              setLoading(true);
              setRequestVersion((value) => value + 1);
            }}
            className="inline-flex min-h-11 items-center justify-center gap-2 rounded-lg border border-red-300 bg-white px-3 font-medium outline-none hover:bg-red-100 focus-visible:ring-2 focus-visible:ring-red-500"
          >
            <RefreshCw className="h-4 w-4" aria-hidden="true" />
            Повторить
          </button>
        </div>
      )}

      <div className="grid gap-2 lg:grid-cols-[minmax(240px,1fr)_minmax(210px,280px)_150px]">
        <label className="relative block">
          <span className="sr-only">Поиск по ревью</span>
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400" aria-hidden="true" />
          <input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Поиск по сотруднику или содержанию"
            className="h-11 w-full rounded-xl border border-gray-200 bg-white pl-9 pr-3 text-sm text-gray-900 outline-none placeholder:text-gray-400 focus:border-blue-500 focus:ring-2 focus:ring-blue-100"
          />
        </label>
        <label>
          <span className="sr-only">Сотрудник</span>
          <select
            value={employeeFilter}
            onChange={(event) => setEmployeeFilter(event.target.value)}
            className="h-11 w-full rounded-xl border border-gray-200 bg-white px-3 text-sm text-gray-700 outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-100"
          >
            <option value="all">Все сотрудники</option>
            {data?.employees.map((employee) => (
              <option key={employee.id} value={employee.id}>{employee.name}</option>
            ))}
          </select>
        </label>
        <label>
          <span className="sr-only">Год</span>
          <select
            value={yearFilter}
            onChange={(event) => setYearFilter(event.target.value)}
            className="h-11 w-full rounded-xl border border-gray-200 bg-white px-3 text-sm text-gray-700 outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-100"
          >
            <option value="all">Все годы</option>
            {years.map((year) => <option key={year} value={String(year)}>{year}</option>)}
          </select>
        </label>
      </div>

      {loading && !data ? <ReviewSkeleton /> : data && (
        <div className="overflow-hidden rounded-2xl border border-gray-200 bg-white">
          <div className="flex items-center justify-between gap-3 border-b border-gray-100 bg-gray-50/60 px-4 py-3 sm:px-5">
            <div>
              <h3 className="text-base font-bold text-gray-900">История ревью</h3>
              <p className="text-xs text-gray-500">
                Показано {filteredReviews.length} из {data.reviews.length}
              </p>
            </div>
            {!data.canManage && (
              <span className="rounded-lg bg-gray-100 px-2.5 py-1 text-xs font-medium text-gray-600">Только ваши ревью</span>
            )}
          </div>

          {filteredReviews.length === 0 ? (
            <div className="px-5 py-12 text-center">
              <p className="text-sm font-semibold text-gray-900">
                {data.reviews.length === 0 ? 'Ревью пока не добавлены' : 'По фильтрам ничего не найдено'}
              </p>
              <p className="mx-auto mt-1 max-w-md text-sm text-gray-500">
                {data.reviews.length === 0
                  ? data.canManage ? 'Добавьте первое ревью, чтобы сохранить договорённости.' : 'Когда руководитель добавит ревью, оно появится здесь.'
                  : 'Измените сотрудника, год или поисковый запрос.'}
              </p>
            </div>
          ) : (
            <div className="divide-y divide-gray-100">
              {filteredReviews.map((review) => {
                const open = expanded.has(review.id);
                const editing = editingId === review.id;
                const regionId = `team-review-${review.id}`;
                return (
                  <article key={review.id}>
                    <button
                      ref={(node) => {
                        if (node) reviewButtonRefs.current.set(review.id, node);
                        else reviewButtonRefs.current.delete(review.id);
                      }}
                      type="button"
                      onClick={() => toggleReview(review.id)}
                      aria-expanded={open}
                      aria-controls={regionId}
                      className="flex min-h-[72px] w-full items-center gap-3 px-4 py-3 text-left outline-none transition-colors hover:bg-gray-50 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-blue-500 sm:px-5"
                    >
                      <EmployeeAvatar employee={review.employee} />
                      <span className="min-w-0 flex-1">
                        <span className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                          <span className="truncate text-sm font-semibold text-gray-900">{review.employee.name}</span>
                          <span className="text-xs text-gray-500">{employeeRole(review.employee)}</span>
                        </span>
                        <span className="mt-0.5 block truncate text-sm text-gray-600">{review.outcomes}</span>
                        <span className="mt-0.5 block text-xs font-medium text-gray-500 sm:hidden">{formatRussianDate(review.reviewDate)}</span>
                      </span>
                      <span className="hidden shrink-0 text-right sm:block">
                        <span className="block text-sm font-medium text-gray-700">{formatRussianDate(review.reviewDate)}</span>
                        <span className="block text-xs text-gray-500">{review.reviewer ? `Автор: ${review.reviewer.name}` : 'Автор не указан'}</span>
                      </span>
                      <ChevronDown
                        className={`h-4 w-4 shrink-0 text-gray-400 transition-transform duration-200 ${open ? 'rotate-180' : ''}`}
                        aria-hidden="true"
                      />
                    </button>

                    {open && (
                      <div id={regionId} className="border-t border-gray-100 bg-gray-50/60 px-4 py-5 sm:px-6">
                        <div className="mb-4 sm:hidden">
                          <p className="text-sm font-medium text-gray-700">{formatRussianDate(review.reviewDate)}</p>
                          <p className="text-xs text-gray-500">{review.reviewer ? `Автор: ${review.reviewer.name}` : 'Автор не указан'}</p>
                        </div>

                        {editing && data.canManage ? (
                          <ReviewForm
                            key={review.id}
                            employees={data.employees}
                            initial={{
                              reviewDate: review.reviewDate.slice(0, 10),
                              employeeUserId: review.employee.id,
                              outcomes: review.outcomes,
                              problems: review.problems,
                              recommendations: review.recommendations,
                            }}
                            mode="edit"
                            saving={saving}
                            error={actionError}
                            onCancel={() => {
                              setEditingId(null);
                              setActionError('');
                              restoreFocus(review.id);
                            }}
                            onSubmit={(values) => submitReview(values, review.id)}
                          />
                        ) : (
                          <>
                            <div className="grid gap-5 lg:grid-cols-3">
                              <ReviewSection title="Основные итоги" text={review.outcomes} />
                              <ReviewSection title="Зоны внимания" text={review.problems} />
                              <ReviewSection title="Рекомендации" text={review.recommendations} />
                            </div>
                            {data.canManage && (
                              <div className="mt-5 flex justify-end border-t border-gray-200 pt-4">
                                <button
                                  type="button"
                                  onClick={() => {
                                    setCreating(false);
                                    setEditingId(review.id);
                                    setActionError('');
                                  }}
                                  className="inline-flex min-h-11 items-center justify-center gap-2 rounded-xl border border-gray-200 bg-white px-4 text-sm font-medium text-gray-700 outline-none hover:bg-gray-100 focus-visible:ring-2 focus-visible:ring-blue-500"
                                >
                                  <Pencil className="h-4 w-4" aria-hidden="true" />
                                  Редактировать
                                </button>
                              </div>
                            )}
                          </>
                        )}
                      </div>
                    )}
                  </article>
                );
              })}
            </div>
          )}
        </div>
      )}

      <p className="sr-only" aria-live="polite">
        {saving ? 'Ревью сохраняется' : ''}
      </p>
    </section>
  );
}
