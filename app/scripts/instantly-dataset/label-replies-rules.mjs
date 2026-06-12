#!/usr/bin/env node
/**
 * label-replies-rules.mjs — детерминированная разметка исходов ответов (rules-v1).
 *
 * Первый проход бэкфилла reply_outcome_labels: высокоточные regex-паттерны
 * закрывают механически распознаваемые категории (автоответы, отписки,
 * "не туда", ликвидации). Оставшееся размечает Claude батчами (без внешних API —
 * политика проекта). Идемпотентен: уже размеченные пары пропускаются.
 *
 * Точность важнее полноты: паттерн добавляется только если он практически
 * не даёт ложных срабатываний. Сомнительное уходит в LLM-проход.
 *
 * Usage: node label-replies-rules.mjs [--apply]
 */
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { Client } = require('pg');
const __dirname = dirname(fileURLToPath(import.meta.url));
const env = Object.fromEntries(readFileSync(resolve(__dirname, '../../../.env'), 'utf8').split('\n').filter(l=>l.includes('=')&&!l.trim().startsWith('#')).map(l=>{const i=l.indexOf('=');return [l.slice(0,i).trim(),l.slice(i+1).trim()];}));
const db = new Client({ connectionString: env.INSTANTLY_DATASET_DB_URL });
const APPLY = process.argv.includes('--apply');

// Порядок важен: первая сработавшая категория побеждает.
const RULES = [
  ['auto_reply', String.raw`(автоматическ(ий|ое) (ответ|уведомлен)|автоответ|out of office|ваше (письмо|сообщение|обращение) (получено|принято)|письмо получено|мы получили ваше (письмо|сообщение)|нахожусь в отпуске|в отпуске (до|по|с)|отпуске? до \d|вернусь \d|на больничном|в командировке (до|по)|дежурн(ый|ая) менеджер|ответим (вам )?в (ближайшее|течение)|свяжемся с вами в|это автоответчик|сообщение сформировано автоматически|данный почтовый ящик (вернули|не обслуживается)|сменился адрес( электронной)? почты|изменился адрес( электронной)? почты|новый (адрес|электронный адрес|email)[:\s]|почта (не актуальна|больше не использу)|переадресован|срок действия сообщения истек|отклонено модератором|недоставлено|не доставлено|доставка не выполнена|mail delivery|delivery (status|failure)|undeliverable|спасибо за (ваше )?обращение[.!]? (мы|ваш|в ближайшее))`],
  ['unsubscribe', String.raw`(прекратите (мне |нам )?(писать|слать|спамить|рассыл)|перестаньте (писать|слать)|хватит (писать|слать|спамить)|удалите (нас|меня|наш|мой|нашу почту|мой адрес|из (базы|рассылки|списка))|исключите (нас|меня|наш адрес) из|отпишите (нас|меня)|уберите (нас|меня|наш|мой) из|не пишите (нам|мне|сюда) (больше|более)|больше не пишите|это спам[ !.]|пожалуюсь|жалоб[ау] в (роскомнадзор|фас)|внесем в спам|отправля(ю|ем) в спам)`],
  ['wrong_person', String.raw`((я |уже |давно )(здесь |тут |там )?не работаю|не работаю в (этой |данной )?(компании|организации)|сотрудником .{0,40}не являюсь|не являюсь сотрудником|вы ошиблись( адресом| почтой| номером)?|ошиблись адресом|не по адресу|попали не туда|это (личная|частная|моя личная) почта|мы не (та компания|занимаемся (этим|таким))|организация ликвидирована|ликвидирован[ао]? (с|в|\d)|компания (закрыта|закрылась|ликвидирована)|мы закрылись|предприятие (закрыто|ликвидировано)|фирма (закрыта|ликвидирована)|организация банкрот|признан[ао]? банкротом)`],
  ['not_interested', String.raw`(^((добрый день|здравствуйте|спасибо)[!,. ]{0,4})*(нам |мне )?(это )?(не ?интересно|не интересует|не актуально|не требуется|не нужно|не надо)[ !.,]*$|спасибо,? (но )?(нам |мне )?(это )?(не интересно|не актуально|не нужно|не требуется)|не заинтересованы|нет потребности|не нуждаемся|нет необходимости|у нас (все|всё) есть[ !.]*$|услуги (не требуются|не нужны))`],
];

(async () => {
  await db.connect();
  let totalMatched = 0;
  for (const [label, pattern] of RULES) {
    // best-body на пару (как в LLM-проходе): самое длинное тело
    const sql = `
      WITH best AS (
        SELECT DISTINCT ON (campaign_id, lead_id)
          campaign_id, lead_id,
          lower(trim(regexp_replace(coalesce(body_text,''), '[[:space:]]+', ' ', 'g'))) AS body,
          md5(coalesce(body_text,'')) AS body_hash
        FROM raw_emails
        WHERE ue_type = 2 AND lead_id IS NOT NULL AND campaign_id IS NOT NULL
          AND timestamp_email BETWEEN '2025-07-01' AND now() + interval '1 day'
        ORDER BY campaign_id, lead_id, length(coalesce(body_text,'')) DESC
      )
      ${APPLY
        ? `INSERT INTO reply_outcome_labels (campaign_id, lead_id, label, confidence, model, rubric_version, body_hash)
           SELECT b.campaign_id, b.lead_id, '${label}', NULL, 'rules-v1', 'v1', b.body_hash FROM best b
           LEFT JOIN reply_outcome_labels l ON l.campaign_id = b.campaign_id AND l.lead_id = b.lead_id
           WHERE l.campaign_id IS NULL AND b.body ~ $$${pattern}$$
           ON CONFLICT DO NOTHING`
        : `SELECT count(*) FROM best b
           LEFT JOIN reply_outcome_labels l ON l.campaign_id = b.campaign_id AND l.lead_id = b.lead_id
           WHERE l.campaign_id IS NULL AND b.body ~ $$${pattern}$$`}`;
    const r = await db.query(sql);
    const n = APPLY ? r.rowCount : Number(r.rows[0].count);
    totalMatched += n;
    console.log(`${label.padEnd(16)} ${APPLY ? 'inserted' : 'would match'}: ${n}`);
  }
  console.log(`TOTAL: ${totalMatched}${APPLY ? '' : '  (dry run — --apply to write)'}`);
  await db.end();
})().catch(e => { console.error('FAIL:', e.message); process.exit(1); });
