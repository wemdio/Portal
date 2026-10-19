'use client';

import { useCallback, useEffect, useState } from 'react';
import { authFetch } from '@/lib/authFetch';
import { logError } from '@/lib/loggerClient';
import OutcomesDashboard from '@/components/mailbox-load/OutcomesDashboard';
import BouncesBreakdown, { type Breakdown } from '@/components/mailbox-load/BouncesBreakdown';
import type { MailboxOutcomes } from '@/lib/instantly/mailboxOutcomes';
import type {
  MailboxLoad, TagLoad, SpecialistLoad, MailboxRow, TagStatus, InactiveTag, InactiveReason,
} from '@/lib/instantly/mailboxLoad';
import {
  sortTags, sortSpecialists, nextSort,
  type SortState, type TagSortKey, type SpecialistSortKey,
} from '@/lib/instantly/mailboxLoadSort';
import { PortalSpinner } from '@/components/PortalSpinner';

// ── визуальные пресеты статусов утилизации ────────────────────────────────────
// Пороги и статус считает ТОЛЬКО сервер (classify в mailboxLoad.ts) — здесь
// исключительно отображение, чтобы правка порогов не расходилась по слоям.
//
// Тихая палитра: цветом выделяем ТОЛЬКО отклонения (простой/недогруз — тёплый,
// перебор — фиолетовый). «Норма»/«Потолок» и технические статусы — нейтральный
// серый, чтобы взгляд цеплялся за проблемы, а не за весь экран.
// accent=true → отклонение (цветная пилюля + цветная полоса); false → тихий серый.
const STATUS_UI: Record<TagStatus, { label: string; badge: string; bar: string; num: string; accent: boolean }> = {
  idle: { label: 'Простой', badge: 'bg-red-50 text-red-700 border-red-200', bar: 'bg-red-400', num: 'text-red-600', accent: true },
  low: { label: 'Недогруз', badge: 'bg-amber-50 text-amber-700 border-amber-200', bar: 'bg-amber-500', num: 'text-amber-600', accent: true },
  over: { label: 'Перебор', badge: 'bg-violet-50 text-violet-700 border-violet-200', bar: 'bg-violet-400', num: 'text-violet-600', accent: true },
  ok: { label: 'Норма', badge: 'text-zinc-400', bar: 'bg-zinc-300', num: 'text-zinc-600', accent: false },
  full: { label: 'Потолок', badge: 'text-zinc-400', bar: 'bg-zinc-400', num: 'text-zinc-600', accent: false },
  stopped: { label: 'Выключены', badge: 'text-zinc-400', bar: 'bg-zinc-200', num: 'text-zinc-400', accent: false },
  no_capacity: { label: '—', badge: 'text-zinc-300', bar: 'bg-zinc-200', num: 'text-zinc-400', accent: false },
};

/**
 * Кликабельный заголовок столбца.
 *
 * Стрелка рисуется только у активного столбца: постоянные значки у всех семи
 * заголовков — шум, из которого не видно, по чему таблица отсортирована
 * сейчас.
 */
function SortTh<K extends string>({
  label, sortKey, sort, onSort, align = 'left',
}: {
  label: string;
  sortKey: K;
  sort: SortState<K> | null;
  onSort: (key: K) => void;
  align?: 'left' | 'right';
}) {
  const active = sort?.key === sortKey;
  return (
    <th className={`px-3 py-2 font-medium ${align === 'right' ? 'text-right' : ''}`}>
      <button
        type="button"
        onClick={() => onSort(sortKey)}
        title={`Сортировать по «${label}»`}
        className={`inline-flex items-center gap-1 uppercase tracking-wider transition hover:text-zinc-700 cursor-pointer ${
          active ? 'text-zinc-700' : ''
        }`}
      >
        {label}
        <span className={`text-[9px] ${active ? 'opacity-100' : 'opacity-0'}`} aria-hidden>
          {sort?.dir === 'asc' ? '▲' : '▼'}
        </span>
      </button>
    </th>
  );
}

const fmt = (n: number) => n.toLocaleString('ru-RU');
const pct = (u: number | null) => (u == null ? '—' : `${Math.round(u * 100)}%`);

// 'YYYY-MM-DD' → «пт, 9 октября». День недели обязателен: без него «данные
// за 11.10» не говорили, что это воскресенье и простой в нём ожидаем.
const dayLabel = (d: string) =>
  new Date(`${d}T00:00:00Z`).toLocaleDateString('ru-RU', { weekday: 'short', day: 'numeric', month: 'long', timeZone: 'UTC' });

function plural(n: number, one: string, few: string, many: string): string {
  const m10 = n % 10;
  const m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
  return many;
}

const REASON_LABEL: Record<InactiveReason, string> = {
  project_done: 'Проект завершён',
  no_recent_activity: 'Свои кампании не шлют неделю',
  // не «кампаний не было»: ящики тега могли слать через другой тег
  no_campaigns: 'Нет своих кампаний',
  not_launched: 'Клиент ещё не запущен',
};

function reasonLabel(tag: InactiveTag): string {
  if (tag.reason === 'project_done' && tag.projectStatus?.toLowerCase().startsWith('отмен')) return 'Проект отменён';
  if (tag.reason === 'not_launched' && /колди|тригга/i.test(tag.workFormat ?? '')) return 'Ведётся вне Instantly';
  return REASON_LABEL[tag.reason];
}

// уточнение причины: проект, найденный по имени тега (ещё не запускали или
// ведут в Coldy), — его статус и формат работы
function reasonDetail(tag: InactiveTag): string | null {
  if (!tag.matchedByName) return null;
  return [tag.projectStatus, tag.workFormat].filter(Boolean).join(' · ') || null;
}

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
      <span className={`tabular-nums text-[11px] font-semibold w-9 text-right ${ui.num}`}>
        {pct(utilization)}
      </span>
    </div>
  );
}

// Бейдж только для отклонений — цветная пилюля. Здоровые/технические статусы —
// тихий серый текст без рамки, чтобы не зашумлять таблицу.
function StatusBadge({ status }: { status: TagStatus }) {
  const ui = STATUS_UI[status];
  if (!ui.accent) return <span className={`text-[10px] font-medium ${ui.badge}`}>{ui.label}</span>;
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

// day — за какой день загружены ящики: защита от гонки (drill, стартовавший до
// смены дня, доезжает после очистки кэша и не должен выдаваться за новый день)
type DrillState = { loading: boolean; error: boolean; day: string; tag: string | null; mailboxes: MailboxRow[] } | undefined;

/** Побочный блок страницы: сбой возвращается значением, а не исключением. */
async function loadSide<T>(url: string): Promise<{ data: T | null; error: string | null }> {
  try {
    const res = await authFetch(url);
    const body = (await res.json().catch(() => null)) as { data?: T | null; error?: string; detail?: string } | null;
    if (!res.ok || !body?.data) {
      const code = body?.error || `HTTP ${res.status}`;
      return { data: null, error: body?.detail ? `${code} — ${body.detail}` : code };
    }
    return { data: body.data, error: null };
  } catch (e) {
    logError('mailbox-load side block failed', e);
    return { data: null, error: (e as Error).message };
  }
}

export default function MailboxLoadPage() {
  const [data, setData] = useState<MailboxLoad | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // Исходы и отбои грузятся вместе с таблицей и показываются с ней одновременно.
  const [outcomes, setOutcomes] = useState<{ data: MailboxOutcomes | null; error: string | null }>({ data: null, error: null });
  const [bounces, setBounces] = useState<{ data: Breakdown | null; error: string | null }>({ data: null, error: null });
  const [day, setDay] = useState<string>(''); // '' = авто (последний полный день)
  const [reloadKey, setReloadKey] = useState(0); // кнопка «Обновить»
  const [view, setView] = useState<'tags' | 'specialists'>('tags');
  const [expanded, setExpanded] = useState<string | null>(null); // tagId
  const [drill, setDrill] = useState<Record<string, DrillState>>({});
  /**
   * Сортировка у каждой вкладки своя: столбцы разные, и переключение «по
   * тегам ↔ по специалистам» не должно ронять выбранный порядок соседней.
   * null — порядок сервера (по потолку), он же вид по умолчанию.
   */
  const [tagSort, setTagSort] = useState<SortState<TagSortKey> | null>(null);
  const [specSort, setSpecSort] = useState<SortState<SpecialistSortKey> | null>(null);
  const [expandedSpec, setExpandedSpec] = useState<string | null>(null);
  // Блок «Не в работе» свёрнут: это справка о свободных ящиках, а не то, ради
  // чего открывают страницу.
  const [showInactive, setShowInactive] = useState(false);

  // Фетч в эффекте, ключ = выбранный день + reloadKey. Инлайн-async + setState ПОСЛЕ
  // await + флаг active — идиома дома (без cascading-render варнинга). Спиннер на старте
  // даёт initial loading=true; при смене дня/обновлении loading ставят обработчики.
  useEffect(() => {
    let active = true;
    const run = async () => {
      try {
        const qs = day ? `?day=${encodeURIComponent(day)}` : '';
        // Все три запроса уходят сразу: страница отрисовывается целиком, а не
        // «таблица, потом внизу догружается дашборд». Исходы и отбои не роняют
        // страницу — у каждого своя ошибка. Каждый сам определяет «последний
        // полный день», когда день не выбран.
        const [res, outcomesRes, bouncesRes] = await Promise.all([
          authFetch(`/api/analytics/mailbox-load${qs}`),
          loadSide<MailboxOutcomes>(`/api/analytics/mailbox-load/outcomes${qs}`),
          loadSide<Breakdown>(`/api/analytics/mailbox-load/bounces${qs}`),
        ]);
        if (!active) return;
        if (!res.ok) {
          // тело несёт код причины (dataset_not_configured / build_failed /
          // role_check_failed) и, для build_failed, текст самой ошибки. Код без
          // текста отвечал на вопрос «что-то сломалось», но не на «что именно»,
          // и разбор начинался с похода в логи сервера.
          const body = (await res.json().catch(() => null)) as { error?: string; detail?: string } | null;
          const code = body?.error || `HTTP ${res.status}`;
          throw new Error(body?.detail ? `${code} — ${body.detail}` : code);
        }
        const json = (await res.json()) as { data: MailboxLoad | null; error?: string };
        if (!active) return;
        if (!json.data) throw new Error(json.error || 'Нет данных');
        setError(null);
        setData(json.data);
        setOutcomes(outcomesRes);
        setBounces(bouncesRes);
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
          // Раскрытие тега показывает лишь «не удалось», поэтому причина обязана
          // хотя бы доехать до клиентского лога — иначе её негде взять.
          const body = (await res.json().catch(() => null)) as { error?: string; detail?: string } | null;
          const code = body?.error || `HTTP ${res.status}`;
          throw new Error(body?.detail ? `${code} — ${body.detail}` : code);
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

  // Клик по заголовку. Разворачивать раскрытую строку не нужно: она привязана
  // к id, а не к позиции, и переживает пересортировку.
  const onTagSort = useCallback((key: TagSortKey) => {
    setTagSort((cur) => nextSort(cur, key));
  }, []);
  const onSpecSort = useCallback((key: SpecialistSortKey) => {
    setSpecSort((cur) => nextSort(cur, key));
  }, []);

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

      {/* Плашка свежести (скрыта при ошибке — иначе рядом с ошибкой висят старые
          цифры). Жёлтая всегда: за какой день таблица и когда был синк — не
          украшение, а условие, при котором её вообще можно читать; серым это
          терялось между шапкой и плитками.

          Рамка по содержимому (`w-fit`), а не во всю страницу: пустая полоса до
          правого края читается как отдельный блок, хотя внутри две короткие
          строки. Именно `flex w-fit`, а не `inline-flex`: контейнер страницы
          разносит блоки через `space-y`, то есть `margin-top` — а на строчном
          элементе он не работает, и плашка слиплась бы с шапкой.

          Устаревший синк уходит в красное — раньше он был единственным жёлтым
          на экране, и с пожелтевшей нормой предупреждение перестало бы
          отличаться от обычного состояния. */}
      {data && !error && (
        <div className={`flex w-fit max-w-full flex-wrap items-center gap-x-4 gap-y-1 rounded-lg border px-3 py-2 text-[11px] ${
          data.stale
            ? 'border-red-300 bg-red-50 text-red-800'
            : 'border-amber-300 bg-amber-50 text-amber-900'
        }`}>
          <span>
            Данные за <b className={data.stale ? 'text-red-900' : 'text-amber-950'}>{data.asOfDay ? dayLabel(data.asOfDay) : '—'}</b> (UTC-день)
          </span>
          {data.lastSync && <span>Последний синк: {new Date(data.lastSync).toLocaleString('ru-RU')}</span>}
          {data.stale && <span className="font-semibold">⚠️ Синк устарел — цифры могут быть неактуальны</span>}
          {/* Выходные пропущены автоматически — называем их, а не прячем:
              иначе в понедельник непонятно, почему таблица за пятницу. */}
          {data.skippedDays.length > 0 && (
            <span className="basis-full">
              {data.skippedDays.map(dayLabel).join(' и ')} — {data.skippedDays.length === 1 ? 'выходной' : 'выходные'} по
              расписанию кампаний, показан последний рабочий день. Выходной можно выбрать в поле «День».
            </span>
          )}
          {!data.isSendingDay && (
            <span className="basis-full font-semibold">
              Выходной по расписанию кампаний: большинство из них в этот день не шлёт, простой ожидаем.
            </span>
          )}
        </div>
      )}

      {/* summary */}
      {t && data && (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
          <SummaryTile label="Потолок / день" value={fmt(t.capacity)} sub="Σ лимитов активных ящиков" />
          <SummaryTile label="Отправлено" value={fmt(t.sent)} sub="писем за день, все ящики" />
          <SummaryTile label="Утилизация" value={pct(t.utilization)} sub="факт / потолок" />
          <SummaryTile label="Активных ящиков" value={fmt(t.activeMailboxes)} sub="под тегами в работе" />
          <SummaryTile
            label="Не в работе"
            value={fmt(data.inactiveTotals.activeMailboxes)}
            sub={`свободных активных ящиков, потолок ${fmt(data.inactiveTotals.capacity)}`}
          />
        </div>
      )}

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

      {loading && <div className="flex justify-center py-10"><PortalSpinner /></div>}
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
                <SortTh label="Тег / клиент" sortKey="tag" sort={tagSort} onSort={onTagSort} />
                <SortTh label="Специалист" sortKey="specialist" sort={tagSort} onSort={onTagSort} />
                <SortTh label="Ящиков" sortKey="mailboxes" sort={tagSort} onSort={onTagSort} align="right" />
                <SortTh label="Потолок" sortKey="capacity" sort={tagSort} onSort={onTagSort} align="right" />
                <SortTh label="Отправлено" sortKey="sent" sort={tagSort} onSort={onTagSort} align="right" />
                <SortTh label="Утилизация" sortKey="utilization" sort={tagSort} onSort={onTagSort} />
                <SortTh label="Статус" sortKey="status" sort={tagSort} onSort={onTagSort} />
              </tr>
            </thead>
            <tbody>
              {sortTags(data.tags, tagSort).map((tag) => (
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
                <SortTh label="Специалист" sortKey="specialist" sort={specSort} onSort={onSpecSort} />
                <SortTh label="Тегов" sortKey="tagCount" sort={specSort} onSort={onSpecSort} align="right" />
                <SortTh label="Активных ящиков" sortKey="mailboxes" sort={specSort} onSort={onSpecSort} align="right" />
                <SortTh label="Потолок" sortKey="capacity" sort={specSort} onSort={onSpecSort} align="right" />
                <SortTh label="Отправлено" sortKey="sent" sort={specSort} onSort={onSpecSort} align="right" />
                <SortTh label="Утилизация" sortKey="utilization" sort={specSort} onSort={onSpecSort} />
              </tr>
            </thead>
            <tbody>
              {sortSpecialists(data.specialists, specSort).map((s) => (
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

      {/* ── НЕ В РАБОТЕ ── теги, ящики которых никто не использует: проект
          завершён, кампании давно встали или их не было. Вне основной таблицы
          и итогов — их простой означает свободные ящики, а не недогруз клиента. */}
      {!loading && !error && data && data.inactiveTags.length > 0 && (
        <div className="rounded-xl border border-zinc-200 bg-white">
          <button
            type="button"
            onClick={() => setShowInactive((v) => !v)}
            aria-expanded={showInactive}
            className="flex w-full flex-wrap items-center gap-x-2 gap-y-0.5 rounded-xl px-3 py-2.5 text-left text-xs hover:bg-zinc-50"
          >
            <span className={`text-zinc-300 transition-transform ${showInactive ? 'rotate-90' : ''}`}>›</span>
            <span className="font-medium text-zinc-800">Не в работе</span>
            <span className="text-zinc-400">
              {data.inactiveTotals.tagCount} {plural(data.inactiveTotals.tagCount, 'тег', 'тега', 'тегов')}
              {' · '}{fmt(data.inactiveTotals.activeMailboxes)} {plural(data.inactiveTotals.activeMailboxes, 'свободный активный ящик', 'свободных активных ящика', 'свободных активных ящиков')}
              {' · '}потолок {fmt(data.inactiveTotals.capacity)} в день
            </span>
          </button>
          {showInactive && (
            <div className="overflow-x-auto border-t border-zinc-100">
              <table className="w-full min-w-[720px] text-xs">
                <thead>
                  <tr className="border-b border-zinc-100 text-left text-[10px] uppercase tracking-wider text-zinc-400">
                    <th className="px-3 py-2 font-medium">Тег / последний клиент</th>
                    <th className="px-3 py-2 font-medium">Специалист</th>
                    <th className="px-3 py-2 font-medium text-right">Свободно ящиков</th>
                    <th className="px-3 py-2 font-medium text-right">Потолок</th>
                    <th className="px-3 py-2 font-medium text-right">Посл. кампания</th>
                    <th className="px-3 py-2 font-medium">Почему</th>
                  </tr>
                </thead>
                <tbody>
                  {data.inactiveTags.map((tag) => (
                    <InactiveRows
                      key={tag.tagId}
                      tag={tag}
                      expanded={expanded === tag.tagId}
                      drill={drill[tag.tagId]}
                      onToggle={() => void toggleTag(tag.tagId)}
                    />
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {/* notes */}
      {data && !error && data.notes.length > 0 && (
        <ul className="space-y-1 text-[11px] text-zinc-400">
          {data.notes.map((n, i) => <li key={i}>• {n}</li>)}
        </ul>
      )}

      {/* Исходы отправок — внизу страницы; грузятся вместе с таблицей, а их сбой
          не роняет страницу. */}
      {!loading && !error && data?.asOfDay && (
        <div className="border-t border-zinc-200 pt-5">
          <OutcomesDashboard data={outcomes.data} error={outcomes.error} />
          <div className="mt-5">
            <BouncesBreakdown data={bounces.data} error={bounces.error} />
          </div>
        </div>
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
  return (
    <>
      <tr
        className="cursor-pointer border-b border-zinc-50 hover:bg-zinc-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-zinc-400"
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
            {tag.matchedByName && tag.unlinkedCampaign && (
              <span className="text-zinc-300" title={`Кампания не привязана к проекту в портале: ${tag.unlinkedCampaign}. Проект найден по имени тега.`}>
                · кампания без проекта
              </span>
            )}
            {tag.otherClients.length > 0 && (
              <span className="text-zinc-300" title={`Ящики тега делят: ${tag.otherClients.join(', ')}`}>
                +{tag.otherClients.length}
              </span>
            )}
            {!tag.client && tag.unlinkedCampaign && (
              <span className="text-zinc-300" title={`Кампания не привязана к проекту в портале: ${tag.unlinkedCampaign}`}>
                · без проекта
              </span>
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
          <td colSpan={7} className="px-3 py-2"><MailboxDrill drill={drill} /></td>
        </tr>
      )}
    </>
  );
}

// ── ящики тега за день (раскрытие строки) ────────────────────────────────────
function MailboxDrill({ drill }: { drill: DrillState }) {
  if (!drill || drill.loading) {
    return <div className="py-3 text-center text-[11px] text-zinc-400">Загрузка ящиков…</div>;
  }
  if (drill.error) {
    return (
      <div className="py-3 text-center text-[11px] text-red-600">
        Не удалось загрузить ящики. Кликните по строке ещё раз, чтобы повторить.
      </div>
    );
  }
  if (drill.mailboxes.length === 0) {
    return <div className="py-3 text-center text-[11px] text-zinc-400">Ящики не найдены.</div>;
  }
  return (
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
  );
}

// ── строка тега «не в работе» + те же ящики ──────────────────────────────────
function InactiveRows({ tag, expanded, drill, onToggle }: {
  tag: InactiveTag; expanded: boolean; drill: DrillState; onToggle: () => void;
}) {
  return (
    <>
      <tr
        className="cursor-pointer border-b border-zinc-50 text-zinc-500 hover:bg-zinc-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-zinc-400"
        onClick={onToggle}
        onKeyDown={rowKeyHandler(onToggle)}
        tabIndex={0}
        aria-expanded={expanded}
      >
        <td className="px-3 py-2">
          <div className="flex items-center gap-1.5">
            <span className={`text-zinc-300 transition-transform ${expanded ? 'rotate-90' : ''}`}>›</span>
            <span className="font-medium text-zinc-700">{tag.tag}</span>
            {tag.client && norm(tag.client) !== norm(tag.tag) && (
              <span className="text-zinc-400">· {tag.client}</span>
            )}
          </div>
        </td>
        <td className="px-3 py-2">{tag.specialist ?? <span className="text-zinc-300">—</span>}</td>
        <td className="px-3 py-2 text-right tabular-nums">
          {tag.activeMailboxes}
          {tag.totalMailboxes !== tag.activeMailboxes && <span className="text-zinc-300">/{tag.totalMailboxes}</span>}
          {/* занятые ящики не свободны: тег не потерялся, его ящики работают
              под другим тегом (посчитаны в таблице выше) или закреплены за
              клиентом, которого ещё не запустили */}
          {tag.busyElsewhere > 0 && (
            <div className="text-[10px] text-zinc-400">ещё {tag.busyElsewhere} заняты другими тегами</div>
          )}
          {tag.reason === 'not_launched' && tag.activeMailboxes > 0 && (
            <div className="text-[10px] text-zinc-400">закреплены за клиентом, в свободные не входят</div>
          )}
        </td>
        <td className="px-3 py-2 text-right tabular-nums">{fmt(tag.capacity)}</td>
        <td className="px-3 py-2 text-right tabular-nums text-zinc-400">{tag.lastCampaignDay ?? '—'}</td>
        <td className="px-3 py-2 text-[11px]">
          {reasonLabel(tag)}
          {reasonDetail(tag) && <div className="text-[10px] text-zinc-400">проект: {reasonDetail(tag)}</div>}
        </td>
      </tr>
      {expanded && (
        <tr className="bg-zinc-50/60">
          <td colSpan={6} className="px-3 py-2"><MailboxDrill drill={drill} /></td>
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
              <span className="text-[10px] text-zinc-400">Итог специалиста — по уникальным ящикам его тегов: ящик под двумя тегами считается один раз (статус: {STATUS_UI[spec.status].label.toLowerCase()}).</span>
            </div>
          </td>
        </tr>
      )}
    </>
  );
}
