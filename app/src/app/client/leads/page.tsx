'use client';

import { useState, useEffect, useCallback } from 'react';
import { clientApiFetch } from '@/lib/clientFetcher';

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

  const loadComments = useCallback(async () => {
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
  }, [lead.id]);

  useEffect(() => {
    loadComments();
  }, [loadComments]);

  const handleSubmit = async () => {
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
        className="neu-pill px-3 py-1.5 text-xs font-semibold mb-6"
        style={{ color: 'var(--cp-text-m)' }}
      >
        ← Назад к лидам
      </button>

      <div className="neu-card p-5 sm:p-8 mb-6">
        <div className="flex items-start justify-between gap-4 mb-6">
          <div>
            <h2 className="text-xl sm:text-2xl font-extrabold" style={{ color: 'var(--cp-text)' }}>
              {lead.lead_name || lead.lead_email}
            </h2>
            {lead.company_name && (
              <p className="text-sm mt-0.5" style={{ color: 'var(--cp-text-m)' }}>
                {lead.company_name}
              </p>
            )}
          </div>
          <span
            className="neu-pill px-3 py-1.5 text-[11px] font-bold shrink-0"
            style={{ color: 'var(--cp-accent)' }}
          >
            {formatDate(lead.reply_timestamp ?? lead.created_at)}
          </span>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3 mb-6">
          <InfoRow label="Email" value={lead.lead_email} />
          {lead.phone && <InfoRow label="Телефон" value={lead.phone} />}
          {lead.website && <InfoRow label="Сайт" value={lead.website} />}
          {lead.linkedin_url && <InfoRow label="LinkedIn" value={lead.linkedin_url} />}
          {lead.campaign_name && <InfoRow label="Кампания" value={lead.campaign_name} />}
        </div>

        {lead.last_outbound_preview && (
          <div className="mb-4">
            <p className="text-[11px] font-semibold uppercase tracking-wider mb-2" style={{ color: 'var(--cp-text-l)' }}>
              Наше последнее письмо
            </p>
            <div className="neu-inset rounded-xl p-4 sm:p-5 text-sm whitespace-pre-wrap max-h-48 overflow-y-auto" style={{ color: 'var(--cp-text-m)' }}>
              {lead.last_outbound_preview}
            </div>
          </div>
        )}

        <div className="mb-2">
          <p className="text-[11px] font-semibold uppercase tracking-wider mb-2" style={{ color: 'var(--cp-text-l)' }}>
            Ответ лида{lead.reply_subject ? `: ${lead.reply_subject}` : ''}
          </p>
          <div className="neu-inset rounded-xl p-4 sm:p-5 text-sm whitespace-pre-wrap max-h-64 overflow-y-auto" style={{ color: 'var(--cp-text)' }}>
            {lead.reply_body ?? '(пусто)'}
          </div>
        </div>
      </div>

      <div className="neu-card p-5 sm:p-8">
        <h3 className="text-base font-extrabold mb-5" style={{ color: 'var(--cp-text)' }}>
          Комментарии
        </h3>

        {loadingComments ? (
          <p className="text-xs py-4 text-center" style={{ color: 'var(--cp-text-l)' }}>Загрузка...</p>
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
                  <span className="text-[10px]" style={{ color: 'var(--cp-text-l)' }}>
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
            style={{ color: 'var(--cp-text)', background: 'var(--cp-inset, rgba(180,173,164,0.08))' }}
          />
          <button
            onClick={handleSubmit}
            disabled={!newComment.trim() || submitting}
            className="neu-btn rounded-xl px-4 py-2.5 text-sm font-semibold disabled:opacity-40 transition-opacity"
            style={{ color: 'var(--cp-accent)' }}
          >
            {submitting ? '...' : 'Отправить'}
          </button>
        </div>
      </div>
    </div>
  );
}

function InfoRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="neu-sm rounded-lg p-3">
      <p className="text-[10px] font-semibold uppercase tracking-wider mb-0.5" style={{ color: 'var(--cp-text-l)' }}>
        {label}
      </p>
      <p className="text-sm font-medium break-all" style={{ color: 'var(--cp-text)' }}>
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

  return (
    <button onClick={onClick} className="neu-sm block w-full text-left p-4 sm:p-5 transition-shadow hover:shadow-md">
      <div className="flex items-start justify-between gap-3 mb-2">
        <div className="min-w-0">
          <p className="text-sm font-bold truncate" style={{ color: 'var(--cp-text)' }}>
            {lead.lead_name || lead.lead_email}
          </p>
          {lead.company_name && (
            <p className="text-xs truncate mt-0.5" style={{ color: 'var(--cp-text-m)' }}>
              {lead.company_name}
            </p>
          )}
        </div>
        <span className="text-[10px] shrink-0 whitespace-nowrap" style={{ color: 'var(--cp-text-l)' }}>
          {formatDate(lead.reply_timestamp ?? lead.created_at)}
        </span>
      </div>

      <p className="text-xs truncate mb-2" style={{ color: 'var(--cp-text-m)' }}>
        {lead.lead_email}
        {lead.campaign_name && <span style={{ color: 'var(--cp-text-l)' }}> · {lead.campaign_name}</span>}
      </p>

      {(lead.reply_subject || lead.reply_body) && (
        <p className="text-xs truncate" style={{ color: 'var(--cp-text-l)' }}>
          {lead.reply_subject && <span className="font-semibold">{lead.reply_subject}: </span>}
          {lead.reply_body?.slice(0, 120) ?? ''}
        </p>
      )}

      {commentCount > 0 && (
        <div className="mt-2 flex items-center gap-1">
          <span className="text-[10px] font-semibold" style={{ color: 'var(--cp-accent)' }}>
            💬 {commentCount} {commentCount === 1 ? 'комментарий' : commentCount < 5 ? 'комментария' : 'комментариев'}
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
      <div className="mb-6 sm:mb-8">
        <h1 className="text-xl sm:text-2xl font-extrabold">Лиды</h1>
        <p className="mt-1 text-xs sm:text-sm" style={{ color: 'var(--cp-text-m)' }}>
          Квалифицированные лиды по вашим кампаниям
        </p>
      </div>

      {error && (
        <div className="neu-inset mb-6 rounded-2xl px-5 py-3.5 text-sm font-medium" style={{ color: 'var(--cp-danger, #dc2626)' }}>
          {error}
        </div>
      )}

      {loading ? (
        <div className="flex items-center justify-center py-16">
          <p className="text-sm" style={{ color: 'var(--cp-text-m)' }}>Загрузка...</p>
        </div>
      ) : leads.length === 0 ? (
        <div className="neu-card py-16 text-center">
          <p className="text-lg font-bold mb-2" style={{ color: 'var(--cp-text)' }}>Лидов пока нет</p>
          <p className="text-sm" style={{ color: 'var(--cp-text-m)' }}>
            Когда специалист передаст вам квалифицированного лида, он появится здесь
          </p>
        </div>
      ) : (
        <>
          <p className="text-xs font-semibold mb-3" style={{ color: 'var(--cp-text-l)' }}>
            Всего: {total}
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
                className="neu-pill px-4 py-2 text-xs font-semibold disabled:opacity-30"
                style={{ color: 'var(--cp-text-m)' }}
              >
                ← Назад
              </button>
              <span className="text-xs" style={{ color: 'var(--cp-text-l)' }}>
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
