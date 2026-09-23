import { createHash } from 'node:crypto';
import { z } from 'zod';
import { veRelevanceDecisionSchema } from './relevanceDecision';
import { veRelevanceReviewResultSchema } from './relevanceReview';
import { veTriageRubricSchema } from './relevanceTriage';

const hashSchema = z.string().regex(/^[a-f0-9]{64}$/);
const websiteEvidenceSchema = z.object({
  // Old pending extracts predate identity verification and must be refetched.
  reader_version: z.literal(1).optional(),
  // Additive discovery revision: older workers can still parse identity-checked
  // evidence and paid verdicts during rollback/rolling deployment.
  reader_revision: z.union([z.literal(2), z.literal(3), z.literal(4)]).optional(),
  status: z.enum(['ok', 'unavailable', 'error']),
  // Keep text only while refinement is pending. Completed checks retain their
  // attempt marker, not thousands of full website extracts in every DB write.
  text: z.string().max(6000),
  url: z.string().max(1000),
  reason: z.string().max(400),
  provider_error: z.object({
    kind: z.enum(['billing', 'configuration', 'transient']),
    message: z.string().max(400),
  }).optional(),
  // Сколько раз поиск по этой компании уже оплачен и не дал ответа. Поле
  // добавлено 16.09.2026: без счётчика каждый перезапуск этапа заново покупал
  // поиск по одним и тем же провалившимся строкам. Optional — старые
  // чекпоинты читаются прежними и новыми воркерами при раскатке и откате.
  provider_error_attempts: z.number().int().nonnegative().max(1000).optional(),
  /** Bounded retries of a timed-out website, distinct from paid-search failures. */
  read_error_attempts: z.number().int().nonnegative().max(1000).optional(),
  search_deferred: z.literal(true).optional(),
  review_attempt: hashSchema,
  review_attempts: z.number().int().nonnegative(),
  refined: z.boolean(),
});
export const relevanceFailureCodeSchema = z.enum([
  'billing', 'configuration', 'invalid_response', 'invalid_evidence', 'timeout', 'provider', 'limit', 'missing_context',
]);
export type VeRelevanceFailureCode = z.infer<typeof relevanceFailureCodeSchema>;

const checkpointSchema = z.object({
  version: z.literal(2),
  context_hash: hashSchema,
  // Hashes cover company identity AND the original fields shown to the model.
  // Supplemental website facts use that same immutable key in website_evidence.
  // Explanations retain bounded evidence, never email addresses or raw responses.
  verdicts: z.record(hashSchema, veRelevanceDecisionSchema),
  website_evidence: z.record(hashSchema, websiteEvidenceSchema).default({}),
  // A durable reservation prevents a crash/retry from repaying the same repair.
  // Website text remains in website_evidence only until this outcome is saved.
  citation_repairs: z.record(hashSchema, z.object({
    input_hash: hashSchema,
    review_attempt: hashSchema.optional(),
    status: z.enum(['started', 'finished']),
    // Preserve provider failures separately from a single unsupported citation.
    failure_code: relevanceFailureCodeSchema.optional(),
    /** Explicit 429: this proposal has not consumed its citation repair yet. */
    retry_proposal: z.object({ status: z.enum(['relevant', 'irrelevant', 'needs_review']),
      reason: z.string().min(1).max(400) }).optional(),
  })).default({}),
  // Reserve each paid attempt before HTTP. Legacy started/failed records count
  // as one attempt; recovery may buy at most one isolated follow-up.
  semantic_reviews: z.record(hashSchema, z.object({
    company_key: hashSchema,
    proposal: veRelevanceDecisionSchema,
    status: z.enum(['pending', 'started', 'finished', 'failed']),
    attempts: z.number().int().min(0).max(2).optional(),
    result: veRelevanceReviewResultSchema.optional(),
    failure_code: relevanceFailureCodeSchema.optional(),
    // Версия правил отбора, по которой оплачена попытка; нет поля — версия 1.
    // Добавочное поле: старый воркер его просто отбросит.
    rules: z.number().int().positive().optional().catch(undefined),
    // Разовая перепроверка по новым правилам: отказ DeepSeek здесь решает
    // вторая модель. Добавочное поле, старый воркер его отбросит.
    recheck: z.literal(true).optional().catch(undefined),
    // Попытка, оборванная остановкой воркера (ни ответа, ни ошибки модели),
    // уже один раз возвращена. Добавочное поле, старый воркер его отбросит.
    interrupted: z.literal(true).optional().catch(undefined),
  })).default({}),
  semantic_review_refs: z.record(hashSchema, hashSchema).default({}),
  // One paid checklist per hypothesis for the calibrated triage. Optional and
  // self-healing: an unreadable value is dropped and regenerated, never a
  // reason to discard the paid verdicts stored next to it.
  triage: z.object({ version: z.number().int().positive(), rubric: veTriageRubricSchema }).optional().catch(undefined),
  // Companies the fast check has read without deciding and that have no saved
  // verdict yet (bit 1: source facts, bit 2: website text). A stopped pass must
  // not buy the same fast check again; entries leave once a verdict is saved.
  triage_seen: z.object({ version: z.number().int().positive(), keys: z.record(hashSchema, z.number().int().min(1).max(3)) }).optional().catch(undefined),
  // Вероятность целевой деятельности, которую быстрая проверка выставила
  // компании, ОСТАВШЕЙСЯ без вердикта. Само по себе ничего не решает и никого
  // не отклоняет — это материал для решения, стоит ли покупать таким компаниям
  // платный поиск сайта: сейчас поиск покупается всем подряд, а окупается
  // верным сайтом лишь в 2.9% записей.
  triage_activity: z.record(hashSchema, z.number().min(0).max(1)).optional().catch(undefined),
  // The paid checklist call failed this many times for this hypothesis context.
  triage_rubric_failures: z.number().int().nonnegative().max(1000).optional().catch(undefined),
  failures: z.array(z.object({
    batch_hash: hashSchema,
    companies: z.number().int().positive(),
    code: relevanceFailureCodeSchema,
  })).max(100),
});

export type VeRelevanceCheckpoint = z.infer<typeof checkpointSchema>;

export function relevanceHash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

export function readRelevanceCheckpoint(value: unknown, contextHash: string): VeRelevanceCheckpoint {
  for (const candidate of (Array.isArray(value) ? value : [value]).slice(0, 3)) {
    const parsed = checkpointSchema.safeParse(candidate);
    if (parsed.success && parsed.data.context_hash === contextHash) return parsed.data;
  }
  return { version: 2, context_hash: contextHash, verdicts: {}, website_evidence: {}, citation_repairs: {},
    semantic_reviews: {}, semantic_review_refs: {}, failures: [] };
}

/** Do not swallow a failed durable write and proceed to another paid batch. */
export class VeRelevanceCheckpointError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VeRelevanceCheckpointError';
  }
}

/** A newer writer owns the base; the old worker must not record a failure. */
export class VePreviewCheckpointConflict extends VeRelevanceCheckpointError {
  constructor(message: string) {
    super(message);
    this.name = 'VePreviewCheckpointConflict';
  }
}
