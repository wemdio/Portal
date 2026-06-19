import { _private } from '@/lib/clientSupport/telegramAlert';

const { buildMessage, escapeHtml } = _private;

describe('support telegram escapeHtml', () => {
  it('escapes &, <, >, "', () => {
    expect(escapeHtml('a & b <c> "d"')).toBe('a &amp; b &lt;c&gt; &quot;d&quot;');
  });
});

describe('support telegram buildMessage', () => {
  const base = { clientDisplayName: 'ООО Ромашка', body: 'Здравствуйте, есть вопрос', threadId: 't1' };

  afterEach(() => {
    delete process.env.SUPPORT_ALERTS_PORTAL_URL;
    delete process.env.NEXT_PUBLIC_SITE_URL;
  });

  it('includes the client name and the message body', () => {
    const msg = buildMessage(base);
    expect(msg).toContain('Новое сообщение в поддержку');
    expect(msg).toContain('ООО Ромашка');
    expect(msg).toContain('Здравствуйте, есть вопрос');
  });

  it('escapes HTML in client name and body (no injection)', () => {
    const msg = buildMessage({ ...base, clientDisplayName: '<b>x</b>', body: 'a<script>&"' });
    expect(msg).not.toContain('<b>x</b>');
    expect(msg).toContain('&lt;b&gt;x&lt;/b&gt;');
    expect(msg).toContain('a&lt;script&gt;&amp;&quot;');
  });

  it('adds a portal link only when a base URL is configured (trailing slash trimmed)', () => {
    expect(buildMessage(base)).not.toContain('Открыть в портале');
    process.env.SUPPORT_ALERTS_PORTAL_URL = 'https://portal.example.com/';
    const msg = buildMessage(base);
    expect(msg).toContain('href="https://portal.example.com/support"');
    expect(msg).toContain('Открыть в портале');
  });

  it('truncates a very long body to 1500 chars', () => {
    const long = 'x'.repeat(5000);
    const msg = buildMessage({ ...base, body: long });
    expect((msg.match(/x/g) || []).length).toBe(1500);
  });
});
