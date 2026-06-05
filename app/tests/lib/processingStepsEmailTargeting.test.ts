/**
 * @jest-environment node
 *
 * Контракты email-targeting фичи в Base Constructor:
 *   1. stepFindEmails(target='separate') — пишет scrape-результат в отдельную
 *      колонку FOUND_EMAIL_COL, не трогая исходную email-колонку.
 *   2. stepValidateEmails(validateTarget=...) — валидирует выбранные колонки;
 *      'both' → строка остаётся если хотя бы одна валидна.
 *
 * Жалоба специалиста, которая всё это породила:
 *   «загружается база уже с почтами, хочу чтобы при выборе find_emails
 *    спрашивало куда писать (в исходную / отдельную); при validate спрашивало
 *    что валидировать (исходные / найденные / обе)».
 *
 * Этот тестовый файл не дёргает реальный SMTP/scraper — мокаем модули.
 */

// processingSteps импортирует supabaseAdmin косвенно через worker? нет, не импортирует.
// Но мокаем для безопасности (другие зависимости вытягиваются).
jest.mock('@/lib/supabaseAdmin', () => ({
  supabaseAdmin: { from: () => ({}) },
}));

// Мокаем emailScraper.scrapeEmails — это сетевая функция. Контролируем что
// она возвращает чтобы детерминированно тестировать stepFindEmails.
jest.mock('@/lib/enrich/emailScraper', () => ({
  scrapeEmails: jest.fn(),
}));

// Мокаем validator (real validateEmail делает SMTP-запросы) — возвращаем
// заранее заданный результат на основании email'а.
jest.mock('@/lib/emailValidation/validator', () => ({
  validateEmail: jest.fn(),
}));

import { scrapeEmails } from '@/lib/enrich/emailScraper';
import { validateEmail } from '@/lib/emailValidation/validator';
import {
  stepFindEmails,
  stepValidateEmails,
  FOUND_EMAIL_COL,
} from '@/lib/tools/processingSteps';

const noopProgress = async () => {};

beforeEach(() => {
  (scrapeEmails as jest.Mock).mockReset();
  (validateEmail as jest.Mock).mockReset();
});

describe('stepFindEmails', () => {
  it('target="separate" + есть исходная email — пишет в новую колонку FOUND_EMAIL_COL', async () => {
    (scrapeEmails as jest.Mock).mockResolvedValue({ emails: ['found@example.com'] });
    const data = [
      ['Компания', 'Сайт', 'Email'],
      ['Acme', 'acme.com', 'sales@acme.com'],
      ['Beta', 'beta.io', ''],
    ];
    const out = await stepFindEmails(data, noopProgress, undefined, { target: 'separate' });
    expect(out[0]).toEqual(['Компания', 'Сайт', 'Email', FOUND_EMAIL_COL]);
    // Acme: исходный email непустой → scrape не запускался для неё (filter),
    // но FOUND_EMAIL_COL для неё пустой (мы её НЕ скрапили в режиме separate,
    // потому что filter по targetIdx — исходная пустая).
    // Wait — в режиме separate targetIdx это новая колонка FOUND_EMAIL_COL.
    // Для Acme строки: row[targetIdx] (= '' изначально) → попадает в toProcess.
    // Так что scrape ВЫЗЫВАЕТСЯ. Это правильное поведение: «отдельная колонка
    // нужна для скрапа всех сайтов независимо от исходного email'а».
    expect(out[1][2]).toBe('sales@acme.com'); // исходный не тронут
    expect(out[1][3]).toBe('found@example.com'); // scraped в отдельную
    expect(out[2][2]).toBe(''); // у Beta исходный пустой
    expect(out[2][3]).toBe('found@example.com'); // scrape сработал
    expect(scrapeEmails).toHaveBeenCalledTimes(2);
  });

  it('target="same" + есть исходная email — дополняет ТУ ЖЕ колонку только для пустых ячеек', async () => {
    (scrapeEmails as jest.Mock).mockResolvedValue({ emails: ['found@example.com'] });
    const data = [
      ['Компания', 'Сайт', 'Email'],
      ['Acme', 'acme.com', 'sales@acme.com'], // не пусто → scrape не вызовется
      ['Beta', 'beta.io', ''], // пусто → scrape вызовется
    ];
    const out = await stepFindEmails(data, noopProgress, undefined, { target: 'same' });
    expect(out[0]).toEqual(['Компания', 'Сайт', 'Email']); // новой колонки НЕТ
    expect(out[1][2]).toBe('sales@acme.com'); // legacy email не тронут
    expect(out[2][2]).toBe('found@example.com'); // пустая ячейка заполнена
    expect(scrapeEmails).toHaveBeenCalledTimes(1); // только для Beta
  });

  it('default behavior (no opts) = "same" чтобы НЕ ломать legacy worker code', async () => {
    // Backward-compat: если STEP_RUNNERS вдруг забыл передать opts, поведение
    // должно остаться предсказуемым. Default 'separate' выбираем в STEP_RUNNERS,
    // а сам stepFindEmails — без opts = same (legacy).
    (scrapeEmails as jest.Mock).mockResolvedValue({ emails: ['found@example.com'] });
    const data = [
      ['Сайт', 'Email'],
      ['acme.com', ''],
    ];
    const out = await stepFindEmails(data, noopProgress);
    expect(out[0]).toEqual(['Сайт', 'Email']); // нет FOUND_EMAIL_COL
    expect(out[1][1]).toBe('found@example.com');
  });

  it('target="separate" без исходной email-колонки → fallback на создание "Email" (single column)', async () => {
    (scrapeEmails as jest.Mock).mockResolvedValue({ emails: ['x@y.ru'] });
    const data = [
      ['Сайт'],
      ['only.site'],
    ];
    const out = await stepFindEmails(data, noopProgress, undefined, { target: 'separate' });
    // Нечего «отделять» — fallback в legacy режим создаёт колонку Email.
    expect(out[0]).toEqual(['Сайт', 'Email']);
    expect(out[0]).not.toContain(FOUND_EMAIL_COL);
    expect(out[1][1]).toBe('x@y.ru');
  });

  it('target="separate" + resume: повторный запуск НЕ дублирует FOUND_EMAIL_COL', async () => {
    // Сценарий: воркер упал после первого прохода stepFindEmails (колонка уже
    // создана и заполнена частично), потом resume запустил step заново.
    // FOUND_EMAIL_COL не должна задвоиться в header'е.
    (scrapeEmails as jest.Mock).mockResolvedValue({ emails: ['fresh@y.ru'] });
    const data = [
      ['Сайт', 'Email', FOUND_EMAIL_COL],
      ['a.ru', 'existing@a.ru', ''], // FOUND пусто → re-scrape
      ['b.ru', '', 'already@b.ru'], // FOUND уже заполнен → НЕ скрапим
    ];
    const out = await stepFindEmails(data, noopProgress, undefined, { target: 'separate' });
    expect(out[0].filter((h) => h === FOUND_EMAIL_COL)).toHaveLength(1); // не задвоилась
    expect(out[1][2]).toBe('fresh@y.ru'); // дозаполнили
    expect(out[2][2]).toBe('already@b.ru'); // сохранили
    expect(scrapeEmails).toHaveBeenCalledTimes(1); // только a.ru
  });
  it('prefers HH company_site_url over vacancy and employer hh.ru links', async () => {
    (scrapeEmails as jest.Mock).mockResolvedValue({ emails: ['hello@acme.ru'] });
    const data = [
      ['vacancy_id', 'name', 'url', 'company_name', 'company_url', 'company_site_url'],
      [
        '123',
        'Marketing manager',
        'https://hh.ru/vacancy/123',
        'Acme',
        'https://hh.ru/employer/456',
        'https://acme.ru',
      ],
    ];

    const out = await stepFindEmails(data, noopProgress, undefined, { target: 'separate' });

    expect(scrapeEmails).toHaveBeenCalledTimes(1);
    expect(scrapeEmails).toHaveBeenCalledWith('https://acme.ru', expect.any(Object));
    expect(out[0]).toEqual([...data[0], 'Email']);
    expect(out[1][6]).toBe('hello@acme.ru');
  });

  it('does not scrape HH vacancy or employer links when no real company site is present', async () => {
    (scrapeEmails as jest.Mock).mockResolvedValue({ emails: ['wrong@hh.ru'] });
    const data = [
      ['vacancy_id', 'name', 'url', 'company_name', 'company_url', 'company_site_url'],
      [
        '123',
        'Marketing manager',
        'https://hh.ru/vacancy/123',
        'Acme',
        'https://hh.ru/employer/456',
        '',
      ],
    ];

    const out = await stepFindEmails(data, noopProgress, undefined, { target: 'separate' });

    expect(scrapeEmails).not.toHaveBeenCalled();
    expect(out[0]).toEqual([...data[0], 'Email']);
    expect(out[1][6]).toBe('');
  });
});

describe('stepValidateEmails', () => {
  // Helper: разные email мокаем по-разному.
  const mockValidator = (mapping: Record<string, 'ok' | 'invalid' | 'catch_all' | 'disposable'>) => {
    (validateEmail as jest.Mock).mockImplementation(async (email: string) => ({
      result: mapping[email.toLowerCase()] ?? 'invalid',
      is_free: false,
      is_catch_all: mapping[email.toLowerCase()] === 'catch_all',
    }));
  };

  it('validateTarget="original" — валидирует только исходную email-колонку', async () => {
    mockValidator({ 'good@a.ru': 'ok', 'bad@b.ru': 'invalid' });
    const data = [
      ['Email', FOUND_EMAIL_COL],
      ['good@a.ru', 'ignored@x.ru'],
      ['bad@b.ru', 'also-ignored@y.ru'],
    ];
    const out = await stepValidateEmails(data, noopProgress, undefined, {
      validateTarget: 'original',
    });
    // Header: добавилась ОДНА пара статус+провайдер (для Email), не для FOUND.
    expect(out[0]).toEqual(['Email', FOUND_EMAIL_COL, 'Email Статус', 'Email Провайдер']);
    // bad@b.ru — invalid → строка вылетела по фильтру.
    expect(out).toHaveLength(2); // header + 1 row
    expect(out[1][0]).toBe('good@a.ru');
    // validateEmail вызвался только для исходных (2 строки → 2 вызова).
    expect(validateEmail).toHaveBeenCalledTimes(2);
  });

  it('validateTarget="found" — валидирует только FOUND_EMAIL_COL', async () => {
    mockValidator({ 'good@y.ru': 'ok', 'bad@y.ru': 'invalid' });
    const data = [
      ['Email', FOUND_EMAIL_COL],
      ['anything@a.ru', 'good@y.ru'],
      ['anything@b.ru', 'bad@y.ru'],
    ];
    const out = await stepValidateEmails(data, noopProgress, undefined, {
      validateTarget: 'found',
    });
    expect(out[0]).toEqual(['Email', FOUND_EMAIL_COL, `${FOUND_EMAIL_COL} Статус`, `${FOUND_EMAIL_COL} Провайдер`]);
    expect(out).toHaveLength(2); // header + 1 row (bad@y.ru filtered)
    expect(out[1][1]).toBe('good@y.ru');
    expect(validateEmail).toHaveBeenCalledTimes(2); // только found-колонка
  });

  it('validateTarget="both" — строка остаётся если хотя бы один email прошёл', async () => {
    mockValidator({
      'orig-ok@a.ru': 'ok',
      'orig-bad@a.ru': 'invalid',
      'found-ok@b.ru': 'ok',
      'found-bad@b.ru': 'invalid',
    });
    const data = [
      ['Email', FOUND_EMAIL_COL],
      ['orig-ok@a.ru', 'found-bad@b.ru'], // оригинал ОК → строка остаётся, found чистится
      ['orig-bad@a.ru', 'found-ok@b.ru'], // оригинал плохой → чистится, found ОК → строка остаётся
      ['orig-bad@a.ru', 'found-bad@b.ru'], // оба плохие → строка ВЫЛЕТАЕТ
      ['orig-ok@a.ru', 'found-ok@b.ru'], // оба ОК → остаётся, ничего не чистится
    ];
    const out = await stepValidateEmails(data, noopProgress, undefined, {
      validateTarget: 'both',
    });
    expect(out).toHaveLength(4); // header + 3 rows (одна вылетела)
    // Row 1: orig сохранён, found почищен.
    expect(out[1][0]).toBe('orig-ok@a.ru');
    expect(out[1][1]).toBe(''); // found-bad → cleared
    // Row 2: orig почищен, found сохранён.
    expect(out[2][0]).toBe('');
    expect(out[2][1]).toBe('found-ok@b.ru');
    // Row 3 (была вылетающая) → не в выводе.
    // Row 4 (оба ОК): оба сохранены.
    expect(out[3][0]).toBe('orig-ok@a.ru');
    expect(out[3][1]).toBe('found-ok@b.ru');
    expect(validateEmail).toHaveBeenCalledTimes(8); // 4 строки × 2 колонки
  });

  it('validateTarget="both" с одной колонкой деградирует до single-column поведения', async () => {
    // Если в данных только Email, нет FOUND_EMAIL_COL — 'both' эквивалентно 'original'.
    // Это compatibility-сценарий когда юзер выбрал validate_emails+find_emails(separate)
    // в UI, но find_emails ещё не прошёл (resume в середине).
    mockValidator({ 'ok@a.ru': 'ok' });
    const data = [
      ['Email'],
      ['ok@a.ru'],
    ];
    const out = await stepValidateEmails(data, noopProgress, undefined, {
      validateTarget: 'both',
    });
    expect(out[0]).toEqual(['Email', 'Email Статус', 'Email Провайдер']);
    expect(out).toHaveLength(2);
  });

  it('no email columns at all → no-op (no header changes)', async () => {
    const data = [
      ['Компания'],
      ['Acme'],
    ];
    const out = await stepValidateEmails(data, noopProgress, undefined, {
      validateTarget: 'both',
    });
    expect(out).toEqual(data);
    expect(validateEmail).not.toHaveBeenCalled();
  });

  it('catch_all считается валидным (оставляет строку)', async () => {
    mockValidator({ 'ca@x.ru': 'catch_all' });
    const data = [
      ['Email'],
      ['ca@x.ru'],
    ];
    const out = await stepValidateEmails(data, noopProgress, undefined, {
      validateTarget: 'original',
    });
    expect(out).toHaveLength(2);
    expect(out[1][0]).toBe('ca@x.ru');
  });

  it('default (dropRowsWithoutEmail=true) — строка с пустым email колонкой ДРОПАЕТСЯ', async () => {
    // Реальный кейс polza@polza.ru: 74% строк на выходе были без email'а
    // ('email Статус' пустой), потому что legacy-ветка их сохраняла.
    // Дефолт теперь — дропать такие строки.
    mockValidator({ 'good@x.ru': 'ok' });
    const data = [
      ['Компания', 'Email'],
      ['Acme', 'good@x.ru'],
      ['Beta', ''],         // пустой email → DROP
      ['Gamma', '   '],     // whitespace-only → тоже DROP
    ];
    const out = await stepValidateEmails(data, noopProgress, undefined, {
      validateTarget: 'original',
    });
    // header + 1 валидная строка
    expect(out).toHaveLength(2);
    expect(out[1][0]).toBe('Acme');
  });

  it('dropRowsWithoutEmail=false — legacy-поведение: пустые строки сохраняются', async () => {
    // Опт-ин путь для случаев когда validate — промежуточный шаг enrich-
    // пайплайна, и строки без email ещё могут получить email позже.
    mockValidator({ 'good@x.ru': 'ok' });
    const data = [
      ['Компания', 'Email'],
      ['Acme', 'good@x.ru'],
      ['Beta', ''],         // пустой email → KEEP (legacy)
    ];
    const out = await stepValidateEmails(data, noopProgress, undefined, {
      validateTarget: 'original',
      dropRowsWithoutEmail: false,
    });
    expect(out).toHaveLength(3);
    expect(out[1][0]).toBe('Acme');
    expect(out[2][0]).toBe('Beta');
    expect(out[2][1]).toBe(''); // email остался пустым
  });

  it('default — строка с мусором (не-email) в колонке тоже дропается', async () => {
    // Кейс из job 8b188038-…: cell сдвинулся, в колонке email лежит
    // «Project Administrator — https://...». extractEmail() не найдёт @-pattern,
    // validateEmail не вызовется (статус останется ''), и dropRowsWithoutEmail
    // дропнет строку. Side-effect: фикс sтоп parseCSV сдвига становится мягче —
    // даже если что-то проскользнёт, на выходе мусора не будет.
    mockValidator({ 'real@x.ru': 'ok' });
    const data = [
      ['Email'],
      ['real@x.ru'],
      ['Project Administrator — https://hh.ru/vacancy/1'], // мусор
    ];
    const out = await stepValidateEmails(data, noopProgress, undefined, {
      validateTarget: 'original',
    });
    expect(out).toHaveLength(2);
    expect(out[1][0]).toBe('real@x.ru');
  });
});
