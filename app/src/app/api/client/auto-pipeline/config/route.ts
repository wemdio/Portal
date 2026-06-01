import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { requireClientAuth, jsonError, demoReadonlyError } from '@/lib/clientApiHelper';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { supabaseInstantly } from '@/lib/supabaseInstantly';
import { logAudit, logError } from '@/lib/loggerServer';
import { buildCampaignPayloadFromPreset } from '@/lib/clientLaunch/buildCampaignPayload';
import { createCampaign, updateCampaign } from '@/lib/instantly/client';
import { upsertInstantlyCatalogFromCampaign } from '@/lib/tools/instantlyCampaignCatalog';
import { resolveInstantlyAccountId } from '@/lib/instantly/accounts';
import type {
  ClientCampaignPreset,
  ClientLaunchSequence,
  ClientLaunchSequenceStep,
  ClientLaunchSequenceVariant,
} from '@/lib/clientLaunch/types';
import type { ScoreBucket } from '@/lib/jobs/autoPipelineRunner';

export const dynamic = 'force-dynamic';
export const maxDuration = 90;

// ── Types для UI ─────────────────────────────────────────────────────────

interface BucketInput {
  id: string | null;
  label: string;
  /** Inclusive lower bound. */
  score_min: number;
  /** Inclusive upper bound. null = «и выше» (open-ended top range). */
  score_max: number | null;
  /** Sequence the client authored. Empty steps array = store-only bucket. */
  sequence: ClientLaunchSequence;
}

interface PutBody {
  score_buckets?: unknown;
}

interface ConfigResponse {
  enabled: boolean;
  endpoint_configured: boolean;
  score_buckets: ScoreBucket[];
  has_bootstrapped: boolean;
}

// ── Validation ───────────────────────────────────────────────────────────

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function coerceVariants(raw: unknown): ClientLaunchSequenceVariant[] {
  if (!Array.isArray(raw)) return [];
  const result: ClientLaunchSequenceVariant[] = [];
  for (const v of raw) {
    if (!isPlainObject(v)) continue;
    const subject = typeof v.subject === 'string' ? v.subject : '';
    const body = typeof v.body === 'string' ? v.body : '';
    if (subject.trim() === '' && body.trim() === '') continue;
    result.push({ subject, body });
  }
  return result;
}

function coerceStep(raw: unknown): ClientLaunchSequenceStep | null {
  if (!isPlainObject(raw)) return null;
  const subject = typeof raw.subject === 'string' ? raw.subject : '';
  const body = typeof raw.body === 'string' ? raw.body : '';
  const waitRaw = Number(raw.wait_days);
  const wait_days = Number.isFinite(waitRaw) ? Math.max(0, Math.floor(waitRaw)) : 0;
  if (subject.trim() === '' && body.trim() === '') return null;
  const variants = coerceVariants(raw.variants);
  return {
    subject,
    body,
    wait_days,
    ...(variants.length > 0 ? { variants } : {}),
  };
}

function coerceBucket(raw: unknown): BucketInput | { error: string } {
  if (!isPlainObject(raw)) return { error: 'Bucket is not an object' };
  const minRaw = Number(raw.score_min);
  if (!Number.isFinite(minRaw)) return { error: 'Bucket score_min is required' };

  const maxRaw = raw.score_max;
  let score_max: number | null;
  if (maxRaw === null || maxRaw === undefined || maxRaw === '') {
    score_max = null;
  } else {
    const n = Number(maxRaw);
    if (!Number.isFinite(n)) return { error: 'Bucket score_max must be a number or null' };
    score_max = n;
  }

  if (score_max !== null && minRaw > score_max) {
    return { error: `Bucket: score_min (${minRaw}) > score_max (${score_max})` };
  }

  const label = typeof raw.label === 'string' ? raw.label.trim() : '';
  if (!label) return { error: 'Bucket label is required' };

  const seqRaw = isPlainObject(raw.sequence) ? raw.sequence : {};
  const name = typeof seqRaw.name === 'string' && seqRaw.name.trim() ? seqRaw.name.trim() : label;
  const stepsRaw = Array.isArray(seqRaw.steps) ? seqRaw.steps : [];
  const steps: ClientLaunchSequenceStep[] = [];
  for (const s of stepsRaw) {
    const step = coerceStep(s);
    if (step) steps.push(step);
  }

  return {
    id: typeof raw.id === 'string' ? raw.id : null,
    label,
    score_min: minRaw,
    score_max,
    sequence: { name, steps },
  };
}

// ── DB helpers ───────────────────────────────────────────────────────────

interface ConfigRow {
  id: string;
  enabled: boolean;
  endpoint_url: string | null;
  endpoint_api_key: string | null;
  score_buckets: ScoreBucket[] | unknown;
}

function normalizeStoredBuckets(raw: unknown): ScoreBucket[] {
  if (!Array.isArray(raw)) return [];
  const result: ScoreBucket[] = [];
  for (const b of raw) {
    if (isPlainObject(b)) result.push(b as unknown as ScoreBucket);
  }
  return result;
}

async function loadConfigRow(clientUserId: string): Promise<ConfigRow | null> {
  if (!supabaseAdmin) return null;
  const { data, error } = await supabaseAdmin
    .from('client_auto_pipeline_configs')
    .select('id, enabled, endpoint_url, endpoint_api_key, score_buckets')
    .eq('client_user_id', clientUserId)
    .maybeSingle();
  if (error || !data) return null;
  return data as ConfigRow;
}

// ── GET — load current state for UI ──────────────────────────────────────

export async function GET(req: NextRequest) {
  const result = await requireClientAuth(req);
  if ('error' in result) return result.error;

  const { userId } = result.auth;
  if (!supabaseAdmin) return jsonError('Server misconfigured', 500);

  const row = await loadConfigRow(userId);
  if (!row) {
    const response: ConfigResponse = {
      enabled: false,
      endpoint_configured: false,
      score_buckets: [],
      has_bootstrapped: false,
    };
    return NextResponse.json(response);
  }

  const buckets = normalizeStoredBuckets(row.score_buckets);
  const response: ConfigResponse = {
    enabled: Boolean(row.enabled),
    endpoint_configured: Boolean(row.endpoint_url),
    score_buckets: buckets,
    has_bootstrapped: buckets.some((b) => Boolean(b.instantly_campaign_id)),
  };
  return NextResponse.json(response);
}

// ── PUT — client saves their bucket sequences ────────────────────────────

export async function PUT(req: NextRequest) {
  const result = await requireClientAuth(req);
  if ('error' in result) return result.error;
  if (result.auth.isDemo) return demoReadonlyError();

  const { userId } = result.auth;
  if (!supabaseAdmin) return jsonError('Server misconfigured', 500);
  if (!supabaseInstantly) return jsonError('Server misconfigured', 500);

  let body: PutBody;
  try {
    body = (await req.json()) as PutBody;
  } catch {
    return jsonError('Invalid body', 400);
  }

  const row = await loadConfigRow(userId);
  if (!row) {
    return jsonError(
      'Авто-пайплайн ещё не настроен. Обратитесь к менеджеру для подключения.',
      400,
    );
  }
  if (!row.enabled) {
    return jsonError(
      'Авто-пайплайн отключён администратором. Обратитесь к менеджеру.',
      400,
    );
  }

  // Validate buckets up-front.
  const rawBuckets = Array.isArray(body.score_buckets) ? body.score_buckets : [];
  if (rawBuckets.length === 0) {
    return jsonError('Нужно задать хотя бы один диапазон score', 400);
  }
  const validated: BucketInput[] = [];
  for (const raw of rawBuckets) {
    const coerced = coerceBucket(raw);
    if ('error' in coerced) {
      return jsonError(coerced.error, 400);
    }
    validated.push(coerced);
  }

  // Сортируем по score_min — это и для UX (порядок), и для надёжного
  // overlap-detection ниже.
  validated.sort((a, b) => a.score_min - b.score_min);

  // Overlap check: bucket[i+1].score_min должен быть строго больше
  // bucket[i].score_max (или bucket[i].score_max=null означает что это
  // последний bucket и больше быть не должно).
  for (let i = 0; i < validated.length - 1; i++) {
    const cur = validated[i];
    const next = validated[i + 1];
    if (cur.score_max === null) {
      return jsonError(
        `Bucket «${cur.label}» с открытой верхней границей не может быть не последним`,
        400,
      );
    }
    if (next.score_min <= cur.score_max) {
      return jsonError(
        `Диапазоны «${cur.label}» (до ${cur.score_max}) и «${next.label}» (от ${next.score_min}) пересекаются`,
        400,
      );
    }
  }

  // Нужен пресет для buildCampaignPayloadFromPreset.
  const { data: presetRow, error: presetErr } = await supabaseInstantly
    .from('client_campaign_presets')
    .select('*')
    .eq('client_user_id', userId)
    .maybeSingle();

  if (presetErr || !presetRow) {
    return jsonError(
      'Пресет запуска не настроен. Обратитесь к менеджеру — нужно один раз настроить email-аккаунты и расписание.',
      400,
    );
  }

  const preset = presetRow as ClientCampaignPreset;
  const instantlyAccountId = resolveInstantlyAccountId(preset.instantly_account_id);
  const instantlyRequestOptions = { accountId: instantlyAccountId };

  // Сохраняем существующие campaign_id'ы по bucket.id.
  const previousById = new Map<string, ScoreBucket>();
  for (const b of normalizeStoredBuckets(row.score_buckets)) {
    if (b.id) previousById.set(b.id, b);
  }

  const finalBuckets: ScoreBucket[] = [];
  const syncErrors: string[] = [];

  for (const bucket of validated) {
    const previous = bucket.id ? previousById.get(bucket.id) : null;
    const newId = bucket.id ?? cryptoRandomId();
    const hasContent = bucket.sequence.steps.length > 0;

    let instantlyCampaignId: string | null = previous?.instantly_campaign_id ?? null;

    if (hasContent) {
      try {
        if (instantlyCampaignId) {
          // Обновляем sequence в живой кампании — клиент отредактировал
          // тексты и/или добавил/удалил шаги.
          const payload = buildCampaignPayloadFromPreset({
            preset,
            sequence: bucket.sequence,
          });
          await updateCampaign(
            instantlyCampaignId,
            { name: bucket.sequence.name, sequences: payload.sequences },
            instantlyRequestOptions,
          );
        } else {
          // Bootstrap: создаём кампанию в Instantly. Лидов не грузим —
          // подложит cron при следующем прогоне.
          const payload = buildCampaignPayloadFromPreset({
            preset,
            sequence: bucket.sequence,
          });
          const created = await createCampaign(payload, instantlyRequestOptions);
          const createdId = (created as { id?: string }).id ?? null;
          if (!createdId) throw new Error('Instantly returned campaign without id');
          instantlyCampaignId = createdId;
          await supabaseInstantly.from('client_instantly_access').upsert(
            {
              client_user_id: userId,
              resource_type: 'campaign',
              resource_id: createdId,
              instantly_account_id: instantlyAccountId,
              created_by: userId,
            },
            { onConflict: 'client_user_id,resource_type,resource_id' },
          );
          // Мгновенно в каталог (с instantly_account_id) — чтобы кампания сразу
          // появилась в портале (Кампании/Отчёты), не дожидаясь часового синка,
          // как при стандартном запуске (runLaunch). Без этого авто-кампании на
          // любом аккаунте «висели» невидимыми до следующего синк-прохода.
          await upsertInstantlyCatalogFromCampaign(created, instantlyAccountId);
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Instantly sync failed';
        await logError(
          'client.auto-pipeline.config.sync_failed',
          err,
          { userId, bucketLabel: bucket.label },
        );
        syncErrors.push(`${bucket.label}: ${msg}`);
      }
    }

    finalBuckets.push({
      id: newId,
      label: bucket.label,
      score_min: bucket.score_min,
      score_max: bucket.score_max,
      instantly_campaign_id: instantlyCampaignId,
      sequence: bucket.sequence,
    });
  }

  const { error: updateErr } = await supabaseAdmin
    .from('client_auto_pipeline_configs')
    .update({
      score_buckets: finalBuckets,
      updated_at: new Date().toISOString(),
    })
    .eq('id', row.id);

  if (updateErr) {
    await logError('client.auto-pipeline.config.update_failed', updateErr, { userId });
    return jsonError('Не удалось сохранить конфигурацию', 500);
  }

  await logAudit(
    'client.auto-pipeline.config.saved',
    'Client saved auto-pipeline buckets',
    {
      userId,
      bucketCount: finalBuckets.length,
      bootstrappedCount: finalBuckets.filter((b) => b.instantly_campaign_id).length,
      syncErrors: syncErrors.length,
    },
  );

  return NextResponse.json({
    ok: true,
    saved_buckets: finalBuckets.length,
    sync_warnings: syncErrors,
  });
}

function cryptoRandomId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `bucket-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}
