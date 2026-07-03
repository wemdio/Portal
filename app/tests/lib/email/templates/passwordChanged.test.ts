import { renderPasswordChangedEmail } from '@/lib/email/templates/passwordChanged';

describe('renderPasswordChangedEmail', () => {
  const args = {
    password: 'AbcDef123!@x',
    changedAtMsk: '24.06.2026, 15:30 МСК',
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

  it('HTML содержит время изменения', () => {
    const { html } = renderPasswordChangedEmail(args);
    expect(html).toContain('24.06.2026, 15:30 МСК');
  });

  it('HTML не содержит строку про IP', () => {
    const { html } = renderPasswordChangedEmail(args);
    expect(html).not.toMatch(/IP/);
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

  it('text-версия не содержит IP', () => {
    const { text } = renderPasswordChangedEmail(args);
    expect(text).not.toMatch(/IP/);
  });

  it('экранирует HTML-спецсимволы в пароле', () => {
    const { html } = renderPasswordChangedEmail({
      ...args,
      password: 'a<b>c&d"e',
    });
    expect(html).toContain('a&lt;b&gt;c&amp;d&quot;e');
    expect(html).not.toMatch(/<b>c/);
  });
});
