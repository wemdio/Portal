/** @jest-environment node */

import { AGENT_TOOLS, WRITE_TOOLS, ALL_TOOLS, TOOL_NAMES, WRITE_TOOL_NAMES } from '@/lib/telegramAgent/tools';

describe('telegramAgent/tools', () => {
  it('defines 12 read tools', () => {
    expect(AGENT_TOOLS).toHaveLength(12);
  });

  it('defines 8 write tools', () => {
    expect(WRITE_TOOLS).toHaveLength(8);
  });

  it('ALL_TOOLS = read + write', () => {
    expect(ALL_TOOLS).toHaveLength(20);
  });

  it('all tools have type "function"', () => {
    for (const tool of ALL_TOOLS) {
      expect(tool.type).toBe('function');
    }
  });

  it('all tools have name, description, and parameters', () => {
    for (const tool of ALL_TOOLS) {
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

  it('TOOL_NAMES matches ALL_TOOLS names', () => {
    const names = ALL_TOOLS.map((t) => t.function.name);
    expect(TOOL_NAMES).toEqual(names);
  });

  it('WRITE_TOOL_NAMES contains all write tools', () => {
    for (const tool of WRITE_TOOLS) {
      expect(WRITE_TOOL_NAMES.has(tool.function.name)).toBe(true);
    }
    expect(WRITE_TOOL_NAMES.size).toBe(8);
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
    'update_project_status',
    'update_project_fields',
    'create_project',
    'create_task',
    'update_task_status',
    'update_task_fields',
    'update_review_status',
    'launch_hh_parser',
  ])('includes tool "%s"', (name) => {
    expect(TOOL_NAMES).toContain(name);
  });
});
