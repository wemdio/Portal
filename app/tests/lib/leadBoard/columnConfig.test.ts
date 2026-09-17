/** @jest-environment node */

import {
  normalizeColumnConfig,
  makeCustomColumnKey,
  columnLabel,
  isBuiltinColumnKey,
  moveBoardColumn,
  reorderColumnConfig,
} from '@/lib/leadBoard/columnConfig';
import { DEFAULT_COLUMN_CONFIG } from '@/lib/instantly/leadBoardWriter';

describe('normalizeColumnConfig', () => {
  it('пустой вход не по форме → error', () => {
    expect(normalizeColumnConfig('oops').error).toMatch(/array/);
    expect(normalizeColumnConfig(null).error).toMatch(/array/);
    expect(normalizeColumnConfig([null]).error).toMatch(/objects/);
    expect(normalizeColumnConfig([{ visible: true }]).error).toMatch(/key/);
  });

  it('builtin-поднабор сохраняет порядок и видимость, отсутствующие дополняются', () => {
    const n = normalizeColumnConfig([
      { key: 'email', visible: true },
      { key: 'phone', visible: false },
    ]);
    expect(n.error).toBeUndefined();
    expect(n.config!.map((c) => c.key)).toEqual(['email', 'phone', ...DEFAULT_COLUMN_CONFIG.slice(2).map((c) => c.key)]);
    expect(n.config!.find((c) => c.key === 'phone')!.visible).toBe(false);
    expect(n.config!.find((c) => c.key === 'email')!.visible).toBe(true);
  });

  it('кастомная колонка перемещается среди builtin без потери метаданных', () => {
    const n = normalizeColumnConfig([
      { key: 'phone', visible: true },
      { key: 'c_inn', label: 'ИНН', visible: true, custom: true },
    ]);
    expect(n.error).toBeUndefined();
    expect(n.config![1]).toEqual({ key: 'c_inn', label: 'ИНН', visible: true, custom: true });
    expect(n.config!).toHaveLength(DEFAULT_COLUMN_CONFIG.length + 1);
    const columns = n.config!;
    const moved = moveBoardColumn(columns, 'c_inn', 'phone');
    expect(moved[0]).toBe(columns[1]);
    expect(columns[0].key).toBe('phone');
    expect(normalizeColumnConfig(moved).config).toEqual(moved);
    expect(moveBoardColumn(columns, 'missing', 'phone')).toBe(columns);
    expect(moveBoardColumn(columns, 'phone', 'phone')).toBe(columns);
    expect(reorderColumnConfig(columns, moved.map((c) => c.key)).config).toEqual(moved);
    expect(reorderColumnConfig(columns, ['phone']).error).toBeTruthy();
    expect(reorderColumnConfig(columns, columns.map(() => 'phone')).error).toBeTruthy();
    expect(reorderColumnConfig(columns, columns.map((c) => c.key === 'phone' ? 'missing' : c.key)).error).toBeTruthy();
  });

  it('кастомная без label → error; с длинным label → error', () => {
    expect(normalizeColumnConfig([{ key: 'c_inn' }]).error).toMatch(/label/);
    expect(normalizeColumnConfig([{ key: 'c_inn', label: 'x'.repeat(61) }]).error).toMatch(/60/);
  });

  it('неизвестный builtin-ключ и битый custom-ключ → error с ключом', () => {
    expect(normalizeColumnConfig([{ key: 'inn' }]).error).toMatch(/inn/);
    expect(normalizeColumnConfig([{ key: 'custom_inn', label: 'x' }]).error).toMatch(/custom_inn/);
  });

  it('дубликаты ключей → error', () => {
    const n = normalizeColumnConfig([
      { key: 'c_inn', label: 'ИНН' },
      { key: 'c_inn', label: 'ИНН 2' },
    ]);
    expect(n.error).toMatch(/duplicate/);
    expect(normalizeColumnConfig([{ key: 'phone' }, { key: 'phone' }]).error).toMatch(/duplicate/);
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
    expect(isBuiltinColumnKey('__proto__')).toBe(false);
  });
});
