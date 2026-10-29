import { aiQualifierConfig, requestAiStep } from '@/lib/senderAiQualifier/ai';
import { decideStep } from '@/lib/senderAiQualifier/decide';
import { loadConversationHistory, offerContextFor } from '@/lib/senderAiQualifier/engine';
import { createWorkerLogger, requireSupabaseAdmin } from './_shared';

/**
 * Холостой прогон квалифицирующего ИИ по последним ответам автоаутрича: что ИИ
 * ответил бы на первое письмо лида. Ничего не пишет в базу, писем не шлёт.
 * Запуск на 139:
 *   docker exec portal-worker-sender-leads node /app/workers/senderAiQualifierDryRunCli.js 10
 */
const log = createWorkerLogger('sender-ai-qualifier-dry-run');

async function main(): Promise<void> {
  const limit = Math.min(Math.max(Number(process.argv[2]) || 10, 1), 50);
  const replyArg = process.argv.indexOf('--reply-id');
  const replyId = replyArg >= 0 ? process.argv[replyArg + 1] : null;
  if (replyArg >= 0 && !/^[0-9a-f-]{36}$/i.test(replyId ?? '')) throw new Error('--reply-id: укажите UUID входящего письма');
  const db = requireSupabaseAdmin(log);
  const cfg = aiQualifierConfig();
  if (!cfg) throw new Error('Ключ ИИ не настроен (SENDER_AI_QUALIFIER_API_KEY / SENDER_LEADS_AI_API_KEY)');

  const { data: folders, error: folderError } = await db.from('sender_folders')
    .select('id, key, ai_offer_text').in('key', ['auto_ru', 'auto_en']);
  if (folderError) throw new Error(folderError.message);
  const folderById = new Map((folders ?? []).map((f) => [f.id as string, f as { id: string; key: string; ai_offer_text: string | null }]));
  const { data: campaigns, error: campaignError } = await db.from('sender_campaigns')
    .select('id, folder_id').in('folder_id', [...folderById.keys()]);
  if (campaignError) throw new Error(campaignError.message);
  const folderOf = new Map((campaigns ?? []).map((c) => [c.id as string, folderById.get(c.folder_id as string)!]));

  let query = db.from('sender_reply_qualifications')
    .select('reply_id, recipient_id, campaign_id, qualified_at')
    .in('status', ['lead', 'not_lead']).in('campaign_id', [...folderOf.keys()]);
  if (replyId) query = query.eq('reply_id', replyId);
  const { data: rows, error } = await query.order('qualified_at', { ascending: false }).limit(limit);
  if (error) throw new Error(error.message);

  console.log(`Модель ${cfg.model}. Лидов к прогону: ${rows?.length ?? 0}\n`);
  for (const row of rows ?? []) {
    const folder = folderOf.get(row.campaign_id as string);
    if (!folder) continue;
    const { data: recipient } = await db.from('sender_recipients').select('email, reply_language').eq('id', row.recipient_id).maybeSingle();
    // Ход по первому письму лида: история — до него включительно.
    const { data: reply } = await db.from('sender_replies').select('received_at, created_at').eq('id', row.reply_id).maybeSingle();
    const until = Date.parse(String(reply?.received_at ?? reply?.created_at ?? ''));
    const history = (await loadConversationHistory(db, row.recipient_id as string))
      .filter((m) => !Number.isFinite(until) || Date.parse(m.at ?? '') <= until);
    const language = recipient?.reply_language === 'en' || recipient?.reply_language === 'ru'
      ? recipient.reply_language
      : (folder.key === 'auto_en' ? 'en' : 'ru');
    try {
      const offer = await offerContextFor(db, folder, row.recipient_id as string, log);
      const memory = { turns: 0, lastIntent: null, lastObjection: null, usedCaseIds: [] as string[] };
      const step = await requestAiStep(cfg, {
        language, mode: 'reply', aiMessages: 0, history, ccEmail: 'manager@example.com',
        ...offer, objections: memory,
      });
      const decision = decideStep(step, {
        aiMessages: 0, stopRequested: step.stopRequested,
        objections: { ...memory, lastLeadText: history.filter((m) => m.from === 'lead').at(-1)?.text ?? '', caseIds: offer.caseIds },
      });
      const lead = history.filter((m) => m.from === 'lead').at(-1)?.text.slice(0, 300) ?? '';
      console.log(`=== ${folder.key} · ${recipient?.email ?? row.recipient_id} → ${decision.kind}`);
      console.log(`Лид: ${lead}`);
      console.log(`relevant=${step.relevant} contact=${step.contact ?? '—'}`);
      console.log(`Намерение=${step.assessment?.intent ?? '—'}; возражение=${step.assessment?.objection ?? '—'}; кейс=${step.assessment?.caseId ?? '—'}`);
      if (decision.kind === 'review') console.log(`Нужен ответ менеджера: ${decision.reason}`);
      if ('letter' in decision && decision.letter) console.log(`Письмо ИИ:\n${decision.letter}`);
      console.log(`Для менеджера: ${step.summary}\n`);
    } catch (err) {
      console.log(`=== ${folder.key} · ${recipient?.email ?? row.recipient_id} → ошибка: ${err instanceof Error ? err.message : String(err)}\n`);
    }
  }
  if (folders?.some((f) => !f.ai_offer_text)) console.log('Внимание: у папки без «Короткого КП» ИИ пишет без цен и кейсов.');
}

main().then(() => process.exit(0)).catch((err) => {
  log('error', 'Холостой прогон упал', err);
  process.exit(1);
});
