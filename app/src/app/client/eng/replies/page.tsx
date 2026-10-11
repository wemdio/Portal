'use client';

/**
 * /client/eng/replies — ответы на кампании ENG-клиента: только чтение, свежие
 * сверху, «Show older replies» дочитывает следующую страницу.
 *
 * Данные — GET /api/client/eng/replies (источник и его границы — шапка
 * lib/hypothesisEngine/engReplies.ts). Текст ответа приходит ПРОСТЫМ ТЕКСТОМ и
 * рисуется текстовым узлом React — HTML письма в браузер не попадает вовсе.
 * Обещания «ответ появится через N минут» на экране нет: доставку уведомлений
 * о новых ответах мы не контролируем.
 */

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { authFetch } from '@/lib/authFetch';
import { engSafeText } from '@/components/client-eng/engText';
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

function ReplyCard({ reply }: { reply: EngReply }) {
  const [expanded, setExpanded] = useState(false);
  const long = (reply.text?.length ?? 0) > COLLAPSED_CHARS;
  const shown = reply.text && long && !expanded ? `${reply.text.slice(0, COLLAPSED_CHARS).trimEnd()}…` : reply.text;
  const meta = [
    reply.campaign_name ? `Campaign: ${reply.campaign_name}` : null,
    reply.vertical_name ? `Vertical: ${reply.vertical_name}` : null,
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
          <ReplyCard key={reply.id} reply={reply} />
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
            Replies to your campaigns, newest first.
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
