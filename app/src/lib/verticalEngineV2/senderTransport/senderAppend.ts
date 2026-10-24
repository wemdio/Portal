import type { SupabaseClient } from '@supabase/supabase-js';
import {
  AppendLeadsPartialError,
  type AppendLeadsResult,
  type AppendLeadsToClientCampaignInput,
} from '@/lib/clientLaunch/appendLeads';
import {
  completeAppendLedgerBatch,
  failAppendLedgerBatch,
  startAppendLedgerBatch,
} from '@/lib/clientReports/ledgerStore';
import type { LeadCreatePayload } from '@/lib/instantly/types';
import { importRecipients } from '@/lib/sender/campaignOps';
import { chunkForInFilter } from '@/lib/sender/inFilter';
import { normalizeRecipientEmail } from '@/lib/sender/recipientImport';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import {
  parseSenderSteps,
  senderLetterProblems,
  senderTemplateFault,
  veLeadToRecipient,
  type SenderLetterVariant,
} from './senderTemplate';
import { readSenderUploadsEnabled } from './transport';

/**
 * Подача контактов VE2 в кампанию «Рассылки» — замена Instantly createLeads
 * для запусков с transport='sender'. Договор с бегуном тот же, что у
 * appendLeadsToClientCampaign (номера строк input.leads):
 *   • обычная ошибка до записи — бегун отпускает все строки;
 *   • после начала записи — только AppendLeadsPartialError: принятые известны
 *     точно, остальные начатые станут неясными и их сверит
 *     contactDeliveryReconciliation по базе;
 *   • успешный ответ — каждая начатая строка либо принята, либо пропущена
 *     навсегда (стоп-лист, некорректный адрес, пустое у этого контакта письмо).
 * Поломку шаблона (senderTemplate.senderTemplateFault) не заливаем и не
 * пропускаем, а отпускаем пачку с ошибкой: купленный запас не сгорает. Обычно
 * до этого не доходит: наблюдатель (senderDelivery) видит ту же поломку
 * раньше и закрывает подачу в эту кампанию. Отпускать из-за одного контакта
 * нельзя: в дневном режиме та же пачка вернулась бы завтра первой.
 * Мест в воркспейсе у «Рассылки» нет: capacityBlocked всегда false.
 */

/** Строк за одну заливку: importRecipients пишет их одним запросом. */
const CHUNK = 500;

/** Кампания та, в которую можно подавать, — иначе обычная ошибка: строки отпустят. */
async function readTargetCampaign(
  db: SupabaseClient,
  input: { veProjectId: string; campaignId: string; userId: string },
): Promise<{ variants: SenderLetterVariant[]; spellings: Set<string> }> {
  const { data: campaign, error } = await db.from('sender_campaigns')
    .select('id, status, source_kind, project_id, client_user_id').eq('id', input.campaignId).maybeSingle();
  if (error) throw new Error(`кампания «Рассылки» не прочитана: ${error.message}`);
  if (!campaign || campaign.source_kind !== 've2') throw new Error('кампания «Рассылки» не найдена или не принадлежит Движку вертикалей');
  if (campaign.status === 'done') throw new Error('кампания «Рассылки» остановлена — контакты в неё не подаются');
  const { data: project, error: projectError } = await db.from('ve_projects')
    .select('portal_project_id').eq('id', input.veProjectId).maybeSingle();
  if (projectError) throw new Error(`проект VE2 не прочитан: ${projectError.message}`);
  if (!project?.portal_project_id || campaign.project_id !== project.portal_project_id) {
    throw new Error('кампания «Рассылки» принадлежит другому проекту');
  }
  // Стоп-лист клиента «Рассылка» берёт из кампании — клиент тот же, что у пресета.
  if (campaign.client_user_id !== input.userId) throw new Error('клиент кампании «Рассылки» не совпадает с клиентом пресета');
  const { count, error: linkError } = await db.from('project_sender_campaigns')
    .select('id', { count: 'exact', head: true })
    .eq('campaign_id', input.campaignId).eq('project_id', project.portal_project_id);
  if (linkError) throw new Error(`привязка кампании «Рассылки» не прочитана: ${linkError.message}`);
  if (!count) throw new Error('кампания «Рассылки» не привязана к проекту — первые письма не попали бы в факт');
  const { data: steps, error: stepError } = await db.from('sender_campaign_steps')
    .select('step_no, subject, body').eq('campaign_id', input.campaignId);
  if (stepError) throw new Error(`письма кампании «Рассылки» не прочитаны: ${stepError.message}`);
  return parseSenderSteps((steps ?? []) as { step_no: unknown; subject: unknown; body: unknown }[]);
}

/** id получателей кампании по адресам (адреса хранятся строчными). */
async function readRecipientIds(db: SupabaseClient, campaignId: string, emails: string[]): Promise<Map<string, string>> {
  const ids = new Map<string, string>();
  for (const part of chunkForInFilter([...new Set(emails)])) {
    const { data, error } = await db.from('sender_recipients').select('id, email').eq('campaign_id', campaignId).in('email', part);
    if (error) throw new Error(error.message);
    for (const row of (data ?? []) as { id: string; email: string }[]) ids.set(row.email, row.id);
  }
  return ids;
}

export async function appendLeadsToVeSenderCampaign(
  input: AppendLeadsToClientCampaignInput,
  ctx: { veProjectId: string; portalDb: SupabaseClient },
): Promise<AppendLeadsResult> {
  const { leads, campaignId } = input;
  if (!leads.length) {
    return { accepted: 0, skipped: 0, attemptedIndexes: [], acceptedIndexes: [], skippedIndexes: [],
      identityComplete: true, deferredIndexes: [], capacityBlocked: false };
  }
  const ledgerDb = supabaseAdmin;
  if (!ledgerDb) throw new Error('Server misconfigured: reporting ledger is not available');
  if (!(await readSenderUploadsEnabled(ctx.portalDb, ctx.veProjectId))) {
    throw new Error('Подача контактов в «Рассылку» выключена');
  }
  const { variants, spellings } = await readTargetCampaign(ctx.portalDb, { veProjectId: ctx.veProjectId, campaignId, userId: input.userId });

  const identities = leads.map((lead) => (lead as LeadCreatePayload & { _ve_company_identity?: unknown })._ve_company_identity);
  const rows = leads.map((lead, index) => veLeadToRecipient(lead, identities[index], spellings));

  const fault = senderTemplateFault(variants, rows);
  if (fault) throw new Error(`${fault} — контакты не поданы`);
  // Контакт с некорректным адресом или с пустым у него письмом (пустая колонка
  // под переменной темы) этим шаблоном не написать — пропуск навсегда.
  const problems = senderLetterProblems(variants, rows);
  const skippedIndexes = new Set<number>([...problems.invalid, ...problems.empty]);

  let accepted = 0;
  let identityComplete = true;
  const acceptedIndexes: number[] = [];
  const attemptedIndexes = new Set<number>();
  const sorted = (values: Iterable<number>) => [...values].sort((a, b) => a - b);
  const currentResult = (): AppendLeadsResult => ({
    accepted,
    skipped: skippedIndexes.size,
    attemptedIndexes: sorted(attemptedIndexes),
    acceptedIndexes: identityComplete ? sorted(acceptedIndexes) : null,
    skippedIndexes: sorted(skippedIndexes),
    identityComplete,
    deferredIndexes: [],
    capacityBlocked: false,
  });

  const source = input.ledgerSource ?? { kind: 've2_contact_delivery' };
  const sendIndexes = leads.map((_, index) => index).filter((index) => !skippedIndexes.has(index));
  let unjournaledSkips = skippedIndexes.size;

  for (let offset = 0; offset < sendIndexes.length; offset += CHUNK) {
    const originalIndexes = sendIndexes.slice(offset, offset + CHUNK);
    const originalChunk = originalIndexes.map((index) => leads[index]);
    let chunk = originalChunk;
    let chunkIndexes = originalIndexes;
    let beforeChunkRequest: (() => Promise<void>) | undefined;
    if (input.prepareProviderChunk) {
      try {
        const prepared = await input.prepareProviderChunk(originalChunk);
        if (prepared.leads.length !== prepared.inputIndexes.length
          || new Set(prepared.inputIndexes).size !== prepared.inputIndexes.length
          || prepared.inputIndexes.some((index, position) => !Number.isSafeInteger(index) || index < 0
            || index >= originalChunk.length
            || prepared.leads[position].email.trim().toLowerCase() !== originalChunk[index].email.trim().toLowerCase())) {
          throw new Error('Caller policy changed recipient identity');
        }
        const retained = new Set(prepared.inputIndexes);
        originalIndexes.forEach((index, position) => { if (!retained.has(position)) skippedIndexes.add(index); });
        unjournaledSkips += originalChunk.length - prepared.leads.length;
        chunk = prepared.leads;
        chunkIndexes = prepared.inputIndexes.map((position) => originalIndexes[position]);
        beforeChunkRequest = prepared.beforeRequest;
      } catch (error) {
        throw new AppendLeadsPartialError(error instanceof Error ? error.message : 'Caller policy unavailable', currentResult());
      }
      if (!chunk.length) continue;
    }

    const ledgerContext = {
      clientUserId: input.userId,
      campaignId,
      campaignName: source.campaignName ?? input.contextLabel ?? null,
      sourceKind: source.kind,
      sourceRunId: source.runId ?? null,
      sourceJobId: source.jobId ?? null,
      leads: chunk,
    };
    let batchId: string;
    try {
      ({ batchId } = await startAppendLedgerBatch(ledgerDb, {
        ...ledgerContext, blockedCount: unjournaledSkips, tariffSkippedCount: 0, startedAt: new Date().toISOString(),
      }));
      unjournaledSkips = 0;
    } catch (error) {
      throw new AppendLeadsPartialError(error instanceof Error ? error.message : 'Reporting ledger write failed', currentResult());
    }

    const chunkRows = chunkIndexes.map((index) => rows[index]);
    let writeStarted = false;
    let inCampaign: Set<number>;
    // Письма проверены выше; если importRecipients всё же нашёл пустое — шаги
    // правили во время заливки. Невставленные тогда не пропускаем навсегда:
    // они станут неясными, сверка их отпустит.
    let templateChanged = false;
    try {
      const imported = await importRecipients(campaignId, chunkRows, {
        mode: 'append',
        beforeWrite: async () => {
          await input.beforeProviderRequest?.();
          await beforeChunkRequest?.();
          for (const index of chunkIndexes) attemptedIndexes.add(index);
          writeStarted = true;
        },
      });
      inCampaign = new Set(imported.inCampaignRows);
      templateChanged = imported.skippedEmptyLetter > 0;
    } catch (error) {
      try {
        await failAppendLedgerBatch(ledgerDb, { ...ledgerContext, batchId, error, finishedAt: new Date().toISOString() });
      } catch {
        // Журнал отчётов не главнее исхода загрузки: он остаётся «отправлен».
      }
      if (writeStarted) {
        // Запись могла лечь и без ответа: кто уже в кампании — принят, про
        // остальных неясно, их сверит contactDeliveryReconciliation.
        try {
          const present = await readRecipientIds(ctx.portalDb, campaignId,
            chunkRows.map((row) => normalizeRecipientEmail(row.email)).filter((email): email is string => Boolean(email)));
          chunkRows.forEach((row, position) => {
            const email = normalizeRecipientEmail(row.email);
            if (email && present.has(email)) { acceptedIndexes.push(chunkIndexes[position]); accepted += 1; }
          });
        } catch {
          identityComplete = false;
        }
      }
      throw new AppendLeadsPartialError(error instanceof Error ? error.message : 'Не удалось залить контакты в «Рассылку»', currentResult());
    }

    const chunkAccepted: { email: string; index: number }[] = [];
    chunkRows.forEach((row, position) => {
      const email = normalizeRecipientEmail(row.email);
      if (email && inCampaign.has(position)) {
        acceptedIndexes.push(chunkIndexes[position]);
        chunkAccepted.push({ email, index: position });
      } else if (!templateChanged) {
        skippedIndexes.add(chunkIndexes[position]);
      }
    });
    accepted += chunkAccepted.length;
    // id получателей нужны только журналу отчётов; не прочитались — журнал
    // запишет неполную идентичность, а загрузка своё уже знает точно.
    let createdLeads: { id: string; email: string; index: number }[] = [];
    try {
      const ids = await readRecipientIds(ctx.portalDb, campaignId, chunkAccepted.map((entry) => entry.email));
      createdLeads = chunkAccepted.flatMap((entry) => {
        const id = ids.get(entry.email);
        return id ? [{ id, email: entry.email, index: entry.index }] : [];
      });
    } catch {
      createdLeads = [];
    }
    try {
      await completeAppendLedgerBatch(ledgerDb, {
        ...ledgerContext, batchId, accepted: chunkAccepted.length, skipped: chunk.length - chunkAccepted.length,
        createdLeads, finishedAt: new Date().toISOString(),
      });
    } catch {
      throw new AppendLeadsPartialError(
        'Contacts were delivered, but the reporting confirmation journal could not be finalized', currentResult());
    }
    if (templateChanged) {
      throw new AppendLeadsPartialError('Шаги кампании «Рассылки» изменились во время заливки', currentResult());
    }
  }
  return currentResult();
}
