/**
 * Проверки целостности справочника HH-индустрий.
 *
 * Если HH когда-нибудь добавит новую top-level индустрию — обновлять руками,
 * но эти тесты ловят минимальные регрессии (дубликаты id, пустые имена).
 */

import { describe, expect, test } from '@jest/globals';
import { HH_TOP_LEVEL_INDUSTRIES, HH_ALL_INDUSTRY_IDS } from '@/lib/jobs/hhIndustries';

describe('HH industries dictionary', () => {
  test('contains 30 top-level industries (snapshot 2026-05-24)', () => {
    expect(HH_TOP_LEVEL_INDUSTRIES).toHaveLength(30);
  });

  test('all ids are unique', () => {
    const ids = HH_TOP_LEVEL_INDUSTRIES.map((i) => i.id);
    const unique = new Set(ids);
    expect(unique.size).toBe(ids.length);
  });

  test('all names are non-empty', () => {
    for (const ind of HH_TOP_LEVEL_INDUSTRIES) {
      expect(ind.name.trim().length).toBeGreaterThan(0);
    }
  });

  test('all ids are numeric strings (HH API contract)', () => {
    for (const ind of HH_TOP_LEVEL_INDUSTRIES) {
      expect(ind.id).toMatch(/^\d+$/);
    }
  });

  test('HH_ALL_INDUSTRY_IDS matches HH_TOP_LEVEL_INDUSTRIES order', () => {
    expect(HH_ALL_INDUSTRY_IDS).toEqual(HH_TOP_LEVEL_INDUSTRIES.map((i) => i.id));
  });

  test('contains expected anchors — IT, Retail, Finance, Healthcare', () => {
    const ids = new Set(HH_ALL_INDUSTRY_IDS);
    expect(ids.has('7')).toBe(true); // IT
    expect(ids.has('41')).toBe(true); // Розница
    expect(ids.has('43')).toBe(true); // Финансовый сектор
    expect(ids.has('48')).toBe(true); // Медицина
  });
});
