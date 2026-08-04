/**
 * @jest-environment node
 *
 * Контракты шага cap_emails_per_company (base-constructor):
 *   1. Не больше N (default 5) email-строк на одну компанию; приоритет —
 *      лучший статус валидации (ok > catch_all > unknown > error > …,
 *      пустой/неизвестный статус — ниже всех).
 *   2. «Однофамильцы» (одно название, разные сайты) НЕ склеиваются в одну
 *      компанию — ключ группировки = компания+сайт (общий с ta_scoring).
 *   3. Почты поддержки (support@/help@) НЕ фильтруются — шаг только режет
 *      количество, роли адресов его не касаются.
 *   4. Компании с ≤ N строками проходят нетронутыми, порядок строк в
 *      выходной матрице — исходный.
 *   5. N конфигурируется (step_config.cap_emails_per_company.max).
 *   6. Нет колонки «Email Статус» (шаг без validate_emails) — не падаем,
 *      оставляем первые N строк компании в исходном порядке.
 *
 * Шаг чистый (без сети/AI), поэтому моки не нужны — импортируем напрямую,
 * как baseConstructorTaScoreDedup.test.ts.
 */

import { stepCapEmailsPerCompany } from '@/lib/tools/processingSteps';

const noopProgress = async () => {};

const HEADER = ['Компания', 'Сайт', 'Email', 'Email Статус'];

describe('stepCapEmailsPerCompany', () => {
  it('(a) оставляет ≤5 строк на компанию, приоритет ok > catch_all > unknown', async () => {
    const data = [
      HEADER,
      ['Alpha', 'a.ru', 'a1@a.ru', 'unknown'],
      ['Alpha', 'a.ru', 'a2@a.ru', 'ok'],
      ['Alpha', 'a.ru', 'a3@a.ru', ''],
      ['Alpha', 'a.ru', 'a4@a.ru', 'catch_all'],
      ['Alpha', 'a.ru', 'a5@a.ru', 'error'],
      ['Alpha', 'a.ru', 'a6@a.ru', 'ok'],
      ['Alpha', 'a.ru', 'a7@a.ru', 'catch_all'],
    ];
    const out = await stepCapEmailsPerCompany(data, noopProgress);
    expect(out[0]).toEqual(HEADER);
    // 7 строк → 5: выкинуты error (ранг 2) и '' (ранг -1, ниже всех).
    expect(out).toHaveLength(1 + 5);
    // Внутри компании — топ по рангу; в выходной матрице — исходный
    // относительный порядок выживших строк.
    expect(out.slice(1).map((r) => r[2])).toEqual([
      'a1@a.ru', // unknown — лучший из оставшихся после ok/catch_all
      'a2@a.ru', // ok
      'a4@a.ru', // catch_all
      'a6@a.ru', // ok
      'a7@a.ru', // catch_all
    ]);
  });

  it('(b) одно название + разные сайты — разные компании, не сливаются', async () => {
    const row = (site: string, n: number, status: string) => [
      'Альфа',
      site,
      `e${n}@${site}`,
      status,
    ];
    const data = [
      HEADER,
      row('a.ru', 1, 'unknown'),
      row('a.ru', 2, 'unknown'),
      row('a.ru', 3, 'unknown'),
      row('a.ru', 4, 'unknown'),
      row('b.ru', 1, 'unknown'),
      row('b.ru', 2, 'unknown'),
      row('b.ru', 3, 'unknown'),
      row('b.ru', 4, 'unknown'),
    ];
    const out = await stepCapEmailsPerCompany(data, noopProgress, { max: 3 });
    // Если бы группировка была только по названию — осталось бы 3 строки
    // суммарно. По (компания, сайт) — по 3 на каждую из двух фирм.
    expect(out).toHaveLength(1 + 6);
    expect(out.slice(1).map((r) => r[2])).toEqual([
      'e1@a.ru',
      'e2@a.ru',
      'e3@a.ru',
      'e1@b.ru',
      'e2@b.ru',
      'e3@b.ru',
    ]);
  });

  it('(c) support@/help@ НЕ выкидываются — шаг не фильтрует роли', async () => {
    const data = [
      HEADER,
      ['Alpha', 'a.ru', 'support@a.ru', 'ok'],
      ['Alpha', 'a.ru', 'help@a.ru', 'ok'],
      ['Alpha', 'a.ru', 'sales@a.ru', 'ok'],
      ['Alpha', 'a.ru', 'info@a.ru', 'ok'],
      ['Alpha', 'a.ru', 'hr@a.ru', 'ok'],
      ['Alpha', 'a.ru', 'ceo@a.ru', 'ok'],
    ];
    const out = await stepCapEmailsPerCompany(data, noopProgress);
    // 6 строк → 5, все статусы равны → выживают первые 5 в исходном порядке,
    // в том числе support@ и help@ (роль адреса не влияет).
    expect(out).toHaveLength(1 + 5);
    const emails = out.slice(1).map((r) => r[2]);
    expect(emails).toContain('support@a.ru');
    expect(emails).toContain('help@a.ru');
    expect(emails).not.toContain('ceo@a.ru'); // шестой по порядку — за капом
  });

  it('(d) компании с < N строками проходят нетронутыми (матрица не меняется)', async () => {
    const data = [
      HEADER,
      ['Alpha', 'a.ru', 'a1@a.ru', 'ok'],
      ['Beta', 'b.ru', 'b1@b.ru', 'catch_all'],
      ['Alpha', 'a.ru', 'a2@a.ru', 'unknown'],
      ['Beta', 'b.ru', 'b2@b.ru', 'ok'],
    ];
    const out = await stepCapEmailsPerCompany(data, noopProgress);
    expect(out).toEqual(data);
  });

  it('(e) max из конфига переопределяет дефолт (max=2)', async () => {
    const data = [
      HEADER,
      ['Alpha', 'a.ru', 'a1@a.ru', 'ok'],
      ['Alpha', 'a.ru', 'a2@a.ru', 'catch_all'],
      ['Alpha', 'a.ru', 'a3@a.ru', 'ok'],
      ['Beta', 'b.ru', 'b1@b.ru', 'unknown'],
      ['Beta', 'b.ru', 'b2@b.ru', 'ok'],
      ['Beta', 'b.ru', 'b3@b.ru', 'catch_all'],
    ];
    const out = await stepCapEmailsPerCompany(data, noopProgress, { max: 2 });
    expect(out).toHaveLength(1 + 4);
    expect(out.slice(1).map((r) => r[2])).toEqual([
      'a1@a.ru', // ok
      'a3@a.ru', // ok — catch_all проигрывает ok даже при max=2
      'b2@b.ru', // ok
      'b3@b.ru', // catch_all > unknown
    ]);
  });

  it('(f) нет колонки «Email Статус» — первые N строк компании, без падения', async () => {
    const data = [
      ['Компания', 'Сайт', 'Email'],
      ['Alpha', 'a.ru', 'a1@a.ru'],
      ['Alpha', 'a.ru', 'a2@a.ru'],
      ['Alpha', 'a.ru', 'a3@a.ru'],
      ['Alpha', 'a.ru', 'a4@a.ru'],
      ['Alpha', 'a.ru', 'a5@a.ru'],
      ['Alpha', 'a.ru', 'a6@a.ru'],
      ['Alpha', 'a.ru', 'a7@a.ru'],
    ];
    const out = await stepCapEmailsPerCompany(data, noopProgress);
    expect(out).toHaveLength(1 + 5);
    expect(out.slice(1).map((r) => r[2])).toEqual([
      'a1@a.ru',
      'a2@a.ru',
      'a3@a.ru',
      'a4@a.ru',
      'a5@a.ru',
    ]);
  });

  it('нет email-колонки — no-op (как остальные шаги)', async () => {
    const data = [
      ['Компания', 'Сайт'],
      ['Alpha', 'a.ru'],
    ];
    const out = await stepCapEmailsPerCompany(data, noopProgress);
    expect(out).toEqual(data);
  });
});
