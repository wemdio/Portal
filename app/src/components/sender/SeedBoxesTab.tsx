'use client';

import { useCallback, useEffect, useState } from 'react';
import { Loader2, Plus, RefreshCw, Trash2 } from 'lucide-react';
import {
  addSeedBoxes,
  checkSeedBox,
  deleteSeedBox,
  fetchSeedBoxes,
  fetchSeedHealth,
  updateSeedBox,
  type SeedBoxDto,
  type SeedBoxesResponse,
  type SeedHealthDto,
  type SeedProviderId,
} from './api';
import { SenderModal } from './SenderModal';
import { SortableTh } from '@/components/ui/SortableTh';
import { useSortableRows, type SortColumns } from '@/components/ui/useSortableRows';

/**
 * «Контрольные ящики»: свои ящики Яндекс, Gmail и Mail.ru. Раз в рабочий день
 * каждый ящик идущих рассылок шлёт на них по нейтральному письму, портал
 * смотрит, легло оно во «Входящие» или в спам, и считает health score ящика.
 * Спека: docs/superpowers/specs/2026-10-07-sender-seed-inbox-placement-design.md
 */

const PROVIDER_LETTER: Record<SeedProviderId, string> = { yandex: 'Я', gmail: 'G', mailru: 'M' };
const PROVIDER_LABEL: Record<SeedProviderId, string> = { yandex: 'Яндекс', gmail: 'Gmail', mailru: 'Mail.ru' };
const PROVIDER_ORDER: SeedProviderId[] = ['yandex', 'gmail', 'mailru'];
/**
 * Цвет сервиса в карточке: Яндекс красный, Gmail жёлтый, Mail.ru голубой.
 * У Mail.ru sky-500 и прозрачный фон: тёмная тема гасит sky-600/sky-50 в серый.
 */
const PROVIDER_TONE: Record<SeedProviderId, { text: string; badge: string }> = {
  yandex: { text: 'text-red-600', badge: 'bg-red-50 text-red-600' },
  gmail: { text: 'text-amber-500', badge: 'bg-amber-50 text-amber-500' },
  mailru: { text: 'text-sky-500', badge: 'bg-sky-500/15 text-sky-500' },
};
const SEED_PAGE_SIZE = 10;
const HEALTH_PAGE_SIZE = 50;
const NO_BOXES: SeedBoxDto[] = [];

/** «Вход»: сначала рабочие, потом не проверенные, потом без входа. */
const STATUS_RANK: Record<string, number> = { ok: 0, failed: 2 };

const SEED_COLUMNS: SortColumns<SeedBoxDto> = {
  provider: { type: 'string', getValue: (box) => PROVIDER_LABEL[box.provider] },
  email: { type: 'string', getValue: (box) => box.email },
  status: { type: 'number', getValue: (box) => STATUS_RANK[box.status] ?? 1 },
};

/** Ящик без проверенных писем (score —) уходит в конец при любом направлении. */
const HEALTH_COLUMNS: SortColumns<SeedHealthDto> = {
  email: { type: 'string', getValue: (row) => row.email },
  score: { type: 'number', getValue: (row) => row.score },
};

/** Страница списка: номер приводится в границы, если список укоротился (удалили ящик). */
function pageOf<T>(items: T[], page: number, size: number): { rows: T[]; page: number; pages: number } {
  const pages = Math.max(1, Math.ceil(items.length / size));
  const safe = Math.min(Math.max(1, page), pages);
  return { rows: items.slice((safe - 1) * size, safe * size), page: safe, pages };
}

function Pager({ page, pages, total, unit, onPage }: { page: number; pages: number; total: number; unit: string; onPage: (page: number) => void }) {
  if (pages <= 1) return null;
  return (
    <div className="flex items-center justify-center gap-4 border-t border-zinc-200 px-5 py-3 text-sm">
      <button
        type="button"
        onClick={() => onPage(page - 1)}
        disabled={page <= 1}
        className="rounded-md px-3 py-1.5 text-zinc-700 hover:bg-zinc-100 disabled:opacity-40"
      >
        ← Назад
      </button>
      <span className="text-zinc-500">Стр. {page} из {pages} · {total} {unit}</span>
      <button
        type="button"
        onClick={() => onPage(page + 1)}
        disabled={page >= pages}
        className="rounded-md px-3 py-1.5 text-zinc-700 hover:bg-zinc-100 disabled:opacity-40"
      >
        Вперёд →
      </button>
    </div>
  );
}

function weekLine(week: { inbox: number; spam: number; missing: number }): string {
  const done = week.inbox + week.spam + week.missing;
  if (!done) return 'проверенных писем нет';
  return `во входящих ${week.inbox} из ${done} · спам ${week.spam} · не дошло ${week.missing}`;
}

function scoreTone(score: number | null): string {
  if (score === null) return 'text-zinc-400';
  if (score >= 80) return 'text-emerald-600';
  if (score >= 50) return 'text-amber-600';
  return 'text-red-600';
}

function StatusChip({ box }: { box: SeedBoxDto }) {
  if (box.status === 'ok') {
    return <span className="rounded-full bg-emerald-50 px-2 py-0.5 text-xs text-emerald-700">вход есть</span>;
  }
  if (box.status === 'failed') {
    return (
      <span title={box.last_error ?? ''} className="cursor-help rounded-full bg-red-50 px-2 py-0.5 text-xs text-red-700">
        нет входа
      </span>
    );
  }
  return <span className="rounded-full bg-zinc-100 px-2 py-0.5 text-xs text-zinc-500">не проверен</span>;
}

export function SeedBoxesTab() {
  const [data, setData] = useState<SeedBoxesResponse | null>(null);
  const [health, setHealth] = useState<SeedHealthDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [passwordFor, setPasswordFor] = useState<SeedBoxDto | null>(null);
  const [proxyFor, setProxyFor] = useState<SeedBoxDto | null>(null);
  const [seedPage, setSeedPage] = useState(1);
  const [healthPage, setHealthPage] = useState(1);
  const boxes = data?.boxes ?? NO_BOXES;
  const seedSort = useSortableRows(boxes, SEED_COLUMNS);
  const healthSort = useSortableRows(health, HEALTH_COLUMNS);

  const load = useCallback(async () => {
    try {
      const [boxes, scores] = await Promise.all([fetchSeedBoxes(), fetchSeedHealth()]);
      setData(boxes);
      setHealth(scores.mailboxes);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Не удалось загрузить контрольные ящики');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  /** Проверка входа по очереди: IMAP медленный, пачку параллельно сервис примет за атаку. */
  const checkMany = async (ids: string[]) => {
    let failed = 0;
    for (let i = 0; i < ids.length; i += 1) {
      setBusyId(ids[i]);
      setNotice(ids.length > 1 ? `Проверяю вход: ${i + 1} из ${ids.length}…` : null);
      try {
        const res = await checkSeedBox(ids[i]);
        if (!res.ok) failed += 1;
      } catch {
        failed += 1;
      }
    }
    setBusyId(null);
    setNotice(ids.length > 1 ? `Проверено ${ids.length}: без входа ${failed}` : null);
    await load();
  };

  const toggle = async (box: SeedBoxDto) => {
    setError(null);
    try {
      await updateSeedBox(box.id, { enabled: !box.enabled });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Не удалось изменить ящик');
    }
  };

  const remove = async (box: SeedBoxDto) => {
    if (!window.confirm(`Удалить ${box.email}? История проб останется.`)) return;
    setError(null);
    try {
      await deleteSeedBox(box.id);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Не удалось удалить ящик');
    }
  };

  if (loading) {
    return (
      <div className="flex items-center gap-2 text-sm text-zinc-500">
        <Loader2 className="h-4 w-4 animate-spin" /> Загружаю…
      </div>
    );
  }

  const seedView = pageOf(seedSort.sortedRows, seedPage, SEED_PAGE_SIZE);
  const healthView = pageOf(healthSort.sortedRows, healthPage, HEALTH_PAGE_SIZE);
  // Новый порядок — с первой страницы.
  const sortSeed = (key: string) => { seedSort.toggleSort(key); setSeedPage(1); };
  const sortHealth = (key: string) => { healthSort.toggleSort(key); setHealthPage(1); };

  return (
    <div className="space-y-6">
      {error ? <p className="text-sm text-red-600">{error}</p> : null}
      {notice ? <p className="text-sm text-emerald-600">{notice}</p> : null}

      <p className={`text-sm ${data?.probesActive ? 'text-emerald-700' : 'text-amber-700'}`}>
        {data?.probesActive
          ? 'Ежедневная проверка идёт: каждый ящик рассылки шлёт по письму на каждый сервис.'
          : 'Ежедневная проверка пока выключена — подключите ящики и проверьте вход.'}
      </p>

      <div className="grid gap-3 sm:grid-cols-3">
        {PROVIDER_ORDER.map((provider) => {
          const own = boxes.filter((b) => b.provider === provider);
          const ok = own.filter((b) => b.status === 'ok' && b.enabled).length;
          const week = data?.providers.find((p) => p.provider === provider)?.week ?? { inbox: 0, spam: 0, missing: 0, total: 0 };
          const done = week.inbox + week.spam + week.missing;
          const score = done ? Math.round((week.inbox / done) * 100) : null;
          const tone = PROVIDER_TONE[provider];
          const share = (n: number) => `${done ? (n / done) * 100 : 0}%`;
          return (
            <div key={provider} className="rounded-xl border border-zinc-200 bg-white p-4">
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <span className={`inline-flex h-7 w-7 items-center justify-center rounded-lg text-sm font-bold ${tone.badge}`}>
                    {PROVIDER_LETTER[provider]}
                  </span>
                  <span className={`text-base font-semibold ${tone.text}`}>{PROVIDER_LABEL[provider]}</span>
                </div>
                <span className={`rounded-full px-2 py-0.5 text-xs ${ok ? 'bg-zinc-100 text-zinc-600' : 'bg-amber-50 text-amber-600'}`}>
                  {own.length ? `в работе ${ok} из ${own.length}` : 'нет ящиков'}
                </span>
              </div>

              <div className="mt-4 flex items-end justify-between gap-2">
                <div>
                  <div className={`text-3xl font-semibold tabular-nums leading-none ${scoreTone(score)}`}>
                    {score === null ? '—' : `${score}%`}
                  </div>
                  <div className="mt-1 text-xs text-zinc-500">во «Входящих» · 7 дней</div>
                </div>
                <div className="text-right text-xs text-zinc-500">
                  <span className="font-semibold tabular-nums text-zinc-900">{done}</span> писем
                </div>
              </div>

              <div className="mt-3 flex h-1.5 overflow-hidden rounded-full bg-zinc-100">
                <div className="bg-emerald-500" style={{ width: share(week.inbox) }} />
                <div className="bg-amber-400" style={{ width: share(week.spam) }} />
                <div className="bg-red-500" style={{ width: share(week.missing) }} />
              </div>
              <div className="mt-2 flex justify-between text-xs text-zinc-500">
                <span><span className="font-semibold tabular-nums text-emerald-600">{week.inbox}</span> входящие</span>
                <span><span className="font-semibold tabular-nums text-amber-500">{week.spam}</span> спам</span>
                <span><span className="font-semibold tabular-nums text-red-600">{week.missing}</span> не дошло</span>
              </div>
            </div>
          );
        })}
      </div>

      <div className="rounded-xl border border-zinc-200 bg-white">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-zinc-100 px-5 py-3">
          <h2 className="text-sm font-semibold text-zinc-900">Контрольные ящики</h2>
          <div className="flex gap-2">
            {boxes.length ? (
              <button
                type="button"
                onClick={() => void checkMany(boxes.filter((b) => b.enabled).map((b) => b.id))}
                disabled={busyId !== null}
                className="inline-flex items-center gap-1.5 rounded-lg border border-zinc-300 px-3 py-1.5 text-sm text-zinc-700 hover:bg-zinc-100 disabled:opacity-50"
              >
                <RefreshCw className="h-4 w-4" /> Проверить все
              </button>
            ) : null}
            <button
              type="button"
              onClick={() => setAddOpen(true)}
              className="inline-flex items-center gap-1.5 rounded-lg bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-500"
            >
              <Plus className="h-4 w-4" /> Добавить
            </button>
          </div>
        </div>

        {boxes.length ? (
          <table className="w-full text-sm">
            <thead className="text-left text-xs uppercase text-zinc-500">
              <tr>
                <SortableTh label="Сервис" sortKey="provider" sort={seedSort.sort} onSort={sortSeed} className="pl-5" />
                <SortableTh label="Адрес" sortKey="email" sort={seedSort.sort} onSort={sortSeed} className="pl-0" />
                <SortableTh label="Вход" sortKey="status" sort={seedSort.sort} onSort={sortSeed} className="pl-0" />
                <th className="py-2 pr-3 font-medium">Письма за 7 дней</th>
                <th className="py-2 pr-5" />
              </tr>
            </thead>
            <tbody>
              {seedView.rows.map((box) => (
                <tr key={box.id} className={`border-t border-zinc-100 ${box.enabled ? '' : 'opacity-50'}`}>
                  <td className="py-2 pl-5 pr-3 text-zinc-600">{PROVIDER_LABEL[box.provider]}</td>
                  <td className="py-2 pr-3">
                    <div className="font-medium text-zinc-900">{box.email}</div>
                    {box.proxy_label ? <div className="text-xs text-zinc-400">через прокси {box.proxy_label}</div> : null}
                  </td>
                  <td className="py-2 pr-3">
                    {busyId === box.id ? <Loader2 className="h-4 w-4 animate-spin text-zinc-400" /> : <StatusChip box={box} />}
                  </td>
                  <td className="py-2 pr-3 text-xs text-zinc-500">{weekLine(box.week)}</td>
                  <td className="py-2 pr-5">
                    <div className="flex justify-end gap-1 text-xs">
                      <button type="button" disabled={busyId !== null} onClick={() => void checkMany([box.id])} className="rounded-md px-2 py-1 text-blue-600 hover:bg-blue-50 disabled:opacity-50">
                        Проверить
                      </button>
                      <button type="button" onClick={() => setPasswordFor(box)} className="rounded-md px-2 py-1 text-zinc-600 hover:bg-zinc-100">
                        Пароль
                      </button>
                      <button type="button" onClick={() => setProxyFor(box)} className="rounded-md px-2 py-1 text-zinc-600 hover:bg-zinc-100">
                        Прокси
                      </button>
                      <button type="button" onClick={() => void toggle(box)} className="rounded-md px-2 py-1 text-zinc-600 hover:bg-zinc-100">
                        {box.enabled ? 'Выключить' : 'Включить'}
                      </button>
                      <button type="button" onClick={() => void remove(box)} aria-label={`Удалить ${box.email}`} className="rounded-md p-1 text-zinc-400 hover:bg-red-50 hover:text-red-600">
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p className="px-5 py-6 text-sm text-zinc-500">Ящиков пока нет — добавьте строки из выдачи продавца.</p>
        )}
        <Pager page={seedView.page} pages={seedView.pages} total={boxes.length} unit="ящиков" onPage={setSeedPage} />
      </div>

      <div className="rounded-xl border border-zinc-200 bg-white">
        <div className="border-b border-zinc-100 px-5 py-3">
          <h2 className="text-sm font-semibold text-zinc-900">Health score ящиков рассылки · 7 дней</h2>
          <p className="mt-0.5 text-xs text-zinc-500">Доля писем, попавших во «Входящие».</p>
        </div>
        {health.length ? (
          <table className="w-full text-sm">
            <thead className="text-left text-xs uppercase text-zinc-500">
              <tr>
                <SortableTh label="Ящик" sortKey="email" sort={healthSort.sort} onSort={sortHealth} className="pl-5" />
                <SortableTh label="Score" sortKey="score" sort={healthSort.sort} onSort={sortHealth} className="pl-0" />
                <th className="py-2 pr-3 font-medium">Входящие / спам / не дошло</th>
                <th className="py-2 pr-5 font-medium">Последний раз</th>
              </tr>
            </thead>
            <tbody>
              {healthView.rows.map((row) => (
                <tr key={row.id} className="border-t border-zinc-100">
                  <td className="py-2 pl-5 pr-3 text-zinc-900">{row.email}</td>
                  <td className={`py-2 pr-3 font-semibold ${scoreTone(row.score)}`}>{row.score === null ? '—' : `${row.score}%`}</td>
                  <td className="py-2 pr-3 text-zinc-600">{row.inbox} / {row.spam} / {row.missing}</td>
                  <td className="py-2 pr-5">
                    <div className="flex gap-1">
                      {PROVIDER_ORDER.map((provider) => {
                        const last = row.last[provider];
                        const tone = !last ? 'bg-zinc-100 text-zinc-400'
                          : last.status === 'inbox' ? 'bg-emerald-100 text-emerald-700'
                            : last.status === 'spam' ? 'bg-amber-100 text-amber-700'
                              : 'bg-red-100 text-red-700';
                        const title = !last ? `${PROVIDER_LABEL[provider]}: не проверялось`
                          : `${PROVIDER_LABEL[provider]}, ${last.day}: ${last.status === 'inbox' ? 'входящие' : last.status === 'spam' ? 'спам' : 'не дошло'}`;
                        return (
                          <span key={provider} title={title} className={`inline-flex h-6 w-6 cursor-help items-center justify-center rounded text-xs font-semibold ${tone}`}>
                            {PROVIDER_LETTER[provider]}
                          </span>
                        );
                      })}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p className="px-5 py-6 text-sm text-zinc-500">Появится после первого дня ежедневной проверки.</p>
        )}
        <Pager page={healthView.page} pages={healthView.pages} total={health.length} unit="ящиков" onPage={setHealthPage} />
      </div>

      {addOpen ? (
        <AddSeedBoxesModal
          onClose={() => setAddOpen(false)}
          onAdded={async (ids, skipped) => {
            setAddOpen(false);
            setError(skipped.length ? `Не добавлены: ${skipped.join('; ')}` : null);
            await load();
            if (ids.length) await checkMany(ids);
          }}
        />
      ) : null}
      {passwordFor ? (
        <PasswordModal
          box={passwordFor}
          onClose={() => setPasswordFor(null)}
          onSaved={async () => {
            const id = passwordFor.id;
            setPasswordFor(null);
            await checkMany([id]);
          }}
        />
      ) : null}
      {proxyFor ? (
        <ProxyModal
          box={proxyFor}
          onClose={() => setProxyFor(null)}
          onSaved={async () => {
            const id = proxyFor.id;
            setProxyFor(null);
            await load();
            await checkMany([id]);
          }}
        />
      ) : null}
    </div>
  );
}

/** Пачка строк из выдачи продавца: адрес — первым полем, пароль IMAP — последним. */
function AddSeedBoxesModal({
  onClose,
  onAdded,
}: {
  onClose: () => void;
  onAdded: (ids: string[], skipped: string[]) => void | Promise<void>;
}) {
  const [lines, setLines] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await addSeedBoxes({ lines });
      await onAdded(res.created.map((c) => c.id), res.skipped);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Не удалось добавить ящики');
    } finally {
      setBusy(false);
    }
  };

  return (
    <SenderModal
      title="Добавить контрольные ящики"
      subtitle="Строки из выдачи продавца, по одной на ящик"
      onClose={onClose}
      footer={
        <>
          {error ? <span className="mr-auto text-sm text-red-600">{error}</span> : null}
          <button type="button" onClick={onClose} className="rounded-lg px-3 py-2 text-sm text-zinc-600 hover:bg-zinc-100">
            Отмена
          </button>
          <button
            type="button"
            onClick={() => void submit()}
            disabled={busy || !lines.trim()}
            className="inline-flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-500 disabled:opacity-50"
          >
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
            Добавить и проверить
          </button>
        </>
      }
    >
      <textarea
        autoFocus
        value={lines}
        onChange={(e) => setLines(e.target.value)}
        rows={10}
        spellCheck={false}
        placeholder={'name@mail.ru:пароль:Имя:Фамилия:пол:дата:пароль IMAP\nname@yandex.ru;пароль IMAP\nname@gmail.com:пароль:2FA:пароль приложения'}
        className="w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 font-mono text-xs text-zinc-900"
      />
      <p className="mt-2 text-xs text-zinc-500">
        Берём адрес и последнее поле — пароль IMAP или пароль приложения. Остальное не сохраняется.
      </p>
    </SenderModal>
  );
}

function PasswordModal({ box, onClose, onSaved }: { box: SeedBoxDto; onClose: () => void; onSaved: () => void | Promise<void> }) {
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await updateSeedBox(box.id, { password });
      await onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Не удалось сохранить пароль');
    } finally {
      setBusy(false);
    }
  };

  return (
    <SenderModal
      title="Новый пароль приложения"
      subtitle={box.email}
      onClose={onClose}
      footer={
        <>
          {error ? <span className="mr-auto text-sm text-red-600">{error}</span> : null}
          <button type="button" onClick={onClose} className="rounded-lg px-3 py-2 text-sm text-zinc-600 hover:bg-zinc-100">
            Отмена
          </button>
          <button
            type="button"
            onClick={() => void submit()}
            disabled={busy || !password.trim()}
            className="inline-flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-500 disabled:opacity-50"
          >
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
            Сохранить и проверить
          </button>
        </>
      }
    >
      <input
        autoFocus
        type="password"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        autoComplete="new-password"
        placeholder="Пароль IMAP / пароль приложения"
        className="w-full rounded-lg border border-zinc-300 bg-white px-3.5 py-2.5 text-sm text-zinc-900"
      />
    </SenderModal>
  );
}

/** Свой прокси на ящик: Яндекс пускает купленные ящики только с российских адресов. */
function ProxyModal({ box, onClose, onSaved }: { box: SeedBoxDto; onClose: () => void; onSaved: () => void | Promise<void> }) {
  const [proxy, setProxy] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async (value: string | null) => {
    setBusy(true);
    setError(null);
    try {
      await updateSeedBox(box.id, { proxy: value });
      await onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Не удалось сохранить прокси');
    } finally {
      setBusy(false);
    }
  };

  return (
    <SenderModal
      title="Прокси для входа"
      subtitle={box.proxy_label ? `${box.email} · сейчас ${box.proxy_label}` : box.email}
      onClose={onClose}
      footer={
        <>
          {error ? <span className="mr-auto text-sm text-red-600">{error}</span> : null}
          {box.proxy_label ? (
            <button
              type="button"
              onClick={() => void save(null)}
              disabled={busy}
              className="rounded-lg px-3 py-2 text-sm text-red-600 hover:bg-red-50 disabled:opacity-50"
            >
              Убрать прокси
            </button>
          ) : null}
          <button type="button" onClick={onClose} className="rounded-lg px-3 py-2 text-sm text-zinc-600 hover:bg-zinc-100">
            Отмена
          </button>
          <button
            type="button"
            onClick={() => void save(proxy)}
            disabled={busy || !proxy.trim()}
            className="inline-flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-500 disabled:opacity-50"
          >
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
            Сохранить и проверить
          </button>
        </>
      }
    >
      <input
        autoFocus
        value={proxy}
        onChange={(e) => setProxy(e.target.value)}
        autoComplete="off"
        spellCheck={false}
        placeholder="http://логин:пароль@1.2.3.4:8000 или 1.2.3.4:8000:логин:пароль"
        className="w-full rounded-lg border border-zinc-300 bg-white px-3.5 py-2.5 text-sm text-zinc-900"
      />
      <p className="mt-2 text-xs text-zinc-500">Российский, один прокси на один ящик</p>
    </SenderModal>
  );
}
