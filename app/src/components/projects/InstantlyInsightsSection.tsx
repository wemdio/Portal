'use client';

import { useEffect, useState } from 'react';

/**
 * Read-only campaign-insights panel for a project's Instantly campaigns.
 * Fetches /api/projects/[id]/insights (pure statistics over the dataset DB —
 * NO AI at render). Renders nothing for projects with no Instantly campaigns
 * or when the dataset is unavailable, so non-Instantly projects stay clean.
 */

type Ci = [number, number] | null;
type CampaignMetric = {
  campaignId: string; name: string; status: string | null;
  universe: 'email' | 'snapshot_only' | 'none';
  sentRetained: number; repliers: number; labeled: number; positive: number;
  replyRate: number | null; replyRateCi: Ci;
  leadRate: number | null; leadRateCi: Ci;
  labelCoverage: number | null; bounceRate: number | null; lifetimeSent: number | null;
};
type Finding = { grade: 'A' | 'B'; campaign: string; text: string };
type Insights = {
  generatedAt: string;
  campaigns: CampaignMetric[];
  totals: { repliers: number; positive: number; labeled: number; labelCoverage: number | null };
  weekly: { week: string; sent: number; replies: number }[];
  findings: Finding[];
  notes: string[];
};

const pct = (x: number | null, d = 1) => (x == null ? '—' : `${(x * 100).toFixed(d)}%`);
const ciLabel = (ci: Ci) => (ci ? ` [${pct(ci[0])}–${pct(ci[1])}]` : '');

function Sparkline({ values, className }: { values: number[]; className?: string }) {
  const max = Math.max(...values, 1);
  return (
    <div className={`flex items-end gap-px h-6 ${className ?? ''}`}>
      {values.map((v, i) => (
        <div
          key={i}
          className="w-1.5 rounded-sm bg-blue-400/70"
          style={{ height: `${Math.max(8, (v / max) * 100)}%` }}
          title={String(v)}
        />
      ))}
    </div>
  );
}

export function InstantlyInsightsSection({ projectId }: { projectId: string }) {
  const [data, setData] = useState<Insights | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'empty' | 'error'>('loading');

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const res = await fetch(`/api/projects/${projectId}/insights`, { credentials: 'include' });
        const json = (await res.json()) as { insights: Insights | null };
        if (!alive) return;
        if (!json.insights || json.insights.campaigns.length === 0) { setState('empty'); return; }
        setData(json.insights);
        setState('ready');
      } catch {
        if (alive) setState('error');
      }
    })();
    return () => { alive = false; };
  }, [projectId]);

  // Nothing to show for non-Instantly projects — keep the card hidden entirely.
  if (state === 'empty') return null;

  return (
    <div className="rounded-xl border border-gray-200 bg-white p-6 shadow-sm">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold uppercase tracking-wide text-gray-400">Инсайты Instantly</h3>
        <span className="text-[10px] text-gray-300">статистика датасета · без ИИ</span>
      </div>

      {state === 'loading' && (
        <div className="mt-4 animate-pulse space-y-2">
          <div className="h-4 w-2/3 rounded bg-gray-100" />
          <div className="h-20 rounded bg-gray-100" />
        </div>
      )}

      {state === 'error' && (
        <p className="mt-3 text-sm text-gray-400">Не удалось загрузить аналитику датасета.</p>
      )}

      {state === 'ready' && data && (
        <div className="mt-4 space-y-5">
          {/* totals + sparkline */}
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div className="text-sm text-gray-700">
              <span className="font-semibold text-gray-900">{data.totals.repliers}</span> ответивших ·{' '}
              <span className="font-semibold text-emerald-600">{data.totals.positive}</span> позитивных ·{' '}
              размечено {pct(data.totals.labelCoverage, 0)}
            </div>
            {data.weekly.length > 1 && (
              <div className="flex items-center gap-2">
                <span className="text-[11px] text-gray-400">отправки / нед</span>
                <Sparkline values={data.weekly.map((w) => w.sent)} />
              </div>
            )}
          </div>

          {/* per-campaign table */}
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-[11px] uppercase tracking-wide text-gray-400">
                  <th className="pb-2 font-medium">Кампания</th>
                  <th className="pb-2 font-medium text-right">Отправок</th>
                  <th className="pb-2 font-medium text-right">Reply rate</th>
                  <th className="pb-2 font-medium text-right">Lead rate</th>
                  <th className="pb-2 font-medium text-right">Bounce</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-50">
                {data.campaigns.map((c) => (
                  <tr key={c.campaignId} className="text-gray-700">
                    <td className="py-2 pr-3">
                      <span className="text-gray-900">{c.name}</span>
                      {c.status && <span className="ml-1.5 text-[10px] text-gray-400">{c.status}</span>}
                    </td>
                    <td className="py-2 text-right tabular-nums">
                      {c.universe === 'email' ? c.sentRetained.toLocaleString('ru-RU') : <span className="text-gray-300" title="история отправок стёрта ретеншеном">—</span>}
                    </td>
                    <td className="py-2 text-right tabular-nums">
                      {c.replyRate != null ? (
                        <span>{pct(c.replyRate)}<span className="text-[10px] text-gray-400">{ciLabel(c.replyRateCi)}</span></span>
                      ) : (
                        <span className="text-gray-300" title={`нужно ≥200 отправок (есть ${c.sentRetained})`}>мало данных</span>
                      )}
                    </td>
                    <td className="py-2 text-right tabular-nums">
                      {c.leadRate != null ? (
                        <span className={c.leadRate >= 0.1 ? 'text-emerald-600 font-medium' : ''}>
                          {pct(c.leadRate)}<span className="text-[10px] text-gray-400 font-normal">{ciLabel(c.leadRateCi)}</span>
                        </span>
                      ) : (
                        <span className="text-gray-300" title={`нужно ≥20 размеченных (есть ${c.labeled})`}>мало данных</span>
                      )}
                    </td>
                    <td className="py-2 text-right tabular-nums">
                      {c.bounceRate != null ? (
                        <span className={c.bounceRate > 0.05 ? 'text-amber-600 font-medium' : ''}>{pct(c.bounceRate)}</span>
                      ) : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* findings */}
          {data.findings.length > 0 && (
            <div className="space-y-2">
              <p className="text-[11px] uppercase tracking-wide text-gray-400">Находки и рекомендации</p>
              {data.findings.map((f, i) => (
                <div key={i} className="flex gap-2 text-sm">
                  <span
                    className={`mt-0.5 shrink-0 rounded px-1.5 py-0.5 text-[10px] font-semibold ${
                      f.grade === 'A' ? 'bg-emerald-50 text-emerald-700' : 'bg-amber-50 text-amber-700'
                    }`}
                    title={f.grade === 'A' ? 'причинный вывод (within-campaign A/B)' : 'корреляционный с контролем'}
                  >
                    {f.grade}
                  </span>
                  <span className="text-gray-700">
                    <span className="text-gray-400">{f.campaign}: </span>{f.text}
                  </span>
                </div>
              ))}
            </div>
          )}

          {/* notes */}
          {data.notes.map((n, i) => (
            <p key={i} className="text-xs text-gray-400">{n}</p>
          ))}

          <p className="text-[10px] text-gray-300">
            Доли с 95% доверительным интервалом. «Мало данных» = ниже порога достоверности (отказ, не ноль).
            Грейды: A — причинный, B — корреляционный.
          </p>
        </div>
      )}
    </div>
  );
}
