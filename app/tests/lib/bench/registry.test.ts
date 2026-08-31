/** @jest-environment node */

import { describeBenchTool, getBenchTool, listBenchTools } from '@/lib/bench/registry';

describe('реестр инструментов', () => {
  it('находит инструмент по ключу', () => {
    expect(getBenchTool('yandexmaps')?.id).toBe('yandexmaps');
  });

  it('на неизвестный ключ отдаёт null, а не бросает', () => {
    expect(getBenchTool('нет-такого')).toBeNull();
  });

  it('показывает только разрешённые ключу инструменты', () => {
    const ids = listBenchTools(['yandexmaps']).map((t) => t.id);
    expect(ids).toEqual(['yandexmaps']);
  });

  it('пустой список разрешённых означает «ничего», а не «всё»', () => {
    expect(listBenchTools([])).toEqual([]);
  });

  it('несуществующий инструмент в списке ключа ничего не открывает', () => {
    expect(listBenchTools(['выдуманный'])).toEqual([]);
  });

  it('описание инструмента несёт схему параметров и поддержку остановки', () => {
    const described = describeBenchTool(getBenchTool('yandexmaps')!);
    expect(described.id).toBe('yandexmaps');
    expect(described.kind).toBe('job');
    expect(described.stop_supported).toBe(false);
    expect(described.stop_reason).toContain('остановку');
    expect(described.params).toHaveProperty('properties.search_urls');
  });

  it('знает про поисковый источник', () => {
    expect(getBenchTool('company-base')?.kind).toBe('search');
  });

  it('описывает поисковый источник без остановки', () => {
    const described = describeBenchTool(getBenchTool('company-base')!);
    expect(described.kind).toBe('search');
    expect(described.stop_supported).toBe(false);
    expect(described.stop_reason).toBeNull();
    expect(described.params).toHaveProperty('properties.country');
  });

  it('ключ с одним инструментом не видит второй', () => {
    expect(listBenchTools(['company-base']).map((t) => t.id)).toEqual(['company-base']);
  });
});
