'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { supabase } from '@/lib/supabaseClient';
import { authFetch, getAccessToken } from '@/lib/authFetch';
import {
  Play,
  Loader2,
  Download,
  FileSpreadsheet,
  AlertCircle,
  Plus,
  Trash2,
  User,
  KeyRound,
  CheckCircle2,
  Upload,
  Square,
  ScrollText,
  ChevronDown,
  ChevronRight,
} from 'lucide-react';
import { saveAs } from 'file-saver';

import type { ParsedUser } from '@/lib/tgParser/types';
import {
  clampTgParserMaxContactsPerRun,
  TG_PARSER_MAX_CONTACTS_PER_RUN_DEFAULT,
  TG_PARSER_MAX_CONTACTS_PER_RUN_MAX,
} from '@/lib/tgParser/constants';
import type { ParseJob, TgParserJobApiRow } from '@/lib/tgParser/mapJobRow';
import { tgParserApiRowToUi } from '@/lib/tgParser/mapJobRow';
import { formatJobStart, formatElapsed } from '@/lib/tgParser/jobDisplay';

const COLUMNS: (keyof ParsedUser)[] = [
  'ID/Username',
  'ID',
  'Username',
  'Имя',
  'Фамилия',
  'Полное имя',
  'Пол',
  'Биография',
  'Личный канал',
  'Статус онлайн',
  'Последний раз в сети',
  'Сообщения',
  'Количество сообщений',
  'Тип источника',
  'Ссылка на источник',
  'Название источника',
];

/**
 * Ширина колонок результата, пиксели.
 *
 * Заданы явно и одинаково для шапки и строк. Иначе колонки разъезжаются: строки
 * виртуализированного списка вынуты из табличной раскладки (absolute + flex), и
 * автоширина ячеек шапки к ним уже не применяется — заголовки подгонялись под
 * длину своего текста, а данные шли ровными блоками.
 *
 * Размеры не равные: длинным полям вроде биографии и сообщений нужно больше
 * места, а «Пол» и «ID» читаются и в узкой колонке.
 */
const DEFAULT_COL_WIDTH = 190;
const COLUMN_WIDTH: Partial<Record<keyof ParsedUser, number>> = {
  'ID/Username': 190,
  ID: 120,
  Username: 170,
  Имя: 140,
  Фамилия: 140,
  'Полное имя': 210,
  Пол: 110,
  Биография: 360,
  'Личный канал': 240,
  'Статус онлайн': 130,
  'Последний раз в сети': 170,
  Сообщения: 360,
  'Количество сообщений': 150,
  'Тип источника': 160,
  'Ссылка на источник': 260,
  'Название источника': 220,
};

function colWidth(col: keyof ParsedUser): number {
  return COLUMN_WIDTH[col] ?? DEFAULT_COL_WIDTH;
}

const TABLE_WIDTH = COLUMNS.reduce((sum, col) => sum + colWidth(col), 0);

function cellValue(v: unknown): string {
  return String(v ?? '').replace(/\t/g, ' ').replace(/\r?\n/g, ' ');
}

function jobAccountKey(accountId: string): string {
  return accountId.trim() || '__env__';
}

type TgAccount = {
  id: string;
  name: string;
  api_id: number;
  api_hash: string;
  phone: string;
  proxy_url: string;
  session_data: string;
  is_active: boolean;
  max_contacts_per_run?: number;
  created_at: string;
};

type TgParserLog = {
  id: number;
  created_at: string;
  job_id: string;
  job_user_id: string;
  is_target: boolean;
  account_label: string | null;
  level: 'info' | 'warning' | 'error';
  message: string;
};

const API_ACCOUNTS = '/api/tools/tg-parser/accounts';

/** Задач на странице списка. */
const JOBS_PAGE_SIZE = 10;

/* ── Virtualized user table ── */

const PAGE_SIZE = 10;

/**
 * Таблица результатов — страницами по десять.
 *
 * Раньше здесь был виртуализированный список на полторы тысячи строк, и он
 * ломал раскладку: строки вынимались из таблицы (absolute + flex), а шапка
 * оставалась обычной и подгоняла колонки под длину заголовков. Совпасть они не
 * могли, данные уезжали относительно шапки.
 *
 * С десятью строками виртуализация не нужна, а обычная таблица выравнивает
 * колонки сама — та же правка чинит и раскладку, и читаемость: значения теперь
 * переносятся в две строки вместо обрезки.
 */
function UserTable({ users }: { users: ParsedUser[] }) {
  const [page, setPage] = useState(0);
  const pageCount = Math.max(1, Math.ceil(users.length / PAGE_SIZE));
  // Список мог смениться под руками (другая задача, перезагрузка) — держим
  // страницу в границах, иначе окажемся на пустой.
  const safePage = Math.min(page, pageCount - 1);
  const rows = users.slice(safePage * PAGE_SIZE, safePage * PAGE_SIZE + PAGE_SIZE);

  return (
    <div className="space-y-2">
      <div className="overflow-x-auto">
        <table className="text-sm" style={{ width: TABLE_WIDTH, tableLayout: 'fixed' }}>
          <colgroup>
            {COLUMNS.map((col) => (
              <col key={col} style={{ width: colWidth(col) }} />
            ))}
          </colgroup>
          <thead className="bg-gray-50">
            <tr>
              {COLUMNS.map((col) => (
                <th
                  key={col}
                  className="border-b border-gray-200 px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500"
                >
                  {col}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="bg-white">
            {rows.map((u, i) => (
              <tr key={safePage * PAGE_SIZE + i} className="border-b border-gray-100 hover:bg-gray-50">
                {COLUMNS.map((col) => {
                  const val = u[col];
                  const text = cellValue(val);
                  const isLink = col === 'Ссылка на источник' || col === 'Личный канал';
                  return (
                    <td
                      key={col}
                      title={text || undefined}
                      className="px-4 py-2.5 align-top text-gray-700"
                    >
                      {isLink && typeof val === 'string' && val.startsWith('http') ? (
                        <a
                          href={val}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="block truncate text-blue-600 hover:underline"
                        >
                          {val}
                        </a>
                      ) : (
                        // Две строки вместо обрезки в одну: биографию и
                        // сообщения в 190 пикселей одной строкой не прочитать.
                        <span className="line-clamp-2 break-words">{text}</span>
                      )}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="flex flex-wrap items-center gap-2 text-xs text-gray-600">
        <span>
          {(safePage * PAGE_SIZE + 1).toLocaleString('ru-RU')}–
          {Math.min((safePage + 1) * PAGE_SIZE, users.length).toLocaleString('ru-RU')}
          {' из '}
          {users.length.toLocaleString('ru-RU')}
        </span>
        <div className="ml-auto flex items-center gap-1">
          <button
            type="button"
            onClick={() => setPage(0)}
            disabled={safePage === 0}
            className="rounded-lg border border-gray-200 px-2 py-1 transition hover:bg-gray-50 disabled:opacity-40"
          >
            «
          </button>
          <button
            type="button"
            onClick={() => setPage((p) => Math.max(0, Math.min(p, pageCount - 1) - 1))}
            disabled={safePage === 0}
            className="rounded-lg border border-gray-200 px-2.5 py-1 transition hover:bg-gray-50 disabled:opacity-40"
          >
            Назад
          </button>
          <span className="px-1 tabular-nums">
            {safePage + 1} / {pageCount}
          </span>
          <button
            type="button"
            onClick={() => setPage((p) => Math.min(pageCount - 1, p + 1))}
            disabled={safePage >= pageCount - 1}
            className="rounded-lg border border-gray-200 px-2.5 py-1 transition hover:bg-gray-50 disabled:opacity-40"
          >
            Вперёд
          </button>
          <button
            type="button"
            onClick={() => setPage(pageCount - 1)}
            disabled={safePage >= pageCount - 1}
            className="rounded-lg border border-gray-200 px-2 py-1 transition hover:bg-gray-50 disabled:opacity-40"
          >
            »
          </button>
        </div>
      </div>
    </div>
  );
}

/* ── Job card with lazy-loaded users ── */

function JobCard({
  job,
  currentUserId,
  exportingJobId,
  stoppingJobId,
  now,
  onExportCsv,
  onExportExcel,
  onRemove,
  onStop,
}: {
  job: ParseJob;
  currentUserId: string | null;
  exportingJobId: string | null;
  stoppingJobId: string | null;
  /** Момент последнего опроса — точка отсчёта для «идёт N мин». */
  now: number;
  onExportCsv: (job: ParseJob) => void;
  onExportExcel: (job: ParseJob) => void;
  onRemove: (id: string) => void;
  onStop: (id: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [loadedUsers, setLoadedUsers] = useState<ParsedUser[] | null>(
    job.users.length > 0 ? job.users : null,
  );
  const [usersLoading, setUsersLoading] = useState(false);

  const canExpand = job.status === 'done' && job.userCount > 0;

  const handleToggle = useCallback(async () => {
    if (!canExpand) return;
    const next = !expanded;
    setExpanded(next);

    if (next && !loadedUsers) {
      setUsersLoading(true);
      try {
        const res = await authFetch(`/api/tools/tg-parser/jobs/${job.id}`);
        if (res.ok) {
          const { job: detail } = (await res.json()) as { job: { result_users: ParsedUser[] | null } };
          setLoadedUsers(detail.result_users ?? []);
        }
      } catch {
        /* ignore */
      } finally {
        setUsersLoading(false);
      }
    }
  }, [canExpand, expanded, loadedUsers, job.id]);

  const jobForExport = useMemo<ParseJob>(
    () => (loadedUsers ? { ...job, users: loadedUsers } : job),
    [job, loadedUsers],
  );

  return (
    <div
      className={`rounded-2xl border overflow-hidden ${
        job.status === 'running'
          ? 'border-blue-200 bg-blue-50/30'
          : job.status === 'error'
            ? 'border-red-200 bg-red-50/30'
            : job.warning
              ? 'border-amber-200 bg-amber-50/20'
              : 'border-gray-200 bg-white'
      }`}
    >
      <div className="p-4 border-b border-gray-200/80 flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 space-y-1 flex-1">
          <div className="flex flex-wrap items-center gap-2 text-sm">
            {canExpand && (
              <button type="button" onClick={handleToggle} className="p-0.5 text-gray-400 hover:text-gray-700">
                {expanded ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
              </button>
            )}
            {job.status === 'running' && (
              <Loader2 className="h-4 w-4 animate-spin text-blue-600 shrink-0" />
            )}
            <span className="font-medium text-gray-900">{job.accountLabel}</span>
            <span
              className={`inline-flex items-center rounded-full px-2 py-0.5 text-[11px] ${
                currentUserId && job.userId === currentUserId
                  ? 'bg-emerald-100 text-emerald-700'
                  : 'bg-slate-100 text-slate-700'
              }`}
            >
              {currentUserId && job.userId === currentUserId ? 'мой запуск' : 'чужой запуск'}
            </span>
            <span className="text-gray-500">
              · {job.linkCount} {job.linkCount === 1 ? 'чат' : 'чатов'}
            </span>
            <span className="text-gray-400 text-xs truncate max-w-full" title={job.linksSummary}>
              ({job.linksSummary})
            </span>
            {job.status === 'done' && job.userCount > 0 && (
              <span className="text-gray-500 text-xs">
                · {job.userCount.toLocaleString('ru-RU')} пользователей
              </span>
            )}
            {/* Идущая задача показывает, сколько уже собрано. Показываем и ноль:
                раньше счётчик появлялся только после первого пользователя, и
                всё время до него задача выглядела одинаково что при работе, что
                при зависании — а до первого контакта проходят минуты. */}
            {job.status === 'running' && (
              <span className="text-xs font-medium text-blue-700">
                · спарсилось: {(job.foundCount ?? 0).toLocaleString('ru-RU')}
              </span>
            )}
            {/* Дата запуска: в списке лежат задачи за несколько дней, и понять,
                вчерашняя это или сегодняшняя, было не по чему. */}
            <span className="text-gray-400 text-xs" title={new Date(job.startedAt).toLocaleString('ru-RU')}>
              · {formatJobStart(job.startedAt)}
            </span>
            {job.status === 'running' && (
              <span className="text-gray-400 text-xs">
                · идёт {formatElapsed(job.startedAt, now)}
              </span>
            )}
          </div>
          {job.status === 'running' && job.progressNote && (
            <p className="text-xs text-gray-500">
              {job.progressNote}
              {job.progressAt && (
                <span className="text-gray-400">
                  {' · '}
                  {new Date(job.progressAt).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })}
                </span>
              )}
            </p>
          )}
          {job.status === 'error' && job.error && (
            <p className="text-sm text-red-700">{job.error}</p>
          )}
          {job.status === 'done' && job.warning && (
            <p className="text-sm text-amber-900/90">{job.warning}</p>
          )}
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {job.status === 'running' && currentUserId && job.userId === currentUserId && (
            <button
              type="button"
              onClick={() => onStop(job.id)}
              disabled={stoppingJobId === job.id}
              className="inline-flex items-center gap-2 rounded-lg border border-red-200 bg-white px-3 py-1.5 text-sm font-medium text-red-700 hover:bg-red-50 disabled:opacity-50"
              title="Остановить задачу"
            >
              {stoppingJobId === job.id ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Square className="h-4 w-4" />
              )}
              Остановить
            </button>
          )}
          {job.status === 'done' && job.userCount > 0 && (
            <>
              <button
                type="button"
                onClick={() => {
                  if (loadedUsers) {
                    onExportCsv(jobForExport);
                  } else {
                    void (async () => {
                      const res = await authFetch(`/api/tools/tg-parser/jobs/${job.id}`);
                      if (res.ok) {
                        const { job: detail } = (await res.json()) as { job: { result_users: ParsedUser[] | null } };
                        const users = detail.result_users ?? [];
                        setLoadedUsers(users);
                        onExportCsv({ ...job, users });
                      }
                    })();
                  }
                }}
                disabled={exportingJobId === job.id}
                className="inline-flex items-center gap-2 rounded-lg border border-gray-300 bg-white px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50"
              >
                <Download className="h-4 w-4" />
                CSV
              </button>
              <button
                type="button"
                onClick={() => {
                  if (loadedUsers) {
                    onExportExcel(jobForExport);
                  } else {
                    void (async () => {
                      const res = await authFetch(`/api/tools/tg-parser/jobs/${job.id}`);
                      if (res.ok) {
                        const { job: detail } = (await res.json()) as { job: { result_users: ParsedUser[] | null } };
                        const users = detail.result_users ?? [];
                        setLoadedUsers(users);
                        onExportExcel({ ...job, users });
                      }
                    })();
                  }
                }}
                disabled={exportingJobId === job.id}
                className="inline-flex items-center gap-2 rounded-lg border border-gray-300 bg-white px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50"
              >
                <FileSpreadsheet className="h-4 w-4" />
                Excel
              </button>
            </>
          )}
          {job.status !== 'running' && currentUserId && job.userId === currentUserId && (
            <button
              type="button"
              onClick={() => onRemove(job.id)}
              className="rounded-lg border border-gray-200 bg-white px-3 py-1.5 text-sm text-gray-600 hover:bg-gray-50"
              title="Удалить запись из истории"
            >
              Скрыть
            </button>
          )}
        </div>
      </div>

      {expanded && canExpand && (
        <>
          <div className="px-4 py-2 bg-gray-50/80 border-b border-gray-100">
            <p className="text-sm text-gray-600">
              Найдено пользователей:{' '}
              <span className="font-semibold text-gray-900">{job.userCount.toLocaleString('ru-RU')}</span>
            </p>
          </div>
          {usersLoading && (
            <div className="flex items-center justify-center py-8 gap-2 text-sm text-gray-500">
              <Loader2 className="h-4 w-4 animate-spin" />
              Загрузка данных…
            </div>
          )}
          {loadedUsers && loadedUsers.length > 0 && <UserTable users={loadedUsers} />}
          {loadedUsers && loadedUsers.length === 0 && (
            <div className="p-4 text-sm text-gray-600">Контакты не найдены по заданным условиям.</div>
          )}
        </>
      )}

      {!expanded && job.status === 'done' && job.userCount === 0 && (
        <div className="p-4 text-sm text-gray-600">Контакты не найдены по заданным условиям.</div>
      )}
    </div>
  );
}

/* ── Main page ── */

export default function TgParserPage() {
  const [links, setLinks] = useState('');
  const [accountId, setAccountId] = useState('');
  const [parseMessages, setParseMessages] = useState(true);
  const [parseMembers, setParseMembers] = useState(true);
  const [parseComments, setParseComments] = useState(true);
  const [enrichProfile, setEnrichProfile] = useState(false);
  const [messageLimit, setMessageLimit] = useState(100);
  const [filterOnline, setFilterOnline] = useState(false);
  const [filterRecently, setFilterRecently] = useState(false);
  const [maxOfflineDays, setMaxOfflineDays] = useState<string>('');

  const [parseJobs, setParseJobs] = useState<ParseJob[]>([]);
  /** Страница списка задач, с нуля. */
  const [jobsPage, setJobsPage] = useState(0);
  /** Сколько задач всего — для «стр. 2 из 7» и блокировки «вперёд». */
  const [jobsTotal, setJobsTotal] = useState(0);
  /**
   * Все идущие задачи, независимо от страницы. По ним живёт опрос и подсказка
   * «этот аккаунт уже парсит» — оба вопроса про всю очередь, а не про то, что
   * сейчас видно на экране.
   */
  const [runningJobs, setRunningJobs] = useState<ParseJob[]>([]);
  const lastJobsPage = Math.max(0, Math.ceil(jobsTotal / JOBS_PAGE_SIZE) - 1);
  /**
   * Задачи заканчиваются и удаляются, поэтому выбранная страница может
   * оказаться за концом списка — тогда экран пуст, и выглядит это как поломка.
   * Зажимаем при рендере, а не правим состояние в эффекте: лишняя перерисовка
   * и гонка «поехали за страницей, которой нет» тут ни к чему.
   */
  const currentJobsPage = Math.min(jobsPage, lastJobsPage);
  const [jobsPanelTab, setJobsPanelTab] = useState<'jobs' | 'logs'>('jobs');
  const [parseLogs, setParseLogs] = useState<TgParserLog[]>([]);
  const [logsLoading, setLogsLoading] = useState(false);
  const [currentUserId, setCurrentUserId] = useState<string | null>(null);
  const runningAccountKeysRef = useRef<Set<string>>(new Set());
  const [exportingJobId, setExportingJobId] = useState<string | null>(null);
  const [stoppingJobId, setStoppingJobId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<'main' | 'target'>('main');

  // --- Accounts state ---
  const [accounts, setAccounts] = useState<TgAccount[]>([]);
  const [accountsLoading, setAccountsLoading] = useState(true);
  const [showAddAccount, setShowAddAccount] = useState(false);
  const [addBusy, setAddBusy] = useState(false);
  const [addName, setAddName] = useState('');
  const [addApiId, setAddApiId] = useState('');
  const [addApiHash, setAddApiHash] = useState('');
  const [addPhone, setAddPhone] = useState('');
  const [uploading, setUploading] = useState(false);

  // Auth wizard state
  type AuthStep = 'form' | 'code_needed' | 'password_needed' | 'done';
  const [authStep, setAuthStep] = useState<AuthStep>('form');
  const [authId, setAuthId] = useState('');
  const [authCode, setAuthCode] = useState('');
  const [authPassword, setAuthPassword] = useState('');

  const loadAccounts = useCallback(async () => {
    setAccountsLoading(true);
    try {
      const res = await authFetch(API_ACCOUNTS);
      if (res.ok) {
        const { items } = (await res.json()) as { items: TgAccount[] };
        setAccounts(items ?? []);
      }
    } finally {
      setAccountsLoading(false);
    }
  }, []);

  useEffect(() => { void loadAccounts(); }, [loadAccounts]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const {
        data: { user },
      } = await supabase.auth.getUser();
      if (!cancelled) setCurrentUserId(user?.id ?? null);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  /**
   * Точка отсчёта для «идёт N мин». Отдельным состоянием, а не `Date.now()` в
   * разметке: вызов часов во время рендера нечист и ломает предсказуемость
   * перерисовок. Обновляется тем же тиком, что и опрос задач.
   */
  const [nowTs, setNowTs] = useState(() => Date.now());

  const loadParseJobs = useCallback(async () => {
    try {
      const res = await authFetch(
        `/api/tools/tg-parser/jobs?limit=${JOBS_PAGE_SIZE}&offset=${currentJobsPage * JOBS_PAGE_SIZE}`,
      );
      if (!res.ok) return;
      const { items, total, running } = (await res.json()) as {
        items: TgParserJobApiRow[];
        total?: number;
        running?: TgParserJobApiRow[];
      };
      setParseJobs((items ?? []).map(tgParserApiRowToUi));
      setJobsTotal(total ?? (items ?? []).length);

      // Очередь считаем по всем идущим задачам, а не по текущей странице:
      // задача со второй страницы всё так же занимает свой аккаунт.
      const runningUi = (running ?? []).map(tgParserApiRowToUi);
      setRunningJobs(runningUi);
      runningAccountKeysRef.current.clear();
      for (const row of runningUi) {
        const key = row.isTarget ? '__target__' : jobAccountKey(row.accountId);
        runningAccountKeysRef.current.add(key);
      }
    } catch {
      /* ignore */
    }
  }, [currentJobsPage]);

  useEffect(() => { void loadParseJobs(); }, [loadParseJobs]);

  const loadParseLogs = useCallback(async () => {
    setLogsLoading(true);
    try {
      const isTarget = activeTab === 'target';
      const res = await authFetch(`/api/tools/tg-parser/logs?limit=200&is_target=${isTarget}`);
      if (!res.ok) return;
      const { items } = (await res.json()) as { items: TgParserLog[] };
      setParseLogs((items ?? []).reverse());
    } catch {
      /* ignore */
    } finally {
      setLogsLoading(false);
    }
  }, [activeTab]);

  /**
   * Опрос идущих задач.
   *
   * Было 3 секунды, стало 15: воркер и так пишет прогресс не чаще раза в 10
   * секунд (`lastProgressWriteAt` в tgParserJobWorker), поэтому четыре из
   * каждых пяти запросов возвращали ровно то же самое. Пятнадцать секунд —
   * это одно обновление на одну запись прогресса.
   */
  useEffect(() => {
    if (runningJobs.length === 0) return;
    const t = setInterval(() => {
      setNowTs(Date.now());
      void loadParseJobs();
    }, 15_000);
    return () => clearInterval(t);
  }, [runningJobs, loadParseJobs]);

  useEffect(() => {
    if (jobsPanelTab !== 'logs') return;
    void loadParseLogs();
    const t = setInterval(() => { void loadParseLogs(); }, 5000);
    return () => clearInterval(t);
  }, [jobsPanelTab, loadParseLogs]);

  const resetAddForm = () => {
    setAddName(''); setAddApiId(''); setAddApiHash('');
    setAddPhone('');
    setAuthStep('form'); setAuthId(''); setAuthCode(''); setAuthPassword('');
  };

  const AUTH_API = '/api/tools/tg-parser/accounts/auth';

  const startAuth = useCallback(async () => {
    const apiId = parseInt(addApiId.trim(), 10);
    const apiHash = addApiHash.trim();
    const phone = addPhone.trim();
    if (!apiId || !apiHash) { setError('API ID и API Hash обязательны'); return; }
    if (!phone) { setError('Телефон обязателен (в формате +7...)'); return; }
    setAddBusy(true);
    setError(null);
    try {
      const res = await authFetch(AUTH_API, {
        method: 'POST',
        body: JSON.stringify({
          step: 'send_code',
          api_id: apiId,
          api_hash: apiHash,
          phone,
          name: addName.trim(),
        }),
      });
      const data = (await res.json()) as { step?: string; auth_id?: string; error?: string };
      if (!res.ok) { setError(data?.error ?? `Ошибка: ${res.status}`); return; }
      if (data.step === 'code_needed' && data.auth_id) {
        setAuthId(data.auth_id);
        setAuthStep('code_needed');
      }
    } finally {
      setAddBusy(false);
    }
  }, [addName, addApiId, addApiHash, addPhone]);

  const submitCode = useCallback(async () => {
    const code = authCode.trim();
    if (!code) { setError('Введите код из Telegram'); return; }
    setAddBusy(true);
    setError(null);
    try {
      const res = await authFetch(AUTH_API, {
        method: 'POST',
        body: JSON.stringify({ step: 'sign_in', auth_id: authId, code }),
      });
      const data = (await res.json()) as { step?: string; auth_id?: string; error?: string };
      if (!res.ok) { setError(data?.error ?? `Ошибка: ${res.status}`); return; }
      if (data.step === 'password_needed') {
        setAuthStep('password_needed');
      } else if (data.step === 'done') {
        setAuthStep('done');
        void loadAccounts();
      }
    } finally {
      setAddBusy(false);
    }
  }, [authId, authCode, loadAccounts]);

  const submitPassword = useCallback(async () => {
    const password = authPassword;
    if (!password) { setError('Введите пароль 2FA'); return; }
    setAddBusy(true);
    setError(null);
    try {
      const res = await authFetch(AUTH_API, {
        method: 'POST',
        body: JSON.stringify({ step: 'check_password', auth_id: authId, password }),
      });
      const data = (await res.json()) as { step?: string; error?: string };
      if (!res.ok) { setError(data?.error ?? `Ошибка: ${res.status}`); return; }
      if (data.step === 'done') {
        setAuthStep('done');
        void loadAccounts();
      }
    } finally {
      setAddBusy(false);
    }
  }, [authId, authPassword, loadAccounts]);

  const deleteAccount = useCallback(async (id: string) => {
    if (!confirm('Удалить аккаунт?')) return;
    const res = await authFetch(`${API_ACCOUNTS}/${id}`, {
      method: 'DELETE',
    });
    if (res.ok) {
      if (accountId === id) setAccountId('');
      void loadAccounts();
    } else {
      const data = (await res.json()) as { error?: string };
      setError(data?.error ?? 'Ошибка удаления');
    }
  }, [accountId, loadAccounts]);

  const updateMaxContactsPerRun = useCallback(async (id: string, newLimit: number) => {
    const clamped = clampTgParserMaxContactsPerRun(newLimit);
    const res = await authFetch(`${API_ACCOUNTS}/${id}`, {
      method: 'PATCH',
      body: JSON.stringify({ max_contacts_per_run: clamped }),
    });
    if (res.ok) {
      setAccounts((prev) =>
        prev.map((a) => (a.id === id ? { ...a, max_contacts_per_run: clamped } : a)),
      );
    } else {
      const data = (await res.json()) as { error?: string };
      setError(data?.error ?? 'Ошибка обновления лимита');
    }
  }, []);

  const handleFilesUpload = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files ? Array.from(e.target.files) : [];
    e.target.value = '';
    if (!files.length) return;

    setUploading(true);
    setError(null);
    try {
      const token = await getAccessToken();
      if (!token) { setError('Необходима авторизация'); return; }
      const form = new FormData();
      files.forEach((file) => form.append('files', file));
      const res = await fetch(`${API_ACCOUNTS}/bulk-files`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        body: form,
      });
      const data = await res.json();
      if (!res.ok) { setError(data?.error ?? `Ошибка: ${res.status}`); return; }
      if (data.warnings?.length) {
        setError(`Загружено ${data.count} аккаунтов. Предупреждения: ${data.warnings.join('; ')}`);
      }
      void loadAccounts();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Ошибка загрузки файлов');
    } finally {
      setUploading(false);
    }
  }, [loadAccounts]);

  const runParse = useCallback(async () => {
    const linkList = links.split('\n').map((l) => l.trim()).filter((l) => l.length > 0);
    if (linkList.length === 0) {
      setError('Введите хотя бы одну ссылку на чат или канал (t.me/… или https://t.me/…)');
      return;
    }

    const isTarget = activeTab === 'target';
    const key = isTarget ? '__target__' : jobAccountKey(accountId);
    if (runningAccountKeysRef.current.has(key)) {
      setError(
        isTarget
          ? 'Целевой парсинг уже запущен. Дождитесь завершения.'
          : 'Этот аккаунт уже участвует в запущенном парсинге. Дождитесь завершения или выберите другой аккаунт.',
      );
      return;
    }

    setError(null);
    runningAccountKeysRef.current.add(key);

    try {
      const body: Record<string, unknown> = {
        links: linkList,
        parse_chat_messages: parseMessages,
        parse_chat_members: parseMembers,
        parse_post_comments: parseComments,
        enrich_profile: enrichProfile,
        message_limit: messageLimit,
        filter_online: filterOnline,
        filter_recently: filterRecently,
        max_offline_days: maxOfflineDays ? Number(maxOfflineDays) : null,
        is_target: isTarget,
      };
      if (!isTarget && accountId.trim()) body.account_id = accountId.trim();

      const res = await authFetch('/api/tools/tg-parser/parse', {
        method: 'POST',
        body: JSON.stringify(body),
      });

      const data = (await res.json()) as { error?: string; job_id?: string };
      if (res.status === 409) {
        runningAccountKeysRef.current.delete(key);
        setError(data?.error ?? 'Задача уже выполняется');
        return;
      }
      if (!res.ok) {
        runningAccountKeysRef.current.delete(key);
        setError(data?.error ?? `Ошибка: ${res.status}`);
        return;
      }

      await loadParseJobs();
    } catch (e) {
      runningAccountKeysRef.current.delete(key);
      setError(e instanceof Error ? e.message : 'Ошибка запроса');
    }
  }, [
    links,
    accountId,
    parseMessages,
    parseMembers,
    parseComments,
    enrichProfile,
    messageLimit,
    filterOnline,
    filterRecently,
    maxOfflineDays,
    activeTab,
    loadParseJobs,
  ]);

  const removeParseJob = useCallback(
    async (id: string) => {
      const res = await authFetch(`/api/tools/tg-parser/jobs/${id}`, {
        method: 'DELETE',
      });
      const data = (await res.json()) as { error?: string };
      if (res.status === 409) {
        setError(data.error ?? null);
        return;
      }
      if (!res.ok) return;
      setParseJobs((prev) => {
        const j = prev.find((x) => x.id === id);
        if (j?.status === 'running') {
          const key = j.isTarget || j.accountLabel === 'Секретный аккаунт (целевой парсинг)' ? '__target__' : jobAccountKey(j.accountId);
          runningAccountKeysRef.current.delete(key);
        }
        return prev.filter((x) => x.id !== id);
      });
    },
    [],
  );

  const stopParseJob = useCallback(
    async (id: string) => {
      setStoppingJobId(id);
      setError(null);
      try {
        const res = await authFetch(`/api/tools/tg-parser/jobs/${id}`, {
          method: 'PATCH',
          body: JSON.stringify({ action: 'stop' }),
        });
        const data = (await res.json()) as { error?: string };
        if (!res.ok) {
          setError(data?.error ?? `Ошибка: ${res.status}`);
          return;
        }
        await loadParseJobs();
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Ошибка остановки задачи');
      } finally {
        setStoppingJobId(null);
      }
    },
    [loadParseJobs],
  );

  const exportJobCsv = useCallback(async (job: ParseJob) => {
    if (job.users.length === 0) return;
    setExportingJobId(job.id);
    try {
      const header = COLUMNS.join(',');
      const rows = job.users.map((u) =>
        COLUMNS.map((col) => {
          const v = cellValue(u[col]);
          const needsQuotes = /[",\n\r]/.test(v);
          return needsQuotes ? `"${v.replace(/"/g, '""')}"` : v;
        }).join(',')
      );
      const csv = [header, ...rows].join('\n');
      const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' });
      const stamp = new Date(job.startedAt).toISOString().slice(0, 19).replace(/[:T]/g, '-');
      saveAs(blob, `tg-parser-${stamp}.csv`);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Ошибка экспорта');
    } finally {
      setExportingJobId(null);
    }
  }, []);

  const exportJobExcel = useCallback(async (job: ParseJob) => {
    if (job.users.length === 0) return;
    setExportingJobId(job.id);
    try {
      const ExcelJS = (await import('exceljs')).default;
      const wb = new ExcelJS.Workbook();
      const ws = wb.addWorksheet('TG Parser');
      ws.columns = COLUMNS.map((col) => ({ header: col, key: col, width: 20 }));
      job.users.forEach((u) => ws.addRow(u as unknown as Record<string, unknown>));
      const buf = await wb.xlsx.writeBuffer();
      const blob = new Blob([buf], {
        type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      });
      const stamp = new Date(job.startedAt).toISOString().slice(0, 19).replace(/[:T]/g, '-');
      saveAs(blob, `tg-parser-${stamp}.xlsx`);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Ошибка экспорта');
    } finally {
      setExportingJobId(null);
    }
  }, []);

  useEffect(() => { setError(null); }, [links]);

  return (
    <div className="space-y-6 text-left max-w-full">
      <div>
        <h1 className="text-2xl font-bold text-gray-900">TG User Parser</h1>
        <p className="text-sm text-gray-500 mt-1">
          Парсинг пользователей из Telegram: сообщения в чатах, участники, комментарии к постам. Экспорт в CSV или Excel.
        </p>
      </div>

      <div className="flex space-x-2 border-b border-gray-200">
        <button
          onClick={() => setActiveTab('main')}
          className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
            activeTab === 'main'
              ? 'border-blue-600 text-blue-600'
              : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
          }`}
        >
          Обычный парсинг
        </button>
        <button
          onClick={() => setActiveTab('target')}
          className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
            activeTab === 'target'
              ? 'border-blue-600 text-blue-600'
              : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
          }`}
        >
          Целевой парсинг
        </button>
      </div>

      {activeTab === 'main' && (
      <>
        {/* Accounts section */}
        <div className="rounded-2xl border border-gray-200 bg-white p-6">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2 text-sm font-semibold text-gray-800">
            <User className="h-4 w-4" aria-hidden />
            Аккаунты Telegram ({accountsLoading ? '…' : accounts.length})
          </div>
          <div className="flex items-center gap-2">
            <label className={`inline-flex items-center gap-2 rounded-lg border border-gray-300 bg-white px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 cursor-pointer transition-colors ${uploading ? 'opacity-50 pointer-events-none' : ''}`}>
              {uploading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />}
              Загрузить файлы
              <input
                type="file"
                multiple
                accept=".json,.session"
                className="hidden"
                onChange={handleFilesUpload}
                disabled={uploading}
              />
            </label>
            <button
              type="button"
              onClick={() => { setShowAddAccount((v) => !v); }}
              className="inline-flex items-center gap-2 rounded-lg border border-gray-300 bg-white px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50"
            >
              <Plus className="h-4 w-4" />
              Добавить
            </button>
          </div>
        </div>

        <div className="mt-4 space-y-4">
            {showAddAccount && (
              <div className="rounded-xl border border-gray-200 bg-gray-50/50 p-4 space-y-3">
                {/* Step 1: credentials + phone */}
                {authStep === 'form' && (
                  <>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                      <input
                        value={addName}
                        onChange={(e) => setAddName(e.target.value)}
                        placeholder="Название (опционально)"
                        className="rounded-lg border border-gray-300 px-4 py-2.5 text-sm text-gray-900 placeholder-gray-400 focus:border-blue-500 focus:ring-1 focus:ring-blue-500"
                      />
                      <input
                        value={addPhone}
                        onChange={(e) => setAddPhone(e.target.value)}
                        placeholder="Телефон (+7...)"
                        className="rounded-lg border border-gray-300 px-4 py-2.5 text-sm text-gray-900 placeholder-gray-400 focus:border-blue-500 focus:ring-1 focus:ring-blue-500"
                      />
                      <input
                        value={addApiId}
                        onChange={(e) => setAddApiId(e.target.value)}
                        placeholder="API ID"
                        type="number"
                        className="rounded-lg border border-gray-300 px-4 py-2.5 text-sm text-gray-900 placeholder-gray-400 focus:border-blue-500 focus:ring-1 focus:ring-blue-500"
                      />
                      <input
                        value={addApiHash}
                        onChange={(e) => setAddApiHash(e.target.value)}
                        placeholder="API Hash"
                        className="rounded-lg border border-gray-300 px-4 py-2.5 text-sm text-gray-900 placeholder-gray-400 focus:border-blue-500 focus:ring-1 focus:ring-blue-500"
                      />
                    </div>
                    <p className="text-xs text-gray-500">
                      API ID и API Hash можно получить на{' '}
                      <a href="https://my.telegram.org" target="_blank" rel="noopener noreferrer" className="text-blue-600 hover:underline">my.telegram.org</a>.
                      После нажатия «Авторизовать» на указанный телефон придёт код подтверждения в Telegram.
                    </p>
                    <div className="flex gap-2">
                      <button
                        type="button"
                        onClick={startAuth}
                        disabled={addBusy}
                        className="inline-flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
                      >
                        {addBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : <KeyRound className="h-4 w-4" />}
                        Авторизовать
                      </button>
                      <button
                        type="button"
                        onClick={() => { setShowAddAccount(false); resetAddForm(); }}
                        className="rounded-lg border border-gray-300 bg-white px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50"
                      >
                        Отмена
                      </button>
                    </div>
                  </>
                )}

                {/* Step 2: enter code from Telegram */}
                {authStep === 'code_needed' && (
                  <>
                    <p className="text-sm text-gray-700">
                      Код отправлен на <span className="font-semibold">{addPhone}</span> в Telegram. Введите его ниже:
                    </p>
                    <input
                      value={authCode}
                      onChange={(e) => setAuthCode(e.target.value)}
                      placeholder="Код из Telegram"
                      autoFocus
                      className="w-full rounded-lg border border-gray-300 px-4 py-2.5 text-sm text-gray-900 placeholder-gray-400 focus:border-blue-500 focus:ring-1 focus:ring-blue-500 font-mono tracking-widest text-center text-lg"
                      onKeyDown={(e) => { if (e.key === 'Enter') void submitCode(); }}
                    />
                    <div className="flex gap-2">
                      <button
                        type="button"
                        onClick={submitCode}
                        disabled={addBusy}
                        className="inline-flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
                      >
                        {addBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : <KeyRound className="h-4 w-4" />}
                        Подтвердить код
                      </button>
                      <button
                        type="button"
                        onClick={() => { setShowAddAccount(false); resetAddForm(); }}
                        className="rounded-lg border border-gray-300 bg-white px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50"
                      >
                        Отмена
                      </button>
                    </div>
                  </>
                )}

                {/* Step 3: 2FA password */}
                {authStep === 'password_needed' && (
                  <>
                    <p className="text-sm text-gray-700">
                      У этого аккаунта включена двухфакторная авторизация. Введите пароль 2FA:
                    </p>
                    <input
                      value={authPassword}
                      onChange={(e) => setAuthPassword(e.target.value)}
                      placeholder="Пароль 2FA"
                      type="password"
                      autoFocus
                      className="w-full rounded-lg border border-gray-300 px-4 py-2.5 text-sm text-gray-900 placeholder-gray-400 focus:border-blue-500 focus:ring-1 focus:ring-blue-500"
                      onKeyDown={(e) => { if (e.key === 'Enter') void submitPassword(); }}
                    />
                    <div className="flex gap-2">
                      <button
                        type="button"
                        onClick={submitPassword}
                        disabled={addBusy}
                        className="inline-flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
                      >
                        {addBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : <KeyRound className="h-4 w-4" />}
                        Подтвердить
                      </button>
                      <button
                        type="button"
                        onClick={() => { setShowAddAccount(false); resetAddForm(); }}
                        className="rounded-lg border border-gray-300 bg-white px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50"
                      >
                        Отмена
                      </button>
                    </div>
                  </>
                )}

                {/* Step 4: done */}
                {authStep === 'done' && (
                  <div className="flex items-center gap-3 py-2">
                    <CheckCircle2 className="h-5 w-5 text-emerald-500" />
                    <p className="text-sm text-gray-700">Аккаунт успешно добавлен!</p>
                    <button
                      type="button"
                      onClick={() => { setShowAddAccount(false); resetAddForm(); }}
                      className="ml-auto rounded-lg border border-gray-300 bg-white px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50"
                    >
                      Закрыть
                    </button>
                  </div>
                )}
              </div>
            )}

            {accountsLoading ? (
              <div className="rounded-lg border border-gray-200 bg-gray-50/50 overflow-hidden">
                <div className="flex flex-col sm:flex-row gap-4 px-6 py-12 items-center justify-center min-h-[140px] text-center sm:text-left">
                  <Loader2 className="h-10 w-10 animate-spin text-blue-600 shrink-0" aria-hidden />
                  <div>
                    <p className="text-sm font-medium text-gray-800">Загрузка аккаунтов…</p>
                    <p className="text-xs text-gray-500 mt-1 max-w-md">
                      Получаем список из базы. Если аккаунтов ещё нет, здесь появится подсказка после загрузки.
                    </p>
                  </div>
                </div>
              </div>
            ) : accounts.length === 0 ? (
              <p className="text-sm text-gray-500 py-2">
                Пока нет аккаунтов. Добавьте Telegram-аккаунт — он появится у всех, кто открывает этот инструмент.
              </p>
            ) : (
              <div className="space-y-2">
                <p className="text-xs text-gray-500 leading-snug">
                  <span className="text-gray-600">Макс. за запуск</span> — сколько <span className="whitespace-nowrap">уникальных контактов</span> максимум
                  соберёт один запуск парсинга с этого аккаунта (по умолчанию 500, до {TG_PARSER_MAX_CONTACTS_PER_RUN_MAX.toLocaleString('ru-RU')}).
                </p>
                <div className="rounded-lg border border-gray-200 overflow-hidden">
                <div className="bg-gray-50 border-b border-gray-200">
                  <div className="grid grid-cols-[0.5rem_minmax(0,1fr)_auto] items-center gap-x-3 px-4 py-2 text-xs font-medium text-gray-500">
                    <span
                      className="w-2 shrink-0"
                      title="Аккаунт включён и доступен для парсинга"
                    />
                    <span className="min-w-0 text-left" title="Имя в списке или номер API">
                      Аккаунт
                    </span>
                    <div className="grid grid-cols-[120px_76px_7rem_2.25rem] items-center gap-x-3 [&>span]:text-center">
                      <span title="Телефон привязки">Телефон</span>
                      <span title="Сохранённая сессия GramJS — можно парсить">Сессия</span>
                      <span title="Максимум уникальных контактов за один запуск парсинга">Макс. за запуск</span>
                      <span className="block w-full" aria-hidden />
                    </div>
                  </div>
                </div>
                <div
                  className="divide-y divide-gray-100 max-h-[calc(7*3rem)] overflow-y-auto overscroll-contain"
                  style={{ scrollbarGutter: 'stable' }}
                >
                {accounts.map((acc) => {
                  const phoneDisplay = acc.phone || `ID: ${acc.api_id}`;

                  return (
                    <div
                      key={acc.id}
                      className="grid grid-cols-[0.5rem_minmax(0,1fr)_auto] items-center gap-x-3 px-4 py-2.5 text-sm"
                    >
                      <span
                        className={`h-2 w-2 rounded-full shrink-0 justify-self-center ${acc.is_active ? 'bg-emerald-500' : 'bg-gray-300'}`}
                        title={acc.is_active ? 'Активен' : 'Отключен'}
                      />
                      <span className="min-w-0 truncate font-medium text-gray-800">
                        {acc.name || `Account ${acc.api_id}`}
                      </span>
                      <div className="grid grid-cols-[120px_76px_7rem_2.25rem] items-center gap-x-3">
                        <div className="min-w-0 text-center">
                          <span
                            className="inline-block max-w-full truncate text-xs text-gray-500"
                            title={phoneDisplay}
                          >
                            {phoneDisplay}
                          </span>
                        </div>
                        <div className="text-center">
                          {acc.session_data ? (
                            <span className="text-xs text-emerald-600">session ok</span>
                          ) : (
                            <span className="text-xs text-amber-600">no session</span>
                          )}
                        </div>

                        <div className="flex justify-center">
                          <input
                            type="number"
                            min={1}
                            max={TG_PARSER_MAX_CONTACTS_PER_RUN_MAX}
                            defaultValue={acc.max_contacts_per_run ?? TG_PARSER_MAX_CONTACTS_PER_RUN_DEFAULT}
                            key={`${acc.id}-${acc.max_contacts_per_run ?? 0}`}
                            onBlur={(e) => {
                              const v = parseInt(e.target.value, 10);
                              if (!isNaN(v)) void updateMaxContactsPerRun(acc.id, v);
                            }}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
                            }}
                            className="w-[6.5rem] rounded border border-gray-300 px-1.5 py-0.5 text-xs text-center text-gray-700 focus:border-blue-500 focus:ring-1 focus:ring-blue-500"
                            title="Максимум уникальных контактов за один запуск парсинга"
                          />
                        </div>

                        <div className="flex justify-center">
                          <button
                            type="button"
                            onClick={() => deleteAccount(acc.id)}
                            className="p-1.5 rounded-lg text-gray-400 hover:text-rose-600 hover:bg-rose-50"
                            title="Удалить"
                          >
                            <Trash2 className="h-4 w-4" />
                          </button>
                        </div>
                      </div>
                    </div>
                  );
                })}
                </div>
                </div>
              </div>
            )}
        </div>
      </div>
      </>
      )}

      {/* Parse form */}
      <div className="rounded-2xl border border-gray-200 bg-white p-6 space-y-4">
        {activeTab === 'target' && (
          <div className="mb-4 rounded-xl border border-blue-200 bg-blue-50/50 p-4">
            <h3 className="text-sm font-semibold text-blue-900 mb-1">Целевой парсинг</h3>
            <p className="text-sm text-blue-800">
              Это более углубленный парсер, который использует специальный аккаунт.
              Он позволяет обходить стандартные ограничения Telegram и собирать больше уникальных контактов.
            </p>
          </div>
        )}

        {activeTab === 'main' && accounts.length > 0 && (
          <div className="flex flex-wrap items-center gap-2">
            <label htmlFor="tg-account" className="text-sm text-gray-600 whitespace-nowrap">
              Аккаунт:
            </label>
            <select
              id="tg-account"
              value={accountId}
              onChange={(e) => setAccountId(e.target.value)}
              className="rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-900 focus:border-blue-500 focus:ring-1 focus:ring-blue-500 min-w-[200px]"
            >
              <option
                value=""
                disabled={parseJobs.some((j) => j.status === 'running' && !j.accountId)}
              >
                Выберите аккаунт
              </option>
              {accounts.filter((a) => a.is_active && a.session_data).map((a) => {
                const accBusy = parseJobs.some(
                  (j) => j.status === 'running' && j.accountId === a.id,
                );
                return (
                  <option key={a.id} value={a.id} disabled={accBusy}>
                    {a.name || `Account ${a.api_id}`}
                    {accBusy ? ' — парсинг…' : ''}
                  </option>
                );
              })}
            </select>
            <span className="text-xs text-gray-500">
              лимит уникальных контактов за один запуск задаётся в таблице аккаунтов («Макс. за запуск»); можно параллельно гонять разные аккаунты
            </span>
          </div>
        )}

        <div>
          <label htmlFor="tg-links" className="block text-sm font-medium text-gray-700 mb-2">
            Ссылки на чаты/каналы (по одной на строку)
          </label>
          <textarea
            id="tg-links"
            value={links}
            onChange={(e) => setLinks(e.target.value)}
            placeholder={'https://t.me/chatname\nhttps://t.me/channel'}
            rows={4}
            className="w-full rounded-lg border border-gray-300 px-4 py-2.5 text-gray-900 placeholder-gray-400 focus:border-blue-500 focus:ring-1 focus:ring-blue-500"
          />
        </div>

        <div>
          <p className="text-sm font-medium text-gray-700 mb-2">Парсить:</p>
          <div className="flex flex-wrap gap-6">
            <div className="flex items-center gap-2">
              <input
                type="checkbox"
                id="parse-messages"
                checked={parseMessages}
                onChange={(e) => setParseMessages(e.target.checked)}
              />
              <label htmlFor="parse-messages" className="text-sm text-gray-700">Сообщения в чатах</label>
            </div>
            <div className="flex items-center gap-2">
              <input
                type="checkbox"
                id="parse-members"
                checked={parseMembers}
                onChange={(e) => setParseMembers(e.target.checked)}
              />
              <label htmlFor="parse-members" className="text-sm text-gray-700">Участники</label>
            </div>
            <div className="flex items-center gap-2">
              <input
                type="checkbox"
                id="parse-comments"
                checked={parseComments}
                onChange={(e) => setParseComments(e.target.checked)}
              />
              <label htmlFor="parse-comments" className="text-sm text-gray-700">Комментарии под постами</label>
            </div>
          </div>
          <p className="text-xs text-gray-500 mt-1">
            Сообщения — собирает авторов сообщений из чатов. Участники — список членов группы/канала. Комментарии — авторы комментариев под постами каналов.
          </p>
        </div>

        <div>
          <div className="flex items-center gap-2">
            <input
              type="checkbox"
              id="enrich-profile"
              checked={enrichProfile}
              onChange={(e) => setEnrichProfile(e.target.checked)}
            />
            <label htmlFor="enrich-profile" className="text-sm text-gray-700">
              Собирать расширенный профиль (медленно)
            </label>
          </div>
          <p className="text-xs text-gray-500 mt-1">
            С галочкой: дополнительно собирает «Биография» и «Личный канал» (медленнее, чаще лимиты Telegram).
            {' '}Без галочки: собирает ID/username, имя, онлайн-статус, сообщения, тип/ссылку/название источника — быстрее и стабильнее.
          </p>
        </div>

        <div className="grid grid-cols-1 gap-6 sm:grid-cols-2 sm:gap-8 sm:items-start">
          <div className="min-w-0 max-w-md">
            <label htmlFor="message-limit" className="block text-sm font-medium text-gray-700 mb-1">
              Лимит сообщений / участников
            </label>
            <input
              id="message-limit"
              type="number"
              min={10}
              max={5000}
              value={messageLimit}
              onChange={(e) => setMessageLimit(Math.min(5000, Math.max(10, Number(e.target.value) || 100)))}
              className="w-24 rounded-lg border border-gray-300 px-3 py-2 text-gray-900"
            />
            <p className="text-[11px] text-gray-500 mt-1.5 leading-snug">
              Ограничивает <span className="text-gray-600">глубину обхода</span> в каждом чате: сколько последних сообщений просмотреть при сборе авторов и сколько участников максимум запросить у Telegram для списка членов.
              Это не «сколько людей в итоге в таблице» — общий потолок по людям задаётся у аккаунта колонкой «Макс. за запуск».
            </p>
          </div>
          <div className="min-w-0 max-w-md">
            <label htmlFor="max-offline" className="block text-sm font-medium text-gray-700 mb-1">
              Макс. дней оффлайн
            </label>
            <input
              id="max-offline"
              type="number"
              min={0}
              placeholder="—"
              value={maxOfflineDays}
              onChange={(e) => setMaxOfflineDays(e.target.value)}
              className="w-24 rounded-lg border border-gray-300 px-3 py-2 text-gray-900"
            />
            <p className="text-[11px] text-gray-500 mt-1.5 leading-snug">
              Если указано число, в результат попадут только пользователи, у которых «последний раз в сети» не старше N дней (с учётом статусов вроде «недавно», «на неделе»).
              Пустое поле — не отсекать по давности последнего визита.
            </p>
          </div>
        </div>

        <div>
          <p className="text-sm font-medium text-gray-700 mb-2">Фильтр по активности</p>
          <div className="flex flex-wrap gap-6">
            <div className="flex items-center gap-2">
              <input
                type="checkbox"
                id="filter-online"
                checked={filterOnline}
                onChange={(e) => setFilterOnline(e.target.checked)}
              />
              <label htmlFor="filter-online" className="text-sm text-gray-700">Только онлайн</label>
            </div>
            <div className="flex items-center gap-2">
              <input
                type="checkbox"
                id="filter-recently"
                checked={filterRecently}
                onChange={(e) => setFilterRecently(e.target.checked)}
              />
              <label htmlFor="filter-recently" className="text-sm text-gray-700">Недавно в сети</label>
            </div>
          </div>
          <p className="text-xs text-gray-500 mt-1">
            «Только онлайн» — в результатах останутся лишь те, кто сейчас в сети.
            «Недавно в сети» — онлайн + те, кого Telegram помечает как «был недавно».
            «Макс. дней оффлайн» — отсечь тех, кто не заходил дольше N дней (например, 7 = был в сети за последнюю неделю).
            Если ничего не выбрано — возвращаются все пользователи без фильтрации.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <button
            type="button"
            onClick={() => void runParse()}
            className="inline-flex items-center justify-center gap-2 rounded-lg bg-blue-600 px-5 py-2.5 text-sm font-medium text-white hover:bg-blue-700"
          >
            <Play className="h-4 w-4" />
            Запустить парсинг
          </button>
          {parseJobs.some((j) => j.status === 'running') && (
            <span className="text-xs text-gray-500 inline-flex items-center gap-1.5">
              <Loader2 className="h-3.5 w-3.5 animate-spin text-blue-600" />
              Выполняется задач:{' '}
              {parseJobs.filter((j) => j.status === 'running').length}
            </span>
          )}
        </div>
      </div>

      {error && (
        <div className="rounded-xl border border-red-200 bg-red-50 p-4 flex items-start gap-3">
          <AlertCircle className="h-5 w-5 text-red-500 shrink-0 mt-0.5" />
          <p className="text-sm text-red-700">{error}</p>
        </div>
      )}

      <div className="space-y-4">
        <div className="flex gap-1 border-b border-gray-200">
          <button
            type="button"
            onClick={() => setJobsPanelTab('jobs')}
            className={`inline-flex items-center gap-1.5 px-4 py-2 text-sm font-medium transition border-b-2 -mb-px ${
              jobsPanelTab === 'jobs'
                ? 'border-blue-600 text-blue-700'
                : 'border-transparent text-gray-500 hover:text-gray-700 hover:bg-gray-50'
            }`}
          >
            Задачи
          </button>
          <button
            type="button"
            onClick={() => setJobsPanelTab('logs')}
            className={`inline-flex items-center gap-1.5 px-4 py-2 text-sm font-medium transition border-b-2 -mb-px ${
              jobsPanelTab === 'logs'
                ? 'border-blue-600 text-blue-700'
                : 'border-transparent text-gray-500 hover:text-gray-700 hover:bg-gray-50'
            }`}
          >
            <ScrollText className="h-4 w-4" />
            Логи
          </button>
        </div>

        {jobsPanelTab === 'jobs' && parseJobs.length > 0 && (
          <div className="space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h2 className="text-sm font-semibold text-gray-800">
                Задачи парсинга{' '}
                <span className="font-normal text-gray-400">
                  ({jobsTotal.toLocaleString('ru-RU')})
                </span>
              </h2>
              {/* Идущие задачи считаем по всей очереди: со страницей по десять
                  работающая задача легко оказывается не на этом экране, и без
                  этой строки казалось бы, что не запущено ничего. */}
              {runningJobs.length > 0 && (
                <span className="text-xs text-blue-700">
                  выполняется: {runningJobs.length}
                </span>
              )}
            </div>
            {parseJobs.map((job) => (
              <JobCard
                key={job.id}
                job={job}
                currentUserId={currentUserId}
                exportingJobId={exportingJobId}
                stoppingJobId={stoppingJobId}
                now={nowTs}
                onExportCsv={exportJobCsv}
                onExportExcel={exportJobExcel}
                onRemove={removeParseJob}
                onStop={stopParseJob}
              />
            ))}

            {jobsTotal > JOBS_PAGE_SIZE && (
              <div className="flex items-center justify-center gap-3 pt-1">
                <button
                  type="button"
                  onClick={() => setJobsPage(Math.max(0, currentJobsPage - 1))}
                  disabled={currentJobsPage === 0}
                  className="rounded-lg border border-gray-200 bg-white px-3 py-1.5 text-xs text-gray-700 hover:bg-gray-50 disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  Назад
                </button>
                <span className="text-xs text-gray-500">
                  стр. {currentJobsPage + 1} из {lastJobsPage + 1}
                </span>
                <button
                  type="button"
                  onClick={() => setJobsPage(currentJobsPage + 1)}
                  disabled={currentJobsPage >= lastJobsPage}
                  className="rounded-lg border border-gray-200 bg-white px-3 py-1.5 text-xs text-gray-700 hover:bg-gray-50 disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  Вперёд
                </button>
              </div>
            )}
          </div>
        )}

        {jobsPanelTab === 'jobs' && parseJobs.length === 0 && !error && (
          <div className="rounded-2xl border border-dashed border-gray-300 bg-gray-50/50 p-12 text-center">
            <p className="text-gray-500 text-sm">
              Введите ссылки на чаты или каналы (t.me/…), выберите режимы парсинга и нажмите «Запустить парсинг».
              Парсинг может занять несколько минут. Запущенные задачи отображаются ниже; пока они идут, можно настроить другой аккаунт и запустить ещё одну.
            </p>
          </div>
        )}

        {jobsPanelTab === 'logs' && (
          <div className="rounded-lg border border-gray-800 bg-gray-950 p-3 font-mono text-[11px] leading-relaxed h-[460px] overflow-auto">
            {logsLoading && <p className="text-gray-500">Загрузка логов...</p>}
            {!logsLoading && parseLogs.length === 0 && (
              <p className="text-gray-600">
                Нет логов для режима «{activeTab === 'target' ? 'целевой парсинг' : 'обычный парсинг'}».
              </p>
            )}
            {parseLogs.map((log) => (
              <div key={log.id} className="flex gap-2">
                <span className="text-gray-600 shrink-0">{new Date(log.created_at).toLocaleTimeString('ru-RU')}</span>
                <span
                  className={`shrink-0 font-bold uppercase w-14 ${
                    log.level === 'error'
                      ? 'text-rose-400'
                      : log.level === 'warning'
                        ? 'text-amber-400'
                        : 'text-gray-400'
                  }`}
                >
                  {log.level}
                </span>
                <span className="text-gray-300 break-all">
                  [{log.account_label ?? '—'}] {log.message}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
