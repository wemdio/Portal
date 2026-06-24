/**
 * create-demo-account.mjs
 * ────────────────────────────────────────────────────────────────────────────
 * Заводит (идемпотентно) ПУБЛИЧНЫЙ демо-аккаунт для лендинга: роль `client` +
 * `profiles.is_demo = true`. Этого достаточно, чтобы:
 *   • middleware пускал юзера только в /client (как любого клиента);
 *   • requireClientAuth централизованно резал ЛЮБЫЕ мутации (см.
 *     lib/clientApiHelper.ts) — демо строго read-only;
 *   • GET'ы /api/client/* отдавались из статичных фикстур (lib/clientDemo),
 *     не трогая реальную БД/Instantly;
 *   • внутренние tool-роуты (/api/tools, /api/ai-caller, /api/sales-copilot)
 *     отдавали 403 (см. lib/auth/internalGuard.ts) — токен демо туда не пройдёт.
 *
 * Демо-аккаунту НЕ нужно: ни client_instantly_access (иначе увидит реальные
 * кампании!), ни client_tariffs — всё закрывают фикстуры. Скрипт лишь проверяет
 * и предупреждает, если access-строки вдруг есть.
 *
 * Запуск из app/ (env берётся из .env / ../.env — НУЖНЫ SUPABASE_SERVICE_ROLE_KEY
 * и NEXT_PUBLIC_SUPABASE_URL ЦЕЛЕВОГО сервера — сначала прогнать на test):
 *   node scripts/create-demo-account.mjs --email=demo@outreachos.pro --name="Демо · Орбита"
 *
 * Печатает user.id. Пароль аккаунту не нужен (вход через /demo magic-link),
 * но создаётся подтверждённым со случайным паролем.
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import process from 'node:process';
import { randomBytes } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';

function loadEnvFile(p){ if(!existsSync(p))return; for(const line of readFileSync(p,'utf8').split(/\r?\n/)){ const m=line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i); if(!m)continue; let v=m[2]; if((v.startsWith('"')&&v.endsWith('"'))||(v.startsWith("'")&&v.endsWith("'")))v=v.slice(1,-1); if(process.env[m[1]]===undefined)process.env[m[1]]=v; } }
loadEnvFile(resolve(process.cwd(),'.env')); loadEnvFile(resolve(process.cwd(),'../.env'));

const args=new Map();
for(const a of process.argv.slice(2)){ const m=a.match(/^--([^=]+)(?:=(.*))?$/); if(m)args.set(m[1],m[2]??true); }
const argStr=(k,d)=>(args.has(k)&&args.get(k)!==true?String(args.get(k)):d);

const SUPABASE_URL=(process.env.NEXT_PUBLIC_SUPABASE_URL||'').trim();
const SERVICE_KEY=(process.env.SUPABASE_SERVICE_ROLE_KEY||'').trim();
if(!SUPABASE_URL||!SERVICE_KEY){ console.error('Нужны NEXT_PUBLIC_SUPABASE_URL и SUPABASE_SERVICE_ROLE_KEY в .env'); process.exit(1); }

const EMAIL=(argStr('email','')||process.env.DEMO_ACCOUNT_EMAIL||'').trim().toLowerCase();
if(!EMAIL){ console.error('Нужен --email=<demo email> (или DEMO_ACCOUNT_EMAIL в .env)'); process.exit(1); }
const FULL_NAME=argStr('name','Демо');
const LOCALE=argStr('locale','ru');

const admin=createClient(SUPABASE_URL,SERVICE_KEY,{auth:{persistSession:false,autoRefreshToken:false}});

async function findUserByEmail(email){
  // admin.listUsers пагинируется; идём по страницам, пока не найдём.
  for(let page=1; page<=50; page++){
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 1000 });
    if(error) throw error;
    const u=(data?.users||[]).find(x=>(x.email||'').toLowerCase()===email);
    if(u) return u;
    if(!data?.users?.length || data.users.length<1000) break;
  }
  return null;
}

async function main(){
  console.log(`[demo] target: ${SUPABASE_URL}`);
  console.log(`[demo] email:  ${EMAIL}`);

  let user=await findUserByEmail(EMAIL);
  if(user){
    console.log(`[demo] auth user уже есть: ${user.id}`);
  }else{
    const password=randomBytes(24).toString('base64url');
    const { data, error } = await admin.auth.admin.createUser({
      email: EMAIL,
      password,
      email_confirm: true,
      user_metadata: { full_name: FULL_NAME, is_demo: true },
    });
    if(error){ console.error('[demo] createUser failed:', error.message); process.exit(1); }
    user=data.user;
    console.log(`[demo] auth user создан: ${user.id}`);
  }

  // profiles: role=client + is_demo=true (главная гарантия безопасности).
  const { error: upErr } = await admin.from('profiles').upsert({
    id: user.id,
    email: EMAIL,
    full_name: FULL_NAME,
    role: 'client',
    is_demo: true,
    locale: LOCALE,
  }, { onConflict: 'id' });
  if(upErr){ console.error('[demo] profiles upsert failed:', upErr.message); process.exit(1); }
  console.log('[demo] profiles: role=client, is_demo=true ✓');

  // Проверка: у демо НЕ должно быть доступа к реальным Instantly-ресурсам.
  // client_instantly_access живёт в instantly-postgres — проверяем, только если
  // заданы его креды; иначе просто напоминаем.
  const INST_URL=(process.env.NEXT_PUBLIC_SUPABASE_INSTANTLY_URL||process.env.SUPABASE_INSTANTLY_URL||'').trim();
  const INST_KEY=(process.env.SUPABASE_INSTANTLY_SERVICE_ROLE_KEY||'').trim();
  if(INST_URL&&INST_KEY){
    try{
      const inst=createClient(INST_URL,INST_KEY,{auth:{persistSession:false,autoRefreshToken:false}});
      const { data, error } = await inst.from('client_instantly_access').select('resource_id').eq('client_user_id',user.id);
      if(error) throw error;
      if((data||[]).length){ console.warn(`[demo] ⚠ ВНИМАНИЕ: у демо ${data.length} строк client_instantly_access — удали их, иначе увидит реальные кампании!`); }
      else console.log('[demo] client_instantly_access: 0 строк ✓');
    }catch(e){ console.warn('[demo] не смог проверить client_instantly_access:', e.message); }
  }else{
    console.log('[demo] (instantly-БД креды не заданы — вручную убедись, что у демо НЕТ client_instantly_access)');
  }

  console.log('');
  console.log('[demo] Готово. Проставь в env приложения: DEMO_ACCOUNT_EMAIL='+EMAIL);
  console.log('[demo] Вход: открой /demo — magic-link залогинит в /client.');
}

main().catch(e=>{ console.error('[demo] fatal:', e); process.exit(1); });
