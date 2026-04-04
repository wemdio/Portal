/** @jest-environment node */

const mockRpc = jest.fn();
const mockHybridSearch = jest.fn();
const mockSerperSearch = jest.fn();

const mockInstantlyRpc = jest.fn();

jest.mock('@/lib/supabaseAdmin', () => ({
  supabaseAdmin: { rpc: (...args: unknown[]) => mockRpc(...args), from: jest.fn() },
}));

jest.mock('@/lib/supabaseInstantly', () => ({
  supabaseInstantly: { rpc: (...args: unknown[]) => mockInstantlyRpc(...args) },
}));

jest.mock('@/lib/knowledgeBase/contextRetriever', () => ({
  hybridSearchChunks: (...args: unknown[]) => mockHybridSearch(...args),
}));

jest.mock('@/lib/parsers/serperSearch', () => ({
  serperSearchDetailed: (...args: unknown[]) => mockSerperSearch(...args),
}));

const mockGetCampaign = jest.fn();

jest.mock('@/lib/instantly/client', () => ({
  getCampaign: (...args: unknown[]) => mockGetCampaign(...args),
}));

jest.mock('@/lib/telegramAgent/pipeline', () => ({
  getPipelineStatus: jest.fn(() => Promise.resolve('Pipeline status')),
  advanceAllPipelines: jest.fn(() => Promise.resolve(0)),
}));

import { toolHandlers } from '@/lib/telegramAgent/handlers';

beforeEach(() => {
  jest.clearAllMocks();
});

describe('telegramAgent/handlers', () => {
  it('exports all read tool handlers', () => {
    expect(typeof toolHandlers.query_database).toBe('function');
    expect(typeof toolHandlers.query_instantly_database).toBe('function');
    expect(typeof toolHandlers.get_campaign_sequences).toBe('function');
    expect(typeof toolHandlers.search_knowledge_base).toBe('function');
    expect(typeof toolHandlers.search_reglament).toBe('function');
    expect(typeof toolHandlers.web_search).toBe('function');
    expect(typeof toolHandlers.fetch_url).toBe('function');
    expect(typeof toolHandlers.think).toBe('function');
    expect(typeof toolHandlers.get_pipeline_status).toBe('function');
    expect(Object.keys(toolHandlers)).toHaveLength(9);
  });

  describe('query_database', () => {
    it('rejects empty query', async () => {
      const result = await toolHandlers.query_database({});
      expect(result).toContain('SQL');
    });

    it('rejects non-SELECT queries', async () => {
      const result = await toolHandlers.query_database({ sql: 'DELETE FROM projects' });
      expect(result).toContain('rejected');
    });

    it('rejects INSERT queries', async () => {
      const result = await toolHandlers.query_database({ sql: 'INSERT INTO projects VALUES (1)' });
      expect(result).toContain('rejected');
    });

    it('rejects UPDATE queries', async () => {
      const result = await toolHandlers.query_database({ sql: 'UPDATE projects SET name = \'x\'' });
      expect(result).toContain('rejected');
    });

    it('rejects DROP queries', async () => {
      const result = await toolHandlers.query_database({ sql: 'DROP TABLE projects' });
      expect(result).toContain('rejected');
    });

    it('rejects auth schema access', async () => {
      const result = await toolHandlers.query_database({ sql: 'SELECT * FROM auth.users' });
      expect(result).toContain('rejected');
    });

    it('allows keywords inside string literals', async () => {
      mockRpc.mockResolvedValue({ data: [{ id: '1' }], error: null });
      const result = await toolHandlers.query_database({
        sql: "SELECT * FROM application_logs WHERE event = 'update' AND source = 'delete_handler'",
      });
      expect(mockRpc).toHaveBeenCalled();
      expect(result).not.toContain('rejected');
    });

    it('still rejects real mutation with keyword in code position', async () => {
      const result = await toolHandlers.query_database({
        sql: "SELECT 1; DELETE FROM projects WHERE name = 'test'",
      });
      expect(result).toContain('rejected');
    });

    it('allows SELECT queries and calls RPC', async () => {
      mockRpc.mockResolvedValue({
        data: [{ id: '1', name: 'Project 1' }],
        error: null,
      });

      const result = await toolHandlers.query_database({
        sql: 'SELECT id, name FROM projects LIMIT 10',
      });

      expect(mockRpc).toHaveBeenCalledWith('agent_query_readonly', {
        query_text: 'SELECT id, name FROM projects LIMIT 10',
      });
      expect(result).toContain('Project 1');
      expect(result).toContain('1 строк');
    });

    it('allows WITH (CTE) queries', async () => {
      mockRpc.mockResolvedValue({ data: [{ cnt: 5 }], error: null });

      const result = await toolHandlers.query_database({
        sql: 'WITH active AS (SELECT * FROM projects WHERE status = \'В работе\') SELECT count(*) AS cnt FROM active',
      });

      expect(mockRpc).toHaveBeenCalled();
      expect(result).toContain('5');
    });

    it('returns error message on RPC failure', async () => {
      mockRpc.mockResolvedValue({ data: null, error: { message: 'permission denied' } });

      const result = await toolHandlers.query_database({
        sql: 'SELECT * FROM projects',
      });
      expect(result).toContain('SQL error');
    });

    it('handles empty results', async () => {
      mockRpc.mockResolvedValue({ data: [], error: null });
      const result = await toolHandlers.query_database({ sql: 'SELECT * FROM projects WHERE 1=0' });
      expect(result).toContain('0 строк');
    });
  });

  describe('search_knowledge_base', () => {
    it('rejects empty query', async () => {
      const result = await toolHandlers.search_knowledge_base({});
      expect(result).toContain('поисковый запрос');
    });

    it('returns formatted results', async () => {
      mockHybridSearch.mockResolvedValue({
        chunks: [
          { chunk_id: 'c1', document_id: 'd1', document_title: 'О продукте', category: 'product_info', content: 'Мы делаем CRM', rank: 1 },
          { chunk_id: 'c2', document_id: 'd2', document_title: 'Кейс Альфа', category: 'cases', content: 'Автоматизация продаж', rank: 0.8 },
        ],
        total: 2,
      });

      const result = await toolHandlers.search_knowledge_base({ query: 'что мы делаем' });
      expect(result).toContain('2 фрагмент');
      expect(result).toContain('О продукте');
      expect(result).toContain('Мы делаем CRM');
      expect(result).toContain('Кейс Альфа');
      expect(mockHybridSearch).toHaveBeenCalledWith(
        expect.anything(),
        'что мы делаем',
        { categories: undefined, limit: 5 },
      );
    });

    it('filters by category', async () => {
      mockHybridSearch.mockResolvedValue({ chunks: [], total: 0 });

      const result = await toolHandlers.search_knowledge_base({ query: 'кейсы', category: 'cases' });
      expect(result).toContain('ничего не найдено');
      expect(mockHybridSearch).toHaveBeenCalledWith(
        expect.anything(),
        'кейсы',
        { categories: ['cases'], limit: 5 },
      );
    });

    it('ignores invalid category', async () => {
      mockHybridSearch.mockResolvedValue({ chunks: [], total: 0 });

      await toolHandlers.search_knowledge_base({ query: 'test', category: 'invalid_cat' });
      expect(mockHybridSearch).toHaveBeenCalledWith(
        expect.anything(),
        'test',
        { categories: undefined, limit: 5 },
      );
    });
  });

  describe('web_search', () => {
    it('rejects empty query', async () => {
      const result = await toolHandlers.web_search({});
      expect(result).toContain('поисковый запрос');
    });

    it('returns formatted search results', async () => {
      mockSerperSearch.mockResolvedValue({
        results: [
          { query: 'test', title: 'Result 1', link: 'https://example.com', snippet: 'Snippet 1', position: 1 },
          { query: 'test', title: 'Result 2', link: 'https://example.org', snippet: 'Snippet 2', position: 2 },
        ],
        debug: { request_url: '', status: 200, organic_count: 2 },
      });

      const result = await toolHandlers.web_search({ query: 'тест' });
      expect(result).toContain('Result 1');
      expect(result).toContain('https://example.com');
      expect(result).toContain('Result 2');
      expect(mockSerperSearch).toHaveBeenCalledWith('тест', { num: 5, gl: 'ru', hl: 'ru' });
    });

    it('respects num parameter capped at 10', async () => {
      mockSerperSearch.mockResolvedValue({ results: [], debug: { request_url: '', status: 200, organic_count: 0 } });
      await toolHandlers.web_search({ query: 'test', num: 50 });
      expect(mockSerperSearch).toHaveBeenCalledWith('test', { num: 10, gl: 'ru', hl: 'ru' });
    });

    it('handles empty results', async () => {
      mockSerperSearch.mockResolvedValue({ results: [], debug: { request_url: '', status: 200, organic_count: 0 } });
      const result = await toolHandlers.web_search({ query: 'nonsense' });
      expect(result).toContain('ничего не найдено');
    });

    it('handles missing API key', async () => {
      mockSerperSearch.mockRejectedValue(new Error('SERPER_API_KEY is not set'));
      const result = await toolHandlers.web_search({ query: 'test' });
      expect(result).toContain('SERPER_API_KEY');
    });
  });

  describe('fetch_url', () => {
    const originalFetch = global.fetch;

    afterEach(() => {
      global.fetch = originalFetch;
    });

    it('rejects empty URL', async () => {
      const result = await toolHandlers.fetch_url({});
      expect(result).toContain('URL');
    });

    it('rejects invalid URL', async () => {
      const result = await toolHandlers.fetch_url({ url: 'not-a-url' });
      expect(result).toContain('Некорректный URL');
    });

    it('fetches and strips HTML', async () => {
      global.fetch = jest.fn().mockResolvedValue(new Response(
        '<html><head><title>Test</title></head><body><h1>Hello</h1><p>World</p></body></html>',
        { status: 200, headers: { 'content-type': 'text/html' } },
      )) as unknown as typeof fetch;

      const result = await toolHandlers.fetch_url({ url: 'https://example.com' });
      expect(result).toContain('Hello');
      expect(result).toContain('World');
      expect(result).not.toContain('<h1>');
    });

    it('handles HTTP errors', async () => {
      global.fetch = jest.fn().mockResolvedValue(new Response('Not Found', { status: 404 })) as unknown as typeof fetch;
      const result = await toolHandlers.fetch_url({ url: 'https://example.com/404' });
      expect(result).toContain('404');
    });
  });

  describe('think', () => {
    it('returns the thought back', async () => {
      const result = await toolHandlers.think({ thought: 'Plan: 1) query DB 2) search web' });
      expect(result).toBe('Plan: 1) query DB 2) search web');
    });

    it('rejects empty thought', async () => {
      const result = await toolHandlers.think({});
      expect(result).toContain('thought');
    });
  });

  describe('query_instantly_database', () => {
    it('rejects empty query', async () => {
      const result = await toolHandlers.query_instantly_database({});
      expect(result).toContain('SQL');
    });

    it('allows SELECT and calls Instantly RPC', async () => {
      mockInstantlyRpc.mockResolvedValue({
        data: [{ name: 'Campaign 1', reply_count: 5 }],
        error: null,
      });

      const result = await toolHandlers.query_instantly_database({
        sql: 'SELECT name, reply_count FROM instantly_campaign_catalog LIMIT 5',
      });
      expect(mockInstantlyRpc).toHaveBeenCalledWith('agent_query_readonly', {
        query_text: 'SELECT name, reply_count FROM instantly_campaign_catalog LIMIT 5',
      });
      expect(result).toContain('Campaign 1');
    });
  });

  describe('get_campaign_sequences', () => {
    it('rejects empty campaign_id', async () => {
      const result = await toolHandlers.get_campaign_sequences({});
      expect(result).toContain('campaign_id');
    });

    it('returns formatted sequences', async () => {
      mockGetCampaign.mockResolvedValue({
        name: 'Test Campaign',
        sequences: [{
          steps: [
            { subject: 'Hello {{first_name}}', body: '<p>First email body</p>', wait_days: 0 },
            { subject: 'Follow up', body: '<p>Second email</p>', wait_days: 3, variants: [{ subject: 'Follow up', body: '<p>Second email</p>' }, { subject: 'Alt subject', body: '<p>Alt body</p>' }] },
          ],
        }],
      });

      const result = await toolHandlers.get_campaign_sequences({ campaign_id: 'abc-123' });
      expect(mockGetCampaign).toHaveBeenCalledWith('abc-123');
      expect(result).toContain('Test Campaign');
      expect(result).toContain('Шагов: 2');
      expect(result).toContain('Hello {{first_name}}');
      expect(result).toContain('First email body');
      expect(result).toContain('задержка 3д');
      expect(result).toContain('A/B вариантов: 2');
    });

    it('handles campaign with no sequences', async () => {
      mockGetCampaign.mockResolvedValue({ name: 'Empty Campaign', sequences: [] });
      const result = await toolHandlers.get_campaign_sequences({ campaign_id: 'empty-1' });
      expect(result).toContain('не содержит');
    });

    it('handles API errors gracefully', async () => {
      mockGetCampaign.mockRejectedValue(new Error('Instantly API 404: not found'));
      const result = await toolHandlers.get_campaign_sequences({ campaign_id: 'bad-id' });
      expect(result).toContain('не найдена');
    });
  });

  describe('get_pipeline_status', () => {
    it('returns pipeline status', async () => {
      const result = await toolHandlers.get_pipeline_status({});
      expect(result).toBe('Pipeline status');
    });
  });
});
