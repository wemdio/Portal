import { parseValuesChips } from '@/lib/emailSequenceV2/valuesChips';

describe('parseValuesChips', () => {
  it('разбирает канонический RU-формат этапа 1 в 4 группы чипов', () => {
    const values = `Ценности Zvukograd

1. Уникальные торговые предложения (УТП).
- Студийная озвучка под ключ — от подбора голоса до финального сведения.
- Готово за 1 день: стандартный ролик озвучивается за сутки.

2. Преимущества продукта/услуги.
- 200+ дикторов на любой тембр и настроение.
- Своя студия записи, полностью оборудованная.
- Правки без доплат, пока клиент не примет результат.

3. Технические характеристики (если применимо).
- WAV/MP3, 48 кГц.

4. Акции и бонусы (если есть).
- −15% на первый заказ до конца месяца.

5. Социальные доказательства (отзывы, кейсы, упоминания в СМИ, регалии, награды).
- 500+ проектов озвучено за 6 лет.
- Работали с РБК, Ozon: коммерческие ролики и IVR.

6. Дополнительный контекст и нюансы.
- Работают по всей РФ и СНГ.`;

    const groups = parseValuesChips(values);
    expect(groups).not.toBeNull();
    expect(groups!.map((g) => g.key)).toEqual(['offer', 'benefits', 'promos', 'trust']);

    const byKey = Object.fromEntries(groups!.map((g) => [g.key, g.items]));
    expect(byKey.offer).toEqual(['Студийная озвучка под ключ', 'Готово за 1 день']);
    expect(byKey.benefits).toEqual([
      '200+ дикторов на любой тембр и настроение',
      'Своя студия записи, полностью оборудованная',
      'Правки без доплат, пока клиент не примет результат',
    ]);
    expect(byKey.promos).toEqual(['−15% на первый заказ до конца месяца']);
    expect(byKey.trust).toEqual(['500+ проектов озвучено за 6 лет', 'Работали с РБК, Ozon']);
  });

  it('понимает EN-заголовки и markdown-жирность', () => {
    const values = `Values Acme

**1. Unique selling propositions (USPs).**
- **Turnkey voiceover** — from casting to mastering.

**2. Product/service benefits.**
- 24h turnaround.

**5. Social proof (testimonials, case studies).**
- Featured in TechCrunch.`;

    const groups = parseValuesChips(values);
    expect(groups).not.toBeNull();
    const byKey = Object.fromEntries(groups!.map((g) => [g.key, g.items]));
    expect(byKey.offer).toEqual(['Turnkey voiceover']);
    expect(byKey.benefits).toEqual(['24h turnaround']);
    expect(byKey.trust).toEqual(['Featured in TechCrunch']);
  });

  it('нераспознанная структура → null (UI падает в полный текст)', () => {
    expect(parseValuesChips('Просто сплошной абзац текста без разделов и пунктов.')).toBeNull();
    expect(parseValuesChips('')).toBeNull();
    expect(parseValuesChips(null)).toBeNull();
  });

  it('режет длинные пункты до чипа и дедупит', () => {
    const long = 'Очень длинное описание преимущества, которое явно не помещается в короткий чип и должно быть обрезано по границе максимума символов чтобы не ломать вёрстку карточки справа';
    const values = `1. УТП.
- ${long}
- Готово за 1 день
- готово за 1 день`;
    const groups = parseValuesChips(values)!;
    const offer = groups.find((g) => g.key === 'offer')!.items;
    expect(offer).toHaveLength(2);
    expect(offer[0].length).toBeLessThanOrEqual(90);
    expect(offer[0].endsWith('…')).toBe(true);
  });
});
