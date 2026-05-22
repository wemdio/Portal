'use client';

import { useEffect, useState, useCallback } from 'react';
import Link from 'next/link';
import type { Route } from 'next';
import { useParams } from 'next/navigation';
import { clientApiFetch } from '@/lib/clientFetcher';

type ProjectDetail = {
  id: string;
  name: string;
  description: string | null;
  status: string;
  specialist: string | null;
  manager: string | null;
  contacts_done: string | null;
  contacts_obligation: string | null;
  launch_date: string | null;
  deadline: string | null;
  leads_count: number;
};

type TaskItem = {
  id: string;
  title: string;
  status: string | null;
  deadline: string | null;
};

type DetailResponse = {
  project: ProjectDetail;
  tasks: {
    active: TaskItem[];
    done: TaskItem[];
  };
};

// Project status → 6px semantic dot. Matches /client/projects list.
const STATUS_DOT: Record<string, string> = {
  'В работе': 'var(--cp-amber)',
  'Тестирование': 'var(--cp-amber)',
  'На паузе': 'var(--cp-paper-faint)',
  'Подготовка': 'var(--cp-paper-faint)',
  'Завершен': 'var(--cp-green)',
  'Отменен': 'var(--cp-red)',
};

const TASK_STATUS_LABEL: Record<string, string> = {
  pending: 'В очереди',
  in_progress: 'В работе',
  done: 'Завершено',
};

const TASK_STATUS_DOT: Record<string, string> = {
  pending: 'var(--cp-paper-faint)',
  in_progress: 'var(--cp-amber)',
  done: 'var(--cp-green)',
};

function formatDate(value: string | null): string {
  if (!value) return '';
  const d = new Date(value);
  if (isNaN(d.getTime())) return value;
  return d.toLocaleDateString('ru-RU', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  });
}

function StatusBadge({ status }: { status: string }) {
  const dot = STATUS_DOT[status] ?? 'var(--cp-paper-faint)';
  return (
    <span
      className="ds-status-tag"
      style={{ color: 'var(--cp-paper-mute)' }}
    >
      <span
        aria-hidden
        className="ds-status-dot shrink-0"
        style={{ background: dot }}
      />
      {status}
    </span>
  );
}

function MetricTile({
  label,
  value,
}: {
  label: string;
  value: number | string;
}) {
  return (
    <div
      className="rounded-md p-3 sm:p-4 text-center"
      style={{
        background: 'var(--cp-surface-rest)',
        border: '1px solid var(--cp-divider)',
      }}
    >
      <p className="ds-eyebrow mb-1">{label}</p>
      <p
        className="ds-mono text-lg sm:text-xl font-semibold"
        style={{ color: 'var(--cp-paper)' }}
      >
        {value}
      </p>
    </div>
  );
}

function ContactsBlock({ done, total }: { done: string | null; total: string | null }) {
  const doneNum = Number(done);
  const totalNum = Number(total);
  const haveAny = (done && done.trim() !== '') || (total && total.trim() !== '');
  if (!haveAny) return null;

  const isNumeric =
    Number.isFinite(doneNum) && Number.isFinite(totalNum) && totalNum > 0;
  const pct = isNumeric ? Math.min(100, Math.max(0, Math.round((doneNum / totalNum) * 100))) : 0;

  return (
    <div className="neu-card p-5 sm:p-6">
      <div className="flex items-baseline justify-between mb-3">
        <p className="ds-eyebrow">Прогресс по контактам</p>
        {isNumeric && (
          <span
            className="ds-mono text-xs font-semibold"
            style={{ color: 'var(--cp-paper)' }}
          >
            {pct}%
          </span>
        )}
      </div>
      <div className="flex items-baseline gap-2 mb-3">
        <span
          className="ds-mono text-2xl sm:text-3xl font-semibold"
          style={{ color: 'var(--cp-paper)' }}
        >
          {done?.trim() || '0'}
        </span>
        {total?.trim() && (
          <span
            className="ds-mono text-base"
            style={{ color: 'var(--cp-paper-faint)' }}
          >
            / {total}
          </span>
        )}
      </div>
      {isNumeric && (
        <div
          className="h-2 rounded-full overflow-hidden"
          style={{ background: 'var(--cp-divider)' }}
        >
          <div
            className="h-full rounded-full transition-all"
            style={{ width: `${pct}%`, background: 'var(--cp-paper)' }}
          />
        </div>
      )}
    </div>
  );
}

function TaskRow({ task }: { task: TaskItem }) {
  const status = task.status ?? 'pending';
  const dotColor = TASK_STATUS_DOT[status] ?? 'var(--cp-paper-faint)';
  const statusLabel = TASK_STATUS_LABEL[status] ?? status;

  return (
    <div className="neu-sm rounded-md p-3 sm:p-4">
      <div className="flex items-start gap-3">
        <span
          aria-hidden
          className="ds-status-dot mt-1.5 shrink-0"
          style={{ background: dotColor }}
        />
        <div className="flex-1 min-w-0">
          <p className="text-sm font-bold m-0" style={{ color: 'var(--cp-paper)' }}>
            {task.title}
          </p>
          <div className="flex items-center gap-2 mt-1">
            <span className="ds-eyebrow">{statusLabel}</span>
            {task.deadline && (
              <>
                <span style={{ color: 'var(--cp-paper-faint)' }}>·</span>
                <span
                  className="ds-mono text-[11px]"
                  style={{ color: 'var(--cp-paper-mute)' }}
                >
                  до {formatDate(task.deadline)}
                </span>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function TasksSection({ title, tasks, emptyText }: {
  title: string;
  tasks: TaskItem[];
  emptyText: string;
}) {
  return (
    <div className="neu-card p-5 sm:p-6">
      <div className="flex items-baseline justify-between mb-4">
        <h3
          className="text-base font-bold m-0"
          style={{ color: 'var(--cp-paper)' }}
        >
          {title}
        </h3>
        <span
          className="ds-mono text-xs font-semibold"
          style={{ color: 'var(--cp-paper-faint)' }}
        >
          {tasks.length}
        </span>
      </div>
      {tasks.length === 0 ? (
        <p
          className="text-xs py-4 text-center"
          style={{ color: 'var(--cp-paper-faint)' }}
        >
          {emptyText}
        </p>
      ) : (
        <div className="space-y-2">
          {tasks.map((task) => (
            <TaskRow key={task.id} task={task} />
          ))}
        </div>
      )}
    </div>
  );
}

export default function ClientProjectDetailPage() {
  const params = useParams();
  const projectId = params?.id as string;

  const [data, setData] = useState<DetailResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const res = await clientApiFetch<DetailResponse>(`/projects/${projectId}`);
      setData(res);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Ошибка загрузки');
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    if (projectId) load();
  }, [projectId, load]);

  if (loading) {
    return (
      <div className="mx-auto max-w-5xl">
        <div className="flex items-center justify-center py-16">
          <p
            className="ds-mono text-xs"
            style={{ color: 'var(--cp-paper-mute)' }}
          >
            Загружаем проект…
          </p>
        </div>
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="mx-auto max-w-5xl">
        <Link
          href={'/client/projects' as Route}
          className="ds-btn-ghost inline-block mb-6 px-3 py-1.5 text-xs"
        >
          ← Все проекты
        </Link>
        <div
          className="neu-inset rounded-lg px-5 py-3.5 text-sm font-medium flex items-start gap-2.5"
          role="alert"
        >
          <span
            aria-hidden
            className="ds-status-dot shrink-0"
            style={{ background: 'var(--cp-red)', marginTop: '7px' }}
          />
          <span style={{ color: 'var(--cp-paper)' }}>
            {error || 'Проект не найден'}
          </span>
        </div>
      </div>
    );
  }

  const { project, tasks } = data;

  return (
    <div className="mx-auto max-w-5xl">
      <Link
        href={'/client/projects' as Route}
        className="ds-btn-ghost inline-block mb-6 px-3 py-1.5 text-xs"
      >
        ← Все проекты
      </Link>

      <div className="neu-card p-5 sm:p-8 mb-6">
        <div className="flex items-start justify-between gap-4 mb-5">
          <div className="min-w-0">
            <h1
              className="text-xl sm:text-2xl font-bold m-0"
              style={{ color: 'var(--cp-paper)' }}
            >
              {project.name || 'Без названия'}
            </h1>
            {(project.launch_date || project.deadline) && (
              <p
                className="ds-mono text-xs sm:text-[13px] mt-1"
                style={{ color: 'var(--cp-paper-mute)' }}
              >
                {project.launch_date && (
                  <>
                    <span style={{ color: 'var(--cp-paper-faint)' }}>запуск </span>
                    {formatDate(project.launch_date)}
                  </>
                )}
                {project.launch_date && project.deadline && (
                  <span style={{ color: 'var(--cp-paper-faint)' }}> · </span>
                )}
                {project.deadline && (
                  <>
                    <span style={{ color: 'var(--cp-paper-faint)' }}>дедлайн </span>
                    {formatDate(project.deadline)}
                  </>
                )}
              </p>
            )}
          </div>
          <StatusBadge status={project.status} />
        </div>

        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-5">
          <MetricTile label="Активных задач" value={tasks.active.length} />
          <MetricTile label="Завершено" value={tasks.done.length} />
          <MetricTile label="Лидов передано" value={project.leads_count} />
          <MetricTile
            label="Всего задач"
            value={tasks.active.length + tasks.done.length}
          />
        </div>

        {(project.specialist || project.manager) && (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {project.specialist && (
              <div className="neu-sm rounded-md p-3">
                <p className="ds-eyebrow mb-1">Специалист</p>
                <p
                  className="text-sm font-bold m-0"
                  style={{ color: 'var(--cp-paper)' }}
                >
                  {project.specialist}
                </p>
              </div>
            )}
            {project.manager && (
              <div className="neu-sm rounded-md p-3">
                <p className="ds-eyebrow mb-1">Менеджер</p>
                <p
                  className="text-sm font-bold m-0"
                  style={{ color: 'var(--cp-paper)' }}
                >
                  {project.manager}
                </p>
              </div>
            )}
          </div>
        )}
      </div>

      <div className="mb-6">
        <ContactsBlock
          done={project.contacts_done}
          total={project.contacts_obligation}
        />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 sm:gap-6">
        <TasksSection
          title="Активные задачи"
          tasks={tasks.active}
          emptyText="Сейчас в работе нет открытых задач"
        />
        <TasksSection
          title="Завершённые задачи"
          tasks={tasks.done}
          emptyText="Завершённых задач пока нет"
        />
      </div>
    </div>
  );
}
