import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { requireInternalToolAuth } from '@/lib/toolsApiAuth';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { supabaseInstantly } from '@/lib/supabaseInstantly';
import { readDeliveryRate, previewDeliveryRate, saveDeliveryRate } from '@/lib/verticalEngineV2/contactDeliveryRateService';
import { DeliveryRateError, type DeliveryRateRow } from '@/lib/verticalEngineV2/contactDeliveryRate';
import { readVeSenderPoolForPreset } from '@/lib/verticalEngineV2/senderTransport/senderPool';
export const dynamic='force-dynamic';
export const maxDuration=60;
const schema=z.object({preset_id:z.string().min(1).max(200),template_ids:z.array(z.string().uuid()).min(1).max(100),
 mode:z.enum(['auto','manual']),manual_limit:z.number().int().min(1).max(100000).nullable(),expected_revision:z.number().int().nonnegative()}).strict();
const display=(row:DeliveryRateRow|null)=>row?{preset_id:row.preset_id,template_ids:row.template_ids,mode:row.mode,manual_limit:row.manual_limit,
 revision:row.revision,status:row.status,snapshot:row.snapshot,error:row.error}:null;
/**
 * Отправляет ли «Рассылка» письма этих шаблонов. Есть записанные запуски —
 * по ним (идущие не переезжают; шаблон без запуска в уже идущем наборе ничего
 * не решает). Ни одного — темп для нового запуска: способ, который выбрал
 * специалист (этап 7; параметр transport=sender, иначе Instantly). Ошибка
 * чтения — нет, как у Instantly.
 */
async function sendsThroughSender(projectId:string,templateIds:string[],chosen:string|null):Promise<boolean> {
 const {data,error}=await supabaseAdmin!.from('ve_launch_queue_items').select('template_id, transport')
  .eq('project_id',projectId).in('template_id',templateIds);
 if(error)return false;
 const rows=(data??[]) as Array<{template_id:string;transport:unknown}>;
 if(rows.length)return rows.some(row=>row.transport==='sender');
 return chosen==='sender';
}
export async function GET(req:NextRequest,{params}:{params:Promise<{id:string}>}) {
 const auth=await requireInternalToolAuth(req); if('error' in auth)return auth.error;
 if(!supabaseAdmin || !supabaseInstantly)return NextResponse.json({error:'Сервис недоступен'},{status:503});
 try {
  const {id}=await params;z.string().uuid().parse(id);
  const presetId=z.string().min(1).parse(req.nextUrl.searchParams.get('preset_id'));
  const templateIds=z.array(z.string().uuid()).min(1).max(100).parse(req.nextUrl.searchParams.get('template_ids')?.split(','));
  const saved=await readDeliveryRate(supabaseAdmin,id);
  const matching=saved?.preset_id===presetId?saved:null;
  const result=await previewDeliveryRate(supabaseAdmin,supabaseInstantly,{projectId:id,presetId,templateIds,
   policy:matching??{mode:'auto',manual_limit:null}});
  // Темп считается по почтам Instantly; если эти письма отправляет «Рассылка» — рядом её ящики (только показ).
  const sender=await sendsThroughSender(id,templateIds,req.nextUrl.searchParams.get('transport'))?{transport:'sender' as const,sender_pool:await readVeSenderPoolForPreset(supabaseAdmin,
   supabaseInstantly,presetId,result.snapshot.sequence_steps).catch(()=>null)}:{};
  return NextResponse.json({rate:display(matching),revision:saved?.revision??0,snapshot:result.snapshot,bound:result.bound,...sender});
 } catch(error) {
  return NextResponse.json({error:error instanceof z.ZodError?'Некорректные параметры':error instanceof DeliveryRateError?error.message:'Не удалось рассчитать темп. Проверьте готовность писем, отправителей и доступность Instantly.'},{status:409});
 }
}
export async function POST(req:NextRequest,{params}:{params:Promise<{id:string}>}) {
 const auth=await requireInternalToolAuth(req); if('error' in auth)return auth.error;
 if(!supabaseAdmin || !supabaseInstantly)return NextResponse.json({error:'Сервис недоступен'},{status:503});
 try {
  const {id}=await params;z.string().uuid().parse(id);const input=schema.parse(await req.json());
  const rate=await saveDeliveryRate(supabaseAdmin,supabaseInstantly,{projectId:id,presetId:input.preset_id,templateIds:input.template_ids,
   policy:{mode:input.mode,manual_limit:input.manual_limit},revision:input.expected_revision,actorId:auth.auth.userId});
  return NextResponse.json({rate:display(rate)});
 } catch(error) {
  return NextResponse.json({error:error instanceof z.ZodError?'Укажите положительный целый дневной лимит.':error instanceof DeliveryRateError?error.message:'Не удалось сохранить темп. Обновите расчёт: настройки могли измениться или Instantly недоступен.'},{status:409});
 }
}
