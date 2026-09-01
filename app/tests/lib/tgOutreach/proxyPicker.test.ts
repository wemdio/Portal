import {
  groupProxiesForPicker,
  flattenPickerGroups,
  type PickerProxy,
} from '@/lib/tgOutreach/proxyPicker';

/**
 * Список прокси при назначении на аккаунт.
 *
 * Смысл проверок — порядок, а не подписи: оператор берёт прокси сверху, и
 * рабочие обязаны стоять выше сбоящих. Перепутанный порядок секций молча
 * посадит аккаунт на мёртвый адрес, а по экрану это неотличимо от нормы —
 * строки в списке выглядят одинаково.
 */

const NOW = Date.parse('2026-09-01T12:00:00Z');
const HOUR = 3_600_000;

function proxy(id: string, over: Partial<PickerProxy> = {}): PickerProxy {
  return {
    id,
    url: `http://user:pass@10.0.0.1:${id}`,
    is_active: true,
    last_used_at: new Date(NOW - HOUR).toISOString(),
    ...over,
  };
}

describe('groupProxiesForPicker', () => {
  it('ставит рабочие выше непроверенных, а сбоящие и мёртвые — в самый низ', () => {
    const groups = groupProxiesForPicker(
      [
        proxy('bad', { is_active: false }),
        proxy('warn', { consecutive_errors: 2 }),
        proxy('new', { last_used_at: null }),
        proxy('ok'),
      ],
      NOW,
    );

    expect(groups.map((g) => g.tone)).toEqual(['ok', 'unknown', 'warn', 'bad']);
    expect(groups.map((g) => g.items.map((i) => i.proxy.id))).toEqual([
      ['ok'], ['new'], ['warn'], ['bad'],
    ]);
  });

  it('не показывает секцию, в которой нет ни одного прокси', () => {
    const groups = groupProxiesForPicker([proxy('ok'), proxy('ok2')], NOW);

    expect(groups).toHaveLength(1);
    expect(groups[0].tone).toBe('ok');
    expect(groups[0].items).toHaveLength(2);
  });

  it('внутри секции сохраняет исходный порядок — он по дате добавления', () => {
    const groups = groupProxiesForPicker(
      [proxy('c', { last_used_at: null }), proxy('a', { last_used_at: null }), proxy('b', { last_used_at: null })],
      NOW,
    );

    expect(groups[0].items.map((i) => i.proxy.id)).toEqual(['c', 'a', 'b']);
  });

  it('разворачивает секции в тот же порядок, в каком они на экране — по нему ходят стрелки', () => {
    const groups = groupProxiesForPicker(
      [proxy('warn', { consecutive_errors: 1 }), proxy('ok'), proxy('new', { last_used_at: null })],
      NOW,
    );

    expect(flattenPickerGroups(groups).map((i) => i.proxy.id)).toEqual(['ok', 'new', 'warn']);
  });
});
