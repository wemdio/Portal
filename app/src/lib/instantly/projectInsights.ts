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

export type DroppedLead = { email: string; ageDays: number; campaign: string };

export type SegmentRoiRow = { segment: string; sent: number; ratePerSent: number; ciLow: number; ciHigh: number };
export type SegmentRoi = {
  recommendation: string;
  best: { segment: string; rate: number };
  worst: { segment: string; rate: number };
  all: SegmentRoiRow[];
};

export type CopyFinding = { text: string; affected: number };
export type CopyInsights = { campaignsAnalyzed: number; defaults: CopyFinding[]; hypotheses: CopyFinding[] };

export type ProjectInsights = {
  generatedAt: string;
  campaigns: CampaignMetric[];
  totals: { repliers: number; positive: number; labeled: number; labelCoverage: number | null };
  weekly: { week: string; sent: number; replies: number }[];
  findings: Finding[];
  // A) брошенные горячие лиды (positive-ответ без нашего ответа), живое окно 30 дней
  droppedLeads: { count: number; items: DroppedLead[] };
  // I) сегмент-ROI внутри клиента (какую нишу собирать дальше); null = гейт не прошёл
  segmentRoi: SegmentRoi | null;
  // копи-инсайты: дефолты по данным (длина, опенер) + гипотезы для A/B; null = нет шагов
  copyInsights: CopyInsights | null;
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
    weekly: [], findings: [], droppedLeads: { count: 0, items: [] }, segmentRoi: null, copyInsights: null, notes: [],
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
    // 'snapshot_only' когда есть строка снапшота (даже lifetime_sent=0) — как v_campaign_health (по существованию строки, не по значению).
    const universe: CampaignMetric['universe'] = sent > 0 ? 'email' : lifetimeSent != null ? 'snapshot_only' : 'none';

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

  // 4) dropped hot leads (A) — interested leads whose LATEST reply to us is still unanswered.
  // "Answered" is scoped to the lead's own conversation THREAD (thread_id), NOT the email globally:
  // a reply we sent in some unrelated campaign/client must not mark this interest as handled
  // (cross-client over-exclusion, found & fixed 2026-06-22). Anchor on their LAST inbound, not the
  // first — so a lead who replied, got an answer, then wrote AGAIN unanswered correctly resurfaces.
  // Referrals excluded (phone/3rd-party contact ≠ lead here). Blind spot named in the UI: replies
  // sent from the client's own mailbox (off Instantly) aren't in the dataset.
  const dropped: { count: number; items: DroppedLead[] } = { count: 0, items: [] };
  try {
    const rows = await datasetQuery<{ email: string; age_days: string; campaign: string }>(
      `
      WITH camp_ue3 AS (SELECT DISTINCT campaign_id FROM raw_emails WHERE ue_type=3 AND campaign_id = ANY($1)),
      ue2 AS (
        SELECT campaign_id, lead_id, thread_id, timestamp_email AS reply_at,
               (i_status=1 OR ai_interest_value=1) AS inst_int_row
        FROM raw_emails
        WHERE ue_type=2 AND lead_id IS NOT NULL AND campaign_id = ANY($1)
          AND timestamp_email BETWEEN '2025-07-01' AND now() + interval '1 day'
      ),
      rf AS (
        SELECT campaign_id, lead_id, max(reply_at) AS last_reply_at, bool_or(inst_int_row) AS inst_int
        FROM ue2 GROUP BY 1, 2
      ),
      -- наш ПОСЛЕДНИЙ ответ В ТРЕДАХ этого лида (по thread_id их реплаев), не глобально по email.
      our_in_thread AS (
        SELECT u.campaign_id, u.lead_id, max(e3.timestamp_email) AS last_our_at
        FROM ue2 u JOIN raw_emails e3 ON e3.ue_type=3 AND e3.thread_id = u.thread_id
        GROUP BY 1, 2
      )
      SELECT rf.lead_id AS email,
             round(extract(epoch FROM (now()-rf.last_reply_at))/86400)::int::text AS age_days,
             left(coalesce(rc.name, ''), 60) AS campaign
      FROM rf
      JOIN camp_ue3 c ON c.campaign_id = rf.campaign_id
      LEFT JOIN raw_campaigns rc ON rc.id = rf.campaign_id
      LEFT JOIN reply_outcome_labels l ON l.campaign_id = rf.campaign_id AND l.lead_id = rf.lead_id
      LEFT JOIN our_in_thread o ON o.campaign_id = rf.campaign_id AND o.lead_id = rf.lead_id
      -- ТОЛЬКО interested (referral исключён). LLM-метка первична; Instantly-interest — только
      -- fallback для ещё не размеченных свежих ответов (<1 сут до ночного лейблера).
      WHERE COALESCE(l.label = 'interested', rf.inst_int, false)
        AND (o.last_our_at IS NULL OR o.last_our_at < rf.last_reply_at)
        AND rf.last_reply_at > now() - interval '30 days'
      ORDER BY rf.last_reply_at DESC
      `,
      [ids],
    );
    // Дедуп по email: лид, заинтересованный и неотвеченный в 2+ кампаниях, не должен считаться/
    // показываться дважды. rows уже отсортированы по свежести → берём первое вхождение.
    const seen = new Set<string>();
    const uniq = rows.filter((r) => (seen.has(r.email) ? false : (seen.add(r.email), true)));
    dropped.count = uniq.length;
    dropped.items = uniq.slice(0, 25).map((r) => ({ email: r.email, ageDays: Number(r.age_days), campaign: r.campaign }));
  } catch (e) {
    console.error('[projectInsights] dropped-leads query skipped:', (e as Error).message);
  }

  // 4b) within-client segment ROI (I) — which segment converts best for THIS project.
  // Gate (skeptic): >=2 real segments (exclude other_unclear) each sent>=500 & repliers>=20;
  // best vs worst Wilson CI on positive/sent must NOT overlap; direction must AGREE on the
  // deliverability-independent positive/replier metric. Else null (refuse). Never generalize
  // one client's winner to others — this is THEIR past lists, correlational, not an A/B.
  let segmentRoi: SegmentRoi | null = null;
  try {
    const segRows = await datasetQuery<{ segment: string; sent: string; repliers: string; positive: string }>(
      `
      WITH seg AS (
        SELECT campaign_id, segment FROM dim_campaign_segment
        WHERE campaign_id = ANY($1) AND segment IS NOT NULL AND segment <> 'other_unclear'
      ),
      sends AS (
        SELECT s.segment, count(*) AS sent
        FROM raw_emails e JOIN seg s ON s.campaign_id = e.campaign_id
        WHERE e.ue_type=1 AND e.timestamp_email BETWEEN '2025-07-01' AND now()+interval '1 day'
        GROUP BY 1
      ),
      rf AS (
        SELECT e.campaign_id, e.lead_id, bool_or(e.i_status=1 OR e.ai_interest_value=1) inst_int
        FROM raw_emails e
        WHERE e.ue_type=2 AND e.lead_id IS NOT NULL AND e.campaign_id = ANY($1)
          AND e.timestamp_email BETWEEN '2025-07-01' AND now()+interval '1 day'
        GROUP BY 1,2
      ),
      outc AS (
        SELECT s.segment, count(*) AS repliers,
          count(*) FILTER (WHERE COALESCE(l.label IN ('interested','referral'), rf.inst_int, false)) AS positive
        FROM rf JOIN seg s ON s.campaign_id = rf.campaign_id
        LEFT JOIN reply_outcome_labels l ON l.campaign_id = rf.campaign_id AND l.lead_id = rf.lead_id
        GROUP BY 1
      )
      SELECT sn.segment, sn.sent::text, o.repliers::text, o.positive::text
      FROM sends sn JOIN outc o ON o.segment = sn.segment
      WHERE sn.sent >= 500 AND o.repliers >= 20
      `,
      [ids],
    );
    const segs = segRows.map((r) => {
      const sent = Number(r.sent), repliers = Number(r.repliers), positive = Number(r.positive);
      const w = wilson(positive, sent);
      return {
        segment: r.segment, sent, repliers, positive,
        ratePerSent: w ? w.p : 0, ciLow: w ? w.low : 0, ciHigh: w ? w.high : 1,
        ratePerReplier: repliers > 0 ? positive / repliers : 0,
      };
    }).sort((a, b) => b.ratePerSent - a.ratePerSent);
    if (segs.length >= 2) {
      const best = segs[0], worst = segs[segs.length - 1];
      // CI non-overlap on per-sent AND same direction on per-replier (strips deliverability)
      if (best.ciLow > worst.ciHigh && best.ratePerReplier > worst.ratePerReplier) {
        segmentRoi = {
          recommendation: `Сегмент «${best.segment}» конвертит лучше «${worst.segment}» — ${(best.ratePerSent * 100).toFixed(1)}% против ${(worst.ratePerSent * 100).toFixed(1)}% лидов на отправку (по вашим прошлым спискам, корреляция — не A/B). Следующий список стоит брать в «${best.segment}».`,
          best: { segment: best.segment, rate: best.ratePerSent },
          worst: { segment: worst.segment, rate: worst.ratePerSent },
          all: segs.map((s) => ({ segment: s.segment, sent: s.sent, ratePerSent: s.ratePerSent, ciLow: s.ciLow, ciHigh: s.ciHigh })),
        };
      }
    }
  } catch (e) {
    console.error('[projectInsights] segment-roi skipped:', (e as Error).message);
  }

  // 4c) copy insights — objective copy checks (audit 2026-06-19): 2 data-backed
  // defaults (length<40w, greeting+early-question opener) + A/B hypotheses (hard CTA,
  // money-opener in construction). Detection over step-0 template; never causal.
  let copyInsights: CopyInsights | null = null;
  try {
    const cr = await datasetQuery<{
      segment: string | null; words: number | null; has_greeting: boolean; early_q: boolean;
      hard_cta: boolean; money: boolean;
    }>(
      String.raw`
      WITH s AS (
        SELECT campaign_id, regexp_replace(coalesce(body_text,''), '<[^>]+>', ' ', 'g') AS b
        FROM raw_campaign_steps
        WHERE step_n=0 AND variant_n=0 AND campaign_id = ANY($1)
          -- exclude empty / variables-only templates: they'd score as a false "short, no-opener"
          AND btrim(regexp_replace(regexp_replace(coalesce(body_text,''), '<[^>]+>', ' ', 'g'), '\{\{[^}]*\}\}', ' ', 'g')) <> ''
      )
      SELECT
        sg.segment,
        array_length(regexp_split_to_array(trim(regexp_replace(regexp_replace(s.b, '\{\{[^}]*\}\}', ' ', 'g'), '\s+', ' ', 'g')), ' '), 1) AS words,
        (s.b ~* '^\s*(здравствуйте|добрый день|добрый вечер|доброе утро|приветствую|привет)') AS has_greeting,
        (position('?' in left(s.b, 260)) > 0) AS early_q,
        (s.b ~* 'созвон|15.{0,4}минут|30.{0,4}минут|встреч|zoom|зум|google meet|демонстрац|презентац|на звонке|удобн.{0,10}время') AS hard_cta,
        (s.b ~* 'выручк|оборот|сэконом|[0-9]+\s?(млн|млрд|тыс)|[0-9]+\s?(рубл|руб|₽)') AS money
      FROM s LEFT JOIN dim_campaign_segment sg ON sg.campaign_id = s.campaign_id
      `,
      [ids],
    );
    if (cr.length > 0) {
      const N = cr.length;
      const longBody = cr.filter((r) => r.words != null && Number(r.words) >= 40).length;
      const veryLong = cr.filter((r) => r.words != null && Number(r.words) > 110).length;
      const noOpener = cr.filter((r) => !(r.has_greeting && r.early_q)).length;
      const hardCta = cr.filter((r) => r.hard_cta && r.segment !== 'it_software_saas').length;
      const moneyConstr = cr.filter((r) => r.money && r.segment === 'construction_realestate').length;
      const defaults: CopyFinding[] = [];
      const hypotheses: CopyFinding[] = [];
      // DEFAULT: length<40w — held in all 3 largest segments with non-overlapping Wilson CIs (re-verified 2026-06-21).
      if (longBody > 0) defaults.push({ affected: longBody, text: `Длинное первое письмо у ${longBody} из ${N} кампаний${veryLong ? ` (${veryLong} — совсем длинные, больше 110 слов)` : ''}. По всему датасету короткие письма (до 40 слов) дают больше лидов — около 22% против 17% у длинных. Сократите первое письмо до 40 слов: это работает в разных нишах.` });
      // HYPOTHESIS (not default): opener lift is carried by the greeting and is segment-dependent —
      // it dissolves in manufacturing (CIs overlap) and the early question alone doesn't help.
      if (noOpener > 0) hypotheses.push({ affected: noOpener, text: `У ${noOpener} из ${N} кампаний первое письмо не начинается с приветствия и короткого вопроса в первых 1-2 предложениях. Письма с приветствием в среднем дают больше лидов (около 21% против 17%), но не во всех нишах, а один вопрос без приветствия не помогает. Начинайте с приветствия; вопрос в начале — проверьте A/B-тестом.` });
      if (hardCta > 0) hypotheses.push({ affected: hardCta, text: `${hardCta} из ${N} кампаний просят звонок или демо уже в первом письме. В большинстве ниш это связано с меньшим числом лидов. Попробуйте перенести предложение встречи во 2-3 письмо и сравните A/B-тестом. (Исключение — IT/SaaS: там, наоборот, можно сразу.)` });
      if (moneyConstr > 0) hypotheses.push({ affected: moneyConstr, text: `${moneyConstr} кампаний начинают первое письмо с денег (выручка, суммы в рублях). В стройке и недвижимости это связано с заметно меньшим числом лидов (около 9% против 21%). Попробуйте заменить на нейтральный вопрос и сравните A/B-тестом.` });
      if (defaults.length || hypotheses.length) copyInsights = { campaignsAnalyzed: N, defaults, hypotheses };
    }
  } catch (e) {
    console.error('[projectInsights] copy-insights skipped:', (e as Error).message);
  }

  // 5) totals + notes
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
    droppedLeads: dropped,
    segmentRoi,
    copyInsights,
    notes,
  };
}
