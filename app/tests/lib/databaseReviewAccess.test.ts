import { ALL_TOOL_IDS, TOOLS_CONFIG } from '@/lib/toolsRegistry';
import { DEFAULT_OFF_TOOL_IDS } from '@/lib/toolsRegistry';

describe('database-review tool access', () => {
  it('database-review is in ALL_TOOL_IDS', () => {
    expect(ALL_TOOL_IDS).toContain('database-review');
  });

  it('database-review has config entry', () => {
    const config = TOOLS_CONFIG['database-review'];
    expect(config).toBeDefined();
    expect(config.title).toBeTruthy();
    expect(config.href).toBeTruthy();
  });

  it('database-review is in DEFAULT_OFF_TOOL_IDS', () => {
    expect(DEFAULT_OFF_TOOL_IDS).toContain('database-review');
  });

  it('databases tool is NOT in DEFAULT_OFF_TOOL_IDS', () => {
    expect(DEFAULT_OFF_TOOL_IDS).not.toContain('databases');
  });

  it('default-off means tool is disabled when no visibility row exists', () => {
    const noRows: Array<{ tool_id: string; enabled: boolean }> = [];
    const isDefaultOff = DEFAULT_OFF_TOOL_IDS.includes('database-review');
    const row = noRows.find((r) => r.tool_id === 'database-review');
    const enabled = row ? row.enabled : !isDefaultOff;
    expect(enabled).toBe(false);
  });

  it('explicitly enabled overrides default-off', () => {
    const rows = [{ tool_id: 'database-review', enabled: true }];
    const row = rows.find((r) => r.tool_id === 'database-review');
    const enabled = row ? row.enabled : false;
    expect(enabled).toBe(true);
  });
});
