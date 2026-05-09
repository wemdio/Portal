'use client';

import { useEffect, useState, useCallback } from 'react';
import Link from 'next/link';
import type { Route } from 'next';
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

const STATUS_TONES: Record<string, { bg: string; fg: string }> = {
  'В работе': { bg: 'rgba(59,130,246,0.15)', fg: '#1d4ed8' },
  'Тестирование': { bg: 'rgba(245,158,11,0.15)', fg: '#b45309' },
  'На паузе': { bg: 'rgba(148,163,184,0.18)', fg: '#475569' },
  'Подготовка': { bg: 'rgba(168,85,247,0.15)', fg: '#7e22ce' },
  'Завершен': { bg: 'rgba(34,197,94,0.15)', fg: '#15803d' },
  'Отменен': { bg: 'rgba(239,68,68,0.15)', fg: '#b91c1c' },
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
        <span
          className="text-[10px] font-semibold uppercase tracking-wider"
          style={{ color: 'var(--cp-text-l)' }}
        >
          Контакты
        </span>
        <span className="text-xs font-bold" style={{ color: 'var(--cp-text)' }}>
          {done?.trim() || '0'}
          {total?.trim() ? <span style={{ color: 'var(--cp-text-l)' }}> / {total}</span> : null}
        </span>
      </div>
      {isNumeric && (
        <div
          className="neu-inset h-1.5 rounded-full overflow-hidden"
          style={{ background: 'var(--cp-inset, rgba(180,173,164,0.12))' }}
        >
          <div
            className="h-full rounded-full transition-all"
            style={{
              width: `${pct}%`,
              background: 'var(--cp-accent)',
            }}
          />
        </div>
      )}
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  const tone = STATUS_TONES[status] ?? {
    bg: 'rgba(148,163,184,0.18)',
    fg: '#475569',
  };
  return (
    <span
      className="inline-flex items-center px-2.5 py-1 rounded-full text-[10px] font-bold whitespace-nowrap"
      style={{ background: tone.bg, color: tone.fg }}
    >
      {status}
    </span>
  );
}

function ProjectCard({ project }: { project: ProjectListItem }) {
  return (
    <Link
      href={`/client/projects/${project.id}` as Route}
      className="neu-sm block p-4 sm:p-5 transition-shadow hover:shadow-md"
    >
      <div className="flex items-start justify-between gap-3 mb-3">
        <div className="min-w-0">
          <p className="text-base font-extrabold truncate" style={{ color: 'var(--cp-text)' }}>
            {project.name || 'Без названия'}
          </p>
          {(project.specialist || project.manager) && (
            <p className="text-xs truncate mt-0.5" style={{ color: 'var(--cp-text-m)' }}>
              {project.specialist && <>Специалист: {project.specialist}</>}
              {project.specialist && project.manager && <span style={{ color: 'var(--cp-text-l)' }}> · </span>}
              {project.manager && <>Менеджер: {project.manager}</>}
            </p>
          )}
        </div>
        <StatusBadge status={project.status} />
      </div>

      <div className="grid grid-cols-3 gap-2 mb-3">
        <div className="neu-inset rounded-lg px-2.5 py-2 text-center">
          <p className="text-[9px] font-semibold uppercase tracking-wider" style={{ color: 'var(--cp-text-l)' }}>
            Активных
          </p>
          <p className="text-base font-extrabold" style={{ color: 'var(--cp-text)' }}>
            {project.tasks_active}
          </p>
        </div>
        <div className="neu-inset rounded-lg px-2.5 py-2 text-center">
          <p className="text-[9px] font-semibold uppercase tracking-wider" style={{ color: 'var(--cp-text-l)' }}>
            Завершено
          </p>
          <p className="text-base font-extrabold" style={{ color: 'var(--cp-text)' }}>
            {project.tasks_done}
          </p>
        </div>
        <div className="neu-inset rounded-lg px-2.5 py-2 text-center">
          <p className="text-[9px] font-semibold uppercase tracking-wider" style={{ color: 'var(--cp-text-l)' }}>
            Лиды
          </p>
          <p className="text-base font-extrabold" style={{ color: 'var(--cp-accent)' }}>
            {project.leads_count}
          </p>
        </div>
      </div>

      <ContactsProgress
        done={project.contacts_done}
        total={project.contacts_obligation}
      />

      {(project.launch_date || project.deadline) && (
        <div className="flex items-center justify-between mt-3 pt-3 text-xs" style={{ borderTop: '1px solid var(--cp-divider, rgba(148,163,184,0.18))', color: 'var(--cp-text-m)' }}>
          {project.launch_date && (
            <span>
              <span style={{ color: 'var(--cp-text-l)' }}>Запуск:</span> {formatDate(project.launch_date)}
            </span>
          )}
          {project.deadline && (
            <span>
              <span style={{ color: 'var(--cp-text-l)' }}>Дедлайн:</span> {formatDate(project.deadline)}
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
      <div className="mb-6 sm:mb-8">
        <h1 className="text-xl sm:text-2xl font-extrabold">Проекты</h1>
        <p className="mt-1 text-xs sm:text-sm" style={{ color: 'var(--cp-text-m)' }}>
          Статусы, задачи и прогресс по контактам по всем вашим проектам
        </p>
      </div>

      {error && (
        <div
          className="neu-inset mb-6 rounded-2xl px-5 py-3.5 text-sm font-medium"
          style={{ color: 'var(--cp-danger, #dc2626)' }}
        >
          {error}
        </div>
      )}

      {loading ? (
        <div className="flex items-center justify-center py-16">
          <p className="text-sm" style={{ color: 'var(--cp-text-m)' }}>
            Загрузка...
          </p>
        </div>
      ) : items.length === 0 ? (
        <div className="neu-card py-12 sm:py-16 text-center px-6">
          <p className="text-base sm:text-lg font-bold mb-2" style={{ color: 'var(--cp-text)' }}>
            Проектов пока нет
          </p>
          <p className="text-xs sm:text-sm max-w-md mx-auto mb-5" style={{ color: 'var(--cp-text-m)' }}>
            Проекты создаёт менеджер агентства. Если вы ожидаете проект, но его нет —
            напишите менеджеру, чтобы он привязал его к вашему профилю.
          </p>
          <Link
            href={'/client/support' as Route}
            className="neu-btn inline-flex items-center gap-2 px-5 py-2.5 text-sm font-semibold"
          >
            Связаться с менеджером
          </Link>
        </div>
      ) : (
        <>
          <p className="text-xs font-semibold mb-3" style={{ color: 'var(--cp-text-l)' }}>
            Всего проектов: {total}
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
