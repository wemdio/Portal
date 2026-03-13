/**
 * One-time script to obtain TGPARS_SESSION_STRING.
 * Run: npx ts-node --compiler-options '{"module":"CommonJS"}' scripts/tgpars-session.ts
 * Or: node --loader ts-node/esm scripts/tgpars-session.ts
 *
 * Requires: TELEGRAM_API_ID, TELEGRAM_API_HASH (or TGPARS_API_ID, TGPARS_API_HASH) in .env
 */
import { TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions';
import * as readline from 'readline';

const API_ID = Number(process.env.TGPARS_API_ID || process.env.TELEGRAM_API_ID || '0');
const API_HASH = process.env.TGPARS_API_HASH || process.env.TELEGRAM_API_HASH || '';

async function main() {
  if (!API_ID || !API_HASH) {
    console.error('Set TELEGRAM_API_ID and TELEGRAM_API_HASH (or TGPARS_*) in .env');
    process.exit(1);
  }

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = (q: string) => new Promise<string>((r) => rl.question(q, r));

  const session = new StringSession('');
  const client = new TelegramClient(session, API_ID, API_HASH, { connectionRetries: 3 });

  await client.start({
    phoneNumber: async () => await ask('Phone (e.g. +79001234567): '),
    phoneCode: async () => await ask('Code from Telegram: '),
    password: async () => await ask('2FA password (if set): '),
    onError: (e) => console.error(e),
  });

  const sessionStr = (client.session as StringSession).save();
  console.log('\nTGPARS_SESSION_STRING=' + sessionStr);
  console.log('\nAdd this to your .env file.');
  await client.disconnect();
  rl.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
