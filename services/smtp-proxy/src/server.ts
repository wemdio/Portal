import { timingSafeEqual } from 'node:crypto';
import Fastify from 'fastify';
import { smtpCheck, type SmtpCheckRequest, type SmtpCheckResult } from './smtp.js';

const API_KEY = process.env.SMTP_PROXY_API_KEY ?? '';
const PORT = Number(process.env.PORT ?? '3100');
const HOST = process.env.HOST ?? '0.0.0.0';

if (!API_KEY) {
  console.error('SMTP_PROXY_API_KEY env variable is required');
  process.exit(1);
}

const EXPECTED_AUTH = `Bearer ${API_KEY}`;

// Constant-time comparison so the key can't be recovered by timing the 401.
function authOk(header: string | undefined): boolean {
  if (!header) return false;
  const a = Buffer.from(header);
  const b = Buffer.from(EXPECTED_AUTH);
  return a.length === b.length && timingSafeEqual(a, b);
}

const app = Fastify({ logger: true });

app.addHook('onRequest', async (req, reply) => {
  if (req.url === '/health') return;
  if (!authOk(req.headers.authorization)) {
    reply.code(401).send({ error: 'Unauthorized' });
  }
});

app.get('/health', async () => ({ status: 'ok' }));

app.post<{ Body: SmtpCheckRequest; Reply: SmtpCheckResult }>('/smtp-check', async (req) => {
  const { email, mxHost, heloDomain, heloFrom, checkCatchAll, timeout } = req.body;

  if (!email || !mxHost) {
    return { code: 0, exists: null, isCatchAll: null, greylist: false, error: 'Missing required fields' } as SmtpCheckResult;
  }

  return smtpCheck({ email, mxHost, heloDomain, heloFrom, checkCatchAll, timeout });
});

async function main() {
  try {
    await app.listen({ port: PORT, host: HOST });
    console.log(`smtp-proxy listening on ${HOST}:${PORT}`);
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}

main();
