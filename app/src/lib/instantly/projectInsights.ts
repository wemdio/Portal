import 'server-only';
import { datasetQuery } from '@/lib/instantlyDataset';

/**
 * Honest campaign-insights for a project's Instantly campaigns.
 *
 * Mirrors app/scripts/instantly-dataset/campaign-health.mjs but scoped by
 * campaign_id (fast, index-backed) so it can run live per request instead of
 * via the whole-workspace v_campaign_health view.
 *
 * Principles (wiki/analyses/2026-06-11-dataset-objectivity-audit.md):
 *  - replies = DISTINCT (campaign, lead) — autoresponder dups collapsed
 *  - every rate carries a Wilson 95% CI; below min-n the rate is null (refusal)
 *  - lead = canonical outcome positive (LLM interested|referral ∪ Instantly)
 *  - causal language only for within-campaign subject A/B
 *  - NO AI at render — pure statistics over the dataset
 */

const MIN_SENT_FOR_RATE = 200;
const MIN_LABELED_FOR_LEAD = 20;
const MIN_SENT_PER_VARIANT = 1000;

// ── stats ───────────────────────────────────────────────────────────────────
function wilson(k: number, n: number): { p: number; low: number; high: number } | null {
  if (!n || n <= 0) return null;
  const z = 1.96;
  const p = k / n;
  const denom = 1 + (z * z) / n;
  const centre = p + (z * z) / (2 * n);
  const margin = z * Math.sqrt((p * (1 - p) + (z * z) / (4 * n)) / n);
  return { p, low: Math.max(0, (centre - margin) / denom), high: Math.min(1, (centre + margin) / denom) };
}

// standard normal CDF (Abramowitz-Stegun 7.1.26) for the two-proportion z-test
function normCdf(x: number): number {
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const d = 0.3989423 * Math.exp((-x * x) / 2);
  const prob =
    d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
  return x > 0 ? 1 - prob : prob;
}

function twoPropZ(k1: number, n1: number, k2: number, n2: number): { p1: number; p2: number; z: number; pValue: number } | null {
  if (!n1 || !n2) return null;
  const p1 = k1 / n1, p2 = k2 / n2, pPool = (k1 + k2) / (n1 + n2);
  const se = Math.sqrt(pPool * (1 - pPool) * (1 / n1 + 1 / n2));
  if (!se) return null;
  const z = (p1 - p2) / se;
  return { p1, p2, z, pValue: 2 * (1 - normCdf(Math.abs(z))) };
}

// ── types ───────────────────────────────────────────────────────────────────
export type CampaignMetric = {
  campaignId: string;
  name: string;
  status: string | null;
  universe: 'email' | 'snapshot_only' | 'none';
  sentRetained: number;
  repliers: number;
  labeled: number;
  positive: number;
  replyRate: number | null;
  replyRateCi: [number, number] | null;
  leadRate: number | null;
  leadRateCi: [number, number] | null;
  labelCoverage: number | null;
  bounceRate: number | null;
  lifetimeSent: number | null;
};

export type Finding = { grade: 'A' | 'B'; campaign: string; text: string };

export type ProjectInsights = {
  generatedAt: string;
  campaigns: CampaignMetric[];
  totals: { repliers: number; positive: number; labeled: number; labelCoverage: number | null };
  weekly: { week: string; sent: number; replies: number }[];
  findings: Finding[];
  notes: string[];
};

type MetricRow = {
  id: string; name: string; status: string | null;
  sent_retained: string | null; repliers: string | null; labeled: string | null; positive: string | null;
  lifetime_sent: string | null; bounced_count: string | null;
};

const ACTIVE = new Set(['active', 'paused', 'running_subsequences']);

export async function buildProjectInsights(campaignIds: string[]): Promise<ProjectInsights> {
  const ids = [...new Set(campaignIds.filter(Boolean))];
  const empty: ProjectInsights = {
    generatedAt: new Date().toISOString(),
    campaigns: [], totals: { repliers: 0, positive: 0, labeled: 0, labelCoverage: null },
    weekly: [], findings: [], notes: [],
  };
  if (ids.length === 0) return empty;

  // 1) per-campaign metrics (scoped, index-backed)
  const metricRows = await datasetQuery<MetricRow>(
    `
    WITH rf AS (
      SELECT campaign_id, lead_id,
        bool_or(i_status=1 OR ai_interest_value=1) inst_int,
        bool_or(i_status IN (-3,-1,1) OR ai_interest_value IN (-1,1)) inst_lab
      FROM raw_emails
      WHERE ue_type=2 AND lead_id IS NOT NULL AND campaign_id = ANY($1)
        AND timestamp_email BETWEEN '2025-07-01' AND now()+interval '1 day'
      GROUP BY 1,2
    ),
    outc AS (
      SELECT rf.campaign_id,
        count(*) repliers,
        count(*) FILTER (WHERE l.label IS NOT NULL OR rf.inst_lab) labeled,
        count(*) FILTER (WHERE COALESCE(l.label IN ('interested','referral'), rf.inst_int, false)) positive
      FROM rf LEFT JOIN reply_outcome_labels l USING (campaign_id, lead_id)
      GROUP BY 1
    ),
    sends AS (
      SELECT campaign_id, count(*) sent_retained
      FROM raw_emails
      WHERE ue_type=1 AND campaign_id = ANY($1)
        AND timestamp_email BETWEEN '2025-07-01' AND now()+interval '1 day'
      GROUP BY 1
    ),
    snap AS (
      SELECT DISTINCT ON (o.campaign_id) o.campaign_id, o.emails_sent_count lifetime_sent, o.bounced_count
      FROM raw_campaign_analytics_overview_snap o
      JOIN dataset_snapshots ds ON ds.id=o.snapshot_id
      WHERE o.campaign_id = ANY($1)
      ORDER BY o.campaign_id, ds.started_at DESC
    )
    SELECT c.id, left(c.name, 80) name, ls.label status,
      s.sent_retained, o.repliers, o.labeled, o.positive,
      sn.lifetime_sent, sn.bounced_count
    FROM raw_campaigns c
    LEFT JOIN lookup_campaign_status ls ON ls.value=c.status
    LEFT JOIN sends s ON s.campaign_id=c.id
    LEFT JOIN outc o ON o.campaign_id=c.id
    LEFT JOIN snap sn ON sn.campaign_id=c.id
    WHERE c.id = ANY($1)
    `,
    [ids],
  );

  const num = (v: string | null) => (v == null ? 0 : Number(v));

  const campaigns: CampaignMetric[] = metricRows.map((r) => {
    const sent = num(r.sent_retained);
    const repliers = num(r.repliers);
    const labeled = num(r.labeled);
    const positive = num(r.positive);
    const lifetimeSent = r.lifetime_sent == null ? null : Number(r.lifetime_sent);
    const bounced = r.bounced_count == null ? null : Number(r.bounced_count);
    const universe: CampaignMetric['universe'] = sent > 0 ? 'email' : lifetimeSent ? 'snapshot_only' : 'none';

    const rr = sent >= MIN_SENT_FOR_RATE ? wilson(repliers, sent) : null;
    const lr = labeled >= MIN_LABELED_FOR_LEAD ? wilson(positive, labeled) : null;
    return {
      campaignId: r.id,
      name: r.name,
      status: r.status,
      universe,
      sentRetained: sent,
      repliers, labeled, positive,
      replyRate: rr?.p ?? null,
      replyRateCi: rr ? [rr.low, rr.high] : null,
      leadRate: lr?.p ?? null,
      leadRateCi: lr ? [lr.low, lr.high] : null,
      labelCoverage: repliers > 0 ? labeled / repliers : null,
      bounceRate: lifetimeSent && lifetimeSent > 0 && bounced != null ? bounced / lifetimeSent : null,
      lifetimeSent,
    };
  });

  // 2) weekly sparkline across these campaigns (last 16 weeks)
  const weeklyRows = await datasetQuery<{ wk: string; sent: string; replies: string }>(
    `
    SELECT to_char(date_trunc('week', date), 'YYYY-MM-DD') wk,
           sum(sent)::bigint sent, sum(unique_replies)::bigint replies
    FROM v_campaign_daily_canonical
    WHERE campaign_id = ANY($1)
    GROUP BY 1 ORDER BY 1
    `,
    [ids],
  );
  const weekly = weeklyRows.slice(-16).map((w) => ({ week: w.wk, sent: Number(w.sent), replies: Number(w.replies) }));

  // 3) findings
  const findings: Finding[] = [];

  // bounce (grade B) — only for changeable (active/paused) campaigns
  for (const c of campaigns) {
    if (ACTIVE.has(c.status ?? '') && c.bounceRate != null && c.bounceRate > 0.05) {
      findings.push({
        grade: 'B', campaign: c.name,
        text: `Bounce ${(c.bounceRate * 100).toFixed(1)}% > 5% — качество списка/доставляемости. Верифицировать базу перед продолжением.`,
      });
    }
  }

  // subject A/B (grade A — causal) from the within-campaign view, resilient
  try {
    const ab = await datasetQuery<{ campaign_id: string; subject: string; sent: string; unique_replies: string }>(
      // materialized snapshot (014) — the live view scans the whole workspace (~4s);
      // A/B is a slow-changing causal result, refreshed nightly in sync.mjs.
      `SELECT campaign_id, subject, sent, unique_replies
       FROM mv_subject_ab_within_campaign
       WHERE campaign_id = ANY($1) AND step_n = 0
       ORDER BY campaign_id, sent DESC`,
      [ids],
    );
    const byCampaign = new Map<string, { subject: string; sent: number; repl: number }[]>();
    for (const r of ab) {
      const arr = byCampaign.get(r.campaign_id) ?? [];
      arr.push({ subject: r.subject, sent: Number(r.sent), repl: Number(r.unique_replies) });
      byCampaign.set(r.campaign_id, arr);
    }
    for (const [cid, variants] of byCampaign) {
      if (variants.length < 2) continue;
      const [a, b] = variants;
      if (a.sent < MIN_SENT_PER_VARIANT || b.sent < MIN_SENT_PER_VARIANT) continue;
      const t = twoPropZ(a.repl, a.sent, b.repl, b.sent);
      if (!t || t.pValue >= 0.01) continue;
      const win = t.p1 > t.p2 ? a : b;
      const lose = t.p1 > t.p2 ? b : a;
      const name = campaigns.find((c) => c.campaignId === cid)?.name ?? cid;
      findings.push({
        grade: 'A', campaign: name,
        text: `A/B темы (та же аудитория — причинный вывод): «${win.subject.slice(0, 60)}» бьёт «${lose.subject.slice(0, 60)}» — ${(Math.max(t.p1, t.p2) * 100).toFixed(1)}% vs ${(Math.min(t.p1, t.p2) * 100).toFixed(1)}% (p=${t.pValue.toExponential(1)}). Перевести трафик на победителя; подтвердить на следующей кампании.`,
      });
    }
  } catch (e) {
    console.error('[projectInsights] A/B query skipped:', (e as Error).message);
  }

  // 4) totals + notes
  const totals = campaigns.reduce(
    (acc, c) => ({ repliers: acc.repliers + c.repliers, positive: acc.positive + c.positive, labeled: acc.labeled + c.labeled }),
    { repliers: 0, positive: 0, labeled: 0 },
  );
  const notes: string[] = [];
  const snapOnly = campaigns.filter((c) => c.universe !== 'email').length;
  if (snapOnly > 0) notes.push(`${snapOnly} кампан${snapOnly === 1 ? 'ия' : 'ий'} без email-данных (история отправок стёрта ретеншеном Instantly) — по ним только lifetime-агрегаты.`);
  if (findings.length === 0) notes.push('Статистически обоснованных рекомендаций нет — это честный результат при текущем объёме, а не недоработка.');

  return {
    generatedAt: new Date().toISOString(),
    campaigns: campaigns.sort((x, y) => y.sentRetained - x.sentRetained),
    totals: { ...totals, labelCoverage: totals.repliers > 0 ? totals.labeled / totals.repliers : null },
    weekly,
    findings,
    notes,
  };
}
