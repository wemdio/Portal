/** @jest-environment node */

import { AGENT_TOOLS, TOOL_NAMES } from '@/lib/telegramAgent/tools';

describe('telegramAgent/tools', () => {
  it('defines exactly 12 tools', () => {
    expect(AGENT_TOOLS).toHaveLength(12);
  });

  it('all tools have type "function"', () => {
    for (const tool of AGENT_TOOLS) {
      expect(tool.type).toBe('function');
    }
  });

  it('all tools have name, description, and parameters', () => {
    for (const tool of AGENT_TOOLS) {
      expect(typeof tool.function.name).toBe('string');
      expect(tool.function.name.length).toBeGreaterThan(0);
      expect(typeof tool.function.description).toBe('string');
      expect(tool.function.description.length).toBeGreaterThan(0);
      expect(tool.function.parameters.type).toBe('object');
      expect(typeof tool.function.parameters.properties).toBe('object');
    }
  });

  it('all tool names are unique', () => {
    const unique = new Set(TOOL_NAMES);
    expect(unique.size).toBe(TOOL_NAMES.length);
  });

  it('TOOL_NAMES matches AGENT_TOOLS names', () => {
    const names = AGENT_TOOLS.map((t) => t.function.name);
    expect(TOOL_NAMES).toEqual(names);
  });

  it.each([
    'get_projects',
    'get_project_detail',
    'get_overdue_projects',
    'get_kpi_summary',
    'get_tasks',
    'get_task_board_summary',
    'get_parser_jobs',
    'get_parser_results_summary',
    'get_instantly_campaigns',
    'get_review_requests',
    'get_team_workload',
    'get_weekly_summary',
  ])('includes tool "%s"', (name) => {
    expect(TOOL_NAMES).toContain(name);
  });
});
