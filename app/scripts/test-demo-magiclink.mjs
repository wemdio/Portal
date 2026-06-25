/**
 * test-demo-magiclink.mjs
 * ────────────────────────────────────────────────────────────────────────────
 * Проверяет ЯДРО роута /demo (app/src/app/demo/route.ts) БЕЗ деплоя: для демо-
 * email генерит magic-link через service-role (admin.generateLink) и пытается
 * обменять токен на сессию (verifyOtp) — отдельно типом 'magiclink' и 'email'.
 * Печатает, какой тип реально срабатывает у ВАШЕГО self-hosted GoTrue.
 *
 * Это единственный непроверенный кусок демо-входа. Если хоть один тип вернул
 * session — /demo залогинит (роут пробует оба). Если оба упали — мне надо менять
 * подход (серверный signInWithPassword вместо magic-link).
 *
 * Запуск из app/ (env должен указывать на ЦЕЛЕВОЙ GoTrue — прод 144 или test;
 * нужны NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, NEXT_PUBLIC_SUPABASE_ANON_KEY):
 *   node scripts/test-demo-magiclink.mjs --email=demoaccount@test.ru
 *
 * Безопасно: создаёт сессию для самого демо-аккаунта (read-only), как и /demo.
 * Каждый прогон берёт свежий одноразовый токен.
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import process from 'node:process';
import { createClient } from '@supabase/supabase-js';

function loadEnvFile(p){ if(!existsSync(p))return; for(const line of readFileSync(p,'utf8').split(/\r?\n/)){ const m=line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i); if(!m)continue; let v=m[2]; if((v.startsWith('"')&&v.endsWith('"'))||(v.startsWith("'")&&v.endsWith("'")))v=v.slice(1,-1); if(process.env[m[1]]===undefined)process.env[m[1]]=v; } }
loadEnvFile(resolve(process.cwd(),'.env')); loadEnvFile(resolve(process.cwd(),'../.env'));

const args=new Map();
for(const a of process.argv.slice(2)){ const m=a.match(/^--([^=]+)(?:=(.*))?$/); if(m)args.set(m[1],m[2]??true); }
const argStr=(k,d)=>(args.has(k)&&args.get(k)!==true?String(args.get(k)):d);

const URL=(process.env.NEXT_PUBLIC_SUPABASE_URL||'').trim();
const SERVICE=(process.env.SUPABASE_SERVICE_ROLE_KEY||'').trim();
const ANON=(process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY||'').trim();
const EMAIL=(argStr('email','')||process.env.DEMO_ACCOUNT_EMAIL||'').trim().toLowerCase();

if(!URL||!SERVICE||!ANON){ console.error('Нужны NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, NEXT_PUBLIC_SUPABASE_ANON_KEY в env'); process.exit(1); }
if(!EMAIL){ console.error('Нужен --email=<demo email> (или DEMO_ACCOUNT_EMAIL)'); process.exit(1); }

const admin=createClient(URL,SERVICE,{auth:{persistSession:false,autoRefreshToken:false}});

async function tryType(type){
  // Свежий одноразовый токен на каждую попытку (как в роуте).
  const gen=await admin.auth.admin.generateLink({ type:'magiclink', email: EMAIL });
  if(gen.error){ return { type, ok:false, stage:'generateLink', error: gen.error.message }; }
  const tokenHash=gen.data?.properties?.hashed_token;
  if(!tokenHash){ return { type, ok:false, stage:'generateLink', error:'no hashed_token in properties' }; }
  const anonClient=createClient(URL,ANON,{auth:{persistSession:false,autoRefreshToken:false}});
  const v=await anonClient.auth.verifyOtp({ type, token_hash: tokenHash });
  if(v.error){ return { type, ok:false, stage:'verifyOtp', error: v.error.message }; }
  const hasSession=Boolean(v.data?.session?.access_token);
  return { type, ok:hasSession, stage: hasSession?'done':'verifyOtp', error: hasSession?null:'verifyOtp returned no session' };
}

async function main(){
  console.log(`[demo-magiclink] GoTrue: ${URL}`);
  console.log(`[demo-magiclink] email:  ${EMAIL}`);
  console.log('');
  let anyOk=false;
  for(const type of ['magiclink','email']){
    const r=await tryType(type);
    if(r.ok){ anyOk=true; console.log(`  ✅ type='${type}' → СЕССИЯ ПОЛУЧЕНА (verifyOtp ок)`); }
    else { console.log(`  ❌ type='${type}' → провал на ${r.stage}: ${r.error}`); }
  }
  console.log('');
  if(anyOk){
    console.log('[demo-magiclink] ИТОГ: /demo залогинит — хотя бы один тип OTP работает. ✓');
    process.exit(0);
  } else {
    console.log('[demo-magiclink] ИТОГ: ОБА типа упали — magic-link через generateLink у этого GoTrue не проходит.');
    console.log('[demo-magiclink] Скажи мне — переведу /demo на серверный signInWithPassword (пароль демо в server-env, не в бандле).');
    process.exit(2);
  }
}
main().catch(e=>{ console.error('[demo-magiclink] fatal:', e); process.exit(1); });
