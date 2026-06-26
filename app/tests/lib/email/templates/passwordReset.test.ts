import { renderPasswordResetEmail } from '@/lib/email/templates/passwordReset';

describe('renderPasswordResetEmail', () => {
  const args = {
    password: 'AbcDef123!@x',
    resetAtMsk: '25.06.2026, 18:42 МСК',
    ip: '203.0.113.42',
  };

  it('subject упоминает восстановление пароля', () => {
    const { subject } = renderPasswordResetEmail(args);
    expect(subject).toMatch(/восстановлени|пароль/i);
    expect(subject).toMatch(/Portal/i);
  });

  it('HTML содержит новый пароль в <code>', () => {
    const { html } = renderPasswordResetEmail(args);
    expect(html).toContain('<code');
    expect(html).toContain('AbcDef123!@x');
  });

  it('HTML содержит время сброса и IP', () => {
    const { html } = renderPasswordResetEmail(args);
    expect(html).toContain('25.06.2026, 18:42 МСК');
    expect(html).toContain('203.0.113.42');
  });

  it('HTML подсказывает сменить пароль через Настройки', () => {
    const { html } = renderPasswordResetEmail(args);
    expect(html).toMatch(/Настройк/i);
  });

  it('text-версия содержит пароль и инструкцию', () => {
    const { text } = renderPasswordResetEmail(args);
    expect(text.length).toBeGreaterThan(50);
    expect(text).toContain('AbcDef123!@x');
    expect(text).toMatch(/Настройк/i);
  });

  it('экранирует HTML-спецсимволы в пароле', () => {
    const { html } = renderPasswordResetEmail({
      ...args,
      password: 'a<b>c&d"e',
    });
    expect(html).toContain('a&lt;b&gt;c&amp;d&quot;e');
    expect(html).not.toMatch(/<b>c/);
  });

  it('экранирует HTML в IP (защита от injection через X-Forwarded-For)', () => {
    const { html } = renderPasswordResetEmail({
      ...args,
      ip: '1.2.3.4<script>alert(1)</script>',
    });
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
  });
});
