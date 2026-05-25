'use client';

import { useEffect, useState, useCallback } from 'react';
import Link from 'next/link';
import type { Route } from 'next';
import { FolderKanban } from 'lucide-react';
import { clientApiFetch } from '@/lib/clientFetcher';

type ProjectListItem = {
  id: string;
  name: string;
  status: string;
  specialist: string | null;
  manager: string | null;
  contacts_done: string | null;
  contacts_obligation: string | null;
  deadline: string | null;
  launch_date: string | null;
  tasks_total: number;
  tasks_active: number;
  tasks_done: number;
  leads_count: number;
};

type ProjectsResponse = {
  items: ProjectListItem[];
  total: number;
};

// Status → 6px semantic dot colour. Tones collapse onto the system's status
// vocabulary (amber = in-progress, green = done, red = cancelled, paper-faint
// = neutral/paused/preparation). The filled tinted-pill pattern is gone —
// status is data, signalled by a dot + mono uppercase tag.
const STATUS_DOT: Record<string, string> = {
  'В работе': 'var(--cp-amber)',
  'Тестирование': 'var(--cp-amber)',
  'На паузе': 'var(--cp-paper-faint)',
  'Подготовка': 'var(--cp-paper-faint)',
  'Завершен': 'var(--cp-green)',
  'Отменен': 'var(--cp-red)',
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

function ContactsProgress({ done, total }: { done: string | null; total: string | null }) {
  const doneNum = Number(done);
  const totalNum = Number(total);
  const haveAny = (done && done.trim() !== '') || (total && total.trim() !== '');
  if (!haveAny) return null;

  const isNumeric =
    Number.isFinite(doneNum) && Number.isFinite(totalNum) && totalNum > 0;
  const pct = isNumeric ? Math.min(100, Math.max(0, Math.round((doneNum / totalNum) * 100))) : 0;

  return (
    <div>
      <div className="flex items-baseline justify-between mb-1.5">
        <span className="ds-eyebrow">Контакты</span>
        <span
          className="ds-mono text-xs font-semibold"
          style={{ color: 'var(--cp-paper)' }}
        >
          {done?.trim() || '0'}
          {total?.trim() ? (
            <span style={{ color: 'var(--cp-paper-faint)' }}> / {total}</span>
          ) : null}
        </span>
      </div>
      {isNumeric && (
        <div
          className="h-1.5 rounded-full overflow-hidden"
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

function ProjectCard({ project }: { project: ProjectListItem }) {
  return (
    <Link
      href={`/client/projects/${project.id}` as Route}
      className="neu-sm ds-card-pressable block p-4 sm:p-5"
    >
      <div className="flex items-start justify-between gap-3 mb-3">
        <div className="min-w-0">
          <p
            className="text-base font-bold truncate m-0"
            style={{ color: 'var(--cp-paper)' }}
          >
            {project.name || 'Без названия'}
          </p>
          {(project.specialist || project.manager) && (
            <p className="text-xs truncate mt-0.5" style={{ color: 'var(--cp-paper-mute)' }}>
              {project.specialist && <>Специалист: {project.specialist}</>}
              {project.specialist && project.manager && (
                <span style={{ color: 'var(--cp-paper-faint)' }}> · </span>
              )}
              {project.manager && <>Менеджер: {project.manager}</>}
            </p>
          )}
        </div>
        <StatusBadge status={project.status} />
      </div>

      <div className="grid grid-cols-3 gap-2 mb-3">
        <div
          className="rounded-md px-2.5 py-2 text-center"
          style={{
            background: 'var(--cp-surface-rest)',
            border: '1px solid var(--cp-divider)',
          }}
        >
          <p className="ds-eyebrow">Активных</p>
          <p
            className="ds-mono text-base font-semibold mt-0.5"
            style={{ color: 'var(--cp-paper)' }}
          >
            {project.tasks_active}
          </p>
        </div>
        <div
          className="rounded-md px-2.5 py-2 text-center"
          style={{
            background: 'var(--cp-surface-rest)',
            border: '1px solid var(--cp-divider)',
          }}
        >
          <p className="ds-eyebrow">Завершено</p>
          <p
            className="ds-mono text-base font-semibold mt-0.5"
            style={{ color: 'var(--cp-paper)' }}
          >
            {project.tasks_done}
          </p>
        </div>
        <div
          className="rounded-md px-2.5 py-2 text-center"
          style={{
            background: 'var(--cp-surface-rest)',
            border: '1px solid var(--cp-divider)',
          }}
        >
          <p className="ds-eyebrow">Лиды</p>
          <p
            className="ds-mono text-base font-semibold mt-0.5"
            style={{ color: 'var(--cp-paper)' }}
          >
            {project.leads_count}
          </p>
        </div>
      </div>

      <ContactsProgress
        done={project.contacts_done}
        total={project.contacts_obligation}
      />

      {(project.launch_date || project.deadline) && (
        <div
          className="ds-mono flex items-center justify-between mt-3 pt-3 text-[11px]"
          style={{
            borderTop: '1px solid var(--cp-divider)',
            color: 'var(--cp-paper-mute)',
          }}
        >
          {project.launch_date && (
            <span>
              <span style={{ color: 'var(--cp-paper-faint)' }}>запуск </span>
              {formatDate(project.launch_date)}
            </span>
          )}
          {project.deadline && (
            <span>
              <span style={{ color: 'var(--cp-paper-faint)' }}>дедлайн </span>
              {formatDate(project.deadline)}
            </span>
          )}
        </div>
      )}
    </Link>
  );
}

export default function ClientProjectsPage() {
  const [items, setItems] = useState<ProjectListItem[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const res = await clientApiFetch<ProjectsResponse>('/projects');
      setItems(res.items);
      setTotal(res.total);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Ошибка загрузки');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  return (
    <div className="mx-auto max-w-5xl">
      <header className="mb-6 sm:mb-8">
        <h1
          className="text-xl sm:text-2xl font-bold m-0"
          style={{ color: 'var(--cp-paper)' }}
        >
          Проекты
        </h1>
        <p className="mt-1 text-xs sm:text-sm" style={{ color: 'var(--cp-paper-mute)' }}>
          Статусы, задачи и прогресс по контактам по всем вашим проектам
        </p>
      </header>

      {error && (
        <div
          className="neu-inset mb-6 rounded-lg px-5 py-3.5 text-sm font-medium flex items-start gap-2.5"
          role="alert"
        >
          <span
            aria-hidden
            className="ds-status-dot shrink-0"
            style={{ background: 'var(--cp-red)', marginTop: '7px' }}
          />
          <span style={{ color: 'var(--cp-paper)' }}>{error}</span>
        </div>
      )}

      {loading ? (
        <div className="flex items-center justify-center py-16">
          <p
            className="ds-mono text-xs"
            style={{ color: 'var(--cp-paper-mute)' }}
          >
            Загружаем проекты…
          </p>
        </div>
      ) : items.length === 0 ? (
        <div className="neu-card py-12 sm:py-16 text-center px-6">
          <FolderKanban
            className="mx-auto h-8 w-8 mb-3"
            style={{ color: 'var(--cp-paper-faint)' }}
            aria-hidden
          />
          <p className="text-base sm:text-lg font-bold mb-2" style={{ color: 'var(--cp-paper)' }}>
            Проектов пока нет
          </p>
          <p className="text-xs sm:text-sm max-w-md mx-auto mb-5" style={{ color: 'var(--cp-paper-mute)' }}>
            Проекты создаёт менеджер агентства. Если вы ожидаете проект, но его нет —
            напишите менеджеру, чтобы он привязал его к вашему профилю.
          </p>
          <Link
            href={'/client/support' as Route}
            className="ds-btn-primary inline-flex items-center gap-2 px-5"
          >
            Связаться с менеджером
          </Link>
        </div>
      ) : (
        <>
          <p
            className="ds-mono text-xs mb-3"
            style={{ color: 'var(--cp-paper-faint)' }}
          >
            всего проектов: {total}
          </p>
          <div className="space-y-3">
            {items.map((project) => (
              <ProjectCard key={project.id} project={project} />
            ))}
          </div>
        </>
      )}
    </div>
  );
}
