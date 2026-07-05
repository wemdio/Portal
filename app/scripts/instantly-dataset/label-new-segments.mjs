#!/usr/bin/env node
/**
 * label-new-segments.mjs — инкрементальная разметка НИШ новых кампаний (гибрид: правила + LLM).
 *
 * Запускать своим cron ПОСЛЕ dataset-sync (как label-new-replies.mjs). Размечает только
 * кампании, которых ещё нет в dim_campaign_segment (segment IS NULL):
 *   1) бесплатные детерминированные правила (regex по имени) — ловят очевидное + явный мусор;
 *   2) остаток — LLM через Requesty (политика quality-классификатора, дёшево, deepseek).
 * Ниша = целевая ОТРАСЛЬ ПОЛУЧАТЕЛЕЙ из имени кампании. Идемпотентно (ON CONFLICT DO NOTHING).
 * Существующие метки (LLM-прогон 30.05, ручные правки) НЕ трогаем.
 *
 * ENV:
 *   INSTANTLY_DATASET_DB_URL  — датасет-БД (обязателен)
 *   REQUESTY_API_KEY          — ключ Requesty (нет → только правила, LLM-хвост пропускается)
 *   INSTANTLY_SEGMENT_MODEL   — модель/политика (default policy/INSTANTLY_LEAD_QUAL_MODEL)
 *   REQUESTY_ENDPOINT         — default https://router.requesty.ai/v1/chat/completions
 *   SEGMENT_BATCH_SIZE        — имён на LLM-вызов (default 30) ; SEGMENT_CAP — макс LLM/прогон (default 2000)
 *
 * Флаги: --dry (ничего не пишет), --rules-only (без LLM — для локального теста без API).
 */
import { readFileSync } from 'fs';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { Client } = require('pg');

const DRY = process.argv.includes('--dry');
const RULES_ONLY = process.argv.includes('--rules-only');

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
const MODEL = env.INSTANTLY_SEGMENT_MODEL || 'policy/INSTANTLY_LEAD_QUAL_MODEL';
const ENDPOINT = env.REQUESTY_ENDPOINT || 'https://router.requesty.ai/v1/chat/completions';
const KEY = env.REQUESTY_API_KEY || '';
const BATCH = parseInt(env.SEGMENT_BATCH_SIZE || '30', 10);
const CAP = parseInt(env.SEGMENT_CAP || '2000', 10);
const log = (m) => console.log(`[${new Date().toISOString()}] ${m}`);

const VALID = new Set(['logistics_transport','construction_realestate','medical_pharma','retail_ecommerce','manufacturing_industrial','food_horeca','it_software_saas','finance_legal','marketing_media_events','education_hr','beauty_wellness','auto','agriculture','other_unclear']);

// ── ПРАВИЛА (первое совпадение выигрывает; специфичное выше общего) ──
const RULES = [
  ['auto',                     /автосервис|автосалон|автодилер|автодиллер|автозапчаст|запчаст|шиномонтаж|автомобил|\bсто\b/i],
  ['medical_pharma',           /медицин|мед\.?\s?центр|мед\.?\s?организац|клиник|стоматолог|косметолог|аптек|фармацевт|\bфарма\b|больниц|поликлиник|диагностик|лаборатори|\bбад(ы|ов)?\b|здравоохран|телемед/i],
  ['beauty_wellness',          /салон[аовы]* красот|спа-?салон|\bспа\b|барбершоп|маникюр|педикюр|ногтев|массаж|\bйог[аиуе]|пилатес|фитнес|велнес|wellness|\bbeauty\b/i],
  ['food_horeca',              /кафе|ресторан|restaurant|horeca|хорека|отел[ьияей]|гостиниц|пищев|общепит|общественн\w* питани|молок|молочн|\bсыр\b|сырн|пекарн|хлебозавод|кондитер|напитк|мясн|мясокомбинат|фудкорт/i],
  ['construction_realestate',  /строительств|строит\b|стройматериал|строймат|девелопер|застройщик|недвижимост|риэлт|\bижс\b|\bовик\b|вентиляц|кондиционирован|инженерн\w* систем|эксплуатац\w* здани|подрядчик|генподряд|\bсмр\b|фасад|кровл|\bepc\b/i],
  ['manufacturing_industrial', /производств|\bзавод|металлург|металлообработк|машиностроен|\bстанк|оборудован|приборостроен|электроник|электротехник|нефтегаз|нефтехим|химпром|химическ|энергетик|\bдобыч|горнодобыв|обрабатыв\w* производств|мебел|фанер|резинов|канцеляр|\bтнп\b|промышленн|литейн|полимер/i],
  ['logistics_transport',      /логистик|транспортн\w* компан|грузопереноз|грузоперевозк|перевозк|\bсклад|таможен|\bвэд\b|фулфилмент|фулфилл|\b3pl\b|опасн\w* груз|экспедир|доставк\w* груз/i],
  ['retail_ecommerce',         /ритейл|розниц|e-?commerce|ecommerce|интернет-магазин|маркетплейс|селлер|wildberries|\bwb\b|\bwbcon\b|\bозон\b|дистрибуц|оптов\w* торговл|\bторговл|дистрибьютор|\bдилер|шоурум|\bfashion\b|одежд/i],
  ['it_software_saas',         /\bit\b|\bит\b|айти|разработк\w* по\b|software|\bsaas\b|веб-?студ|web-?студ|веб-?разработк|разработк\w* сайт|программн\w* обеспечен|аккредит\w* ит|цифровизац|\bhabr\b|it-компан|ит-компан/i],
  ['finance_legal',            /\bбанк\b|\bбанки\b|банковск|финтех|fintech|страхован|страхов\w* компан|\bюрист|юридическ|консалтинг|бухгалтер|\bаудит\b|\bброкер|инвестицион|лизинг|факторинг|микрофинанс|\bмфо\b/i],
  ['marketing_media_events',   /маркетинг|\bdigital\b|диджитал|\bpr\b|\bпиар|реклам\w* агентств|\bsmm\b|\bevent|ивент|мероприят|\bсми\b|\bмедиа\b|туропер|турагент|туризм|affiliate|performance/i],
  ['education_hr',             /образован|обучен|эдтех|edtech|\bкурс[ыао]|тренинг|\bшкол|детск\w* сад|\bвуз\b|университет|\bhr\b|подбор персонал|рекрутинг|кадров\w* агентств|бизнес-клуб/i],
  ['agriculture',              /сельск\w* хозяйств|сельхоз|агропром|агрокомплекс|агрохолдинг|животноводств|птицеводств|птицефабрик|растениеводств|фермер\w* хозяйств|\bапк\b|зернов/i],
];
const GENERIC = /солянк|тендер|телеком|телекоммуникац|оператор\w* связи|my campaign|constructor_|тестов\w* запуск|\bтест\b|\bархив\b|перенаправлен|\bb2b\b|стартап|партнерк|франшиз|выплаты в валют|сфера обслуживан/i;

function classifyRule(name) {
  const n = (name || '').toLowerCase();
  for (const [seg, re] of RULES) if (re.test(n)) return seg;
  if (GENERIC.test(n)) return 'other_unclear';
  return null; // непонятно → отдать LLM
}

// ── LLM-проход (Requesty, OpenAI-формат) ──
const SYSTEM = `Ты классифицируешь B2B email-кампании по ЦЕЛЕВОЙ НИШЕ — отрасли ПОЛУЧАТЕЛЕЙ — по имени кампании.
Имя = клиент/продукт + целевая отрасль + источник списка (СБИС/руспрофайл/HH/2ГИС/ЦИАН/Селеком/Яндекс карты/export-base) + номера/эмодзи. Тебе нужна ТОЛЬКО целевая отрасль — игнорируй клиента, продукт, источник, номера.
Верни ровно одну метку из 14:
logistics_transport, construction_realestate, medical_pharma, retail_ecommerce, manufacturing_industrial, food_horeca, it_software_saas, finance_legal, marketing_media_events, education_hr, beauty_wellness, auto, agriculture, other_unclear.
Правила: юристы/банки/страхование/консалтинг/бухгалтерия→finance_legal; IT/разработка ПО/web-студии/SaaS→it_software_saas; маркетинг/digital/pr/event/СМИ/туризм→marketing_media_events; медицина/стоматология/косметология/аптеки/фарма→medical_pharma; спа/салоны красоты/фитнес→beauty_wellness; стройка/недвижимость/девелоперы/ОВиК/эксплуатация зданий→construction_realestate; производство/металлургия/оборудование/мебель/нефтегаз/добыча→manufacturing_industrial; логистика/склады/перевозки/ВЭД→logistics_transport; ритейл/розница/e-commerce/селлеры WB/дистрибуция/опт/торговля→retail_ecommerce; кафе/рестораны/HoReCa/отели/пищёвка/молочка/пекарни→food_horeca; агро/сельхоз/животноводство→agriculture; авто/автосалоны/автосервисы/запчасти→auto; образование/HR/школы/курсы/эдтех→education_hr; телеком/операторы связи/«солянка»/тендеры/слишком общее/непонятное→other_unclear.
Ответь ТОЛЬКО JSON-массивом меток в ТОМ ЖЕ порядке, что входные строки. Без пояснений.`;

async function classifyBatch(names) {
  const lines = names.map((nm, i) => `${i + 1}. ${(nm || '').slice(0, 200)}`).join('\n');
  // Политика = reasoning-модель (deepseek): токены размышлений считаются в max_tokens,
  // при малом лимите content обрезается до пустоты («no JSON array»). Держим запас.
  const body = { model: MODEL, max_tokens: 6000, temperature: 0,
    messages: [{ role: 'system', content: SYSTEM }, { role: 'user', content: lines }] };
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(ENDPOINT, { method: 'POST',
        headers: { 'Authorization': `Bearer ${KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body) });
      const j = await res.json();
      if (j.error) throw new Error(JSON.stringify(j.error).slice(0, 160));
      const choice = j.choices?.[0];
      const m = (choice?.message?.content || '').match(/\[[\s\S]*\]/);
      if (!m) throw new Error(`no JSON array (finish=${choice?.finish_reason}, content="${(choice?.message?.content || '').slice(0, 80)}")`);
      const arr = JSON.parse(m[0]);
      if (!Array.isArray(arr) || arr.length !== names.length) throw new Error(`len ${arr?.length}!=${names.length}`);
      return { labels: arr.map((x) => (VALID.has(x) ? x : 'other_unclear')), cost: j.usage?.cost || 0 };
    } catch (e) {
      if (attempt === 2) { log(`  ! batch failed: ${e.message}`); return null; }
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

  const { rows } = await c.query(
    `SELECT c.id, c.name FROM raw_campaigns c
     LEFT JOIN dim_campaign_segment s ON s.campaign_id=c.id
     WHERE s.campaign_id IS NULL ORDER BY c.timestamp_created DESC`);
  log(`кампаний без ниши: ${rows.length}`);

  // 1) правила
  let ruled = 0; const llmTargets = [];
  for (const r of rows) {
    const seg = classifyRule(r.name);
    if (!seg) { llmTargets.push(r); continue; }
    ruled++;
    if (!DRY) await c.query(
      `INSERT INTO dim_campaign_segment (campaign_id, segment, confidence, classified_at)
       VALUES ($1,$2,'rule', now()) ON CONFLICT (campaign_id) DO NOTHING`, [r.id, seg]);
  }
  log(`  правила ${DRY ? 'разметили бы' : 'разметили'}: ${ruled}; на LLM-хвост: ${llmTargets.length}`);

  if (RULES_ONLY || !KEY) { log(RULES_ONLY ? 'rules-only → skip LLM' : 'нет REQUESTY_API_KEY → skip LLM'); await c.end(); return; }
  if (DRY) { log('dry → LLM не вызываем'); await c.end(); return; }

  // 2) LLM-добивка остатка
  const targets = llmTargets.slice(0, CAP);
  let labeled = 0, cost = 0; const dist = {};
  for (let i = 0; i < targets.length; i += BATCH) {
    const batch = targets.slice(i, i + BATCH);
    const out = await classifyBatch(batch.map((r) => r.name));
    if (!out) continue;
    cost += out.cost;
    const vals = []; const params = []; let p = 1;
    batch.forEach((r, k) => { const seg = out.labels[k]; dist[seg] = (dist[seg] || 0) + 1;
      vals.push(`($${p++},$${p++},'llm', now())`); params.push(r.id, seg); });
    const res = await c.query(
      `INSERT INTO dim_campaign_segment (campaign_id, segment, confidence, classified_at)
       VALUES ${vals.join(',')} ON CONFLICT (campaign_id) DO NOTHING`, params);
    labeled += res.rowCount;
  }
  log(`DONE: правила ${ruled} + LLM ${labeled}. LLM ~$${cost.toFixed(4)} (${MODEL}). ${((Date.now() - t0) / 1000).toFixed(0)}s`);
  log(`  LLM dist: ${Object.entries(dist).map(([k, v]) => `${k}=${v}`).join(' ')}`);
  await c.end();
})().catch((e) => { console.error('FAIL:', e.stack || e.message); process.exit(1); });
