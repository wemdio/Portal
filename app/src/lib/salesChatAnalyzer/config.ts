import 'server-only';

/**
 * Конфигурация инструмента «Анализатор сейлз-переписок».
 * Изолированные env-переменные; api_id/api_hash имеют фолбэк на общие TELEGRAM_*.
 */

export function getSalesChatApiCreds(): { apiId: number; apiHash: string } {
  const apiId = Number(process.env.SALES_CHAT_TG_API_ID ?? process.env.TELEGRAM_API_ID ?? '');
  const apiHash = (process.env.SALES_CHAT_TG_API_HASH ?? process.env.TELEGRAM_API_HASH ?? '').trim();
  if (!apiId || !apiHash) {
    throw new Error(
      'Не заданы SALES_CHAT_TG_API_ID / SALES_CHAT_TG_API_HASH (или TELEGRAM_API_ID / TELEGRAM_API_HASH).',
    );
  }
  return { apiId, apiHash };
}

export function getSalesChatCipherKey(): string {
  const key = (process.env.SALES_CHAT_CIPHER_KEY ?? '').trim();
  if (!key) {
    throw new Error('Не задан SALES_CHAT_CIPHER_KEY — без него нельзя шифровать ТГ-сессии.');
  }
  return key;
}

export function getSalesChatProxyUrl(): string {
  return (process.env.SALES_CHAT_TG_PROXY ?? '').trim();
}
