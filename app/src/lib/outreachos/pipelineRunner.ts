/**
 * OutreachOS daily pipeline orchestrator — Mailganer-free self-outreach.
 *
 * Поток (раз в сутки, см. worker/outreachosCron.ts):
 *
 *   1. Загрузить singleton-конфиг. Выключен → выйти. measure_only=false и нет
 *      campaign_id → выйти. measure_only=true → идём без кампании (замер).
 *   2. HH-парс новых работодателей за window_hours, фильтр ICP = индустрии +
 *      exclude федеральных брендов + maxEmployees (БЕЗ скоринга).
 *   3. Дедуп против outreachos_seen_employers (свой журнал, не Mailganer-стек).
 *   4. Сетка → base_constructor_jobs (чистка/обогащение/валидация БЕЗ
 *      ta_scoring/personalization). Ждём, пока worker-baseconstructor доработает.
 *   5. measure_only → журналим parsed/new/valid и ВЫХОДИМ (без заливки, без seen).
 *      Иначе: готовую сетку → лиды → appendLeadsToClientCampaign в ОДНУ кампанию.
 *   6. Журналируем seen + run.
 *
 * ИЗОЛЯЦИЯ: ни одного импорта из autoPipelineRunner / mailganerScore* /
 * clientEndpointClient / bobScoringRunner и ни одного обращения к
 * mailganer_domain_scores / background_scorer_state / client_auto_pipeline_*.
 * Скоринга нет вовсе.
 */

import 'server-only';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { logAudit, logError } from '@/lib/loggerServer';
import { findNewHhEmployers, deriveDomain, type HhEmployer } from '@/lib/jobs/hhAutoParser';
import { ensureArchiveSinkJob, buildHhArchiveSinkCallback, getUserIdByEmail } from '@/lib/parsers/hhArchiveSink';
import { appendLeadsToClientCampaign, fetchExistingCampaignEmails } from '@/lib/clientLaunch/appendLeads';
import { loadOutreachOsConfig } from './config';
import { buildExcludePatterns } from './excludePatterns';
import { isOutreachOsB2cCompany } from './excludeB2c';
import {
  EMPTY_SUPPRESSION,
  isSuppressedCompany,
  type OutreachOsSuppression,
} from './suppression';
import { llmClassifyNoise, type CompanyForClassify } from './classifyCompanies';
import { loadRecentlySeen, markSeen, RECONTACT_AFTER_DAYS, type SeenEmployerUpsert } from './seenEmployers';
import { employersToGrid, gridToLeadPayloads } from './gridMapping';

const POLL_INTERVAL_MS = 10_000;
const TERMINAL_STATUSES = new Set(['completed', 'failed', 'cancelled']);

export interface OutreachOsRunResult {
  runId: string | null;
  status: 'completed' | 'failed' | 'skipped';
  parsed: number;
  newEmployers: number;
  validContacts: number;
  appended: number;
  skipped: number;
  error?: string;
}

type Logger = (msg: string) => void;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function runOutreachOsDailyPipeline(log: Logger = () => {}): Promise<OutreachOsRunResult> {
  const empty: OutreachOsRunResult = {
    runId: null,
    status: 'skipped',
    parsed: 0,
    newEmployers: 0,
    validContacts: 0,
    appended: 0,
    skipped: 0,
  };

  if (!supabaseAdmin) {
    return { ...empty, status: 'failed', error: 'supabaseAdmin unavailable' };
  }
  const db = supabaseAdmin;

  // 1. Конфиг.
  const config = await loadOutreachOsConfig();
  if (!config) {
    log('Нет outreachos_pipeline_config (id=1) — пропускаем');
    return { ...empty, error: 'no_config' };
  }
  if (!config.enabled) {
    log('Пайплайн выключен (enabled=false) — пропускаем');
    return empty;
  }
  const measureOnly = config.measure_only === true;
  if (!measureOnly && !config.campaign_id) {
    log('Не задан campaign_id (и не measure_only) — кампания не создана, пропускаем');
    return { ...empty, error: 'no_campaign_id' };
  }
  if (config.selected_steps.length === 0) {
    log('Пустой selected_steps — нечего прогонять, пропускаем');
    return { ...empty, error: 'no_steps' };
  }

  // 2. Run row.
  const { data: runRow, error: runErr } = await db
    .from('outreachos_pipeline_runs')
    .insert({ status: 'running' })
    .select('id')
    .single();
  if (runErr || !runRow) {
    return { ...empty, status: 'failed', error: `run insert failed: ${runErr?.message}` };
  }
  const runId = (runRow as { id: string }).id;

  const finishRun = async (patch: Record<string, unknown>): Promise<void> => {
    await db
      .from('outreachos_pipeline_runs')
      .update({ ...patch, finished_at: new Date().toISOString() })
      .eq('id', runId);
  };

  try {
    // 3. HH-парс + ICP-фильтр.
    // Sink в общий hh_vacancies (см. lib/parsers/hhArchiveSink.ts). Пайплайн
    // общий для агентства, per-client user_id нет — используем служебного
    // outreachos@test.ru как «владельца» sink parser_job. Если у него в
    // profiles email не совпадает или юзер удалён — sinkJobId=null, парсер
    // отдаёт данные только клиенту (сохранённое поведение).
    const outreachosSinkOwnerEmail = process.env.OUTREACHOS_SINK_OWNER_EMAIL ?? 'outreachos@test.ru';
    const sinkOwnerId = await getUserIdByEmail(outreachosSinkOwnerEmail);
    const sinkJobId = sinkOwnerId ? await ensureArchiveSinkJob(sinkOwnerId) : null;
    const onVacancies = buildHhArchiveSinkCallback(sinkJobId);

    const since = new Date(Date.now() - config.window_hours * 3600_000);
    const employers = await findNewHhEmployers({
      since,
      area: config.area,
      industries: config.industries.length > 0 ? config.industries : undefined,
      excludePatterns: buildExcludePatterns(config.extra_exclude),
      maxEmployees: config.max_employees ?? undefined,
      limit: config.daily_limit,
      log: (m) => log(`[hh] ${m}`),
      onVacancies,
    });
    log(`HH вернул ${employers.length} работодателей (после ICP-фильтра)`);

    // 3b. Структурный B2C/ИП-отсев по названию+домену (excludeB2c.ts): школы,
    //     отели, ИП-ФИО, .shop и т.п. — ДО конструктора, чтобы не жечь скрейп
    //     на компании, которым мы всё равно не пишем. Отсев только наш,
    //     общий конструктор/HH-парсер не меняются.
    const b2cFiltered = employers.filter(
      (e) => !isOutreachOsB2cCompany(e.name ?? '', e.siteUrl ?? ''),
    );
    if (b2cFiltered.length < employers.length) {
      log(`B2C/ИП-отсев: -${employers.length - b2cFiltered.length} → ${b2cFiltered.length}`);
    }

    // 3c. SUPPRESSION: наши клиенты (AMO) не должны получать self-outreach
    //     НИКОГДА. Fail-closed: не смогли прочитать список — роняем прогон
    //     (пропущенный день лучше письма собственному клиенту); сбой ДО шага 8,
    //     так что завтра всё ретраится. Компании клиентов отсеиваются по домену
    //     сайта ДО конструктора; рубеж по почте — в gridToLeadPayloads.
    const suppression = await loadSuppression(db);
    log(`Suppression-список: ${suppression.emails.size} почт, ${suppression.domains.size} доменов`);
    const icp = b2cFiltered.filter((e) => !isSuppressedCompany(e.siteUrl ?? '', suppression));
    if (icp.length < b2cFiltered.length) {
      log(`Suppression-отсев клиентов: -${b2cFiltered.length - icp.length} → ${icp.length}`);
    }

    // 4. Дедуп по окну: компании, контактированные за последние
    //    RECONTACT_AFTER_DAYS дней, пропускаем (не пишем одной компании чаще
    //    раза в 1.5 месяца). По hh_employer_id И по домену сайта. Компании
    //    старше окна — снова eligible (повторный аутрич разрешён).
    const seen = await loadRecentlySeen();
    const fresh = icp.filter((e) => {
      if (seen.ids.has(e.id)) return false;
      const d = deriveDomain(e.siteUrl);
      return !(d && seen.domains.has(d));
    });
    log(`Новых (не контактированы за ${RECONTACT_AFTER_DAYS}д): ${fresh.length}`);

    if (fresh.length === 0) {
      await finishRun({
        status: 'completed',
        parsed: employers.length,
        after_icp: icp.length,
        new_employers: 0,
        valid_contacts: 0,
        appended: 0,
        skipped: 0,
      });
      return {
        runId,
        status: 'completed',
        parsed: employers.length,
        newEmployers: 0,
        validContacts: 0,
        appended: 0,
        skipped: 0,
      };
    }

    // 5. Сетка → base_constructor_jobs (чистка/валидация без ta_scoring/persona).
    const grid = employersToGrid(fresh);
    const today = new Date().toISOString().slice(0, 10);
    const { data: jobRow, error: jobErr } = await db
      .from('base_constructor_jobs')
      .insert({
        user_id: config.client_user_id,
        file_name: `outreachos-${today}`,
        data: grid,
        selected_steps: config.selected_steps,
        // find_emails пишет прямо в колонку Email (а не в отдельную «Найденный
        // Email» с последующим merge) — убираем неявную зависимость от порядка
        // шагов: даже без промежуточных шагов почты сразу в Email.
        step_config: { find_emails_target: 'same' },
        initial_row_count: grid.length - 1,
        total_steps: config.selected_steps.length,
      })
      .select('id')
      .single();
    if (jobErr || !jobRow) {
      throw new Error(`base job insert failed: ${jobErr?.message}`);
    }
    const baseJobId = (jobRow as { id: string }).id;
    log(`Создан base_constructor_job ${baseJobId} (${grid.length - 1} строк, шаги: ${config.selected_steps.join(',')})`);

    // 6. Ждём, пока worker-baseconstructor доработает. В цикле тянем ТОЛЬКО
    //    status (не весь data-блоб — он может быть мегабайтами), а финальную
    //    сетку забираем один раз по завершении.
    const deadline = Date.now() + config.job_poll_timeout_minutes * 60_000;
    let finalGrid: string[][] | null = null;
    for (;;) {
      if (Date.now() > deadline) {
        throw new Error(`base job ${baseJobId} не завершился за ${config.job_poll_timeout_minutes} мин`);
      }
      await sleep(POLL_INTERVAL_MS);
      const { data: js } = await db
        .from('base_constructor_jobs')
        .select('status, error_message')
        .eq('id', baseJobId)
        .maybeSingle();
      const status = (js as { status?: string } | null)?.status;
      if (!status || !TERMINAL_STATUSES.has(status)) continue;
      if (status !== 'completed') {
        const em = (js as { error_message?: string } | null)?.error_message;
        throw new Error(`base job ${baseJobId} завершился со status=${status}: ${em ?? 'no message'}`);
      }
      const { data: full } = await db
        .from('base_constructor_jobs')
        .select('data')
        .eq('id', baseJobId)
        .maybeSingle();
      finalGrid = ((full as { data?: string[][] } | null)?.data ?? null);
      break;
    }

    // 7. Сетка → лиды (с suppression-рубежом по почте/домену внутри).
    const leads = gridToLeadPayloads(finalGrid ?? [], suppression);
    log(`Валидных контактов на выходе конструктора: ${leads.length}`);

    // MEASURE-режим: только меряем воронку (parsed→new→valid). НЕ заливаем в
    // Instantly и НЕ пишем seen — замер неразрушающий и повторяемый, go-live
    // не «засевается». Ранний выход до append/seen, независимо от числа лидов.
    if (measureOnly) {
      await finishRun({
        status: 'completed',
        parsed: employers.length,
        after_icp: icp.length,
        new_employers: fresh.length,
        base_job_id: baseJobId,
        valid_contacts: leads.length,
        appended: 0,
        skipped: 0,
      });
      log(`MEASURE: parsed=${employers.length} new=${fresh.length} valid=${leads.length} (без заливки, seen не тронут)`);
      return {
        runId,
        status: 'completed',
        parsed: employers.length,
        newEmployers: fresh.length,
        validContacts: leads.length,
        appended: 0,
        skipped: 0,
      };
    }

    if (leads.length === 0) {
      // Скрейп отработал, но почт не нашли — помечаем seen как no_email,
      // чтобы не гонять тех же работодателей завтра.
      await markSeen(fresh.map(toSeen(new Set(), new Set(), 'no_email')));
      await finishRun({
        status: 'completed',
        parsed: employers.length,
        after_icp: icp.length,
        new_employers: fresh.length,
        base_job_id: baseJobId,
        valid_contacts: 0,
        appended: 0,
        skipped: 0,
      });
      return {
        runId,
        status: 'completed',
        parsed: employers.length,
        newEmployers: fresh.length,
        validContacts: 0,
        appended: 0,
        skipped: 0,
      };
    }

    // Сюда попадаем только в live-режиме (measureOnly=false), верхний гард
    // гарантирует, что campaign_id задан. Захватываем в const (тип → string).
    const campaignId = config.campaign_id;
    if (!campaignId) {
      throw new Error('campaign_id отсутствует в live-режиме (не должно случаться)');
    }

    // 7b. LLM-отсев B2C/ИП/гос (ТРЕТИЙ рубеж, только live): структурные правила
    //     ловят ~4%, но онлайн-школа с нейтральным доменом от B2B неотличима.
    //     Классифицируем УНИКАЛЬНЫЕ компании (не лиды), выкидываем лиды шумовых.
    //     Fail-open: сбой LLM = едем без этого фильтра, лиды не теряем.
    //     Шумовые компании остаются в fresh → попадут в markSeen (45д не трогаем
    //     — им и не надо писать; спустя окно их снова классифицирует LLM).
    // Контекст HH по домену: индустрии/описание/вакансия из fresh (HhEmployer[])
    // — они не доходят до грида (тот несёт только Компания/Сайт/Город/Email),
    // поэтому классификатору их отдаём отдельным маппингом по домену сайта.
    // Это резко сокращает «unclear»: «Смарт» → +индустрия +описание = ясный B2B.
    const hhContext = new Map<string, { industries: string[]; description?: string; vacancyTitle?: string }>();
    for (const e of fresh) {
      const d = deriveDomain(e.siteUrl);
      if (d && !hhContext.has(d)) {
        hhContext.set(d, { industries: e.industries ?? [], description: e.description, vacancyTitle: e.vacancyTitle });
      }
    }

    const uniqueCompanies: CompanyForClassify[] = [];
    const companyIdxByKey = new Map<string, number>();
    const leadCompanyIdx: number[] = [];
    for (const l of leads) {
      const key = `${(l.company_name ?? '').trim().toLowerCase()}|${(l.website ?? '').trim().toLowerCase()}`;
      let idx = companyIdxByKey.get(key);
      if (idx === undefined) {
        idx = uniqueCompanies.length;
        companyIdxByKey.set(key, idx);
        const ctx = hhContext.get(deriveDomain(l.website ?? null) ?? '');
        uniqueCompanies.push({
          name: l.company_name ?? '',
          website: l.website ?? '',
          industries: ctx?.industries,
          description: ctx?.description,
          vacancyTitle: ctx?.vacancyTitle,
        });
      }
      leadCompanyIdx.push(idx);
    }
    const llm = await llmClassifyNoise(uniqueCompanies, (m) => log(`[llm] ${m}`));
    const keptLeads = leads.filter((_, i) => !llm.noise.has(leadCompanyIdx[i]));
    log(
      `LLM-отсев: компаний ${uniqueCompanies.length}, вердиктов ${llm.classified}, ` +
        `шум ${llm.noise.size} (рефьют спас ${llm.refuted}), лидов ${leads.length} → ${keptLeads.length}` +
        (llm.failedBatches > 0 ? ` (батчей без фильтра: ${llm.failedBatches})` : '') +
        (llm.guardTripped ? ' [ПРЕДОХРАНИТЕЛЬ: фильтр отключён на этот прогон]' : ''),
    );
    // Известное ограничение: кап catch-all ≤20% посчитан в gridToLeadPayloads ДО
    // этого отсева; если LLM выкинул преимущественно ok-компании, доля catch-all
    // в финальной пачке может слегка превысить 20% (статусов у лидов здесь уже
    // нет — пересчитать нечем). При штатном шуме ~10-14% overshoot ≤ ~2 п.п.

    // Домены LLM-шума — для честного статуса в seen-журнале ('skipped', не
    // 'no_email': почты у них НАЙДЕНЫ, мы их отсеяли сами).
    const noiseDomains = new Set<string>();
    for (const idx of llm.noise) {
      const d = deriveDomain(uniqueCompanies[idx].website || null);
      if (d) noiseDomains.add(d);
    }

    // 8. ФИКСИРУЕМ seen-окно ДО append. append необратим (лиды улетают в
    //    Instantly, возможно несколькими chunk'ами по 1000); если он затем
    //    частично/полностью упадёт, эти компании НЕЛЬЗЯ пере-залить на следующем
    //    прогоне (клиент чистит кампанию → skip_if_in_campaign не спасёт). Поэтому
    //    окно 45 дней ставится РАНЬШЕ, чем хоть один лид попал в Instantly.
    //    Ранние сбои (HH/конструктор, выше) сюда не доходят → корректно ретраятся.
    //    Если markSeen упадёт — append (ниже) не выполнится → компании ретраятся,
    //    в Instantly чисто. Цена: при чистом полном сбое append (ничего не залито)
    //    эти компании на 45 дней не трогаем — осознанно (под-контакт ОК,
    //    пере-контакт — нет; требование «не чаще раза в 1.5 месяца»).
    const leadDomains = new Set(
      keptLeads.map((l) => deriveDomain(l.website ?? null)).filter((d): d is string => !!d),
    );
    await markSeen(fresh.map(toSeen(leadDomains, noiseDomains, 'no_email')));

    // 8b. ДЕДУП ПРОТИВ СВОИХ КАМПАНИЙ (до Instantly). Мы шлём с
    //     skip_if_in_campaign=false, потому что этот флаг у Instantly работает
    //     на весь воркспейс и режет наши лиды по пересечению с ЧУЖИМИ клиентскими
    //     кампаниями (у нас параллельно крутятся клиенты «под ключ»). Раз
    //     воркспейс-дедуп выключен — сами не допускаем дубль в СВОИХ A/B (иначе
    //     ре-контакт спустя 45д без чистки кампании создал бы вторую копию лида).
    //     Fail-soft: не смогли прочитать кампании — шлём как есть (риск редкого
    //     дубля лучше потери прогона; seen уже зафиксирован).
    const campaignIdB = config.campaign_id_b;
    const ourCampaigns = [campaignId, ...(campaignIdB ? [campaignIdB] : [])];
    let existingEmails = new Set<string>();
    try {
      existingEmails = await fetchExistingCampaignEmails(config.client_user_id, ourCampaigns);
    } catch (err) {
      log(`[dedup] не удалось прочитать свои кампании (${err instanceof Error ? err.message : String(err)}) — шлём без дедупа против своих`);
    }
    const sendLeads = keptLeads.filter((l) => !existingEmails.has(l.email.trim().toLowerCase()));
    if (sendLeads.length < keptLeads.length) {
      log(`Дедуп против своих кампаний: -${keptLeads.length - sendLeads.length} (уже в наших A/B) → ${sendLeads.length}`);
    }

    // 9. Добор в кампании Instantly. При заданной campaign_id_b — A/B-сплит
    //    офферов: лиды делятся 50/50 детерминированно по домену КОМПАНИИ
    //    (hash%2), чтобы все почты одной компании попали в ОДНУ кампанию (одна
    //    фирма не должна получить два разных оффера) и чтобы при ретраях лид не
    //    мигрировал между кампаниями.
    const batches: { campaign: string; label: 'A' | 'B'; leads: typeof sendLeads }[] = [];
    if (campaignIdB) {
      const a: typeof sendLeads = [];
      const b: typeof sendLeads = [];
      for (const l of sendLeads) (splitBucket(l.website ?? '', l.email) === 0 ? a : b).push(l);
      batches.push({ campaign: campaignId, label: 'A', leads: a });
      batches.push({ campaign: campaignIdB, label: 'B', leads: b });
      log(`A/B-сплит по домену компании: A=${a.length} B=${b.length}`);
    } else {
      batches.push({ campaign: campaignId, label: 'A', leads: sendLeads });
    }

    let acceptedA = 0;
    let acceptedB = 0;
    let skippedTotal = 0;
    const appendErrors: string[] = [];
    for (const batch of batches) {
      if (batch.leads.length === 0) continue;
      try {
        const res = await appendLeadsToClientCampaign({
          userId: config.client_user_id,
          campaignId: batch.campaign,
          leads: batch.leads,
          contextLabel: `OutreachOS daily (${batch.label})`,
          // false: Instantly НЕ режет по пересечению с чужими клиентскими
          // кампаниями (флаг у него воркспейс-широкий). Свой дедуп — шаг 8b.
          skipIfInCampaign: false,
        });
        if (batch.label === 'A') acceptedA = res.accepted;
        else acceptedB = res.accepted;
        skippedTotal += res.skipped;
        log(`Instantly [${batch.label}]: accepted=${res.accepted} skipped=${res.skipped}`);
      } catch (err) {
        // Сбой одной кампании не отменяет вторую: seen уже зафиксирован (шаг 8),
        // пере-заливки этих компаний не будет — фиксируем ошибку и продолжаем.
        appendErrors.push(`[${batch.label}] ${err instanceof Error ? err.message : String(err)}`);
        await logError('outreachos.append.failed', err, { runId, campaign: batch.campaign });
      }
    }
    const totalAccepted = acceptedA + acceptedB;
    const runStatus: 'completed' | 'failed' = appendErrors.length > 0 ? 'failed' : 'completed';

    await finishRun({
      status: runStatus,
      parsed: employers.length,
      after_icp: icp.length,
      new_employers: fresh.length,
      base_job_id: baseJobId,
      valid_contacts: leads.length,
      // LLM-отсев персистится (миграция 20260706_0001): без этого разница
      // valid_contacts↔appended в БД неотличима от отказов Instantly, а
      // деградация модели (шум 90%) незаметна до ручного чтения логов.
      llm_noise: llm.noise.size,
      llm_kept: keptLeads.length,
      llm_failed_batches: llm.failedBatches,
      llm_guard_tripped: llm.guardTripped,
      appended: acceptedA,
      appended_b: acceptedB,
      skipped: skippedTotal,
      ...(appendErrors.length > 0 ? { error_message: appendErrors.join('; ') } : {}),
    });

    await logAudit('outreachos.run.completed', 'OutreachOS daily pipeline completed', {
      runId,
      parsed: employers.length,
      newEmployers: fresh.length,
      validContacts: leads.length,
      llmNoise: llm.noise.size,
      llmKept: keptLeads.length,
      llmFailedBatches: llm.failedBatches,
      llmGuardTripped: llm.guardTripped,
      appendedA: acceptedA,
      appendedB: acceptedB,
      appendErrors: appendErrors.length,
    });

    return {
      runId,
      status: runStatus,
      parsed: employers.length,
      newEmployers: fresh.length,
      validContacts: leads.length,
      appended: totalAccepted,
      skipped: skippedTotal,
      ...(appendErrors.length > 0 ? { error: appendErrors.join('; ') } : {}),
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // Здесь seen НЕ трогаем. Сбои ДО шага 8 (HH/конструктор) seen не писали →
    // компании корректно ретраятся на следующем прогоне. Сбои НА/ПОСЛЕ шага 8
    // (append) уже прошли markSeen (шаг 8 выше append) → компании зафиксированы
    // в окне и НЕ будут пере-залиты, даже если append упал частично. Так блокер
    // «залито в Instantly, но не записано в seen → дубль в окне» закрыт.
    await finishRun({ status: 'failed', error_message: message });
    await logError('outreachos.run.failed', err, { runId });
    return { ...empty, runId, status: 'failed', error: message };
  }
}

/**
 * Читает suppression-список целиком (пагинация по 1000 — PostgREST режет
 * большие выборки). 3 попытки, затем throw: suppression обязателен (fail-closed).
 */
async function loadSuppression(
  db: NonNullable<typeof supabaseAdmin>,
): Promise<OutreachOsSuppression> {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const emails = new Set<string>();
      const domains = new Set<string>();
      const PAGE = 1000;
      for (let from = 0; ; from += PAGE) {
        const { data, error } = await db
          .from('outreachos_suppression')
          .select('kind, value')
          .range(from, from + PAGE - 1);
        if (error) throw new Error(error.message);
        const rows = (data ?? []) as { kind: string; value: string }[];
        for (const r of rows) {
          const v = (r.value ?? '').trim().toLowerCase();
          if (!v) continue;
          if (r.kind === 'email') emails.add(v);
          else if (r.kind === 'domain') domains.add(v);
        }
        if (rows.length < PAGE) break;
      }
      return { emails, domains };
    } catch (err) {
      if (attempt === 3) {
        throw new Error(
          `suppression load failed (клиентам писать нельзя — прогон остановлен): ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      await sleep(2000 * attempt);
    }
  }
  return EMPTY_SUPPRESSION; // недостижимо, для типов
}

/**
 * Детерминированный сплит 50/50 для A/B офферов: bucket по домену КОМПАНИИ
 * (сайт; fallback — домен почты). djb2-hash % 2 — стабилен между прогонами
 * (одна компания всегда в одной кампании) и не зависит от порядка лидов.
 */
export function splitBucket(website: string, email: string): 0 | 1 {
  const key =
    deriveDomain(website.trim() || null) ??
    email.slice(email.indexOf('@') + 1).toLowerCase();
  let h = 5381;
  for (let i = 0; i < key.length; i++) h = ((h * 33) ^ key.charCodeAt(i)) >>> 0;
  return (h % 2) as 0 | 1;
}

/**
 * Фабрика маппера HhEmployer → SeenEmployerUpsert. Статусы: домен в leadDomains
 * → 'appended'; в skippedDomains (LLM-шум: почты найдены, отсеяли сами) →
 * 'skipped'; иначе fallback ('no_email' = скрейп реально не нашёл почту).
 */
function toSeen(
  leadDomains: Set<string>,
  skippedDomains: Set<string>,
  fallback: SeenEmployerUpsert['status'],
): (e: HhEmployer) => SeenEmployerUpsert {
  return (e) => {
    const domain = deriveDomain(e.siteUrl);
    const status: SeenEmployerUpsert['status'] = !domain
      ? fallback
      : leadDomains.has(domain)
        ? 'appended'
        : skippedDomains.has(domain)
          ? 'skipped'
          : fallback;
    return {
      hh_employer_id: e.id,
      hh_employer_name: e.name ?? null,
      domain,
      site_url: e.siteUrl,
      status,
    };
  };
}
