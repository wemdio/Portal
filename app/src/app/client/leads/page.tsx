'use client';

import { useState, useEffect, useCallback } from 'react';
import Link from 'next/link';
import type { Route } from 'next';
import { Send, MessageSquare } from 'lucide-react';
import { clientApiFetch } from '@/lib/clientFetcher';
import { ExpandedThread } from '@/components/client-replies/ExpandedThread';

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

function LeadDetail({
  lead,
  onBack,
}: {
  lead: ForwardedLead;
  onBack: () => void;
}) {
  const [comments, setComments] = useState<LeadComment[]>([]);
  const [loadingComments, setLoadingComments] = useState(true);
  const [newComment, setNewComment] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const canComment = lead.source !== 'reply';
  const canReplyByEmail = Boolean(lead.campaign_id && lead.email_id);

  const loadComments = useCallback(async () => {
    if (!canComment) {
      setComments([]);
      setLoadingComments(false);
      return;
    }

    setLoadingComments(true);
    try {
      const res = await clientApiFetch<{ items: LeadComment[] }>(
        `/leads/${lead.id}/comments`,
      );
      setComments(res.items);
    } catch {
      // ignore
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
    try {
      await clientApiFetch(`/leads/${lead.id}/comments`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ comment: text }),
      });
      setNewComment('');
      loadComments();
    } catch {
      // ignore
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div>
      <button
        onClick={onBack}
        className="ds-btn-ghost inline-block mb-6 px-3 py-1.5 text-xs"
      >
        ← Назад к лидам
      </button>

      <div className="neu-card p-5 sm:p-8 mb-6">
        <div className="flex items-start justify-between gap-4 mb-6">
          <div>
            <h2
              className="text-xl sm:text-2xl font-bold m-0"
              style={{ color: 'var(--cp-paper)' }}
            >
              {lead.lead_name || lead.lead_email}
            </h2>
            {lead.company_name && (
              <p className="text-sm mt-0.5" style={{ color: 'var(--cp-paper-mute)' }}>
                {lead.company_name}
              </p>
            )}
          </div>
          <span
            className="ds-mono text-[11px] shrink-0"
            style={{ color: 'var(--cp-paper-faint)' }}
          >
            {formatDate(lead.reply_timestamp ?? lead.created_at)}
          </span>
        </div>

        {/* P1-A distill: was a grid of 5 framed `neu-sm` tiles (border + bg)
            living inside the outer `neu-card` — hairline-on-hairline. Now a
            flat 2-column definition list with generous gaps. Same info
            density, ~80px less vertical, and `dl/dt/dd` is the semantic
            HTML for the structure. */}
        <dl className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-3 mb-6">
          <InfoRow label="Email" value={lead.lead_email} />
          {lead.phone && <InfoRow label="Телефон" value={lead.phone} />}
          {lead.website && <InfoRow label="Сайт" value={lead.website} />}
          {lead.linkedin_url && <InfoRow label="LinkedIn" value={lead.linkedin_url} />}
          {lead.campaign_name && <InfoRow label="Кампания" value={lead.campaign_name} />}
        </dl>

        {/* P2-B: stripped «02 → » and «02/03 → » section numbers. Editorial-
            Numbering is for multi-step flows; these are content blocks inside
            a lead view. The conditional jump (02 vs 03 depending on whether
            outbound preview exists) also broke cross-lead consistency. Bare
            eyebrows tell the same story without the lie. */}
        {lead.last_outbound_preview && (
          <div className="mb-4">
            <p className="ds-eyebrow mb-2">наше последнее письмо</p>
            <div
              className="neu-inset rounded-md p-4 sm:p-5 text-sm whitespace-pre-wrap max-h-48 overflow-y-auto"
              style={{ color: 'var(--cp-paper-mute)' }}
            >
              {lead.last_outbound_preview}
            </div>
          </div>
        )}

        <div className="mb-2">
          <p className="ds-eyebrow mb-2">
            ответ лида
            {lead.reply_subject ? `: ${lead.reply_subject.toLowerCase()}` : ''}
          </p>
          <div
            className="neu-inset rounded-md p-4 sm:p-5 text-sm whitespace-pre-wrap max-h-64 overflow-y-auto"
            style={{ color: 'var(--cp-paper)' }}
          >
            {lead.reply_body ?? '(пусто)'}
          </div>
        </div>

        {canReplyByEmail && (
          <ExpandedThread
            campaignId={lead.campaign_id}
            emailId={lead.email_id!}
          />
        )}
      </div>

      {/* P1-B: was `{canComment && (...)}` which silently hid the entire 70-
          line comment card for reply-sourced leads. Olga opened a lead,
          expected to leave an internal note, saw nothing. Now: when
          comments aren't available for this lead source, render an
          explanatory note card pointing the user to where they should
          comment instead.
          P2-B: dropped the «04 → комментарии» eyebrow that duplicated the
          H3 «Комментарии» right below it. The H3 alone is enough. */}
      {canComment ? (
        <div className="neu-card p-5 sm:p-8">
          <h3
            className="text-base font-bold mb-5 m-0"
            style={{ color: 'var(--cp-paper)' }}
          >
            Комментарии
          </h3>

          {loadingComments ? (
            <p
              className="ds-mono text-xs py-4 text-center"
              style={{ color: 'var(--cp-paper-faint)' }}
            >
              загружаем комментарии…
            </p>
          ) : comments.length === 0 ? (
            <p
              className="text-xs py-4 text-center"
              style={{ color: 'var(--cp-paper-faint)' }}
            >
              Комментариев пока нет. Оставьте обратную связь по лиду.
            </p>
          ) : (
            <div className="space-y-3 mb-5">
              {comments.map((c) => (
                <div key={c.id} className="neu-sm rounded-md p-3">
                  <div className="flex items-center justify-between mb-1">
                    <span
                      className="text-xs font-semibold"
                      style={{ color: 'var(--cp-paper)' }}
                    >
                      {c.user_name || 'Пользователь'}
                    </span>
                    <span
                      className="ds-mono text-[10px]"
                      style={{ color: 'var(--cp-paper-faint)' }}
                    >
                      {formatDate(c.created_at)}
                    </span>
                  </div>
                  <p className="text-sm" style={{ color: 'var(--cp-paper-mute)' }}>
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
              placeholder="Напишите комментарий…"
              className="ds-input flex-1 text-sm"
            />
            <button
              onClick={handleSubmit}
              disabled={!newComment.trim() || submitting}
              className="ds-btn-primary px-4 py-2.5 text-sm disabled:opacity-40 transition-opacity"
            >
              {submitting ? '…' : 'Отправить'}
            </button>
          </div>
        </div>
      ) : (
        <div className="neu-card p-5 sm:p-8">
          <h3
            className="text-base font-bold mb-2 m-0"
            style={{ color: 'var(--cp-paper)' }}
          >
            Комментарии
          </h3>
          <p className="text-sm" style={{ color: 'var(--cp-paper-mute)' }}>
            Это лид из «Ответов» — оставляйте комментарии прямо во{' '}
            <Link
              href={'/client/replies' as Route}
              className="font-semibold underline"
              style={{ color: 'var(--cp-paper)' }}
            >
              вкладке «Ответы»
            </Link>
            , так контекст диалога останется в одном месте.
          </p>
        </div>
      )}
    </div>
  );
}

function InfoRow({ label, value }: { label: string; value: string }) {
  /* P1-A distill: dropped the inner `neu-sm rounded-md p-3` frame. The parent
     neu-card already provided the boundary; nesting another bordered cell
     for each label/value pair was hairline-on-hairline (the same anti-pattern
     just shipped on /projects and base-constructor). dl/dt/dd is the
     semantic HTML for a definition list, which is what these rows are. */
  return (
    <div>
      <dt className="ds-eyebrow mb-1">{label.toLowerCase()}</dt>
      <dd
        className="text-sm font-medium break-all m-0"
        style={{ color: 'var(--cp-paper)' }}
      >
        {value}
      </dd>
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

  // One status per row, hierarchy: this list is leads-by-definition, so the
  // "Лид" label always shines; unread amber upgrades the dot.
  const dotColor = lead.is_unread ? 'var(--cp-amber)' : 'var(--cp-green)';
  const textColor = lead.is_unread ? 'var(--cp-amber)' : 'var(--cp-green)';
  const statusLabel = lead.is_unread ? 'Непрочитано' : 'Лид';

  return (
    <button
      onClick={onClick}
      className="neu-sm ds-card-pressable block w-full text-left p-4 sm:p-5"
    >
      <div className="flex items-start justify-between gap-3 mb-2">
        <div className="min-w-0">
          {/* P2-A: font-semibold (was font-bold) — 30 bold titles in a row
              flatten cross-list hierarchy; the status dot can't reassert
              primacy if every name shouts equally. Same fix shipped on
              /projects and /client (campaigns). */}
          <p
            className="text-sm font-semibold truncate m-0"
            style={{ color: 'var(--cp-paper)' }}
          >
            {lead.lead_name || lead.lead_email}
          </p>
          {lead.company_name && (
            <p
              className="text-xs truncate mt-0.5"
              style={{ color: 'var(--cp-paper-mute)' }}
            >
              {lead.company_name}
            </p>
          )}
        </div>
        <span
          className="ds-mono text-[10px] shrink-0 whitespace-nowrap"
          style={{ color: 'var(--cp-paper-faint)' }}
        >
          {formatDate(lead.reply_timestamp ?? lead.created_at)}
        </span>
      </div>

      <div className="flex flex-wrap items-center gap-3 mb-2">
        <span className="ds-status-tag" style={{ color: textColor }}>
          <span
            aria-hidden
            className="ds-status-dot"
            style={{ background: dotColor }}
          />
          {statusLabel}
        </span>
        <p
          className="text-xs truncate min-w-0"
          style={{ color: 'var(--cp-paper-mute)' }}
        >
          {lead.lead_email}
          {lead.campaign_name && (
            <span style={{ color: 'var(--cp-paper-faint)' }}> · {lead.campaign_name}</span>
          )}
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
          <MessageSquare
            className="h-3 w-3"
            style={{ color: 'var(--cp-paper-faint)' }}
            aria-hidden
          />
          <span
            className="text-[10px] font-semibold"
            style={{ color: 'var(--cp-paper-mute)' }}
          >
            {commentCount} {commentCount === 1 ? 'комментарий' : commentCount < 5 ? 'комментария' : 'комментариев'}
          </span>
        </div>
      )}
    </button>
  );
}

export default function ClientLeadsPage() {
  const [leads, setLeads] = useState<ForwardedLead[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [selectedLead, setSelectedLead] = useState<ForwardedLead | null>(null);
  const [offset, setOffset] = useState(0);
  const LIMIT = 30;

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const data = await clientApiFetch<LeadsResponse>(
        `/leads?limit=${LIMIT}&offset=${offset}`,
      );
      setLeads(data.items);
      setTotal(data.total);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Ошибка загрузки');
    } finally {
      setLoading(false);
    }
  }, [offset]);

  useEffect(() => {
    load();
  }, [load]);

  if (selectedLead) {
    return (
      <div className="mx-auto max-w-5xl">
        <LeadDetail
          lead={selectedLead}
          onBack={() => setSelectedLead(null)}
        />
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-5xl">
      <header className="mb-6 sm:mb-8">
        {/* P2-B: page eyebrow now mirrors the sidebar section. «Лиды» is a
            page within the Мониторинг group (CLIENT_NAV_GROUPS[1] → «02»);
            the previous «01 → Лиды» put a number on the page name itself
            which was ornament (Editorial-Numbering is for multi-step flows,
            not page badges). Same alignment shipped on /client (campaigns). */}
        <p className="ds-eyebrow mb-2">
          02<span aria-hidden> → </span>Мониторинг
        </p>
        <h1
          className="text-xl sm:text-2xl font-bold m-0"
          style={{ color: 'var(--cp-paper)' }}
        >
          Квалифицированные лиды
        </h1>
        <p className="mt-1 text-xs sm:text-sm" style={{ color: 'var(--cp-paper-mute)' }}>
          Диалоги, которые вы пометили как лиды из вкладки «Ответы»
        </p>
      </header>

      {error && (
        <div
          className="neu-inset mb-6 rounded-lg px-5 py-3.5 text-sm font-medium flex items-start gap-2.5"
          role="alert"
        >
          <span
            aria-hidden
            className="ds-status-dot shrink-0"
            style={{ background: 'var(--cp-red)', marginTop: '7px' }}
          />
          <span style={{ color: 'var(--cp-paper)' }}>{error}</span>
        </div>
      )}

      {loading ? (
        <div className="flex items-center justify-center py-16">
          <p
            className="ds-mono text-xs"
            style={{ color: 'var(--cp-paper-mute)' }}
          >
            Загружаем лиды…
          </p>
        </div>
      ) : leads.length === 0 ? (
        <div className="neu-card py-12 sm:py-16 text-center px-6">
          <MessageSquare
            className="mx-auto h-8 w-8 mb-3"
            style={{ color: 'var(--cp-paper-faint)' }}
            aria-hidden
          />
          <p
            className="text-base sm:text-lg font-bold mb-2"
            style={{ color: 'var(--cp-paper)' }}
          >
            Лидов пока нет
          </p>
          <p
            className="text-xs sm:text-sm max-w-md mx-auto mb-5"
            style={{ color: 'var(--cp-paper-mute)' }}
          >
            Откройте вкладку «Ответы» и помечайте перспективные диалоги как лиды.
            Здесь будет отдельный рабочий список для дальнейшей обработки и комментариев.
          </p>
          <Link
            href={'/client/replies' as Route}
            className="ds-btn-primary inline-flex items-center gap-2 px-5"
          >
            <Send className="h-4 w-4" aria-hidden />
            Перейти к ответам
          </Link>
        </div>
      ) : (
        <>
          <p
            className="ds-mono text-xs mb-3"
            style={{ color: 'var(--cp-paper-faint)' }}
          >
            всего лидов: {total}
          </p>
          <div className="space-y-3">
            {leads.map((lead) => (
              <LeadCard
                key={lead.id}
                lead={lead}
                onClick={() => setSelectedLead(lead)}
              />
            ))}
          </div>

          {total > LIMIT && (
            <div className="mt-6 flex items-center justify-between">
              <button
                onClick={() => setOffset(Math.max(0, offset - LIMIT))}
                disabled={offset === 0}
                className="ds-btn-secondary px-4 py-2 text-xs disabled:opacity-30 disabled:cursor-not-allowed"
              >
                ← Назад
              </button>
              <span
                className="ds-mono text-xs"
                style={{ color: 'var(--cp-paper-faint)' }}
              >
                {offset + 1}–{Math.min(offset + LIMIT, total)} из {total}
              </span>
              <button
                onClick={() => offset + LIMIT < total && setOffset(offset + LIMIT)}
                disabled={offset + LIMIT >= total}
                className="ds-btn-secondary px-4 py-2 text-xs disabled:opacity-30 disabled:cursor-not-allowed"
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
