import { renderPasswordResetEmail } from '@/lib/email/templates/passwordReset';

describe('renderPasswordResetEmail', () => {
  const args = {
    password: 'AbcDef123!@x',
    resetAtMsk: '25.06.2026, 18:42 МСК',
  };

  it('subject упоминает восстановление пароля и бренд outreachOS', () => {
    const { subject } = renderPasswordResetEmail(args);
    expect(subject).toMatch(/восстановлени|пароль/i);
    expect(subject).toMatch(/outreachOS/i);
  });

  it('HTML использует outreachOS как название аккаунта, не Portal', () => {
    const { html } = renderPasswordResetEmail(args);
    expect(html).toMatch(/outreachOS/i);
    expect(html).not.toMatch(/Portal/);
  });

  it('HTML не упоминает IP запроса (по требованию: убрали из шаблона)', () => {
    const { html } = renderPasswordResetEmail(args);
    expect(html).not.toMatch(/IP/i);
  });

  it('HTML содержит новый пароль в <code>', () => {
    const { html } = renderPasswordResetEmail(args);
    expect(html).toContain('<code');
    expect(html).toContain('AbcDef123!@x');
  });

  it('HTML содержит время сброса', () => {
    const { html } = renderPasswordResetEmail(args);
    expect(html).toContain('25.06.2026, 18:42 МСК');
  });

  it('HTML подсказывает сменить пароль через Настройки', () => {
    const { html } = renderPasswordResetEmail(args);
    expect(html).toMatch(/Настройк/i);
  });

  it('оранжевый блок содержит только короткое «обратитесь к администратору»', () => {
    const { html } = renderPasswordResetEmail(args);
    expect(html).toMatch(/обратитесь к администратору/i);
    // Контролируем что длинная старая копия не вернулась.
    expect(html).not.toMatch(/никто посторонний не получит доступ/);
    expect(html).not.toMatch(/чтобы вернуть контроль/);
  });

  it('text-версия содержит пароль и инструкцию', () => {
    const { text } = renderPasswordResetEmail(args);
    expect(text.length).toBeGreaterThan(50);
    expect(text).toContain('AbcDef123!@x');
    expect(text).toMatch(/Настройк/i);
    expect(text).toMatch(/обратитесь к администратору/i);
  });

  it('экранирует HTML-спецсимволы в пароле', () => {
    const { html } = renderPasswordResetEmail({
      ...args,
      password: 'a<b>c&d"e',
    });
    expect(html).toContain('a&lt;b&gt;c&amp;d&quot;e');
    expect(html).not.toMatch(/<b>c/);
  });
});
