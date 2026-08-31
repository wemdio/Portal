import {
  detectSummaryChannel,
  unknownSourceOf,
  type SummaryChannelName,
} from '@/lib/leadsReport/channels';

function raw(fields: Record<string, string>): unknown {
  return {
    custom_fields_values: Object.entries(fields).map(([field_name, value]) => ({
      field_name,
      values: [{ value }],
    })),
  };
}

describe('detectSummaryChannel', () => {
  it.each<[Record<string, string>, SummaryChannelName | null]>([
    // Явный маркер маркетинга через новое поле «Контур» — приоритет над всем.
    [{ Контур: 'Маркетинг' }, 'marketing'],
    [{ Контур: 'Маркетинг', Источник: 'Email Outreach' }, 'marketing'],
    // Остальные каналы — по «Источник».
    [{ Источник: 'Telegram Outreach' }, 'tg_outreach'],
    [{ Источник: 'Партнер' }, 'partners'],
    [{ Источник: 'Партнёрка' }, 'partners'],
    // Сарафан — та же строка отчёта, что и партнёрка (встреча 31.08.2026).
    [{ Источник: 'Сарафан' }, 'partners'],
    [{ Источник: 'Email Outreach' }, 'outreach'],
    [{ Источник: 'Аутрич' }, 'outreach'],
    [{ Источник: 'SMM' }, 'smm'],
    [{ Источник: 'Личный бренд (инст /ютуб)' }, 'smm'],
    [{ Источник: 'Личный бренд (инст /ютуб)', utm_medium: 'instagram' }, 'smm'],
    // Каналы, заведённые 31.08.2026 — раньше все четыре выпадали в null.
    [{ Источник: 'Конференция' }, 'conference'],
    [{ Источник: 'SDR' }, 'sdr'],
    [{ Источник: 'Автоаутрич' }, 'auto_outreach'],
    [{ Источник: 'портал (outreachOS)' }, 'auto_outreach'],
    [{ Источник: 'TG Outreach Eng' }, 'eng_tg_outreach'],
    [{ Источник: 'Email Outreach Eng' }, 'eng_email_outreach'],
    // Маркетинговые источники — теперь по «Источнику», без пометки «Контур».
    [{ Источник: 'Сайт' }, 'marketing'],
    [{ Источник: 'SEO' }, 'marketing'],
    [{ Источник: 'ТГ-канал' }, 'marketing'],
    [{ Источник: 'TG-посев' }, 'marketing'],
    [{ Источник: 'ТГ Бот' }, 'marketing'],
    [{ Источник: 'Email-рассылка' }, 'marketing'],
    // Сознательно несчитаемые и незнакомые.
    [{ Источник: 'Лидскан' }, null],
    [{ Источник: 'Холодная база' }, null],
    [{ Источник: 'Неизвестный новый источник' }, null],
    [{}, null],
  ])('classifies %p as %s', (fields, expected) => {
    expect(detectSummaryChannel(raw(fields))).toBe(expected);
  });

  it('источник сильнее utm-метки: «Сайт» с utm_medium=smm — это Маркетинг', () => {
    // 26 сделок за полгода несут «Источник» = «Сайт» плюс utm_medium=smm. До
    // 31.08 «Сайт» не значил ничего и они считались SMM; решение Дмитрия от
    // 31.08 — источник главнее метки, все они Маркетинг.
    expect(detectSummaryChannel(raw({ Источник: 'Сайт', utm_medium: 'smm' })))
      .toBe('marketing');
  });

  it('utm_medium=smm остаётся признаком SMM там, где источник неизвестен', () => {
    expect(detectSummaryChannel(raw({ utm_medium: 'smm' }))).toBe('smm');
  });

  it('сознательно несчитаемый источник сильнее пометки «Контур»=«Маркетинг»', () => {
    expect(
      detectSummaryChannel(raw({ Контур: 'Маркетинг', Источник: 'Лидскан' })),
    ).toBeNull();
  });

  it('регистр и «ё» в значении источника роли не играют', () => {
    expect(detectSummaryChannel(raw({ Источник: 'ПОРТАЛ (OUTREACHOS)' })))
      .toBe('auto_outreach');
  });
});

describe('unknownSourceOf', () => {
  it('возвращает источник, не разложенный ни по одному правилу', () => {
    expect(unknownSourceOf(raw({ Источник: 'Новый канал' }))).toBe('Новый канал');
  });

  it('молчит про известные и сознательно несчитаемые источники', () => {
    expect(unknownSourceOf(raw({ Источник: 'SDR' }))).toBeNull();
    expect(unknownSourceOf(raw({ Источник: 'Лидскан' }))).toBeNull();
    expect(unknownSourceOf(raw({}))).toBeNull();
  });
});
