/**
 * Раскладка выпадающего списка вендоров в форме ручной траты.
 *
 * Под тестом здесь то, что глазами не проверяется: порядок групп, хвост из
 * вендоров без категории, момент появления пункта «создать» и то, что стрелка
 * перепрыгивает заголовки групп, а не залипает на них.
 */

import {
  MIN_VENDOR_NAME_LENGTH,
  buildVendorPicker,
  stepVendorItem,
} from '@/lib/expenses/vendorPicker';
import type { VendorOption } from '@/lib/expenses/types';

const OPTIONS: VendorOption[] = [
  { id: 'v-notion', name: 'Notion', category: 'tools' },
  { id: 'v-figma', name: 'Figma', category: 'tools' },
  { id: 'v-fns', name: 'ФНС', category: 'taxes' },
  { id: 'v-adhoc', name: 'Курьер', category: null },
];

function keys(items: ReturnType<typeof buildVendorPicker>['items']): string[] {
  return items.map((item) => item.key);
}

describe('buildVendorPicker', () => {
  it('группирует по категориям в порядке справочника, безкатегорийные — в хвосте', () => {
    const model = buildVendorPicker({ options: OPTIONS, query: '', includeEmpty: false });

    expect(model.groups.map((group) => group.key)).toEqual(['tools', 'taxes', 'unclassified']);
    expect(model.groups[0].label).toBe('Сервисы и подписки');
    expect(model.groups[2].label).toBe('Без категории');
  });

  it('внутри группы сортирует по названию', () => {
    const model = buildVendorPicker({ options: OPTIONS, query: '', includeEmpty: false });

    expect(model.groups[0].items.map((item) => item.option.name)).toEqual(['Figma', 'Notion']);
  });

  it('фильтрует по подстроке без учёта регистра', () => {
    const model = buildVendorPicker({ options: OPTIONS, query: 'not', includeEmpty: false });

    expect(model.groups).toHaveLength(1);
    expect(model.groups[0].items.map((item) => item.option.name)).toEqual(['Notion']);
  });

  it('предлагает создать вендора, когда совпадений нет', () => {
    const model = buildVendorPicker({ options: OPTIONS, query: 'Яндекс Директ', includeEmpty: true });

    expect(model.groups).toHaveLength(0);
    expect(model.createItem).toEqual({ kind: 'create', key: 'create', name: 'Яндекс Директ' });
    // Единственный выбираемый пункт — значит Enter сразу заводит вендора.
    expect(keys(model.items)).toEqual(['create']);
  });

  it('не предлагает создать дубль уже существующего названия', () => {
    const model = buildVendorPicker({ options: OPTIONS, query: '  notion ', includeEmpty: false });

    expect(model.createItem).toBeNull();
    expect(model.groups[0].items).toHaveLength(1);
  });

  it('не предлагает создать имя короче минимальной длины — роут его всё равно не примет', () => {
    const short = 'я'.repeat(MIN_VENDOR_NAME_LENGTH - 1);
    const model = buildVendorPicker({ options: OPTIONS, query: short, includeEmpty: true });

    expect(model.createItem).toBeNull();
    expect(model.items).toHaveLength(0);
  });

  it('пункт «без вендора» показывается только при пустом запросе', () => {
    const idle = buildVendorPicker({ options: OPTIONS, query: '', includeEmpty: true });
    expect(idle.emptyItem).toEqual({ kind: 'empty', key: 'empty' });
    expect(keys(idle.items)[0]).toBe('empty');

    const typing = buildVendorPicker({ options: OPTIONS, query: 'fig', includeEmpty: true });
    expect(typing.emptyItem).toBeNull();
    expect(keys(typing.items)).not.toContain('empty');
  });

  it('в очереди разметки пункта «без вендора» нет вовсе', () => {
    const model = buildVendorPicker({ options: OPTIONS, query: '', includeEmpty: false });

    expect(model.emptyItem).toBeNull();
    expect(keys(model.items)).not.toContain('empty');
  });

  it('порядок items совпадает с порядком отрисовки: пусто → группы → создать', () => {
    const model = buildVendorPicker({ options: OPTIONS, query: '', includeEmpty: true });

    expect(keys(model.items)).toEqual([
      'empty',
      'vendor:v-figma',
      'vendor:v-notion',
      'vendor:v-fns',
      'vendor:v-adhoc',
    ]);
  });
});

describe('stepVendorItem', () => {
  const model = buildVendorPicker({ options: OPTIONS, query: '', includeEmpty: true });

  it('без текущего пункта вниз даёт первый, вверх — последний', () => {
    expect(stepVendorItem(model.items, null, 1)).toBe('empty');
    expect(stepVendorItem(model.items, null, -1)).toBe('vendor:v-adhoc');
  });

  it('перепрыгивает границу групп: заголовков в списке нет', () => {
    // Figma и Notion — «сервисы», ФНС — «налоги»: шаг вниз с Notion попадает
    // сразу на ФНС, а не на заголовок её группы.
    expect(stepVendorItem(model.items, 'vendor:v-notion', 1)).toBe('vendor:v-fns');
  });

  it('зациклен по краям', () => {
    expect(stepVendorItem(model.items, 'vendor:v-adhoc', 1)).toBe('empty');
    expect(stepVendorItem(model.items, 'empty', -1)).toBe('vendor:v-adhoc');
  });

  it('на пустом списке ходить некуда', () => {
    expect(stepVendorItem([], null, 1)).toBeNull();
  });

  it('исчезнувший из списка пункт не роняет навигацию', () => {
    expect(stepVendorItem(model.items, 'vendor:gone', 1)).toBe('empty');
  });
});
