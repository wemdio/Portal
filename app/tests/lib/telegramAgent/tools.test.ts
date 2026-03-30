/** @jest-environment node */

import { AGENT_TOOLS, WRITE_TOOLS, ALL_TOOLS, TOOL_NAMES, WRITE_TOOL_NAMES } from '@/lib/telegramAgent/tools';

describe('telegramAgent/tools', () => {
  it('defines 7 read tools', () => {
    expect(AGENT_TOOLS).toHaveLength(7);
  });

  it('defines 17 write tools', () => {
    expect(WRITE_TOOLS).toHaveLength(17);
  });

  it('ALL_TOOLS = read + write', () => {
    expect(ALL_TOOLS).toHaveLength(24);
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
    expect(WRITE_TOOL_NAMES.size).toBe(17);
  });

  it('query_database is a read tool', () => {
    expect(TOOL_NAMES).toContain('query_database');
    expect(WRITE_TOOL_NAMES.has('query_database')).toBe(false);
  });

  it.each([
    'query_database',
    'export_parser_results',
    'search_knowledge_base',
    'web_search',
    'fetch_url',
    'think',
    'get_pipeline_status',
    'update_project_status',
    'update_project_fields',
    'create_project',
    'create_task',
    'update_task_status',
    'update_task_fields',
    'update_review_status',
    'launch_hh_parser',
    'launch_search_parser',
    'launch_yandex_maps_parser',
    'launch_email_search',
    'launch_email_validation',
    'launch_lpr_search',
    'launch_brief_scoring',
    'clean_company_names',
    'deduplicate_results',
    'create_pipeline',
  ])('includes tool "%s"', (name) => {
    expect(TOOL_NAMES).toContain(name);
  });
});
