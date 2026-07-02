#!/usr/bin/env node
/**
 * Провижининг клиентского аккаунта OutreachOS под наш self-outreach
 * (продаём доступ к Порталу через СВОЙ изолированный пайплайн HH → конструктор
 * баз → добор в кампанию Instantly). Идемпотентный, безопасный для повтора.
 *
 * ВАЖНО — Mailganer не трогаем: этот скрипт НЕ создаёт client_auto_pipeline_configs
 * (тот стек завязан на Mailganer-скоринг). Вместо него сеется наша своя таблица
 * outreachos_pipeline_config (см. migration 20260623_0001). Скоринга нет.
 *
 * По умолчанию НИЧЕГО НЕ ПИШЕТ — печатает план. Применить: флаг --execute.
 *
 * Что создаёт (порядок важен — FK + кросс-БД):
 *   1. auth-юзер OutreachOS@test.ru (main GoTrue) → триггер handle_new_user
 *      создаёт public.profiles c role='client'.
 *   2. profiles: role='client'                                   (main DB)
 *   3. client_tariffs: лимиты, статус active                     (main DB)
 *   4. client_campaign_presets: instantly_account_id, почты пусто (Instantly DB)
 *   5. outreachos_pipeline_config (id=1): ICP-индустрии, шаги      (main DB)
 *
 * Почты-отправители и сама кампания Instantly — отдельные ручные шаги go-live:
 *   - создать ОДНУ кампанию в Instantly, её id → outreachos_pipeline_config.campaign_id
 *   - подключить прогретые ящики в кампанию и активировать её в Instantly
 *   - выставить enabled=true в outreachos_pipeline_config
 *
 * Запуск:
 *   cd app
 *   node --env-file=../.env scripts/provision-outreachos.mjs                       # план
 *   OUTREACHOS_PASSWORD='…' node --env-file=../.env scripts/provision-outreachos.mjs --execute
 *
 * Env: NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (main),
 *      INSTANTLY_SUPABASE_URL, INSTANTLY_SUPABASE_SERVICE_ROLE_KEY (Instantly DB),
 *      OUTREACHOS_PASSWORD (только при --execute),
 *      OUTREACHOS_CAMPAIGN_ID (опц. — если кампания уже создана).
 */

import { createClient } from '@supabase/supabase-js';

// ─────────────────────────────────────────────────────────────────────────
// КОНФИГ — ревьюим эти значения
// ─────────────────────────────────────────────────────────────────────────

const CLIENT_EMAIL = 'OutreachOS@test.ru';
const CLIENT_FULL_NAME = 'OutreachOS';

/**
 * ICP = «широкий B2B». HH top-level industry id'ы (см. lib/jobs/hhIndustries.ts).
 * Пайплайн делает по одному запросу /vacancies на индустрию.
 *
 * Включено (16) — небытовые / B2B:
 *   7 IT/интеграция/интернет · 11 СМИ/маркетинг/реклама/дизайн · 44 услуги бизнесу
 *   9 телеком · 43 финсектор · 8 электроника · 5 логистика · 13 стройка/недвижимость
 *   24 металлургия · 33 тяжмаш · 34 химпроизводство · 45 добыча · 46 энергетика
 *   47 нефть/газ · 388 промоборудование/станки · 389 управление активами
 * Исключены госорганы(36)/НКО(37)/образование(39)/розница(41)/потреб(42)/
 *   медицина(48)/услуги населению(49)/HoReCa(50)/ЖКХ(51)/культура(52)/авто(15).
 */
const ICP_INDUSTRIES = [
  '7', '11', '44', '9', '43', '8', '5', '13',
  '24', '33', '34', '45', '46', '47', '388', '389',
];

/**
 * Шаги конструктора баз — чистка/обогащение/валидация БЕЗ ta_scoring (оценка ЦА)
 * и personalization. Порядок в массиве не важен: loadOutreachOsConfig сортирует по
 * каноническому приоритету перед заливкой (worker-baseconstructor сам НЕ сортирует).
 * enrich_descriptions намеренно опущен (описания в Instantly не шлём).
 */
const SELECTED_STEPS = [
  'remove_empty', 'dedup_full', 'check_sites', 'find_emails', 'split_emails',
  'remove_support_emails', 'dedup_email', 'validate_emails', 'clean_names',
];

/**
 * Лимиты тарифа. is_active=true ОБЯЗАТЕЛЕН: client_tariffs.is_active DEFAULT false,
 * а getClientStatus при !is_active → 'inactive' → appendLeadsToClientCampaign кидает
 * 403 на КАЖДЫЙ прогон (ноль контактов). paid_until/setup_until=NULL → 'active'.
 * max_contacts здесь advisory: реальный потолок — daily_limit в конфиге
 * (countClientContacts читает client_campaign_launches, куда append-путь не пишет).
 */
const TARIFF = {
  tariff_type: 'custom',
  is_active: true,
  max_contacts: 40000,   // advisory; месяц на полной мощности ≈ 2450×30 отправок → до ~30k новых лидов
  max_rows: 200000,
  max_emails: 40,        // план: 35 ящиков (лимит с запасом; admin preset route валидирует count ≤ max_emails)
  max_domains: 10,
  max_chains_per_month: 60,
};

/**
 * outreachos_pipeline_config (id=1). enabled=false до go-live.
 *
 * daily_limit: калибровка под 35 ящиков (40→50→70 писем/день; 1400→1750→2450
 * отправок). Выход воронки ~0.45 лида/компанию (замер 1500: HR + ≤3/домен +
 * catch-all ≤20% → 677/1500). При 2-3-шаговой цепочке новых лидов нужно
 * ~560-700/день на старте → 1500 ок; к месяцу (~980-1225/день) поднять до
 * ~2200-2700: UPDATE outreachos_pipeline_config SET daily_limit=… WHERE id=1.
 * Следить по журналу прогонов за parsed vs new (seen-окно со временем съедает
 * часть выборки — лимит поднимать и по этой причине).
 */
const PIPELINE_CONFIG = {
  id: 1,
  enabled: false,                                  // включить вручную после campaign_id + ящиков
  measure_only: false,                             // true = замер воронки без заливки (см. футер)
  campaign_id: process.env.OUTREACHOS_CAMPAIGN_ID || null,
  industries: ICP_INDUSTRIES,
  area: '113',                                     // Россия
  window_hours: 24,
  max_employees: null,                             // без отсечки по размеру (можно поставить, напр. 5000)
  daily_limit: 1500,
  selected_steps: SELECTED_STEPS,
  extra_exclude: [],
  job_poll_timeout_minutes: 180,
};

/**
 * Preset (Instantly DB). Почты подключим позже — пул пустой (35 ящиков на go-live).
 * daily_limit/daily_max_leads = старт прогрева 40/ящик; через неделю поднять до 50,
 * через месяц до 70 — через админку /admin/clients/[id]/preset (она синкает
 * работающие кампании) или UPDATE client_campaign_presets.
 */
const PRESET = {
  instantly_account_id: 'main',
  email_account_ids: [],
  daily_limit: 40,
  daily_max_leads: 40,
  email_gap_minutes: 10,
  open_tracking: true,
  link_tracking: true,
  stop_on_reply: true,
  text_only: false,
  schedule_from: '09:00',
  schedule_to: '18:00',
  schedule_days: [1, 2, 3, 4, 5],
  schedule_timezone: 'Europe/Moscow',
};

// ─────────────────────────────────────────────────────────────────────────
// Реализация
// ─────────────────────────────────────────────────────────────────────────

const EXECUTE = process.argv.includes('--execute');

function need(name) {
  const v = process.env[name];
  if (!v) {
    console.error(`FATAL: нет env ${name}`);
    process.exit(1);
  }
  return v;
}

function banner() {
  console.log('');
  console.log('━'.repeat(70));
  console.log(`  Provision OutreachOS  —  ${EXECUTE ? '🟢 EXECUTE (пишем в БД)' : '🔵 PLAN (ничего не пишем)'}`);
  console.log('━'.repeat(70));
  console.log(`  email:        ${CLIENT_EMAIL}`);
  console.log(`  industries:   [${ICP_INDUSTRIES.join(', ')}]  (${ICP_INDUSTRIES.length})`);
  console.log(`  steps:        ${SELECTED_STEPS.join(', ')}`);
  console.log(`  enabled:      ${PIPELINE_CONFIG.enabled}  (включить после go-live)`);
  console.log(`  campaign_id:  ${PIPELINE_CONFIG.campaign_id ?? '— (создать кампанию, потом UPDATE)'}`);
  console.log(`  tariff:       ${TARIFF.tariff_type}, ${TARIFF.max_contacts} contacts, ${TARIFF.max_emails} mailboxes`);
  console.log('━'.repeat(70));
  if (!EXECUTE) console.log('  (превью. Запусти с --execute чтобы применить.)');
  console.log('');
}

async function ensureAuthUser(main) {
  let page = 1;
  for (;;) {
    const { data, error } = await main.auth.admin.listUsers({ page, perPage: 200 });
    if (error) throw new Error(`listUsers: ${error.message}`);
    const found = data.users.find(
      (u) => (u.email ?? '').toLowerCase() === CLIENT_EMAIL.toLowerCase(),
    );
    if (found) {
      console.log(`  [auth] юзер уже есть: ${found.id}`);
      return found.id;
    }
    if (data.users.length < 200) break;
    page += 1;
  }

  if (!EXECUTE) {
    console.log('  [auth] СОЗДАЛ БЫ нового юзера admin.createUser(...)');
    return '<new-user-id-после-execute>';
  }

  const password = need('OUTREACHOS_PASSWORD');
  const { data, error } = await main.auth.admin.createUser({
    email: CLIENT_EMAIL,
    password,
    email_confirm: true,
    user_metadata: { role: 'client', full_name: CLIENT_FULL_NAME },
  });
  if (error) throw new Error(`createUser: ${error.message}`);
  console.log(`  [auth] создан: ${data.user.id}`);
  return data.user.id;
}

async function applyMain(main, userId) {
  // profiles: роль client (триггер мог поставить иначе). auto_pipeline_enabled
  // НЕ трогаем — наш cron читает outreachos_pipeline_config напрямую, а этот
  // флаг кормит ЧУЖОЙ (Mailganer) auto-pipeline cron.
  if (EXECUTE) {
    const { error } = await main.from('profiles').update({ role: 'client' }).eq('id', userId);
    if (error) throw new Error(`profiles update: ${error.message}`);
  }
  console.log('  [main] profiles.role=client');

  if (EXECUTE) {
    const { error } = await main
      .from('client_tariffs')
      .upsert({ user_id: userId, ...TARIFF }, { onConflict: 'user_id' });
    if (error) throw new Error(`client_tariffs upsert: ${error.message}`);
  }
  console.log('  [main] client_tariffs upserted');

  // outreachos_pipeline_config (id=1, singleton). client_user_id = OutreachOS.
  if (EXECUTE) {
    const { error } = await main
      .from('outreachos_pipeline_config')
      .upsert(
        { ...PIPELINE_CONFIG, client_user_id: userId, updated_at: new Date().toISOString() },
        { onConflict: 'id' },
      );
    if (error) throw new Error(`outreachos_pipeline_config upsert: ${error.message}`);
  }
  console.log(`  [main] outreachos_pipeline_config upserted (enabled=${PIPELINE_CONFIG.enabled})`);
}

async function applyInstantly(inst, userId) {
  if (EXECUTE) {
    const { error } = await inst
      .from('client_campaign_presets')
      .upsert({ client_user_id: userId, ...PRESET }, { onConflict: 'client_user_id' });
    if (error) throw new Error(`client_campaign_presets upsert: ${error.message}`);
  }
  console.log(`  [instantly] client_campaign_presets upserted (mailboxes: ${PRESET.email_account_ids.length})`);
}

async function main() {
  banner();

  const mainDb = createClient(
    need('NEXT_PUBLIC_SUPABASE_URL'),
    need('SUPABASE_SERVICE_ROLE_KEY'),
    { auth: { persistSession: false } },
  );
  const instDb = createClient(
    need('INSTANTLY_SUPABASE_URL'),
    need('INSTANTLY_SUPABASE_SERVICE_ROLE_KEY'),
    { auth: { persistSession: false } },
  );

  const userId = await ensureAuthUser(mainDb);
  await applyMain(mainDb, userId);
  await applyInstantly(instDb, userId);

  console.log('');
  console.log(`✅ ${EXECUTE ? 'Применено' : 'План показан'}. client_user_id = ${userId}`);
  console.log('');
  console.log('Замер воронки ДО go-live (без заливки, без записи seen, повторяемо):');
  console.log('  1. npm run build:workers  (бандл dist/workers/outreachosCron.js)');
  console.log('  2. UPDATE outreachos_pipeline_config SET enabled=true, measure_only=true WHERE id=1;');
  console.log('  3. node --env-file=../.env dist/workers/outreachosCron.js  (на проде — есть HH-токен+прокси)');
  console.log('     → лог печатает MEASURE: parsed=… new=… valid=…; журнал в outreachos_pipeline_runs.');
  console.log('  4. По valid выставить daily_limit и вернуть measure_only=false.');
  console.log('');
  console.log('Go-live (вручную, когда готовы почты):');
  console.log('  1. Создать ОДНУ кампанию в Instantly, подключить прогретые ящики, активировать.');
  console.log('  2. UPDATE outreachos_pipeline_config SET campaign_id=\'<id>\', enabled=true WHERE id=1;');
  console.log('  3. npm run build:workers  (бандл dist/workers/outreachosCron.js)');
  console.log('  4. crontab: 0 5 * * * node --env-file=../.env dist/workers/outreachosCron.js');
  console.log('     (или разовый прогон: node --env-file=../.env dist/workers/outreachosCron.js)');
  console.log('');
}

main().catch((err) => {
  console.error('FATAL:', err.message);
  process.exit(1);
});
