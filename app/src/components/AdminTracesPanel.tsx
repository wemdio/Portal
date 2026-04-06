'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { supabase } from '@/lib/supabaseClient';

/* -------------------------------------------------------------------------- */
/*  Types                                                                     */
/* -------------------------------------------------------------------------- */

type SpanRow = {
  id: string;
  trace_id: string;
  parent_span_id: string | null;
  name: string;
  status: 'running' | 'completed' | 'failed' | 'cancelled';
  input: Record<string, unknown>;
  output: Record<string, unknown>;
  started_at: string;
  ended_at: string | null;
  duration_ms: number | null;
  user_id: string | null;
  job_id: string | null;
  level: 'info' | 'warn' | 'error';
  message: string | null;
  created_at: string;
};

type LogEntry = {
  id: string;
  created_at: string;
  level: 'info' | 'warn' | 'error';
  source: 'server' | 'client' | 'audit';
  event: string;
  message: string;
  context?: Record<string, unknown> | null;
  user_id?: string | null;
  request_id?: string | null;
  route?: string | null;
  ip?: string | null;
};

type TraceGroup = {
  trace_id: string;
  root: SpanRow;
  spans: SpanRow[];
  logs: LogEntry[];
};

type SpanNode = SpanRow & {
  children: SpanNode[];
  depth: number;
};

/* -------------------------------------------------------------------------- */
/*  Helpers                                                                   */
/* -------------------------------------------------------------------------- */

function buildTree(spans: SpanRow[]): SpanNode[] {
  const map = new Map<string, SpanNode>();
  const roots: SpanNode[] = [];

  for (const span of spans) {
    map.set(span.id, { ...span, children: [], depth: 0 });
  }

  for (const span of spans) {
    const node = map.get(span.id)!;
    if (span.parent_span_id && map.has(span.parent_span_id)) {
      const parent = map.get(span.parent_span_id)!;
      node.depth = parent.depth + 1;
      parent.children.push(node);
    } else {
      roots.push(node);
    }
  }

  return roots;
}

function formatDuration(ms: number | null | undefined): string {
  if (ms == null) return '—';
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const min = Math.floor(ms / 60_000);
  const sec = Math.round((ms % 60_000) / 1000);
  return `${min}m ${sec}s`;
}

function formatTimestamp(value: string): string {
  try {
    return new Date(value).toLocaleString('ru-RU', {
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
  } catch {
    return value;
  }
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value ?? '');
  }
}

function isEmptyObj(obj: Record<string, unknown> | null | undefined): boolean {
  if (!obj) return true;
  return Object.keys(obj).length === 0;
}

function getInputValue(input: Record<string, unknown> | null | undefined, key: string): string | null {
  if (!input) return null;
  const value = input[key];
  if (value == null) return null;
  if (typeof value === 'string' || typeof value === 'number') return String(value);
  return null;
}

function mapLogToSpan(log: LogEntry, root: SpanRow): SpanRow {
  return {
    id: `log:${log.id}`,
    trace_id: root.trace_id,
    parent_span_id: root.id,
    name: log.event,
    status: 'completed',
    input: log.context ?? {},
    output: {},
    started_at: log.created_at,
    ended_at: log.created_at,
    duration_ms: null,
    user_id: log.user_id ?? null,
    job_id: root.job_id ?? null,
    level: log.level,
    message: log.message,
    created_at: log.created_at,
  };
}

/* -------------------------------------------------------------------------- */
/*  Status styling                                                            */
/* -------------------------------------------------------------------------- */

const STATUS_CONFIG: Record<
  SpanRow['status'],
  { label: string; bg: string; text: string; dot: string; ring: string }
> = {
  running: {
    label: 'Выполняется',
    bg: 'bg-blue-50',
    text: 'text-blue-700',
    dot: 'bg-blue-500',
    ring: 'ring-blue-200',
  },
  completed: {
    label: 'Завершено',
    bg: 'bg-emerald-50',
    text: 'text-emerald-700',
    dot: 'bg-emerald-500',
    ring: 'ring-emerald-200',
  },
  failed: {
    label: 'Ошибка',
    bg: 'bg-red-50',
    text: 'text-red-700',
    dot: 'bg-red-500',
    ring: 'ring-red-200',
  },
  cancelled: {
    label: 'Отменено',
    bg: 'bg-amber-50',
    text: 'text-amber-700',
    dot: 'bg-amber-500',
    ring: 'ring-amber-200',
  },
};

const LEVEL_DOT: Record<SpanRow['level'], string> = {
  info: 'bg-gray-400',
  warn: 'bg-amber-400',
  error: 'bg-red-400',
};

/* -------------------------------------------------------------------------- */
/*  SpanTreeItem component                                                    */
/* -------------------------------------------------------------------------- */

function SpanTreeItem({ node, isLast }: { node: SpanNode; isLast: boolean }) {
  const [expanded, setExpanded] = useState(false);
  const hasChildren = node.children.length > 0;
  const hasDetails = !isEmptyObj(node.input) || !isEmptyObj(node.output) || Boolean(node.message);
  const canExpand = hasChildren || hasDetails;
  const status = STATUS_CONFIG[node.status];
  const isRoot = node.depth === 0;

  return (
    <div className={isRoot ? '' : 'ml-5'}>
      {/* Connector line */}
      {!isRoot && (
        <div className="relative">
          <div
            className={`absolute -left-5 top-0 w-5 border-l-2 border-b-2 border-gray-200 rounded-bl-md ${
              isLast ? 'h-5' : 'h-full'
            }`}
            style={{ top: 0, height: isLast ? '20px' : '100%' }}
          />
        </div>
      )}

      {/* Span row */}
      <div
        role={canExpand ? 'button' : undefined}
        tabIndex={canExpand ? 0 : undefined}
        onClick={canExpand ? () => setExpanded(!expanded) : undefined}
        onKeyDown={
          canExpand
            ? (e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  setExpanded(!expanded);
                }
              }
            : undefined
        }
        className={`group relative flex items-start gap-3 py-2.5 px-3 rounded-lg transition-colors ${
          node.status === 'failed'
            ? 'bg-red-50/50 hover:bg-red-50'
            : node.status === 'running'
              ? 'bg-blue-50/30 hover:bg-blue-50/60'
              : 'hover:bg-gray-50'
        }`}
      >
        {/* Expand toggle / status dot */}
        <div className="flex-shrink-0 mt-0.5">
          {canExpand ? (
            <button
              onClick={(e) => {
                e.stopPropagation();
                setExpanded(!expanded);
              }}
              className="flex items-center justify-center w-5 h-5 rounded text-gray-500 hover:bg-gray-200 transition-colors"
            >
              <svg
                className={`w-3.5 h-3.5 transition-transform ${expanded ? 'rotate-90' : ''}`}
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                strokeWidth={2}
              >
                <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
              </svg>
            </button>
          ) : (
            <div className="flex items-center justify-center w-5 h-5">
              <div className={`w-2 h-2 rounded-full ${status.dot}`} />
            </div>
          )}
        </div>

        {/* Content */}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-mono text-sm sm:text-lg font-semibold text-gray-900 break-all sm:break-normal">
              {node.name}
            </span>

            {/* Status badge */}
            <span
              className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full text-[10px] font-semibold ${status.bg} ${status.text}`}
            >
              {node.status === 'running' && (
                <span className="relative flex h-2 w-2">
                  <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-blue-400 opacity-75" />
                  <span className="relative inline-flex rounded-full h-2 w-2 bg-blue-500" />
                </span>
              )}
              {status.label}
            </span>

            {/* Duration */}
            {node.duration_ms != null && (
              <span className="text-xs sm:text-base text-gray-400 font-mono">
                {formatDuration(node.duration_ms)}
              </span>
            )}

            {/* Level dot */}
            {node.level !== 'info' && (
              <span className={`w-1.5 h-1.5 rounded-full ${LEVEL_DOT[node.level]}`} />
            )}
          </div>

          {/* Message */}
          {node.message && (
            <p className="mt-0.5 text-xs sm:text-lg text-gray-600 truncate">{node.message}</p>
          )}

          {expanded && (
            <div
              className="mt-2 space-y-2"
              onClick={(e) => e.stopPropagation()}
              onKeyDown={(e) => e.stopPropagation()}
            >
              {!isEmptyObj(node.input) && (
                <details className="text-xs sm:text-base">
                  <summary className="cursor-pointer text-gray-500 hover:text-gray-700 select-none font-medium">
                    Параметры запроса
                  </summary>
                  <pre className="mt-1 p-2 rounded-md bg-gray-50 border border-gray-100 text-gray-700 whitespace-pre-wrap break-words overflow-auto max-h-52 text-xs sm:text-base">
                    {safeJson(node.input)}
                  </pre>
                </details>
              )}
              {!isEmptyObj(node.output) && (
                <details className="text-xs sm:text-base" open={node.status === 'failed'}>
                  <summary className="cursor-pointer text-gray-500 hover:text-gray-700 select-none font-medium">
                    Результат
                  </summary>
                  <pre
                    className={`mt-1 p-2 rounded-md border whitespace-pre-wrap break-words overflow-auto max-h-52 text-xs sm:text-base ${
                      node.status === 'failed'
                        ? 'bg-red-50 border-red-100 text-red-700'
                        : 'bg-gray-50 border-gray-100 text-gray-700'
                    }`}
                  >
                    {safeJson(node.output)}
                  </pre>
                </details>
              )}
            </div>
          )}
        </div>

        {/* Timestamp - right side */}
        <div className="flex-shrink-0 text-right">
          <span className="text-[10px] sm:text-sm text-gray-400">{formatTimestamp(node.started_at)}</span>
        </div>
      </div>

      {/* Children */}
      {expanded && hasChildren && (
        <div className="relative">
          {node.children.map((child, i) => (
            <SpanTreeItem
              key={child.id}
              node={child}
              isLast={i === node.children.length - 1}
            />
          ))}
        </div>
      )}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/*  TraceCard component                                                       */
/* -------------------------------------------------------------------------- */

function TraceCard({ trace }: { trace: TraceGroup }) {
  const [expanded, setExpanded] = useState(false);
  const mergedSpans = useMemo(() => {
    if (!trace.logs || trace.logs.length === 0) return trace.spans;
    const logSpans = trace.logs.map((log) => mapLogToSpan(log, trace.root));
    return [...trace.spans, ...logSpans];
  }, [trace.logs, trace.root, trace.spans]);
  const tree = useMemo(() => buildTree(mergedSpans), [mergedSpans]);
  const root = trace.root;
  const status = STATUS_CONFIG[root.status];
  const childCount = Math.max(0, mergedSpans.length - 1);
  const metaRoute = getInputValue(root.input, 'route');
  const metaIp = getInputValue(root.input, 'ip');
  const metaRequestId = getInputValue(root.input, 'requestId');
  const metaUserId = root.user_id ?? getInputValue(root.input, 'userId');
  const metaAccount =
    getInputValue(root.input, 'account') ??
    getInputValue(root.input, 'phone') ??
    getInputValue(root.input, 'phoneNumber');

  return (
    <div
      className={`rounded-xl border transition-all ${
        root.status === 'failed'
          ? 'border-red-200 bg-white'
          : root.status === 'running'
            ? 'border-blue-200 bg-white ring-1 ' + status.ring
            : 'border-gray-200 bg-white'
      }`}
    >
      {/* Root span header */}
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full text-left px-5 py-4 flex items-start gap-3 hover:bg-gray-50/50 transition-colors rounded-xl"
      >
        {/* Expand icon */}
        <div className="flex-shrink-0 mt-0.5">
          <svg
            className={`w-4 h-4 text-gray-400 transition-transform ${expanded ? 'rotate-90' : ''}`}
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            strokeWidth={2}
          >
            <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
          </svg>
        </div>

        {/* Content */}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2.5 flex-wrap">
            <span className="font-mono text-sm sm:text-xl font-bold text-gray-900 break-all sm:break-normal">
              {root.name}
            </span>

            {/* Status badge */}
            <span
              className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-xs font-semibold ${status.bg} ${status.text}`}
            >
              {root.status === 'running' && (
                <span className="relative flex h-2 w-2">
                  <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-blue-400 opacity-75" />
                  <span className="relative inline-flex rounded-full h-2 w-2 bg-blue-500" />
                </span>
              )}
              {status.label}
            </span>

            {/* Duration */}
            {root.duration_ms != null && (
              <span className="text-xs sm:text-lg text-gray-400 font-mono">
                {formatDuration(root.duration_ms)}
              </span>
            )}

            {/* Child count */}
            {childCount > 0 && (
              <span className="text-xs sm:text-base text-gray-400 bg-gray-100 px-2 py-0.5 sm:px-2.5 sm:py-1 rounded-md">
                {childCount} {childCount === 1 ? 'подзадача' : childCount < 5 ? 'подзадачи' : 'подзадач'}
              </span>
            )}
          </div>

          {/* Message */}
          {root.message && (
            <p className="mt-1 text-xs sm:text-lg text-gray-600">{root.message}</p>
          )}

          {/* Meta row */}
          <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] sm:text-base text-gray-400">
            <span>{formatTimestamp(root.started_at)}</span>
            {root.job_id && (
              <span className="font-mono truncate max-w-[180px]" title={root.job_id}>
                job: {root.job_id.slice(0, 8)}…
              </span>
            )}
            {metaUserId && (
              <span className="font-mono truncate max-w-[180px]" title={metaUserId}>
                user: {metaUserId.slice(0, 8)}…
              </span>
            )}
            {metaAccount && (
              <span className="font-mono truncate max-w-[180px]" title={metaAccount}>
                account: {metaAccount}
              </span>
            )}
            {metaRoute && (
              <span className="truncate max-w-[220px]" title={metaRoute}>
                {metaRoute}
              </span>
            )}
            {metaIp && (
              <span className="font-mono" title={metaIp}>
                ip: {metaIp}
              </span>
            )}
            {metaRequestId && (
              <span className="font-mono truncate max-w-[180px]" title={metaRequestId}>
                req: {metaRequestId.slice(0, 8)}…
              </span>
            )}
          </div>
        </div>
      </button>

      {/* Expanded tree */}
      {expanded && (
        <div className="border-t border-gray-100 px-4 py-3">
          {!isEmptyObj(root.input) && (
            <details className="mb-3 text-xs sm:text-base" open>
              <summary className="cursor-pointer text-gray-500 hover:text-gray-700 select-none font-medium">
                Параметры запроса
              </summary>
              <pre className="mt-1 p-2 rounded-md bg-gray-50 border border-gray-100 text-gray-700 whitespace-pre-wrap break-words overflow-auto max-h-60 text-xs sm:text-base">
                {safeJson(root.input)}
              </pre>
            </details>
          )}
          {!isEmptyObj(root.output) && (
            <details className="mb-3 text-xs sm:text-base" open={root.status === 'failed'}>
              <summary className="cursor-pointer text-gray-500 hover:text-gray-700 select-none font-medium">
                Результат
              </summary>
              <pre
                className={`mt-1 p-2 rounded-md border whitespace-pre-wrap break-words overflow-auto max-h-60 text-xs sm:text-base ${
                  root.status === 'failed'
                    ? 'bg-red-50 border-red-100 text-red-700'
                    : 'bg-gray-50 border-gray-100 text-gray-700'
                }`}
              >
                {safeJson(root.output)}
              </pre>
            </details>
          )}
          {tree.length === 0 ? (
            <p className="text-sm text-gray-400 py-2">Нет подзадач</p>
          ) : (
            <div className="space-y-0.5">
              {tree.map((rootNode, i) => (
                <SpanTreeItem
                  key={rootNode.id}
                  node={rootNode}
                  isLast={i === tree.length - 1}
                />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/*  Real-time active tasks counter                                            */
/* -------------------------------------------------------------------------- */

type RealtimeSpanPayload = {
  id: string;
  parent_span_id: string | null;
  status: string;
};

type ActiveTask = {
  id: string;
  name: string;
  message: string | null;
  started_at: string;
  input: Record<string, unknown>;
  user_id: string | null;
};

const TASK_NAME_RU: Record<string, string> = {
  'tg-outreach.campaign.run': 'TG-рассылка',
  'database.brief_scoring': 'Скоринг по брифу',
  'database.email_validation': 'Валидация email-адресов',
  'database.email_scraping': 'Поиск email-адресов',
  'database.website_enrichment': 'Обогащение по сайтам',
  'database.site_availability': 'Проверка доступности сайтов',
  'yandexmaps.collect_links': 'Яндекс.Карты: сбор ссылок',
  'yandexmaps.parse_orgs': 'Яндекс.Карты: парсинг организаций',
  'search.execute': 'Поисковый парсинг',
  'hh.execute': 'Парсинг HeadHunter',
  'audio_transcribe.process': 'Расшифровка аудио/видео',
  'email_sequence.generate_chain': 'Генерация цепочки писем',
  'email_sequence.analyze_segment': 'Анализ сегмента',
  'email_sequence.generate_segments': 'Генерация сегментов',
};

function resolveTaskDisplayName(task: ActiveTask): string {
  if (task.message) return task.message;
  if (TASK_NAME_RU[task.name]) return TASK_NAME_RU[task.name];
  return task.name;
}

/* -------------------------------------------------------------------------- */
/*  Task source resolution                                                    */
/* -------------------------------------------------------------------------- */

type TaskSource = { label: string; badgeClass: string };

const TOOL_DETAIL_RU: Record<string, string> = {
  'tg-transcribe': 'TG Расшифровка',
  'tg-parser': 'TG Парсер',
  'tg-outreach': 'TG Аутрич',
  'li-outreach': 'LinkedIn Аутрич',
  'cis-leads': 'CIS Лиды',
  'email-sequence': 'Email-цепочки',
  'audio-transcribe': 'Расшифровка',
  'habr-career': 'Хабр Карьера',
  'rdp': 'RDP',
  'dfyb': 'DFYB',
  'auto-report': 'Авто-отчёт',
};

function resolveTaskSource(name: string): TaskSource {
  if (name.startsWith('tools.')) {
    const tool = name.split('.')[1] ?? '';
    const isWebhook = name.includes('.webhook.');
    const detail = TOOL_DETAIL_RU[tool] ?? tool;
    return isWebhook
      ? { label: `Вебхук: ${detail}`, badgeClass: 'bg-violet-100 text-violet-700' }
      : { label: `API: ${detail}`, badgeClass: 'bg-indigo-100 text-indigo-700' };
  }
  if (name.startsWith('tg-outreach.')) return { label: 'Воркер: TG Аутрич', badgeClass: 'bg-green-100 text-green-700' };
  if (name.startsWith('hh.')) return { label: 'Парсер: HeadHunter', badgeClass: 'bg-orange-100 text-orange-700' };
  if (name.startsWith('yandexmaps.')) return { label: 'Парсер: Яндекс.Карты', badgeClass: 'bg-orange-100 text-orange-700' };
  if (name.startsWith('search.')) return { label: 'Парсер: Поисковый', badgeClass: 'bg-orange-100 text-orange-700' };
  if (name === 'database.brief_scoring') return { label: 'Воркер: Скоринг', badgeClass: 'bg-teal-100 text-teal-700' };
  if (name === 'database.email_validation') return { label: 'Воркер: Email-валидация', badgeClass: 'bg-teal-100 text-teal-700' };
  if (name === 'database.email_scraping') return { label: 'Воркер: Email-поиск', badgeClass: 'bg-teal-100 text-teal-700' };
  if (name === 'database.website_enrichment') return { label: 'Воркер: Обогащение сайтов', badgeClass: 'bg-teal-100 text-teal-700' };
  if (name === 'database.site_availability') return { label: 'Воркер: Проверка сайтов', badgeClass: 'bg-teal-100 text-teal-700' };
  if (name.startsWith('audio_transcribe.')) return { label: 'API: Расшифровка', badgeClass: 'bg-indigo-100 text-indigo-700' };
  if (name.startsWith('email_sequence.')) return { label: 'API: Email-цепочки', badgeClass: 'bg-indigo-100 text-indigo-700' };
  return { label: name.split('.')[0], badgeClass: 'bg-gray-100 text-gray-600' };
}

function useActiveTasks() {
  const [tasks, setTasks] = useState<Map<string, ActiveTask>>(new Map());
  const [profiles, setProfiles] = useState<Map<string, string>>(new Map());
  const [initialised, setInitialised] = useState(false);
  const mountedRef = useRef(true);
  const fetchedProfileIdsRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    mountedRef.current = true;

    async function fetchProfilesForIds(userIds: string[]) {
      const toFetch = userIds.filter(id => id && !fetchedProfileIdsRef.current.has(id));
      if (toFetch.length === 0) return;
      for (const id of toFetch) fetchedProfileIdsRef.current.add(id);
      const { data } = await supabase.from('profiles').select('id, full_name').in('id', toFetch);
      if (!data || !mountedRef.current) return;
      setProfiles(prev => {
        const next = new Map(prev);
        for (const p of data) if (p.full_name) next.set(p.id, p.full_name);
        return next;
      });
    }

    async function fetchInitial() {
      const { data } = await supabase
        .from('trace_spans')
        .select('id, name, message, started_at, input, user_id')
        .is('parent_span_id', null)
        .eq('status', 'running')
        .order('started_at', { ascending: false });

      if (mountedRef.current) {
        const map = new Map<string, ActiveTask>();
        const userIds: string[] = [];
        for (const r of data ?? []) {
          map.set(r.id, {
            id: r.id,
            name: r.name,
            message: r.message,
            started_at: r.started_at,
            input: r.input ?? {},
            user_id: r.user_id ?? null,
          });
          if (r.user_id) userIds.push(r.user_id);
        }
        setTasks(map);
        setInitialised(true);
        void fetchProfilesForIds(userIds);
      }
    }
    void fetchInitial();

    const channel = supabase
      .channel('active_tasks_counter')
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'trace_spans' },
        (payload) => {
          const row = payload.new as RealtimeSpanPayload & {
            name?: string; message?: string | null; started_at?: string;
            input?: Record<string, unknown>; user_id?: string | null;
          };
          if (row.parent_span_id !== null) return;
          if (row.status === 'running') {
            setTasks((prev) => {
              const next = new Map(prev);
              next.set(row.id, {
                id: row.id,
                name: row.name ?? row.id,
                message: row.message ?? null,
                started_at: row.started_at ?? new Date().toISOString(),
                input: row.input ?? {},
                user_id: row.user_id ?? null,
              });
              return next;
            });
            if (row.user_id) void fetchProfilesForIds([row.user_id]);
          }
        },
      )
      .on(
        'postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'trace_spans' },
        (payload) => {
          const row = payload.new as RealtimeSpanPayload & {
            name?: string; message?: string | null; started_at?: string;
            input?: Record<string, unknown>; user_id?: string | null;
          };
          if (row.parent_span_id !== null) return;
          setTasks((prev) => {
            const next = new Map(prev);
            if (row.status === 'running') {
              next.set(row.id, {
                id: row.id,
                name: row.name ?? row.id,
                message: row.message ?? null,
                started_at: row.started_at ?? new Date().toISOString(),
                input: row.input ?? {},
                user_id: row.user_id ?? null,
              });
            } else {
              next.delete(row.id);
            }
            return next;
          });
          if (row.user_id) void fetchProfilesForIds([row.user_id]);
        },
      )
      .subscribe();

    return () => {
      mountedRef.current = false;
      void supabase.removeChannel(channel);
    };
  }, []);

  const sorted = useMemo(
    () => Array.from(tasks.values()).sort((a, b) => b.started_at.localeCompare(a.started_at)),
    [tasks],
  );

  return { tasks: sorted, count: tasks.size, initialised, profiles };
}

function ActiveTasksBadge() {
  const { tasks, count, initialised, profiles } = useActiveTasks();

  return (
    <div className="mb-4 rounded-xl border border-gray-200 bg-white shadow-sm overflow-hidden">
      <div className="flex items-center gap-3 px-5 py-3.5">
        <div className="flex items-center gap-2.5">
          {count > 0 ? (
            <span className="relative flex h-3 w-3">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-blue-400 opacity-75" />
              <span className="relative inline-flex rounded-full h-3 w-3 bg-blue-500" />
            </span>
          ) : (
            <span className="h-3 w-3 rounded-full bg-gray-300" />
          )}
          <span className="text-sm font-medium text-gray-600">Активные задачи</span>
        </div>

        {!initialised ? (
          <div className="h-8 w-10 animate-pulse rounded bg-gray-100" />
        ) : (
          <span
            className={`text-2xl font-bold tabular-nums transition-all duration-300 ${
              count > 0 ? 'text-blue-600' : 'text-gray-400'
            }`}
          >
            {count}
          </span>
        )}
      </div>

      {initialised && tasks.length > 0 && (
        <div className="border-t border-gray-100 divide-y divide-gray-100">
          {tasks.map((task) => {
            const source = resolveTaskSource(task.name);
            const userName = task.user_id ? profiles.get(task.user_id) : null;
            return (
              <div key={task.id} className="flex items-start gap-3 px-5 py-2.5">
                <span className="relative flex h-2 w-2 flex-shrink-0 mt-1.5">
                  <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-blue-400 opacity-75" />
                  <span className="relative inline-flex rounded-full h-2 w-2 bg-blue-500" />
                </span>
                <div className="flex-1 min-w-0">
                  <span className="text-sm font-medium text-gray-800 truncate block">
                    {resolveTaskDisplayName(task)}
                  </span>
                  <div className="flex items-center gap-1.5 mt-0.5 flex-wrap">
                    <span className={`inline-flex items-center px-1.5 py-0.5 rounded-full text-[10px] font-semibold ${source.badgeClass}`}>
                      {source.label}
                    </span>
                    {userName && (
                      <span className="text-[11px] text-gray-400 truncate max-w-[180px]" title={userName}>
                        {userName}
                      </span>
                    )}
                  </div>
                </div>
                <span className="text-xs text-gray-400 flex-shrink-0 tabular-nums mt-0.5">
                  {formatTimestamp(task.started_at)}
                </span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/*  Main Panel                                                                */
/* -------------------------------------------------------------------------- */

type AdminTracesPanelProps = {
  title?: string;
  description?: string;
  jobId?: string;
};

export function AdminTracesPanel({
  title = 'Трассировки задач',
  description = 'Дерево выполнения задач',
  jobId,
}: AdminTracesPanelProps) {
  const [traces, setTraces] = useState<TraceGroup[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [statusFilter, setStatusFilter] = useState<'all' | SpanRow['status']>('all');
  const [search, setSearch] = useState('');
  const mountedRef = useRef(true);
  const inFlightRef = useRef(false);
  const pendingRefreshRef = useRef(false);
  const abortRef = useRef<AbortController | null>(null);

  const fetchTraces = useCallback(async () => {
    if (inFlightRef.current) {
      pendingRefreshRef.current = true;
      return;
    }

    inFlightRef.current = true;
    pendingRefreshRef.current = false;
    const controller = new AbortController();
    abortRef.current = controller;

    try {
      if (traces.length === 0) setLoading(true);
      const { data: { session } } = await supabase.auth.getSession();
      if (!session?.access_token) {
        setError('Не авторизован');
        return;
      }

      const params = new URLSearchParams({ limit: '50' });
      if (jobId) params.set('job_id', jobId);
      if (statusFilter !== 'all') params.set('status', statusFilter);

      const res = await fetch(`/api/traces?${params}`, {
        headers: { Authorization: `Bearer ${session.access_token}` },
        signal: controller.signal,
      });

      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }

      const { traces: data } = (await res.json()) as { traces: TraceGroup[] };
      if (mountedRef.current) {
        setTraces((data ?? []).map((trace) => ({ ...trace, logs: trace.logs ?? [] })));
        setError('');
      }
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') return;
      if (mountedRef.current) {
        setError(err instanceof Error ? err.message : 'Не удалось загрузить трассировки');
      }
    } finally {
      inFlightRef.current = false;
      if (mountedRef.current) setLoading(false);
      if (mountedRef.current && pendingRefreshRef.current) {
        pendingRefreshRef.current = false;
        queueMicrotask(() => {
          void fetchTraces();
        });
      }
    }
  }, [jobId, statusFilter, traces.length]);

  useEffect(() => {
    mountedRef.current = true;
    void fetchTraces();

    const channel = supabase
      .channel('trace_spans_realtime')
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'trace_spans' },
        () => {
          clearTimeout(realtimeRefreshTimer);
          realtimeRefreshTimer = setTimeout(() => {
            if (mountedRef.current) void fetchTraces();
          }, 1500);
        },
      )
      .subscribe();

    let pollTimer: ReturnType<typeof setTimeout>;
    const scheduleNextPoll = () => {
      clearTimeout(pollTimer);
      const delayMs = 10000 + Math.round(Math.random() * 5000);
      pollTimer = setTimeout(() => {
        if (!mountedRef.current) return;
        if (typeof document !== 'undefined' && document.visibilityState === 'hidden') {
          scheduleNextPoll();
          return;
        }
        void fetchTraces();
        scheduleNextPoll();
      }, delayMs);
    };
    scheduleNextPoll();

    let realtimeRefreshTimer: ReturnType<typeof setTimeout>;

    return () => {
      mountedRef.current = false;
      abortRef.current?.abort();
      clearTimeout(realtimeRefreshTimer);
      clearTimeout(pollTimer);
      void supabase.removeChannel(channel);
    };
  }, [fetchTraces]);

  const filtered = useMemo(() => {
    const term = search.trim().toLowerCase();
    if (!term) return traces;

    return traces.filter((t) => {
      const rootMatch =
        t.root.name.toLowerCase().includes(term) ||
        t.root.message?.toLowerCase().includes(term) ||
        t.root.job_id?.toLowerCase().includes(term);
      if (rootMatch) return true;

      const logMatch = t.logs?.some(
        (log) =>
          log.event.toLowerCase().includes(term) ||
          log.message.toLowerCase().includes(term) ||
          log.route?.toLowerCase().includes(term),
      );
      if (logMatch) return true;

      return t.spans.some(
        (s) =>
          s.name.toLowerCase().includes(term) ||
          s.message?.toLowerCase().includes(term),
      );
    });
  }, [traces, search]);

  return (
    <div>
      <ActiveTasksBadge />

      <div className="bg-white p-4 sm:p-7 rounded-xl border border-gray-200 shadow-sm">
        {/* Header */}
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <h2 className="text-lg sm:text-2xl font-semibold text-gray-900">{title}</h2>
            <p className="text-xs sm:text-base text-gray-500">{description}</p>
          </div>
        </div>

        {/* Filters */}
        <div className="mt-4 flex flex-wrap items-center gap-3">
          <select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value as 'all' | SpanRow['status'])}
            className="rounded-md border border-gray-200 bg-white px-3 py-2 text-sm sm:text-lg text-gray-700"
          >
            <option value="all">Все статусы</option>
            <option value="running">Выполняется</option>
            <option value="completed">Завершено</option>
            <option value="failed">Ошибка</option>
            <option value="cancelled">Отменено</option>
          </select>
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Поиск по имени, событию, сообщению, job_id..."
            className="flex-1 min-w-[220px] rounded-md border border-gray-200 px-3 py-2 text-sm sm:text-lg text-gray-700"
          />
        </div>

        {/* Error */}
        {error && (
          <div className="mt-4 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm sm:text-lg text-red-700">
            {error}
          </div>
        )}

        {/* Content */}
        {loading && traces.length === 0 ? (
          <div className="mt-6 text-sm sm:text-base text-gray-500">Загрузка трассировок...</div>
        ) : filtered.length === 0 ? (
          <div className="mt-6 text-sm sm:text-base text-gray-500">
            {traces.length === 0 ? 'Трассировки не найдены' : 'Нет совпадений по фильтру'}
          </div>
        ) : (
          <div className="mt-6 space-y-3">
            {filtered.map((trace) => (
              <TraceCard key={trace.trace_id} trace={trace} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
