'use client';

import { useState, useEffect, useCallback } from 'react';
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
  needsSync: boolean;
  synced?: number;
}

export default function ClientBasesPage() {
  const [campaigns, setCampaigns] = useState<CampaignGroup[]>([]);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [error, setError] = useState('');
  const [search, setSearch] = useState('');
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const data = await clientApiFetch<BasesResponse>('/bases');
      setCampaigns(data.campaigns ?? []);
      if (data.needsSync) {
        doSync(false);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Ошибка загрузки');
    } finally {
      setLoading(false);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const doSync = useCallback(async (manual: boolean) => {
    setSyncing(true);
    if (manual) setError('');
    try {
      const data = await clientApiFetch<BasesResponse>('/bases/sync', { method: 'POST' });
      setCampaigns(data.campaigns ?? []);
    } catch (err) {
      if (manual) setError(err instanceof Error ? err.message : 'Ошибка синхронизации');
    } finally {
      setSyncing(false);
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

  return (
    <div className="mx-auto max-w-5xl">
      <div className="mb-6 sm:mb-8 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <div>
          <h1 className="text-xl sm:text-2xl font-extrabold">Базы</h1>
          <p className="mt-1 text-xs sm:text-sm" style={{ color: 'var(--cp-text-m)' }}>
            {totalLeads > 0
              ? `${totalLeads} контактов в ${campaigns.length} кампаниях`
              : 'Контакты из ваших кампаний'}
          </p>
        </div>
        <button
          onClick={() => doSync(true)}
          disabled={syncing}
          className="neu-btn px-4 py-2 text-xs sm:text-sm font-semibold shrink-0 disabled:opacity-50"
        >
          {syncing ? 'Синхронизация...' : 'Синхронизировать'}
        </button>
      </div>

      <div className="mb-4 sm:mb-6 sm:max-w-sm">
        <input
          type="text"
          placeholder="Поиск по email, имени, компании..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="neu-input w-full py-2 sm:py-2.5 px-3 sm:px-4 text-sm"
        />
      </div>

      {error && (
        <div className="neu-inset mb-6 rounded-2xl px-5 py-3.5 text-sm font-medium" style={{ color: 'var(--cp-danger)' }}>
          {error}
        </div>
      )}

      {loading ? (
        <div className="flex items-center justify-center py-24">
          <div className="neu-spinner animate-spin" />
        </div>
      ) : syncing && totalLeads === 0 ? (
        <div className="flex flex-col items-center justify-center py-24 gap-3">
          <div className="neu-spinner animate-spin" />
          <p className="text-sm" style={{ color: 'var(--cp-text-m)' }}>
            Первая синхронизация...
          </p>
        </div>
      ) : filtered.length === 0 && totalLeads === 0 ? (
        <div className="neu-card py-16 text-center">
          <p className="text-sm" style={{ color: 'var(--cp-text-m)' }}>
            Нет загруженных контактов. Нажмите «Синхронизировать» для загрузки.
          </p>
        </div>
      ) : filtered.length === 0 ? (
        <div className="neu-card py-16 text-center">
          <p className="text-sm" style={{ color: 'var(--cp-text-m)' }}>Ничего не найдено</p>
        </div>
      ) : (
        <div className="space-y-4">
          {filtered.map((c) => {
            const isOpen = expanded.has(c.id);
            return (
              <div key={c.id} className="neu-card overflow-hidden">
                <button
                  onClick={() => toggle(c.id)}
                  className="w-full flex items-center justify-between px-4 py-3 sm:px-6 sm:py-4 text-left hover:opacity-80 transition-opacity"
                >
                  <div className="min-w-0 flex-1 mr-3">
                    <p className="text-sm sm:text-base font-semibold truncate">{c.name}</p>
                    <p className="text-[10px] sm:text-xs mt-0.5" style={{ color: 'var(--cp-text-l)' }}>
                      {c.leads_synced_at
                        ? `Синхр. ${new Date(c.leads_synced_at).toLocaleDateString('ru-RU')} ${new Date(c.leads_synced_at).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })}`
                        : 'Не синхронизировано'}
                    </p>
                  </div>
                  <div className="flex items-center gap-3 shrink-0">
                    <span
                      className="inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-semibold"
                      style={{ background: 'var(--cp-accent)', color: '#fff' }}
                    >
                      {c.leads_count}
                    </span>
                    <span
                      className="text-sm transition-transform"
                      style={{
                        transform: isOpen ? 'rotate(180deg)' : 'rotate(0deg)',
                        color: 'var(--cp-text-l)',
                      }}
                    >
                      ▼
                    </span>
                  </div>
                </button>

                {isOpen && c.leads.length > 0 && (
                  <>
                    {/* Desktop table */}
                    <div className="hidden sm:block overflow-x-auto">
                      <table className="w-full text-sm">
                        <thead>
                          <tr style={{ borderTop: '1px solid rgba(180,173,164,0.15)' }}>
                            <th className="px-6 py-3 text-left text-[11px] font-semibold uppercase tracking-wider" style={{ color: 'var(--cp-text-l)' }}>Email</th>
                            <th className="px-6 py-3 text-left text-[11px] font-semibold uppercase tracking-wider" style={{ color: 'var(--cp-text-l)' }}>Имя</th>
                            <th className="px-6 py-3 text-left text-[11px] font-semibold uppercase tracking-wider" style={{ color: 'var(--cp-text-l)' }}>Компания</th>
                            <th className="px-6 py-3 text-left text-[11px] font-semibold uppercase tracking-wider" style={{ color: 'var(--cp-text-l)' }}>Сайт</th>
                          </tr>
                        </thead>
                        <tbody>
                          {c.leads.slice(0, 200).map((l) => (
                            <tr key={l.email} className="neu-row">
                              <td className="px-6 py-2.5 font-mono text-xs" style={{ borderTop: '1px solid rgba(180,173,164,0.1)' }}>{l.email}</td>
                              <td className="px-6 py-2.5" style={{ borderTop: '1px solid rgba(180,173,164,0.1)', color: 'var(--cp-text-m)' }}>
                                {[l.first_name, l.last_name].filter(Boolean).join(' ') || '—'}
                              </td>
                              <td className="px-6 py-2.5" style={{ borderTop: '1px solid rgba(180,173,164,0.1)', color: 'var(--cp-text-m)' }}>{l.company_name || '—'}</td>
                              <td className="px-6 py-2.5" style={{ borderTop: '1px solid rgba(180,173,164,0.1)' }}>
                                {l.website ? (
                                  <a href={l.website.startsWith('http') ? l.website : `https://${l.website}`} target="_blank" rel="noopener noreferrer" className="underline text-xs" style={{ color: 'var(--cp-accent)' }}>
                                    {l.website.replace(/^https?:\/\//, '').slice(0, 30)}
                                  </a>
                                ) : '—'}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                      {c.leads.length > 200 && (
                        <p className="px-6 py-3 text-xs text-center" style={{ color: 'var(--cp-text-l)' }}>
                          Показано 200 из {c.leads.length}
                        </p>
                      )}
                    </div>

                    {/* Mobile cards */}
                    <div className="sm:hidden px-4 pb-4 space-y-2">
                      {c.leads.slice(0, 100).map((l) => (
                        <div key={l.email} className="neu-sm p-3 space-y-1">
                          <p className="font-mono text-xs font-semibold truncate">{l.email}</p>
                          <p className="text-[10px]" style={{ color: 'var(--cp-text-m)' }}>
                            {[l.first_name, l.last_name].filter(Boolean).join(' ') || '—'}
                            {l.company_name ? ` · ${l.company_name}` : ''}
                          </p>
                        </div>
                      ))}
                      {c.leads.length > 100 && (
                        <p className="text-[10px] text-center pt-1" style={{ color: 'var(--cp-text-l)' }}>
                          Показано 100 из {c.leads.length}
                        </p>
                      )}
                    </div>
                  </>
                )}

                {isOpen && c.leads.length === 0 && (
                  <div className="px-6 py-8 text-center" style={{ borderTop: '1px solid rgba(180,173,164,0.15)' }}>
                    <p className="text-xs" style={{ color: 'var(--cp-text-l)' }}>
                      Нет контактов. Нажмите «Синхронизировать».
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
