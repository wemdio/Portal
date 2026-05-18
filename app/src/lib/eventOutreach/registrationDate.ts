/**
 * Exact company registration dates via DaData (by INN).
 *
 * OGRN only encodes the registration year — and for companies registered
 * before EGRUL (2002) even that is wrong (their OGRN year is 2002). DaData's
 * `state.registration_date` is the real date, which lets the tool target
 * anniversaries by month, not just year.
 *
 * Called only for anniversary candidates (see isAnniversaryCandidate) to keep
 * DaData request volume low.
 */

import { findByInn, hasDadataKey } from '@/lib/enrich/dadataClient';

const CONCURRENCY = 5;

/** DaData returns state.registration_date as a millisecond timestamp. */
interface DadataState {
  registration_date?: number;
  status?: string;
}

/** Resolves exact registration dates for the given INNs. Missing/failed lookups are simply absent. */
export async function fetchRegistrationDates(inns: string[]): Promise<Map<string, Date>> {
  const result = new Map<string, Date>();
  if (!hasDadataKey()) {
    console.warn('[event-outreach] DADATA_API_KEY not set — skipping registration-date enrichment');
    return result;
  }

  const unique = [...new Set(inns.filter((x) => !!x))];

  for (let i = 0; i < unique.length; i += CONCURRENCY) {
    const batch = unique.slice(i, i + CONCURRENCY);
    const settled = await Promise.allSettled(
      batch.map(async (inn) => {
        const suggestion = await findByInn(inn);
        const state = suggestion?.data?.state as DadataState | undefined;
        const ts = state?.registration_date;
        return { inn, ts: typeof ts === 'number' && ts > 0 ? ts : null };
      }),
    );
    for (const r of settled) {
      if (r.status === 'fulfilled' && r.value.ts !== null) {
        result.set(r.value.inn, new Date(r.value.ts));
      }
    }
  }

  console.log(`[event-outreach] DaData resolved ${result.size}/${unique.length} registration dates`);
  return result;
}
