describe('tgParserBulkFiles — parseAccountJson logic', () => {
  function toText(value: unknown): string {
    return typeof value === 'string' ? value.trim() : '';
  }

  function parseAccountJson(text: string) {
    const parsed = JSON.parse(text) as unknown;
    const items = Array.isArray(parsed) ? parsed : [parsed];
    return items
      .filter((item): item is Record<string, unknown> => !!item && typeof item === 'object')
      .map((raw) => ({
        api_id: Number(raw.api_id) || 0,
        api_hash: toText(raw.api_hash),
        phone: toText(raw.phone),
        session_string: toText(raw.session_string) || toText(raw.session_data),
        name: toText(raw.name) || toText(raw.session_name),
        proxy_url: toText(raw.proxy_url) || toText(raw.proxy),
      }));
  }

  it('parses single account JSON', () => {
    const json = JSON.stringify({
      api_id: 12345,
      api_hash: 'abc123',
      phone: '+79001234567',
      session_string: 'session-data-here',
      name: 'Test Account',
    });
    const result = parseAccountJson(json);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({
      api_id: 12345,
      api_hash: 'abc123',
      phone: '+79001234567',
      session_string: 'session-data-here',
      name: 'Test Account',
      proxy_url: '',
    });
  });

  it('parses array of accounts', () => {
    const json = JSON.stringify([
      { api_id: 111, api_hash: 'hash1', phone: '+71111111111' },
      { api_id: 222, api_hash: 'hash2', phone: '+72222222222', session_string: 'sess2' },
    ]);
    const result = parseAccountJson(json);
    expect(result).toHaveLength(2);
    expect(result[0].api_id).toBe(111);
    expect(result[0].session_string).toBe('');
    expect(result[1].api_id).toBe(222);
    expect(result[1].session_string).toBe('sess2');
  });

  it('falls back session_data to session_string', () => {
    const json = JSON.stringify({
      api_id: 333,
      api_hash: 'hash3',
      session_data: 'fallback-session',
    });
    const result = parseAccountJson(json);
    expect(result[0].session_string).toBe('fallback-session');
  });

  it('uses session_name as name fallback', () => {
    const json = JSON.stringify({
      api_id: 444,
      api_hash: 'hash4',
      session_name: 'My Session',
    });
    const result = parseAccountJson(json);
    expect(result[0].name).toBe('My Session');
  });

  it('handles proxy_url and proxy fallback', () => {
    const json = JSON.stringify({
      api_id: 555,
      api_hash: 'hash5',
      proxy: 'socks5://user:pass@host:1080',
    });
    const result = parseAccountJson(json);
    expect(result[0].proxy_url).toBe('socks5://user:pass@host:1080');
  });

  it('skips non-object entries in array', () => {
    const json = JSON.stringify([null, 42, 'string', { api_id: 666, api_hash: 'hash6' }]);
    const result = parseAccountJson(json);
    expect(result).toHaveLength(1);
    expect(result[0].api_id).toBe(666);
  });

  it('returns zero api_id for missing field', () => {
    const json = JSON.stringify({ api_hash: 'only-hash' });
    const result = parseAccountJson(json);
    expect(result[0].api_id).toBe(0);
  });
});
