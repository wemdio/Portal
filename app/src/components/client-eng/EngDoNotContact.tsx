'use client';

/**
 * «Do not contact» ENG-кабинета (/client/eng/do-not-contact): чёрный список
 * клиента — добавить вставкой, найти, убрать.
 *
 * Хранилище — общий список клиента (`client_blocked_contacts`), его читают
 * фильтры запуска (Launch, «Launch N more markets») — один раз, в начале
 * запуска, — и ночного добора — прямо перед загрузкой (шапка
 * `api/client/blocklist/_eng.ts`). Адрес, добавленный, пока запуск или долив
 * уже идёт, в него ещё может попасть; экран так и говорит.
 * Из уже идущих кампаний людей этот экран НЕ убирает — ни одного вызова
 * рассыльщика за ним нет, — и говорит это клиенту прямо, вместе с тем, что
 * делать, если письма надо остановить сразу (Pause рынка на Outreach).
 *
 * Список берёт только точные адреса (то же правило `normalizeBlockedEmail`,
 * что у фильтров, плюс консервативная форма адреса); сайты, домены и шаблоны
 * роут не добавляет и называет.
 *
 * Список длиннее BLOCKLIST_MAX_ENTRIES (сбой отката, потерянный ответ
 * вставки) читатели не принимают вовсе: запуск отказывает, долив не добавляет
 * никого. Пока так, экран держит об этом постоянную строку с настоящими
 * числами (OverLimitNotice).
 */

import Link from 'next/link';
import type { Route } from 'next';
import { useCallback, useEffect, useRef, useState } from 'react';
import { BLOCKLIST_MAX_ENTRIES } from '@/lib/clientBlocklist/blockedContacts';
import {
  addEngBlockedAddresses,
  fetchEngBlockedList,
  removeEngBlockedAddress,
  type EngBlockedAddResult,
  type EngBlockedAddress,
  type EngBlockedListPage,
  type EngBlockedRejected,
} from './api-client';
import { EngCard, EngEyebrow, EngSpinner, fmtDate } from './ui';

const OUTREACH_PAGE = '/client/eng/dashboard' as Route;

const LOAD_FAILED = 'Could not load your list. Try again in a minute.';
// Читаемого ответа нет (сеть, 502/504 по таймауту или во время деплоя): сделал
// ли сервер своё, неизвестно. После добавления экран сам перечитывает список —
// отсюда «below»; после удаления — нет, отсюда «Refresh this page».
const ADD_NO_ANSWER =
  "We did not get an answer from the server, so we can't tell whether the addresses were added. " +
  'Check your list below.';
const REMOVE_NO_ANSWER =
  "We did not get an answer from the server, so we can't tell whether the address was removed. " +
  'Refresh this page to check.';
const EMPTY_PASTE = 'Paste at least one email address.';

function fmtCount(n: number): string {
  return n.toLocaleString('en-US');
}

function addresses(n: number): string {
  return `${fmtCount(n)} ${n === 1 ? 'address' : 'addresses'}`;
}

/**
 * Текст брошенной ошибки: английская фраза роута или истёкшей сессии (их
 * доводит engApiFetch) — как есть; сетевой отказ fetch (TypeError) и пустое
 * сообщение — `fallback`.
 */
function errorText(e: unknown, fallback: string): string {
  return e instanceof Error && !(e instanceof TypeError) && e.message ? e.message : fallback;
}

/** «a, b and 3 more» — примеры как прислал роут, плюс остаток числом. */
function examplesText(r: EngBlockedRejected): string {
  const rest = r.count - r.examples.length;
  const list = r.examples.join(', ');
  return rest > 0 ? `${list} and ${fmtCount(rest)} more` : list;
}

/** Строки итога добавления; каждая верна для любого сочетания чисел. */
function addResultLines(r: EngBlockedAddResult): string[] {
  const lines: string[] = [];
  if (r.added > 0) lines.push(`Added ${addresses(r.added)} to your list.`);
  if (r.already_listed > 0) {
    lines.push(
      r.already_listed === 1
        ? '1 address was already on your list.'
        : `${fmtCount(r.already_listed)} addresses were already on your list.`,
    );
  }
  if (r.added === 0 && r.already_listed === 0) lines.push('Nothing was added.');
  if (r.domains.count > 0) {
    // В этот класс роут кладёт только токены с явным признаком сайта, домена
    // или шаблона (`@acme.com`, `*@acme.com`, `https://…`, `www.…`, путь) —
    // голое слово с точкой идёт в «not an email address» ниже.
    lines.push(
      'Not added, because only exact email addresses can be added, not websites, whole domains or patterns: ' +
        `${examplesText(r.domains)}.`,
    );
  }
  if (r.invalid.count > 0) {
    lines.push(
      `Not added, because ${r.invalid.count === 1 ? 'this is not an email address' : 'these are not email addresses'}: ` +
        `${examplesText(r.invalid)}.`,
    );
  }
  return lines;
}

type Note = { tone: 'ok' | 'error'; lines: string[] };

function NoteLines({ note }: { note: Note }) {
  return (
    <div className="mt-3 flex flex-col gap-1">
      {note.lines.map((line, i) => (
        <p
          key={i}
          className="text-sm m-0 break-words"
          style={{ color: note.tone === 'error' ? 'var(--cp-red)' : 'var(--cp-paper)' }}
        >
          {line}
        </p>
      ))}
    </div>
  );
}

function HowItWorks() {
  const item = 'text-sm m-0';
  const color = { color: 'var(--cp-text-m)' };
  return (
    <EngCard>
      <EngEyebrow>How it works</EngEyebrow>
      <ul className="m-0 pl-5 flex flex-col gap-2 list-disc">
        {/* Запуск читает список один раз, в начале (launchTemplate, шаг 5a), и
            грузит контакты через минуты; долив — прямо перед загрузкой. Отсюда
            «at that moment» и оговорка про уже идущий запуск или долив. */}
        <li className={item} style={color}>
          We check this list when a launch starts and each time the daily top-up adds new contacts. Anyone on the
          list at that moment is left out. Someone you add while a launch or a top-up is already running may still
          be included in it.
        </li>
        <li className={item} style={color}>
          It matches exact email addresses only. A whole domain, such as company.com, can&apos;t be added.
        </li>
        <li className={item} style={color}>
          Adding someone here does not take them out of a campaign they are already in. If they were added to a
          campaign before, they keep getting its remaining emails until the sequence ends or they reply.
        </li>
        <li className={item} style={color}>
          If emails to someone must stop right away, open{' '}
          <Link href={OUTREACH_PAGE} prefetch={false} className="underline">
            Outreach
          </Link>{' '}
          and press «Pause» on the market they are in, or on every market if you are not sure. Nothing is sent from
          a paused market, but their remaining emails go out once you press «Resume».
        </li>
      </ul>
    </EngCard>
  );
}

/**
 * Список длиннее потолка: getBlockedEmailSet бросает на count > потолка, и тогда
 * запуск отказывает на шаге 5a (до первой загрузки контактов), а долив падает
 * на шаге 4 и в appendLeads — новых контактов в кампаниях нет, пока список не
 * укоротят. Уже загруженным получателям кампании пишут дальше — эта строка
 * этого и не утверждает. Числа — из `total` списка (точный счёт роута).
 */
function OverLimitNotice({ total }: { total: number }) {
  return (
    <EngCard>
      <p className="text-sm m-0" style={{ color: 'var(--cp-red)' }}>
        Your list holds {addresses(total)}, more than the {fmtCount(BLOCKLIST_MAX_ENTRIES)} it can hold. Until you
        remove at least {fmtCount(total - BLOCKLIST_MAX_ENTRIES)}, no new contacts are added to your campaigns: a
        launch stops with an error before adding anyone, and the daily top-up adds no one.
      </p>
    </EngCard>
  );
}

function AddAddresses({ onAdded }: { onAdded: () => void }) {
  const [text, setText] = useState('');
  const [adding, setAdding] = useState(false);
  const [note, setNote] = useState<Note | null>(null);

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (adding) return;
    if (!text.trim()) {
      setNote({ tone: 'error', lines: [EMPTY_PASTE] });
      return;
    }
    setAdding(true);
    setNote(null);
    try {
      const outcome = await addEngBlockedAddresses(text);
      if (outcome.ok) {
        const r = outcome.result;
        setNote({ tone: r.added > 0 || r.already_listed > 0 ? 'ok' : 'error', lines: addResultLines(r) });
        // Всё принято — поле пустеет; что-то не добавлено — текст остаётся,
        // чтобы клиент поправил именно его.
        if (r.domains.count === 0 && r.invalid.count === 0) setText('');
        if (r.added > 0) onAdded();
      } else {
        // error: null — читаемого ответа не было (502/504 и т. п.), исход
        // неизвестен; reload тогда true, и список перечитывается.
        setNote({ tone: 'error', lines: [outcome.error ?? ADD_NO_ANSWER] });
        if (outcome.reload) onAdded();
      }
    } catch (err) {
      setNote({ tone: 'error', lines: [errorText(err, ADD_NO_ANSWER)] });
      onAdded();
    } finally {
      setAdding(false);
    }
  };

  return (
    <EngCard>
      <EngEyebrow>Add addresses</EngEyebrow>
      <form onSubmit={(e) => void onSubmit(e)} className="flex flex-col gap-2">
        <label className="flex flex-col gap-1">
          <span className="text-[11px] font-semibold" style={{ color: 'var(--cp-text-m)' }}>
            Email addresses
          </span>
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            rows={5}
            placeholder={'jane@company.com\njohn@company.com'}
            className="ds-input w-full resize-y"
            spellCheck={false}
          />
        </label>
        <p className="text-[11px] m-0" style={{ color: 'var(--cp-text-l)' }}>
          Paste one or more addresses: one per line, or separated by commas or spaces. Up to 1,000 at a time; the
          list holds up to 10,000.
        </p>
        <div>
          <button
            type="submit"
            disabled={adding}
            className="ds-btn-primary inline-flex items-center gap-1.5 text-xs disabled:opacity-50"
          >
            {adding && <EngSpinner />}
            {adding ? 'Adding…' : 'Add to list'}
          </button>
        </div>
      </form>
      {note && <NoteLines note={note} />}
    </EngCard>
  );
}

function AddressRow({
  entry,
  onRemoved,
}: {
  entry: EngBlockedAddress;
  onRemoved: (entry: EngBlockedAddress, removed: number) => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const remove = async () => {
    if (removing) return;
    setRemoving(true);
    setError(null);
    try {
      const outcome = await removeEngBlockedAddress(entry.id);
      if (outcome.ok) {
        onRemoved(entry, outcome.removed);
      } else {
        setError(outcome.error ?? REMOVE_NO_ANSWER);
        setRemoving(false);
      }
    } catch (err) {
      setError(errorText(err, REMOVE_NO_ANSWER));
      setRemoving(false);
    }
  };

  return (
    <li className="py-2.5 border-b last:border-b-0" style={{ borderColor: 'var(--cp-divider)' }}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="ds-mono text-sm break-all" style={{ color: 'var(--cp-paper)' }}>
          {entry.email}
        </span>
        <span className="text-xs" style={{ color: 'var(--cp-paper-mute)' }}>
          Added {fmtDate(entry.created_at)}
        </span>
        <span className="ml-auto flex items-center gap-2">
          {confirming ? (
            <>
              <span className="text-xs" style={{ color: 'var(--cp-text-m)' }}>
                Remove from your list?
              </span>
              <button
                type="button"
                onClick={() => void remove()}
                disabled={removing}
                className="ds-btn-secondary inline-flex items-center gap-1.5 text-[11px] disabled:opacity-50"
              >
                {removing && <EngSpinner />}
                {removing ? 'Removing…' : 'Remove'}
              </button>
              <button
                type="button"
                onClick={() => {
                  setConfirming(false);
                  setError(null);
                }}
                disabled={removing}
                className="ds-btn-ghost inline-flex items-center gap-1.5 text-[11px] disabled:opacity-50"
              >
                Keep
              </button>
            </>
          ) : (
            <button
              type="button"
              onClick={() => setConfirming(true)}
              className="ds-btn-ghost inline-flex items-center gap-1.5 text-[11px]"
            >
              Remove
            </button>
          )}
        </span>
      </div>
      {error && (
        <p className="mt-1 text-xs m-0" style={{ color: 'var(--cp-red)' }}>
          {error}
        </p>
      )}
    </li>
  );
}

export function EngDoNotContact() {
  const [list, setList] = useState<EngBlockedListPage | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [moreError, setMoreError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [query, setQuery] = useState('');
  const [removedNote, setRemovedNote] = useState<string | null>(null);

  // Перечитать первую страницу: смена поиска или `reloads`. Состояние меняется
  // только по ответу, и ответ устаревшего запроса (поиск сменился) отбрасывается.
  const [reloads, setReloads] = useState(0);
  const queryRef = useRef(query);
  useEffect(() => {
    queryRef.current = query;
  }, [query]);
  useEffect(() => {
    let cancelled = false;
    fetchEngBlockedList({ q: query }).then(
      (page) => {
        if (cancelled) return;
        setList(page);
        setLoadError(null);
        setMoreError(null);
        setLoading(false);
      },
      (err: unknown) => {
        if (cancelled) return;
        setLoadError(errorText(err, LOAD_FAILED));
        setLoading(false);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [query, reloads]);

  const reload = useCallback(() => {
    setLoading(true);
    setReloads((n) => n + 1);
  }, []);

  const loadMore = async () => {
    if (!list || list.next_offset === null || loadingMore) return;
    setLoadingMore(true);
    setMoreError(null);
    const q = query;
    try {
      const page = await fetchEngBlockedList({ offset: list.next_offset, q });
      // Пока страница шла, клиент сменил поиск — она уже не про этот список.
      if (queryRef.current !== q) return;
      setList((prev) => {
        if (!prev) return page;
        const seen = new Set(prev.items.map((r) => r.id));
        return { ...page, items: [...prev.items, ...page.items.filter((r) => !seen.has(r.id))] };
      });
    } catch (err) {
      setMoreError(errorText(err, LOAD_FAILED));
    } finally {
      setLoadingMore(false);
    }
  };

  const onRemoved = (entry: EngBlockedAddress, removed: number) => {
    if (removed === 0) {
      // Строки уже нет (другая вкладка) — список перечитывается целиком.
      setRemovedNote(`${entry.email} was already removed from your list.`);
      reload();
      return;
    }
    setRemovedNote(`Removed ${entry.email}. From now on, it can be included again when we add contacts to your campaigns.`);
    // Свежие сверху: удалённая строка стояла до следующей страницы, поэтому
    // её граница сдвигается на одну строку вверх.
    setList((prev) =>
      prev
        ? {
            ...prev,
            items: prev.items.filter((r) => r.id !== entry.id),
            total: Math.max(0, prev.total - 1),
            matching: Math.max(0, prev.matching - 1),
            next_offset: prev.next_offset === null ? null : Math.max(0, prev.next_offset - 1),
          }
        : prev,
    );
  };

  const onSearch = (e: React.FormEvent) => {
    e.preventDefault();
    setRemovedNote(null);
    const next = search.trim();
    if (next === query) {
      reload();
      return;
    }
    setLoading(true);
    setQuery(next);
  };

  let content: React.ReactNode;
  if (loading && !list) {
    content = (
      <div className="flex items-center gap-2 text-sm" style={{ color: 'var(--cp-paper-mute)' }}>
        <EngSpinner /> Loading your list…
      </div>
    );
  } else if (!list) {
    content = (
      <div>
        <p className="text-sm m-0" style={{ color: 'var(--cp-red)' }}>{loadError ?? LOAD_FAILED}</p>
        <button
          type="button"
          onClick={reload}
          disabled={loading}
          className="ds-btn-ghost mt-3 disabled:opacity-50"
        >
          Try again
        </button>
      </div>
    );
  } else if (list.total === 0) {
    content = (
      <p className="text-sm m-0" style={{ color: 'var(--cp-paper-mute)' }}>
        Your list is empty.
      </p>
    );
  } else if (list.matching === 0) {
    content = (
      <p className="text-sm m-0 break-words" style={{ color: 'var(--cp-paper-mute)' }}>
        No address on your list contains “{query}”.
      </p>
    );
  } else {
    content = (
      <>
        <ul className="m-0 p-0 list-none">
          {list.items.map((entry) => (
            <AddressRow key={entry.id} entry={entry} onRemoved={onRemoved} />
          ))}
        </ul>
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <span className="text-xs" style={{ color: 'var(--cp-paper-mute)' }}>
            Showing {fmtCount(list.items.length)} of {fmtCount(list.matching)}.
          </span>
          {list.next_offset !== null && (
            <button
              type="button"
              onClick={() => void loadMore()}
              disabled={loadingMore}
              className="ds-btn-ghost inline-flex items-center gap-1.5 disabled:opacity-50"
            >
              {loadingMore ? 'Loading…' : 'Show more'}
            </button>
          )}
        </div>
        {moreError && (
          <p className="mt-2 text-sm m-0" style={{ color: 'var(--cp-red)' }}>{moreError}</p>
        )}
      </>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <header className="mb-2 sm:mb-4">
        <h1 className="text-xl sm:text-2xl font-bold m-0" style={{ color: 'var(--cp-paper)' }}>
          Do not contact
        </h1>
        <p className="mt-1 text-sm m-0" style={{ color: 'var(--cp-paper-mute)' }}>
          Your blocked-contacts list. We check it before we add new contacts to your campaigns and leave these
          addresses out.
        </p>
      </header>

      {list && list.total > BLOCKLIST_MAX_ENTRIES && <OverLimitNotice total={list.total} />}

      <HowItWorks />

      <AddAddresses onAdded={reload} />

      <EngCard>
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <EngEyebrow>On your list</EngEyebrow>
          {list && list.total > 0 && (
            <span className="text-xs" style={{ color: 'var(--cp-paper-mute)' }}>
              {addresses(list.total)}
            </span>
          )}
          {loading && list && <EngSpinner />}
        </div>
        {list && list.total > 0 && (
          <form onSubmit={onSearch} className="mb-3 flex flex-wrap items-center gap-2">
            <input
              type="search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search addresses"
              className="ds-input text-xs flex-1 min-w-[12rem]"
              spellCheck={false}
            />
            <button type="submit" className="ds-btn-secondary inline-flex items-center gap-1.5 text-xs">
              Search
            </button>
            {query && (
              <button
                type="button"
                onClick={() => {
                  setSearch('');
                  setLoading(true);
                  setQuery('');
                }}
                className="ds-btn-ghost inline-flex items-center gap-1.5 text-xs"
              >
                Clear search
              </button>
            )}
          </form>
        )}
        {removedNote && (
          <p className="mb-3 text-sm m-0 break-words" style={{ color: 'var(--cp-paper)' }}>{removedNote}</p>
        )}
        {list && loadError && (
          <p className="mb-3 text-sm m-0" style={{ color: 'var(--cp-red)' }}>{loadError}</p>
        )}
        {content}
      </EngCard>
    </div>
  );
}
