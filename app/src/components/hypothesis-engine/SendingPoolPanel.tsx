'use client';

/**
 * «Пул ящиков ENG» — экран сотрудника для пула НАШИХ ящиков отправки
 * (миграция 20261011_0001, lib/hypothesisEngine/sendingPool.ts; роуты
 * /api/tools/hypothesis-engine/sending-pool и
 * /api/tools/hypothesis-engine/projects/[id]/sending-pool).
 *
 * Что умеет:
 *  - список ящиков со статусом и проектом, сводка свободных по воркспейсам;
 *  - добавить ящики (по адресу; воркспейс — только воркспейс пула, второй
 *    аккаунт рассыльщика: HE_US_POOL_WORKSPACE, по умолчанию account-2, никогда
 *    main — lib/hypothesisEngine/sendingPool.ts, «Воркспейс пула»; каждый адрес —
 *    свой запрос и своя строка ответа: проверка у рассыльщика идёт по одному);
 *  - выключить свободный / включить выключенный;
 *  - вернуть ящики проекта в пул (только у проекта без запуска — роут
 *    отказывает 409 и объясняет).
 * Выдачу проекту делает запуск клиента, а не этот экран.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { HE_API, heCall, hePatch, hePost } from './api';
import { HE } from './design';
import { Badge, StatusBox, formatDate, prettyProjectName, type BadgeTone } from './ui';

type PoolStatus = 'available' | 'assigned' | 'disabled';

interface PoolRow {
  id: string;
  email: string;
  instantly_account_id: string;
  status: PoolStatus;
  project_id: string | null;
  assigned_at: string | null;
  released_at: string | null;
  notes: string | null;
  created_at: string;
  project: { id: string; name: string | null; website_url: string } | null;
}

interface PoolResponse {
  supported?: boolean;
  per_project?: number;
  per_project_rejected?: boolean;
  workspaces?: Array<{ id: string; label: string; isDefault: boolean }>;
  workspaces_error?: string | null;
  /** Куда экран добавляет ящики (HE_US_POOL_WORKSPACE, по умолчанию account-2) — или почему некуда. */
  pool_workspace?: { id: string; ok: boolean; from_env: boolean; problem: string | null };
  /** Из каких воркспейсов выдача берёт ящики: настроенные, кроме main. */
  assignable_workspaces?: string[];
  rows?: PoolRow[];
  truncated?: boolean;
  counts?: Record<string, Record<PoolStatus, number>>;
  error?: string;
}

const STATUS_META: Record<PoolStatus, { label: string; tone: BadgeTone }> = {
  available: { label: 'свободен', tone: 'emerald' },
  assigned: { label: 'отдан проекту', tone: 'blue' },
  disabled: { label: 'выключен', tone: 'gray' },
};

const PROJECT_POOL_API = (projectId: string) => `${HE_API}/projects/${projectId}/sending-pool`;
const POOL_API = `${HE_API}/sending-pool`;

export function SendingPoolPanel() {
  const [data, setData] = useState<PoolResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [workspace, setWorkspace] = useState('');
  const [emailsText, setEmailsText] = useState('');
  const [notes, setNotes] = useState('');
  const [adding, setAdding] = useState(false);
  const [addLog, setAddLog] = useState<Array<{ email: string; ok: boolean; text: string }>>([]);

  const [busyId, setBusyId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionInfo, setActionInfo] = useState<string | null>(null);

  // Ответ GET → состояние экрана. Первая загрузка — loading уже true из
  // useState; повторные (после действий) показывают прежний список до ответа.
  const applyLoad = useCallback((res: { ok: boolean; status: number; data: PoolResponse } | null) => {
    if (!res) setLoadError('Не удалось загрузить пул ящиков');
    else if (!res.ok) setLoadError(res.data.error ?? `Ошибка ${res.status}`);
    else {
      setLoadError(null);
      setData(res.data);
    }
    setLoading(false);
  }, []);

  const load = useCallback(async () => {
    applyLoad(await heCall<PoolResponse>(POOL_API).catch(() => null));
  }, [applyLoad]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const res = await heCall<PoolResponse>(POOL_API).catch(() => null);
      if (!cancelled) applyLoad(res);
    })();
    return () => {
      cancelled = true;
    };
  }, [applyLoad]);

  // Добавлять можно только в воркспейс пула (роут отказывает в любой другой и
  // всегда — в main), поэтому в списке только он; не годится — список пуст, и
  // экран пишет причину.
  const pool = data?.pool_workspace ?? null;
  const workspaces = useMemo(
    () => (data?.pool_workspace?.ok ? (data.workspaces ?? []).filter((w) => w.id === data.pool_workspace?.id) : []),
    [data],
  );
  const selectedWorkspace = workspaces.some((w) => w.id === workspace) ? workspace : workspaces[0]?.id ?? '';

  const rows = useMemo(() => data?.rows ?? [], [data]);
  const perProject = data?.per_project ?? 3;
  // Свободные в main и в ненастроенных воркспейсах выдача не берёт — не считаем.
  const assignable = useMemo(() => new Set(data?.assignable_workspaces ?? []), [data]);
  const bestFree = useMemo(() => {
    let best = 0;
    for (const [ws, c] of Object.entries(data?.counts ?? {})) {
      if (assignable.has(ws)) best = Math.max(best, c.available ?? 0);
    }
    return best;
  }, [data, assignable]);

  const projects = useMemo(() => {
    const byProject = new Map<string, { project: PoolRow['project']; rows: PoolRow[] }>();
    for (const row of rows) {
      if (row.status !== 'assigned' || !row.project_id) continue;
      const entry = byProject.get(row.project_id) ?? { project: row.project, rows: [] };
      entry.rows.push(row);
      byProject.set(row.project_id, entry);
    }
    return [...byProject.entries()];
  }, [rows]);

  async function addMailboxes() {
    const emails = [...new Set(emailsText.split(/[\s,;]+/).map((e) => e.trim()).filter(Boolean))];
    if (!selectedWorkspace || emails.length === 0) return;
    setAdding(true);
    setAddLog([]);
    const log: Array<{ email: string; ok: boolean; text: string }> = [];
    for (const email of emails) {
      try {
        const res = await hePost<{ error?: string }>(POOL_API, {
          email,
          instantly_account_id: selectedWorkspace,
          notes: notes.trim() || null,
        });
        log.push({ email, ok: res.ok, text: res.ok ? 'добавлен' : res.data.error ?? `ошибка ${res.status}` });
      } catch {
        log.push({ email, ok: false, text: 'сеть — попробуйте ещё раз' });
      }
      setAddLog([...log]);
    }
    setAdding(false);
    if (log.some((l) => l.ok)) {
      setEmailsText(log.filter((l) => !l.ok).map((l) => l.email).join('\n'));
      void load();
    }
  }

  async function setStatus(row: PoolRow, status: 'available' | 'disabled') {
    setBusyId(row.id);
    setActionError(null);
    setActionInfo(null);
    try {
      const res = await hePatch<{ error?: string }>(`${POOL_API}/${row.id}`, { status });
      if (!res.ok) setActionError(`${row.email}: ${res.data.error ?? `ошибка ${res.status}`}`);
      else void load();
    } catch {
      setActionError(`${row.email}: сеть — попробуйте ещё раз`);
    } finally {
      setBusyId(null);
    }
  }

  async function releaseProject(projectId: string, label: string, count: number) {
    const ok = window.confirm(
      `Вернуть ${count} ящик(а) проекта «${label}» в пул?\n\n` +
        'Только для проекта без запуска (например, по runbook смены сайта): ящики получит следующий новый проект, ' +
        'а адреса уберутся из пресета владельца проекта.',
    );
    if (!ok) return;
    setBusyId(projectId);
    setActionError(null);
    setActionInfo(null);
    try {
      const res = await hePost<{ error?: string; released?: string[]; preset_cleanup?: string }>(
        PROJECT_POOL_API(projectId),
      );
      if (!res.ok) {
        setActionError(`${label}: ${res.data.error ?? `ошибка ${res.status}`}`);
      } else {
        const cleanup = res.data.preset_cleanup;
        setActionInfo(
          `${label}: возвращено ${res.data.released?.length ?? 0}. ` +
            (cleanup === 'failed'
              ? 'Пресет владельца НЕ очищен — уберите эти адреса на /admin/clients/<владелец>/preset.'
              : cleanup === 'cleaned'
                ? 'Адреса убраны из пресета владельца.'
                : 'В пресете владельца этих адресов не было.'),
        );
        void load();
      }
    } catch {
      setActionError(`${label}: сеть — попробуйте ещё раз`);
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="space-y-5">
      <p className={`text-sm ${HE.muted2}`}>
        Наши прогретые ящики, из которых пишут кампании английского кабинета. Каждый новый проект клиента при первом
        запуске получает ящики из одного воркспейса (сейчас — {perProject} шт.), и они только его. Если свободных не
        хватает, запуск клиента отказывается, а команде уходит сообщение в health-бот. Пул живёт во втором аккаунте
        рассыльщика — там, где клиенты RU-кабинета outreachOS
        {pool ? <> (воркспейс «{pool.id}», {pool.from_env ? 'из HE_US_POOL_WORKSPACE' : 'по умолчанию'})</> : null}; в
        «main» ящиков пула нет.
      </p>

      {loadError && <StatusBox tone="error">{loadError}</StatusBox>}
      {pool && !pool.ok && (
        <StatusBox tone="error">
          Воркспейс пула не настроен — {pool.problem}. Добавлять ящики некуда: задайте HE_US_POOL_WORKSPACE (id второго
          аккаунта рассыльщика) и его ключ в INSTANTLY_ACCOUNTS_JSON контейнера portal.
        </StatusBox>
      )}
      {data?.supported === false && (
        <StatusBox tone="error">
          Пул недоступен: не применена миграция 20261011_0001_he_sending_pool.sql. Пока её нет, запуск любого
          ENG-клиента отказывается.
        </StatusBox>
      )}
      {data?.workspaces_error && (
        <StatusBox tone="error">Воркспейсы рассыльщика не читаются из окружения: {data.workspaces_error}</StatusBox>
      )}
      {data?.per_project_rejected && (
        <StatusBox tone="error">
          HE_US_POOL_MAILBOXES_PER_PROJECT не читается — взят дефолт {perProject}.
        </StatusBox>
      )}
      {data?.supported && bestFree < perProject && (
        <StatusBox tone="error">
          Свободных ящиков в одном воркспейсе меньше {perProject} (лучший — {bestFree}): следующий новый клиент получит
          отказ запуска. Добавьте ящики.
        </StatusBox>
      )}
      {actionError && <StatusBox tone="error">{actionError}</StatusBox>}
      {actionInfo && <StatusBox tone="info">{actionInfo}</StatusBox>}

      {data?.supported && (
        <div className="flex flex-wrap gap-2">
          {Object.entries(data.counts ?? {}).map(([ws, c]) => (
            <span key={ws} className={HE.chip}>
              {ws}: свободно {c.available}, отдано {c.assigned}, выключено {c.disabled}
              {!assignable.has(ws) && ' — не выдаётся'}
            </span>
          ))}
        </div>
      )}

      {/* Добавление */}
      <div className={`${HE.card} ${HE.cardPad} space-y-3`}>
        <p className={HE.secTitle}>Добавить ящики</p>
        <p className={`text-xs ${HE.muted2}`}>
          Адреса по одному на строку. Каждый проверяется у рассыльщика: есть в выбранном воркспейсе, активен, прогрев не
          в бане. Ящик, который уже стоит в пресете любого клиента или в живом запуске RU-кабинета, не добавляется. Ящики
          добавляются только в воркспейс пула; в «main» — никогда.
        </p>
        <div className="grid gap-3 sm:grid-cols-[220px_1fr]">
          <select
            className={HE.input}
            value={selectedWorkspace}
            onChange={(e) => setWorkspace(e.target.value)}
            disabled={adding || workspaces.length === 0}
            aria-label="Воркспейс рассыльщика"
          >
            {workspaces.map((w) => (
              <option key={w.id} value={w.id}>
                {w.label} ({w.id})
              </option>
            ))}
          </select>
          <input
            className={HE.input}
            placeholder="Заметка (необязательно): откуда ящики, когда прогреты"
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            disabled={adding}
          />
        </div>
        <textarea
          className={`${HE.input} min-h-[96px] font-mono`}
          placeholder={'hello@domain-one.com\nteam@domain-two.com'}
          value={emailsText}
          onChange={(e) => setEmailsText(e.target.value)}
          disabled={adding}
        />
        <button
          type="button"
          className={HE.btnPrimary}
          onClick={() => void addMailboxes()}
          disabled={adding || !selectedWorkspace || !emailsText.trim() || data?.supported === false}
        >
          {adding ? 'Проверяем и добавляем…' : 'Добавить в пул'}
        </button>
        {addLog.length > 0 && (
          <ul className="space-y-1 text-xs">
            {addLog.map((l) => (
              <li key={l.email} className={l.ok ? 'text-emerald-700' : 'text-red-700'}>
                {l.email} — {l.text}
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* Проекты с ящиками */}
      {projects.length > 0 && (
        <div className={`${HE.card} ${HE.cardPad} space-y-3`}>
          <p className={HE.secTitle}>Проекты с ящиками пула</p>
          <ul className="divide-y divide-gray-100">
            {projects.map(([projectId, entry]) => {
              const label = entry.project
                ? prettyProjectName(entry.project.name, entry.project.website_url)
                : projectId;
              return (
                <li key={projectId} className="flex flex-wrap items-center justify-between gap-3 py-2">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium text-gray-900">{label}</p>
                    <p className={`truncate text-xs ${HE.muted}`}>
                      {projectId} · {entry.rows.map((r) => r.email).join(', ')}
                    </p>
                  </div>
                  <button
                    type="button"
                    className={HE.btnSmall}
                    disabled={busyId === projectId}
                    onClick={() => void releaseProject(projectId, label, entry.rows.length)}
                  >
                    Вернуть ящики в пул
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      )}

      {/* Все ящики */}
      <div className={`${HE.card} overflow-x-auto`}>
        {loading && !data ? (
          <p className={`p-5 text-sm ${HE.muted}`}>Загрузка…</p>
        ) : rows.length === 0 ? (
          <p className={`p-5 text-sm ${HE.muted}`}>{data?.supported === false ? 'Пул недоступен.' : 'В пуле пока нет ящиков.'}</p>
        ) : (
          <table className="w-full text-left text-sm">
            <thead className={`text-xs ${HE.muted2}`}>
              <tr>
                <th className="px-4 py-2 font-medium">Ящик</th>
                <th className="px-4 py-2 font-medium">Воркспейс</th>
                <th className="px-4 py-2 font-medium">Статус</th>
                <th className="px-4 py-2 font-medium">Проект</th>
                <th className="px-4 py-2 font-medium">Даты</th>
                <th className="px-4 py-2 font-medium">Заметка</th>
                <th className="px-4 py-2" />
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {rows.map((row) => (
                <tr key={row.id}>
                  <td className="px-4 py-2 font-mono text-xs text-gray-900">{row.email}</td>
                  <td className="px-4 py-2 text-xs">{row.instantly_account_id}</td>
                  <td className="px-4 py-2">
                    <Badge tone={STATUS_META[row.status]?.tone ?? 'gray'}>{STATUS_META[row.status]?.label ?? row.status}</Badge>
                  </td>
                  <td className="px-4 py-2 text-xs">
                    {row.project
                      ? prettyProjectName(row.project.name, row.project.website_url)
                      : row.project_id ?? '—'}
                  </td>
                  <td className={`px-4 py-2 text-xs ${HE.muted2}`}>
                    добавлен {formatDate(row.created_at)}
                    {row.assigned_at ? <><br />отдан {formatDate(row.assigned_at)}</> : null}
                    {row.released_at ? <><br />последний возврат {formatDate(row.released_at)}</> : null}
                  </td>
                  <td className={`max-w-[220px] truncate px-4 py-2 text-xs ${HE.muted2}`} title={row.notes ?? undefined}>
                    {row.notes ?? '—'}
                  </td>
                  <td className="px-4 py-2 text-right">
                    {row.status === 'available' && (
                      <button
                        type="button"
                        className={HE.btnSmall}
                        disabled={busyId === row.id}
                        onClick={() => void setStatus(row, 'disabled')}
                      >
                        Выключить
                      </button>
                    )}
                    {row.status === 'disabled' && (
                      <button
                        type="button"
                        className={HE.btnSmall}
                        disabled={busyId === row.id}
                        onClick={() => void setStatus(row, 'available')}
                      >
                        Включить
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {data?.truncated && (
          <p className={`px-4 py-2 text-xs ${HE.muted}`}>Показаны первые 2000 ящиков.</p>
        )}
      </div>
    </div>
  );
}
