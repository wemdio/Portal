import * as net from 'node:net';
import * as os from 'node:os';

const SMTP_CONNECT_TIMEOUT_MS = 8_000;
const SMTP_COMMAND_TIMEOUT_MS = 8_000;

const DEFAULT_HELO_DOMAIN = process.env.EMAIL_VALIDATION_HELO_DOMAIN ?? os.hostname();

type SmtpResponse = { code: number; text: string };

export type SmtpCheckResult = {
  code: number;
  exists: boolean | null;
  isCatchAll: boolean | null;
  greylist: boolean;
  error?: string;
};

function parseSmtpResponse(data: string): SmtpResponse {
  const match = data.match(/^(\d{3})[\s-]/);
  return { code: match ? parseInt(match[1], 10) : 0, text: data.trim() };
}

function smtpCommand(socket: net.Socket, command: string, timeoutMs: number): Promise<SmtpResponse> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`SMTP timeout waiting for response to: ${command.split('\r\n')[0]}`));
    }, timeoutMs);

    const onData = (data: Buffer) => {
      clearTimeout(timer);
      socket.removeListener('data', onData);
      socket.removeListener('error', onError);
      const text = data.toString('utf-8');
      if (/^\d{3} /m.test(text)) {
        resolve(parseSmtpResponse(text));
      } else {
        let accumulated = text;
        const onMore = (chunk: Buffer) => {
          accumulated += chunk.toString('utf-8');
          if (/^\d{3} /m.test(accumulated)) {
            clearTimeout(timer);
            socket.removeListener('data', onMore);
            resolve(parseSmtpResponse(accumulated));
          }
        };
        socket.on('data', onMore);
      }
    };
    const onError = (err: Error) => {
      clearTimeout(timer);
      socket.removeListener('data', onData);
      reject(err);
    };

    socket.once('error', onError);
    socket.on('data', onData);
    socket.write(command + '\r\n');
  });
}

function waitForGreeting(socket: net.Socket, timeoutMs: number): Promise<SmtpResponse> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error('SMTP greeting timeout'));
    }, timeoutMs);

    const onData = (data: Buffer) => {
      clearTimeout(timer);
      socket.removeListener('data', onData);
      socket.removeListener('error', onError);
      resolve(parseSmtpResponse(data.toString('utf-8')));
    };
    const onError = (err: Error) => {
      clearTimeout(timer);
      socket.removeListener('data', onData);
      reject(err);
    };

    socket.once('data', onData);
    socket.once('error', onError);
  });
}

export interface SmtpCheckRequest {
  email: string;
  mxHost: string;
  /**
   * Optional. If omitted, the proxy fills it from EMAIL_VALIDATION_HELO_DOMAIN
   * env var or os.hostname(). HELO/PTR must match the proxy's outbound IP.
   */
  heloDomain?: string;
  /**
   * Optional envelope sender for the probe. If omitted, defaults to the
   * EMAIL_VALIDATION_MAIL_FROM env var, otherwise the RFC 5321 null sender
   * `<>`. The null sender is the canonical bounce/verify path and is NOT
   * subject to the receiver's sender-callback verification, so it avoids
   * "550 Sender verify failed" false negatives from hosts (Exim/cPanel) that
   * verify the sender's domain — which a non-deliverable `verify@<host>`
   * sender (no MX) would trip. Pass an explicit address to override.
   */
  heloFrom?: string;
  checkCatchAll?: boolean;
  timeout?: number;
}

export async function smtpCheck(req: SmtpCheckRequest): Promise<SmtpCheckResult> {
  const timeout = req.timeout ?? SMTP_CONNECT_TIMEOUT_MS;
  const result: SmtpCheckResult = { code: 0, exists: null, isCatchAll: null, greylist: false };

  const heloDomain = req.heloDomain ?? DEFAULT_HELO_DOMAIN;
  // Default to the RFC 5321 null sender `<>` for the probe envelope. EHLO still
  // uses heloDomain (must match the proxy's PTR), but the MAIL FROM is `<>` so
  // receivers that do sender-callback verification (Exim/cPanel "verify =
  // sender") can't reject us with "550 Sender verify failed" for an
  // unverifiable sender domain. EMAIL_VALIDATION_MAIL_FROM overrides if set.
  const heloFrom = req.heloFrom ?? process.env.EMAIL_VALIDATION_MAIL_FROM ?? '';

  let socket: net.Socket | null = null;

  try {
    socket = await new Promise<net.Socket>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('SMTP connect timeout')), timeout);
      const s = net.createConnection({ host: req.mxHost, port: 25, timeout }, () => {
        clearTimeout(timer);
        resolve(s);
      });
      s.once('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });

    const greeting = await waitForGreeting(socket, SMTP_COMMAND_TIMEOUT_MS);
    if (greeting.code !== 220) {
      result.error = `Unexpected greeting: ${greeting.code}`;
      return result;
    }

    const ehloResp = await smtpCommand(socket, `EHLO ${heloDomain}`, SMTP_COMMAND_TIMEOUT_MS);
    if (ehloResp.code !== 250) {
      const heloResp = await smtpCommand(socket, `HELO ${heloDomain}`, SMTP_COMMAND_TIMEOUT_MS);
      if (heloResp.code !== 250) {
        result.error = `EHLO/HELO rejected: ${heloResp.code}`;
        return result;
      }
    }

    const mailFrom = await smtpCommand(socket, `MAIL FROM:<${heloFrom}>`, SMTP_COMMAND_TIMEOUT_MS);
    if (mailFrom.code !== 250) {
      result.error = `MAIL FROM rejected: ${mailFrom.code}`;
      return result;
    }

    const rcptTo = await smtpCommand(socket, `RCPT TO:<${req.email}>`, SMTP_COMMAND_TIMEOUT_MS);
    result.code = rcptTo.code;

    if (rcptTo.code === 250) {
      result.exists = true;
    } else if (rcptTo.code >= 550 && rcptTo.code <= 559) {
      result.exists = false;
    } else if (rcptTo.code >= 450 && rcptTo.code <= 459) {
      result.greylist = true;
      result.exists = null;
    } else if (rcptTo.code >= 400 && rcptTo.code < 500) {
      result.greylist = true;
      result.exists = null;
    }

    if (req.checkCatchAll && result.exists === true) {
      const domain = req.email.split('@')[1];
      const randomLocal = `verify-check-${Date.now()}-${Math.random().toString(36).substring(2, 10)}`;
      const randomEmail = `${randomLocal}@${domain}`;

      await smtpCommand(socket, 'RSET', SMTP_COMMAND_TIMEOUT_MS);
      await smtpCommand(socket, `MAIL FROM:<${heloFrom}>`, SMTP_COMMAND_TIMEOUT_MS);
      const catchAllRcpt = await smtpCommand(socket, `RCPT TO:<${randomEmail}>`, SMTP_COMMAND_TIMEOUT_MS);

      if (catchAllRcpt.code === 250) {
        result.isCatchAll = true;
      } else if (catchAllRcpt.code >= 550 && catchAllRcpt.code <= 559) {
        result.isCatchAll = false;
      }
    }

    try {
      await smtpCommand(socket, 'QUIT', 3000);
    } catch {
      // QUIT timeout is non-critical
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'SMTP error';
    result.error = msg;

    if (msg.includes('ECONNREFUSED') || msg.includes('connect timeout')) {
      result.exists = null;
    }
  } finally {
    if (socket) {
      try { socket.destroy(); } catch { /* ignore */ }
    }
  }

  return result;
}
