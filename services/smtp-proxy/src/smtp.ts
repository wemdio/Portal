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
  /** Full text of the RCPT TO reply — lets the caller distinguish a genuine
   *  "user unknown" 550 from a policy/rate-limit 550 instead of treating every
   *  5xx as invalid. */
  smtpText?: string;
  error?: string;
};

function parseSmtpResponse(data: string): SmtpResponse {
  const match = data.match(/^(\d{3})[\s-]/);
  return { code: match ? parseInt(match[1], 10) : 0, text: data.trim() };
}

/**
 * Read one SMTP reply, accumulating across TCP segments. A reply is complete
 * when its FINAL line is "<code><SP>" ("<code>-" marks non-final multiline
 * lines). `data`, `error` and `close` listeners stay attached for the whole
 * read and are torn down in ONE place on settle — so a connection RST mid-reply
 * rejects the promise instead of emitting an unhandled 'error' that crashes the
 * process. Used for both the greeting (no command) and every command.
 */
function readSmtpReply(
  socket: net.Socket,
  timeoutMs: number,
  label: string,
  command?: string,
): Promise<SmtpResponse> {
  return new Promise((resolve, reject) => {
    let accumulated = '';
    let settled = false;
    const cleanup = () => {
      clearTimeout(timer);
      socket.removeListener('data', onData);
      socket.removeListener('error', onError);
      socket.removeListener('close', onClose);
    };
    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      cleanup();
      fn();
    };
    const timer = setTimeout(
      () => settle(() => reject(new Error(`SMTP timeout waiting for ${label}`))),
      timeoutMs,
    );
    const onData = (chunk: Buffer) => {
      accumulated += chunk.toString('utf-8');
      if (/^\d{3} /m.test(accumulated)) settle(() => resolve(parseSmtpResponse(accumulated)));
    };
    const onError = (err: Error) => settle(() => reject(err));
    const onClose = () => settle(() => reject(new Error(`SMTP connection closed before ${label}`)));

    socket.on('data', onData);
    socket.once('error', onError);
    socket.once('close', onClose);
    if (command !== undefined) socket.write(command + '\r\n');
  });
}

function smtpCommand(socket: net.Socket, command: string, timeoutMs: number): Promise<SmtpResponse> {
  return readSmtpReply(socket, timeoutMs, `response to: ${command.split('\r\n')[0]}`, command);
}

function waitForGreeting(socket: net.Socket, timeoutMs: number): Promise<SmtpResponse> {
  return readSmtpReply(socket, timeoutMs, 'greeting');
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

  // Reject control chars (CR/LF/NUL) in anything interpolated into an SMTP
  // command line — blocks SMTP command injection on the connection we open.
  for (const v of [req.email, req.mxHost, heloDomain, heloFrom]) {
    if (typeof v === 'string' && /[\r\n\0]/.test(v)) {
      result.error = 'Invalid characters in request';
      return result;
    }
  }

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
    result.smtpText = rcptTo.text;

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
