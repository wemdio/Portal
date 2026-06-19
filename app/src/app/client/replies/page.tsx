'use client';

import { useState, useEffect, useCallback, useRef, Suspense } from 'react';
import Link from 'next/link';
import type { Route } from 'next';
import { useRouter, useSearchParams } from 'next/navigation';
import { Send, MessageSquare, RefreshCw, Search, X } from 'lucide-react';
import { clientApiFetch } from '@/lib/clientFetcher';
import { ExpandedThread } from '@/components/client-replies/ExpandedThread';
import type { ThreadMessage } from '@/lib/clientCampaignReplies/types';

type StatusFilter = 'all' | 'unread' | 'answered' | 'leads';

const STATUS_LABEL: Record<StatusFilter, string> = {
  all: 'Все',
  unread: 'Непрочитано',
  answered: 'Отвечено',
  leads: 'Лиды',
};

type LeadComment = {
  id: string;
  forwarded_lead_id: string;
  user_id: string;
  user_name: string | null;
  comment: string;
  created_at: string;
};

type ForwardedLead = {
  id: string;
  source?: 'forwarded_lead' | 'reply';
  qualification_id: string | null;
  campaign_id: string;
  campaign_name: string | null;
  lead_email: string;
  lead_name: string | null;
  company_name: string | null;
  phone: string | null;
  website: string | null;
  linkedin_url: string | null;
  reply_subject: string | null;
  reply_body: string | null;
  last_outbound_preview: string | null;
  reply_timestamp: string | null;
  status: string | null;
  ai_reason: string | null;
  created_at: string;
  client_lead_comments: { count: number }[];
  email_id?: string | null;
  lead_id?: string | null;
  thread_id?: string | null;
  is_unread?: boolean;
  ai_interest_value?: number | null;
  is_lead?: boolean;
  lead_entry_id?: string | null;
  is_answered?: boolean;
  message_count?: number;
};

type LeadsResponse = {
  items: ForwardedLead[];
  total: number;
  limit: number;
  offset: number;
};

function formatDate(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  return d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' });
}

/** Russian noun pluralization with 11-14 exception (1 / 2-4 / 5+). */
function plural(n: number, one: string, few: string, many: string): string {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return one;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return few;
  return many;
}

/**
 * Статус-бейдж одной переписки — единая логика для списка (LeadCard) и детальной
 * карточки (LeadDetail), чтобы они не разъезжались. Иерархия: лид > непрочитано >
 * отвечено > прочитано. Прочитанное-без-ответа — нейтральный «Ответ» (раньше был
 * красный «Требует ответа», но клиент: часто ответ и не нужен — раздражало).
 */
function leadStatusBadge(lead: {
  is_lead?: boolean;
  is_unread?: boolean;
  is_answered?: boolean;
}): { label: string; dotColor: string; textColor: string } {
  if (lead.is_lead) return { label: 'Лид', dotColor: 'var(--cp-green)', textColor: 'var(--cp-green)' };
  if (lead.is_unread) return { label: 'Непрочитано', dotColor: 'var(--cp-amber)', textColor: 'var(--cp-amber)' };
  if (lead.is_answered) return { label: 'Отвечено', dotColor: 'var(--cp-accent)', textColor: 'var(--cp-accent)' };
  return { label: 'Ответ', dotColor: 'var(--cp-paper-faint)', textColor: 'var(--cp-paper-mute)' };
}

function LeadDetail({
  lead,
  onBack,
  onMarkedLead,
  onMarkedUnread,
  onReplied,
}: {
  lead: ForwardedLead;
  onBack: () => void;
  onMarkedLead?: () => void;
  onMarkedUnread?: () => void;
  onReplied?: () => void;
}) {
  const [comments, setComments] = useState<LeadComment[]>([]);
  const [loadingComments, setLoadingComments] = useState(true);
  const [commentsError, setCommentsError] = useState('');
  const [newComment, setNewComment] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState('');
  const [isLead, setIsLead] = useState(Boolean(lead.is_lead));
  const [markingLead, setMarkingLead] = useState(false);
  const [markLeadError, setMarkLeadError] = useState('');
  const [isBlocked, setIsBlocked] = useState(false);
  const [blocking, setBlocking] = useState(false);
  const [blockError, setBlockError] = useState('');
  const [markingUnread, setMarkingUnread] = useState(false);
  const canComment = lead.source !== 'reply';
  const canReplyByEmail = Boolean(lead.campaign_id && lead.email_id);

  const loadComments = useCallback(async () => {
    if (!canComment) {
      setComments([]);
      setLoadingComments(false);
      return;
    }

    setLoadingComments(true);
    setCommentsError('');
    try {
      const res = await clientApiFetch<{ items: LeadComment[] }>(
        `/leads/${lead.id}/comments`,
      );
      setComments(res.items);
    } catch (err) {
      // Surface the failure inline with a retry — silent catches let the
      // empty-state lie ("Комментариев пока нет") when API actually 500'd.
      setCommentsError(
        err instanceof Error ? err.message : 'Не удалось загрузить комментарии',
      );
    } finally {
      setLoadingComments(false);
    }
  }, [canComment, lead.id]);

  useEffect(() => {
    loadComments();
  }, [loadComments]);

  const handleSubmit = async () => {
    if (!canComment) return;
    const text = newComment.trim();
    if (!text) return;
    setSubmitting(true);
    setSubmitError('');
    try {
      await clientApiFetch(`/leads/${lead.id}/comments`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ comment: text }),
      });
      // Clear ONLY on success — silent failure used to clear input as if it
      // worked, costing the user their typed comment with no warning.
      setNewComment('');
      loadComments();
    } catch (err) {
      setSubmitError(
        err instanceof Error ? err.message : 'Не удалось отправить комментарий',
      );
    } finally {
      setSubmitting(false);
    }
  };

  const handleMarkLead = async () => {
    if (!lead.campaign_id || !lead.email_id || isLead) return;
    setMarkingLead(true);
    setMarkLeadError('');
    try {
      await clientApiFetch(`/campaigns/${lead.campaign_id}/replies/${lead.email_id}/mark-lead`, {
        method: 'POST',
      });
      setIsLead(true);
      onMarkedLead?.();
    } catch (err) {
      setMarkLeadError(err instanceof Error ? err.message : 'Не удалось пометить как лид');
    } finally {
      setMarkingLead(false);
    }
  };

  // Вернуть письмо в «непрочитанные» (персональная прочитанность у нас, не в
  // Instantly). Открытие переписки помечает прочитанным — эта кнопка отменяет.
  const handleMarkUnread = async () => {
    if (!lead.campaign_id || !lead.email_id || markingUnread) return;
    setMarkingUnread(true);
    try {
      await clientApiFetch(`/campaigns/${lead.campaign_id}/replies/${lead.email_id}/read`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ read: false }),
      });
      onMarkedUnread?.();
    } catch {
      // статус прочтения не критичен — молча игнорируем сбой
    } finally {
      setMarkingUnread(false);
    }
  };

  const handleBlock = async () => {
    if (!lead.lead_email || isBlocked || blocking) return;
    setBlocking(true);
    setBlockError('');
    try {
      await clientApiFetch('/blocklist', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: lead.lead_email, source: 'reply' }),
      });
      setIsBlocked(true);
    } catch (err) {
      setBlockError(err instanceof Error ? err.message : 'Не удалось добавить в чёрный список');
    } finally {
      setBlocking(false);
    }
  };

  const statusBadge = leadStatusBadge(lead);
  // Фолбэк для ExpandedThread: последний ответ лида из уже загруженных данных
  // списка. Показывается, ТОЛЬКО если живой /thread не загрузился (раньше тут был
  // отдельный закреплённый блок «ответ лида», но с новым порядком треда он
  // дублировал верхний пузырь ленты).
  const fallbackThread: ThreadMessage[] = lead.email_id
    ? [{
        id: lead.email_id,
        direction: 'inbound',
        timestamp: lead.reply_timestamp ?? lead.created_at ?? null,
        subject: lead.reply_subject ?? null,
        from_email: lead.lead_email ?? null,
        from_name: lead.lead_name ?? null,
        body_text: lead.reply_body ?? null,
      }]
    : [];

  return (
    <div>
      <button
        onClick={onBack}
        className="neu-pill px-3 py-1.5 text-xs font-semibold mb-6"
        style={{ color: 'var(--cp-text-m)' }}
      >
        ← Назад к ответам
      </button>

      <div className="neu-card p-5 sm:p-8 mb-6">
        <div className="flex items-start justify-between gap-4 mb-6">
          <div>
            <h2 className="text-xl sm:text-2xl font-bold" style={{ color: 'var(--cp-text)' }}>
              {lead.lead_name || lead.lead_email}
            </h2>
            {lead.company_name && (
              <p className="text-sm mt-0.5" style={{ color: 'var(--cp-text-m)' }}>
                {lead.company_name}
              </p>
            )}
          </div>
          <div className="flex flex-col items-end gap-2 shrink-0">
            <span className="ds-status-tag" style={{ color: statusBadge.textColor }}>
              <span aria-hidden className="ds-status-dot" style={{ background: statusBadge.dotColor }} />
              {statusBadge.label}
            </span>
            <span
              className="neu-pill px-3 py-1.5 text-[11px] font-bold"
              style={{ color: 'var(--cp-accent)' }}
            >
              {formatDate(lead.reply_timestamp ?? lead.created_at)}
            </span>
            {canReplyByEmail && (
              <button
                type="button"
                onClick={() => void handleMarkUnread()}
                disabled={markingUnread}
                title="Вернуть письмо в «непрочитанные»"
                className="neu-pill px-3 py-1.5 text-[11px] font-semibold disabled:opacity-60"
                style={{ color: 'var(--cp-text-m)' }}
              >
                {markingUnread ? 'Сохраняем…' : '⟲ В непрочитанные'}
              </button>
            )}
          </div>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3 mb-6">
          <InfoRow label="Email" value={lead.lead_email} />
          {lead.phone && <InfoRow label="Телефон" value={lead.phone} />}
          {lead.website && <InfoRow label="Сайт" value={lead.website} />}
          {lead.linkedin_url && <InfoRow label="LinkedIn" value={lead.linkedin_url} />}
          {lead.campaign_name && <InfoRow label="Кампания" value={lead.campaign_name} />}
        </div>

        {/* Переписка — единой лентой (новые сверху, как в Instantly), сразу под
            шапкой. Раньше тут были закреплённые «наше последнее письмо» + «ответ
            лида», но с новым порядком треда они дублировали верхние письма ленты,
            поэтому убраны. Полный текст последнего ответа — верхний пузырь треда;
            если /thread не загрузился, ExpandedThread покажет его из fallbackThread. */}
        {canReplyByEmail && (
          <div className="mb-2">
            <p className="ds-eyebrow mb-2">
              02<span aria-hidden> → </span>переписка
            </p>
            <ExpandedThread
              campaignId={lead.campaign_id}
              emailId={lead.email_id!}
              onReplied={onReplied}
              fallbackMessages={fallbackThread}
              className="space-y-3"
            />
          </div>
        )}

        {canReplyByEmail && (
          <div className="neu-sm mt-5 p-4">
            <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-3">
              <div>
                <p className="text-sm font-semibold mb-1" style={{ color: 'var(--cp-text)' }}>
                  Лид из этого диалога
                </p>
                <p className="text-xs leading-relaxed" style={{ color: 'var(--cp-text-m)' }}>
                  Помечайте как лид те ответы, где есть реальный интерес, запрос цены, созвона или материалов. Такие диалоги попадут в отдельную вкладку «Лиды», где их удобно вести дальше и оставлять комментарии.
                </p>
              </div>
              <button
                type="button"
                onClick={() => void handleMarkLead()}
                disabled={isLead || markingLead}
                className="neu-btn shrink-0 px-4 py-2 text-xs font-semibold disabled:opacity-60"
              >
                {isLead ? 'Уже в лидах' : markingLead ? 'Сохраняем...' : 'Пометить как лид'}
              </button>
            </div>
            {markLeadError && (
              <p className="text-xs mt-2" style={{ color: 'var(--cp-red)' }}>
                {markLeadError}
              </p>
            )}
          </div>
        )}

        {/* Чёрный список: негативный ответ → блокируем контакт, и все будущие
            запуски кампаний отфильтруют его до загрузки в Instantly. */}
        {lead.lead_email && (
          <div className="neu-sm mt-5 p-4">
            <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-3">
              <div>
                <p className="text-sm font-semibold mb-1" style={{ color: 'var(--cp-text)' }}>
                  Не писать этому контакту
                </p>
                <p className="text-xs leading-relaxed" style={{ color: 'var(--cp-text-m)' }}>
                  Если в ответе негатив или просьба больше не писать — добавьте адрес в чёрный
                  список. В новые кампании он не попадёт. Список можно посмотреть и изменить на
                  странице «Чёрный список».
                </p>
              </div>
              <button
                type="button"
                onClick={() => void handleBlock()}
                disabled={isBlocked || blocking}
                className="neu-btn shrink-0 px-4 py-2 text-xs font-semibold disabled:opacity-60"
              >
                {isBlocked ? 'В чёрном списке' : blocking ? 'Блокируем...' : 'В чёрный список'}
              </button>
            </div>
            {blockError && (
              <p className="text-xs mt-2" style={{ color: 'var(--cp-red)' }}>
                {blockError}
              </p>
            )}
          </div>
        )}

      </div>

      {canComment && (
        <div className="neu-card p-5 sm:p-8">
          <p className="ds-eyebrow mb-5">
            03<span aria-hidden> → </span>комментарии
          </p>

          {loadingComments ? (
            <p className="text-xs py-4 text-center" style={{ color: 'var(--cp-text-l)' }}>Загрузка...</p>
          ) : commentsError ? (
            <div
              className="flex items-center gap-3 mb-5 px-4 py-3 rounded-xl"
              style={{ background: 'var(--cp-surface-rest)', border: '1px solid var(--cp-divider)' }}
              role="alert"
            >
              <p className="text-xs flex-1" style={{ color: 'var(--cp-red)' }}>
                {commentsError}
              </p>
              <button
                type="button"
                onClick={() => void loadComments()}
                className="neu-pill inline-flex items-center gap-1.5 px-3 py-1 text-[11px] font-semibold shrink-0"
                style={{ color: 'var(--cp-paper)' }}
              >
                <RefreshCw className="h-3 w-3" aria-hidden />
                Повторить
              </button>
            </div>
          ) : comments.length === 0 ? (
            <p className="text-xs py-4 text-center" style={{ color: 'var(--cp-text-l)' }}>
              Комментариев пока нет. Оставьте обратную связь по лиду.
            </p>
          ) : (
            <div className="space-y-3 mb-5">
              {comments.map((c) => (
                <div key={c.id} className="neu-sm rounded-xl p-3">
                  <div className="flex items-center justify-between mb-1">
                    <span className="text-xs font-semibold" style={{ color: 'var(--cp-text)' }}>
                      {c.user_name || 'Пользователь'}
                    </span>
                    <span className="text-[10px] ds-mono" style={{ color: 'var(--cp-text-l)' }}>
                      {formatDate(c.created_at)}
                    </span>
                  </div>
                  <p className="text-sm" style={{ color: 'var(--cp-text-m)' }}>
                    {c.comment}
                  </p>
                </div>
              ))}
            </div>
          )}

          <div className="flex gap-2">
            <input
              type="text"
              value={newComment}
              onChange={(e) => setNewComment(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && !e.shiftKey && handleSubmit()}
              placeholder="Напишите комментарий..."
              className="neu-inset flex-1 rounded-xl px-4 py-2.5 text-sm focus:outline-none"
              style={{ color: 'var(--cp-text)' }}
            />
            <button
              onClick={handleSubmit}
              disabled={!newComment.trim() || submitting}
              className="neu-btn rounded-xl px-4 py-2.5 text-sm font-semibold disabled:opacity-40 transition-opacity"
            >
              {submitting ? '...' : 'Отправить'}
            </button>
          </div>
          {submitError && (
            <p className="text-xs mt-2" style={{ color: 'var(--cp-red)' }}>
              {submitError}
            </p>
          )}
        </div>
      )}
    </div>
  );
}

function InfoRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="neu-sm rounded-lg p-3">
      <p className="ds-eyebrow mb-1">{label.toLowerCase()}</p>
      <p className="text-sm break-all" style={{ color: 'var(--cp-paper)' }}>
        {value}
      </p>
    </div>
  );
}

function LeadCard({
  lead,
  onClick,
}: {
  lead: ForwardedLead;
  onClick: () => void;
}) {
  const commentCount = lead.client_lead_comments?.[0]?.count ?? 0;

  // Статус строки (переписки) — единая логика со списком и карточкой, см. leadStatusBadge.
  const { label: statusLabel, dotColor: statusColor, textColor: statusTextColor } =
    leadStatusBadge(lead);

  return (
    <button
      onClick={onClick}
      className="neu-sm ds-card-pressable block w-full text-left p-4 sm:p-5"
    >
      <div className="flex items-start justify-between gap-3 mb-2">
        <div className="min-w-0">
          <p className="text-sm font-bold truncate" style={{ color: 'var(--cp-paper)' }}>
            {lead.lead_name || lead.lead_email}
          </p>
          {lead.company_name && (
            <p className="text-xs truncate mt-0.5" style={{ color: 'var(--cp-paper-mute)' }}>
              {lead.company_name}
            </p>
          )}
        </div>
        <span className="text-[10px] ds-mono shrink-0 whitespace-nowrap" style={{ color: 'var(--cp-paper-faint)' }}>
          {formatDate(lead.reply_timestamp ?? lead.created_at)}
        </span>
      </div>

      <div className="flex flex-wrap items-center gap-3 mb-2">
        <span className="ds-status-tag" style={{ color: statusTextColor }}>
          <span aria-hidden className="ds-status-dot" style={{ background: statusColor }} />
          {statusLabel}
        </span>
        {(lead.message_count ?? 0) > 1 && (
          <span className="text-[10px] font-semibold shrink-0" style={{ color: 'var(--cp-paper-faint)' }} title="Ответов лида в переписке">
            <span className="ds-mono tabular-nums">{lead.message_count}</span>{' '}
            {plural(lead.message_count ?? 0, 'ответ лида', 'ответа лида', 'ответов лида')}
          </span>
        )}
        <p className="text-xs truncate min-w-0" style={{ color: 'var(--cp-paper-mute)' }}>
          {lead.lead_email}
          {lead.campaign_name && <span style={{ color: 'var(--cp-paper-faint)' }}> · {lead.campaign_name}</span>}
        </p>
      </div>

      {(lead.reply_subject || lead.reply_body) && (
        <p className="text-xs truncate" style={{ color: 'var(--cp-paper-faint)' }}>
          {lead.reply_subject && <span className="font-semibold">{lead.reply_subject}: </span>}
          {lead.reply_body?.slice(0, 120) ?? ''}
        </p>
      )}

      {commentCount > 0 && (
        <div className="mt-2 flex items-center gap-1.5">
          <MessageSquare className="h-3 w-3" style={{ color: 'var(--cp-paper-faint)' }} aria-hidden />
          <span className="text-[10px] font-semibold" style={{ color: 'var(--cp-paper-mute)' }}>
            <span className="ds-mono tabular-nums">{commentCount}</span>{' '}
            {plural(commentCount, 'комментарий', 'комментария', 'комментариев')}
          </span>
        </div>
      )}
    </button>
  );
}

function RepliesPageContent() {
  const router = useRouter();
  const searchParams = useSearchParams();

  // URL-driven filter + query. Anything malformed quietly collapses to 'all'
  // so a stale or mangled link never leaks the unfiltered set under the
  // wrong label.
  const rawStatus = searchParams.get('status');
  const status: StatusFilter =
    rawStatus === 'unread' || rawStatus === 'leads' || rawStatus === 'answered'
      ? rawStatus
      : 'all';
  const query = searchParams.get('q') ?? '';

  const [leads, setLeads] = useState<ForwardedLead[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [selectedLead, setSelectedLead] = useState<ForwardedLead | null>(null);
  const [offset, setOffset] = useState(0);
  // Controlled input for the search box; pushed to URL after a 300 ms
  // debounce so every keystroke doesn't spam history or the API.
  const [searchInput, setSearchInput] = useState(query);
  const LIMIT = 30;

  // Debounce input → URL update.
  useEffect(() => {
    if (searchInput === query) return;
    const t = setTimeout(() => {
      const params = new URLSearchParams(searchParams);
      const trimmed = searchInput.trim();
      if (trimmed) params.set('q', trimmed);
      else params.delete('q');
      const qs = params.toString();
      router.replace(qs ? `/client/replies?${qs}` : '/client/replies');
    }, 300);
    return () => clearTimeout(t);
  }, [searchInput, query, searchParams, router]);

  // Reset pagination whenever the active filter or query changes — otherwise
  // a user paginated to page 4 of "all" would land on page 4 of "unread"
  // which is almost always empty.
  useEffect(() => {
    setOffset(0);
  }, [status, query]);

  const setStatusFilter = useCallback(
    (next: StatusFilter) => {
      const params = new URLSearchParams(searchParams);
      if (next === 'all') params.delete('status');
      else params.set('status', next);
      const qs = params.toString();
      router.replace(qs ? `/client/replies?${qs}` : '/client/replies');
    },
    [router, searchParams],
  );

  const clearSearch = useCallback(() => {
    setSearchInput('');
    const params = new URLSearchParams(searchParams);
    params.delete('q');
    const qs = params.toString();
    router.replace(qs ? `/client/replies?${qs}` : '/client/replies');
  }, [router, searchParams]);

  const clearAll = useCallback(() => {
    setSearchInput('');
    router.replace('/client/replies');
  }, [router]);

  // Монотонный счётчик загрузок: если за время ретраев пользователь сменил
  // фильтр/страницу (стартовал новый load), устаревший ответ не должен
  // перетереть свежие данные.
  const loadSeq = useRef(0);

  const load = useCallback(async () => {
    const seq = ++loadSeq.current;
    setLoading(true);
    setError('');

    const params = new URLSearchParams();
    params.set('limit', String(LIMIT));
    params.set('offset', String(offset));
    if (status !== 'all') params.set('status', status);
    if (query) params.set('search', query);
    const path = `/replies?${params.toString()}`;

    // «Ответы» тянутся живьём из Instantly по каждой кампании. Под общим
    // рейтлимитом воркспейса медленный вызов упирается в серверный дедлайн, и
    // если так упали ВСЕ кампании — роут отдаёт 502. Это транзиентно: повтор
    // обычно проходит (а уже успевшие кампании отдаются из серверного кэша, так
    // что ретрай почти не добавляет нагрузки). Поэтому НЕ показываем ошибку на
    // первом сбое — прозрачно повторяем, оставляя «Загрузка…», и ругаемся
    // только если не вышло за несколько попыток.
    const MAX_ATTEMPTS = 3;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      try {
        const data = await clientApiFetch<LeadsResponse>(path);
        if (seq !== loadSeq.current) return; // нас уже сменил более свежий load
        setLeads(data.items);
        setTotal(data.total);
        setError('');
        setLoading(false);
        return;
      } catch (err) {
        if (seq !== loadSeq.current) return;
        if (attempt === MAX_ATTEMPTS) {
          setError(err instanceof Error ? err.message : 'Ошибка загрузки');
          setLoading(false);
          return;
        }
        // Бэкофф перед повтором — даём рейтлимиту/медленному вызову прийти в себя.
        await new Promise((r) => setTimeout(r, 2000 * attempt));
      }
    }
  }, [offset, status, query]);

  useEffect(() => {
    load();
  }, [load]);

  if (selectedLead) {
    return (
      <div className="mx-auto max-w-5xl">
        <LeadDetail
          lead={selectedLead}
          onBack={() => setSelectedLead(null)}
          onMarkedLead={() => {
            setLeads((prev) => prev.map((lead) => (
              lead.id === selectedLead.id
                ? { ...lead, is_lead: true, is_unread: false, status: 'lead' }
                : lead
            )));
            setSelectedLead((lead) => (lead
              ? { ...lead, is_lead: true, is_unread: false, status: 'lead' }
              : lead));
          }}
          onMarkedUnread={() => {
            setLeads((prev) => prev.map((l) => (
              l.id === selectedLead.id
                ? { ...l, is_unread: true, status: 'unread' }
                : l
            )));
            setSelectedLead(null);
          }}
          onReplied={() => {
            // Ответ отправлен → оптимистично «Отвечено» в списке и в детальной
            // карточке, не дожидаясь перезагрузки (раньше до reload было «не
            // понятно, отвечал или нет»).
            setLeads((prev) => prev.map((l) => (
              l.id === selectedLead.id
                ? { ...l, is_answered: true, is_unread: false }
                : l
            )));
            setSelectedLead((lead) => (lead
              ? { ...lead, is_answered: true, is_unread: false }
              : lead));
          }}
        />
      </div>
    );
  }

  const hasFilter = status !== 'all' || query.length > 0;

  return (
    <div className="mx-auto max-w-5xl">
      <header className="mb-6 sm:mb-8">
        <p className="ds-eyebrow mb-2">
          01<span aria-hidden> → </span>Входящие
        </p>
        <h1 className="text-xl sm:text-2xl font-extrabold" style={{ color: 'var(--cp-paper)' }}>
          Ответы
        </h1>
        <p className="mt-1 text-xs sm:text-sm" style={{ color: 'var(--cp-paper-mute)' }}>
          Все ответы получателей по вашим кампаниям
        </p>
      </header>

      {/* Filter strip — status toggle + search. Both wired to URL params so
          a filtered view is shareable and browser back walks the filters. */}
      <div className="mb-5 flex flex-col sm:flex-row sm:items-center gap-3">
        <div
          className="flex gap-1.5 shrink-0"
          role="tablist"
          aria-label="Фильтр ответов"
        >
          {(['all', 'unread', 'answered', 'leads'] as const).map((s) => {
            const active = status === s;
            return (
              <button
                key={s}
                type="button"
                onClick={() => setStatusFilter(s)}
                role="tab"
                aria-selected={active}
                className="px-3 py-1.5 text-xs font-semibold rounded-md transition-colors"
                style={
                  active
                    ? {
                        color: 'var(--cp-paper)',
                        background: 'var(--cp-surface-elev)',
                        border: '1px solid var(--cp-divider-strong)',
                      }
                    : {
                        color: 'var(--cp-paper-mute)',
                        background: 'transparent',
                        border: '1px solid var(--cp-divider)',
                      }
                }
              >
                {STATUS_LABEL[s]}
              </button>
            );
          })}
        </div>
        <div className="sm:flex-1 relative">
          <Search
            className="absolute left-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 pointer-events-none"
            style={{ color: 'var(--cp-paper-faint)' }}
            aria-hidden
          />
          <input
            type="search"
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            placeholder="Поиск по email, имени, теме или тексту"
            className="neu-inset w-full rounded-md pl-9 pr-9 py-1.5 text-xs focus:outline-none"
            style={{ color: 'var(--cp-paper)' }}
            aria-label="Поиск по ответам"
          />
          {searchInput && (
            <button
              type="button"
              onClick={clearSearch}
              className="absolute right-2 top-1/2 -translate-y-1/2 p-1 rounded-md"
              style={{ color: 'var(--cp-paper-faint)' }}
              aria-label="Очистить поиск"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
      </div>

      {error && (
        <div
          className="neu-inset mb-6 rounded-xl px-5 py-3.5 text-sm font-medium"
          style={{ color: 'var(--cp-red)' }}
        >
          {error}
        </div>
      )}

      {loading ? (
        <div className="flex items-center justify-center py-16">
          <p className="text-sm" style={{ color: 'var(--cp-text-m)' }}>Загрузка...</p>
        </div>
      ) : leads.length === 0 ? (
        hasFilter ? (
          // Filtered empty — explain filter context, offer a clear-all CTA.
          <div className="neu-card py-10 text-center px-6">
            <MessageSquare
              className="mx-auto h-6 w-6 mb-3"
              style={{ color: 'var(--cp-paper-faint)' }}
              aria-hidden
            />
            <p className="text-sm font-bold mb-1" style={{ color: 'var(--cp-paper)' }}>
              {status === 'unread'
                ? 'Нет непрочитанных ответов'
                : status === 'answered'
                  ? 'Нет отвеченных переписок'
                  : status === 'leads'
                    ? 'В этой выборке нет помеченных лидов'
                    : query
                      ? `Ничего не найдено по запросу «${query}»`
                      : 'Ничего не найдено'}
            </p>
            <p className="text-xs mb-4" style={{ color: 'var(--cp-paper-mute)' }}>
              Попробуйте изменить фильтр или сбросить поиск.
            </p>
            <button
              type="button"
              onClick={clearAll}
              className="neu-pill inline-flex items-center gap-1.5 px-4 py-2 text-xs font-semibold"
              style={{ color: 'var(--cp-paper)' }}
            >
              <X className="h-3 w-3" aria-hidden />
              Сбросить фильтр
            </button>
          </div>
        ) : (
          // Cold empty — no inbox activity at all yet.
          <div className="neu-card py-12 sm:py-16 text-center px-6">
            <MessageSquare
              className="mx-auto h-8 w-8 mb-3"
              style={{ color: 'var(--cp-paper-faint)' }}
              aria-hidden
            />
            <p className="text-base sm:text-lg font-bold mb-2" style={{ color: 'var(--cp-paper)' }}>
              Ответов пока нет
            </p>
            <p className="text-xs sm:text-sm max-w-md mx-auto mb-5" style={{ color: 'var(--cp-paper-mute)' }}>
              Ответы появятся здесь после того, как получатели ваших кампаний напишут вам.
              Когда ответ выглядит перспективным, откройте диалог и пометьте его как лид.
            </p>
            <Link
              href={'/client/launch' as Route}
              className="neu-btn inline-flex items-center gap-2 px-5 py-2.5 text-sm font-semibold"
            >
              <Send className="h-4 w-4" aria-hidden />
              Создать кампанию
            </Link>
          </div>
        )
      ) : (
        <>
          <p className="text-xs font-semibold mb-3" style={{ color: 'var(--cp-text-l)' }}>
            {hasFilter ? 'В выборке: ' : 'Всего ответов: '}
            <span className="ds-mono tabular-nums">{total}</span>
          </p>
          <div className="space-y-3">
            {leads.map((lead) => (
              <LeadCard
                key={lead.id}
                lead={lead}
                onClick={() => {
                  // Открытие переписки помечает её прочитанной на сервере (/thread);
                  // оптимистично гасим «непрочитано» и в открываемой карточке (её
                  // статус-бейдж иначе показал бы stale «Непрочитано»), и в строке
                  // списка (чтобы по «назад» не висело непрочитанным до перезагрузки).
                  setSelectedLead(lead.is_unread ? { ...lead, is_unread: false } : lead);
                  if (lead.is_unread) {
                    setLeads((prev) => prev.map((l) => (
                      l.id === lead.id ? { ...l, is_unread: false } : l
                    )));
                  }
                }}
              />
            ))}
          </div>

          {total > LIMIT && (
            <div className="mt-6 flex items-center justify-between">
              <button
                onClick={() => setOffset(Math.max(0, offset - LIMIT))}
                disabled={offset === 0}
                className="neu-pill px-4 py-2 text-xs font-semibold disabled:opacity-30"
                style={{ color: 'var(--cp-text-m)' }}
              >
                ← Назад
              </button>
              <span className="text-xs ds-mono" style={{ color: 'var(--cp-text-l)' }}>
                {offset + 1}–{Math.min(offset + LIMIT, total)} из {total}
              </span>
              <button
                onClick={() => offset + LIMIT < total && setOffset(offset + LIMIT)}
                disabled={offset + LIMIT >= total}
                className="neu-pill px-4 py-2 text-xs font-semibold disabled:opacity-30"
                style={{ color: 'var(--cp-text-m)' }}
              >
                Далее →
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}

/**
 * Suspense wrapper required because useSearchParams() opts the route into
 * client rendering and Next.js 16 wants an explicit boundary at the route
 * level — otherwise build warns and the page CSR-flickers on cold nav.
 */
export default function ClientLeadsPage() {
  return (
    <Suspense
      fallback={
        <div className="mx-auto max-w-5xl">
          <div className="flex items-center justify-center py-16">
            <p className="text-sm" style={{ color: 'var(--cp-text-m)' }}>Загрузка...</p>
          </div>
        </div>
      }
    >
      <RepliesPageContent />
    </Suspense>
  );
}
