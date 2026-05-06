'use client';

import { useState, useEffect, useCallback } from 'react';
import { ChevronDown, Search } from 'lucide-react';
import { authFetch } from '@/lib/authFetch';
import { useUser } from '@/lib/UserProvider';

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

export default function OurBasesPage() {
  const { locale } = useUser();
  const [campaigns, setCampaigns] = useState<CampaignGroup[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [search, setSearch] = useState('');
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const res = await authFetch('/api/tools/our-bases');
      if (!res.ok) throw new Error('Ошибка загрузки');
      const data = (await res.json()) as BasesResponse;
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

  const isEn = locale === 'en';

  return (
    <div className="space-y-6 text-left max-w-full">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">
            {isEn ? 'Our Lead Database' : 'Наша база баз'}
          </h1>
          <p className="text-sm text-gray-500 mt-1">
            {totalLeads > 0
              ? isEn
                ? `${totalLeads} contacts in ${campaigns.length} campaigns`
                : `${totalLeads} контактов в ${campaigns.length} кампаниях`
              : isEn
                ? 'Contacts from all campaigns'
                : 'Контакты из всех кампаний'}
          </p>
        </div>
        {lastSyncAt && (
          <p className="text-xs text-gray-400 shrink-0">
            {isEn ? 'Updated' : 'Обновлено'}{' '}
            {new Date(lastSyncAt).toLocaleDateString(isEn ? 'en-US' : 'ru-RU')}{' '}
            {new Date(lastSyncAt).toLocaleTimeString(isEn ? 'en-US' : 'ru-RU', { hour: '2-digit', minute: '2-digit' })}
          </p>
        )}
      </div>

      <div className="relative sm:max-w-sm">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400" />
        <input
          type="text"
          placeholder={isEn ? 'Search by email, name, company...' : 'Поиск по email, имени, компании...'}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="w-full rounded-lg border border-gray-200 bg-white py-2.5 pl-10 pr-4 text-sm text-gray-900 placeholder:text-gray-400 focus:border-blue-300 focus:outline-none focus:ring-1 focus:ring-blue-300"
        />
      </div>

      {error && (
        <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {error}
        </div>
      )}

      {loading ? (
        <div className="space-y-4">
          {[1, 2, 3].map((i) => (
            <div key={i} className="rounded-2xl border border-gray-200 bg-gray-50 p-6 animate-pulse">
              <div className="h-5 w-60 bg-gray-200 rounded mb-2" />
              <div className="h-4 w-32 bg-gray-200 rounded" />
            </div>
          ))}
        </div>
      ) : filtered.length === 0 && totalLeads === 0 ? (
        <div className="rounded-2xl border border-gray-200 bg-gray-50 py-16 text-center">
          <p className="text-sm text-gray-500">
            {isEn
              ? 'No contacts loaded yet. Data refreshes automatically every hour.'
              : 'Контакты ещё не загружены. Данные обновляются автоматически каждый час.'}
          </p>
        </div>
      ) : filtered.length === 0 ? (
        <div className="rounded-2xl border border-gray-200 bg-gray-50 py-16 text-center">
          <p className="text-sm text-gray-500">{isEn ? 'Nothing found' : 'Ничего не найдено'}</p>
        </div>
      ) : (
        <div className="space-y-4">
          {filtered.map((c) => {
            const isOpen = expanded.has(c.id);
            return (
              <div key={c.id} className="rounded-2xl border border-gray-200 bg-white overflow-hidden">
                <button
                  onClick={() => toggle(c.id)}
                  className="w-full flex items-center justify-between px-5 py-4 sm:px-6 sm:py-5 text-left hover:bg-gray-50 transition-colors"
                >
                  <div className="min-w-0 flex-1 mr-3">
                    <p className="text-sm sm:text-base font-semibold text-gray-900 truncate">{c.name}</p>
                    <p className="text-[11px] sm:text-xs text-gray-400 mt-0.5">
                      {c.leads_synced_at
                        ? `${isEn ? 'Synced' : 'Синхр.'} ${new Date(c.leads_synced_at).toLocaleDateString(isEn ? 'en-US' : 'ru-RU')} ${new Date(c.leads_synced_at).toLocaleTimeString(isEn ? 'en-US' : 'ru-RU', { hour: '2-digit', minute: '2-digit' })}`
                        : isEn ? 'Awaiting sync' : 'Ожидает синхронизации'}
                    </p>
                  </div>
                  <div className="flex items-center gap-3 shrink-0">
                    <span className="inline-flex items-center rounded-full bg-blue-100 text-blue-700 px-2.5 py-0.5 text-xs font-semibold">
                      {c.leads_count}
                    </span>
                    <ChevronDown
                      className={`h-4 w-4 text-gray-400 transition-transform ${isOpen ? 'rotate-180' : ''}`}
                    />
                  </div>
                </button>

                {isOpen && c.leads.length > 0 && (
                  <>
                    {/* Desktop table */}
                    <div className="hidden sm:block overflow-x-auto border-t border-gray-100">
                      <table className="w-full text-sm">
                        <thead>
                          <tr className="bg-gray-50">
                            <th className="px-6 py-3 text-left text-[11px] font-semibold uppercase tracking-wider text-gray-400">Email</th>
                            <th className="px-6 py-3 text-left text-[11px] font-semibold uppercase tracking-wider text-gray-400">{isEn ? 'Name' : 'Имя'}</th>
                            <th className="px-6 py-3 text-left text-[11px] font-semibold uppercase tracking-wider text-gray-400">{isEn ? 'Company' : 'Компания'}</th>
                            <th className="px-6 py-3 text-left text-[11px] font-semibold uppercase tracking-wider text-gray-400">{isEn ? 'Website' : 'Сайт'}</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-gray-100">
                          {c.leads.slice(0, 200).map((l) => (
                            <tr key={l.email} className="hover:bg-gray-50 transition-colors">
                              <td className="px-6 py-2.5 font-mono text-xs text-gray-900">{l.email}</td>
                              <td className="px-6 py-2.5 text-gray-500">
                                {[l.first_name, l.last_name].filter(Boolean).join(' ') || '—'}
                              </td>
                              <td className="px-6 py-2.5 text-gray-500">{l.company_name || '—'}</td>
                              <td className="px-6 py-2.5">
                                {l.website ? (
                                  <a
                                    href={l.website.startsWith('http') ? l.website : `https://${l.website}`}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    className="text-blue-600 hover:text-blue-700 underline text-xs"
                                  >
                                    {l.website.replace(/^https?:\/\//, '').slice(0, 30)}
                                  </a>
                                ) : '—'}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                      {c.leads.length > 200 && (
                        <p className="px-6 py-3 text-xs text-center text-gray-400">
                          {isEn
                            ? `Showing 200 of ${c.leads.length}`
                            : `Показано 200 из ${c.leads.length}`}
                        </p>
                      )}
                    </div>

                    {/* Mobile cards */}
                    <div className="sm:hidden px-4 pb-4 space-y-2 border-t border-gray-100 pt-3">
                      {c.leads.slice(0, 100).map((l) => (
                        <div key={l.email} className="rounded-lg border border-gray-100 bg-gray-50 p-3 space-y-1">
                          <p className="font-mono text-xs font-semibold text-gray-900 truncate">{l.email}</p>
                          <p className="text-[11px] text-gray-500">
                            {[l.first_name, l.last_name].filter(Boolean).join(' ') || '—'}
                            {l.company_name ? ` · ${l.company_name}` : ''}
                          </p>
                        </div>
                      ))}
                      {c.leads.length > 100 && (
                        <p className="text-[11px] text-center text-gray-400 pt-1">
                          {isEn
                            ? `Showing 100 of ${c.leads.length}`
                            : `Показано 100 из ${c.leads.length}`}
                        </p>
                      )}
                    </div>
                  </>
                )}

                {isOpen && c.leads.length === 0 && (
                  <div className="px-6 py-8 text-center border-t border-gray-100">
                    <p className="text-xs text-gray-400">
                      {isEn
                        ? 'No contacts loaded yet. Data refreshes automatically.'
                        : 'Контакты ещё не загружены. Данные обновляются автоматически.'}
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
