import { CLIENT_LAUNCH_ROW_LIMIT } from './constants';
import type {
  ClientCampaignPreset,
  ClientLaunchColumnMapping,
  ClientLaunchSequence,
} from './types';

export interface ValidateClientLaunchInput {
  preset: ClientCampaignPreset | null;
  sequence: ClientLaunchSequence;
  mapping: ClientLaunchColumnMapping;
  rowCount: number;
}

export type ValidateClientLaunchResult =
  | { ok: true }
  | { ok: false; error: string };

export function validateClientLaunchInput(
  input: ValidateClientLaunchInput,
): ValidateClientLaunchResult {
  const { preset, sequence, mapping, rowCount } = input;

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
    if (!step.subject || !step.subject.trim()) {
      return { ok: false, error: `Шаг ${i + 1}: укажите тему письма.` };
    }
    if (!step.body || !step.body.trim()) {
      return { ok: false, error: `Шаг ${i + 1}: укажите текст письма.` };
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
