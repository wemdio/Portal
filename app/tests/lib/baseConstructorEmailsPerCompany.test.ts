/**
 * @jest-environment node
 *
 * Настройка «Почт на компанию» ручного конструктора баз. Без неё find_emails
 * останавливал обход на первой странице с адресом, и ~80% компаний получали
 * одну почту (прод, британская база PDL 24.09.2026: 46 227 из 57 309).
 * Контракты:
 *   1. Шаг не выбран → step_config пустой, поведение прежнее.
 *   2. N > 1 + find_emails → stop_at_first=false, max_per_site ≥ N.
 *   3. N = 1 → ранняя остановка остаётся (одной почте полный обход не нужен).
 *   4. Мусорный N с сервера не превращается в NaN (иначе cap срезал бы всё).
 *   5. Связка split → cap действительно оставляет N лучших адресов компании.
 */

import {
  EMAILS_PER_COMPANY_DEFAULT,
  EMAILS_PER_COMPANY_MAX,
  buildEmailsPerCompanyStepConfig,
  normalizeEmailsPerCompany,
  sanitizeEmailsPerCompanyStepConfig,
} from '@/lib/tools/baseConstructorEmailsPerCompany';
import { stepCapEmailsPerCompany, stepSplitEmails } from '@/lib/tools/processingSteps';

const noopProgress = async () => {};

describe('buildEmailsPerCompanyStepConfig', () => {
  it('шаг не выбран — пустой конфиг, worker-дефолты find_emails не меняются', () => {
    expect(buildEmailsPerCompanyStepConfig(['find_emails', 'split_emails'], 5)).toEqual({});
  });

  it('N > 1 с find_emails — выключает раннюю остановку', () => {
    expect(buildEmailsPerCompanyStepConfig(['find_emails', 'split_emails', 'cap_emails_per_company'], 3)).toEqual({
      cap_emails_per_company: { max: 3 },
      find_emails: { stop_at_first: false, max_per_site: 8 },
    });
  });

  it('N больше дефолта max_per_site — адресов с сайта пишется не меньше N', () => {
    expect(buildEmailsPerCompanyStepConfig(['find_emails', 'cap_emails_per_company'], 12)).toEqual({
      cap_emails_per_company: { max: 12 },
      find_emails: { stop_at_first: false, max_per_site: 12 },
    });
  });

  it('N = 1 — только cap, быстрый поиск остаётся', () => {
    expect(buildEmailsPerCompanyStepConfig(['find_emails', 'cap_emails_per_company'], 1)).toEqual({
      cap_emails_per_company: { max: 1 },
    });
  });

  it('без find_emails (почты уже в файле) — только cap', () => {
    expect(buildEmailsPerCompanyStepConfig(['split_emails', 'cap_emails_per_company'], 4)).toEqual({
      cap_emails_per_company: { max: 4 },
    });
  });
});

describe('normalizeEmailsPerCompany', () => {
  it.each([
    [5, 5],
    ['7', 7],
    [2.9, 2],
    [0, 1],
    [-3, 1],
    [999, EMAILS_PER_COMPANY_MAX],
    [NaN, EMAILS_PER_COMPANY_DEFAULT],
    ['abc', EMAILS_PER_COMPANY_DEFAULT],
    ['', EMAILS_PER_COMPANY_DEFAULT],
    [undefined, EMAILS_PER_COMPANY_DEFAULT],
    [null, EMAILS_PER_COMPANY_DEFAULT],
  ])('%p → %p', (input, expected) => {
    expect(normalizeEmailsPerCompany(input)).toBe(expected);
  });
});

describe('sanitizeEmailsPerCompanyStepConfig', () => {
  it('шаг не выбран — конфиг возвращается как есть', () => {
    const cfg = { find_emails_target: 'same', cap_emails_per_company: { max: 'abc' } };
    expect(sanitizeEmailsPerCompanyStepConfig(cfg, ['find_emails'])).toBe(cfg);
  });

  it('мусорный max приводится к допустимому числу, остальные ключи сохраняются', () => {
    expect(sanitizeEmailsPerCompanyStepConfig(
      { find_emails_target: 'separate', cap_emails_per_company: { max: 'abc' } },
      ['find_emails', 'cap_emails_per_company'],
    )).toEqual({ find_emails_target: 'separate', cap_emails_per_company: { max: EMAILS_PER_COMPANY_DEFAULT } });
  });

  it('шаг выбран без настройки — дефолт', () => {
    expect(sanitizeEmailsPerCompanyStepConfig({}, ['cap_emails_per_company'])).toEqual({
      cap_emails_per_company: { max: EMAILS_PER_COMPANY_DEFAULT },
    });
  });
});

describe('split_emails → cap_emails_per_company с N из настройки', () => {
  it('оставляет N адресов компании, приоритет — подтверждённые', async () => {
    const data = [
      ['компания', 'сайт', 'Email'],
      ['Acme', 'acme.co.uk', 'info@acme.co.uk, sales@acme.co.uk, jane@acme.co.uk, john@acme.co.uk'],
      ['Beta', 'beta.co.uk', 'info@beta.co.uk'],
    ];
    const split = await stepSplitEmails(data, noopProgress);
    // Имитация validate_emails: статус лучше у двух последних адресов Acme.
    const statusByEmail: Record<string, string> = {
      'info@acme.co.uk': 'unknown',
      'sales@acme.co.uk': 'catch_all',
      'jane@acme.co.uk': 'ok',
      'john@acme.co.uk': 'ok',
      'info@beta.co.uk': 'ok',
    };
    const validated = [
      [...split[0], 'Email Статус'],
      ...split.slice(1).map((row) => [...row, statusByEmail[row[2]]]),
    ];
    const cfg = buildEmailsPerCompanyStepConfig(['find_emails', 'split_emails', 'cap_emails_per_company'], 2);
    const out = await stepCapEmailsPerCompany(validated, noopProgress, cfg.cap_emails_per_company as { max: number });
    expect(out.slice(1).map((r) => r[2])).toEqual(['jane@acme.co.uk', 'john@acme.co.uk', 'info@beta.co.uk']);
  });
});
