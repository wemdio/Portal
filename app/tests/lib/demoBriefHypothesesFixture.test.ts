/** @jest-environment node */

/**
 * Контракт «демо-фикстура гипотез ↔ parseHypotheses».
 *
 * Фикстура ОБЯЗАНА быть в каноническом формате парсера («### Гипотеза N: …»
 * + «- Лейбл: значение»): плоские абзацы parseHypotheses выбрасывает, и демо
 * рендерит одну битую карточку с сырыми звёздочками вместо шести — реальный
 * дефект ee92f57f1, прошедший мимо всех тестов. Этот тест прибивает формат.
 */

import { parseHypotheses } from '@/lib/projectBriefHypotheses/parseHypotheses';
import { DEMO_BRIEF_HYPOTHESES_RESPONSE } from '@/lib/clientDemo/fixtures';

describe('DEMO_BRIEF_HYPOTHESES_RESPONSE', () => {
  it('рендерится в 6 чистых карточек гипотез (не одну битую)', () => {
    const blocks = parseHypotheses(DEMO_BRIEF_HYPOTHESES_RESPONSE.lead_source_hypotheses);
    expect(blocks).toHaveLength(6);
    blocks.forEach((block, i) => {
      // Номер из заголовка секции, не fallback по индексу.
      expect(block.number).toBe(String(i + 1));
      // Заголовок без markdown-мусора (** или ###) — признак того, что
      // сплиттер распознал секцию, а не свалил всё в один блок.
      expect(block.title).toBeTruthy();
      expect(block.title).not.toMatch(/[*#]/);
      // Поля распознаны как «Лейбл: значение», а не потеряны.
      expect(block.fields.length).toBeGreaterThanOrEqual(3);
      for (const field of block.fields) {
        expect(field.label).toBeTruthy();
        expect(field.value).toBeTruthy();
      }
    });
  });
});
