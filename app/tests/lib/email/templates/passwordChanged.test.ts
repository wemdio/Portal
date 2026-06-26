import { renderPasswordChangedEmail } from '@/lib/email/templates/passwordChanged';

describe('renderPasswordChangedEmail', () => {
  const args = {
    password: 'AbcDef123!@x',
    changedAtMsk: '24.06.2026, 15:30 МСК',
    ip: '203.0.113.42',
  };

  it('subject упоминает Portal и пароль', () => {
    const { subject } = renderPasswordChangedEmail(args);
    expect(subject).toMatch(/пароль/i);
    expect(subject).toMatch(/Portal/i);
  });

  it('HTML содержит пароль в <code>', () => {
    const { html } = renderPasswordChangedEmail(args);
    expect(html).toContain('<code');
    expect(html).toContain('AbcDef123!@x');
  });

  it('HTML содержит время изменения и IP', () => {
    const { html } = renderPasswordChangedEmail(args);
    expect(html).toContain('24.06.2026, 15:30 МСК');
    expect(html).toContain('203.0.113.42');
  });

  it('HTML содержит призыв обратиться в поддержку если это не вы', () => {
    const { html } = renderPasswordChangedEmail(args);
    expect(html).toMatch(/поддержк/i);
  });

  it('text-версия не пустая и содержит пароль', () => {
    const { text } = renderPasswordChangedEmail(args);
    expect(text.length).toBeGreaterThan(50);
    expect(text).toContain('AbcDef123!@x');
  });

  it('экранирует HTML-спецсимволы в пароле', () => {
    const { html } = renderPasswordChangedEmail({
      ...args,
      password: 'a<b>c&d"e',
    });
    expect(html).toContain('a&lt;b&gt;c&amp;d&quot;e');
    expect(html).not.toMatch(/<b>c/);
  });

  it('экранирует HTML в IP (защита от injection через X-Forwarded-For)', () => {
    const { html } = renderPasswordChangedEmail({
      ...args,
      ip: '1.2.3.4<script>alert(1)</script>',
    });
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
  });
});
