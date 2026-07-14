import { createHash } from 'crypto';

/**
 * input_hash — детерминированный ключ дедупа. Одинаковый ввод → одинаковый
 * хэш → если такой уже был в sales_ai_deal_analysis для этой сделки, повторно
 * не гоняем LLM.
 *
 * Компоненты: updated_at сделки + timestamp последнего сообщения в диалоге
 * + timestamp последней транскрипции + sha256 активной версии регламента.
 * Изменилось хоть что-то — хэш другой — перегоняем.
 */
export function computeInputHash(parts: {
  amoUpdatedAt: string | null;
  lastMessageAt: string | null;
  lastTranscriptAt: string | null;
  regulationSha256: string;
}): string {
  const src = [
    parts.amoUpdatedAt ?? '-',
    parts.lastMessageAt ?? '-',
    parts.lastTranscriptAt ?? '-',
    parts.regulationSha256,
  ].join('|');
  return createHash('sha256').update(src, 'utf-8').digest('hex');
}
