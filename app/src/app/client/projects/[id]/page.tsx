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

const STATUS_TONES: Record<string, { bg: string; fg: string }> = {
  'В работе': { bg: 'rgba(59,130,246,0.15)', fg: '#1d4ed8' },
  'Тестирование': { bg: 'rgba(245,158,11,0.15)', fg: '#b45309' },
  'На паузе': { bg: 'rgba(148,163,184,0.18)', fg: '#475569' },
  'Подготовка': { bg: 'rgba(168,85,247,0.15)', fg: '#7e22ce' },
  'Завершен': { bg: 'rgba(34,197,94,0.15)', fg: '#15803d' },
  'Отменен': { bg: 'rgba(239,68,68,0.15)', fg: '#b91c1c' },
};

const TASK_STATUS_LABEL: Record<string, string> = {
  pending: 'В очереди',
  in_progress: 'В работе',
  done: 'Завершено',
};

const TASK_STATUS_DOT: Record<string, string> = {
  pending: '#94a3b8',
  in_progress: '#3b82f6',
  done: '#22c55e',
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
  const tone = STATUS_TONES[status] ?? {
    bg: 'rgba(148,163,184,0.18)',
    fg: '#475569',
  };
  return (
    <span
      className="inline-flex items-center px-3 py-1.5 rounded-full text-[11px] font-bold whitespace-nowrap"
      style={{ background: tone.bg, color: tone.fg }}
    >
      {status}
    </span>
  );
}

function MetricTile({
  label,
  value,
  accent,
}: {
  label: string;
  value: number | string;
  accent?: boolean;
}) {
  return (
    <div className="neu-inset rounded-xl p-3 sm:p-4 text-center">
      <p
        className="text-[10px] font-semibold uppercase tracking-wider mb-1"
        style={{ color: 'var(--cp-text-l)' }}
      >
        {label}
      </p>
      <p
        className="text-lg sm:text-xl font-extrabold"
        style={{ color: accent ? 'var(--cp-accent)' : 'var(--cp-text)' }}
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
        <p
          className="text-[11px] font-semibold uppercase tracking-wider"
          style={{ color: 'var(--cp-text-l)' }}
        >
          Прогресс по контактам
        </p>
        {isNumeric && (
          <span className="text-xs font-bold" style={{ color: 'var(--cp-accent)' }}>
            {pct}%
          </span>
        )}
      </div>
      <div className="flex items-baseline gap-2 mb-3">
        <span className="text-2xl sm:text-3xl font-extrabold" style={{ color: 'var(--cp-text)' }}>
          {done?.trim() || '0'}
        </span>
        {total?.trim() && (
          <span className="text-base font-semibold" style={{ color: 'var(--cp-text-l)' }}>
            / {total}
          </span>
        )}
      </div>
      {isNumeric && (
        <div
          className="neu-inset h-2 rounded-full overflow-hidden"
          style={{ background: 'var(--cp-inset, rgba(180,173,164,0.12))' }}
        >
          <div
            className="h-full rounded-full transition-all"
            style={{ width: `${pct}%`, background: 'var(--cp-accent)' }}
          />
        </div>
      )}
    </div>
  );
}

function TaskRow({ task }: { task: TaskItem }) {
  const status = task.status ?? 'pending';
  const dotColor = TASK_STATUS_DOT[status] ?? '#94a3b8';
  const statusLabel = TASK_STATUS_LABEL[status] ?? status;

  return (
    <div className="neu-sm rounded-xl p-3 sm:p-4">
      <div className="flex items-start gap-3">
        <span
          className="w-2 h-2 rounded-full mt-1.5 shrink-0"
          style={{ background: dotColor }}
        />
        <div className="flex-1 min-w-0">
          <p className="text-sm font-bold" style={{ color: 'var(--cp-text)' }}>
            {task.title}
          </p>
          <div className="flex items-center gap-2 mt-1">
            <span
              className="text-[10px] font-semibold uppercase tracking-wider"
              style={{ color: 'var(--cp-text-l)' }}
            >
              {statusLabel}
            </span>
            {task.deadline && (
              <>
                <span style={{ color: 'var(--cp-text-l)' }}>·</span>
                <span className="text-[11px]" style={{ color: 'var(--cp-text-m)' }}>
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
        <h3 className="text-base font-extrabold" style={{ color: 'var(--cp-text)' }}>
          {title}
        </h3>
        <span className="text-xs font-bold" style={{ color: 'var(--cp-text-l)' }}>
          {tasks.length}
        </span>
      </div>
      {tasks.length === 0 ? (
        <p className="text-xs py-4 text-center" style={{ color: 'var(--cp-text-l)' }}>
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
          <p className="text-sm" style={{ color: 'var(--cp-text-m)' }}>
            Загрузка...
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
          className="neu-pill px-3 py-1.5 text-xs font-semibold mb-6 inline-block"
          style={{ color: 'var(--cp-text-m)' }}
        >
          ← Все проекты
        </Link>
        <div
          className="neu-inset rounded-2xl px-5 py-3.5 text-sm font-medium"
          style={{ color: 'var(--cp-danger, #dc2626)' }}
        >
          {error || 'Проект не найден'}
        </div>
      </div>
    );
  }

  const { project, tasks } = data;

  return (
    <div className="mx-auto max-w-5xl">
      <Link
        href={'/client/projects' as Route}
        className="neu-pill px-3 py-1.5 text-xs font-semibold mb-6 inline-block"
        style={{ color: 'var(--cp-text-m)' }}
      >
        ← Все проекты
      </Link>

      <div className="neu-card p-5 sm:p-8 mb-6">
        <div className="flex items-start justify-between gap-4 mb-5">
          <div className="min-w-0">
            <h1 className="text-xl sm:text-2xl font-extrabold" style={{ color: 'var(--cp-text)' }}>
              {project.name || 'Без названия'}
            </h1>
            {(project.launch_date || project.deadline) && (
              <p className="text-xs sm:text-sm mt-1" style={{ color: 'var(--cp-text-m)' }}>
                {project.launch_date && <>Запуск {formatDate(project.launch_date)}</>}
                {project.launch_date && project.deadline && <span style={{ color: 'var(--cp-text-l)' }}> · </span>}
                {project.deadline && <>дедлайн {formatDate(project.deadline)}</>}
              </p>
            )}
          </div>
          <StatusBadge status={project.status} />
        </div>

        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-5">
          <MetricTile label="Активных задач" value={tasks.active.length} />
          <MetricTile label="Завершено" value={tasks.done.length} />
          <MetricTile label="Лидов передано" value={project.leads_count} accent />
          <MetricTile
            label="Всего задач"
            value={tasks.active.length + tasks.done.length}
          />
        </div>

        {(project.specialist || project.manager) && (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {project.specialist && (
              <div className="neu-sm rounded-xl p-3">
                <p
                  className="text-[10px] font-semibold uppercase tracking-wider mb-0.5"
                  style={{ color: 'var(--cp-text-l)' }}
                >
                  Специалист
                </p>
                <p className="text-sm font-bold" style={{ color: 'var(--cp-text)' }}>
                  {project.specialist}
                </p>
              </div>
            )}
            {project.manager && (
              <div className="neu-sm rounded-xl p-3">
                <p
                  className="text-[10px] font-semibold uppercase tracking-wider mb-0.5"
                  style={{ color: 'var(--cp-text-l)' }}
                >
                  Менеджер
                </p>
                <p className="text-sm font-bold" style={{ color: 'var(--cp-text)' }}>
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
