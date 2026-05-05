import { CLIENT_LAUNCH_ROW_LIMIT } from './constants';
import { normalizeInstantlyTimezone, isInstantlyValidTimezone } from './timezones';
import {
  CLIENT_LAUNCH_MAX_VARIANTS_PER_STEP,
  type ClientCampaignPreset,
  type ClientLaunchColumnMapping,
  type ClientLaunchScheduleOverride,
  type ClientLaunchSequence,
} from './types';

export interface ValidateClientLaunchInput {
  preset: ClientCampaignPreset | null;
  sequence: ClientLaunchSequence;
  mapping: ClientLaunchColumnMapping;
  rowCount: number;
  scheduleOverride?: ClientLaunchScheduleOverride;
}

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

function timeToMinutes(value: string): number {
  const [h, m] = value.split(':').map((n) => Number.parseInt(n, 10));
  return h * 60 + m;
}

function validateScheduleOverride(
  o: ClientLaunchScheduleOverride,
): { ok: true } | { ok: false; error: string } {
  if (typeof o.from !== 'string' || !TIME_RE.test(o.from)) {
    return { ok: false, error: 'Расписание: время начала должно быть в формате ЧЧ:ММ.' };
  }
  if (typeof o.to !== 'string' || !TIME_RE.test(o.to)) {
    return { ok: false, error: 'Расписание: время окончания должно быть в формате ЧЧ:ММ.' };
  }
  if (timeToMinutes(o.to) <= timeToMinutes(o.from)) {
    return { ok: false, error: 'Расписание: время окончания должно быть позже времени начала.' };
  }
  if (!Array.isArray(o.days) || o.days.length === 0) {
    return { ok: false, error: 'Расписание: выберите хотя бы один день недели.' };
  }
  for (const d of o.days) {
    if (!Number.isInteger(d) || d < 0 || d > 6) {
      return { ok: false, error: 'Расписание: дни должны быть числами 0–6 (вс–сб).' };
    }
  }
  if (typeof o.timezone !== 'string' || !o.timezone.trim()) {
    return { ok: false, error: 'Расписание: укажите часовой пояс.' };
  }
  // Accept either an already-valid id or a known legacy alias (it will be
  // mapped at payload-build time). Reject unknown / typo timezones so the
  // client gets a clear error before we hit Instantly's 400.
  const normalized = normalizeInstantlyTimezone(o.timezone);
  if (!isInstantlyValidTimezone(normalized)) {
    return { ok: false, error: `Расписание: часовой пояс «${o.timezone}» не поддерживается.` };
  }
  return { ok: true };
}

export type ValidateClientLaunchResult =
  | { ok: true }
  | { ok: false; error: string };

export function validateClientLaunchInput(
  input: ValidateClientLaunchInput,
): ValidateClientLaunchResult {
  const { preset, sequence, mapping, rowCount, scheduleOverride } = input;

  if (scheduleOverride) {
    const r = validateScheduleOverride(scheduleOverride);
    if (!r.ok) return r;
  }

  if (!preset) {
    return {
      ok: false,
      error: 'Пресет ещё не настроен. Обратитесь к менеджеру для настройки кампаний.',
    };
  }

  if (!preset.email_account_ids || preset.email_account_ids.length === 0) {
    return {
      ok: false,
      error: 'В пресете нет привязанных email-аккаунтов. Обратитесь к менеджеру.',
    };
  }

  if (!sequence.name || !sequence.name.trim()) {
    return { ok: false, error: 'Укажите название кампании.' };
  }

  if (!sequence.steps || sequence.steps.length === 0) {
    return { ok: false, error: 'Добавьте хотя бы один шаг в цепочку писем.' };
  }

  for (let i = 0; i < sequence.steps.length; i++) {
    const step = sequence.steps[i];
    const isFirstStep = i === 0;

    if (isFirstStep && (!step.subject || !step.subject.trim())) {
      return { ok: false, error: `Шаг ${i + 1}: укажите тему письма.` };
    }
    if (!step.body || !step.body.trim()) {
      return { ok: false, error: `Шаг ${i + 1}: укажите текст письма.` };
    }

    if (step.variants && step.variants.length > 0) {
      const totalVariants = 1 + step.variants.length;
      if (totalVariants > CLIENT_LAUNCH_MAX_VARIANTS_PER_STEP) {
        return {
          ok: false,
          error: `Шаг ${i + 1}: максимум ${CLIENT_LAUNCH_MAX_VARIANTS_PER_STEP} вариантов на шаг (A/B/C).`,
        };
      }
      for (let v = 0; v < step.variants.length; v++) {
        const variant = step.variants[v];
        const variantLetter = String.fromCharCode(66 + v); // B, C, ...
        if (isFirstStep && (!variant.subject || !variant.subject.trim())) {
          return {
            ok: false,
            error: `Шаг ${i + 1}, вариант ${variantLetter}: укажите тему письма.`,
          };
        }
        if (!variant.body || !variant.body.trim()) {
          return {
            ok: false,
            error: `Шаг ${i + 1}, вариант ${variantLetter}: укажите текст письма.`,
          };
        }
      }
    }
  }

  if (!mapping.email || !mapping.email.trim()) {
    return { ok: false, error: 'Сопоставьте колонку с email-адресом.' };
  }

  if (rowCount <= 0) {
    return { ok: false, error: 'Загруженный файл пустой.' };
  }

  if (rowCount > CLIENT_LAUNCH_ROW_LIMIT) {
    return {
      ok: false,
      error: `Лимит ${CLIENT_LAUNCH_ROW_LIMIT.toLocaleString('ru-RU')} строк для одного запуска. В файле ${rowCount.toLocaleString('ru-RU')} строк.`,
    };
  }

  return { ok: true };
}
