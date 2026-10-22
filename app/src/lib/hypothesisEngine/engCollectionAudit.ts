import { createHash } from 'node:crypto';
import type { HeEngQualificationMemo } from './engCompanyQualificationPolicy';

/**
 * New adaptive ENG bases retain only the exact passages cited by the two
 * decisions once a whole wave is finished. Full acceptance evidence, country
 * proofs, reasons and paid history are independent fields and stay unchanged.
 * The marker makes clear that this is no longer the complete model input.
 *
 * Call only when committing a finished adaptive round, never as a migration or
 * inside a live qualification checkpoint. Any unfinished model work is left
 * untouched, including its source material and interrupted request marker.
 */
export function compactHeEngCollectionQualificationMemo(
  memo: HeEngQualificationMemo,
): HeEngQualificationMemo {
  if (memo.economy?.inFlight || memo.economy?.inFlights?.length || Object.keys(memo.economy?.prepared ?? {}).length > 0 ||
      Object.keys(memo.economy?.proposals ?? {}).length > 0) return memo;

  let changed = false;
  const verdicts = Object.fromEntries(Object.entries(memo.verdicts).map(([key, verdict]) => {
    const audit = verdict.audit;
    if (!audit || audit.compaction) return [key, verdict];
    const citedIds = new Set([
      ...(audit.classifier?.quoteIds ?? []),
      ...(audit.review?.quoteIds ?? []),
    ]);
    const quotes = audit.quotes.filter((quote) => citedIds.has(quote.id));
    if (quotes.length === audit.quotes.length) return [key, verdict];
    changed = true;
    return [key, {
      ...verdict,
      audit: {
        ...audit,
        quotes,
        compaction: {
          version: 1 as const,
          strategy: 'decision_quotes' as const,
          originalQuoteCount: audit.quotes.length,
          originalQuotesSha256: createHash('sha256').update(JSON.stringify(audit.quotes)).digest('hex'),
        },
      },
    }];
  }));
  return changed ? { ...memo, verdicts } : memo;
}
