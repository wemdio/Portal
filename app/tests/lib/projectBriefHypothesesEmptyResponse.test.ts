/** @jest-environment node */

/**
 * Регресс на инцидент 21.09.2026: карточка проекта показывала «Гипотезы не
 * сгенерированы: AI вернул пустой ответ».
 *
 * Алиас `policy/gemini-flash` в Requesty стал роутиться на reasoning-модель
 * (deepseek-flash): все 4500 токенов лимита уходили в скрытые рассуждения,
 * `finish_reason: length`, `content: ''`. Тот же алиас до этого ронял генерацию
 * поисковых запросов (см. `lib/constants.ts`) и sales-гипотезы (см.
 * `salesHypotheses/model.ts`) — дефолты этого пути третий раз наступали на те же
 * грабли. Тест стережёт две вещи: дефолт не берётся из policy-алиаса, и пустой
 * ответ называет причину, а не молчит.
 */

import {
  generateLeadSourceHypotheses,
  DEFAULT_HYPOTHESES_MODEL,
} from '@/lib/projectBriefHypotheses/generateHypotheses';
import { DEFAULT_ICP_MODEL } from '@/lib/projectBriefHypotheses/analyzeIcp';

describe('гипотезы по брифу: пустой ответ модели', () => {
  it('дефолтные модели обоих шагов пиннятся, а не берутся из policy-алиаса', () => {
    expect(DEFAULT_HYPOTHESES_MODEL).not.toMatch(/^policy\//);
    expect(DEFAULT_ICP_MODEL).not.toMatch(/^policy\//);
  });

  it('на пустом content с finish_reason=length называет модель и лимит', async () => {
    const fetchImpl = (async () => ({
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({ choices: [{ message: { content: '' }, finish_reason: 'length' }] }),
    })) as unknown as typeof fetch;

    await expect(
      generateLeadSourceHypotheses({
        apiKey: 'k',
        briefText: 'продаём CRM медицинским клиникам',
        // client — одношаговый путь: разбор ЦА не мешает проверке шага 2.
        audience: 'client',
        model: 'some/reasoning-model',
        fetchImpl,
        maxRetries: 0,
      }),
    ).rejects.toThrow(/some\/reasoning-model.*4500/);
  });
});
