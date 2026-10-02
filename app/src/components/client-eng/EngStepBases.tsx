'use client';

/**
 * Шаг 4 «Bases & Launch» — ВИТРИНА прогресса (без ручных кнопок): сборки,
 * конструктор и шаблоны гоняет автопилот («Start outreach», шаг 2), запуск —
 * единая кнопка на шаге 5 «Review & Launch». Здесь клиент видит живой прогресс
 * сборки (фазы задач + счётчики конструктора: найдено/валидных почт из
 * collect_info.construct), статусы баз (анализ: сегменты/углы) и кампании
 * после запуска (имя, контакты, дата — без ссылок наружу: кабинет white-label).
 *
 * У готовой базы рядом со «строками» стоит объём, который реально уедет в
 * рассылку (SendVolume): строк в базе и контактов в кампании — разные числа.
 */

import { useMemo } from 'react';
import { Database } from 'lucide-react';
import type { HeTemplate, HeVertical } from '@/lib/hypothesisEngine/types';
import { heLaunchIsIncomplete, parseLaunchInfo } from '@/lib/hypothesisEngine/launchHandoff';
import { type EngBaseSummary } from './api-client';
import { engRefillStoppedText, engStageErrorText } from './engText';
import { EngBadge, EngCard, EngSpinner, baseStatusTone, fmtDate } from './ui';
import type { EngDetail } from './EngProjectWizard';

/* ── Прогресс авто-сборки (collecting-база) ── */

function CollectProgress({ base }: { base: EngBaseSummary }) {
  const info = base.collect_info;
  const tasks = info?.tasks ?? [];
  const stats = info?.stats;
  const construct = info?.construct;
  return (
    <div
      className="rounded-md p-3 mt-2 flex flex-col gap-1.5"
      style={{ border: '1px solid var(--cp-divider)' }}
    >
      <div className="flex items-center gap-2 text-xs" style={{ color: 'var(--cp-amber)' }}>
        <EngSpinner className="h-3 w-3" />
        Collecting base{info?.limit ? ` (limit ${info.limit.toLocaleString('en-US')})` : ''}…
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

/**
 * Честный объём ДО запуска. Строк в базе и контактов в кампании — разные
 * числа: запуск (`runHeTemplateLaunch`) отправляет только строки с вердиктом
 * валидации 'ok', строки вне вертикали выбрасывает, а повторный адрес грузит
 * один раз (`mapBaseRowsToLeads`, дедуп по email). База на 2000 строк уезжает
 * сотнями, и до этой правки клиент узнавал об этом только после запуска.
 *
 * ПОЧЕМУ НЕТ ОДНОГО ЧИСЛА «ready to send». Точный ответ считается только по
 * самим строкам: нужно пересечение «вердикт ok» × «не помечена вне вертикали»
 * минус дубли адресов. Строки живут в `he_bases.data` (до 50k строк, десятки
 * МБ), а деталку проекта кабинет поллит каждые 4 секунды — по ней этот jsonb
 * намеренно не тянут (projectDetail.ts: HE_BASE_LIST_COLUMNS без `data`).
 * Из двух счётчиков в `collect_info` точное число не выводится: пересечение
 * «ok» и «вне вертикали» неизвестно, и любая арифметика над ними дала бы
 * ВЫДУМАННУЮ цифру — она хуже отсутствия цифры. Поэтому показываем ровно то,
 * что записано, каждое число своим именем, а «сколько уедет» называем только
 * фактом после запуска (`launch_info.leads_count`, TemplateLaunchStatus).
 * Точный предварительный счётчик возможен, но его должна ПИСАТЬ стадия при
 * финализации базы: считать «адреса с вердиктом 'ok', не помеченные вне
 * вертикали, после капа на компанию» надо там, где известна сетка, и класть
 * готовое число в collect_info.stats — кабинет не должен это выводить сам.
 *
 * ТРИ ветки из четырёх говорят не «сколько уедет», а «не уедет ничего»: база
 * без вердиктов, база, собранная прежним контрактом (вердикт не построчный), и
 * база, где ни один вердикт не 'ok'. Все три запуск ENG-клиента отклоняет до
 * создания кампании (runHeTemplateLaunch: baseNotVerified /
 * baseCollectedBeforeSplit / noValidEmails), поэтому здесь про это сказано
 * прямо — клиент не должен узнавать об отказе на шаге 5, пройдя часы сборки.
 *
 * КОМУ ПАНЕЛЬ ВООБЩЕ ПОЛОЖЕНА. Только базе, которую ещё можно запустить: авто-
 * база вертикали в 'analyzing' или 'analyzed'. Упавшую базу запуск не берёт (у
 * неё не бывает шаблона), а объяснение причины у неё своё — код стадии ниже;
 * панель рядом с ним спорила бы с ним («проверка не доработала» против «срез
 * не про вертикаль»). Прогон ежедневного долива не запускается вовсе — его
 * строки уходят прямо в идущую кампанию, и «уточним при запуске» про него ложь.
 */
function SendVolume({ base }: { base: EngBaseSummary }) {
  // Только авто-база: у загруженного файла движок строки не размечает, и
  // запуск их не фильтрует (`isAutoBase` в runHeTemplateLaunch).
  if (base.source !== 'auto' || base.row_count <= 0) return null;
  if (base.refill === true) return null;
  if (base.status !== 'analyzed' && base.status !== 'analyzing') return null;

  const construct = base.collect_info?.construct;
  // valid_count пишется только вместе с импортом результата конструктора;
  // у фазы в состоянии 'dispatched' его ещё нет.
  const verified =
    construct && construct.status !== 'dispatched' && typeof construct.valid_count === 'number'
      ? construct.valid_count
      : null;
  // `stats.low_relevance` отдаёт проекция (COLLECT_STATS_FIELDS).
  const flagged = base.collect_info?.stats?.low_relevance ?? 0;

  // Вердиктов нет ВООБЩЕ — и это не «узнаем на запуске», а отказ запуска.
  // `valid_count` пишется ровно тем же импортом результата конструктора, что и
  // пометки `_email_status` на строках (stages/baseCollect.ts: finalEmailStatuses
  // ← capImportedRows, оба в одной ветке), поэтому его отсутствие означает «ни
  // на одной строке вердикта нет». У market='us' вердикт обязателен
  // (runHeTemplateLaunch, шаг 5: verdict 'missing' → строка снята), так что
  // лидов не останется и запуск вернёт 400 baseNotVerified. Пересобрать базу
  // из кабинета клиент не может (шаг 4 — витрина, UI-вызова
  // POST /verticals/[id]/collect нет, а «Start outreach» новой сборки при
  // готовой базе не ставит), поэтому действие — то же, что у пустого пресета на
  // шаге 5: попросить менеджера. Легаси-база сюда НЕ попадает: импорт до
  // 26.09.2026 тоже писал valid_count — её разбирает следующая ветка.
  if (verified === null) {
    return (
      <div className="mt-2 text-[11px]" style={{ color: 'var(--cp-amber)' }}>
        Email verification did not finish on this base, so none of its rows has a verified email — and an
        unverified address is never mailed. This base cannot be launched: step 5 «Review &amp; Launch» will
        refuse it. Ask your manager to collect this audience again; a new collection runs verification to the
        end.
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
        This base was collected before every address got its own email check, so its check results cannot be
        tied to single addresses — step 5 «Review &amp; Launch» will refuse it. Ask your manager to collect this
        audience again; a new collection keeps one address per row with its own check result.
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
        {flagged > 0 ? ` · ${flagged.toLocaleString('en-US')} flagged as outside this vertical` : ''}
      </div>
      <div style={{ color: 'var(--cp-text-l)' }}>
        {verified === 0
          ? // Вердикты есть, но ни один не 'ok' — запуск вернёт 400 noValidEmails
            // (все строки снимет гейт как rejected), лидов не останется.
            'Not one address here passed verification, and only a verified email is mailed — so this base cannot be launched. Ask your manager to collect this audience again.'
          : 'Only rows with a verified email are mailed; flagged rows are skipped and a repeated address is mailed once — so a launch sends fewer contacts than the base has rows. The exact number is confirmed at launch.'}
      </div>
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
function AutopilotDecisions({ base }: { base: EngBaseSummary }) {
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
          Audience check: the first catalog slice matched the vertical in {pct(probe.first_hit_rate)} of
          sampled companies, so it was replaced — the new one matches {pct(probe.hit_rate)}.
        </div>
      )}
      {probe?.outcome === 'rejected' && (
        <div style={{ color: 'var(--cp-amber)' }}>
          Audience check failed: only {pct(probe.hit_rate)} of {probe.sampled ?? 0} sampled companies
          belonged to this vertical
          {probe.off_target_examples?.length
            ? ` (off-target: ${probe.off_target_examples.slice(0, 3).join(', ')})`
            : ''}
          . The base was not built on purpose — mailing such a list would hurt the verticals that do work.
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

/* ── Состояние запуска готового шаблона (только отображение; запуск — шаг 5) ── */

function TemplateLaunchStatus({ template }: { template: HeTemplate }) {
  const launch = parseLaunchInfo((template as { launch_info?: unknown }).launch_info);
  // Тот же предикат, что у шага 5 и у самого запуска: часть аудитории осталась
  // без кампании или без адресов. Зелёное «launched» здесь значило бы, что
  // делать нечего, а достроить запуск может только нажатие на шаге 5.
  const unfinished = launch !== null && heLaunchIsIncomplete(launch);

  if (!launch) {
    return (
      <div className="mt-2 rounded-md p-3 text-[11px]" style={{ border: '1px solid var(--cp-divider)', color: 'var(--cp-text-m)' }}>
        {/* Запуску нужен пресет отправки (`client_campaign_presets`): без него
            POST /eng/templates/[id]/launch отвечает «Sending preset not found»,
            а селектор шага 5 просто пуст. Сам клиент пресет НЕ создаёт — его
            заводит администратор студии (api/admin/clients/[id]/preset), и
            самообслуживания здесь не будет: в пресете живут ящики рассылки.
            Поэтому про условие сказано заранее, на шаге 4: до шага 5 клиент
            проходит часы сборки и не должен узнавать о блокировке последним.
            Про окно отправки здесь намеренно молчим — его клиент выбирает при
            запуске (роут `templates/[id]/schedule`), пресет задаёт лишь
            дефолт. */}
        {template.status === 'ready'
          ? 'Template is ready — launch it from step 5 «Review & Launch». Sending needs a preset set up for your account — the mailboxes your campaigns send from; step 5 shows whether yours is ready.'
          : 'Template is being built…'}
      </div>
    );
  }

  return (
    <div className="mt-2 rounded-md p-3 text-xs flex flex-col gap-1" style={{ border: '1px solid var(--cp-divider)' }}>
      <div className="flex items-center gap-2">
        <EngBadge
          label={unfinished ? 'launch unfinished' : 'launched (paused)'}
          tone={unfinished ? 'amber' : 'green'}
        />
        <span className="font-semibold" style={{ color: 'var(--cp-paper)' }}>{launch.campaign_name}</span>
      </div>
      <div className="ds-mono" style={{ color: 'var(--cp-text-m)' }}>
        {launch.leads_count.toLocaleString('en-US')} contacts{unfinished ? ' so far' : ''} · {fmtDate(launch.created_at)}
      </div>
      {unfinished && (
        <span className="text-[11px]" style={{ color: 'var(--cp-amber)' }}>
          Part of this audience has not gone out yet — finish the launch on step 5 «Review &amp; Launch».
        </span>
      )}
      {/* White-label: сегменты — подписи, а не ссылки. Вести клиента наружу
          некуда: своего входа в рассыльщик у него нет, а ссылка светит бренд. */}
      {Array.isArray(launch.campaigns) && launch.campaigns.length > 1 ? (
        <div className="flex flex-col gap-1 mt-1">
          <span className="text-[10px] font-semibold" style={{ color: 'var(--cp-text-m)' }}>
            Segment campaigns ({launch.campaigns.length})
          </span>
          {launch.campaigns.map((c) => (
            <span
              key={`${c.campaign_id}-${c.segment ?? 'main'}`}
              className="inline-flex items-center gap-1"
              style={{ color: 'var(--cp-paper)' }}
            >
              {c.segment ?? 'Default texts'}
            </span>
          ))}
        </div>
      ) : null}
      <span className="text-[10px]" style={{ color: 'var(--cp-text-l)' }}>
        The campaign stays paused — the team reviews and starts it manually.
      </span>
    </div>
  );
}

/* ── Основной компонент шага ── */

export function EngStepBases({ detail }: { detail: EngDetail; onChanged: () => void }) {
  const verticals = useMemo(() => (detail.verticals ?? []) as HeVertical[], [detail]);
  const bases = useMemo(() => (detail.bases ?? []) as EngBaseSummary[], [detail]);
  const templates = useMemo(() => (detail.templates ?? []) as HeTemplate[], [detail]);
  const jobs = useMemo(() => detail.jobs ?? [], [detail]);

  if (verticals.length === 0) {
    return (
      <EngCard>
        <p className="text-sm" style={{ color: 'var(--cp-text-m)' }}>
          No verticals yet — finish the research and review verticals on step 2 first.
        </p>
      </EngCard>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      {verticals.map((v) => {
        const ownBases = bases.filter((b) => b.vertical_id === v.id);
        const collecting = ownBases.find((b) => b.status === 'collecting');

        return (
          <EngCard key={v.id}>
            <div className="flex items-center gap-2">
              <Database className="h-4 w-4 shrink-0" style={{ color: 'var(--cp-text-l)' }} />
              <h4 className="text-sm font-bold m-0" style={{ color: 'var(--cp-paper)' }}>
                {v.name}
              </h4>
            </div>

            {/* Прогресс идущей сборки */}
            {collecting && <CollectProgress base={collecting} />}

            {/* Готовые/падавшие базы вертикали */}
            {ownBases.filter((b) => b.status !== 'collecting').map((b) => {
              const template = templates.find((t) => t.base_id === b.id);
              // Прогон ежедневного долива: не база под запуск, и у его отказа
              // другой ответ «что делать» (перезапуска ночи у клиента нет).
              const refill = b.refill === true;
              const templateJobActive = jobs.some(
                (j) =>
                  j.stage === 'template' &&
                  (j.status === 'pending' || j.status === 'running') &&
                  (j.payload as { base_id?: string } | null)?.base_id === b.id,
              );
              return (
                <div
                  key={b.id}
                  className="mt-2 rounded-md p-3"
                  style={{ border: '1px solid var(--cp-divider)' }}
                >
                  <div className="flex items-center gap-2">
                    <span className="truncate text-xs font-semibold" style={{ color: 'var(--cp-paper)' }}>
                      {b.filename}
                    </span>
                    <EngBadge label={b.status} tone={baseStatusTone(b.status)} />
                    <span className="ml-auto ds-mono text-[11px]" style={{ color: 'var(--cp-text-m)' }}>
                      {b.row_count.toLocaleString('en-US')} rows
                    </span>
                  </div>

                  {refill && b.status !== 'failed' && (
                    <div className="mt-2 text-[11px]" style={{ color: 'var(--cp-text-l)' }}>
                      This is a daily refill run, not a base to launch: whatever it adds goes straight into the
                      running campaign, and only addresses with a verified email are added. Recent activity on
                      the Command Center shows what each run added.
                    </div>
                  )}

                  <SendVolume base={b} />

                  <AutopilotDecisions base={b} />

                  {/* Причина падения: без неё «failed / 0 rows» ничего не объясняет.
                      he_bases.error пишет стадия как есть (русский текст, uuid
                      базы, имена таблиц), поэтому роут отдаёт не её, а код
                      причины: «сегмент исчерпан» и «срез не про эту вертикаль»
                      так остаются различимы, а сырьё не уезжает даже в payload.
                      Отмена сюда тоже попадает со status='failed' (cancel-роут
                      снимает базу с 'collecting') — её отдельный код 'cancelled'
                      читается как остановка, а не как сбой; статуса для этого
                      не хватает. */}
                  {b.status === 'failed' && b.error_code && (
                    <div className="mt-2 text-[11px]" style={{ color: 'var(--cp-red)' }}>
                      {engStageErrorText(b.error_code, refill ? 'refill' : 'collection')}
                    </div>
                  )}

                  {/* Тот же 'failed', но БЕЗ причины: `error_code` равен null,
                      когда в колонке пусто (стадию убили вместе с подом, и
                      he_bases.error пуст или отсутствует: легаси-строка,
                      правка руками или писатель, положивший пустой текст). Без
                      этой ветки карточка показывала красный бейдж и ничего
                      больше — статус без единого слова читается как поломка
                      продукта. Действие то же, что у кодов с перезапуском:
                      клиентское «Start outreach» ставит вертикали новую сборку
                      (упавшая база её не останавливает), но собранное этой
                      базой не переиспользует — поэтому «всё сохранено» здесь не
                      пишется. У ночи долива перезапуска нет вовсе. */}
                  {b.status === 'failed' && !b.error_code && (
                    <div className="mt-2 text-[11px]" style={{ color: 'var(--cp-red)' }}>
                      {refill
                        ? engRefillStoppedText()
                        : 'This collection stopped without a recorded reason, so this base will not be launched. If you still need this vertical, «Start outreach» on step 2 starts a new collection for it; contact your manager if it keeps stopping.'}
                    </div>
                  )}

                  {b.status === 'analyzing' && (
                    <div className="mt-2 text-[11px] inline-flex items-center gap-1.5" style={{ color: 'var(--cp-amber)' }}>
                      <EngSpinner className="h-3 w-3" /> Analyzing the base…
                    </div>
                  )}

                  {b.status === 'analyzed' && b.analysis && (
                    <div className="mt-2 text-[11px] flex flex-col gap-1" style={{ color: 'var(--cp-text-m)' }}>
                      {b.analysis.notable_segments.length > 0 && (
                        <div>Segments: {b.analysis.notable_segments.join(' · ')}</div>
                      )}
                      {b.analysis.recommended_angles.length > 0 && (
                        <div>Angles: {b.analysis.recommended_angles.join(' · ')}</div>
                      )}
                    </div>
                  )}

                  {templateJobActive && (
                    <div className="mt-2 text-[11px] inline-flex items-center gap-1.5" style={{ color: 'var(--cp-amber)' }}>
                      <EngSpinner className="h-3 w-3" /> Building template…
                    </div>
                  )}

                  {template && (
                    <div className="mt-2">
                      <div className="flex items-center gap-2 text-xs" style={{ color: 'var(--cp-text-m)' }}>
                        <EngBadge label={`template: ${template.status}`} tone={template.status === 'ready' ? 'green' : 'amber'} />
                        <span>{template.letters.length} letter{template.letters.length === 1 ? '' : 's'}</span>
                      </div>
                      <TemplateLaunchStatus template={template} />
                    </div>
                  )}
                </div>
              );
            })}

            {ownBases.length === 0 && !collecting && (
              <p className="mt-2 text-xs" style={{ color: 'var(--cp-text-l)' }}>
                No base yet — the autopilot collects one after «Start outreach» on step 2.
              </p>
            )}
          </EngCard>
        );
      })}
    </div>
  );
}
