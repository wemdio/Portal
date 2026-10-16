'use client';

/**
 * Куски карточки рынка шага 3 «Launch» (EngStepLaunch) про его КОНТАКТЫ: живой
 * прогресс сборки (фазы задач + счётчики конструктора: найдено/валидных почт
 * из collect_info.construct — CollectProgress), объём, который реально уедет в
 * рассылку (SendVolume: строк в базе и контактов в кампании — разные числа),
 * решения автопилота по плану источников (AutopilotDecisions) и правило кнопки
 * «Collect again» у последней базы рынка, остановившейся решением, которое
 * новая сборка повторит (HE_COLLECT_STOP_REPEATS_CODES): «Launch» такой рынок
 * заново не собирает, и повтор — только это явное нажатие.
 *
 * Список Do not contact клиента (план §1B): сборка пропускает компании из него
 * (`collect_info.stats.excluded_do_not_contact` — «N companies skipped»), а
 * компании, внесённые в список после сборки, остаются в базе, но в кампании не
 * уходят — запуск и долив сверяют список сами; панель объёма так и говорит.
 */

import { useEffect, useState } from 'react';
import { fetchEngBaseRows, type EngBaseSummary, type EngReadyToSend } from './api-client';
import { heCollectStopRepeats } from './clientFailureText';
import { EngSupportText } from './EngPaidAccess';
import { EngSpinner } from './ui';
import type { EngDetail } from './EngProjectWizard';

/* ── Список Do not contact в сборке ── */

/** «12 companies skipped — on your Do not contact list»; null — пропусков нет (или поля нет). */
function dncSkippedText(base: EngBaseSummary): string | null {
  const n = base.collect_info?.stats?.excluded_do_not_contact;
  if (typeof n !== 'number' || !Number.isFinite(n) || n <= 0) return null;
  return `${n.toLocaleString('en-US')} ${n === 1 ? 'company' : 'companies'} skipped — on your Do not contact list`;
}

/** Оговорка панели объёма: база не перечищается, список сверяют запуск и долив. */
const DNC_OLDER_BASES_NOTE = 'Companies on your Do not contact list stay in older bases but are not added to campaigns.';

function DncNotes({ base }: { base: EngBaseSummary }) {
  const skipped = dncSkippedText(base);
  return (
    <div className="flex flex-col gap-0.5" style={{ color: 'var(--cp-text-l)' }}>
      {skipped && <div className="ds-mono">{skipped}</div>}
      <div>{DNC_OLDER_BASES_NOTE}</div>
    </div>
  );
}

/* ── Прогресс авто-сборки (collecting-база) ── */

export function CollectProgress({ base }: { base: EngBaseSummary }) {
  const info = base.collect_info;
  const tasks = info?.tasks ?? [];
  const stats = info?.stats;
  const construct = info?.construct;
  const skipped = dncSkippedText(base);
  return (
    <div
      className="rounded-md p-3 mt-2 flex flex-col gap-1.5"
      style={{ border: '1px solid var(--cp-divider)' }}
    >
      <div className="flex items-center gap-2 text-xs" style={{ color: 'var(--cp-amber)' }}>
        <EngSpinner className="h-3 w-3" />
        Collecting contacts{info?.limit ? ` (limit ${info.limit.toLocaleString('en-US')})` : ''}…
      </div>
      {tasks.length > 0 && (
        <ul className="flex flex-col gap-1">
          {tasks.map((t, i) => (
            <li key={i} className="flex items-center gap-2 text-[11px] ds-mono" style={{ color: 'var(--cp-text-m)' }}>
              <span style={{ color: t.status === 'done' ? 'var(--cp-green)' : t.status === 'failed' ? 'var(--cp-red)' : 'var(--cp-text-l)' }}>
                {t.status ?? 'pending'}
              </span>
              <span>{t.source ?? 'source'}</span>
              {typeof t.rows === 'number' && <span className="ml-auto">{t.rows.toLocaleString('en-US')} rows</span>}
            </li>
          ))}
        </ul>
      )}
      {stats && (
        <div className="text-[11px] ds-mono" style={{ color: 'var(--cp-text-m)' }}>
          {stats.tasks_done ?? 0}/{stats.tasks_total ?? 0} tasks · {(stats.rows_total ?? 0).toLocaleString('en-US')} rows
        </div>
      )}
      {skipped && (
        <div className="text-[11px] ds-mono" style={{ color: 'var(--cp-text-l)' }}>
          {skipped}
        </div>
      )}
      {construct && (
        <div className="text-[11px]" style={{ color: 'var(--cp-text-m)' }}>
          {construct.status === 'dispatched' && (
            <span className="inline-flex items-center gap-1.5" style={{ color: 'var(--cp-amber)' }}>
              <EngSpinner className="h-3 w-3" /> Finding &amp; validating emails…
            </span>
          )}
          {construct.status === 'done' && (
            <span className="ds-mono">
              Emails found: {(construct.emails_found ?? 0).toLocaleString('en-US')} · valid:{' '}
              {(construct.valid_count ?? 0).toLocaleString('en-US')}
            </span>
          )}
          {(construct.status === 'failed' || construct.status === 'cancelled') && (
            <span style={{ color: 'var(--cp-red)' }}>Email enrichment {construct.status}.</span>
          )}
          {construct.note && <span className="block text-[10px]" style={{ color: 'var(--cp-text-l)' }}>{construct.note}</span>}
        </div>
      )}
    </div>
  );
}

/* ── Сколько из готовой базы реально уедет в рассылку ── */

const fmtCount = (n: number) => n.toLocaleString('en-US');

/**
 * Счёт «к отправке» готовой базы — GET /eng/bases/[id]/rows?ready=1
 * (countReadyToSend роута: правило us-запуска по всем строкам и чёрному
 * списку клиента). Один запрос на базу при показе карточки и заново, когда
 * меняется число строк; опрос деталки его не повторяет. null — ещё не пришёл,
 * не прочитался или сервер честно посчитать не может: панель тогда говорит
 * прежнее «X of Y rows with a verified email».
 */
function useReadyToSend(baseId: string | null, rowCount: number): EngReadyToSend | null {
  const key = baseId ? `${baseId}:${rowCount}` : null;
  const [state, setState] = useState<{ key: string; ready: EngReadyToSend | null } | null>(null);
  useEffect(() => {
    if (!baseId) return;
    const stateKey = `${baseId}:${rowCount}`;
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetchEngBaseRows(baseId, { limit: 1, ready: true });
        if (!cancelled) setState({ key: stateKey, ready: res.ready ?? null });
      } catch {
        if (!cancelled) setState({ key: stateKey, ready: null });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [baseId, rowCount]);
  return state && state.key === key ? state.ready : null;
}

/** Почему проверенные адреса не уйдут — только причины с ненулевым числом. */
function readyToSendReasons(ready: EngReadyToSend): string[] {
  return [
    ready.failed > 0 ? `${fmtCount(ready.failed)} did not pass the email check` : '',
    ready.flagged > 0 ? `${fmtCount(ready.flagged)} flagged as not a fit for this market` : '',
    ready.unusable > 0 ? `${fmtCount(ready.unusable)} without one usable address` : '',
    ready.repeated > 0 ? `${fmtCount(ready.repeated)} repeat an address already counted` : '',
    ready.blocked > 0 ? `${fmtCount(ready.blocked)} on your «Do not contact» list` : '',
    ready.over_limit > 0
      ? `${fmtCount(ready.over_limit)} over the ${fmtCount(ready.limit)}-contact limit of one launch`
      : '',
  ].filter((s) => s !== '');
}

/**
 * Честный объём ДО запуска. Строк в базе и контактов в кампании — разные
 * числа: запуск (`runHeTemplateLaunch`) отправляет только строки с вердиктом
 * валидации 'ok', строки вне вертикали выбрасывает, а повторный адрес грузит
 * один раз (`mapBaseRowsToLeads`, дедуп по email). База на 2000 строк уезжает
 * сотнями, и до этой правки клиент узнавал об этом только после запуска.
 *
 * ЧИСЛО «READY TO SEND» у готовой ('analyzed') базы считает СЕРВЕР по самим
 * строкам (useReadyToSend → countReadyToSend роута строк): те же функции и
 * тот же порядок, что у us-запуска, плюс чёрный список клиента и потолок
 * одного запуска. Деталка проекта `data` не возит (projectDetail.ts:
 * HE_BASE_LIST_COLUMNS без `data`, опрос раз в 4 с), поэтому счёт — отдельный
 * запрос раз на базу. Из двух счётчиков `collect_info` точное число не
 * выводится (пересечение «ok» и «вне вертикали» неизвестно), и экран сам его
 * не выводит: пока счёта нет — прежние числа, каждое своим именем, и «точное
 * число — при запуске». У 'analyzing'-базы счёта нет: её анализ ещё идёт.
 * После запуска карточка рынка печатает факт (`launch_info.leads_count`).
 *
 * ТРИ ветки из четырёх говорят не «сколько уедет», а «не уедет ничего»: база
 * без вердиктов, база, собранная прежним контрактом (вердикт не построчный), и
 * база, где ни один вердикт не 'ok'. Все три запуск ENG-клиента отклоняет до
 * создания кампании (runHeTemplateLaunch: baseNotVerified /
 * baseCollectedBeforeSplit / noValidEmails), поэтому здесь про это сказано
 * прямо — клиент не должен узнавать об отказе только при запуске, пройдя часы сборки.
 *
 * КОМУ ПАНЕЛЬ ВООБЩЕ ПОЛОЖЕНА. Только базе, которую ещё можно запустить: авто-
 * база вертикали в 'analyzing' или 'analyzed'. Упавшую базу запуск не берёт (у
 * неё не бывает шаблона), а объяснение причины у неё своё — код стадии ниже;
 * панель рядом с ним спорила бы с ним («проверка не доработала» против «срез
 * не про вертикаль»). Прогон ежедневного долива не запускается вовсе — его
 * строки уходят прямо в идущую кампанию, и «уточним при запуске» про него ложь.
 */
export function SendVolume({ base }: { base: EngBaseSummary }) {
  // Только авто-база: у загруженного файла движок строки не размечает, и
  // запуск их не фильтрует (`isAutoBase` в runHeTemplateLaunch).
  const shown =
    base.source === 'auto' &&
    base.row_count > 0 &&
    base.refill !== true &&
    (base.status === 'analyzed' || base.status === 'analyzing');

  const construct = base.collect_info?.construct;
  // valid_count пишется только вместе с импортом результата конструктора;
  // у фазы в состоянии 'dispatched' его ещё нет.
  const verified =
    construct && construct.status !== 'dispatched' && typeof construct.valid_count === 'number'
      ? construct.valid_count
      : null;
  // `stats.low_relevance` отдаёт проекция (COLLECT_STATS_FIELDS).
  const flagged = base.collect_info?.stats?.low_relevance ?? 0;
  // Счёт «к отправке» — только там, где ниже рисуется последняя ветка (есть
  // проверенные адреса, вердикты построчные) и база готова.
  const ready = useReadyToSend(
    shown && base.status === 'analyzed' && verified !== null && verified > 0 && construct?.per_address_verdicts !== false
      ? base.id
      : null,
    base.row_count,
  );
  if (!shown) return null;

  // Вердиктов нет ВООБЩЕ — и это не «узнаем на запуске», а отказ запуска.
  // `valid_count` пишется ровно тем же импортом результата конструктора, что и
  // пометки `_email_status` на строках (stages/baseCollect.ts: finalEmailStatuses
  // ← capImportedRows, оба в одной ветке), поэтому его отсутствие означает «ни
  // на одной строке вердикта нет». У market='us' вердикт обязателен
  // (runHeTemplateLaunch, пятый шаг ядра: verdict 'missing' → строка снята), так что
  // лидов не останется и запуск вернёт 400 baseNotVerified. Пересобрать базу
  // из кабинета клиент не может (кнопка «Collect again» есть только у
  // остановленной сборки, и её роут откажет вертикали с готовой базой, а
  // «Launch» новой сборки при готовой базе не ставит), поэтому
  // действие — Support (сборку заново ставит команда), той же фразой, что у
  // отказа запуска baseNotVerified.
  // Легаси-база сюда НЕ попадает: импорт до
  // 26.09.2026 тоже писал valid_count — её разбирает следующая ветка.
  if (verified === null) {
    return (
      <div className="mt-2 text-[11px]" style={{ color: 'var(--cp-amber)' }}>
        <EngSupportText
          text={
            'Email verification did not finish on this base, so none of its rows has a verified email — and an ' +
            'unverified address is never mailed. This base cannot be launched: its launch would be refused. ' +
            'Message Support to have this audience collected again; a new collection runs verification to the end.'
          }
        />
      </div>
    );
  }

  // Вердикты есть, но НЕ построчные: базу собирал прежний контракт (до
  // 26.09.2026 одна строка держала несколько адресов, и проверка сохраняла один
  // результат на всю ячейку). us-запуск такую базу отклоняет целиком
  // (baseCollectedBeforeSplit) тем же маркером, что проекция кладёт в
  // `per_address_verdicts`. Ключа нет (ответ старше) — не гадаем, идём дальше
  // прежним путём.
  if (construct?.per_address_verdicts === false) {
    return (
      <div className="mt-2 text-[11px]" style={{ color: 'var(--cp-amber)' }}>
        <EngSupportText
          text={
            'This base was collected before every address got its own email check, so its check results cannot ' +
            'be tied to single addresses — its launch would be refused. Message Support to have this audience ' +
            'collected again; a new collection keeps one address per row with its own check result.'
          }
        />
      </div>
    );
  }

  // Счёт сервера пришёл: одно число «к отправке» из проверенных и причины
  // остальных. Ноль к отправке — запуск такой базы откажет (ядро: noValidEmails
  // / allContactsBlocked — лидов не осталось). Проверенных нет вовсе (счёт
  // разошёлся с valid_count) — прежняя ветка ниже.
  if (ready && ready.checked > 0) {
    const reasons = readyToSendReasons(ready);
    return (
      <div
        className="mt-2 flex flex-col gap-1 text-[11px]"
        style={{ color: ready.to_send === 0 ? 'var(--cp-amber)' : 'var(--cp-text-m)' }}
      >
        <div className="ds-mono">
          Ready to send: {fmtCount(ready.to_send)} of {fmtCount(ready.checked)} checked addresses
        </div>
        <div style={{ color: ready.to_send === 0 ? 'var(--cp-amber)' : 'var(--cp-text-l)' }}>
          <EngSupportText
            text={
              ready.to_send === 0
                ? `Not one checked address can be mailed now: ${reasons.join(', ')}. A launch of this base would be refused. Message Support.`
                : `${reasons.length > 0 ? `The rest will not be mailed: ${reasons.join(', ')}. ` : ''}The launch counts again when it starts, so the number can still change.`
            }
          />
        </div>
        <DncNotes base={base} />
      </div>
    );
  }

  return (
    <div
      className="mt-2 flex flex-col gap-1 text-[11px]"
      // Ноль проверенных — не «меньше», а «нечего»: тот же сигнал, что у ветки
      // без вердиктов.
      style={{ color: verified === 0 ? 'var(--cp-amber)' : 'var(--cp-text-m)' }}
    >
      <div className="ds-mono">
        {verified.toLocaleString('en-US')} of {base.row_count.toLocaleString('en-US')} rows with a verified email
        {/* «not a fit», а не «outside this vertical»: при включённом
            HE_GATE_HYPOTHESIS_SCOPE (по умолчанию выключен) гейт судит по
            неотклонённым гипотезам вертикали (relevanceGate, gateScopeEn) и
            помечает и компанию из самой вертикали, не подходящую ни под одну из
            них. Фраза верна при обоих правилах гейта. */}
        {flagged > 0 ? ` · ${flagged.toLocaleString('en-US')} flagged as not a fit for this market` : ''}
      </div>
      <div style={{ color: 'var(--cp-text-l)' }}>
        <EngSupportText
          text={
            verified === 0
              ? // Вердикты есть, но ни один не 'ok' — запуск вернёт 400 noValidEmails
                // (все строки снимет гейт как rejected), лидов не останется.
                'Not one address here passed verification, and only a verified email is mailed — so this base cannot be launched. Message Support to have this audience collected again.'
              : 'Only rows with a verified email are mailed; flagged rows are skipped and a repeated address is mailed once — so a launch sends fewer contacts than the base has rows. The exact number is confirmed at launch.'
          }
        />
      </div>
      <DncNotes base={base} />
    </div>
  );
}

/* ── Решения автопилота по плану источников ── */

const pct = (v: number | undefined) => `${Math.round((v ?? 0) * 100)}%`;

/**
 * Что автопилот сделал с планом и почему. Обязательный экран: машина умеет
 * подменить каталожный срез и вовсе ОТКАЗАТЬСЯ строить базу — без объяснения
 * это читается как поломка. Клиент по задумке смотрит только ответы, поэтому
 * решение должно объяснять себя само, а не лежать в collect_info для разбора.
 */
export function AutopilotDecisions({ base }: { base: EngBaseSummary }) {
  const probe = base.collect_info?.slice_probe;
  const repair = base.collect_info?.plan_repair;
  if (!probe && !repair) return null;

  return (
    <div className="mt-2 flex flex-col gap-1 text-[11px]" style={{ color: 'var(--cp-text-m)' }}>
      {repair?.outcome === 'repaired' && (
        <div>The plan had no company catalog — the autopilot added one.</div>
      )}
      {repair?.outcome === 'failed' && (
        <div style={{ color: 'var(--cp-amber)' }}>
          The plan had no company catalog and one could not be added — the base stayed thin.
        </div>
      )}

      {probe?.outcome === 'repaired' && (
        <div>
          Audience check: the first catalog slice matched the market in {pct(probe.first_hit_rate)} of
          sampled companies, so it was replaced — the new one matches {pct(probe.hit_rate)}.
        </div>
      )}
      {probe?.outcome === 'rejected' && (
        <div style={{ color: 'var(--cp-amber)' }}>
          Audience check failed: only {pct(probe.hit_rate)} of {probe.sampled ?? 0} sampled companies
          belonged to this market
          {probe.off_target_examples?.length
            ? ` (off-target: ${probe.off_target_examples.slice(0, 3).join(', ')})`
            : ''}
          . The base was not built on purpose — mailing such a list would hurt the markets that do work.
        </div>
      )}
      {probe?.outcome === 'repair_failed' && (
        <div style={{ color: 'var(--cp-amber)' }}>
          Audience check flagged the catalog slice ({pct(probe.hit_rate)} match), but it could not be
          replaced — collected as planned.
        </div>
      )}
    </div>
  );
}

/* ── 'analyzing'-база: идёт ли анализ ── */

// Идёт ли анализ 'analyzing'-базы, решает СЕРВЕР (`analysis_live` деталки,
// общий предикат isAnalyzingBaseLive с окном постановки
// ANALYZING_ORPHAN_GRACE_MS — тот же, что у Command Center и реконсилера
// «Launch»), а экран читает его через engBaseAnalysisStopped (ui.tsx) —
// одно правило на бейдж и на фразу ниже. Прежний вывод здесь по капнутому
// списку `jobs` окна не знал и объявлял свежую базу (щель harvest-финала между
// статусом и вставкой анализа) остановленной раньше дашборда и кнопки.

type DetailJob = NonNullable<EngDetail['jobs']>[number];

function jobBaseId(job: DetailJob): string {
  const baseId = (job.payload as { base_id?: unknown } | null | undefined)?.base_id;
  return typeof baseId === 'string' ? baseId : '';
}

/**
 * Последний закончившийся base_analyze базы отменён («Cancel all jobs» обогнал
 * запись стадии). Список свежими первыми, поэтому первая найденная строка —
 * последняя; нет её в 30 строках — не знаем, и текст говорит «остановился».
 */
export function analysisCancelled(detail: EngDetail, baseId: string): boolean {
  const last = (detail.jobs ?? []).find(
    (j) => j.stage === 'base_analyze' && (j.status === 'failed' || j.status === 'cancelled') && jobBaseId(j) === baseId,
  );
  return last?.status === 'cancelled';
}

/* ── «Collect again»: повтор сборки, которую «Launch» не повторяет ── */

/** Своя база вертикали — авто-база, не прогон ночного долива (как у автопилота). */
export function isOwnAutoBase(base: EngBaseSummary): boolean {
  return base.source === 'auto' && base.refill !== true && !String(base.filename ?? '').startsWith('auto-refill');
}

/**
 * У какой базы вертикали рисовать «Collect again» (null — ни у какой). Ровно
 * условия, при которых роут кнопки (POST /verticals/[id]/collect) и правило
 * «Launch» (autopilotReconcile.ts) отдают повтор клиенту:
 *  - проект 'researched' и вертикаль выбрана (accepted-гипотеза);
 *  - ПОСЛЕДНЯЯ своя база (по created_at) — 'failed' с остановкой из
 *    HE_COLLECT_STOP_REPEATS_CODES;
 *  - нет своей базы в 'collecting' / 'analyzing' / 'analyzed' — иначе роут
 *    ответил бы «сборка уже идёт» или «база уже есть».
 */
export function collectAgainBaseId(ownBases: EngBaseSummary[], researched: boolean, selected: boolean): string | null {
  if (!researched || !selected) return null;
  const { latest, liveOrReady } = ownAutoBaseState(ownBases);
  if (liveOrReady) return null;
  if (!latest || latest.status !== 'failed' || !heCollectStopRepeats(latest.error_code)) return null;
  return latest.id;
}

/**
 * Своя авто-база вертикали, которая решает, что с вертикалью дальше:
 * ПОСЛЕДНЯЯ по created_at (как у «Launch» и «Collect again»), и есть
 * ли у вертикали своя база в 'collecting' / 'analyzing' / 'analyzed'.
 */
export function ownAutoBaseState(ownBases: EngBaseSummary[]): { latest: EngBaseSummary | null; liveOrReady: boolean } {
  const own = ownBases.filter(isOwnAutoBase);
  let latest: EngBaseSummary | null = null;
  for (const b of own) {
    if (!latest || Date.parse(b.created_at) > Date.parse(latest.created_at)) latest = b;
  }
  return {
    latest,
    liveOrReady: own.some((b) => b.status === 'collecting' || b.status === 'analyzing' || b.status === 'analyzed'),
  };
}

/**
 * Совет «перезапустите» («Launch» / «Collect again») правдив только у
 * остановленной своей авто-базы, которая решает, что дальше: она последняя и
 * у вертикали нет живой или готовой своей базы. Иначе «Launch» новую
 * сборку по ней не ставит (по живой или готовой базе — никогда, после
 * остановки HE_COLLECT_STOP_REPEATS_CODES последней базы — тоже), а «Collect
 * again» у неё не рисуется — и текст у неё другой (engEarlierBaseStopText).
 * Базы не авто-сборки правило «последней» не касается — прежний текст.
 */
export function stopTextOffersRestart(base: EngBaseSummary, ownBases: EngBaseSummary[]): boolean {
  if (!isOwnAutoBase(base)) return true;
  const { latest, liveOrReady } = ownAutoBaseState(ownBases);
  return !liveOrReady && latest?.id === base.id;
}
