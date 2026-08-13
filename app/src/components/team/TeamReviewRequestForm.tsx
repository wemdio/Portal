'use client';

import { useRef, useState } from 'react';
import { Plus, X } from 'lucide-react';
import {
  buildTeamReviewRequestWrite,
  teamApiFetch,
  type TeamReviewRequestPerson,
  type TeamReviewRequestProject,
} from './teamApi';
import { TEAM_FORM_INPUT_CLASS, TEAM_FORM_TEXTAREA_CLASS } from './teamFormStyles';

interface TeamReviewRequestFormProps {
  employees: TeamReviewRequestPerson[];
  projects: TeamReviewRequestProject[];
  requestVisibility: 'private' | 'lead_shared';
  onSubmitted: () => void;
}

interface FormState {
  employeeUserId: string;
  projectId: string;
  problem: string;
  examples: string;
  desiredOutcome: string;
}

const EMPTY_FORM: FormState = {
  employeeUserId: '',
  projectId: '',
  problem: '',
  examples: '',
  desiredOutcome: '',
};

export default function TeamReviewRequestForm({
  employees,
  projects,
  requestVisibility,
  onSubmitted,
}: TeamReviewRequestFormProps) {
  const [open, setOpen] = useState(false);
  const [values, setValues] = useState<FormState>(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const triggerRef = useRef<HTMLButtonElement>(null);

  const update = <K extends keyof FormState>(key: K, value: FormState[K]) => {
    setValues((current) => ({ ...current, [key]: value }));
  };

  const close = () => {
    if (saving) return;
    setOpen(false);
    setError('');
    window.requestAnimationFrame(() => triggerRef.current?.focus());
  };

  const submit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!values.employeeUserId || !values.problem.trim() || !values.desiredOutcome.trim()) return;
    setSaving(true);
    setError('');
    setSuccess('');
    try {
      await teamApiFetch('/api/team/review-requests', {
        method: 'POST',
        body: JSON.stringify(buildTeamReviewRequestWrite(values)),
      });
      setValues(EMPTY_FORM);
      setOpen(false);
      setSuccess(requestVisibility === 'lead_shared'
        ? 'Запрос отправлен. Его увидят другие лиды и директора.'
        : 'Запрос отправлен. Его увидят только Алина и Сергей.');
      onSubmitted();
      window.requestAnimationFrame(() => triggerRef.current?.focus());
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : 'Не удалось отправить запрос. Попробуйте ещё раз.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <section aria-label="Запрос на ревью" className="space-y-3">
      <div className="flex flex-wrap items-center gap-3">
        <button
          ref={triggerRef}
          type="button"
          disabled={open}
          aria-expanded={open}
          aria-controls={open ? 'team-review-request-form' : undefined}
          onClick={() => {
            setOpen(true);
            setSuccess('');
          }}
          className="inline-flex min-h-11 items-center justify-center gap-2 rounded-xl border border-gray-200 bg-white px-4 text-sm font-semibold text-gray-800 outline-none hover:bg-gray-50 focus-visible:ring-2 focus-visible:ring-blue-500 disabled:opacity-60"
        >
          <Plus aria-hidden="true" className="h-4 w-4" />
          Запросить ревью
        </button>
        {success && <p role="status" className="text-sm text-emerald-700">{success}</p>}
      </div>

      {open && (
        <form
          id="team-review-request-form"
          aria-label="Новый запрос на ревью"
          aria-busy={saving}
          onSubmit={submit}
          className="rounded-2xl border border-gray-200 bg-gray-50/70 p-4 sm:p-6"
        >
          <div className="mb-5 flex items-start justify-between gap-3">
            <div className="min-w-0">
              <h3 className="text-base font-bold text-gray-900">Запросить ревью</h3>
              <p className="mt-1 max-w-[70ch] text-sm text-gray-500">
                Опишите рабочую ситуацию и результат, который поможет сотруднику двигаться дальше.
              </p>
              <p role="note" className="mt-2 max-w-[70ch] text-sm font-medium text-gray-700">
                {requestVisibility === 'lead_shared'
                  ? 'Запрос увидят другие лиды и директора. Обработать его смогут Алина и Сергей.'
                  : 'Запрос увидят только Алина и Сергей.'}
              </p>
            </div>
            <button
              type="button"
              disabled={saving}
              onClick={close}
              aria-label="Закрыть форму"
              className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-xl text-gray-500 outline-none hover:bg-gray-100 focus-visible:ring-2 focus-visible:ring-blue-500 disabled:opacity-50"
            >
              <X aria-hidden="true" className="h-4 w-4" />
            </button>
          </div>

          <div className="grid gap-4 lg:grid-cols-2">
            <label className="space-y-1.5 text-sm font-medium text-gray-700">
              <span>Сотрудник, с которым нужно ревью</span>
              <select
                autoFocus
                required
                disabled={saving}
                value={values.employeeUserId}
                onChange={(event) => update('employeeUserId', event.target.value)}
                className={TEAM_FORM_INPUT_CLASS}
              >
                <option value="">Выберите сотрудника</option>
                {employees.map((employee) => (
                  <option key={employee.id} value={employee.id}>
                    {employee.name}{employee.email ? ` · ${employee.email}` : ''}
                  </option>
                ))}
              </select>
            </label>

            <label className="space-y-1.5 text-sm font-medium text-gray-700">
              <span>Проект, необязательно</span>
              <select
                disabled={saving}
                value={values.projectId}
                onChange={(event) => update('projectId', event.target.value)}
                className={TEAM_FORM_INPUT_CLASS}
              >
                <option value="">Без проекта</option>
                {projects.map((project) => (
                  <option key={project.id} value={project.id}>{project.name}</option>
                ))}
              </select>
            </label>

            <label className="space-y-1.5 text-sm font-medium text-gray-700 lg:col-span-2">
              <span>Проблема или причина</span>
              <textarea
                required
                maxLength={500}
                disabled={saving}
                rows={3}
                value={values.problem}
                onChange={(event) => update('problem', event.target.value)}
                placeholder="Что происходит и почему нужен отдельный разбор"
                className={TEAM_FORM_TEXTAREA_CLASS}
              />
            </label>

            <label className="space-y-1.5 text-sm font-medium text-gray-700 lg:col-span-2">
              <span>Примеры или обсуждения, необязательно</span>
              <textarea
                maxLength={5000}
                disabled={saving}
                rows={2}
                value={values.examples}
                onChange={(event) => update('examples', event.target.value)}
                placeholder="Ссылки, сообщения или короткие примеры"
                className={TEAM_FORM_TEXTAREA_CLASS}
              />
            </label>

            <label className="space-y-1.5 text-sm font-medium text-gray-700 lg:col-span-2">
              <span>Что нужно выяснить</span>
              <textarea
                required
                maxLength={1000}
                disabled={saving}
                rows={3}
                value={values.desiredOutcome}
                onChange={(event) => update('desiredOutcome', event.target.value)}
                placeholder="Какой вопрос или решение должно закрыть ревью"
                className={TEAM_FORM_TEXTAREA_CLASS}
              />
            </label>
          </div>

          {error && <p role="alert" className="mt-4 text-sm text-red-700">{error}</p>}

          <div className="mt-5 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <button
              type="button"
              disabled={saving}
              onClick={close}
              className="min-h-11 rounded-xl border border-gray-200 bg-white px-4 text-sm font-medium text-gray-700 outline-none hover:bg-gray-50 focus-visible:ring-2 focus-visible:ring-blue-500 disabled:opacity-50"
            >
              Отмена
            </button>
            <button
              type="submit"
              disabled={saving}
              className="min-h-11 rounded-xl bg-gray-900 px-4 text-sm font-semibold text-white outline-none hover:bg-gray-800 focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2 disabled:cursor-wait disabled:opacity-60"
            >
              {saving ? 'Отправляем…' : 'Отправить запрос'}
            </button>
          </div>
        </form>
      )}
    </section>
  );
}
