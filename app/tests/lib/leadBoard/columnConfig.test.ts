/** @jest-environment node */

import {
  normalizeColumnConfig,
  makeCustomColumnKey,
  columnLabel,
  isBuiltinColumnKey,
} from '@/lib/leadBoard/columnConfig';
import { DEFAULT_COLUMN_CONFIG } from '@/lib/instantly/leadBoardWriter';

describe('normalizeColumnConfig', () => {
  it('пустой вход не по форме → error', () => {
    expect(normalizeColumnConfig('oops').error).toMatch(/array/);
    expect(normalizeColumnConfig(null).error).toMatch(/array/);
    expect(normalizeColumnConfig([null]).error).toMatch(/objects/);
    expect(normalizeColumnConfig([{ visible: true }]).error).toMatch(/key/);
  });

  it('builtin-поднабор мержится с дефолтом: порядок дефолтный, видимость из payload', () => {
    const n = normalizeColumnConfig([
      { key: 'phone', visible: false },
      { key: 'email', visible: true },
    ]);
    expect(n.error).toBeUndefined();
    expect(n.config!.map((c) => c.key)).toEqual(DEFAULT_COLUMN_CONFIG.map((c) => c.key));
    expect(n.config!.find((c) => c.key === 'phone')!.visible).toBe(false);
    expect(n.config!.find((c) => c.key === 'email')!.visible).toBe(true);
  });

  it('кастомная колонка: label обязателен, идёт после builtin, custom-флаг', () => {
    const n = normalizeColumnConfig([
      { key: 'phone', visible: true },
      { key: 'c_inn', label: 'ИНН', visible: true, custom: true },
    ]);
    expect(n.error).toBeUndefined();
    const last = n.config![n.config!.length - 1];
    expect(last).toEqual({ key: 'c_inn', label: 'ИНН', visible: true, custom: true });
    expect(n.config!).toHaveLength(DEFAULT_COLUMN_CONFIG.length + 1);
  });

  it('кастомная без label → error; с длинным label → error', () => {
    expect(normalizeColumnConfig([{ key: 'c_inn' }]).error).toMatch(/label/);
    expect(normalizeColumnConfig([{ key: 'c_inn', label: 'x'.repeat(61) }]).error).toMatch(/60/);
  });

  it('неизвестный builtin-ключ и битый custom-ключ → error с ключом', () => {
    expect(normalizeColumnConfig([{ key: 'inn' }]).error).toMatch(/inn/);
    expect(normalizeColumnConfig([{ key: 'custom_inn', label: 'x' }]).error).toMatch(/custom_inn/);
  });

  it('дубликат кастомного ключа → error', () => {
    const n = normalizeColumnConfig([
      { key: 'c_inn', label: 'ИНН' },
      { key: 'c_inn', label: 'ИНН 2' },
    ]);
    expect(n.error).toMatch(/duplicate/);
  });

  it('все скрытые → error', () => {
    const n = normalizeColumnConfig(DEFAULT_COLUMN_CONFIG.map((c) => ({ key: c.key, visible: false })));
    expect(n.error).toMatch(/at least one column/);
  });
});

describe('makeCustomColumnKey', () => {
  it('транслитерация кириллицы и уникализация суффиксом', () => {
    expect(makeCustomColumnKey('ИНН', new Set())).toBe('c_inn');
    expect(makeCustomColumnKey('ИНН', new Set(['c_inn']))).toBe('c_inn_2');
    expect(makeCustomColumnKey('ИНН', new Set(['c_inn', 'c_inn_2']))).toBe('c_inn_3');
    expect(makeCustomColumnKey('Тип лида!', new Set())).toBe('c_tip_lida');
    expect(makeCustomColumnKey('!!!', new Set())).toBe('c_col');
  });
});

describe('columnLabel / isBuiltinColumnKey', () => {
  it('builtin берёт лейбл из словаря, custom — свой', () => {
    expect(columnLabel({ key: 'phone', visible: true })).toBe('Контакт');
    expect(columnLabel({ key: 'c_inn', label: 'ИНН', visible: true, custom: true })).toBe('ИНН');
    expect(isBuiltinColumnKey('phone')).toBe(true);
    expect(isBuiltinColumnKey('c_inn')).toBe(false);
  });
});
