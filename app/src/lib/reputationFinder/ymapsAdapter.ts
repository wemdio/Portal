import 'server-only';

import { supabaseAdmin } from '@/lib/supabaseAdmin';
import type { ReputationCandidate, PrimarySource } from './scoring';

export interface YmapsFilterConfig {
  maxRating: number;
  minReviews: number;
  cities?: string[];
  categories?: string[];
  ymapsJobIds?: string[];
}

interface YmapsOrgRow {
  id: string;
  job_id: string;
  name: string | null;
  city: string | null;
  rating: string | null;
  reviews_count: string | null;
  website: string | null;
  card_url: string | null;
  categories: string | null;
}

/**
 * Fetch organizations from already-parsed Yandex Maps jobs
 * that match the low-rating filter criteria.
 */
export async function fetchLowRatedOrganizations(
  config: YmapsFilterConfig,
): Promise<YmapsOrgRow[]> {
  if (!supabaseAdmin) throw new Error('Supabase admin not configured');

  let query = supabaseAdmin
    .from('yandex_maps_organizations')
    .select('id, job_id, name, city, rating, reviews_count, website, card_url, categories')
    .not('name', 'is', null)
    .not('rating', 'is', null);

  if (config.ymapsJobIds?.length) {
    query = query.in('job_id', config.ymapsJobIds);
  }

  if (config.cities?.length) {
    query = query.in('city', config.cities);
  }

  const { data, error } = await query.limit(2000);
  if (error) throw new Error(`yandex_maps_organizations query: ${error.message}`);

  return (data ?? []).filter((row) => {
    const rating = parseFloat(row.rating ?? '');
    const reviews = parseInt(row.reviews_count ?? '', 10);
    if (isNaN(rating) || isNaN(reviews)) return false;
    if (rating > config.maxRating) return false;
    if (reviews < config.minReviews) return false;

    if (config.categories?.length) {
      const cats = (row.categories ?? '').toLowerCase();
      const match = config.categories.some((c) => cats.includes(c.toLowerCase()));
      if (!match) return false;
    }

    return true;
  });
}

export function ymapsOrgToCandidate(
  jobId: string,
  org: YmapsOrgRow,
): ReputationCandidate {
  const rating = parseFloat(org.rating ?? '') || 0;
  const reviewsCount = parseInt(org.reviews_count ?? '', 10) || 0;

  return {
    id: crypto.randomUUID(),
    jobId,
    company: org.name ?? '',
    city: org.city,
    category: org.categories,
    sourceMode: 'local_reviews',
    primarySource: 'yandex_maps' as PrimarySource,
    primarySourceUrl: org.card_url,
    website: org.website,
    rating,
    reviewsCount,
    negativeReviews30d: estimateNegativeReviews(rating, reviewsCount, 30),
    negativeReviews90d: estimateNegativeReviews(rating, reviewsCount, 90),
    unansweredNegativeReviews: 0,
    negativeSerpResultsTop10: 0,
    issueThemes: [],
    proofUrls: org.card_url ? [`${org.card_url}/reviews`] : [],
    proofSnippets: [],
    collectedAt: new Date().toISOString(),
    secondSourceConfirmed: false,
  };
}

/**
 * Estimate negative reviews from rating + total count.
 * Yandex Maps doesn't expose per-month breakdowns in the org card,
 * so we use a statistical heuristic:
 *   rating 4.0 → ~20% negative, 3.0 → ~40%, 2.0 → ~60%
 */
function estimateNegativeReviews(
  rating: number,
  totalReviews: number,
  dayWindow: number,
): number {
  if (totalReviews === 0 || rating >= 4.5) return 0;
  const negativeRatio = Math.max(0, (4.5 - rating) / 2.5);
  const totalNeg = Math.round(totalReviews * negativeRatio);
  const dailyRate = totalNeg / 365;
  return Math.round(dailyRate * dayWindow);
}
