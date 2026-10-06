'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown, Globe, RefreshCw, Search, Settings, X } from 'lucide-react';
import { fetchOthers, fetchProjects, fetchReplies, type ProjectListItem } from './api';
import { ColumnResizer, useColumnWidths } from '@/components/ResizableColumns';
import { GlobalKnowledgeForm } from './GlobalKnowledgeForm';
import { KnowledgeBaseForm } from './KnowledgeBaseForm';
import { ReplyDetailPanel } from './ReplyDetailPanel';
import type { ReplyCampaignOption, ReplyListItem } from '@/lib/replyPersonalization/types';

/** Писем за раз; при прокрутке к концу списка догружается следующая сотня. */
const REPLIES_PAGE_SIZE = 100;

type ListTab = 'replies' | 'others';

/** Полный адрес ищет сам Instantly; часть адреса или текста — среди загруженных писем Others. */
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

/** Догруженная страница Others без повторов и по дате: пачки ящиков листаются независимо. */
function mergeReplies(current: ReplyListItem[], next: ReplyListItem[]): ReplyListItem[] {
  const seen = new Set(current.map((item) => item.id));
  return [...current, ...next.filter((item) => !seen.has(item.id))].sort((a, b) =>
    (b.replyTimestamp ?? '').localeCompare(a.replyTimestamp ?? ''),
  );
}

// Ширина колонок «Проекты» и «Письма» тянется мышью — см. ResizableColumns.
const COLUMN_DEFAULTS = { projects: 240, list: 360 };
const COLUMN_LIMITS = { projects: [160, 520], list: [260, 760] } as const;

// hint — подсказка при наведении: что значит метка и что с письмом делать.
type Badge = { label: string; className: string; hint: string };

const LIST_STATUS_BADGE: Record<ReplyListItem['listStatus'], Badge> = {
  new: { label: 'новый', className: 'bg-blue-100 text-blue-700', hint: 'Человек ответил впервые, мы ещё не ответили' },
  sent: { label: 'отправлено', className: 'bg-emerald-100 text-emerald-700', hint: 'Мы уже ответили на это письмо' },
  skipped: { label: 'пропущено', className: 'bg-gray-100 text-gray-500', hint: 'Отмечено «Пропустить» — отвечать не стали' },
};

/** Необработанное письмо адресата, который уже отвечал раньше, — не «новый». */
const REPEAT_BADGE: Badge = {
  label: 'повторный',
  className: 'bg-violet-100 text-violet-700',
  hint: 'Человек уже писал нам раньше, это его следующее письмо; на него мы ещё не ответили',
};

function listBadge(item: ReplyListItem) {
  return item.listStatus === 'new' && item.repeat ? REPEAT_BADGE : LIST_STATUS_BADGE[item.listStatus];
}

/**
 * Вердикт квалификатора по ответу — им же помечены лиды в дашбордах. Раньше он
 * приходил в список, но нигде не показывался, и менеджер шёл по письмам подряд,
 * не зная, где интерес. Показываем только решённые случаи: 'pending',
 * 'processing', 'error' и письма живых аккаунтов метки не получают.
 */
const LEAD_BADGE: Record<string, Badge> = {
  lead: { label: 'лид', className: 'bg-amber-100 text-amber-800', hint: 'ИИ по тексту видит интерес — стоит ответить в первую очередь' },
  not_lead: { label: 'не лид', className: 'bg-gray-100 text-gray-400', hint: 'ИИ интереса не видит: отказ, автоответ или «переслали коллегам»' },
  needs_review: { label: 'под вопросом', className: 'bg-sky-100 text-sky-700', hint: 'ИИ не уверен — посмотрите письмо сами' },
};

function LeadBadge({ item }: { item: ReplyListItem }) {
  const badge = item.qualificationStatus ? LEAD_BADGE[item.qualificationStatus] : undefined;
  if (!badge) return null;
  return (
    <span
      className={`cursor-help rounded px-1.5 py-0.5 text-[10px] font-semibold ${badge.className}`}
      title={badge.hint}
    >
      {badge.label}
    </span>
  );
}

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
  /** Открыт ли выпадающий список кампаний; закрывается выбором или кликом мимо. */
  const [campaignsExpanded, setCampaignsExpanded] = useState(false);
  const campaignMenuRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!campaignsExpanded) return;
    const close = (event: MouseEvent) => {
      if (!campaignMenuRef.current?.contains(event.target as Node)) setCampaignsExpanded(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setCampaignsExpanded(false);
    };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', onKey);
    };
  }, [campaignsExpanded]);
  /**
   * «Только лиды» — письма, которым квалификатор поставил вердикт 'lead'.
   * Фильтруем на сервере: в списке подгружаются сотни писем страницами, и
   * отбор по загруженному куску показывал бы «лидов» меньше, чем их есть.
   */
  const [onlyLeads, setOnlyLeads] = useState(false);
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

  /** Вкладка списка: ответы проекта или папка Others в Instantly. */
  const [tab, setTab] = useState<ListTab>('replies');
  const tabRef = useRef<ListTab>('replies');
  useEffect(() => {
    tabRef.current = tab;
  }, [tab]);

  const reloadReplies = useCallback(async () => {
    if (!projectId) return;
    const seq = ++requestSeq.current;
    setItemsLoading(true);
    try {
      const res = await fetchReplies(projectId, {
        campaignId: campaignFilter || null,
        search: replySearch,
        limit,
        onlyLeads,
      });
      if (seq !== requestSeq.current) return;
      setItems(res.replies);
      setCampaigns(res.campaigns);
      setTotal(res.total);
      setHasMore(res.hasMore);
      setMissingReason(res.missingReason);
      // Пока открыта вкладка Others, выбранное там письмо не сбиваем.
      if (tabRef.current === 'replies') {
        setSelectedId((current) =>
          current && res.replies.some((r) => r.id === current) ? current : (res.replies[0]?.id ?? null),
        );
      }
    } catch (err) {
      if (seq === requestSeq.current) {
        setError(err instanceof Error ? err.message : 'Не удалось загрузить письма');
        // Иначе догрузка при прокрутке будет повторять упавший запрос по кругу.
        setHasMore(false);
      }
    } finally {
      if (seq === requestSeq.current) setItemsLoading(false);
    }
  }, [projectId, campaignFilter, replySearch, limit, onlyLeads]);

  useEffect(() => {
    reloadReplies();
  }, [reloadReplies]);

  // Вкладка Others — папка Others в Instantly по ящикам проекта. Грузится из
  // Instantly только когда её открыли, дальше — страницами по курсору.
  const [othersItems, setOthersItems] = useState<ReplyListItem[]>([]);
  const [othersCursor, setOthersCursor] = useState<string | null>(null);
  const [othersLoading, setOthersLoading] = useState(false);
  const [othersNotices, setOthersNotices] = useState<string[]>([]);
  /** Проект и поиск, для которых загружена первая страница; null — ещё не грузили. */
  const [othersLoadedKey, setOthersLoadedKey] = useState<string | null>(null);
  const othersSeq = useRef(0);
  const othersServerSearch = EMAIL_RE.test(replySearch) ? replySearch : '';
  const othersKey = projectId ? `${projectId}|${othersServerSearch}` : null;

  const loadOthers = useCallback(
    async (cursor: string | null, fresh = false) => {
      if (!projectId) return;
      const key = `${projectId}|${othersServerSearch}`;
      const seq = ++othersSeq.current;
      setOthersLoading(true);
      try {
        const res = await fetchOthers(projectId, { cursor, search: othersServerSearch, fresh });
        if (seq !== othersSeq.current) return;
        setOthersItems((current) => (cursor ? mergeReplies(current, res.replies) : res.replies));
        setOthersCursor(res.nextCursor);
        setOthersNotices(res.notices);
        setMissingReason(res.missingReason);
        if (!cursor && tabRef.current === 'others') {
          setSelectedId((current) =>
            current && res.replies.some((r) => r.id === current) ? current : (res.replies[0]?.id ?? null),
          );
        }
      } catch (err) {
        if (seq === othersSeq.current) {
          setError(err instanceof Error ? err.message : 'Не удалось загрузить Others');
          // Иначе догрузка при прокрутке будет повторять упавший запрос по кругу.
          setOthersCursor(null);
        }
      } finally {
        if (seq === othersSeq.current) {
          setOthersLoading(false);
          setOthersLoadedKey(key);
        }
      }
    },
    [projectId, othersServerSearch],
  );

  useEffect(() => {
    if (tab === 'others' && othersKey && othersLoadedKey !== othersKey) void loadOthers(null);
  }, [tab, othersKey, othersLoadedKey, loadOthers]);

  const othersVisible = useMemo(() => {
    const q = replySearch.toLowerCase();
    if (!q || othersServerSearch) return othersItems;
    return othersItems.filter((i) =>
      [i.leadEmail, i.replySubject, i.replyBody, i.eaccount].some((v) => (v ?? '').toLowerCase().includes(q)),
    );
  }, [othersItems, replySearch, othersServerSearch]);

  const selectProject = useCallback((p: ProjectListItem) => {
    othersSeq.current += 1;
    setOthersItems([]);
    setOthersCursor(null);
    setOthersNotices([]);
    setOthersLoadedKey(null);
    setOthersLoading(false);
    setProject(p);
    setItems([]);
    setCampaigns([]);
    setTotal(null);
    setHasMore(false);
    setSelectedId(null);
    setMissingReason(null);
    setCampaignFilter('');
    setCampaignsExpanded(false);
    setReplyQuery('');
    setReplySearch('');
    setLimit(REPLIES_PAGE_SIZE);
  }, []);

  const handleHandled = useCallback(
    (id: string, status: 'sent' | 'skipped') => {
      // Статус хранится у нас: письмо Others меняем на месте, не перечитывая
      // Instantly. Основной список на своей вкладке перечитываем, как раньше.
      const mark = (list: ReplyListItem[]) => list.map((i) => (i.id === id ? { ...i, listStatus: status } : i));
      setOthersItems(mark);
      if (tabRef.current === 'replies') reloadReplies();
      else setItems(mark);
    },
    [reloadReplies],
  );

  const switchTab = (next: ListTab) => {
    if (next === tab) return;
    setTab(next);
    const list = next === 'others' ? othersVisible : items;
    setSelectedId(list[0]?.id ?? null);
  };

  const handleKbSaved = useCallback(() => {
    // Пометку пересчитает сервер: сохранение базы знаний ещё не значит, что
    // бриф появился (могли сохранить только тон или пример).
    loadProjects();
    reloadReplies();
  }, [loadProjects, reloadReplies]);

  const filtersActive = Boolean(campaignFilter || replySearch || onlyLeads);
  /** Кампании проекта не привязаны — обе вкладки будут пустыми, и это не «никто не ответил». */
  const noCampaigns = Boolean(project) && !itemsLoading && campaigns.length === 0;
  /** Число на кнопке «Все кампании»; null — есть кампании без счётчика. */
  const allCampaignsCount = campaigns.every((c) => c.replyCount !== null)
    ? campaigns.reduce((sum, c) => sum + (c.replyCount ?? 0), 0)
    : null;
  const campaignOptions = [{ id: '', name: 'Все кампании', replyCount: allCampaignsCount }, ...campaigns];
  // Выбранная кампания пропала из списка (сменился проект) — подпись «Все кампании».
  const activeCampaign = campaignOptions.find((c) => c.id === campaignFilter) ?? campaignOptions[0];

  const listItems = tab === 'others' ? othersVisible : items;
  const listLoading = tab === 'others' ? othersLoading : itemsLoading;
  const listHasMore = tab === 'others' ? othersCursor !== null : hasMore;
  // Пока в Others ищем среди загруженного, сами Instantly дальше не листаем:
  // пустая выдача поиска выкачала бы всю папку. Дальше — по кнопке.
  const autoLoadMore = !(tab === 'others' && replySearch && !othersServerSearch);
  const loadMore = useCallback(() => {
    if (tab === 'others') void loadOthers(othersCursor);
    else setLimit((current) => current + REPLIES_PAGE_SIZE);
  }, [tab, loadOthers, othersCursor]);

  // Догрузка при прокрутке: как только низ списка показался, просим следующую
  // сотню. Пока идёт загрузка, не следим — иначе один показ даст несколько страниц.
  const loadMoreRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const target = loadMoreRef.current;
    if (!listHasMore || listLoading || !autoLoadMore || !target) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          observer.disconnect();
          loadMore();
        }
      },
      { rootMargin: '300px' },
    );
    observer.observe(target);
    return () => observer.disconnect();
  }, [listHasMore, listLoading, autoLoadMore, listItems, loadMore]);

  const selected = listItems.find((i) => i.id === selectedId) ?? null;

  // Поиск по списку проектов: их 60, и листать до нужного дольше, чем набрать
  // пару букв. Ищем по вхождению без учёта регистра и ё/е.
  const [projectQuery, setProjectQuery] = useState('');
  const columns = useColumnWidths('reply-personalization:column-widths', COLUMN_DEFAULTS, COLUMN_LIMITS);
  const visibleProjects = useMemo(() => {
    const norm = (v: string) => v.toLowerCase().replace(/ё/g, 'е').trim();
    const q = norm(projectQuery);
    return q ? projects.filter((p) => norm(p.client).includes(q)) : projects;
  }, [projects, projectQuery]);

  return (
    <div
      className="grid h-full min-h-0"
      style={{ gridTemplateColumns: `${columns.widths.projects}px ${columns.widths.list}px minmax(0,1fr)` }}
    >
      {/* Колонка 1: проекты */}
      <aside className="relative flex min-h-0 flex-col border-r border-gray-200 bg-white">
        <ColumnResizer
          onMouseDown={(e) => columns.startDrag('projects', e)}
          onDoubleClick={() => columns.reset('projects')}
        />
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
                    <span className="block truncate text-sm font-medium text-gray-900" title={p.client}>{p.client}</span>
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
      <div className="relative flex min-h-0 flex-col border-r border-gray-200 bg-white">
        <ColumnResizer
          onMouseDown={(e) => columns.startDrag('list', e)}
          onDoubleClick={() => columns.reset('list')}
        />
        <div className="flex items-center justify-between gap-2 border-b border-gray-100 px-3 py-2">
          {project ? (
            <div className="flex items-center gap-1" role="group" aria-label="Папка писем">
              {(
                [
                  ['replies', 'Ответы', total ?? `${items.length}${hasMore ? '+' : ''}`],
                  ['others', 'Others', othersLoadedKey ? `${othersVisible.length}${othersCursor ? '+' : ''}` : null],
                ] as const
              ).map(([id, label, count]) => (
                <button
                  key={id}
                  type="button"
                  onClick={() => switchTab(id)}
                  aria-pressed={tab === id}
                  className={`rounded-md px-2 py-1 text-sm font-semibold transition ${
                    tab === id ? 'bg-gray-100 text-gray-900' : 'text-gray-400 hover:text-gray-700'
                  }`}
                >
                  {label}
                  {count !== null ? <span className="ml-1 font-normal text-gray-400">{count}</span> : null}
                </button>
              ))}
            </div>
          ) : (
            <h2 className="text-sm font-semibold text-gray-900">Письма</h2>
          )}
          {project ? (
            <button
              type="button"
              onClick={() => (tab === 'others' ? void loadOthers(null, true) : reloadReplies())}
              disabled={listLoading}
              title="Обновить список"
              className="rounded p-1 text-gray-400 hover:bg-gray-100 hover:text-gray-600 disabled:opacity-50"
            >
              <RefreshCw className={`h-4 w-4 ${listLoading ? 'animate-spin' : ''}`} aria-hidden />
            </button>
          ) : null}
        </div>
        {project ? (
          <div className="space-y-2 border-b border-gray-100 px-3 py-2">
            <div className="relative">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-gray-400" aria-hidden />
              <input
                value={replyQuery}
                onChange={(e) => setReplyQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Escape') setReplyQuery('');
                }}
                placeholder={tab === 'others' ? 'Найти по почте или тексту' : 'Найти по почте или компании'}
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
            {/* Отбор по вердикту квалификатора. Вкладка Others живая, в ней
                вердикта нет вовсе — там переключатель не показываем. */}
            {tab === 'replies' ? (
              <button
                type="button"
                onClick={() => {
                  setOnlyLeads((v) => !v);
                  setLimit(REPLIES_PAGE_SIZE);
                }}
                aria-pressed={onlyLeads}
                title="Показать только ответы, которые квалификатор признал лидами"
                className={`rounded-full border px-2.5 py-1 text-xs transition ${
                  onlyLeads
                    ? 'border-amber-500 bg-amber-50 text-amber-800'
                    : 'border-gray-200 text-gray-600 hover:bg-gray-50'
                }`}
              >
                Только лиды
              </button>
            ) : null}
            {tab === 'others' && othersNotices.length ? (
              <div className="space-y-0.5 text-[11px] text-amber-600">
                {othersNotices.map((notice) => (
                  <p key={notice}>{notice}</p>
                ))}
              </div>
            ) : null}
            {tab === 'replies' && campaigns.length > 1 ? (
              // Кампании — выпадающим списком: лентой кнопок они занимали
              // полэкрана над письмами.
              <div ref={campaignMenuRef} className="relative">
                <button
                  type="button"
                  onClick={() => setCampaignsExpanded((v) => !v)}
                  aria-haspopup="listbox"
                  aria-expanded={campaignsExpanded}
                  className={`flex w-full items-center gap-2 rounded-lg border px-2.5 py-1.5 text-left text-xs transition ${
                    campaignFilter
                      ? 'border-blue-500 bg-blue-50 text-blue-700'
                      : 'border-gray-200 text-gray-600 hover:bg-gray-50'
                  }`}
                >
                  <span className="truncate">{activeCampaign.name}</span>
                  {activeCampaign.replyCount !== null ? (
                    <span className={campaignFilter ? 'text-blue-500' : 'text-gray-400'}>{activeCampaign.replyCount}</span>
                  ) : null}
                  <ChevronDown className={`ml-auto h-3.5 w-3.5 shrink-0 transition-transform ${campaignsExpanded ? 'rotate-180' : ''}`} />
                </button>
                {campaignsExpanded ? (
                  <div
                    role="listbox"
                    aria-label="Кампании"
                    className="absolute left-0 right-0 z-20 mt-1 max-h-80 overflow-y-auto rounded-lg border border-gray-200 bg-white py-1 shadow-lg"
                  >
                    {campaignOptions.map((c) => {
                      const isActive = campaignFilter === c.id;
                      return (
                        <button
                          key={c.id || 'all'}
                          type="button"
                          role="option"
                          aria-selected={isActive}
                          onClick={() => {
                            setCampaignFilter(c.id);
                            setLimit(REPLIES_PAGE_SIZE);
                            setCampaignsExpanded(false);
                          }}
                          title={c.name}
                          className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs transition ${
                            isActive ? 'bg-blue-50 text-blue-700' : 'text-gray-700 hover:bg-gray-50'
                          }`}
                        >
                          <span className="truncate">{c.name}</span>
                          {c.replyCount !== null ? (
                            <span className={`ml-auto shrink-0 ${isActive ? 'text-blue-500' : 'text-gray-400'}`}>{c.replyCount}</span>
                          ) : null}
                        </button>
                      );
                    })}
                  </div>
                ) : null}
              </div>
            ) : null}
          </div>
        ) : null}
        <div className="flex-1 overflow-y-auto">
          {/* Без брифа письма видны (с 06.10.2026): отвечать можно руками,
              ИИ соберёт черновик только из общих кейсов и тона. */}
          {project && missingReason ? (
            <p className="border-b border-amber-100 bg-amber-50 px-3 py-1.5 text-[11px] text-amber-700">
              Нет брифа — ИИ ответит только по общим кейсам и тону, лучше вручную
            </p>
          ) : null}
          {!project ? (
            <div className="p-3 text-sm text-gray-500">Выберите проект слева.</div>
          ) : listLoading && listItems.length === 0 ? (
            <div className="p-3 text-sm text-gray-500">Загрузка...</div>
          ) : (
            <>
            {listItems.length === 0 ? (
              // Пустой список без единой кампании — почти всегда не «никто не
              // ответил», а непривязанные кампании: переименование клиента в
              // карточке привязку не создаёт, её делают там же в карточке.
              noCampaigns ? (
                <div className="p-3 text-sm text-gray-500">
                  У проекта не привязано ни одной кампании Instantly — писем взять неоткуда.
                  Привяжите кампании в карточке проекта.
                </div>
              ) : (
                <div className="p-3 text-sm text-gray-500">
                  {tab === 'others'
                    ? replySearch
                      ? 'По этому поиску писем нет.'
                      : 'В Others по ящикам проекта писем нет.'
                    : filtersActive
                      ? 'По этому фильтру писем нет.'
                      : 'Пока никто не ответил.'}
                </div>
              )
            ) : null}
            {listItems.map((item) => (
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
                  <span className="min-w-0 truncate text-sm font-medium text-gray-900" title={item.companyName || item.leadEmail}>
                    {item.companyName || item.leadEmail}
                  </span>
                  <span className="flex shrink-0 items-center gap-1">
                    <LeadBadge item={item} />
                    <span
                      className={`cursor-help rounded px-1.5 py-0.5 text-[10px] font-semibold ${listBadge(item).className}`}
                      title={listBadge(item).hint}
                    >
                      {listBadge(item).label}
                    </span>
                  </span>
                </div>
                {item.companyName ? (
                  <div className="truncate text-[11px] text-gray-400">{item.leadEmail}</div>
                ) : null}
                {/* В Others тема отличает ответ («Re: …») от прогрева и рассылок. */}
                {item.source === 'others' && item.replySubject ? (
                  <div className="mt-0.5 truncate text-xs text-gray-700">{item.replySubject}</div>
                ) : null}
                <div className="mt-0.5 truncate text-xs text-gray-500">{item.replyBody}</div>
                <div className="mt-0.5 flex items-center gap-1.5 text-[11px] text-gray-400">
                  <span className="shrink-0">{formatDate(item.replyTimestamp)}</span>
                  {item.source === 'others' ? (
                    item.eaccount ? (
                      <span className="truncate" title={item.eaccount}>
                        · на {item.eaccount}
                      </span>
                    ) : null
                  ) : !campaignFilter && item.campaignName ? (
                    <span className="truncate" title={item.campaignName}>
                      · {item.campaignName}
                    </span>
                  ) : null}
                </div>
              </button>
            ))}
            {listHasMore ? (
              autoLoadMore ? (
                <div ref={loadMoreRef} className="p-3 text-center text-xs text-gray-400">
                  Загрузка...
                </div>
              ) : (
                <div className="p-3 text-center">
                  <button
                    type="button"
                    onClick={loadMore}
                    disabled={listLoading}
                    className="text-xs text-blue-600 hover:underline disabled:opacity-50"
                  >
                    {listLoading ? 'Загрузка...' : 'Искать в более старых письмах'}
                  </button>
                </div>
              )
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
