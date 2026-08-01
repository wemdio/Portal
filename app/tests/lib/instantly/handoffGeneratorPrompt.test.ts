/** @jest-environment node */

import { _private, generateHandoffReply } from '@/lib/instantly/handoffGenerator';

const fetchMock = jest.fn();

describe('handoffGenerator — промпт против выдумок', () => {
  const oldFetch = global.fetch;

  beforeEach(() => {
    jest.clearAllMocks();
    global.fetch = fetchMock as unknown as typeof fetch;
  });

  afterAll(() => {
    global.fetch = oldFetch;
  });

  it('промпт ставит задачу как минимальную адаптацию легенды, а не генерацию', () => {
    const prompt = _private.buildSystemPrompt('Передаю коллеге в копию');
    expect(prompt).toContain('МИНИМАЛЬНО адаптировать');
    expect(prompt).toContain('Текст легенды: Передаю коллеге в копию');
  });

  it('запреты: никаких консультаций по существу, новой информации, обещаний, вопросов', () => {
    const prompt = _private.buildSystemPrompt('x');
    expect(prompt).toContain('НЕ отвечать на вопросы лида по существу');
    expect(prompt).toContain('Никаких консультаций');
    expect(prompt).toContain('НЕ добавлять никакой новой информации');
    expect(prompt).toContain('НЕ давать обещаний сверх легенды');
    expect(prompt).toContain('НЕ задавать встречных вопросов');
    expect(prompt).toContain('не длиннее легенды больше чем на 2 коротких предложения');
  });

  it('температура остаётся 0.4 (как раньше — сдерживание идёт запретами промпта, не сэмплингом)', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ choices: [{ message: { content: 'ок' }, finish_reason: 'stop' }] }),
    });

    await generateHandoffReply({ leadReplyText: 'пришлите цены', framing: 'x' }, { apiKey: 'k' });
    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string) as {
      temperature: number;
    };
    expect(body.temperature).toBe(0.4);
  });

  it('жёсткое правило языка в промпте (русская легенда → только русский)', () => {
    const prompt = _private.buildSystemPrompt('Передаю коллеге');
    expect(prompt).toContain('ЯЗЫК — жёсткое правило');
    expect(prompt).toContain('отвечай ТОЛЬКО на русском, ни слова по-английски');
    expect(prompt).toContain('На английский переходи только если сама переписка на английском');
  });

  it('языковой гард: легенда русская, драфт английский → ретрай до русского', async () => {
    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ choices: [{ message: { content: 'I will add my colleague to CC' }, finish_reason: 'stop' }] }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ choices: [{ message: { content: 'Поставил в копию коллегу' }, finish_reason: 'stop' }] }),
      });

    const draft = await generateHandoffReply(
      { leadReplyText: 'пришлите стоимость', framing: 'Передаю коллеге в копию' },
      { apiKey: 'k' },
    );
    expect(draft).toBe('Поставил в копию коллегу');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('гард НЕ трогает англоязычные проекты: легенда латиницей + английский драфт → сразу ок', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ choices: [{ message: { content: 'I added my colleague to CC' }, finish_reason: 'stop' }] }),
    });

    const draft = await generateHandoffReply(
      { leadReplyText: 'send me pricing', framing: 'I will add my colleague to CC' },
      { apiKey: 'k' },
    );
    expect(draft).toBe('I added my colleague to CC');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
