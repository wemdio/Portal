'use client';

/**
 * Куски карточки рынка шага 3 «Launch» (EngStepLaunch) про его КОНТАКТЫ: живой
 * прогресс сборки (фазы задач + число найденных адресов
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
import { EngCollectionProgress } from './EngCollectionProgress';
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
  const qualification = base.collect_info?.company_qualification;
  const excluded = qualification && qualification.checked === qualification.total ? qualification.excluded : 0;
  return (
    <div className="flex flex-col gap-0.5" style={{ color: 'var(--cp-text-l)' }}>
      {excluded > 0 && (
        <div>{excluded.toLocaleString('en-US')} {excluded === 1 ? 'company' : 'companies'} excluded: the audience or country could not be confirmed.</div>
      )}
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
      {base.collection_progress?.step_key === 'company_qualification' || construct?.status === 'dispatched' ? (
        <EngCollectionProgress progress={base.collection_progress} />
      ) : !construct ? (
        <div className="flex items-center gap-2 text-xs" style={{ color: 'var(--cp-amber)' }}>
          <EngSpinner className="h-3 w-3" />
          Collecting contacts{info?.limit ? ` (up to ${info.limit.toLocaleString('en-US')})` : ''}…
        </div>
      ) : null}
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
          {construct.status === 'done' && (
            <span className="ds-mono">
              Emails found: {(construct.emails_found ?? 0).toLocaleString('en-US')}
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
 * не прочитался или сервер честно посчитать не может: панель тогда показывает
 * только размер базы, без предположения о количестве готовых контактов.
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
 * Объём до запуска считает сервер по строкам базы, списку Do not contact и
 * лимиту кампании. Счётчик valid_count из конструктора не заменяет этот расчёт:
 * у старых баз он не включает все адреса, допустимые текущей политикой ENG.
 * Пока готового расчёта нет, показываем только размер базы. Для analyzing
 * проверка ещё идёт; для refill отдельного запуска нет, поэтому панель скрыта.
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
  const verificationFinished =
    construct && construct.status !== 'dispatched' && typeof construct.valid_count === 'number';
  // Ноль в старом valid_count не означает, что все адреса непригодны.
  // Готовую базу с построчной проверкой считает сервер, включая такой случай.
  const ready = useReadyToSend(
    shown && base.status === 'analyzed' && verificationFinished && construct?.per_address_verdicts !== false
      ? base.id
      : null,
    base.row_count,
  );
  if (!shown) return null;

  // Импорт записывает valid_count вместе с построчными результатами проверки.
  // Отсутствие этого маркера означает, что проверка не завершилась.
  if (!verificationFinished) {
    return (
      <div className="mt-2 text-[11px]" style={{ color: 'var(--cp-amber)' }}>
        <EngSupportText
          text={
            'Email checks did not finish on this base. It cannot be launched yet. ' +
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

  // Только ответ сервера определяет доступный объём, в том числе нулевой.
  if (ready) {
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
                ? `No contacts are ready to send${reasons.length > 0 ? `: ${reasons.join(', ')}` : ''}. This base cannot be launched yet. Message Support.`
                : `${reasons.length > 0 ? `The rest will not be mailed: ${reasons.join(', ')}. ` : ''}The launch counts again when it starts, so the number can still change.`
            }
          />
        </div>
        <DncNotes base={base} />
      </div>
    );
  }

  return (
    <div className="mt-2 flex flex-col gap-1 text-[11px]" style={{ color: 'var(--cp-text-m)' }}>
      <div className="ds-mono">{fmtCount(base.row_count)} rows collected</div>
      <div style={{ color: 'var(--cp-text-l)' }}>
        {base.status === 'analyzing'
          ? 'Contacts are being checked. The number ready to send will be shown when the base is ready.'
          : 'The number ready to send is not available yet. It will be checked before launch.'}
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
