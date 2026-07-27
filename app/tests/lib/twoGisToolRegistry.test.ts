import { ALL_TOOL_IDS, TOOL_GROUPS, TOOLS_CONFIG } from '@/lib/toolsRegistry';

describe('2GIS parser tool registration', () => {
  it('registers a separate parser and keeps it out of the registry database tool', () => {
    expect(ALL_TOOL_IDS).toContain('2gis-parser');
    expect(TOOLS_CONFIG['2gis-parser']).toEqual(
      expect.objectContaining({
        title: '2GIS Парсер',
        href: '/tools/2gis-parser',
      }),
    );
    expect(TOOLS_CONFIG['2gis-parser'].badge).toBeUndefined();
    expect(TOOLS_CONFIG['2gis-parser'].badge_en).toBeUndefined();
    expect(TOOLS_CONFIG['2gis-parser'].badgeVariant).toBeUndefined();

    const parsers = TOOL_GROUPS.find((group) => group.label === 'Парсеры и поиск лидов');
    const databases = TOOL_GROUPS.find((group) => group.label === 'Базы и данные');
    expect(parsers?.toolIds).toContain('2gis-parser');
    expect(databases?.toolIds).not.toContain('2gis-parser');
    expect(TOOLS_CONFIG['2gis-parser'].href).not.toBe(TOOLS_CONFIG['our-bases'].href);
  });
});
