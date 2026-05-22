'use client';

import { useState, useEffect, useCallback } from 'react';
import Link from 'next/link';
import type { Route } from 'next';
import { Send, ChevronDown } from 'lucide-react';
import { clientApiFetch } from '@/lib/clientFetcher';

interface Lead {
  email: string;
  first_name: string | null;
  last_name: string | null;
  company_name: string | null;
  website: string | null;
  linkedin_url: string | null;
}

interface CampaignGroup {
  id: string;
  name: string;
  leads_count: number;
  leads_synced_at: string | null;
  leads: Lead[];
}

interface BasesResponse {
  campaigns: CampaignGroup[];
}

export default function ClientBasesPage() {
  const [campaigns, setCampaigns] = useState<CampaignGroup[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [search, setSearch] = useState('');
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const data = await clientApiFetch<BasesResponse>('/bases');
      setCampaigns(data.campaigns ?? []);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Ошибка загрузки';
      setError(msg.length > 200 || msg.includes('<') ? 'Ошибка загрузки данных. Попробуйте позже.' : msg);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const toggle = (id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const totalLeads = campaigns.reduce((s, c) => s + c.leads_count, 0);

  const filtered = search.trim()
    ? campaigns
        .map((c) => {
          const q = search.toLowerCase();
          const matchedLeads = c.leads.filter((l) =>
            [l.email, l.first_name, l.last_name, l.company_name]
              .filter(Boolean)
              .join(' ')
              .toLowerCase()
              .includes(q),
          );
          return matchedLeads.length > 0
            ? { ...c, leads: matchedLeads, leads_count: matchedLeads.length }
            : null;
        })
        .filter(Boolean) as CampaignGroup[]
    : campaigns;

  const lastSyncAt = campaigns.reduce<string | null>((latest, c) => {
    if (!c.leads_synced_at) return latest;
    if (!latest) return c.leads_synced_at;
    return c.leads_synced_at > latest ? c.leads_synced_at : latest;
  }, null);

  return (
    <div className="mx-auto max-w-5xl">
      <header className="mb-6 sm:mb-8 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <div>
          <h1
            className="text-xl sm:text-2xl font-bold m-0"
            style={{ color: 'var(--cp-paper)' }}
          >
            Базы
          </h1>
          <p
            className="ds-mono text-xs sm:text-sm mt-1"
            style={{ color: 'var(--cp-paper-mute)' }}
          >
            {totalLeads > 0
              ? `${totalLeads.toLocaleString('ru-RU')} контактов в ${campaigns.length} ${campaigns.length === 1 ? 'кампании' : 'кампаниях'}`
              : 'Контакты из ваших кампаний'}
          </p>
        </div>
        {lastSyncAt && (
          <p
            className="ds-mono text-[11px] sm:text-xs shrink-0"
            style={{ color: 'var(--cp-paper-faint)' }}
          >
            обновлено {new Date(lastSyncAt).toLocaleDateString('ru-RU')}{' '}
            {new Date(lastSyncAt).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })}
          </p>
        )}
      </header>

      <div className="mb-4 sm:mb-6 sm:max-w-sm">
        <input
          type="text"
          placeholder="Поиск по email, имени, компании…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="ds-input w-full text-sm"
        />
      </div>

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
        <div className="flex items-center justify-center py-24">
          <div className="neu-spinner animate-spin" />
        </div>
      ) : filtered.length === 0 && totalLeads === 0 ? (
        <div className="neu-card py-12 sm:py-16 text-center px-6">
          <Send
            className="mx-auto h-8 w-8 mb-3"
            style={{ color: 'var(--cp-paper-faint)' }}
            aria-hidden
          />
          <p
            className="text-base sm:text-lg font-bold mb-2"
            style={{ color: 'var(--cp-paper)' }}
          >
            Контакты ещё не загружены
          </p>
          <p
            className="text-xs sm:text-sm max-w-md mx-auto mb-5"
            style={{ color: 'var(--cp-paper-mute)' }}
          >
            На этой странице видно базы внутри уже запущенных кампаний.
            Создайте первую кампанию — её база появится здесь автоматически.
          </p>
          <Link
            href={'/client/launch' as Route}
            className="ds-btn-primary inline-flex items-center gap-2 px-5"
          >
            <Send className="h-4 w-4" aria-hidden />
            Создать кампанию
          </Link>
        </div>
      ) : filtered.length === 0 ? (
        <div className="neu-card py-16 text-center">
          <p className="text-sm" style={{ color: 'var(--cp-paper-mute)' }}>
            Ничего не найдено
          </p>
        </div>
      ) : (
        <div className="space-y-4">
          {filtered.map((c) => {
            const isOpen = expanded.has(c.id);
            return (
              <div key={c.id} className="neu-card overflow-hidden">
                <button
                  onClick={() => toggle(c.id)}
                  className="ds-card-pressable w-full flex items-center justify-between px-4 py-3 sm:px-6 sm:py-4 text-left"
                  aria-expanded={isOpen}
                >
                  <div className="min-w-0 flex-1 mr-3">
                    <p
                      className="text-sm sm:text-base font-semibold truncate m-0"
                      style={{ color: 'var(--cp-paper)' }}
                    >
                      {c.name}
                    </p>
                    <p
                      className="ds-mono text-[10px] sm:text-xs mt-0.5"
                      style={{ color: 'var(--cp-paper-faint)' }}
                    >
                      {c.leads_synced_at
                        ? `синхр. ${new Date(c.leads_synced_at).toLocaleDateString('ru-RU')} ${new Date(c.leads_synced_at).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })}`
                        : 'ожидает синхронизации'}
                    </p>
                  </div>
                  <div className="flex items-center gap-3 shrink-0">
                    <span
                      className="ds-mono text-xs font-semibold"
                      style={{ color: 'var(--cp-paper-mute)' }}
                    >
                      {c.leads_count.toLocaleString('ru-RU')}
                    </span>
                    <ChevronDown
                      className="h-4 w-4 transition-transform"
                      style={{
                        transform: isOpen ? 'rotate(180deg)' : 'rotate(0deg)',
                        color: 'var(--cp-paper-faint)',
                      }}
                      aria-hidden
                    />
                  </div>
                </button>

                {isOpen && c.leads.length > 0 && (
                  <>
                    {/* Desktop table */}
                    <div
                      className="hidden sm:block overflow-x-auto"
                      style={{ borderTop: '1px solid var(--cp-divider)' }}
                    >
                      <table className="w-full text-sm">
                        <thead>
                          <tr style={{ background: 'var(--cp-surface-elev)' }}>
                            <th className="ds-eyebrow px-6 py-3 text-left">Email</th>
                            <th className="ds-eyebrow px-6 py-3 text-left">Имя</th>
                            <th className="ds-eyebrow px-6 py-3 text-left">Компания</th>
                            <th className="ds-eyebrow px-6 py-3 text-left">Сайт</th>
                          </tr>
                        </thead>
                        <tbody>
                          {c.leads.slice(0, 200).map((l, idx) => (
                            <tr key={l.email} className="neu-row">
                              <td
                                className="ds-mono px-6 py-2.5 text-xs"
                                style={{
                                  borderTop: idx > 0 ? '1px solid var(--cp-divider)' : 'none',
                                  color: 'var(--cp-paper)',
                                }}
                              >
                                {l.email}
                              </td>
                              <td
                                className="px-6 py-2.5"
                                style={{
                                  borderTop: idx > 0 ? '1px solid var(--cp-divider)' : 'none',
                                  color: 'var(--cp-paper-mute)',
                                }}
                              >
                                {[l.first_name, l.last_name].filter(Boolean).join(' ') || '—'}
                              </td>
                              <td
                                className="px-6 py-2.5"
                                style={{
                                  borderTop: idx > 0 ? '1px solid var(--cp-divider)' : 'none',
                                  color: 'var(--cp-paper-mute)',
                                }}
                              >
                                {l.company_name || '—'}
                              </td>
                              <td
                                className="px-6 py-2.5"
                                style={{
                                  borderTop: idx > 0 ? '1px solid var(--cp-divider)' : 'none',
                                }}
                              >
                                {l.website ? (
                                  <a
                                    href={l.website.startsWith('http') ? l.website : `https://${l.website}`}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    className="ds-mono underline text-xs"
                                    style={{ color: 'var(--cp-paper)' }}
                                  >
                                    {l.website.replace(/^https?:\/\//, '').slice(0, 30)}
                                  </a>
                                ) : (
                                  <span style={{ color: 'var(--cp-paper-faint)' }}>—</span>
                                )}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                      {c.leads.length > 200 && (
                        <p
                          className="ds-mono px-6 py-3 text-xs text-center"
                          style={{ color: 'var(--cp-paper-faint)' }}
                        >
                          показано 200 из {c.leads.length.toLocaleString('ru-RU')}
                        </p>
                      )}
                    </div>

                    {/* Mobile cards */}
                    <div className="sm:hidden px-4 pb-4 space-y-2">
                      {c.leads.slice(0, 100).map((l) => (
                        <div key={l.email} className="neu-sm p-3 space-y-1">
                          <p
                            className="ds-mono text-xs font-semibold truncate m-0"
                            style={{ color: 'var(--cp-paper)' }}
                          >
                            {l.email}
                          </p>
                          <p className="text-[10px] m-0" style={{ color: 'var(--cp-paper-mute)' }}>
                            {[l.first_name, l.last_name].filter(Boolean).join(' ') || '—'}
                            {l.company_name ? ` · ${l.company_name}` : ''}
                          </p>
                        </div>
                      ))}
                      {c.leads.length > 100 && (
                        <p
                          className="ds-mono text-[10px] text-center pt-1"
                          style={{ color: 'var(--cp-paper-faint)' }}
                        >
                          показано 100 из {c.leads.length.toLocaleString('ru-RU')}
                        </p>
                      )}
                    </div>
                  </>
                )}

                {isOpen && c.leads.length === 0 && (
                  <div
                    className="px-6 py-8 text-center"
                    style={{ borderTop: '1px solid var(--cp-divider)' }}
                  >
                    <p className="text-xs" style={{ color: 'var(--cp-paper-faint)' }}>
                      Контакты ещё не загружены. Данные обновляются автоматически.
                    </p>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
