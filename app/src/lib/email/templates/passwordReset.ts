export interface PasswordResetEmailArgs {
  /** Plain-text new password chosen by the server. */
  password: string;
  /** Moscow time when the reset was triggered, formatted like "25.06.2026, 14:23 МСК". */
  resetAtMsk: string;
}

export interface RenderedEmail {
  subject: string;
  html: string;
  text: string;
}

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Email body for the "forgot password" flow: someone hit the public reset
 * endpoint with this account's email, the server rolled a fresh password,
 * and we're delivering it to the address registered for the account.
 *
 * Important UX bits (and security):
 *   - Sender doesn't get to choose the destination — it's always the email
 *     bound to the auth user, not the address they typed. We say so in the
 *     copy so a victim immediately understands what happened if it wasn't them.
 *   - We tell them to log in with this password and change it via Настройки.
 */
export function renderPasswordResetEmail(args: PasswordResetEmailArgs): RenderedEmail {
  const subject = 'outreachOS: восстановление пароля';

  const html = `<!doctype html>
<html lang="ru">
<body style="margin:0;padding:0;background:#f5f5f5;font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#1a1a1a;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f5f5f5;padding:24px 12px;">
    <tr><td align="center">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border-radius:8px;padding:32px;">
        <tr><td>
          <h1 style="font-size:20px;margin:0 0 16px;color:#1a1a1a;">Восстановление пароля</h1>
          <p style="font-size:15px;line-height:1.5;margin:0 0 12px;">
            Кто-то запросил сброс пароля для вашего аккаунта outreachOS <strong>${esc(args.resetAtMsk)}</strong>.
          </p>
          <p style="font-size:15px;line-height:1.5;margin:24px 0 8px;">Ваш новый пароль для входа:</p>
          <p style="margin:0 0 24px;">
            <code style="display:inline-block;font-family:Menlo,Consolas,monospace;font-size:18px;background:#f0f0f0;padding:12px 16px;border-radius:6px;letter-spacing:0.5px;">${esc(args.password)}</code>
          </p>
          <p style="font-size:14px;line-height:1.5;margin:0 0 12px;color:#444;">
            Войдите с этим паролем, затем смените его на свой через раздел «Настройки» в кабинете.
          </p>
          <p style="font-size:13px;line-height:1.5;margin:0 0 12px;color:#666;">
            Рекомендуем удалить это письмо после смены пароля и хранить новый пароль в менеджере паролей.
          </p>
          <hr style="border:none;border-top:1px solid #eee;margin:24px 0;" />
          <p style="font-size:13px;line-height:1.5;margin:0;color:#a00;">
            <strong>Если это были не вы</strong> — обратитесь к администратору.
          </p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;

  const text = [
    'Восстановление пароля',
    '',
    `Кто-то запросил сброс пароля для вашего аккаунта outreachOS ${args.resetAtMsk}.`,
    '',
    `Новый пароль: ${args.password}`,
    '',
    'Войдите с этим паролем, затем смените его на свой через раздел «Настройки» в кабинете.',
    '',
    'Если это были не вы — обратитесь к администратору.',
  ].join('\n');

  return { subject, html, text };
}

export interface PasswordResetLinkEmailArgs {
  /** Ссылка подтверждения: только после перехода по ней пароль меняется. */
  link: string;
  /** Moscow time when the reset was requested, formatted like "25.06.2026, 14:23 МСК". */
  requestedAtMsk: string;
}

/**
 * Первое письмо сброса пароля RU-аккаунта (24.10.2026): ссылка, а не пароль.
 *
 * Раньше пароль менялся сразу по запросу, и любой, кто знал почту сотрудника,
 * мог раз в минуту сбрасывать ему пароль — человек не мог войти. Теперь пароль
 * меняется только после перехода по ссылке из этого письма (_ruReset.ts).
 */
export function renderPasswordResetLinkEmail(args: PasswordResetLinkEmailArgs): RenderedEmail {
  const subject = 'outreachOS: подтвердите сброс пароля';

  const html = `<!doctype html>
<html lang="ru">
<body style="margin:0;padding:0;background:#f5f5f5;font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#1a1a1a;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f5f5f5;padding:24px 12px;">
    <tr><td align="center">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border-radius:8px;padding:32px;">
        <tr><td>
          <h1 style="font-size:20px;margin:0 0 16px;color:#1a1a1a;">Сброс пароля</h1>
          <p style="font-size:15px;line-height:1.5;margin:0 0 12px;">
            Кто-то запросил сброс пароля для вашего аккаунта outreachOS <strong>${esc(args.requestedAtMsk)}</strong>.
          </p>
          <p style="font-size:15px;line-height:1.5;margin:0 0 24px;">
            Если это вы — откройте ссылку и подтвердите сброс. Новый пароль придёт следующим письмом.
          </p>
          <p style="margin:0 0 24px;">
            <a href="${esc(args.link)}" style="display:inline-block;background:#2563eb;color:#ffffff;text-decoration:none;font-size:15px;padding:12px 20px;border-radius:6px;">Сбросить пароль</a>
          </p>
          <p style="font-size:13px;line-height:1.5;margin:0 0 12px;color:#666;">
            Ссылка действует 1 час и срабатывает один раз.
          </p>
          <hr style="border:none;border-top:1px solid #eee;margin:24px 0;" />
          <p style="font-size:13px;line-height:1.5;margin:0;color:#a00;">
            <strong>Если это были не вы</strong> — просто проигнорируйте письмо: пароль не изменится.
          </p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;

  const text = [
    'Сброс пароля',
    '',
    `Кто-то запросил сброс пароля для вашего аккаунта outreachOS ${args.requestedAtMsk}.`,
    '',
    'Если это вы — откройте ссылку и подтвердите сброс. Новый пароль придёт следующим письмом:',
    args.link,
    '',
    'Ссылка действует 1 час и срабатывает один раз.',
    '',
    'Если это были не вы — просто проигнорируйте письмо: пароль не изменится.',
  ].join('\n');

  return { subject, html, text };
}
