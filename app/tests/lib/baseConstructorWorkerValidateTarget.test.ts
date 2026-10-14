/**
 * @jest-environment node
 *
 * validate_target в ручном конструкторе после eager merge.
 *
 * С 27.05.2026 (12843da52) worker сливает «Найденный Email» в исходную
 * колонку ДО split_emails. После этого stepValidateEmails видел одну
 * колонку: 'found' не проверял НИ ОДНОГО адреса (невалидные найденные
 * доживали до выгрузки), 'original' проверял всё. Прод, 120 дней: 7 джоб
 * «Только найденные» ушли без валидации.
 *
 * Контракт (реальные runBaseConstructorJob → split → validate; мокается
 * только скрейп и SMTP-проба):
 *   - 'found'    — проверяются только адреса со скрейпа, исходные остаются
 *                  как есть (доверенные, без статуса);
 *   - 'original' — наоборот;
 *   - 'both', без validate_target (автоматические пайплайны) и старый UI
 *     ('original' без validate_target_explicit) — проверяется всё, как раньше;
 *   - resume посреди find_emails и посреди validate не теряет происхождение;
 *   - повтор уже завершённого validate не проверяет доверенный источник;
 *   - cap_emails_per_company при «Только найденные» не срезает исходные;
 *   - адрес из исходной колонки одной компании, найденный у другой, после
 *     dedup_email остаётся исходным;
 *   - служебная колонка не попадает в результат.
 */

jest.mock('@/lib/supabaseAdmin', () => {
  let currentJob: Record<string, unknown> = {};
  const persisted: Array<{ data: string[][] }> = [];
  const builder = {
    abortSignal: () => builder,
    select: () => builder,
    insert: () => builder,
    update: (patch: Record<string, unknown>) => {
      if (Array.isArray(patch.data)) persisted.push({ data: patch.data as string[][] });
      currentJob = { ...currentJob, ...patch };
      return builder;
    },
    eq: () => builder,
    in: () => builder,
    neq: () => builder,
    single: async () => ({ data: currentJob, error: null }),
    maybeSingle: async () => ({ data: currentJob, error: null }),
  };
  return {
    supabaseAdmin: {
      from: () => builder,
      __setCurrentJob: (job: Record<string, unknown>) => { currentJob = { ...job }; },
      __getCurrentJob: () => currentJob,
      __persisted: persisted,
      __reset: () => { currentJob = {}; persisted.length = 0; },
    },
  };
});

jest.mock('@/lib/emailValidation/validator', () => ({
  validateEmail: jest.fn(),
}));

// Скрейп: «Найденный Email» как у реального stepFindEmails(target='separate'),
// включая resume: существующая колонка дописывается только в пустые ячейки.
const FOUND_BY_SITE: Record<string, string> = {
  'acme.com': 'info@acme.com, bad@acme.com, boss@acme.com',
  'beta.com': 'sales@beta.com',
  'shared.com': 'shared@x.com, sales@shared.com',
  'gamma.com': 'new@gamma.com',
};
jest.mock('@/lib/tools/processingSteps', () => {
  const actual = jest.requireActual('@/lib/tools/processingSteps');
  return {
    ...actual,
    stepFindEmails: async (data: string[][]) => {
      const siteIdx = data[0].indexOf('сайт');
      let foundIdx = data[0].indexOf('Найденный Email');
      let header = data[0];
      let body = data.slice(1).map((row) => [...row]);
      if (foundIdx < 0) {
        foundIdx = header.length;
        header = [...header, 'Найденный Email'];
        body = body.map((row) => [...row, '']);
      }
      for (const row of body) {
        while (row.length < header.length) row.push('');
        if (!row[foundIdx]) row[foundIdx] = FOUND_BY_SITE[row[siteIdx]] ?? '';
      }
      return [header, ...body];
    },
  };
});

import { validateEmail } from '@/lib/emailValidation/validator';
import { runBaseConstructorJob } from '@/lib/tools/baseConstructorWorker';
import { FOUND_EMAIL_ORIGIN_COL } from '@/lib/tools/baseConstructorCheckpoint';

const STATUS: Record<string, string> = {
  'boss@acme.com': 'ok',          // исходный И найденный → считается исходным
  'info@acme.com': 'ok',          // найденный
  'bad@acme.com': 'invalid',      // найденный
  'bad-orig@beta.com': 'invalid', // исходный
  'sales@beta.com': 'catch_all',  // найденный
  'shared@x.com': 'invalid',      // исходный у Alpha, найденный у Shared
  'sales@shared.com': 'ok',       // найденный
  'orig@gamma.com': 'ok',         // исходный
  'prefilled@gamma.com': 'invalid', // из «Найденный Email» в загруженном файле
  'new@gamma.com': 'ok',          // найденный скрейпом
};

const INPUT = [
  ['компания', 'сайт', 'email'],
  ['Acme', 'acme.com', 'boss@acme.com'],
  ['Beta', 'beta.com', 'bad-orig@beta.com'],
];

type AdminMock = {
  __setCurrentJob: (j: Record<string, unknown>) => void;
  __getCurrentJob: () => Record<string, unknown>;
  __persisted: Array<{ data: string[][] }>;
  __reset: () => void;
};
async function admin(): Promise<AdminMock> {
  const mod = await import('@/lib/supabaseAdmin');
  return mod.supabaseAdmin as unknown as AdminMock;
}

// Все адреса базового INPUT (исходные + найденные), по алфавиту.
const ALL_INPUT_EMAILS = ['bad-orig@beta.com', 'bad@acme.com', 'boss@acme.com', 'info@acme.com', 'sales@beta.com'];

const STEPS = ['find_emails', 'split_emails', 'validate_emails'];
// Новый UI шлёт метку вместе с явным выбором источника.
const FOUND = { validate_target: 'found', validate_target_explicit: true };
const ORIGINAL = { validate_target: 'original', validate_target_explicit: true };

async function run(
  stepConfig: Record<string, unknown>,
  extra: Record<string, unknown> = {},
  steps: string[] = STEPS,
) {
  const a = await admin();
  a.__setCurrentJob({
    id: 'job-vt',
    user_id: 'u',
    file_name: 'test.csv',
    status: 'pending',
    selected_steps: steps,
    step_config: { find_emails_target: 'separate', ...stepConfig },
    current_step: 0,
    current_step_progress: 0,
    data: INPUT,
    ...extra,
  });
  await runBaseConstructorJob('job-vt');
  const job = a.__getCurrentJob();
  expect(job.status).toBe('completed');
  const data = job.data as string[][];
  const header = data[0];
  const emailIdx = header.indexOf('email');
  const statusIdx = header.indexOf('email Статус');
  const rows = data.slice(1).map((r) => [r[emailIdx], statusIdx >= 0 ? r[statusIdx] : '']);
  return { header, data, rows: Object.fromEntries(rows), probed: probedEmails() };
}

function probedEmails(): string[] {
  return (validateEmail as jest.Mock).mock.calls.map((c) => c[0]).sort();
}

beforeEach(async () => {
  (await admin()).__reset();
  (validateEmail as jest.Mock).mockReset();
  (validateEmail as jest.Mock).mockImplementation(async (email: string) => ({
    result: STATUS[email] ?? 'unknown', is_free: false, is_catch_all: STATUS[email] === 'catch_all', error: '',
  }));
});

describe('validate_target после eager merge (worker)', () => {
  it("'found' проверяет только найденные адреса; исходные остаются доверенными", async () => {
    const { header, rows, probed } = await run(FOUND);
    expect(probed).toEqual(['bad@acme.com', 'info@acme.com', 'sales@beta.com']);
    expect(rows).toEqual({
      'boss@acme.com': '',          // исходный — не проверялся
      'info@acme.com': 'ok',
      'bad-orig@beta.com': '',      // исходный — не проверялся и НЕ удалён
      'sales@beta.com': 'catch_all',
    });
    expect(header).not.toContain(FOUND_EMAIL_ORIGIN_COL);
    expect(header).not.toContain('Найденный Email');
  });

  it("'original' проверяет только исходные; найденные остаются как есть", async () => {
    const { rows, probed } = await run(ORIGINAL);
    expect(probed).toEqual(['bad-orig@beta.com', 'boss@acme.com']);
    expect(rows).toEqual({
      'boss@acme.com': 'ok',
      'info@acme.com': '',
      'bad@acme.com': '',
      'sales@beta.com': '',
    });
  });

  it("'both' проверяет всё", async () => {
    const { rows, probed } = await run({ validate_target: 'both' });
    expect(probed).toEqual(ALL_INPUT_EMAILS);
    expect(rows).toEqual({ 'boss@acme.com': 'ok', 'info@acme.com': 'ok', 'sales@beta.com': 'catch_all' });
  });

  it('без validate_target (автоматические пайплайны) — проверяется всё, как раньше', async () => {
    const { header, rows, probed } = await run({});
    expect(probed).toEqual(ALL_INPUT_EMAILS);
    expect(rows).toEqual({ 'boss@acme.com': 'ok', 'info@acme.com': 'ok', 'sales@beta.com': 'catch_all' });
    expect(header).not.toContain(FOUND_EMAIL_ORIGIN_COL);
    // Колонка происхождения не создаётся вовсе.
    const persistedHeaders = (await admin()).__persisted.map((p) => p.data[0]);
    expect(persistedHeaders.some((h) => h.includes(FOUND_EMAIL_ORIGIN_COL))).toBe(false);
  });

  it('происхождение сохраняется между шагами и переживает resume посреди validate', async () => {
    await run(FOUND);
    const afterSplit = (await admin()).__persisted
      .map((p) => p.data)
      .find((d) => d[0].includes(FOUND_EMAIL_ORIGIN_COL));
    expect(afterSplit).toBeDefined();

    // Новый worker подхватывает джобу посреди validate_emails (шаг 3 из 3).
    (await admin()).__reset();
    (validateEmail as jest.Mock).mockClear();
    const { rows, probed } = await run(
      FOUND,
      { status: 'processing', current_step: 3, current_step_key: 'validate_emails', current_step_progress: 40, data: afterSplit },
    );
    expect(probed).toEqual(['bad@acme.com', 'info@acme.com', 'sales@beta.com']);
    expect(rows['bad-orig@beta.com']).toBe('');
    expect(rows['bad@acme.com']).toBeUndefined();
  });
  it("старый UI ('original' без метки) — проверяется всё, как до исправления", async () => {
    const { rows, probed } = await run({ validate_target: 'original' });
    expect(probed).toEqual(ALL_INPUT_EMAILS);
    expect(rows).toEqual({ 'boss@acme.com': 'ok', 'info@acme.com': 'ok', 'sales@beta.com': 'catch_all' });
  });

  it('resume посреди find_emails: адреса, найденные после рестарта, остаются «найденными»', async () => {
    // Acme уже обработан до рестарта, Beta — ещё нет.
    const midFind = [
      ['компания', 'сайт', 'email', 'Найденный Email'],
      ['Acme', 'acme.com', 'boss@acme.com', 'info@acme.com, bad@acme.com, boss@acme.com'],
      ['Beta', 'beta.com', 'bad-orig@beta.com', ''],
    ];
    const { rows, probed } = await run(
      FOUND,
      { status: 'processing', current_step: 1, current_step_key: 'find_emails', current_step_progress: 50, data: midFind },
    );
    expect(probed).toEqual(['bad@acme.com', 'info@acme.com', 'sales@beta.com']);
    expect(rows['sales@beta.com']).toBe('catch_all');
    expect(rows['bad-orig@beta.com']).toBe('');
  });

  it("повтор завершённого validate ('original') не проверяет доверенные найденные адреса", async () => {
    // Итог validate «Только исходные» уже сохранён, progress=100, следом cap.
    const validated = [
      ['компания', 'сайт', 'email', 'email Статус', 'email Провайдер'],
      ['Acme', 'acme.com', 'boss@acme.com', 'ok', 'acme.com'],
      ['Acme', 'acme.com', 'info@acme.com', '', ''],
      ['Acme', 'acme.com', 'bad@acme.com', '', ''],
      ['Beta', 'beta.com', 'sales@beta.com', '', ''],
    ];
    const { rows, probed } = await run(
      { ...ORIGINAL, cap_emails_per_company: { max: 5 } },
      { status: 'processing', current_step: 3, current_step_key: 'validate_emails', current_step_progress: 100, data: validated },
      [...STEPS, 'cap_emails_per_company'],
    );
    expect(probed).toEqual([]);
    expect(Object.keys(rows).sort()).toEqual(['bad@acme.com', 'boss@acme.com', 'info@acme.com', 'sales@beta.com']);
  });

  it("«Только найденные» + «Почт на компанию»: исходный доверенный адрес не срезается", async () => {
    const { rows } = await run(
      { ...FOUND, cap_emails_per_company: { max: 1 } },
      {},
      [...STEPS, 'cap_emails_per_company'],
    );
    expect(rows).toEqual({ 'boss@acme.com': '', 'bad-orig@beta.com': '' });
  });

  it('адрес из исходной колонки одной компании, найденный у другой, после dedup_email остаётся исходным', async () => {
    const { rows, probed } = await run(
      FOUND,
      {
        data: [
          ['компания', 'сайт', 'email', 'телефон'],
          ['Alpha', 'alpha.com', 'shared@x.com', ''],
          ['Shared', 'shared.com', '', '+7 999'],
        ],
      },
      ['find_emails', 'split_emails', 'dedup_email', 'validate_emails'],
    );
    expect(probed).toEqual(['sales@shared.com']);
    expect(rows['shared@x.com']).toBe('');
    expect(rows['sales@shared.com']).toBe('ok');
  });
  it("'found' без метки (старая вкладка / очередь) — тоже проверяются только найденные", async () => {
    const { rows, probed } = await run({ validate_target: 'found' });
    expect(probed).toEqual(['bad@acme.com', 'info@acme.com', 'sales@beta.com']);
    expect(rows['bad-orig@beta.com']).toBe('');
  });

  it('в загруженном файле уже есть «Найденный Email» — все найденные адреса остаются «найденными»', async () => {
    const { rows, probed } = await run(
      FOUND,
      {
        data: [
          ['компания', 'сайт', 'email', 'Найденный Email'],
          ['Gamma', 'gamma.com', 'orig@gamma.com', 'prefilled@gamma.com'],
        ],
      },
      ['remove_empty', 'find_emails', 'split_emails', 'validate_emails'],
    );
    expect(probed).toEqual(['new@gamma.com', 'prefilled@gamma.com']);
    expect(rows).toEqual({ 'orig@gamma.com': '', 'new@gamma.com': 'ok' });
  });
});
