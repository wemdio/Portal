/** @jest-environment node */

const generateHandoffReply = jest.fn();

jest.mock('@/lib/instantly/handoffGenerator', () => ({
  __esModule: true,
  generateHandoffReply: (...args: unknown[]) => generateHandoffReply(...args),
}));

import { buildHandoffDraft } from '@/lib/instantly/handoffLegend';

describe('buildHandoffDraft — режим по тумблеру aiAdapt', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    generateHandoffReply.mockResolvedValue('ИИ-текст адаптации');
  });

  it('OFF: легенда дословно + подстановка имени, ИИ НЕ вызывается', async () => {
    const draft = await buildHandoffDraft({
      aiAdapt: false,
      legend: 'Добрый день, [Имя, если есть]. Передаю коллеге.',
      leadName: 'Венера',
      leadReplyText: 'давайте демо',
      apiKey: 'k',
    });
    expect(draft).toBe('Добрый день, Венера. Передаю коллеге.');
    expect(generateHandoffReply).not.toHaveBeenCalled();
  });

  it('ON: ИИ-генератор вызывается с легендой как framing и контекстом лида', async () => {
    const draft = await buildHandoffDraft({
      aiAdapt: true,
      legend: 'Передаю коллеге в копию',
      leadName: 'Пётр',
      leadReplyText: 'пришлите цены',
      lastOutboundText: 'наше письмо',
      apiKey: 'k',
    });
    expect(draft).toBe('ИИ-текст адаптации');
    expect(generateHandoffReply).toHaveBeenCalledWith(
      {
        leadReplyText: 'пришлите цены',
        lastOutboundText: 'наше письмо',
        leadName: 'Пётр',
        framing: 'Передаю коллеге в копию',
      },
      { apiKey: 'k' },
    );
  });
});
