'use client';

/**
 * /client/eng/replies — ответы на кампании ENG-клиента: свежие сверху, «Show
 * older replies» дочитывает следующую страницу. Сами ответы — только чтение;
 * единственное действие на карточке — «Block» (см. ниже).
 *
 * Данные — GET /api/client/eng/replies (источник и его границы — шапка
 * lib/hypothesisEngine/engReplies.ts). Текст ответа приходит ПРОСТЫМ ТЕКСТОМ и
 * рисуется текстовым узлом React — HTML письма в браузер не попадает вовсе.
 * Обещания «ответ появится через N минут» на экране нет: доставку уведомлений
 * о новых ответах мы не контролируем.
 *
 * «BLOCK» — как «В чёрный список» RU-экрана (app/client/replies, handleBlock):
 * одно нажатие кладёт адрес в «Do not contact» клиента — POST
 * /api/client/blocklist, ENG-ветка (`{ text }`, она читает только текст и
 * пишет source 'manual'), без подтверждения; отмена — «Remove from Do not
 * contact» (поиск строки по точному адресу + DELETE /blocklist/[id]). Что
 * сказать про кампании — по полям `removal` и `removal_campaigns` ответа,
 * теми же словами, что и страница «Do not contact» (EngDoNotContact:
 * engDncBlockLines). Первая фраза итога во всех режимах — «эта кампания ему
 * больше не пишет»: каждая кампания кабинета создаётся с stop on reply
 * (engSendingPreset.HE_ENG_POOL_CAMPAIGN_SETTINGS; пресет клиента держит то
 * же), а карточка есть только у ответа, который рассыльщик привязал к этой
 * кампании (событие reply_received). Совет нажать Pause — только для кампании
 * ДРУГОГО рынка и только при выключенном снятии.
 *
 * Скоуп: адрес берётся из ответа на кампанию самого клиента (роут Replies
 * отбирает кампании по владельцу), а POST кладёт его только в список
 * вошедшего клиента (userId сессии в роуте) — чужой список и чужие кампании
 * не задеваются ничем на этой странице. Повтор нажатия безопасен: роут не
 * дублирует адрес («Already on your Do not contact list»).
 *
 * Вместе с адресом уходит id ответа (`reply_id`): при включённом снятии
 * сервер не проверяет кампанию этого ответа — она уже перестала писать
 * человеку, а удалять ответившего лида незачем (engDncRemoval, шапка п. 3b).
 * Сервер берёт кампанию из самого события и только если его адрес — этот же,
 * а пропускает её, только если она в записях клиента: чужой id ничего не даёт.
 *
 * Чей адрес. Блокируется только `contact_email` — адрес контакта кампании, к
 * которому рассыльщик привязал ответ (lead_email события), как RU блокирует
 * `lead.lead_email`, а не ящик-получатель. Ящиков пула в ответе роута нет
 * вовсе. Адрес входа самого клиента (сессия) кнопки не получает; пока он не
 * прочитан (или не прочитался), кнопки нет ни у кого.
 */

import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';
import { authFetch, isAuthExpiredError } from '@/lib/authFetch';
import { supabase } from '@/lib/supabaseClient';
import { engSafeText } from '@/components/client-eng/engText';
import {
  addEngBlockedAddresses,
  findEngBlockedAddress,
  removeEngBlockedAddress,
  type EngBlockedFindResult,
  type EngDncAddRemoval,
} from '@/components/client-eng/api-client';
import {
  ENG_DNC_PAGE,
  ENG_OUTREACH_PAGE,
  engDncBlockLines,
  engDncBlockPauseHint,
  engDncErrorText,
  engDncUnblockLines,
} from '@/components/client-eng/EngDoNotContact';
import { EngCard, EngSpinner, fmtDate } from '@/components/client-eng/ui';

interface EngReply {
  id: string;
  contact_email: string;
  subject: string | null;
  text: string | null;
  text_partial: boolean;
  replied_at: string;
  campaign_name: string;
  vertical_name: string;
}

interface EngRepliesCursor {
  before_at: string;
  before_id: string;
}

interface EngRepliesResponse {
  campaigns: number;
  items: EngReply[];
  next: EngRepliesCursor | null;
}

const LOAD_FAILED = 'Could not load your replies. Try again.';
const LOAD_MORE_FAILED = 'Could not load older replies. Try again.';
const SESSION_EXPIRED = 'Your session has expired. Sign in again to see your replies.';

/** Длинный ответ сворачивается до этого числа символов («Show the full reply»). */
const COLLAPSED_CHARS = 600;

/* ── «Block» ── */

const BLOCK_NO_ANSWER =
  "We did not get an answer from the server, so we can't tell whether this address was added. " +
  'Check your Do not contact list.';
const BLOCK_UNCONFIRMED =
  "Could not finish adding this address, so we can't tell whether it is on your list now. " +
  'Check your Do not contact list.';
const BLOCK_NOT_ADDABLE = "This address can't be added to Do not contact, because it is not a valid email address.";
const BLOCK_STILL_LISTED = 'This address is still on your Do not contact list.';
const RETRY_NO_ANSWER = 'We did not get an answer from the server. Press «Try again» in a minute.';
const UNBLOCK_NO_ANSWER =
  "We did not get an answer from the server, so we can't tell whether this address was removed. " +
  'Check your Do not contact list.';
const UNBLOCK_FAILED = 'Could not remove this address. Try again in a minute.';
const UNBLOCK_NOT_CHECKED =
  'We could not find this address on your list from here. Remove it on your Do not contact list.';
const UNBLOCK_ABSENT = 'This address is not on your Do not contact list.';
const OWN_ADDRESS = 'This is the address you sign in with, so there is no Block button for it here.';
/** Адрес ответа не в той форме, которую список хранит (blockKeyOf): кнопки нет — сказано почему. */
const NOT_BLOCKABLE = "This address can't be added to Do not contact.";

/**
 * Адрес, который кнопка кладёт в список, — или null, если кнопки не будет.
 * Форма — подмножество той, что принимает ENG-разбор вставки (ADDRESS_RE в
 * api/client/blocklist/_eng.ts): один токен без разделителей, обёрток и
 * хвостовой пунктуации. Поэтому роут сохраняет ровно эту строку (trim +
 * lowercase), и отмена находит её точным сравнением. `'` и `` ` `` в локальной
 * части ADDRESS_RE принимает (dan.o'brien@acme.com), а в НАЧАЛЕ адреса разбор
 * срезает их, как `{`, `}` и `"`, обёрткой (WRAP_HEAD_RE) — такой адрес кнопки
 * не получает (роут сохранил бы другую строку).
 */
const BLOCKABLE_RE =
  /^(?![{}'"`])[\p{L}\p{M}\p{N}!#$%&'+\/=?^_`{|}~.-]+@(?:[\p{L}\p{N}](?:[\p{L}\p{M}\p{N}-]*[\p{L}\p{M}\p{N}])?\.)+(?:\p{L}[\p{L}\p{M}]{1,62}|xn--[a-z0-9-]+)$/u;

function blockKeyOf(raw: string): string | null {
  const key = raw.replace(/\p{Cf}/gu, '').trim().toLowerCase();
  return key.length <= 320 && BLOCKABLE_RE.test(key) ? key : null;
}

type BlockNote = {
  tone: 'ok' | 'error' | 'mute';
  lines: string[];
  /** Строка «кампания другого рынка: как остановить её сразу» (снятие выключено). */
  pauseHint?: boolean;
  /** Ссылка на «Do not contact»: исход неизвестен или действие — там. */
  listLink?: boolean;
};

/**
 * Состояние «Block» одного адреса (общее для всех карточек этого адреса):
 * idle — кнопка «Block»; listed — адрес в списке, есть «Remove from Do not
 * contact» (и «Try again», если снятие с кампаний не заявилось); adding /
 * retrying («Try again») / removing — запрос идёт; not_addable — роут адрес
 * не принял, кнопки нет.
 * `removal` — режим последнего добавления (по нему тексты отмены),
 * `campaigns` — сколько кампаний клиента проверяется (только 'removing').
 */
interface BlockState {
  phase: 'idle' | 'adding' | 'listed' | 'retrying' | 'removing' | 'not_addable';
  added: boolean;
  removal: EngDncAddRemoval;
  campaigns: number | null;
  note: BlockNote | null;
}

const BLOCK_IDLE: BlockState = { phase: 'idle', added: false, removal: 'off', campaigns: null, note: null };

function isRepliesResponse(raw: unknown): raw is EngRepliesResponse {
  const r = raw as Partial<EngRepliesResponse> | null;
  return !!r && typeof r.campaigns === 'number' && Array.isArray(r.items);
}

async function fetchReplies(cursor: EngRepliesCursor | null): Promise<EngRepliesResponse | { error: string }> {
  const qs = cursor
    ? `?before_at=${encodeURIComponent(cursor.before_at)}&before_id=${encodeURIComponent(cursor.before_id)}`
    : '';
  try {
    const res = await authFetch(`/api/client/eng/replies${qs}`);
    const body: unknown = await res.json().catch(() => null);
    if (res.status === 401) return { error: SESSION_EXPIRED };
    if (!res.ok || !isRepliesResponse(body)) {
      const routeText = typeof (body as { error?: unknown } | null)?.error === 'string'
        ? engSafeText((body as { error: string }).error)
        : null;
      return { error: routeText ?? (cursor ? LOAD_MORE_FAILED : LOAD_FAILED) };
    }
    return body;
  } catch {
    return { error: cursor ? LOAD_MORE_FAILED : LOAD_FAILED };
  }
}

function BlockNoteView({ note }: { note: BlockNote }) {
  const color =
    note.tone === 'error' ? 'var(--cp-red)' : note.tone === 'mute' ? 'var(--cp-paper-mute)' : 'var(--cp-paper)';
  return (
    <>
      {note.lines.map((line, i) => (
        <p key={i} className="text-xs m-0 break-words" style={{ color }}>
          {line}
        </p>
      ))}
      {note.pauseHint && (
        <p className="text-xs m-0" style={{ color: 'var(--cp-text-m)' }}>
          If they are also in a campaign of another market, that campaign keeps emailing them. To stop it right
          away, open{' '}
          <Link href={ENG_OUTREACH_PAGE} prefetch={false} className="underline">
            Outreach
          </Link>{' '}
          and press «Pause» on that market.
        </p>
      )}
      {note.listLink && (
        <p className="text-xs m-0">
          <Link href={ENG_DNC_PAGE} prefetch={false} className="underline" style={{ color: 'var(--cp-text-m)' }}>
            Open Do not contact
          </Link>
        </p>
      )}
    </>
  );
}

/**
 * Низ карточки: «Block» / отмена. Кнопки не выключаются атрибутом disabled
 * (фокус с выключенной кнопки уходит на body) — пока идёт запрос, они
 * aria-disabled, а нажатие гасит обработчик. После ответа фокус уходит на
 * строку итога (role=status), следующий Tab — на кнопки под ней: повторный
 * Enter по месту кнопки «Block» отмену не нажмёт.
 */
function BlockControl({
  email,
  blockKey,
  replyId,
  state,
  onBlock,
  onUnblock,
}: {
  email: string;
  blockKey: string;
  /** id ответа этой карточки: сервер не проверяет его кампанию (шапка). */
  replyId: string;
  state: BlockState;
  onBlock: (key: string, current: BlockState, replyId: string) => Promise<void>;
  onUnblock: (key: string, current: BlockState) => Promise<void>;
}) {
  const statusRef = useRef<HTMLDivElement>(null);
  const busy = state.phase === 'adding' || state.phase === 'retrying' || state.phase === 'removing';
  const listed = state.phase === 'listed' || state.phase === 'retrying' || state.phase === 'removing';

  const run = async (action: (key: string, current: BlockState, replyId: string) => Promise<void>) => {
    if (busy) return;
    await action(blockKey, state, replyId);
    statusRef.current?.focus();
  };

  return (
    <div className="mt-3 pt-3 border-t flex flex-col gap-2" style={{ borderColor: 'var(--cp-divider)' }}>
      <div ref={statusRef} tabIndex={-1} role="status" className="flex flex-col gap-1 outline-none">
        {state.note && <BlockNoteView note={state.note} />}
      </div>
      {state.phase !== 'not_addable' && (
        <div className="flex flex-wrap items-center gap-2">
          {(state.phase === 'idle' || state.phase === 'adding') && (
            <button
              type="button"
              onClick={() => void run(onBlock)}
              aria-disabled={busy}
              aria-label={`Block ${email}`}
              title="Add this address to Do not contact"
              className={`ds-btn-secondary inline-flex items-center gap-1.5 text-[11px] ${busy ? 'opacity-50' : ''}`}
            >
              {state.phase === 'adding' && <EngSpinner />}
              {state.phase === 'adding' ? 'Blocking…' : 'Block'}
            </button>
          )}
          {listed && (
            <>
              {state.removal === 'not_scheduled' && (
                <button
                  type="button"
                  onClick={() => void run(onBlock)}
                  aria-disabled={busy}
                  className={`ds-btn-secondary inline-flex items-center gap-1.5 text-[11px] ${busy ? 'opacity-50' : ''}`}
                >
                  {state.phase === 'retrying' && <EngSpinner />}
                  {state.phase === 'retrying' ? 'Trying again…' : 'Try again'}
                </button>
              )}
              <button
                type="button"
                onClick={() => void run(onUnblock)}
                aria-disabled={busy}
                aria-label={`Remove ${email} from Do not contact`}
                className={`ds-btn-ghost inline-flex items-center gap-1.5 text-[11px] ${busy ? 'opacity-50' : ''}`}
              >
                {state.phase === 'removing' && <EngSpinner />}
                {state.phase === 'removing' ? 'Removing…' : 'Remove from Do not contact'}
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}

function ReplyCard({
  reply,
  ownEmail,
  blockState,
  onBlock,
  onUnblock,
}: {
  reply: EngReply;
  /** Адрес входа клиента (lowercase); null — ещё не прочитан или не прочитался. */
  ownEmail: string | null;
  blockState: (key: string) => BlockState;
  onBlock: (key: string, current: BlockState, replyId: string) => Promise<void>;
  onUnblock: (key: string, current: BlockState) => Promise<void>;
}) {
  const [expanded, setExpanded] = useState(false);
  const blockKey = reply.contact_email ? blockKeyOf(reply.contact_email) : null;
  const long = (reply.text?.length ?? 0) > COLLAPSED_CHARS;
  const shown = reply.text && long && !expanded ? `${reply.text.slice(0, COLLAPSED_CHARS).trimEnd()}…` : reply.text;
  const meta = [
    reply.campaign_name ? `Campaign: ${reply.campaign_name}` : null,
    reply.vertical_name ? `Market: ${reply.vertical_name}` : null,
  ].filter(Boolean);

  return (
    <EngCard>
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className="text-sm font-semibold break-all" style={{ color: 'var(--cp-paper)' }}>
          {reply.contact_email || 'Unknown contact'}
        </span>
        <span className="ml-auto text-xs" style={{ color: 'var(--cp-paper-mute)' }}>
          {fmtDate(reply.replied_at)}
        </span>
      </div>
      <p className="mt-1 text-sm m-0 break-words" style={{ color: 'var(--cp-paper)' }}>
        {reply.subject ?? '(no subject)'}
      </p>
      {meta.length > 0 && (
        <p className="mt-1 text-xs m-0 break-words" style={{ color: 'var(--cp-paper-mute)' }}>
          {meta.join(' · ')}
        </p>
      )}
      {shown ? (
        <p className="mt-3 text-sm m-0 whitespace-pre-wrap break-words" style={{ color: 'var(--cp-text-m)' }}>
          {shown}
        </p>
      ) : (
        <p className="mt-3 text-sm m-0 italic" style={{ color: 'var(--cp-paper-mute)' }}>
          The text of this reply is not available here.
        </p>
      )}
      {long && (
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="mt-2 text-xs underline"
          style={{ color: 'var(--cp-text-m)' }}
        >
          {expanded ? 'Show less' : 'Show the full reply'}
        </button>
      )}
      {reply.text && reply.text_partial && (
        <p className="mt-2 text-xs m-0" style={{ color: 'var(--cp-paper-mute)' }}>
          Only the beginning of this reply is shown.
        </p>
      )}
      {blockKey && ownEmail !== null && blockKey === ownEmail && (
        <p className="mt-3 text-xs m-0" style={{ color: 'var(--cp-paper-mute)' }}>
          {OWN_ADDRESS}
        </p>
      )}
      {!blockKey && reply.contact_email && (
        <p className="mt-3 text-xs m-0" style={{ color: 'var(--cp-paper-mute)' }}>
          {NOT_BLOCKABLE}
        </p>
      )}
      {blockKey && ownEmail !== null && blockKey !== ownEmail && (
        <BlockControl
          email={reply.contact_email}
          blockKey={blockKey}
          replyId={reply.id}
          state={blockState(blockKey)}
          onBlock={onBlock}
          onUnblock={onUnblock}
        />
      )}
    </EngCard>
  );
}

export default function EngRepliesPage() {
  const [campaigns, setCampaigns] = useState<number | null>(null);
  const [items, setItems] = useState<EngReply[]>([]);
  const [next, setNext] = useState<EngRepliesCursor | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loadingFirst, setLoadingFirst] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [moreError, setMoreError] = useState<string | null>(null);
  const [ownEmail, setOwnEmail] = useState<string | null>(null);
  const [blocks, setBlocks] = useState<Record<string, BlockState>>({});
  // Адреса с идущим запросом «Block» / отмены: второе нажатие (та же или
  // другая карточка того же адреса) до ответа гасится.
  const blockBusy = useRef(new Set<string>());

  // Адрес входа: без него кнопки «Block» нет (своего адреса она не блокирует).
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const { data: { session } } = await supabase.auth.getSession();
        const email = session?.user?.email?.trim().toLowerCase();
        if (!cancelled && email) setOwnEmail(email);
      } catch {
        // Не прочитался — кнопки «Block» нет.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const setBlock = useCallback((key: string, next: BlockState) => {
    setBlocks((prev) => ({ ...prev, [key]: next }));
  }, []);

  const blockState = useCallback((key: string): BlockState => blocks[key] ?? BLOCK_IDLE, [blocks]);

  const onBlock = useCallback(
    async (key: string, current: BlockState, replyId: string) => {
      if (blockBusy.current.has(key)) return;
      blockBusy.current.add(key);
      // «Try again» (снятие не заявилось) — адрес уже в списке: при сбое он там
      // и остаётся, а «Added» первого нажатия не превращается в «Already».
      const wasListed = current.phase === 'listed';
      const fallback: BlockState = wasListed ? current : BLOCK_IDLE;
      // Сбой «Try again» адрес из списка не убирает: роут откатывает только
      // строки, вставленные этим же запросом, а этот адрес уже стоял. Вопрос
      // тогда не «добавлен ли», а «заявилось ли снятие» — повтор безопасен.
      const noAnswer = wasListed ? RETRY_NO_ANSWER : BLOCK_NO_ANSWER;
      const errorLines = (text: string): string[] => (wasListed ? [BLOCK_STILL_LISTED, text] : [text]);
      setBlock(key, { ...current, phase: wasListed ? 'retrying' : 'adding' });
      try {
        const outcome = await addEngBlockedAddresses(key, { replyId });
        if (outcome.ok) {
          const r = outcome.result;
          if (r.added + r.already_listed === 0) {
            setBlock(key, { ...BLOCK_IDLE, phase: 'not_addable', note: { tone: 'error', lines: [BLOCK_NOT_ADDABLE] } });
            return;
          }
          const added = r.added > 0 || (wasListed && current.added);
          setBlock(key, {
            phase: 'listed',
            added,
            removal: r.removal,
            campaigns: r.removal_campaigns,
            note: {
              tone: 'ok',
              lines: engDncBlockLines({
                added,
                removal: r.removal,
                campaigns: r.removal_campaigns,
                afterLaunch: r.removal_after_launch,
                skippedReplyCampaign: r.removal_skipped_reply_campaign,
              }),
              pauseHint: engDncBlockPauseHint(r.removal),
              // Проверка кампаний идёт (или пойдёт после запуска) — её ход виден на «Do not contact».
              listLink: r.removal === 'removing' || r.removal === 'deferred' || r.removal_after_launch,
            },
          });
          return;
        }
        // Нет читаемого ответа или «не удалось закончить» — добавлен ли адрес,
        // неизвестно: своя фраза со ссылкой на список (текст роута для
        // add_unconfirmed говорит про список «below» страницы Do not contact).
        const text =
          outcome.error === null
            ? noAnswer
            : outcome.code === 'add_unconfirmed'
              ? wasListed
                ? RETRY_NO_ANSWER
                : BLOCK_UNCONFIRMED
              : outcome.error;
        const unknown = outcome.error === null || outcome.code === 'add_unconfirmed';
        setBlock(key, {
          ...fallback,
          note: {
            tone: 'error',
            lines: errorLines(text),
            listLink: outcome.reload || (unknown && !wasListed),
          },
        });
      } catch (err) {
        const text = engDncErrorText(err, noAnswer);
        setBlock(key, {
          ...fallback,
          note: { tone: 'error', lines: errorLines(text), listLink: text === BLOCK_NO_ANSWER },
        });
      } finally {
        blockBusy.current.delete(key);
      }
    },
    [setBlock],
  );

  const onUnblock = useCallback(
    async (key: string, current: BlockState) => {
      if (blockBusy.current.has(key)) return;
      blockBusy.current.add(key);
      const listed: BlockState = { ...current, phase: 'listed' };
      setBlock(key, { ...current, phase: 'removing' });
      try {
        let found: EngBlockedFindResult;
        try {
          found = await findEngBlockedAddress(key);
        } catch (err) {
          // Сбой чтения списка: текст роута («Could not load your list») здесь
          // не к месту — своя фраза; истёкшая сессия — её текст.
          const text = isAuthExpiredError(err) ? engDncErrorText(err, UNBLOCK_FAILED) : UNBLOCK_FAILED;
          setBlock(key, { ...listed, note: { tone: 'error', lines: [text] } });
          return;
        }
        if (found.kind === 'absent') {
          setBlock(key, { ...BLOCK_IDLE, removal: current.removal, note: { tone: 'mute', lines: [UNBLOCK_ABSENT] } });
          return;
        }
        if (found.kind === 'not_checked') {
          setBlock(key, { ...listed, note: { tone: 'error', lines: [UNBLOCK_NOT_CHECKED], listLink: true } });
          return;
        }
        const outcome = await removeEngBlockedAddress(found.entry.id);
        if (outcome.ok) {
          setBlock(key, {
            ...BLOCK_IDLE,
            removal: current.removal,
            note:
              outcome.removed > 0
                ? { tone: 'ok', lines: engDncUnblockLines(current.removal) }
                : { tone: 'mute', lines: [UNBLOCK_ABSENT] },
          });
          return;
        }
        setBlock(key, {
          ...listed,
          note: { tone: 'error', lines: [outcome.error ?? UNBLOCK_NO_ANSWER], listLink: outcome.error === null },
        });
      } catch (err) {
        const text = engDncErrorText(err, UNBLOCK_NO_ANSWER);
        setBlock(key, { ...listed, note: { tone: 'error', lines: [text], listLink: text === UNBLOCK_NO_ANSWER } });
      } finally {
        blockBusy.current.delete(key);
      }
    },
    [setBlock],
  );

  const applyFirst = useCallback((result: EngRepliesResponse | { error: string }) => {
    if ('error' in result) {
      setLoadError(result.error);
    } else {
      setLoadError(null);
      setCampaigns(result.campaigns);
      setItems(result.items);
      setNext(result.next);
      setMoreError(null);
    }
    setLoadingFirst(false);
  }, []);

  // Первая загрузка: состояние меняется только по ответу (loadingFirst уже true).
  useEffect(() => {
    let cancelled = false;
    void fetchReplies(null).then((result) => {
      if (!cancelled) applyFirst(result);
    });
    return () => {
      cancelled = true;
    };
  }, [applyFirst]);

  // «Try again» / «Refresh» — с первой страницы.
  const loadFirst = async () => {
    setLoadingFirst(true);
    applyFirst(await fetchReplies(null));
  };

  const loadMore = async () => {
    if (!next || loadingMore) return;
    setLoadingMore(true);
    setMoreError(null);
    const result = await fetchReplies(next);
    if ('error' in result) {
      setMoreError(result.error);
    } else {
      // Ответ, пришедший между страницами, сдвигает ленту — без повторов по id.
      setItems((prev) => {
        const seen = new Set(prev.map((r) => r.id));
        return [...prev, ...result.items.filter((r) => !seen.has(r.id))];
      });
      setNext(result.next);
    }
    setLoadingMore(false);
  };

  let content: React.ReactNode;
  if (loadingFirst && campaigns === null) {
    content = (
      <div className="flex items-center gap-2 text-sm" style={{ color: 'var(--cp-paper-mute)' }}>
        <EngSpinner /> Loading replies…
      </div>
    );
  } else if (loadError && campaigns === null) {
    content = (
      <EngCard>
        <p className="text-sm m-0" style={{ color: 'var(--cp-red)' }}>{loadError}</p>
        <button
          type="button"
          onClick={() => void loadFirst()}
          disabled={loadingFirst}
          className="ds-btn-ghost mt-3 disabled:opacity-50"
        >
          {loadingFirst ? 'Loading…' : 'Try again'}
        </button>
      </EngCard>
    );
  } else if (campaigns === 0) {
    content = (
      <EngCard>
        <p className="text-sm m-0" style={{ color: 'var(--cp-paper-mute)' }}>
          You have not launched any campaigns yet, so there are no replies to show.
        </p>
        <p className="mt-3 text-sm m-0">
          <Link href="/client/eng" className="underline" style={{ color: 'var(--cp-text-m)' }}>
            Go to Outreach
          </Link>
        </p>
      </EngCard>
    );
  } else if (items.length === 0 && !next) {
    content = (
      <EngCard>
        <p className="text-sm m-0" style={{ color: 'var(--cp-paper-mute)' }}>
          No replies have reached this page yet. Replies show up here after they arrive.
        </p>
      </EngCard>
    );
  } else {
    // Пустая страница с курсором дальше бывает, когда свежие события скрыты как
    // полученные чужими ящиками (lib/hypothesisEngine/engReplies.ts, «ЧУЖОЙ
    // ЯЩИК»): тогда только кнопка — фраза «ответов нет» была бы неправдой.
    content = (
      <div className="flex flex-col gap-3">
        {items.map((reply) => (
          <ReplyCard
            key={reply.id}
            reply={reply}
            ownEmail={ownEmail}
            blockState={blockState}
            onBlock={onBlock}
            onUnblock={onUnblock}
          />
        ))}
        {next ? (
          <div className="flex flex-col items-start gap-2">
            <button
              type="button"
              onClick={() => void loadMore()}
              disabled={loadingMore}
              className="ds-btn-ghost disabled:opacity-50"
            >
              {loadingMore ? 'Loading…' : 'Show older replies'}
            </button>
            {moreError && (
              <p className="text-sm m-0" style={{ color: 'var(--cp-red)' }}>{moreError}</p>
            )}
          </div>
        ) : (
          <p className="text-xs m-0" style={{ color: 'var(--cp-paper-mute)' }}>
            No older replies.
          </p>
        )}
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-3xl">
      <header className="mb-6 sm:mb-8 flex flex-wrap items-end gap-3">
        <div>
          <h1 className="text-xl sm:text-2xl font-bold m-0" style={{ color: 'var(--cp-paper)' }}>
            Replies
          </h1>
          <p className="mt-1 text-sm m-0" style={{ color: 'var(--cp-paper-mute)' }}>
            Replies to your campaigns, newest first. Press «Block» on a reply to add that address to{' '}
            <Link href={ENG_DNC_PAGE} prefetch={false} className="underline">
              Do not contact
            </Link>
            .
          </p>
        </div>
        {campaigns !== null && (
          <button
            type="button"
            onClick={() => void loadFirst()}
            disabled={loadingFirst}
            className="ds-btn-ghost ml-auto disabled:opacity-50"
          >
            {loadingFirst ? 'Refreshing…' : 'Refresh'}
          </button>
        )}
      </header>
      {loadError && campaigns !== null && (
        <p className="mb-4 text-sm m-0" style={{ color: 'var(--cp-red)' }}>{loadError}</p>
      )}
      {content}
    </div>
  );
}
