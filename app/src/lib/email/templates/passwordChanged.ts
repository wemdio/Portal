export interface PasswordChangedEmailArgs {
  password: string;
  changedAtMsk: string;
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

export function renderPasswordChangedEmail(args: PasswordChangedEmailArgs): RenderedEmail {
  const subject = 'Portal: ваш пароль был изменён';

  const html = `<!doctype html>
<html lang="ru">
<body style="margin:0;padding:0;background:#f5f5f5;font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#1a1a1a;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f5f5f5;padding:24px 12px;">
    <tr><td align="center">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border-radius:8px;padding:32px;">
        <tr><td>
          <h1 style="font-size:20px;margin:0 0 16px;color:#1a1a1a;">Пароль изменён</h1>
          <p style="font-size:15px;line-height:1.5;margin:0 0 12px;">
            Пароль вашего аккаунта в Portal был успешно изменён <strong>${esc(args.changedAtMsk)}</strong>.
          </p>
          <p style="font-size:15px;line-height:1.5;margin:24px 0 8px;">Ваш новый пароль:</p>
          <p style="margin:0 0 24px;">
            <code style="display:inline-block;font-family:Menlo,Consolas,monospace;font-size:18px;background:#f0f0f0;padding:12px 16px;border-radius:6px;letter-spacing:0.5px;">${esc(args.password)}</code>
          </p>
          <p style="font-size:13px;line-height:1.5;margin:0 0 12px;color:#666;">
            Рекомендуем удалить это письмо после прочтения и хранить пароль в менеджере паролей.
          </p>
          <hr style="border:none;border-top:1px solid #eee;margin:24px 0;" />
          <p style="font-size:13px;line-height:1.5;margin:0;color:#a00;">
            <strong>Если это были не вы</strong> — срочно напишите в поддержку: пароль был изменён из вашего личного кабинета, но кто-то мог получить доступ к сессии.
          </p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;

  const text = [
    'Пароль изменён',
    '',
    `Пароль вашего аккаунта в Portal был успешно изменён ${args.changedAtMsk}.`,
    '',
    `Новый пароль: ${args.password}`,
    '',
    'Рекомендуем удалить это письмо после прочтения и хранить пароль в менеджере паролей.',
    '',
    'Если это были не вы — срочно напишите в поддержку.',
  ].join('\n');

  return { subject, html, text };
}
