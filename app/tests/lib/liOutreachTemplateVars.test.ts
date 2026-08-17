/** @jest-environment node */

/**
 * Regression: camelCase merge tags rendered as nothing.
 *
 * Prod 2026-08-17. The team writes LinkedIn campaign texts from the internal
 * manual (/reglament), which teaches Instantly's vocabulary — {{firstName}},
 * {{companyName}}. parseMessageTemplate only matched three literal spellings
 * per key (`first_name`, `FIRST_NAME`, `First_name`), so those tags matched
 * nothing and were then wiped by the "clean remaining {{...}}" pass. The
 * greeting «Здравствуйте, {{firstName}}!» left as «Здравствуйте,» and 145 of
 * 160 invites in one week went out without a name — while the health digest
 * stayed green, because its invariant hunts for LEFTOVER braces and the
 * cleanup had removed them all.
 */

import { parseMessageTemplate } from '@/lib/liOutreach/aiService';
import { findUnknownPlaceholders } from '@/lib/liOutreach/messageVars';

const lead = {
  name: 'Michail Morozov',
  first_name: 'Michail',
  last_name: 'Morozov',
  company: 'Kommo',
  position: 'CEO',
};

describe('parseMessageTemplate — merge tag spellings', () => {
  it('renders camelCase tags exactly like their snake_case twins', () => {
    expect(parseMessageTemplate('Здравствуйте, {{firstName}}!', lead)).toBe(
      parseMessageTemplate('Здравствуйте, {{first_name}}!', lead),
    );
    expect(parseMessageTemplate('Здравствуйте, {{firstName}}!', lead)).toBe('Здравствуйте, Michail!');
  });

  it('renders the exact prod invite that went out nameless', () => {
    const invite = 'Здравствуйте, {{firstName}}! Обратил внимание на {{company}} - вижу, что компания развивается.';
    const rendered = parseMessageTemplate(invite, lead);

    expect(rendered).toContain('Здравствуйте, Michail!');
    expect(rendered).toContain('Kommo');
    // The failure signature: greeting collapsed onto the next sentence.
    expect(rendered).not.toContain('Здравствуйте, Обратил');
  });

  it('renders a follow-up whose first word is a tag', () => {
    // Prod text of step 3. It used to start with a bare comma: ", живой пример:".
    expect(parseMessageTemplate('{{firstName}}, живой пример: у клиента было 25+ подрядчиков', lead))
      .toBe('Michail, живой пример: у клиента было 25+ подрядчиков');
  });

  it('accepts companyName / lastName / fullName spellings', () => {
    expect(parseMessageTemplate('{{companyName}}', lead)).toBe('Kommo');
    expect(parseMessageTemplate('{{lastName}}', lead)).toBe('Morozov');
    expect(parseMessageTemplate('{{fullName}}', lead)).toBe('Michail Morozov');
  });

  it('still wipes genuinely unknown tags so raw braces never reach the lead', () => {
    // health-check invariant #1 depends on this.
    expect(parseMessageTemplate('А ваш сайт {{website}} — интересный.', lead)).not.toMatch(/\{\{|\}\}/);
  });

  it('leaves single-brace text alone unless it is a known variable', () => {
    expect(parseMessageTemplate('Скидка {discount} на {company}', lead)).toBe('Скидка {discount} на Kommo');
  });

  it('still picks one option out of {a|b} spintax', () => {
    const out = parseMessageTemplate('{Привет|Здравствуйте}, {{firstName}}', lead);
    expect(['Привет, Michail', 'Здравствуйте, Michail']).toContain(out);
  });

  it('falls back to splitting name when first_name is absent', () => {
    expect(parseMessageTemplate('{{firstName}}', { name: 'Olga Maltseva' })).toBe('Olga');
  });
});

describe('findUnknownPlaceholders — what the operator gets warned about', () => {
  it('reports Instantly-only tags that have no LinkedIn field', () => {
    expect(findUnknownPlaceholders('Ваш сайт {{website}} и телефон {{phone}}')).toEqual(
      expect.arrayContaining(['website', 'phone']),
    );
  });

  it('says nothing about tags that now resolve', () => {
    expect(findUnknownPlaceholders('{{firstName}} из {{companyName}}, {{position}}')).toEqual([]);
  });

  it('ignores single braces — they are ordinary punctuation in chat', () => {
    expect(findUnknownPlaceholders('Скидка {discount}')).toEqual([]);
  });
});
