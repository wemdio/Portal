/** @jest-environment node */

/**
 * Перепланирование источника. Решает, можно ли попробовать другой запрос или
 * другой источник, не потеряв ограничения плана. Замер, из-за которого правился
 * этот модуль: база по нефтехимии встала на 13 контактах с пометкой «реестр
 * исчерпан», хотя под тем же ОКВЭД в реестре 2 863 компании, а в картах — 27
 * тысяч организаций отрасли. Виноваты были пороги размера компании.
 */
import { safeAlternativeTask } from '@/lib/verticalEngineV2/stages/baseCollect';
import type { VeCollectTask } from '@/lib/verticalEngineV2/prompts/sourcePlan';

const directory = (filters: Record<string, unknown>): VeCollectTask => ({
  source: 'companies_directory', rationale: 'нефтехимия', directory_filters: filters,
} as unknown as VeCollectTask);

describe('safeAlternativeTask', () => {
  it('позволяет альтернативе ослабить порог размера, выдуманный планировщиком', () => {
    // Раньше исходные фильтры перетирали кандидата целиком, и порог «выручка от
    // 100 млн + штат от 50» возвращался на каждой попытке — ослабить его не
    // могла ни одна альтернатива.
    const result = safeAlternativeTask(
      directory({ okvedCodes: ['20.14'] }),
      directory({ okvedCodes: ['20.1'], revenueFrom: 100_000_000, employeesFrom: 50 }),
    );
    expect(result?.directory_filters?.okvedCodes).toEqual(['20.14']);
    expect(result?.directory_filters?.revenueFrom).toBeUndefined();
    expect(result?.directory_filters?.employeesFrom).toBeUndefined();
  });

  it('сохраняет ограничения, которые задал не планировщик: география остаётся', () => {
    const result = safeAlternativeTask(
      directory({ okvedCodes: ['20.14'] }),
      directory({ okvedCodes: ['20.1'], regionCodes: ['77'] }),
    );
    expect(result?.directory_filters?.regionCodes).toEqual(['77']);
  });

  it('порог размера больше не запрещает уход на другой источник', () => {
    // Именно из-за этой ветки карты не попадали в план промышленных вертикалей:
    // любой числовой фильтр считался ограничением, которое карты не исполнят.
    const maps = { source: 'yandex_maps', rationale: 'химия',
      maps_query: { text: 'нефтехимическое производство' } } as unknown as VeCollectTask;
    // Прод-форма: includeIp стоит у 326 задач из 331, и он один запрещал карты.
    expect(safeAlternativeTask(maps, directory({
      okvedCodes: ['20.1'], includeIp: false, revenueFrom: 100_000_000, employeesFrom: 50,
    }))).not.toBeNull();
    // А настоящее ограничение плана по-прежнему запрещает: карты не умеют в регион реестра.
    expect(safeAlternativeTask(maps, directory({ okvedCodes: ['20.1'], regionCodes: ['77'] }))).toBeNull();
  });

  it('исходную задачу hh_live можно заменить реестром или каталогом', () => {
    // 9f82e79d «Риелторские франшизы»: активным источником был поиск вакансий
    // по всей России, и любая замена считалась нарушением его «ограничений».
    const hh = { source: 'hh_live', rationale: 'Агентства, нанимающие риелторов по новостройкам',
      hh_query: { area: '113', text: 'агент по недвижимости новостройки OR риелтор новостройки' } } as unknown as VeCollectTask;
    expect(safeAlternativeTask(directory({ okvedCodes: ['68.31'] }), hh)?.directory_filters?.okvedCodes).toEqual(['68.31']);
    const maps = { source: 'yandex_maps', rationale: 'агентства',
      maps_query: { queries: ['агентство недвижимости'] } } as unknown as VeCollectTask;
    expect(safeAlternativeTask(maps, hh)).toEqual(maps);
    expect(safeAlternativeTask(maps, { ...hh, hh_query: { text: 'риелтор' } } as VeCollectTask)).toEqual(maps);
    // Регион поиска вакансий — настоящая граница: реестр без региона её не исполнит.
    expect(safeAlternativeTask(directory({ okvedCodes: ['68.31'] }), { ...hh, hh_query: { ...hh.hh_query!, area: '1' } } as VeCollectTask)).toBeNull();
    // Живой парсер вакансий взамен по-прежнему не предлагается.
    expect(safeAlternativeTask(hh, directory({ okvedCodes: ['68.3'] }))).toBeNull();
  });
});
