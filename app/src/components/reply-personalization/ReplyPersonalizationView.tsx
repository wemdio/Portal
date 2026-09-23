'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Globe, RefreshCw, Search, Settings, X } from 'lucide-react';
import { fetchProjects, fetchReplies, type ProjectListItem } from './api';
import { GlobalKnowledgeForm } from './GlobalKnowledgeForm';
import { KnowledgeBaseForm } from './KnowledgeBaseForm';
import { ReplyDetailPanel } from './ReplyDetailPanel';
import type { ReplyCampaignOption, ReplyListItem } from '@/lib/replyPersonalization/types';

/** Писем за раз; при прокрутке к концу списка догружается следующая сотня. */
const REPLIES_PAGE_SIZE = 100;

const LIST_STATUS_BADGE: Record<ReplyListItem['listStatus'], { label: string; className: string }> = {
  new: { label: 'новый', className: 'bg-blue-100 text-blue-700' },
  sent: { label: 'отправлено', className: 'bg-emerald-100 text-emerald-700' },
  skipped: { label: 'пропущено', className: 'bg-gray-100 text-gray-500' },
};

/** Палитра аватаров проектов — как кружки аккаунтов в анализаторе тг-переписок. */
const AVATAR_COLORS = [
  'bg-blue-100 text-blue-700',
  'bg-emerald-100 text-emerald-700',
  'bg-amber-100 text-amber-700',
  'bg-purple-100 text-purple-700',
  'bg-rose-100 text-rose-700',
  'bg-teal-100 text-teal-700',
];

function avatarColor(name: string): string {
  let hash = 0;
  for (const ch of name) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  return AVATAR_COLORS[hash % AVATAR_COLORS.length];
}

function formatDate(iso: string | null) {
  if (!iso) return '';
  const d = new Date(iso);
  const now = new Date();
  if (d.toDateString() === now.toDateString()) {
    return d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
  }
  return d.toLocaleDateString('ru-RU', { day: '2-digit', month: 'short' });
}

/**
 * Трёхколоночный экран «как переписки в ТГ»: слева проекты (с шестерёнкой
 * настроек базы знаний у каждого), в середине список писем, справа — полный
 * диалог по выбранному письму с генерацией/отправкой ответа.
 */
export function ReplyPersonalizationView() {
  const [projects, setProjects] = useState<ProjectListItem[]>([]);
  const [projectsLoading, setProjectsLoading] = useState(true);
  const [project, setProject] = useState<ProjectListItem | null>(null);
  const [items, setItems] = useState<ReplyListItem[]>([]);
  const [itemsLoading, setItemsLoading] = useState(false);
  /** Почему письма проекта не показаны — нет брифа; null — всё в порядке. */
  const [missingReason, setMissingReason] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [kbModalOpen, setKbModalOpen] = useState(false);
  const [globalKbModalOpen, setGlobalKbModalOpen] = useState(false);
  const [canManageGlobalKb, setCanManageGlobalKb] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadProjects = useCallback(async () => {
    try {
      const res = await fetchProjects();
      setProjects(res.projects);
      setCanManageGlobalKb(res.canManageGlobalKb);
      setProject((current) =>
        current ? (res.projects.find((p) => p.id === current.id) ?? current) : current,
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Не удалось загрузить проекты');
    } finally {
      setProjectsLoading(false);
    }
  }, []);

  useEffect(() => {
    loadProjects();
  }, [loadProjects]);

  // Фильтры списка писем — как в Instantly: кампания и поиск по почте ответившего.
  const [campaigns, setCampaigns] = useState<ReplyCampaignOption[]>([]);
  const [campaignFilter, setCampaignFilter] = useState('');
  const [replyQuery, setReplyQuery] = useState('');
  /** replyQuery после паузы в наборе — чтобы не дёргать сервер на каждую букву. */
  const [replySearch, setReplySearch] = useState('');
  const [limit, setLimit] = useState(REPLIES_PAGE_SIZE);
  const [total, setTotal] = useState<number | null>(null);
  const [hasMore, setHasMore] = useState(false);
  /** Номер последнего запроса: ответ на устаревший фильтр не должен перетереть свежий. */
  const requestSeq = useRef(0);

  useEffect(() => {
    const timer = setTimeout(() => {
      const next = replyQuery.trim();
      if (next === replySearch) return;
      setReplySearch(next);
      setLimit(REPLIES_PAGE_SIZE);
    }, 300);
    return () => clearTimeout(timer);
  }, [replyQuery, replySearch]);

  const projectId = project?.id ?? null;

  const reloadReplies = useCallback(async () => {
    if (!projectId) return;
    const seq = ++requestSeq.current;
    setItemsLoading(true);
    try {
      const res = await fetchReplies(projectId, { campaignId: campaignFilter || null, search: replySearch, limit });
      if (seq !== requestSeq.current) return;
      setItems(res.replies);
      setCampaigns(res.campaigns);
      setTotal(res.total);
      setHasMore(res.hasMore);
      setMissingReason(res.missingReason);
      setSelectedId((current) =>
        current && res.replies.some((r) => r.id === current) ? current : (res.replies[0]?.id ?? null),
      );
    } catch (err) {
      if (seq === requestSeq.current) {
        setError(err instanceof Error ? err.message : 'Не удалось загрузить письма');
        // Иначе догрузка при прокрутке будет повторять упавший запрос по кругу.
        setHasMore(false);
      }
    } finally {
      if (seq === requestSeq.current) setItemsLoading(false);
    }
  }, [projectId, campaignFilter, replySearch, limit]);

  useEffect(() => {
    reloadReplies();
  }, [reloadReplies]);

  const selectProject = useCallback((p: ProjectListItem) => {
    setProject(p);
    setItems([]);
    setCampaigns([]);
    setTotal(null);
    setHasMore(false);
    setSelectedId(null);
    setMissingReason(null);
    setCampaignFilter('');
    setReplyQuery('');
    setReplySearch('');
    setLimit(REPLIES_PAGE_SIZE);
    // Окно базы знаний открываем само только тем, кому без него не ответить.
    if (p.missingReason) setKbModalOpen(true);
  }, []);

  const handleHandled = useCallback(() => {
    reloadReplies();
  }, [reloadReplies]);

  const handleKbSaved = useCallback(() => {
    // Пометку пересчитает сервер: сохранение базы знаний ещё не значит, что
    // бриф появился (могли сохранить только тон или пример).
    loadProjects();
    reloadReplies();
  }, [loadProjects, reloadReplies]);

  const filtersActive = Boolean(campaignFilter || replySearch);
  /** Число на кнопке «Все кампании»; null — есть кампании без счётчика. */
  const allCampaignsCount = campaigns.every((c) => c.replyCount !== null)
    ? campaigns.reduce((sum, c) => sum + (c.replyCount ?? 0), 0)
    : null;

  // Догрузка при прокрутке: как только низ списка показался, просим следующую
  // сотню. Пока идёт загрузка, не следим — иначе один показ даст несколько страниц.
  const loadMoreRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const target = loadMoreRef.current;
    if (!hasMore || itemsLoading || !target) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          observer.disconnect();
          setLimit((current) => current + REPLIES_PAGE_SIZE);
        }
      },
      { rootMargin: '300px' },
    );
    observer.observe(target);
    return () => observer.disconnect();
  }, [hasMore, itemsLoading, items]);

  const selected = items.find((i) => i.id === selectedId) ?? null;

  // Поиск по списку проектов: их 60, и листать до нужного дольше, чем набрать
  // пару букв. Ищем по вхождению без учёта регистра и ё/е.
  const [projectQuery, setProjectQuery] = useState('');
  const visibleProjects = useMemo(() => {
    const norm = (v: string) => v.toLowerCase().replace(/ё/g, 'е').trim();
    const q = norm(projectQuery);
    return q ? projects.filter((p) => norm(p.client).includes(q)) : projects;
  }, [projects, projectQuery]);

  return (
    <div className="grid h-full min-h-0 grid-cols-[240px_360px_minmax(0,1fr)]">
      {/* Колонка 1: проекты */}
      <aside className="flex min-h-0 flex-col border-r border-gray-200 bg-white">
        <div className="flex items-center justify-between gap-2 border-b border-gray-100 px-3 py-2.5">
          <h2 className="text-sm font-semibold text-gray-900">Проекты ({projects.length})</h2>
          {canManageGlobalKb ? (
            <button
              type="button"
              onClick={() => setGlobalKbModalOpen(true)}
              title="Глобальные тон и пример письма"
              aria-label="Глобальные настройки"
              className="rounded p-1 text-gray-400 hover:bg-gray-100 hover:text-gray-600"
            >
              <Globe className="h-4 w-4" aria-hidden />
            </button>
          ) : null}
        </div>
        <div className="border-b border-gray-100 px-3 py-2">
          <div className="relative">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-gray-400" aria-hidden />
            <input
              value={projectQuery}
              onChange={(e) => setProjectQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Escape') setProjectQuery('');
              }}
              placeholder="Найти проект"
              aria-label="Найти проект"
              className="w-full rounded-lg border border-gray-200 bg-white py-1.5 pl-8 pr-7 text-sm text-gray-900 focus:border-blue-400 focus:outline-none"
            />
            {projectQuery ? (
              <button
                type="button"
                onClick={() => setProjectQuery('')}
                aria-label="Очистить поиск"
                className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded p-0.5 text-gray-400 hover:bg-gray-100 hover:text-gray-600"
              >
                <X className="h-3.5 w-3.5" aria-hidden />
              </button>
            ) : null}
          </div>
        </div>
        <div className="flex-1 overflow-y-auto">
          {projectsLoading ? (
            <div className="p-3 text-sm text-gray-500">Загрузка проектов...</div>
          ) : projects.length === 0 ? (
            <div className="p-3 text-sm text-gray-500">Нет доступных проектов.</div>
          ) : visibleProjects.length === 0 ? (
            <div className="p-3 text-sm text-gray-500">Ничего не нашлось по «{projectQuery.trim()}».</div>
          ) : (
            visibleProjects.map((p) => {
              const isActive = project?.id === p.id;
              return (
                <div
                  key={p.id}
                  role="button"
                  tabIndex={0}
                  onClick={() => selectProject(p)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      selectProject(p);
                    }
                  }}
                  className={`group flex w-full cursor-pointer items-center gap-2.5 px-3 py-2.5 text-left transition ${
                    isActive ? 'bg-blue-50' : 'hover:bg-gray-50'
                  }`}
                >
                  <span
                    className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-sm font-semibold ${avatarColor(p.client)}`}
                  >
                    {p.client.charAt(0).toUpperCase() || '?'}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium text-gray-900">{p.client}</span>
                    {p.missingReason ? (
                      <span className="block text-[11px] text-amber-600">{p.missingReason.toLowerCase()}</span>
                    ) : null}
                  </span>
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      // Фильтры прошлого проекта (кампания, поиск) к этому не относятся.
                      if (project?.id !== p.id) selectProject(p);
                      setKbModalOpen(true);
                    }}
                    title="Настройки проекта (база знаний)"
                    aria-label="Настройки проекта"
                    className="shrink-0 rounded p-1 text-gray-300 hover:bg-gray-100 hover:text-gray-600"
                  >
                    <Settings className="h-4 w-4" aria-hidden />
                  </button>
                </div>
              );
            })
          )}
          {error && !projectsLoading ? (
            <div className="p-3 text-sm text-red-600">{error}</div>
          ) : null}
        </div>
      </aside>

      {/* Колонка 2: письма */}
      <div className="flex min-h-0 flex-col border-r border-gray-200 bg-white">
        <div className="flex items-center justify-between gap-2 border-b border-gray-100 px-3 py-2.5">
          <h2 className="text-sm font-semibold text-gray-900">
            {project ? `Письма (${total ?? `${items.length}${hasMore ? '+' : ''}`})` : 'Письма'}
          </h2>
          {project ? (
            <button
              type="button"
              onClick={() => reloadReplies()}
              disabled={itemsLoading}
              title="Обновить список"
              className="rounded p-1 text-gray-400 hover:bg-gray-100 hover:text-gray-600 disabled:opacity-50"
            >
              <RefreshCw className={`h-4 w-4 ${itemsLoading ? 'animate-spin' : ''}`} aria-hidden />
            </button>
          ) : null}
        </div>
        {project && !missingReason ? (
          <div className="space-y-2 border-b border-gray-100 px-3 py-2">
            <div className="relative">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-gray-400" aria-hidden />
              <input
                value={replyQuery}
                onChange={(e) => setReplyQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Escape') setReplyQuery('');
                }}
                placeholder="Найти по почте или компании"
                aria-label="Найти письмо по почте"
                className="w-full rounded-lg border border-gray-200 bg-white py-1.5 pl-8 pr-7 text-sm text-gray-900 focus:border-blue-400 focus:outline-none"
              />
              {replyQuery ? (
                <button
                  type="button"
                  onClick={() => setReplyQuery('')}
                  aria-label="Очистить поиск"
                  className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded p-0.5 text-gray-400 hover:bg-gray-100 hover:text-gray-600"
                >
                  <X className="h-3.5 w-3.5" aria-hidden />
                </button>
              ) : null}
            </div>
            {campaigns.length > 1 ? (
              <div className="flex max-h-28 flex-wrap gap-1 overflow-y-auto" role="group" aria-label="Кампании">
                {[{ id: '', name: 'Все кампании', replyCount: allCampaignsCount }, ...campaigns].map((c) => {
                  const isActive = campaignFilter === c.id;
                  return (
                    <button
                      key={c.id || 'all'}
                      type="button"
                      onClick={() => {
                        setCampaignFilter(c.id);
                        setLimit(REPLIES_PAGE_SIZE);
                      }}
                      title={c.name}
                      aria-pressed={isActive}
                      className={`flex max-w-full items-center gap-1 rounded-full border px-2 py-0.5 text-xs transition ${
                        isActive
                          ? 'border-blue-500 bg-blue-50 text-blue-700'
                          : 'border-gray-200 text-gray-600 hover:bg-gray-50'
                      }`}
                    >
                      <span className="truncate">{c.name}</span>
                      {c.replyCount !== null ? (
                        <span className={isActive ? 'text-blue-500' : 'text-gray-400'}>{c.replyCount}</span>
                      ) : null}
                    </button>
                  );
                })}
              </div>
            ) : null}
          </div>
        ) : null}
        <div className="flex-1 overflow-y-auto">
          {!project ? (
            <div className="p-3 text-sm text-gray-500">Выберите проект слева.</div>
          ) : missingReason ? (
            <div className="p-3 text-sm text-gray-500">
              {missingReason} — ИИ не из чего собрать ответ. Заполните бриф в карточке проекта или
              нажмите шестерёнку у проекта слева и вставьте его там.
            </div>
          ) : itemsLoading && items.length === 0 ? (
            <div className="p-3 text-sm text-gray-500">Загрузка...</div>
          ) : items.length === 0 ? (
            <div className="p-3 text-sm text-gray-500">
              {filtersActive ? 'По этому фильтру писем нет.' : 'Пока никто не ответил.'}
            </div>
          ) : (
            <>
            {items.map((item) => (
              <button
                key={item.id}
                type="button"
                onClick={() => setSelectedId(item.id)}
                className={`block w-full border-l-2 px-3 py-2.5 text-left transition ${
                  selectedId === item.id
                    ? 'border-blue-500 bg-blue-50'
                    : 'border-transparent hover:bg-gray-50'
                }`}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="truncate text-sm font-medium text-gray-900">
                    {item.companyName || item.leadEmail}
                  </span>
                  <span
                    className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] font-semibold ${LIST_STATUS_BADGE[item.listStatus].className}`}
                  >
                    {LIST_STATUS_BADGE[item.listStatus].label}
                  </span>
                </div>
                {item.companyName ? (
                  <div className="truncate text-[11px] text-gray-400">{item.leadEmail}</div>
                ) : null}
                <div className="mt-0.5 truncate text-xs text-gray-500">{item.replyBody}</div>
                <div className="mt-0.5 flex items-center gap-1.5 text-[11px] text-gray-400">
                  <span className="shrink-0">{formatDate(item.replyTimestamp)}</span>
                  {!campaignFilter && item.campaignName ? (
                    <span className="truncate" title={item.campaignName}>
                      · {item.campaignName}
                    </span>
                  ) : null}
                </div>
              </button>
            ))}
            {hasMore ? (
              <div ref={loadMoreRef} className="p-3 text-center text-xs text-gray-400">
                Загрузка...
              </div>
            ) : null}
            </>
          )}
        </div>
      </div>

      {/* Колонка 3: диалог */}
      <div className="flex min-h-0 flex-col bg-white">
        {selected && project ? (
          <ReplyDetailPanel
            key={selected.id}
            projectId={project.id}
            item={selected}
            onHandled={handleHandled}
          />
        ) : (
          <div className="flex flex-1 items-center justify-center text-sm text-gray-500">
            Выберите письмо из списка
          </div>
        )}
      </div>

      {/* Модалка настроек проекта (база знаний) */}
      {kbModalOpen && project ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div className="fixed inset-0 bg-black/40" onClick={() => setKbModalOpen(false)} />
          <div className="relative w-full max-w-2xl overflow-hidden rounded-2xl bg-white shadow-2xl">
            <KnowledgeBaseForm
              projectId={project.id}
              onClose={() => setKbModalOpen(false)}
              onSaved={handleKbSaved}
            />
          </div>
        </div>
      ) : null}

      {/* Модалка глобальных настроек (тон/пример по умолчанию, для руководителей) */}
      {globalKbModalOpen ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div className="fixed inset-0 bg-black/40" onClick={() => setGlobalKbModalOpen(false)} />
          <div className="relative w-full max-w-2xl overflow-hidden rounded-2xl bg-white shadow-2xl">
            <GlobalKnowledgeForm onClose={() => setGlobalKbModalOpen(false)} />
          </div>
        </div>
      ) : null}
    </div>
  );
}
