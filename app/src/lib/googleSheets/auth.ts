import { google, type sheets_v4 } from 'googleapis';

/**
 * JWT-клиент от Google service account. Env-переменные:
 * - GOOGLE_SERVICE_ACCOUNT_EMAIL — email, кому шарим таблицы Editor-доступом.
 * - GOOGLE_PRIVATE_KEY — приватный ключ с "\n" вместо реальных переносов строк.
 * Scopes: readonly Drive + read/write Sheets.
 */
export function getSheetsClient(): sheets_v4.Sheets {
  const email = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
  const key = process.env.GOOGLE_PRIVATE_KEY;
  if (!email || !key) {
    throw new Error(
      'GOOGLE_SERVICE_ACCOUNT_EMAIL and GOOGLE_PRIVATE_KEY must be set',
    );
  }

  const auth = new google.auth.JWT({
    email,
    key: key.replace(/\\n/g, '\n'),
    scopes: [
      'https://www.googleapis.com/auth/drive.readonly',
      'https://www.googleapis.com/auth/spreadsheets',
    ],
  });

  return google.sheets({ version: 'v4', auth });
}
