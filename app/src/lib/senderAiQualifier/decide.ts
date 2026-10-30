import { nextWindowSlot, zonedParts, type SendWindow } from '@/lib/sender/sendWindow';
import { MAX_OBJECTION_TURNS, OBJECTION_KINDS, REPLY_INTENTS, type ReplyAssessment } from './objections';
import {
  MAX_AI_LETTERS, REMINDER_BUSINESS_DAYS, REPLY_DELAY_MS,
  type AiCloseReason, type AiDecision, type AiStep,
} from './types';

/**
 * Чистая логика квалифицирующего ИИ: разбор ответа модели, решение по ходу
 * и арифметика сроков. Без обращений к базе и сети.
 */

const RELEVANT = new Set<AiStep['relevant']>(['yes', 'no', 'unclear']);
const OUTCOMES = new Set<AiStep['outcome']>(['continue', 'handoff', 'close', 'counter_offer', 'review']);

/** Заглушки, которые модель пишет вместо контакта. */
const CONTACT_PLACEHOLDER = /^(null|none|n\/?a|нет|не указан[оа]?|не указал[аи]?|отсутствует|unknown|-+|—+|–+)$/i;
/**
 * Похоже ли на контакт для связи: цифры (телефон, время, дата), почта или
 * ник, мессенджер, «по почте», день или время суток.
 */
const CONTACT_SIGNAL = /\d|@|почт|e-?mail|mail|телеграм|telegram|\btg\b|whatsapp|ватсап|звон|call|zoom|зум|понедельник|вторник|сред[аеуы]|четверг|пятниц|суббот|воскресен|monday|tuesday|wednesday|thursday|friday|завтра|сегодня|tomorrow|today|утр|вечер|днём|morning|afternoon|evening/i;

export function looksLikeContact(value: string | null): boolean {
  if (!value) return false;
  const text = value.trim();
  return Boolean(text) && !CONTACT_PLACEHOLDER.test(text) && CONTACT_SIGNAL.test(text);
}

/**
 * Ответ модели → AiStep. Модель иногда оборачивает JSON в ```json или пишет
 * пояснение вокруг — берём объект от первой «{» до последней «}».
 */
export function parseAiStep(raw: string): AiStep {
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('В ответе модели нет JSON');
  let data: Record<string, unknown>;
  try {
    data = JSON.parse(raw.slice(start, end + 1)) as Record<string, unknown>;
  } catch {
    throw new Error('Ответ модели — невалидный JSON');
  }
  const relevant = data.relevant as AiStep['relevant'];
  const outcome = data.outcome as AiStep['outcome'];
  if (!RELEVANT.has(relevant)) throw new Error(`relevant: неизвестное значение «${String(data.relevant)}»`);
  if (!OUTCOMES.has(outcome)) throw new Error(`outcome: неизвестное значение «${String(data.outcome)}»`);
  const contact = typeof data.contact === 'string' ? data.contact.trim() : '';
  let assessment: ReplyAssessment | undefined;
  if (data.assessment != null) {
    const a = data.assessment as Record<string, unknown>;
    if (!REPLY_INTENTS.includes(a.intent as ReplyAssessment['intent'])
      || (a.objection !== null && !OBJECTION_KINDS.includes(a.objection as NonNullable<ReplyAssessment['objection']>))
      || !['high', 'medium', 'low'].includes(String(a.confidence))
      || typeof a.evidence !== 'string' || a.evidence.length > 500
      || (a.case_id !== null && typeof a.case_id !== 'string')) {
      throw new Error('Невалидная оценка намерения/возражения');
    }
    assessment = {
      intent: a.intent as ReplyAssessment['intent'], objection: a.objection as ReplyAssessment['objection'],
      evidence: a.evidence.trim(), confidence: a.confidence as ReplyAssessment['confidence'],
      caseId: typeof a.case_id === 'string' ? a.case_id.trim() || null : null,
    };
  }
  return {
    relevant,
    outcome,
    contact: contact && !CONTACT_PLACEHOLDER.test(contact) ? contact : null,
    reply: typeof data.reply === 'string' ? data.reply.trim() : '',
    summary: typeof data.summary === 'string' ? data.summary.trim() : '',
    stopRequested: data.stop_requested === true,
    ...(assessment ? { assessment } : {}),
  };
}

/**
 * Решение по ходу. Передаём только при подтверждённой актуальности и
 * присланном контакте — что бы ни написала модель в outcome.
 */
export function decideStep(step: AiStep, ctx: {
  aiMessages: number; stopRequested: boolean;
  objections?: {
    turns: number; lastIntent: string | null; lastObjection: string | null;
    lastLeadText: string; caseIds: string[]; usedCaseIds: string[];
  };
}): AiDecision {
  // Просьба не писать важнее всего остального: ни передачи, ни прощания.
  if (ctx.stopRequested || step.stopRequested) return { kind: 'close', letter: null };
  const a = step.assessment;
  if (ctx.objections) {
    if (!a) return { kind: 'review', reason: 'ИИ не определил намерение адресата' };
    if (a.intent === 'stop') return { kind: 'close', letter: null };
    if (a.intent === 'machine' || a.intent === 'counter_offer') return { kind: 'close', letter: null };
    if (a.confidence !== 'high' || a.intent === 'review' || a.intent === 'timing' || step.outcome === 'review') {
      return { kind: 'review', reason: step.summary || 'Нужен ответ менеджера: недостаточно данных или отложенный интерес' };
    }
    const normalize = (s: string) => s.replace(/\s+/g, ' ').trim().toLowerCase();
    if (!a.evidence || !normalize(ctx.objections.lastLeadText).includes(normalize(a.evidence))) {
      return { kind: 'review', reason: 'Намерение не подтверждено цитатой последнего ответа' };
    }
    if (a.caseId && (!ctx.objections.caseIds.includes(a.caseId) || ctx.objections.usedCaseIds.includes(a.caseId))) {
      return { kind: 'review', reason: 'Кейс отсутствует в актуальной библиотеке или уже использован' };
    }
    if (a.intent === 'soft_decline' || a.intent === 'objection') {
      if (ctx.objections.turns >= MAX_OBJECTION_TURNS
        || (a.intent === 'soft_decline' && ctx.objections.turns > 0)
        || (a.intent === 'objection' && ctx.objections.turns > 0 && a.objection === ctx.objections.lastObjection)) {
        return { kind: 'close', letter: null };
      }
      // Отказ с номером в подписи не становится подтверждённым интересом.
      if ((step.relevant === 'yes' && looksLikeContact(step.contact)) || step.outcome === 'handoff') {
        return { kind: 'review', reason: 'Возражение противоречит подтверждённому интересу' };
      }
    }
  }
  if (step.relevant === 'yes' && step.contact && looksLikeContact(step.contact)) {
    if (ctx.objections && a && !a.evidence.replace(/\s+/g, ' ').toLowerCase().includes(step.contact.replace(/\s+/g, ' ').toLowerCase())) {
      return { kind: 'review', reason: 'Контакт для передачи не подтверждён новой репликой адресата' };
    }
    if (!step.reply && ctx.aiMessages < MAX_AI_LETTERS) throw new Error('Модель не написала письмо передачи');
    return { kind: 'handoff', letter: ctx.aiMessages < MAX_AI_LETTERS ? step.reply : null, contact: step.contact, summary: step.summary };
  }
  if (step.outcome === 'counter_offer') return { kind: 'close', letter: null };
  if (step.outcome === 'review') return { kind: 'review', reason: step.summary || 'Нужен ответ менеджера' };
  if (ctx.aiMessages >= MAX_AI_LETTERS) return { kind: 'no_reply' };
  if (step.outcome === 'close') {
    return { kind: 'close', letter: ctx.stopRequested || !step.reply ? null : step.reply };
  }
  if (!step.reply) throw new Error('Модель не написала письмо');
  return { kind: 'reply', letter: step.reply };
}

/**
 * Причина закрытия разговора. Просьба не писать сильнее всего (как в decideStep),
 * затем встречное предложение, затем отказ; прочие закрытия причины не имеют.
 */
export function closeReasonOf(step: AiStep): AiCloseReason | null {
  if (step.stopRequested) return 'stop';
  if (step.outcome === 'counter_offer') return 'counter_offer';
  if (step.relevant === 'no') return 'decline';
  return null;
}

/** Через `days` рабочих дней (пн–пт в поясе папки) в то же время суток. */
export function addBusinessDays(from: Date, days: number, timezone: string): Date {
  let cursor = new Date(from);
  let left = days;
  while (left > 0) {
    cursor = new Date(cursor.getTime() + 24 * 60 * 60_000);
    if (zonedParts(cursor, timezone).weekday <= 5) left -= 1;
  }
  return cursor;
}

/** Когда отвечать на письмо лида: не раньше REPLY_DELAY_MS и только в окне отправки. */
export function replyDueAt(receivedAt: Date, window: SendWindow): Date {
  return nextWindowSlot(new Date(receivedAt.getTime() + REPLY_DELAY_MS), window);
}

/** Когда напоминать, если лид молчит после письма ИИ. */
export function reminderDueAt(lastAiSentAt: Date, timezone: string): Date {
  return addBusinessDays(lastAiSentAt, REMINDER_BUSINESS_DAYS, timezone);
}
