/* ──────────────────────────────────────────────
   AI Caller — форматирование транскрипта звонка
   ────────────────────────────────────────────── */

export type TranscriptMessage = {
  role?: string;
  message?: string;
  content?: string;
};

/**
 * Собирает диалог в «Клиент: … / AI: …».
 *
 * Vapi помечает реплики ассистента ролью `bot`, ElevenLabs — `assistant`.
 * Фильтр только по `assistant` молча выбрасывал все ответы AI, и в карточке
 * звонка оставались одни реплики клиента.
 */
export function formatTranscript(
  messages: TranscriptMessage[] | null | undefined,
): string {
  if (!messages?.length) return '';

  return messages
    .filter((m) => m.role === 'user' || m.role === 'assistant' || m.role === 'bot')
    .map((m) => `${m.role === 'user' ? 'Клиент' : 'AI'}: ${m.message ?? m.content ?? ''}`)
    .join('\n');
}
