/**
 * Бэкфилл колонки «Сайт» гостевой таблицы лидов (project_lead_board_rows).
 *
 * Воркер с <дата коммита> заполняет website фолбэком из домена корпоративной
 * почты лида (lib/leadBoard/deriveWebsite.ts). Этот скрипт догоняет строки,
 * записанные до фикса: website IS NULL → домен почты, кроме персональных
 * ящиков (mail.ru, gmail, ...) и сервисных релеев (zendesk, ...).
 *
 * Список доменов — зеркало isFreeProvider (emailValidation/shared.ts) +
 * SERVICE_DOMAIN_SUFFIXES из deriveWebsite.ts. Если списки там меняются —
 * синхронизировать вручную.
 *
 * Запуск ИЗ КОНТЕЙНЕРА portal-worker/portal-app (там есть DATABASE_URL
 * мгновенно-операционной БД, схема public):
 *   node scripts/backfill-board-website.mjs [--dry-run]
 *
 * Повторный запуск безопасен: трогает только website IS NULL, клиентские
 * колонки (quality/comment/taken) не обновляет.
 */

import { Client } from 'pg';

const FREE_PROVIDERS = new Set([
  'gmail.com','yahoo.com','yahoo.co.uk','yahoo.co.in','yahoo.fr','yahoo.de','yahoo.it',
  'yahoo.es','yahoo.co.jp','yahoo.com.br','yahoo.com.au','yahoo.com.ar','yahoo.com.mx',
  'hotmail.com','hotmail.co.uk','hotmail.fr','hotmail.de','hotmail.it','hotmail.es',
  'outlook.com','outlook.fr','outlook.de','outlook.it','outlook.es','outlook.co.uk',
  'live.com','live.co.uk','live.fr','live.de','live.nl','live.it',
  'msn.com','aol.com','aol.co.uk','protonmail.com','protonmail.ch','proton.me',
  'icloud.com','me.com','mac.com','zoho.com','zohomail.com',
  'mail.ru','bk.ru','inbox.ru','list.ru','internet.ru',
  'pochta.ru','ngs.ru','e1.ru','mail15.com',
  'yandex.ru','yandex.com','yandex.ua','yandex.by','ya.ru',
  'yandex.kz','yandex.uz','yandex.com.tr',
  'rambler.ru','lenta.ru','autorambler.ru','myrambler.ru','ro.ru',
  'gmx.com','gmx.de','gmx.net','gmx.at','gmx.ch',
  'web.de','t-online.de','freenet.de','arcor.de',
  'mail.com','email.com','usa.com','consultant.com','europe.com',
  'fastmail.com','fastmail.fm','tutanota.com','tutanota.de','tuta.io',
  'mailfence.com','disroot.org','riseup.net',
  'qq.com','163.com','126.com','sina.com','sohu.com','aliyun.com',
  'naver.com','daum.net','hanmail.net',
  'wp.pl','onet.pl','interia.pl','o2.pl','poczta.fm',
  'ukr.net','i.ua','meta.ua','bigmir.net',
  'abv.bg','dir.bg','gbg.bg',
  'centrum.cz','seznam.cz','email.cz','post.cz',
  'atlas.sk','azet.sk',
  'freemail.hu','citromail.hu','indamail.hu',
  'libero.it','virgilio.it','tiscali.it','alice.it','tin.it',
  'laposte.net','sfr.fr','free.fr','orange.fr','wanadoo.fr',
  'terra.com.br','bol.com.br','uol.com.br','ig.com.br',
  'rediffmail.com','sify.com',
]);

const SERVICE_SUFFIXES = [
  'zendesk.com', 'freshdesk.com', 'intercom.io', 'helpscout.net',
  'hubspot.com', 'forwarding.email', 'mailinator.com', 'mediacat.email',
];

function deriveWebsite(email) {
  if (!email || typeof email !== 'string') return null;
  const at = email.lastIndexOf('@');
  if (at <= 0 || at === email.length - 1) return null;
  let domain = email.slice(at + 1).trim().toLowerCase();
  if (domain.endsWith('.')) domain = domain.slice(0, -1);
  if (!domain || domain.includes('..') || !domain.includes('.')) return null;
  if (FREE_PROVIDERS.has(domain)) return null;
  if (SERVICE_SUFFIXES.some((sfx) => domain === sfx || domain.endsWith(`.${sfx}`))) return null;
  return domain;
}

const dryRun = process.argv.includes('--dry-run');

const db = new Client({ connectionString: process.env.DATABASE_URL, statement_timeout: 120_000 });
await db.connect();

const { rows } = await db.query(
  "select id, lead_email from project_lead_board_rows where website is null and lead_email is not null",
);
const updates = [];
for (const r of rows) {
  const website = deriveWebsite(r.lead_email);
  if (website) updates.push([website, r.id]);
}

console.log(`строк без сайта: ${rows.length}; будет заполнено: ${updates.length}${dryRun ? ' (dry-run)' : ''}`);
if (!dryRun && updates.length > 0) {
  await db.query('begin');
  try {
    for (const [website, id] of updates) {
      await db.query('update project_lead_board_rows set website = $1, updated_at = now() where id = $2 and website is null', [website, id]);
    }
    await db.query('commit');
    console.log(`обновлено: ${updates.length}`);
  } catch (err) {
    await db.query('rollback');
    throw err;
  }
}
await db.end();
