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
type DroppedLead = { email: string; bucket: 'interested' | 'referral'; ageDays: number; campaign: string };
type SegmentRoiRow = { segment: string; sent: number; ratePerSent: number; ciLow: number; ciHigh: number };
type SegmentRoi = { recommendation: string; best: { segment: string; rate: number }; worst: { segment: string; rate: number }; all: SegmentRoiRow[] };
type CopyFinding = { text: string; affected: number };
type CopyInsights = { campaignsAnalyzed: number; defaults: CopyFinding[]; hypotheses: CopyFinding[] };
type Insights = {
  generatedAt: string;
  campaigns: CampaignMetric[];
  totals: { repliers: number; positive: number; labeled: number; labelCoverage: number | null };
  weekly: { week: string; sent: number; replies: number }[];
  findings: Finding[];
  droppedLeads: { interested: number; referral: number; items: DroppedLead[] };
  segmentRoi: SegmentRoi | null;
  copyInsights: CopyInsights | null;
  notes: string[];
};

const pct = (x: number | null, d = 1) => (x == null ? '—' : `${(x * 100).toFixed(d)}%`);

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
                <tr className="text-[11px] uppercase tracking-wide text-gray-400">
                  <th className="pb-2 pr-4 text-left font-medium">Кампания</th>
                  <th className="pb-2 px-4 text-right font-medium whitespace-nowrap">Отправок</th>
                  <th className="pb-2 px-4 text-right font-medium whitespace-nowrap">Reply&nbsp;rate</th>
                  <th className="pb-2 px-4 text-right font-medium whitespace-nowrap">
                    Lead&nbsp;rate <span className="text-emerald-500" title="выше — лучше">↑</span>
                  </th>
                  <th className="pb-2 pl-4 text-right font-medium whitespace-nowrap">
                    Bounce <span className="text-amber-500" title="ниже — лучше">↓</span>
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-50">
                {data.campaigns.map((c) => (
                  <tr key={c.campaignId} className="align-top text-gray-700">
                    <td className="py-2.5 pr-4 max-w-[240px]">
                      <div className="truncate text-gray-900" title={c.name}>{c.name}</div>
                      {c.status && <div className="text-[10px] text-gray-400">{c.status}</div>}
                    </td>
                    <td className="py-2.5 px-4 text-right tabular-nums whitespace-nowrap">
                      {c.universe === 'email' ? c.sentRetained.toLocaleString('ru-RU') : <span className="text-gray-300" title="история отправок стёрта ретеншеном">—</span>}
                    </td>
                    <td className="py-2.5 px-4 text-right tabular-nums whitespace-nowrap">
                      {c.replyRate != null ? (
                        <>
                          <div>{pct(c.replyRate)}</div>
                          {c.replyRateCi && <div className="text-[10px] text-gray-400">{pct(c.replyRateCi[0])}–{pct(c.replyRateCi[1])}</div>}
                        </>
                      ) : (
                        <span className="text-gray-300" title={`нужно ≥200 отправок (есть ${c.sentRetained})`}>мало данных</span>
                      )}
                    </td>
                    <td className="py-2.5 px-4 text-right tabular-nums whitespace-nowrap">
                      {c.leadRate != null ? (
                        <>
                          <div className={c.leadRate >= 0.1 ? 'font-semibold text-emerald-600' : ''}>{pct(c.leadRate, 0)}</div>
                          {c.leadRateCi && <div className="text-[10px] font-normal text-gray-400">{pct(c.leadRateCi[0], 0)}–{pct(c.leadRateCi[1], 0)}</div>}
                        </>
                      ) : (
                        <span className="text-gray-300" title={`нужно ≥20 размеченных (есть ${c.labeled})`}>мало данных</span>
                      )}
                    </td>
                    <td className="py-2.5 pl-4 text-right tabular-nums whitespace-nowrap">
                      {c.bounceRate != null ? (
                        <span className={c.bounceRate > 0.05 ? 'font-semibold text-amber-600' : ''}>{pct(c.bounceRate)}</span>
                      ) : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* A) dropped hot leads — the chase worklist */}
          {(data.droppedLeads.interested + data.droppedLeads.referral) > 0 && (
            <div className="rounded-lg border border-rose-200 bg-rose-50/50 p-3">
              <div className="flex items-center justify-between">
                <p className="text-sm font-semibold text-rose-800">
                  🔥 Брошенные горячие лиды: {data.droppedLeads.interested + data.droppedLeads.referral}
                </p>
                <span className="text-[10px] text-rose-400">за 30 дней · перезвонить/ответить</span>
              </div>
              <p className="mt-0.5 text-[11px] text-rose-500/90">
                ответили «интересно» ({data.droppedLeads.interested}) или дали контакт ({data.droppedLeads.referral}) — а мы им так и не ответили.
              </p>
              <ul className="mt-2 space-y-1">
                {data.droppedLeads.items.map((d, i) => (
                  <li key={i} className="flex items-center justify-between gap-2 text-xs">
                    <div className="flex min-w-0 items-center gap-1.5">
                      <span className={`shrink-0 rounded px-1 py-0.5 text-[9px] font-medium ${d.bucket === 'interested' ? 'bg-rose-100 text-rose-700' : 'bg-amber-100 text-amber-700'}`}>
                        {d.bucket === 'interested' ? 'интерес' : 'контакт'}
                      </span>
                      <span className="truncate font-medium text-gray-800">{d.email}</span>
                      <span className="truncate text-gray-400" title={d.campaign}>· {d.campaign}</span>
                    </div>
                    <span className="shrink-0 tabular-nums text-gray-400">{d.ageDays}д назад</span>
                  </li>
                ))}
              </ul>
              {(data.droppedLeads.interested + data.droppedLeads.referral) > data.droppedLeads.items.length && (
                <p className="mt-1.5 text-[10px] text-rose-400">…показаны 25 самых свежих из {data.droppedLeads.interested + data.droppedLeads.referral}.</p>
              )}
            </div>
          )}

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

          {/* I) within-client segment ROI — where to source the next list */}
          {data.segmentRoi && (
            <div className="rounded-lg border border-emerald-200 bg-emerald-50/50 p-3">
              <p className="text-sm font-semibold text-emerald-800">🎯 Куда собирать следующий список</p>
              <p className="mt-0.5 text-xs text-emerald-700">{data.segmentRoi.recommendation}</p>
              <ul className="mt-2 space-y-1">
                {data.segmentRoi.all.map((s, i) => (
                  <li key={i} className="flex items-center justify-between gap-2 text-xs">
                    <span className="truncate text-gray-700">{s.segment}</span>
                    <span className="shrink-0 tabular-nums text-gray-500">
                      {pct(s.ratePerSent)}<span className="ml-1 text-[10px] text-gray-400">[{pct(s.ciLow)}–{pct(s.ciHigh)}]</span>
                    </span>
                  </li>
                ))}
              </ul>
              <p className="mt-1.5 text-[10px] text-emerald-500/80">лидов на отправку по вашим прошлым спискам · корреляция, не A/B · не переносится на других клиентов</p>
            </div>
          )}

          {/* copy insights — data-backed defaults + A/B hypotheses on the first email */}
          {data.copyInsights && (data.copyInsights.defaults.length > 0 || data.copyInsights.hypotheses.length > 0) && (
            <div className="rounded-lg border border-indigo-200 bg-indigo-50/40 p-3">
              <p className="text-sm font-semibold text-indigo-800">✍️ Копи-инсайты по первому письму</p>
              <p className="mt-0.5 text-[10px] text-indigo-500/80">
                разобрано {data.copyInsights.campaignsAnalyzed} кампаний проекта · проценты — бенчмарк по всему датасету, не замер этого проекта
              </p>
              {data.copyInsights.defaults.length > 0 && (
                <div className="mt-2 space-y-1.5">
                  {data.copyInsights.defaults.map((c, i) => (
                    <div key={i} className="flex gap-2 text-xs">
                      <span
                        className="mt-0.5 shrink-0 rounded bg-indigo-100 px-1.5 py-0.5 text-[9px] font-semibold text-indigo-700"
                        title="сигнал держится при контроле на сегмент — можно принять по умолчанию"
                      >
                        дефолт
                      </span>
                      <span className="text-gray-700">{c.text}</span>
                    </div>
                  ))}
                </div>
              )}
              {data.copyInsights.hypotheses.length > 0 && (
                <div className="mt-2 space-y-1.5">
                  {data.copyInsights.hypotheses.map((c, i) => (
                    <div key={i} className="flex gap-2 text-xs">
                      <span
                        className="mt-0.5 shrink-0 rounded bg-amber-100 px-1.5 py-0.5 text-[9px] font-semibold text-amber-700"
                        title="кросс-сегментный сигнал, внутри сегмента нестабилен — проверять within-campaign A/B"
                      >
                        гипотеза · A/B
                      </span>
                      <span className="text-gray-700">{c.text}</span>
                    </div>
                  ))}
                </div>
              )}
              <p className="mt-1.5 text-[10px] text-indigo-500/80">
                длина держится при контроле на сегмент (дефолт); опенер и остальное — кросс-сегментный сигнал, нестабильный внутри сегмента (гипотеза для A/B). Причинно только within-campaign A/B.
              </p>
            </div>
          )}

          {/* notes */}
          {data.notes.map((n, i) => (
            <p key={i} className="text-xs text-gray-400">{n}</p>
          ))}

          <p className="text-[10px] leading-relaxed text-gray-400">
            <span className="font-medium text-emerald-600">Lead rate</span> зелёным — высокий = хорошо ·{' '}
            <span className="font-medium text-amber-600">Bounce</span> оранжевым — выше&nbsp;5% = проблема списка/доставляемости.
            <br />
            Под каждой долей — её 95% доверительный интервал. «Мало данных» = ниже порога достоверности (честный отказ, не ноль).
            Находки: грейд <span className="font-medium">A</span> — причинный (A/B внутри кампании), <span className="font-medium">B</span> — корреляционный.
          </p>
        </div>
      )}
    </div>
  );
}
