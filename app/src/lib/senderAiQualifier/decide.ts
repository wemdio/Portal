import { nextWindowSlot, zonedParts, type SendWindow } from '@/lib/sender/sendWindow';
import {
  MAX_AI_LETTERS, REMINDER_BUSINESS_DAYS, REPLY_DELAY_MS,
  type AiDecision, type AiStep,
} from './types';

/**
 * Чистая логика квалифицирующего ИИ: разбор ответа модели, решение по ходу
 * и арифметика сроков. Без обращений к базе и сети.
 */

const RELEVANT = new Set<AiStep['relevant']>(['yes', 'no', 'unclear']);
const OUTCOMES = new Set<AiStep['outcome']>(['continue', 'handoff', 'close', 'counter_offer']);

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
  return {
    relevant,
    outcome,
    contact: contact || null,
    reply: typeof data.reply === 'string' ? data.reply.trim() : '',
    summary: typeof data.summary === 'string' ? data.summary.trim() : '',
  };
}

/**
 * Решение по ходу. Передаём только при подтверждённой актуальности и
 * присланном контакте — что бы ни написала модель в outcome.
 */
export function decideStep(step: AiStep, ctx: { aiMessages: number; stopRequested: boolean }): AiDecision {
  if (step.relevant === 'yes' && step.contact) {
    if (!step.reply) throw new Error('Модель не написала письмо передачи');
    return { kind: 'handoff', letter: step.reply, contact: step.contact, summary: step.summary };
  }
  if (step.outcome === 'counter_offer') return { kind: 'close', letter: null };
  if (step.outcome === 'close') {
    return { kind: 'close', letter: ctx.stopRequested || !step.reply ? null : step.reply };
  }
  if (ctx.aiMessages >= MAX_AI_LETTERS) return { kind: 'no_reply' };
  if (!step.reply) throw new Error('Модель не написала письмо');
  return { kind: 'reply', letter: step.reply };
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
