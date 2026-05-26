/**
 * Pre-flight time-band estimator for base-constructor jobs.
 *
 * Calibrated against the polza@polza.ru regression (job
 * 8b188038-ddf3-41a7-ab48-35d7e43b9909): 4297 rows, full client steps
 * (3 cheap site-scrape, 1 api SMTP, 1 ai naming + clean_names) wall-
 * clocked at ~2 hours. The old «sizeFactor» formula predicted 5–15
 * минут — it ignored `cheap`-cost steps entirely, which were the
 * actual time hogs (find_emails alone fetches up to 5 pages × 15s
 * timeout per company). New formula puts `cheap` at the highest
 * per-row coefficient.
 *
 * Per-row coefficients in seconds (post-concurrency, empirical):
 *
 *   cheap: 0.5  — site scrape (check_sites, find_emails,
 *                  enrich_descriptions). High variance: ~0.1s on a
 *                  fast Cloudflare-cached homepage, up to 75s on a
 *                  dead/tarpitted host (5 pages × 15s timeout).
 *                  Median per-row, divided by concurrency=10.
 *   api:   0.2  — SMTP validation. DNS + MX + handshake. Fast on
 *                  modern hosts, slow on greylisting.
 *   ai:    0.1  — OpenRouter calls (clean_names, ta_scoring,
 *                  personalization). Hits rate limit on big runs but
 *                  batch concurrency hides most of it.
 *   free:  0    — pure JS filter/dedup, never material.
 *
 * Output: a single «central» estimate in minutes. The band shown to
 * the user (formatProcessingTimeBand) widens this with empirical
 * lo/hi multipliers to honestly reflect the variance.
 */

export interface EstimateInput {
  rows: number;
  cheapSteps: number;
  apiSteps: number;
  aiSteps: number;
}

const COEF_CHEAP_SEC_PER_ROW = 0.5;
const COEF_API_SEC_PER_ROW = 0.2;
const COEF_AI_SEC_PER_ROW = 0.1;

/**
 * Central wall-clock estimate in minutes for a given workload. Always
 * returns at least 1 minute (anything smaller is just «несколько
 * минут» of fixed setup overhead — file upload, job init, polling).
 */
export function estimateProcessingMinutes(input: EstimateInput): number {
  const seconds =
    input.rows *
    (input.cheapSteps * COEF_CHEAP_SEC_PER_ROW +
      input.apiSteps * COEF_API_SEC_PER_ROW +
      input.aiSteps * COEF_AI_SEC_PER_ROW);
  const minutes = seconds / 60;
  return Math.max(1, Math.round(minutes));
}

/**
 * Human-readable time band for the pre-flight summary line. Returns
 * an honest range (not a single number) because per-row scrape latency
 * has 10×+ variance between fast and dead hosts — we'd rather under-
 * promise and over-deliver than the other way around.
 *
 * Tiers chosen to match plausible user mental models:
 *   «несколько минут» — coffee break
 *   «5–15 / 15–30 / 30–60 минут» — leave-and-come-back, granular
 *   «1–2 / 2–4 часа» — full-on long job, plan accordingly
 *   «4+ часа» — overnight territory
 */
export function formatProcessingTimeBand(centralMinutes: number): string {
  if (centralMinutes < 2) return 'до 2 минут';
  if (centralMinutes < 5) return 'несколько минут';
  if (centralMinutes < 15) return '5–15 минут';
  if (centralMinutes < 30) return '15–30 минут';
  if (centralMinutes < 60) return '30–60 минут';
  if (centralMinutes < 120) return '1–2 часа';
  if (centralMinutes < 240) return '2–4 часа';
  return 'более 4 часов';
}
