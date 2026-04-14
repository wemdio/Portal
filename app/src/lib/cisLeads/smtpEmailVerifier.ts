/**
 * SMTP email verifier — checks if an email address is deliverable
 * by resolving MX records and performing an SMTP RCPT TO handshake.
 *
 * Limitations:
 * - Port 25 may be blocked on some hosting providers
 * - Catch-all domains always return valid
 * - Some servers greylist first attempts
 */
import 'server-only';

import dns from 'node:dns';
import net from 'node:net';

const SMTP_TIMEOUT_MS = 8_000;
const FROM_EMAIL = 'verify@portal-check.ru';

export type VerifyResult = 'valid' | 'invalid' | 'catch_all' | 'unknown';

interface MxRecord {
  exchange: string;
  priority: number;
}

async function resolveMx(domain: string): Promise<MxRecord[]> {
  return new Promise((resolve, reject) => {
    dns.resolveMx(domain, (err, records) => {
      if (err) return reject(err);
      const sorted = (records ?? []).sort((a, b) => a.priority - b.priority);
      resolve(sorted);
    });
  });
}

function smtpCheck(host: string, email: string): Promise<{ code: number; catchAll: boolean }> {
  return new Promise((resolve) => {
    let resolved = false;
    let buffer = '';
    let stage: 'greeting' | 'ehlo' | 'mail' | 'rcpt' | 'rcpt_fake' | 'quit' = 'greeting';
    let rcptCode = 0;

    const finish = (code: number, catchAll = false) => {
      if (resolved) return;
      resolved = true;
      socket.destroy();
      resolve({ code, catchAll });
    };

    const socket = net.createConnection({ host, port: 25, timeout: SMTP_TIMEOUT_MS });

    const timer = setTimeout(() => finish(0), SMTP_TIMEOUT_MS);

    socket.on('timeout', () => finish(0));
    socket.on('error', () => finish(0));
    socket.on('close', () => { clearTimeout(timer); if (!resolved) finish(0); });

    socket.on('data', (chunk: Buffer) => {
      buffer += chunk.toString();
      if (!buffer.includes('\r\n') && !buffer.includes('\n')) return;

      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        const code = parseInt(line.slice(0, 3), 10);
        if (isNaN(code)) continue;
        if (line.length > 3 && line[3] === '-') continue;

        switch (stage) {
          case 'greeting':
            if (code >= 200 && code < 300) {
              stage = 'ehlo';
              socket.write('EHLO portal-check.ru\r\n');
            } else {
              finish(0);
            }
            break;

          case 'ehlo':
            if (code >= 200 && code < 300) {
              stage = 'mail';
              socket.write(`MAIL FROM:<${FROM_EMAIL}>\r\n`);
            } else {
              finish(0);
            }
            break;

          case 'mail':
            if (code === 250) {
              stage = 'rcpt';
              socket.write(`RCPT TO:<${email}>\r\n`);
            } else {
              finish(0);
            }
            break;

          case 'rcpt':
            rcptCode = code;
            stage = 'rcpt_fake';
            socket.write(`RCPT TO:<definitely-nonexistent-${Date.now()}@${email.split('@')[1]}>\r\n`);
            break;

          case 'rcpt_fake': {
            const fakeAccepted = code === 250;
            stage = 'quit';
            socket.write('QUIT\r\n');
            if (rcptCode === 250 && fakeAccepted) {
              finish(rcptCode, true);
            } else {
              finish(rcptCode);
            }
            break;
          }

          case 'quit':
            finish(rcptCode);
            break;
        }
      }
    });
  });
}

export async function verifyEmail(email: string): Promise<VerifyResult> {
  const parts = email.split('@');
  if (parts.length !== 2) return 'invalid';
  const domain = parts[1]!;

  let mxRecords: MxRecord[];
  try {
    mxRecords = await resolveMx(domain);
  } catch {
    return 'invalid';
  }

  if (mxRecords.length === 0) return 'invalid';

  for (const mx of mxRecords.slice(0, 2)) {
    try {
      const result = await smtpCheck(mx.exchange, email);
      if (result.catchAll) return 'catch_all';
      if (result.code === 250) return 'valid';
      if (result.code >= 500 && result.code < 600) return 'invalid';
    } catch {
      continue;
    }
  }

  return 'unknown';
}

export async function verifyEmailBatch(
  emails: string[],
  concurrency = 3,
): Promise<Map<string, VerifyResult>> {
  const results = new Map<string, VerifyResult>();
  let idx = 0;

  const run = async () => {
    while (idx < emails.length) {
      const i = idx++;
      const email = emails[i]!;
      const result = await verifyEmail(email);
      results.set(email, result);
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(concurrency, emails.length) }, () => run()),
  );

  return results;
}
