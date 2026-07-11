'use client';

import { useCallback, useEffect, useState } from 'react';
import { authFetch } from '@/lib/authFetch';
import { logError } from '@/lib/loggerClient';
import type { MailboxLoad, TagLoad, SpecialistLoad, MailboxRow, PoolInfo, TagStatus } from '@/lib/instantly/mailboxLoad';

// ── визуальные пресеты статусов утилизации ────────────────────────────────────
// Пороги и статус считает ТОЛЬКО сервер (classify в mailboxLoad.ts) — здесь
// исключительно отображение, чтобы правка порогов не расходилась по слоям.
const STATUS_UI: Record<TagStatus, { label: string; badge: string; bar: string; row: string }> = {
  over: { label: 'Перебор', badge: 'bg-violet-50 text-violet-700 border-violet-200', bar: 'bg-violet-500', row: '' },
  full: { label: 'Потолок', badge: 'bg-emerald-50 text-emerald-700 border-emerald-200', bar: 'bg-emerald-500', row: '' },
  ok: { label: 'Норма', badge: 'bg-sky-50 text-sky-700 border-sky-200', bar: 'bg-sky-500', row: '' },
  low: { label: 'Недогруз', badge: 'bg-amber-50 text-amber-700 border-amber-200', bar: 'bg-amber-500', row: 'bg-amber-50/40' },
  idle: { label: 'Простой', badge: 'bg-red-50 text-red-700 border-red-200', bar: 'bg-red-400', row: 'bg-red-50/50' },
  stopped: { label: 'Ящики выключены', badge: 'bg-zinc-100 text-zinc-600 border-zinc-200', bar: 'bg-zinc-400', row: 'opacity-75' },
  no_capacity: { label: 'Нет активных', badge: 'bg-gray-100 text-gray-500 border-gray-200', bar: 'bg-gray-300', row: 'opacity-60' },
};

const fmt = (n: number) => n.toLocaleString('ru-RU');
const pct = (u: number | null) => (u == null ? '—' : `${Math.round(u * 100)}%`);

// нормализация для сравнения «клиент ≈ название тега» (убираем пунктуацию/регистр)
const norm = (s: string | null | undefined) => (s ?? '').replace(/[^\p{L}\p{N}]/gu, '').toLowerCase();

function UtilBar({ utilization, status }: { utilization: number | null; status: TagStatus }) {
  const ui = STATUS_UI[status];
  const width = utilization == null ? 0 : Math.min(utilization, 1) * 100;
  return (
    <div className="flex items-center gap-2 min-w-[130px]">
      <div className="relative h-2 flex-1 rounded-full bg-zinc-100 overflow-hidden">
        <div className={`h-full rounded-full ${ui.bar}`} style={{ width: `${width}%` }} />
      </div>
      <span className={`tabular-nums text-[11px] font-semibold w-9 text-right ${
        status === 'idle' ? 'text-red-600' : status === 'over' ? 'text-violet-600' : 'text-zinc-700'
      }`}>
        {pct(utilization)}
      </span>
    </div>
  );
}

function StatusBadge({ status }: { status: TagStatus }) {
  const ui = STATUS_UI[status];
  return <span className={`inline-block rounded-full border px-1.5 py-0.5 text-[10px] font-medium ${ui.badge}`}>{ui.label}</span>;
}

function SummaryTile({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="rounded-xl border border-zinc-200 bg-white px-4 py-3">
      <p className="text-[10px] font-medium uppercase tracking-wider text-zinc-400">{label}</p>
      <p className="mt-1 text-xl font-semibold tabular-nums text-zinc-900">{value}</p>
      {sub && <p className="text-[11px] text-zinc-400">{sub}</p>}
    </div>
  );
}

function PoolCard({ pool }: { pool: PoolInfo }) {
  const exhausted = pool.freeMailboxes === 0;
  return (
    <div className={`flex flex-wrap items-center gap-x-4 gap-y-1 rounded-xl border px-4 py-2.5 text-xs ${
      exhausted ? 'border-amber-200 bg-amber-50' : 'border-zinc-200 bg-white'
    }`}>
      <span className="font-medium text-zinc-800">Резерв «{pool.tag}»</span>
      <span className={exhausted ? 'font-semibold text-amber-700' : 'text-zinc-600'}>
        свободно: <b className="tabular-nums">{pool.freeMailboxes}</b> ящиков ({fmt(pool.freeCapacity)} писем/день)
      </span>
      <span className="text-zinc-500">
        занято под клиентами: <b className="tabular-nums">{pool.takenMailboxes}</b> из {pool.totalMailboxes}
      </span>
      {exhausted && <span className="text-amber-700">⚠️ резерв исчерпан — под нового клиента нужны новые ящики</span>}
      <span className="text-[10px] text-zinc-400">занятые ящики посчитаны в тегах своих клиентов</span>
    </div>
  );
}

// day — за какой день загружены ящики: защита от гонки (drill, стартовавший до
// смены дня, доезжает после очистки кэша и не должен выдаваться за новый день)
type DrillState = { loading: boolean; error: boolean; day: string; tag: string | null; mailboxes: MailboxRow[] } | undefined;

export default function MailboxLoadPage() {
  const [data, setData] = useState<MailboxLoad | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [day, setDay] = useState<string>(''); // '' = авто (последний полный день)
  const [reloadKey, setReloadKey] = useState(0); // кнопка «Обновить»
  const [view, setView] = useState<'tags' | 'specialists'>('tags');
  const [expanded, setExpanded] = useState<string | null>(null); // tagId
  const [drill, setDrill] = useState<Record<string, DrillState>>({});
  const [expandedSpec, setExpandedSpec] = useState<string | null>(null);

  // Фетч в эффекте, ключ = выбранный день + reloadKey. Инлайн-async + setState ПОСЛЕ
  // await + флаг active — идиома дома (без cascading-render варнинга). Спиннер на старте
  // даёт initial loading=true; при смене дня/обновлении loading ставят обработчики.
  useEffect(() => {
    let active = true;
    const run = async () => {
      try {
        const qs = day ? `?day=${encodeURIComponent(day)}` : '';
        const res = await authFetch(`/api/analytics/mailbox-load${qs}`);
        if (!res.ok) {
          // тело несёт код причины (dataset_not_configured / build_failed /
          // role_check_failed) — показываем его, а не голый HTTP-статус
          const body = (await res.json().catch(() => null)) as { error?: string } | null;
          throw new Error(body?.error || `HTTP ${res.status}`);
        }
        const json = (await res.json()) as { data: MailboxLoad | null; error?: string };
        if (!active) return;
        if (!json.data) throw new Error(json.error || 'Нет данных');
        setError(null);
        setData(json.data);
        setExpanded(null);
        setExpandedSpec(null);
        setDrill({});
      } catch (e) {
        if (!active) return;
        logError('mailbox-load load failed', e);
        setError((e as Error).message);
      } finally {
        if (active) setLoading(false);
      }
    };
    void run();
    return () => { active = false; };
  }, [day, reloadKey]);

  const toggleTag = useCallback(async (tagId: string) => {
    const cached = drill[tagId];
    const currentDay = data?.asOfDay ?? '';
    if (expanded === tagId) {
      // клик по раскрытой строке: обычно сворачиваем, но при ошибке — ретраим
      // на месте (иначе подсказка «кликните ещё раз» требовала бы два клика)
      if (!cached?.error) { setExpanded(null); return; }
    } else {
      setExpanded(tagId);
    }
    // рефетч: нет кэша / прошлая ошибка / кэш от другого дня (гонка со сменой дня)
    if (!cached || cached.error || cached.day !== currentDay) {
      setDrill((d) => ({ ...d, [tagId]: { loading: true, error: false, day: currentDay, tag: null, mailboxes: [] } }));
      try {
        const qs = currentDay ? `?day=${encodeURIComponent(currentDay)}` : '';
        const res = await authFetch(`/api/analytics/mailbox-load/${encodeURIComponent(tagId)}${qs}`);
        if (!res.ok) {
          const body = (await res.json().catch(() => null)) as { error?: string } | null;
          throw new Error(body?.error || `HTTP ${res.status}`);
        }
        const json = (await res.json()) as { tag: string | null; mailboxes: MailboxRow[]; error?: string };
        if (json.error) throw new Error(json.error);
        setDrill((d) => ({ ...d, [tagId]: { loading: false, error: false, day: currentDay, tag: json.tag, mailboxes: json.mailboxes ?? [] } }));
      } catch (e) {
        logError('mailbox-load drill failed', e);
        setDrill((d) => ({ ...d, [tagId]: { loading: false, error: true, day: currentDay, tag: null, mailboxes: [] } }));
      }
    }
  }, [data, drill, expanded]);

  const t = !error ? data?.totals : undefined;

  return (
    <div className="space-y-4">
      {/* header */}
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold text-zinc-900">Нагрузка почт</h1>
          <p className="text-xs text-zinc-500">
            Утилизация ящиков по тегам клиентов: сколько из дневного потолка отправок реально выбрано.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <label className="text-[11px] text-zinc-500">День</label>
          <input
            type="date"
            value={day || data?.asOfDay || ''}
            max={data?.latestDay || undefined}
            onChange={(e) => { setLoading(true); setDay(e.target.value); }}
            className="rounded-lg border border-zinc-200 px-2 py-1 text-xs text-zinc-700"
          />
          <button
            type="button"
            onClick={() => { setLoading(true); setReloadKey((k) => k + 1); }}
            className="rounded-lg border border-zinc-200 px-2.5 py-1 text-xs text-zinc-600 hover:bg-zinc-50"
          >
            Обновить
          </button>
        </div>
      </div>

      {/* freshness banner (скрыт при ошибке — иначе рядом с ошибкой висят старые цифры) */}
      {data && !error && (
        <div className={`flex flex-wrap items-center gap-x-4 gap-y-1 rounded-lg border px-3 py-2 text-[11px] ${
          data.stale ? 'border-amber-200 bg-amber-50 text-amber-800' : 'border-zinc-200 bg-zinc-50 text-zinc-500'
        }`}>
          <span>Данные за <b className="text-zinc-700">{data.asOfDay || '—'}</b> (UTC-день)</span>
          {data.lastSync && <span>Последний синк: {new Date(data.lastSync).toLocaleString('ru-RU')}</span>}
          {data.stale && <span className="font-semibold">⚠️ Синк устарел — цифры могут быть неактуальны</span>}
        </div>
      )}

      {/* summary */}
      {t && (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <SummaryTile label="Потолок / день" value={fmt(t.capacity)} sub="Σ лимитов активных ящиков" />
          <SummaryTile label="Отправлено" value={fmt(t.sent)} sub="писем за день, все ящики" />
          <SummaryTile label="Утилизация" value={pct(t.utilization)} sub="факт / потолок" />
          <SummaryTile label="Активных ящиков" value={fmt(t.activeMailboxes)} sub="под тегами" />
        </div>
      )}

      {/* пул(ы) неименных ящиков — резерв, не клиент */}
      {!error && data?.pool.map((p) => <PoolCard key={p.tagId} pool={p} />)}

      {/* view toggle */}
      <div className="flex items-center gap-1">
        {(['tags', 'specialists'] as const).map((v) => (
          <button
            key={v}
            type="button"
            onClick={() => setView(v)}
            className={`rounded-full px-3 py-1 text-xs font-medium transition ${
              view === v ? 'bg-zinc-900 text-white' : 'text-zinc-500 hover:bg-zinc-100'
            }`}
          >
            {v === 'tags' ? 'По тегам' : 'По специалистам'}
          </button>
        ))}
      </div>

      {loading && <div className="py-10 text-center text-sm text-zinc-400">Загрузка…</div>}
      {error && !loading && (
        <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
          Ошибка загрузки: {error}
        </div>
      )}

      {/* ── ПО ТЕГАМ ── */}
      {!loading && !error && data && view === 'tags' && (
        <div className="overflow-x-auto rounded-xl border border-zinc-200 bg-white">
          <table className="w-full min-w-[720px] text-xs">
            <thead>
              <tr className="border-b border-zinc-100 text-left text-[10px] uppercase tracking-wider text-zinc-400">
                <th className="px-3 py-2 font-medium">Тег / клиент</th>
                <th className="px-3 py-2 font-medium">Специалист</th>
                <th className="px-3 py-2 font-medium text-right">Ящиков</th>
                <th className="px-3 py-2 font-medium text-right">Потолок</th>
                <th className="px-3 py-2 font-medium text-right">Отправлено</th>
                <th className="px-3 py-2 font-medium">Утилизация</th>
                <th className="px-3 py-2 font-medium">Статус</th>
              </tr>
            </thead>
            <tbody>
              {data.tags.map((tag) => (
                <TagRows
                  key={tag.tagId}
                  tag={tag}
                  expanded={expanded === tag.tagId}
                  drill={drill[tag.tagId]}
                  onToggle={() => void toggleTag(tag.tagId)}
                />
              ))}
              {data.tags.length === 0 && (
                <tr><td colSpan={7} className="px-3 py-8 text-center text-zinc-400">Нет тегов с ящиками.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      )}

      {/* ── ПО СПЕЦИАЛИСТАМ ── */}
      {!loading && !error && data && view === 'specialists' && (
        <div className="overflow-x-auto rounded-xl border border-zinc-200 bg-white">
          <table className="w-full min-w-[720px] text-xs">
            <thead>
              <tr className="border-b border-zinc-100 text-left text-[10px] uppercase tracking-wider text-zinc-400">
                <th className="px-3 py-2 font-medium">Специалист</th>
                <th className="px-3 py-2 font-medium text-right">Тегов</th>
                <th className="px-3 py-2 font-medium text-right">Активных ящиков</th>
                <th className="px-3 py-2 font-medium text-right">Потолок</th>
                <th className="px-3 py-2 font-medium text-right">Отправлено</th>
                <th className="px-3 py-2 font-medium">Утилизация</th>
              </tr>
            </thead>
            <tbody>
              {data.specialists.map((s) => (
                <SpecialistRows
                  key={s.specialist}
                  spec={s}
                  tags={data.tags}
                  expanded={expandedSpec === s.specialist}
                  onToggle={() => setExpandedSpec(expandedSpec === s.specialist ? null : s.specialist)}
                />
              ))}
              {data.specialists.length === 0 && (
                <tr><td colSpan={6} className="px-3 py-8 text-center text-zinc-400">Нет данных.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      )}

      {/* notes */}
      {data && !error && data.notes.length > 0 && (
        <ul className="space-y-1 text-[11px] text-zinc-400">
          {data.notes.map((n, i) => <li key={i}>• {n}</li>)}
        </ul>
      )}
    </div>
  );
}

// клавиатурная активация «кликабельной» строки таблицы
function rowKeyHandler(onToggle: () => void) {
  return (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      onToggle();
    }
  };
}

// ── строка тега + drill-down ──────────────────────────────────────────────────
function TagRows({ tag, expanded, drill, onToggle }: {
  tag: TagLoad; expanded: boolean; drill: DrillState; onToggle: () => void;
}) {
  const ui = STATUS_UI[tag.status];
  return (
    <>
      <tr
        className={`cursor-pointer border-b border-zinc-50 hover:bg-zinc-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-zinc-400 ${ui.row}`}
        onClick={onToggle}
        onKeyDown={rowKeyHandler(onToggle)}
        tabIndex={0}
        aria-expanded={expanded}
      >
        <td className="px-3 py-2">
          <div className="flex items-center gap-1.5">
            <span className={`text-zinc-300 transition-transform ${expanded ? 'rotate-90' : ''}`}>›</span>
            <span className="font-medium text-zinc-800">{tag.tag}</span>
            {tag.client && norm(tag.client) !== norm(tag.tag) && (
              <span className="text-zinc-400">· {tag.client}</span>
            )}
          </div>
        </td>
        <td className="px-3 py-2 text-zinc-600">
          {tag.specialist ?? <span className="text-zinc-300">—</span>}
          {tag.otherSpecialists.length > 0 && (
            <span className="text-zinc-300" title={tag.otherSpecialists.join(', ')}> +{tag.otherSpecialists.length}</span>
          )}
        </td>
        <td className="px-3 py-2 text-right tabular-nums text-zinc-600">
          {tag.activeMailboxes}
          {tag.totalMailboxes !== tag.activeMailboxes && <span className="text-zinc-300">/{tag.totalMailboxes}</span>}
        </td>
        <td className="px-3 py-2 text-right tabular-nums text-zinc-700">{fmt(tag.capacity)}</td>
        <td className="px-3 py-2 text-right tabular-nums text-zinc-700">{fmt(tag.sent)}</td>
        <td className="px-3 py-2"><UtilBar utilization={tag.utilization} status={tag.status} /></td>
        <td className="px-3 py-2"><StatusBadge status={tag.status} /></td>
      </tr>
      {expanded && (
        <tr className="bg-zinc-50/60">
          <td colSpan={7} className="px-3 py-2">
            {!drill || drill.loading ? (
              <div className="py-3 text-center text-[11px] text-zinc-400">Загрузка ящиков…</div>
            ) : drill.error ? (
              <div className="py-3 text-center text-[11px] text-red-600">
                Не удалось загрузить ящики. Кликните по строке ещё раз, чтобы повторить.
              </div>
            ) : drill.mailboxes.length === 0 ? (
              <div className="py-3 text-center text-[11px] text-zinc-400">Ящики не найдены.</div>
            ) : (
              <div className="overflow-x-auto rounded-lg border border-zinc-200 bg-white">
                <table className="w-full min-w-[560px] text-[11px]">
                  <thead>
                    <tr className="border-b border-zinc-100 text-left text-[9px] uppercase tracking-wider text-zinc-400">
                      <th className="px-2.5 py-1.5 font-medium">Ящик</th>
                      <th className="px-2.5 py-1.5 font-medium">Статус</th>
                      <th className="px-2.5 py-1.5 font-medium text-right">Лимит</th>
                      <th className="px-2.5 py-1.5 font-medium text-right">Отпр.</th>
                      <th className="px-2.5 py-1.5 font-medium">Утил.</th>
                      <th className="px-2.5 py-1.5 font-medium text-right">Посл. актив.</th>
                    </tr>
                  </thead>
                  <tbody>
                    {drill.mailboxes.map((mb) => {
                      const idle = mb.statusValue === 1 && mb.sent === 0;
                      const u = mb.dailyLimit > 0 ? mb.sent / mb.dailyLimit : null;
                      return (
                        <tr key={mb.email} className={`border-b border-zinc-50 ${idle ? 'bg-red-50/40' : ''}`}>
                          <td className="px-2.5 py-1.5 font-mono text-[10px] text-zinc-700">{mb.email}</td>
                          <td className="px-2.5 py-1.5">
                            <span className={mb.statusValue === 1 ? 'text-emerald-600' : 'text-zinc-400'}>{mb.status ?? '—'}</span>
                          </td>
                          <td className="px-2.5 py-1.5 text-right tabular-nums text-zinc-600">
                            {mb.dailyLimit}
                            {mb.isDefaultLimit && <span className="text-zinc-300" title="Лимит явно не выставлен — действует дефолт воркспейса"> (дефолт)</span>}
                          </td>
                          <td className="px-2.5 py-1.5 text-right tabular-nums text-zinc-700">{mb.sent}</td>
                          <td className="px-2.5 py-1.5 tabular-nums text-zinc-500">{u == null ? '—' : `${Math.round(u * 100)}%`}</td>
                          <td className="px-2.5 py-1.5 text-right text-zinc-400">{mb.lastUsed ?? '—'}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </td>
        </tr>
      )}
    </>
  );
}

// ── строка специалиста + раскрытие тегов ──────────────────────────────────────
function SpecialistRows({ spec, tags, expanded, onToggle }: {
  spec: SpecialistLoad; tags: TagLoad[]; expanded: boolean; onToggle: () => void;
}) {
  const isUnassigned = spec.specialist === '__unassigned__';
  const name = isUnassigned ? 'Не привязано' : spec.specialist;
  const ownTags = tags.filter((tg) => (tg.specialist ?? '__unassigned__') === spec.specialist);
  return (
    <>
      <tr
        className={`cursor-pointer border-b border-zinc-50 hover:bg-zinc-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-zinc-400 ${isUnassigned ? 'text-zinc-500' : ''}`}
        onClick={onToggle}
        onKeyDown={rowKeyHandler(onToggle)}
        tabIndex={0}
        aria-expanded={expanded}
      >
        <td className="px-3 py-2">
          <div className="flex items-center gap-1.5">
            <span className={`text-zinc-300 transition-transform ${expanded ? 'rotate-90' : ''}`}>›</span>
            <span className={`font-medium ${isUnassigned ? 'text-zinc-500' : 'text-zinc-800'}`}>{name}</span>
            {spec.clients.length > 0 && (
              <span className="text-zinc-400 truncate max-w-[280px]" title={spec.clients.join(', ')}>
                · {spec.clients.slice(0, 3).join(', ')}{spec.clients.length > 3 ? ` +${spec.clients.length - 3}` : ''}
              </span>
            )}
          </div>
        </td>
        <td className="px-3 py-2 text-right tabular-nums text-zinc-600">{spec.tagCount}</td>
        <td className="px-3 py-2 text-right tabular-nums text-zinc-600">{spec.activeMailboxes}</td>
        <td className="px-3 py-2 text-right tabular-nums text-zinc-700">{fmt(spec.capacity)}</td>
        <td className="px-3 py-2 text-right tabular-nums text-zinc-700">{fmt(spec.sent)}</td>
        <td className="px-3 py-2"><UtilBar utilization={spec.utilization} status={spec.status} /></td>
      </tr>
      {expanded && (
        <tr className="bg-zinc-50/60">
          <td colSpan={6} className="px-3 py-2">
            <div className="space-y-1">
              {ownTags.map((tg) => (
                <div key={tg.tagId} className="flex items-center gap-3 rounded-lg bg-white px-3 py-1.5 border border-zinc-100">
                  <span className="w-40 truncate font-medium text-zinc-700">{tg.tag}</span>
                  <span className="tabular-nums text-zinc-400 w-24">{fmt(tg.sent)} / {fmt(tg.capacity)}</span>
                  <div className="flex-1"><UtilBar utilization={tg.utilization} status={tg.status} /></div>
                  <StatusBadge status={tg.status} />
                </div>
              ))}
              <span className="text-[10px] text-zinc-400">Итог специалиста = сумма его тегов (статус: {STATUS_UI[spec.status].label.toLowerCase()}).</span>
            </div>
          </td>
        </tr>
      )}
    </>
  );
}
