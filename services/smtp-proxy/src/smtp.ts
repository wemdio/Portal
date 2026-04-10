import * as net from 'node:net';

const SMTP_CONNECT_TIMEOUT_MS = 8_000;
const SMTP_COMMAND_TIMEOUT_MS = 8_000;

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
  heloDomain: string;
  heloFrom: string;
  checkCatchAll?: boolean;
  timeout?: number;
}

export async function smtpCheck(req: SmtpCheckRequest): Promise<SmtpCheckResult> {
  const timeout = req.timeout ?? SMTP_CONNECT_TIMEOUT_MS;
  const result: SmtpCheckResult = { code: 0, exists: null, isCatchAll: null, greylist: false };

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

    const ehloResp = await smtpCommand(socket, `EHLO ${req.heloDomain}`, SMTP_COMMAND_TIMEOUT_MS);
    if (ehloResp.code !== 250) {
      const heloResp = await smtpCommand(socket, `HELO ${req.heloDomain}`, SMTP_COMMAND_TIMEOUT_MS);
      if (heloResp.code !== 250) {
        result.error = `EHLO/HELO rejected: ${heloResp.code}`;
        return result;
      }
    }

    const mailFrom = await smtpCommand(socket, `MAIL FROM:<${req.heloFrom}>`, SMTP_COMMAND_TIMEOUT_MS);
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
      await smtpCommand(socket, `MAIL FROM:<${req.heloFrom}>`, SMTP_COMMAND_TIMEOUT_MS);
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
