import { formatTranscript } from '@/lib/ai-caller/transcript';

/**
 * Инцидент 30.07.2026: в карточке звонка «Расшифровка диалога» показывала
 * только реплики клиента. Vapi помечает ответы ассистента ролью `bot`, а
 * фильтр в AnalyticsTab ждал `assistant` — все ответы AI молча пропадали.
 */
describe('formatTranscript', () => {
  it('keeps vapi bot replies (role=bot), not just assistant', () => {
    const messages = [
      { role: 'system', message: 'Ты — менеджер по продажам' },
      { role: 'user', message: 'Алло.' },
      { role: 'bot', message: 'Добрый день! Это Мария.' },
      { role: 'user', message: 'Ага.' },
    ];

    expect(formatTranscript(messages)).toBe(
      ['Клиент: Алло.', 'AI: Добрый день! Это Мария.', 'Клиент: Ага.'].join('\n'),
    );
  });

  it('labels elevenlabs assistant replies the same way', () => {
    const messages = [
      { role: 'assistant', message: 'Здравствуйте!' },
      { role: 'user', message: 'Слушаю.' },
    ];

    expect(formatTranscript(messages)).toBe('AI: Здравствуйте!\nКлиент: Слушаю.');
  });

  it('reads the text from either message or content', () => {
    expect(formatTranscript([{ role: 'bot', content: 'Из content' }])).toBe('AI: Из content');
  });

  it('returns an empty string when there are no messages', () => {
    expect(formatTranscript([])).toBe('');
    expect(formatTranscript(undefined)).toBe('');
    expect(formatTranscript([{ role: 'system', message: 'prompt' }])).toBe('');
  });
});
