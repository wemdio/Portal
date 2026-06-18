#!/usr/bin/env node
/**
 * label-new-replies.mjs — ночная авто-разметка НОВЫХ ответов лидов.
 *
 * Запускается своим cron после dataset-sync (sync.mjs). Размечает только
 * (campaign, lead)-пары, которых ещё нет в reply_outcome_labels:
 *   1) бесплатные детерминированные правила (regex) — ловят ~2/3 (авто/отказы/«не туда»);
 *   2) остаток (судейские: интерес/реферал/вопрос/возражение) — LLM через Requesty.
 * Идемпотентно (ON CONFLICT DO NOTHING). Бюджет ограничен LABEL_NIGHTLY_CAP.
 *
 * ENV:
 *   INSTANTLY_DATASET_DB_URL  — датасет-БД (обязателен)
 *   REQUESTY_API_KEY          — ключ Requesty (если нет — только правила, LLM пропускается)
 *   REQUESTY_MODEL            — модель (default anthropic/claude-opus-4-8); меняется без передеплоя
 *   REQUESTY_ENDPOINT         — default https://router.requesty.ai/v1/chat/completions
 *   LABEL_NIGHTLY_CAP         — макс. LLM-размечаемых за ночь (default 4000)
 *   LABEL_BATCH_SIZE          — пар на один LLM-вызов (default 25)
 *
 * Флаги: --dry (ничего не пишет), --rules-only (без LLM).
 */
import { readFileSync } from 'fs';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { Client } = require('pg');

const DRY = process.argv.includes('--dry');
const RULES_ONLY = process.argv.includes('--rules-only');

// env: из process.env (cron --env-file) или ../../../.env при локальном запуске
function loadEnv() {
  if (process.env.INSTANTLY_DATASET_DB_URL) return process.env;
  try {
    const txt = readFileSync(new URL('../../../.env', import.meta.url), 'utf8');
    for (const l of txt.split('\n')) {
      if (!l.includes('=') || l.trim().startsWith('#')) continue;
      const i = l.indexOf('='); const k = l.slice(0, i).trim();
      if (!(k in process.env)) process.env[k] = l.slice(i + 1).trim();
    }
  } catch { /* prod: только process.env */ }
  return process.env;
}
const env = loadEnv();
const MODEL = env.REQUESTY_MODEL || 'anthropic/claude-opus-4-8';
const ENDPOINT = env.REQUESTY_ENDPOINT || 'https://router.requesty.ai/v1/chat/completions';
const CAP = parseInt(env.LABEL_NIGHTLY_CAP || '4000', 10);
const BATCH = parseInt(env.LABEL_BATCH_SIZE || '25', 10);
const KEY = env.REQUESTY_API_KEY || '';
// Окно свежести: ночью размечаем только последние N дней (бэкфилл закрыл историю).
// Это и быстро (не сканируем 2.1M каждую ночь), и логически верно — нужны новые ответы.
// Разовый прогон всей истории: --all (или WINDOW_DAYS=99999).
const WINDOW_DAYS = process.argv.includes('--all') ? 99999 : parseInt(env.LABEL_WINDOW_DAYS || '14', 10);
const WINDOW = `timestamp_email BETWEEN now() - interval '${WINDOW_DAYS} days' AND now() + interval '1 day'`;

const log = (m) => console.log(`[${new Date().toISOString()}] ${m}`);

// ── правила (зеркало label-replies-rules.mjs; высокая точность, первая сработавшая побеждает) ──
const RULES = [
  ['auto_reply', String.raw`(не удалось (выполнить )?доставку|адрес(а)? .{0,30}не (существ|найден)|delivery (has )?(failed|status|failure)|undeliverable|mailbox (unavailable|full)|antispam found|message you sent .{0,30}(deleted|blocked))`],
  ['auto_reply', String.raw`((нахожусь|буду находиться|буду|я)? ?(в|на)? ?(ежегодном |очередном )?отпуск[еа]|в отпуске|отсутству(ю|ет|вать).{0,40}(на рабочем месте|в офисе|до|без доступа)|буду отсутствовать|без доступа к (почте|телефону|электронной)|временно (недоступен|отсутству)|on (annual )?(leave|vacation)|out of (the )?office|i am (currently )?(out|away|on)|с \d{1,2}[.\s/]\d{1,2}.{0,25}(по|до).{0,25}\d{1,2}[.\s/]\d{1,2}.{0,40}(отпуск|отсутств|вернусь)|по всем (вопросам|неотложным).{0,30}(обращайтесь|прошу обращаться))`],
  ['auto_reply', String.raw`((адрес|почт[аеу]|ящик|email|e-mail).{0,45}(измен(ён|ен|ил)|замен(ён|ен)|больше не (использ|действ|актуал)|не (используется|актуал(ен|ьна|ьн)|действ)|прекра(тил|щает)|переход[еа]? на)|(новый|актуальн(ый|ая)|обновлённ(ый|ая)).{0,15}(официальный )?(адрес|email|e-mail|почт)|просим .{0,25}(направлять|отправлять|присылать).{0,30}(на (новый|адрес|почт|обновл)|по (новому|адресу))|смен(а|е|ился|илась) (адреса|почты|реквизит)|уведомля(ем|ю).{0,40}смен)`],
  ['auto_reply', String.raw`(автоматическ(ий|ое|и) (ответ|уведомлен|сформирован|создан)|это автоответ|автоответчик|ваше (письмо|сообщение|обращение|заявка|запрос) (получен|принят|зарегистрир|доставлен|зафиксирован)|мы получили ваш|получили ваше (письмо|сообщение|обращение)|заявк[аи] (зарегистрир|принят|получен|присвоен|успешно)|номер (вашего )?(обращения|заявки)|присвоен номер|специалист[ы]?.{0,30}свяж|менеджер.{0,30}свяж[ие]|с вами свяжет?ся|ответим (вам )?(в течение|в ближайш|не позднее|после)|не отвечайте на (это|данное|эт)|сообщение (создано|сформировано|сгенерировано) автоматически|дежурн(ый|ая) менеджер|в порядке очереди|поздравляем.{0,25}(с наступающ|праздник|новым годом)|обращения.{0,40}не рассматрива|оцените (качество|ответ|мою работу|работу)|ticket #|request \(?\d{3,}|has been (created|received)|thank you for (contacting|reaching out)|we('| ha)?ve received your|спасибо,? получил|принято к сведению|принято в работу)`],
  ['unsubscribe', String.raw`(прекратите (мне |нам )?(писать|слать|спамить|рассыл)|перестаньте (писать|слать|беспокоить)|хватит (писать|слать|спамить)|удалите (нас|меня|наш|мой|нашу почту|мой адрес|из (базы|рассылки|списка))|исключите (нас|меня|наш адрес|мой адрес) из|отпишите (нас|меня)|уберите (нас|меня|наш|мой) из|не пишите (нам|мне|сюда) (больше|более)|больше (нам |мне )?не пишите|^\s*спам\s*$|это спам[ !.]|пометил.{0,12}как спам|не беспокоить|пожалуюсь|жалоб[ауы] в (роскомнадзор|фас))`],
  ['wrong_person', String.raw`((я |уже |давно )?(здесь |тут |там )?(больше )?не работаю|не работаю (в|здесь|тут|у)|сотрудником .{0,40}не являюсь|не являюсь (сотрудником|работником)|уволил(ся|ась|и)|вы ошиблись( адресом| почтой| номером)?|ошиблись адресом|(письмо|обращение).{0,20}(не нам|не по адресу|надо направить|не тот)|не по адресу|попали не туда|это (личная|частная|моя личная) почта|мы не (та компания|та организация|занимаемся (этим|таким)|медицинская|клиника)|проект заморожен|не осуществляем деятельность|организация ликвидирована|ликвидирован[ао]? (с|в|\d|19|20)|компания (закрыта|закрылась|ликвидирована|прекратила)|мы закрылись|предприятие (закрыто|ликвидировано)|(организация|компания|мы) банкрот|признан[ао]? банкротом|ceased operations|no longer (active|work))`],
  ['not_interested', String.raw`(^((добрый день|здравствуйте|спасибо|благодарю)[!,.\s]{0,6})*(нам |мне |нас )?(это |этот |ваш[еи]? )?(не ?интересн|не интересует|не актуальн|не требуется|не нужн|не надо|неинтересно|не рассматрива|не планир)|спасибо,? (но )?(нам |мне |это )?(не интересн|не актуальн|не нужн|не требуется|не рассматрива|не планир|отказ)|не заинтересован|нет потребности|не нуждаемся|нет (необходимости|надобности)|услуги (не требуются|не нужны|нам не)|не рассматриваем (сотрудничеств|новый|ваш|предложен)|не планируем (такую|менять|переход|сотруднич)|отказываем|нам не нужн|у нас (уже )?(всё|все) (есть|устраивает|автоматизир)|нас (всё|все) устраивает|работаем с другим|есть (действующий |свой )?(подрядчик|провайдер|сервис|поставщик))`],
];

const clean = `trim(regexp_replace(body_text, '[[:space:]]+', ' ', 'g'))`;

async function applyRules(c) {
  let total = 0;
  for (const [label, pat] of RULES) {
    if (DRY) {
      const r = await c.query(
        `WITH best AS (SELECT DISTINCT ON (campaign_id, lead_id) campaign_id, lead_id, ${clean} body
           FROM raw_emails WHERE ue_type=2 AND lead_id IS NOT NULL AND campaign_id IS NOT NULL
             AND ${WINDOW}
           ORDER BY campaign_id, lead_id, length(coalesce(body_text,'')) DESC)
         SELECT count(*) n FROM best b LEFT JOIN reply_outcome_labels l USING (campaign_id, lead_id)
         WHERE l.campaign_id IS NULL AND b.body ~* $1`, [pat]);
      total += Number(r.rows[0].n);
    } else {
      const r = await c.query(
        `WITH best AS (SELECT DISTINCT ON (campaign_id, lead_id) campaign_id, lead_id, md5(coalesce(body_text,'')) h, ${clean} body
           FROM raw_emails WHERE ue_type=2 AND lead_id IS NOT NULL AND campaign_id IS NOT NULL
             AND ${WINDOW}
           ORDER BY campaign_id, lead_id, length(coalesce(body_text,'')) DESC)
         INSERT INTO reply_outcome_labels (campaign_id, lead_id, label, confidence, model, rubric_version, body_hash)
         SELECT b.campaign_id, b.lead_id, $2, NULL, 'rules-v1', 'v1', b.h FROM best b
         LEFT JOIN reply_outcome_labels l USING (campaign_id, lead_id)
         WHERE l.campaign_id IS NULL AND b.body ~* $1 ON CONFLICT DO NOTHING`, [pat, label]);
      total += r.rowCount;
    }
  }
  return total;
}

// ── LLM-проход (Requesty, OpenAI-формат) ──
const LABELS = new Set(['interested','referral','question','objection','not_interested','unsubscribe','auto_reply','wrong_person','other']);
const SYSTEM = `Ты размечаешь ответы лидов на холодные B2B-письма (русский рынок). На каждую строку верни ровно одну метку:
- interested: просят КП/прайс/детали/презентацию, предлагают созвон/встречу, «пришлите», «давайте обсудим», «высылайте»
- referral: дали КОНКРЕТНЫЙ контакт нужного человека (почта/телефон в тексте) или «обратитесь к X». Просто «передали руководству» без контакта = other
- question: уточняют без интереса («а вы кто?», «что предлагаете?», «по какому вопросу?»)
- objection: возражение не категоричное («дорого», «не сейчас», «есть подрядчик», «после праздников», «мы на Unisender»)
- not_interested: отказ («не интересно», «не нужно», «не актуально», «у нас всё есть»)
- unsubscribe: «прекратите писать», «удалите из базы», жалоба на спам, угрозы
- auto_reply: автоответ/OOO, «письмо получено», «ответим позже», смена адреса, NDR
- wrong_person: «я здесь не работаю», «вы ошиблись адресом», «мы не та компания», «ликвидирована»
- other: пустое/нечитаемое/неклассифицируемое; вежливое «передали, если интересно свяжемся» без контакта
Ответь ТОЛЬКО JSON-массивом строк-меток в том же порядке, что и входные строки. Без пояснений.`;

async function classifyBatch(rows) {
  const lines = rows.map((r, i) => `${i + 1}. ${r.body.slice(0, 400)}`).join('\n');
  const body = {
    model: MODEL, max_tokens: 1200, temperature: 0,
    messages: [{ role: 'system', content: SYSTEM }, { role: 'user', content: lines }],
  };
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(ENDPOINT, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const j = await res.json();
      if (j.error) throw new Error(JSON.stringify(j.error).slice(0, 160));
      const content = j.choices?.[0]?.message?.content || '';
      const m = content.match(/\[[\s\S]*\]/);
      if (!m) throw new Error('no JSON array in response');
      const arr = JSON.parse(m[0]);
      if (!Array.isArray(arr) || arr.length !== rows.length) throw new Error(`len ${arr?.length} != ${rows.length}`);
      return { labels: arr.map((x) => (LABELS.has(x) ? x : 'other')), cost: j.usage?.cost || 0 };
    } catch (e) {
      if (attempt === 2) { log(`  ! batch failed after retries: ${e.message}`); return null; }
      await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
    }
  }
  return null;
}

(async () => {
  if (!env.INSTANTLY_DATASET_DB_URL) { console.error('FATAL: INSTANTLY_DATASET_DB_URL missing'); process.exit(1); }
  const c = new Client({ connectionString: env.INSTANTLY_DATASET_DB_URL });
  await c.connect();
  await c.query('SET statement_timeout=0');
  const t0 = Date.now();

  log(`rules pass${DRY ? ' (dry)' : ''}...`);
  const ruled = await applyRules(c);
  log(`  rules ${DRY ? 'would label' : 'labeled'}: ${ruled}`);

  if (RULES_ONLY || !KEY) {
    log(RULES_ONLY ? 'rules-only mode → skip LLM' : 'no REQUESTY_API_KEY → skip LLM (rules only)');
    await c.end(); return;
  }

  // остаток после правил
  const targets = (await c.query(
    `SELECT b.campaign_id c, b.lead_id l, b.h, left(b.body, 400) body FROM (
        SELECT DISTINCT ON (campaign_id, lead_id) campaign_id, lead_id, md5(coalesce(body_text,'')) h, ${clean} body
        FROM raw_emails WHERE ue_type=2 AND lead_id IS NOT NULL AND campaign_id IS NOT NULL
          AND ${WINDOW}
        ORDER BY campaign_id, lead_id, length(coalesce(body_text,'')) DESC
     ) b LEFT JOIN reply_outcome_labels l USING (campaign_id, lead_id)
     WHERE l.campaign_id IS NULL AND length(b.body) >= 2
     ORDER BY b.campaign_id LIMIT ${CAP}`)).rows;
  log(`LLM targets (after rules): ${targets.length} (cap ${CAP}, model ${MODEL})`);
  if (DRY) { log('dry → no LLM calls'); await c.end(); return; }

  let labeled = 0, cost = 0; const dist = {};
  for (let i = 0; i < targets.length; i += BATCH) {
    const batch = targets.slice(i, i + BATCH);
    const out = await classifyBatch(batch);
    if (!out) continue;
    cost += out.cost;
    const rows = batch.map((r, k) => [r.c, r.l, out.labels[k], r.h]);
    for (const lab of out.labels) dist[lab] = (dist[lab] || 0) + 1;
    // bulk insert
    const vals = []; const params = []; let p = 1;
    for (const r of rows) { vals.push(`($${p++},$${p++},$${p++},'${MODEL.replace(/'/g, '')}','v1',$${p++})`); params.push(r[0], r[1], r[2], r[3]); }
    const res = await c.query(
      `INSERT INTO reply_outcome_labels (campaign_id, lead_id, label, model, rubric_version, body_hash)
       VALUES ${vals.join(',')} ON CONFLICT DO NOTHING`, params);
    labeled += res.rowCount;
    if ((i / BATCH) % 10 === 0) log(`  ...${labeled}/${targets.length}, cost ~$${cost.toFixed(3)}`);
  }
  log(`DONE: rules ${ruled} + LLM ${labeled} labeled. LLM cost ~$${cost.toFixed(3)}. ${((Date.now() - t0) / 1000).toFixed(0)}s`);
  log(`  LLM dist: ${Object.entries(dist).map(([k, v]) => `${k}=${v}`).join(' ')}`);
  await c.end();
})().catch((e) => { console.error('FAIL:', e.stack || e.message); process.exit(1); });
