import type { SupabaseClient } from '@supabase/supabase-js';
import type { HeCollectTask } from './prompts/sourcePlan';
import { readHeEngRegistryPage } from './engPublicRegistries';
import { validateHeEngRegistryPlan } from './engPublicRegistryPlan';
import type { HeEngRegistryCandidate, HeEngRegistryCursor, HeEngRegistryPlan } from './engPublicRegistryTypes';
import { resolveHeEngRegistryCandidate, type HeEngRegistryResolutionCheckpoint } from './engRegistryCompanyEvidence';
import type { HeEngSearchEvidenceScope } from './engSearchCompanyEvidence';
import type { HeStageContext } from './stages/shared';
import { heStageSignal } from './stages/io';
import { addHeSite, heCompanySiteIdentity, heSameCompanySite, newHeSiteSet } from './collectionIdentity';

type Row = Record<string, unknown>;
export interface HeEngRegistryState {
  plan: HeEngRegistryPlan;
  cursors: Record<string, HeEngRegistryCursor>;
  seenRecords: string[];
}

export interface HeEngRegistryWave {
  taskId: string;
  pageLoaded: boolean;
  candidates: HeEngRegistryCandidate[];
  recordsRead: number;
  resolved: number;
  rows: Row[];
  excluded: Record<string, number>;
  decisions: Array<{ provider: string; recordId: string; reason: string }>;
  resolution?: HeEngRegistryResolutionCheckpoint;
}

export function heEngRegistrySourceTasks(state?: HeEngRegistryState): HeCollectTask[] {
  return state?.plan.tasks.map(task => ({ source: 'eng_registry',
    rationale: `Public registry: ${task.provider}, ${task.country}, ${task.category}`,
    registry_query: { task_id: task.id, plan_fingerprint: state.plan.fingerprint },
  })) ?? [];
}

export function createHeEngRegistryWave(taskId: string): HeEngRegistryWave {
  return { taskId, pageLoaded: false, candidates: [], recordsRead: 0, resolved: 0, rows: [], excluded: {}, decisions: [] };
}

function bump(counts: Record<string, number>, reason: string, count = 1): void {
  counts[reason] = (counts[reason] ?? 0) + count;
}

/** One free page, followed by checkpointed website resolution in the SAME base budget. */
export async function runHeEngRegistryWave(input: {
  ctx: HeStageContext; db: SupabaseClient; baseId: string; projectId: string;
  state: HeEngRegistryState; wave: HeEngRegistryWave; task: HeCollectTask;
  scopeKey: string; scope: HeEngSearchEvidenceScope;
  excluded: (row: Row) => string | null;
  /** Caller must commit state and wave together and assert running-job ownership. */
  save: () => Promise<void>;
}): Promise<{ rows: Row[]; exhausted: boolean; error?: string }> {
  const { state, wave, ctx } = input;
  const signal = heStageSignal(ctx);
  signal?.throwIfAborted();
  validateHeEngRegistryPlan(state.plan, input.scopeKey);
  const query = input.task.registry_query;
  const task = state.plan.tasks.find(item => item.id === query?.task_id);
  if (input.task.source !== 'eng_registry' || !task || query?.plan_fingerprint !== state.plan.fingerprint ||
      wave.taskId !== task.id || !input.scope.allowedCountries.includes(task.country)) {
    throw new Error('ENG registry task does not match its frozen audience');
  }
  const cursor = state.cursors[task.id] ?? { position: 0, pages: 0, exhausted: false };
  if (!Number.isSafeInteger(cursor.position) || cursor.position < 0 ||
      !Number.isSafeInteger(cursor.pages) || cursor.pages < 0 || cursor.pages > 80 ||
      typeof cursor.exhausted !== 'boolean' || !Array.isArray(state.seenRecords) ||
      state.seenRecords.some(id => typeof id !== 'string' || id.length > 100) ||
      !Array.isArray(wave.candidates) || !Array.isArray(wave.rows) || !Array.isArray(wave.decisions) ||
      !Number.isSafeInteger(wave.resolved) || wave.resolved < 0 || wave.resolved > wave.candidates.length ||
      !Number.isSafeInteger(wave.recordsRead) || wave.recordsRead < 0 || wave.recordsRead > 200) {
    throw new Error('ENG registry checkpoint is invalid');
  }
  state.cursors[task.id] = cursor;
  if (!wave.pageLoaded && !cursor.exhausted && !cursor.unavailable) {
    if (cursor.pages >= 80 || state.seenRecords.length >= 20_000) {
      cursor.unavailable = 'registry_safety_limit';
      await input.save();
    } else {
      let page;
      try {
        page = await readHeEngRegistryPage(task, cursor.position, { signal });
      } catch (error) {
        signal?.throwIfAborted();
        if (error && typeof error === 'object' && (error as { heJobInterruption?: unknown }).heJobInterruption) throw error;
        const message = error instanceof Error ? error.message : '';
        cursor.unavailable = /^registry_[a-z0-9_]{1,60}$/.test(message) ? message : 'registry_unavailable';
        await input.save();
        return { rows: [], exhausted: false, error: cursor.unavailable };
      }
      if (!Number.isSafeInteger(page.nextPosition) || page.nextPosition < cursor.position ||
          (!page.exhausted && page.nextPosition === cursor.position) ||
          !Number.isSafeInteger(page.recordsRead) || page.recordsRead < 0 || page.recordsRead > 200 ||
          page.candidates.length > page.recordsRead) throw new Error('ENG registry page progress is invalid');
      const seen = new Set(state.seenRecords);
      for (const candidate of page.candidates) {
        if (candidate.provider !== task.provider || candidate.country !== task.country) {
          bump(wave.excluded, 'outside_registry_scope'); continue;
        }
        const id = `${candidate.provider}:${candidate.recordId}`;
        if (seen.has(id)) { bump(wave.excluded, 'duplicate_registry_record'); continue; }
        seen.add(id);
        wave.candidates.push(candidate);
      }
      state.seenRecords = [...seen];
      wave.recordsRead = page.recordsRead;
      for (const [reason, count] of Object.entries(page.excluded)) bump(wave.excluded, reason, count);
      wave.pageLoaded = true;
      cursor.position = page.nextPosition;
      cursor.pages += 1;
      cursor.exhausted = page.exhausted;
      // No paid resolution until candidates and their next source cursor are durable.
      await input.save();
    }
  }
  const seenSites = newHeSiteSet();
  for (const row of wave.rows) {
    const site = heCompanySiteIdentity(row.website);
    if (site) addHeSite(seenSites, site);
  }
  while (wave.resolved < wave.candidates.length) {
    signal?.throwIfAborted();
    const candidate = wave.candidates[wave.resolved];
    const preExcluded = input.excluded({ company: candidate.company, website: candidate.website, email: candidate.emails.join('; ') });
    let reason: string;
    if (preExcluded && !wave.resolution) { reason = preExcluded; bump(wave.excluded, preExcluded); }
    else {
      const result = await resolveHeEngRegistryCandidate(ctx, candidate, input.scope, {
        db: input.db, baseId: input.baseId, projectId: input.projectId, saved: wave.resolution,
        onCheckpoint: async checkpoint => { wave.resolution = checkpoint; await input.save(); },
      });
      const site = result.row ? heCompanySiteIdentity(result.row.website) : null;
      const excluded = result.row ? input.excluded(result.row) ??
        (site && heSameCompanySite(seenSites, site) ? 'duplicate_company_website' : null) : result.reason;
      reason = excluded ?? result.reason;
      if (!result.row || excluded) bump(wave.excluded, excluded ?? 'registry_unconfirmed');
      else {
        wave.rows.push(result.row);
        if (site) addHeSite(seenSites, site);
      }
    }
    wave.decisions.push({ provider: candidate.provider, recordId: candidate.recordId, reason });
    wave.resolved += 1;
    delete wave.resolution;
    ctx.onActivity?.();
    await input.save();
  }
  return { rows: wave.rows, exhausted: cursor.exhausted, ...(cursor.unavailable ? { error: cursor.unavailable } : {}) };
}
