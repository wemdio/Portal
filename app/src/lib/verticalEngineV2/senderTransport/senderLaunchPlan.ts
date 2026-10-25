import { createHash } from 'node:crypto';
import type { ClientCampaignPreset } from '@/lib/clientLaunch/types';
import type { CampaignStepInput } from '@/lib/sender/campaignOps';
import { PLACEHOLDER_RE } from '@/lib/sender/templateVars';
import { MAX_VARIANTS } from '@/lib/sender/variants';
import type { VeLaunchSequence } from '../launchHandoff';

/**
 * Запуск VE2 в «Рассылку»: как пресет и письма запуска становятся настройками
 * и шагами кампании «Рассылки», и что «Рассылка» передать не может. Только
 * чистые функции: отказ здесь — до первой записи запуска, а не после
 * резервирования, когда «Рассылка» молча срезала бы письма или варианты
 * (campaignOps.prepareSteps режет шаги до 5 и варианты до 4 без ошибки).
 */

/** Столько шагов принимает «Рассылка» (campaignOps.MAX_STEPS). */
export const VE_SENDER_MAX_STEPS = 5;

export interface VeSenderRefusal {
  ok: false;
  status: number;
  code: string;
  error: string;
}

function refuse(code: string, error: string, status = 409): VeSenderRefusal {
  return { ok: false, status, code, error };
}

export interface VeSenderSchedule {
  timezone: string;
  sendHourFrom: number;
  sendHourTo: number;
  sendWeekdays: number[];
  gapSeconds: number;
  gapJitterSeconds: number;
}

/** Часовой пояс так, как его понимает Intl; null — Intl его не знает. */
function canonicalTimezone(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  try {
    return new Intl.DateTimeFormat('en-US', { timeZone: value.trim() }).resolvedOptions().timeZone;
  } catch {
    return null;
  }
}

function clock(value: unknown): { hour: number; minute: number } | null {
  const match = typeof value === 'string' ? /^([01]\d|2[0-3]):([0-5]\d)$/.exec(value.trim()) : null;
  return match ? { hour: Number(match[1]), minute: Number(match[2]) } : null;
}

/**
 * Окно и ритм пресета → настройки кампании «Рассылки». У «Рассылки» окно в
 * целых часах, конец не включается: начало округляется вверх, конец — вниз,
 * чтобы не писать вне окна клиента (09:30–18:30 → 10–18). Дни пресета —
 * формат Instantly (0 — воскресенье), у «Рассылки» воскресенье — 7. Окно через
 * полночь и пустое после округления «Рассылка» не умеет — отказ, а не тихая
 * потеря воскресений или часов.
 */
export function veSenderScheduleFromPreset(
  preset: Pick<ClientCampaignPreset, 'schedule_from' | 'schedule_to' | 'schedule_days' | 'schedule_timezone' | 'email_gap_minutes'>,
): { ok: true; schedule: VeSenderSchedule } | VeSenderRefusal {
  const invalid = (reason: string) => refuse('VE_SENDER_SCHEDULE_INVALID', `Окно отправки пресета не переносится в «Рассылку»: ${reason}`);
  const timezone = canonicalTimezone(preset.schedule_timezone);
  if (!timezone) return invalid(`неизвестный часовой пояс «${String(preset.schedule_timezone ?? '')}»`);
  const from = clock(preset.schedule_from);
  const to = clock(preset.schedule_to);
  if (!from || !to) return invalid('время задано не в формате ЧЧ:ММ');
  const sendHourFrom = from.hour + (from.minute > 0 ? 1 : 0);
  const sendHourTo = to.hour === 0 && to.minute === 0 ? 24 : to.hour;
  if (sendHourFrom > 23 || sendHourTo <= sendHourFrom) {
    return invalid(`окно ${preset.schedule_from}–${preset.schedule_to} в целых часах пустое или через полночь`);
  }
  const days = Array.isArray(preset.schedule_days) ? preset.schedule_days : [];
  const sendWeekdays = [...new Set(days
    .filter((day) => Number.isSafeInteger(day) && day >= 0 && day <= 6)
    .map((day) => (day === 0 ? 7 : day)))].sort((a, b) => a - b);
  if (!sendWeekdays.length) return invalid('не выбрано ни одного дня');
  const gapMinutes = Number(preset.email_gap_minutes);
  const gapSeconds = Math.max(60, Number.isFinite(gapMinutes) ? Math.round(gapMinutes) * 60 : 60);
  return { ok: true, schedule: { timezone, sendHourFrom, sendHourTo, sendWeekdays, gapSeconds, gapJitterSeconds: 120 } };
}

/**
 * Письма запуска (buildLaunchSequence) → шаги «Рассылки». Пауза письма —
 * от предыдущего, как wait_days; у первого 0. Варианты — всегда списком,
 * вариант A первый. Тема follow-up пустая — «Рассылка» продолжит переписку
 * («Re: …»). Вариант первого письма без темы берёт тему варианта A (решение
 * владельца). Тело — как есть, текстом: разметку [текст](ссылка) «Рассылка»
 * превращает в ссылку сама; HTML Instantly ей не нужен.
 */
export function veSequenceToSenderSteps(sequence: VeLaunchSequence): { ok: true; steps: CampaignStepInput[] } | VeSenderRefusal {
  const letters = sequence.steps;
  if (!letters.length) return refuse('VE_SENDER_TEMPLATE_UNSUPPORTED', 'У шаблона нет писем для «Рассылки»');
  if (letters.length > VE_SENDER_MAX_STEPS) {
    return refuse('VE_SENDER_CHAIN_TOO_LONG', `В цепочке ${letters.length} писем, «Рассылка» отправляет не больше ${VE_SENDER_MAX_STEPS}. Сократите цепочку или запустите через Instantly.`);
  }
  const subjectA = (letters[0].subject ?? '').trim();
  if (!subjectA) return refuse('VE_SENDER_TEMPLATE_UNSUPPORTED', 'У первого письма нет темы');
  const steps: CampaignStepInput[] = [];
  for (const [index, letter] of letters.entries()) {
    const variants = [{ subject: letter.subject, body: letter.body }, ...(letter.variants ?? [])];
    if (variants.length > MAX_VARIANTS) {
      return refuse('VE_SENDER_TOO_MANY_VARIANTS', `У письма ${index + 1} ${variants.length} вариантов, «Рассылка» отправляет не больше ${MAX_VARIANTS}. Уберите лишние темы или тексты.`);
    }
    if (variants.some((variant) => !(variant.body ?? '').trim())) {
      return refuse('VE_SENDER_TEMPLATE_UNSUPPORTED', `У письма ${index + 1} есть вариант без текста`);
    }
    const waitDays = Number(letter.wait_days);
    steps.push({
      delayHours: index === 0 ? 0 : Math.round((Number.isFinite(waitDays) && waitDays > 0 ? waitDays : 0) * 24),
      variants: variants.map((variant) => ({
        subject: index === 0 ? ((variant.subject ?? '').trim() || subjectA) : '',
        body: variant.body,
      })),
    });
  }
  return { ok: true, steps };
}

/** Переменная, как её пишет Движок: {{companyName}}, без запасных значений и пробелов внутри имени. */
const VE_OPERATOR = /^\s*[A-Za-zА-Яа-яЁё0-9_.-]+\s*$/;

/**
 * Конструкции, которые «Рассылка» отправит не так, как Instantly и превью:
 * {% … %} она печатает как есть, а {{a|b}}, {{RANDOM | …}}, {{first name}}
 * у неё — другая или пустая переменная. Такие шаблоны не запускаем.
 */
export function veSenderSyntaxIssue(steps: readonly CampaignStepInput[]): VeSenderRefusal | null {
  for (const [index, step] of steps.entries()) {
    for (const variant of step.variants ?? []) {
      const text = `${variant.subject ?? ''}\n${variant.body ?? ''}`;
      if (/\{%|%\}/.test(text)) {
        return refuse('VE_SENDER_TEMPLATE_UNSUPPORTED', `В письме ${index + 1} есть конструкция {% … %}, «Рассылка» её не поддерживает`);
      }
      const odd = [...text.matchAll(PLACEHOLDER_RE)].map((match) => match[0]).find((placeholder) => !VE_OPERATOR.test(placeholder.slice(2, -2)));
      if (odd) {
        return refuse('VE_SENDER_TEMPLATE_UNSUPPORTED', `В письме ${index + 1} переменная ${odd} записана так, как «Рассылка» не поддерживает: только {{имяПеременной}} без запасного значения`);
      }
    }
  }
  return null;
}

/**
 * source_ref кампании запуска: сегмент запуска. Основной группе — 'default',
 * сегментной — хеш её условия: условие бывает длинным и могло бы совпасть со
 * словом 'default'.
 */
export function veSenderSourceRef(segment: string | null): string {
  return segment === null ? 'default' : `seg:${createHash('sha256').update(segment).digest('hex').slice(0, 32)}`;
}
