#!/usr/bin/env node
// Explicit opt-in, local evaluation only. No production writes or Requesty.
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {MODEL,VERSION,QUESTIONS,NOTICE_QUESTIONS,prepareState,compose,needsNoticeCheck} from './instantly-jev-candidate-v2.mjs';
const hash=x=>createHash('sha256').update(typeof x==='string'?x:JSON.stringify(x)).digest('hex');
const exists=async p=>{try{await fs.access(p);return true;}catch(e){if(e.code==='ENOENT')return false;throw e;}};
const count=xs=>xs.reduce((a,x)=>(a[x]=(a[x]||0)+1,a),{});
export function validate(response,questions=QUESTIONS){
  if(response.model!==MODEL||!Number.isSafeInteger(response.usage?.input_tokens)||response.usage.input_tokens<0)throw Error('schema');
  const facts={};
  for(const [k,q] of Object.entries(questions)){
    const a=response.answers?.[k];
    if(a?.type!=='choice'||!Object.hasOwn(q.criteria,a.choice)||!Number.isFinite(a.confidence)||a.confidence<0||a.confidence>1)throw Error('schema');
    let sum=0;for(const option of Object.keys(q.criteria)){const p=a.probabilities?.[option];if(!Number.isFinite(p)||p<0||p>1)throw Error('schema');sum+=p;}
    if(Math.abs(sum-1)>.03)throw Error('schema');facts[k]=a.choice;
  }
  return facts;
}
async function main(){
  const opts={live:false,reuse:[]};for(let i=2;i<process.argv.length;i++){const a=process.argv[i];if(a==='--live')opts.live=true;else if(a==='--reuse-from')opts.reuse.push(process.argv[++i]);else if(['--dataset','--out','--ids'].includes(a))opts[a.slice(2)]=process.argv[++i];else throw Error('args');}
  if(opts.reuse.some(p=>!path.isAbsolute(p||'')))throw Error('args');
  if(!path.isAbsolute(opts.dataset||'')||!path.isAbsolute(opts.out||'')||(opts.ids&&!path.isAbsolute(opts.ids)))throw Error('args');
  const texts=await Promise.all(['tuning.json','holdout.json'].map(n=>fs.readFile(path.join(opts.dataset,n),'utf8')));
  const all=texts.flatMap(x=>JSON.parse(x).cases);
  const ids=opts.ids?JSON.parse(await fs.readFile(opts.ids,'utf8')):all.map(c=>c.id);
  if(!Array.isArray(ids)||!ids.length||ids.length>2200||new Set(ids).size!==ids.length||ids.some(id=>!all.some(c=>c.id===id)))throw Error('selection');
  const jobs=all.filter(c=>ids.includes(c.id)).sort((a,b)=>a.id.localeCompare(b.id)).map(c=>{
    const {state,transformations}=prepareState(c),request={model:MODEL,state,questions:QUESTIONS},body=JSON.stringify(request);
    // UTF-8 bytes deliberately bound the request far below the documented 64k
    // token aggregate limit. A provider rejection remains an error, never a label.
    if(Buffer.byteLength(body)>32000)throw Error('input_too_large');
    const noticeRequest={model:MODEL,state:{NEW_REPLY:{text:state.NEW_REPLY.text}},questions:NOTICE_QUESTIONS};
    return {c,request,body,noticeRequest,transformations,request_hash:hash(body),reservation:(Buffer.byteLength(body)+Buffer.byteLength(JSON.stringify(noticeRequest))+4096)*.042/1e6};
  });
  // Reuse only a complete, validated primary response for the identical payload.
  // Errors/timeouts stay in their original journal; a new run is an explicit attempt.
  for(const j of jobs)for(const dir of opts.reuse){const file=path.join(dir,j.c.id+'.json');if(!await exists(file))continue;const a=JSON.parse(await fs.readFile(file,'utf8'));if(a.state!=='complete'||a.request_hash!==j.request_hash||hash(a.request)!==j.request_hash)continue;validate(a.response);j.reused={response:a.response,source:file};break;}
  const reserve=jobs.reduce((s,j)=>s+j.reservation,0);if(reserve>3)throw Error('budget');
  let out=path.join(await fs.realpath(path.dirname(opts.out)),path.basename(opts.out));
  if(await exists(out))out=await fs.realpath(out);
  const repo=await fs.realpath(path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..'));
  if(out===repo||out.startsWith(repo+path.sep))throw Error('private_output');
  const manifest={version:VERSION,model:MODEL,question_hash:hash(QUESTIONS),notice_question_hash:hash(NOTICE_QUESTIONS),source_hashes:texts.map(hash),selection_hash:hash(ids),
    code_hashes:await Promise.all([import.meta.url,new URL('./instantly-jev-candidate-v2.mjs',import.meta.url)].map(async u=>hash(await fs.readFile(new URL(u),'utf8')))),
    requests_hash:hash(jobs.map(j=>j.request_hash)),reused_primary_hash:hash(jobs.map(j=>j.reused||null)),reused_primary_count:jobs.filter(j=>j.reused).length,cases:jobs.length,reservation_usd:reserve,max_usd:3,concurrency:2,
    note:'No retries. No historic decision or reference label enters API payload. Unresolved diagnostics are not a production manual queue.'};
  await fs.mkdir(out,{recursive:true,mode:0o700});await fs.chmod(out,0o700);
  const mf=path.join(out,'manifest.json');if(await exists(mf)){if(hash(JSON.parse(await fs.readFile(mf,'utf8')))!==hash(manifest))throw Error('manifest_changed');}
  else await fs.writeFile(mf,JSON.stringify(manifest,null,2),{flag:'wx',mode:0o600});
  console.log(JSON.stringify({version:VERSION,live:opts.live,cases:jobs.length,reserve_usd:reserve,truncated:jobs.filter(j=>j.transformations.context_truncated).length}));
  if(!opts.live)return;
  const key=process.env.TYPESAFE_API_KEY;if(!key)throw Error('missing_key');
  const requestApi=async(request,record)=>{const r=await fetch('https://api.typesafe.ai/v1/systemone',{method:'POST',redirect:'error',signal:AbortSignal.timeout(30000),headers:{Authorization:'Bearer '+key,'Content-Type':'application/json'},body:JSON.stringify(request)});
    if(!r.ok){record.http_status=r.status;try{const error=await r.json();record.error_type=String(error.detail?.error_type||'unspecified').slice(0,120);}catch{}throw Error('HTTP_'+r.status);}return r.json();};
  let next=0,done=0,stopped=false;
  const worker=async()=>{while(next<jobs.length&&!stopped){
    const j=jobs[next++],file=path.join(out,j.c.id+'.json');
    if(await exists(file)){const r=JSON.parse(await fs.readFile(file,'utf8'));if(r.request_hash!==j.request_hash)throw Error('resume_mismatch');if(r.state!=='complete'){stopped=true;console.log(JSON.stringify({stopped:true,reason:'unresolved_attempt',id:j.c.id}));}continue;}
    const record={id:j.c.id,state:'started',started_at:new Date().toISOString(),request_hash:j.request_hash,request:j.request,transformations:j.transformations,split:j.c.split,baseline:j.c.baseline.status,coverage:j.c.coverage,reused_primary_source:j.reused?.source||null,new_input_tokens:0,estimated_usd:0};
    await fs.writeFile(file,JSON.stringify(record),{flag:'wx',mode:0o600});const start=performance.now();
    try{const response=j.reused?.response||await requestApi(j.request,record),facts=validate(response);Object.assign(record,{response,facts,new_input_tokens:j.reused?0:response.usage.input_tokens});
      let noticeFacts;
      if(needsNoticeCheck(facts,j.request.state)){
        record.notice={state:'started',request:j.noticeRequest};
        // Persist primary success and follow-up intent before the second call.
        await fs.writeFile(file,JSON.stringify(record),{mode:0o600});
        const noticeResponse=await requestApi(j.noticeRequest,record);noticeFacts=validate(noticeResponse,NOTICE_QUESTIONS);
        record.notice={...record.notice,state:'complete',response:noticeResponse,facts:noticeFacts};record.new_input_tokens+=noticeResponse.usage.input_tokens;
      }
      Object.assign(record,{state:'complete',result:compose(facts,j.request.state,noticeFacts),latency_ms:performance.now()-start,estimated_usd:record.new_input_tokens*.042/1e6,finished_at:new Date().toISOString()});done++;
    }catch(e){Object.assign(record,{state:'error',estimated_usd:record.new_input_tokens*.042/1e6,error:/^HTTP_\d+$/.test(e.message)?e.message:e.message==='schema'?'schema':e.name==='TimeoutError'?'timeout':'request_error'});stopped=true;}
    await fs.writeFile(file,JSON.stringify(record),{mode:0o600});if(done%50===0||stopped)console.log(JSON.stringify({completed_new:done,stopped,error:record.error||null}));
  }};
  await Promise.all([worker(),worker()]);
  const records=[];for(const j of jobs){const f=path.join(out,j.c.id+'.json');if(await exists(f))records.push(JSON.parse(await fs.readFile(f,'utf8')));}
  const completed=records.filter(r=>r.state==='complete'),times=completed.filter(r=>!r.reused_primary_source).map(r=>r.latency_ms).sort((a,b)=>a-b);
  const summary={version:VERSION,total:jobs.length,complete:completed.length,errors:records.filter(r=>r.state==='error').length,unstarted:jobs.length-records.length,
    labels:count(completed.map(r=>r.result.label||'unresolved')),reasons:count(completed.map(r=>r.result.reason)),historical_comparison:count(completed.map(r=>r.baseline+' -> '+(r.result.label||'unresolved'))),
    reused_primary:completed.filter(r=>r.reused_primary_source).length,notice_checks:completed.filter(r=>r.notice).length,new_input_tokens:records.reduce((s,r)=>s+(r.new_input_tokens||0),0),estimated_usd:records.reduce((s,r)=>s+(r.estimated_usd||0),0),median_fresh_case_ms:times[Math.floor(times.length/2)],p95_fresh_case_ms:times[Math.ceil(times.length*.95)-1],population_accuracy:null};
  await fs.writeFile(path.join(out,'summary.json'),JSON.stringify(summary,null,2),{mode:0o600});console.log(JSON.stringify(summary));if(stopped)process.exitCode=1;
}
if(process.argv[1]&&await fs.realpath(process.argv[1])===fileURLToPath(import.meta.url))main().catch(e=>{console.error(JSON.stringify({error:['args','selection','input_too_large','budget','private_output','manifest_changed','missing_key','resume_mismatch'].includes(e.message)?e.message:'evaluation_failed',stopped:true}));process.exitCode=1;});
