'use client';

/**
 * «Do not contact» ENG-кабинета (/client/eng/do-not-contact): чёрный список
 * клиента — добавить вставкой, найти, убрать.
 *
 * Хранилище — общий список клиента (`client_blocked_contacts`), его читают
 * фильтры запуска (Launch, «Launch N more markets») — один раз, в начале
 * запуска, — и ночного добора — прямо перед загрузкой (шапка
 * `api/client/blocklist/_eng.ts`). Адрес, добавленный, пока запуск или долив
 * уже идёт, в него ещё может попасть; экран так и говорит.
 *
 * ЛЮДИ, КОТОРЫЕ УЖЕ ЛЕЖАТ В КАМПАНИИ. Сам экран рассыльщика не зовёт. Снимает
 * их с кампаний клиента воркер (hypothesisEngine/engDncRemoval.ts) — только
 * при включённом HE_ENG_DNC_REMOVE (по умолчанию выключен). Режим экран берёт
 * из ответа GET (`in_campaign_removal`, `pending`, `failed`,
 * `failed_examples`) и POST (`removal`, `removal_campaigns`), тексты — по
 * режиму, и каждый говорит только то, что уже правда:
 *  - 'off' (и ответ без поля) — прежние честные слова: список не пускает адрес
 *    в новые загрузки (запуск, долив — их фильтр по списку клиента есть,
 *    launchTemplate шаг 5a, baseCollectRefill шаг 4, appendLeads), но из
 *    кампании, в которой человек уже лежит, его не убирает; срочно — Pause
 *    рынка на Outreach;
 *  - 'on' — «проверяем ваши кампании и убираем найденных» (а не «убираем»:
 *    большинства добавленных в кампаниях нет вовсе); без кампаний — «снимать
 *    неоткуда»; не прочиталось — «попробуем ещё»; сколько адресов ещё ждут
 *    проверки и какие снять не удалось (с тем, что делать). Адреса, стоявшие в
 *    списке до включения, воркер сам не проверяет — проверяет повторное
 *    добавление, — экран так и говорит. Шёл запуск (`removal_after_launch`) —
 *    «он ещё может их добавить, проверим ещё раз, когда он кончится» (воркер
 *    так и делает, engDncRemoval п. 3a), а не «снимать неоткуда»;
 *  - режим ещё неизвестен (список не прочитан) — только то, что верно в обоих.
 * Тексты Block на Replies — отсюда же (engDncBlockLines и соседи), чтобы обе
 * страницы говорили одно.
 *
 * Список берёт только точные адреса (то же правило `normalizeBlockedEmail`,
 * что у фильтров, плюс консервативная форма адреса); сайты, домены и шаблоны
 * роут не добавляет и называет.
 *
 * ДОМЕНЫ КОМПАНИЙ (план §1B, выключатель HE_ENG_DNC_DOMAINS, `domains_enabled`
 * ответа GET). Включён — у формы добавления два режима, «Email addresses» и
 * «Company domains»: домены шлются тем же POST с `kind: 'domains'`, проверяет
 * и нормализует их сервер (blockedDomains.ts — в бандл не едет: tldts и
 * словари почтовых сервисов), экран печатает его итог. Домен блокирует
 * компанию целиком: сборка её не берёт, запуск и долив не добавляют никого с
 * адресом на этом домене или его поддоменах и никого с этим сайтом компании.
 * Строка-домен в списке — `value` с меткой «Whole company». Снятие домена
 * честно оговаривает: компании, которые сборка пропустила, пока он стоял,
 * могут не вернуться в те же поиски (закладки каталога ушли дальше).
 *
 * Список длиннее BLOCKLIST_MAX_ENTRIES (сбой отката, потерянный ответ
 * вставки) читатели не принимают вовсе: запуск отказывает, долив не добавляет
 * никого. Пока так, экран держит об этом постоянную строку с настоящими
 * числами (OverLimitNotice).
 */

import Link from 'next/link';
import type { Route } from 'next';
import { useCallback, useEffect, useRef, useState } from 'react';
import { BLOCKLIST_MAX_ENTRIES } from '@/lib/clientBlocklist/blockedContacts';
import {
  addEngBlockedAddresses,
  addEngBlockedDomains,
  engBlockedIsDomain,
  engBlockedValue,
  fetchEngBlockedList,
  removeEngBlockedAddress,
  type EngBlockedAddResult,
  type EngBlockedAddress,
  type EngBlockedDomainsResult,
  type EngBlockedListPage,
  type EngBlockedRejected,
  type EngDncAddRemoval,
  type EngDncRemovalMode,
} from './api-client';
import { EngCard, EngEyebrow, EngSpinner, fmtDate } from './ui';

export const ENG_OUTREACH_PAGE = '/client/eng/dashboard' as Route;
export const ENG_DNC_PAGE = '/client/eng/do-not-contact' as Route;
const SUPPORT_PAGE = '/client/support' as Route;

const LOAD_FAILED = 'Could not load your list. Try again in a minute.';
// Читаемого ответа нет (сеть, 502/504 по таймауту или во время деплоя): сделал
// ли сервер своё, неизвестно. После добавления экран сам перечитывает список —
// отсюда «below»; после удаления — нет, отсюда «Refresh this page».
const ADD_NO_ANSWER =
  "We did not get an answer from the server, so we can't tell whether the addresses were added. " +
  'Check your list below.';
const REMOVE_NO_ANSWER =
  "We did not get an answer from the server, so we can't tell whether the address was removed. " +
  'Refresh this page to check.';
const EMPTY_PASTE = 'Paste at least one email address.';
const EMPTY_DOMAINS_PASTE = 'Paste at least one company domain.';
const ADD_DOMAINS_NO_ANSWER =
  "We did not get an answer from the server, so we can't tell whether the domains were added. " +
  'Check your list below.';
/** Оговорка снятия домена (план §1B): закладки каталога ушли дальше пропущенных компаний. */
const DOMAIN_REMOVAL_CAVEAT = 'Companies we skipped while it was listed may not be collected again.';

function fmtCount(n: number): string {
  return n.toLocaleString('en-US');
}

function addresses(n: number): string {
  return `${fmtCount(n)} ${n === 1 ? 'address' : 'addresses'}`;
}

function entries(n: number): string {
  return `${fmtCount(n)} ${n === 1 ? 'entry' : 'entries'}`;
}

function domains(n: number): string {
  return `${fmtCount(n)} ${n === 1 ? 'domain' : 'domains'}`;
}

function people(n: number): string {
  return `${fmtCount(n)} ${n === 1 ? 'person' : 'people'}`;
}

/**
 * Текст брошенной ошибки: английская фраза роута или истёкшей сессии (их
 * доводит engApiFetch) — как есть; сетевой отказ fetch (TypeError) и пустое
 * сообщение — `fallback`.
 */
export function engDncErrorText(e: unknown, fallback: string): string {
  return e instanceof Error && !(e instanceof TypeError) && e.message ? e.message : fallback;
}

/* ── Тексты снятия с кампаний (общие с Block на Replies) ── */

/**
 * Сроки. Проверяет воркер hypothesis-engine между джобами, раз в минуту и не
 * больше 5 вызовов рассыльщика за проход (engDncRemoval.ts): адрес × кампания
 * — 1–5 вызовов, то есть 1 000 адресов при 3 кампаниях — около суток. Строки
 * клиента идут по очереди, поэтому и один адрес ждёт всех, добавленных раньше:
 * обещания «за несколько минут» нет нигде.
 */
const LONG_LIST_TIMING = 'A long list can take a day or more.';

/** «your campaign» / «your 3 campaigns» / «your campaigns» (число не пришло). */
function yourCampaigns(campaigns: number | null): string {
  if (campaigns === null) return 'your campaigns';
  return campaigns === 1 ? 'your campaign' : `your ${fmtCount(campaigns)} campaigns`;
}

/** Block, кампания ответа не проверяется: «your other campaign» / «your 3 other campaigns». */
function yourOtherCampaigns(campaigns: number | null): string {
  if (campaigns === null) return 'your other campaigns';
  return campaigns === 1 ? 'your other campaign' : `your ${fmtCount(campaigns)} other campaigns`;
}

/**
 * У клиента шёл запуск (removal_after_launch): он прочитал список в начале и
 * ещё может загрузить этих людей; воркер проверит кампании ещё раз, когда он
 * кончится (engDncRemoval, шапка п. 3a).
 */
function afterLaunchLine(subject: 'this person' | 'these people' | 'this address'): string {
  return `A launch is running right now and may still add ${subject} to a campaign, so we check again once it finishes.`;
}

/**
 * Строка итога вставки про кампании; null — сказать нечего (снятие выключено
 * или адресов во вставке не было). `n` — адреса вставки, которые теперь в
 * списке (добавленные + уже стоявшие): роут раскладывает по кампаниям и те, и
 * другие, и каждое добавление проверяет все кампании заново.
 */
function addRemovalLine(r: EngBlockedAddResult, n: number): string | null {
  const { removal, removal_campaigns: campaigns, removal_after_launch: afterLaunch } = r;
  if (n <= 0 || removal === 'off') return null;
  const one = n === 1;
  if (removal === 'removing') {
    const launch = afterLaunch ? ` ${afterLaunchLine(one ? 'this person' : 'these people')}` : '';
    return one
      ? `We are also checking ${yourCampaigns(campaigns)} for this person and taking them out of any campaign they ` +
          `are in. Until we get to them, they may still get emails from a campaign they are already in.${launch}`
      : `We are also checking ${yourCampaigns(campaigns)} for these people and taking each of them out of any ` +
          'campaign they are in. Until we get to an address, it may still get emails from a campaign it is already ' +
          `in.${launch} ${LONG_LIST_TIMING} You can follow the progress at the top of this page.`;
  }
  if (removal === 'none_running') {
    if (afterLaunch) {
      // Кампаний в записях ещё нет, но запуск идёт: он может их создать и
      // загрузить этих людей — после него воркер проверит.
      return (
        `You have no launched campaigns yet. ${afterLaunchLine(one ? 'this person' : 'these people')} ` +
        `If we find ${one ? 'them' : 'any of them'} in one, we take ${one ? 'them' : 'that person'} out of it. ` +
        `Until we get to ${one ? 'them' : 'an address'}, ${one ? 'they' : 'it'} may still get emails from it.`
      );
    }
    return (
      'You have no launched campaigns yet, so there is no one to take out of one. Your list is checked before ' +
      'contacts are added to any campaign you launch.'
    );
  }
  if (removal === 'deferred') {
    return (
      `We could not check your campaigns for ${one ? 'this person' : 'these people'} just now. We will keep ` +
      `trying, and take ${one ? 'them' : 'each of them'} out of any campaign they are in. Until then, they may ` +
      'still get emails from a campaign they are already in.'
    );
  }
  return (
    `${one ? 'This address is' : 'These addresses are'} on your list, but we could not start checking your ` +
    `campaigns for ${one ? 'it' : 'them'}. Add ${one ? 'it' : 'them'} again in a minute to try again.`
  );
}

/** Первая фраза Block на Replies про сам ответ: кампании кабинета созданы с stop on reply. */
export const ENG_DNC_REPLY_STOPPED = 'This campaign stopped emailing them when they replied.';

/**
 * Block на Replies: что сказать, когда адрес оказался в списке. `added` —
 * добавлен этим нажатием (false — уже стоял). Человек ответил, а каждая
 * кампания кабинета создаётся с stop on reply (engSendingPreset
 * HE_ENG_POOL_CAMPAIGN_SETTINGS, пресет клиента держит то же) — поэтому
 * первая фраза одна во всех режимах: эта кампания ему больше не пишет. При
 * 'off' экран Replies добавляет строку про Pause — только для кампании
 * ДРУГОГО рынка (engDncBlockPauseHint).
 *
 * `skippedReplyCampaign` — кампанию ответа сервер не проверяет (из неё
 * человека не удаляют: она ему уже не пишет), `campaigns` — остальные: «your
 * N other campaigns». Без признака (событие ответа не сошлось) — общая фраза
 * про все кампании, она верна и тогда. `afterLaunch` — идёт запуск (см.
 * afterLaunchLine).
 */
export function engDncBlockLines(input: {
  added: boolean;
  removal: EngDncAddRemoval;
  campaigns: number | null;
  afterLaunch?: boolean;
  skippedReplyCampaign?: boolean;
}): string[] {
  const first = input.added ? 'Added to Do not contact.' : 'Already on your Do not contact list.';
  const lines = [first, ENG_DNC_REPLY_STOPPED];
  const launch = input.afterLaunch ? ` ${afterLaunchLine('this address')}` : '';
  if (input.removal === 'removing') {
    lines.push(
      input.skippedReplyCampaign
        ? `We are also checking ${yourOtherCampaigns(input.campaigns)} for this address and taking it out of any ` +
            `campaign it is still in. Until we get to it, another campaign it is in may still email it.${launch} ` +
            'You can follow the progress on Do not contact.'
        : `We are also checking ${yourCampaigns(input.campaigns)} for this address and taking it out of any campaign ` +
            `it is still in. Until we get to it, another campaign it is in may still email it.${launch} ` +
            'You can follow the progress on Do not contact.',
    );
  } else if (input.removal === 'none_running' && input.afterLaunch) {
    lines.push(
      `${afterLaunchLine('this address')} If we find it in one, we take it out of it. Until we get to it, that ` +
        'campaign may still email it. You can follow the progress on Do not contact.',
    );
  } else if (input.removal === 'deferred') {
    lines.push(
      'We could not check your other campaigns for this address just now. We will keep trying, and take it out of ' +
        'any campaign it is in.',
    );
  } else if (input.removal === 'not_scheduled') {
    lines.push('We could not start checking your other campaigns for this address. Press «Try again» in a minute.');
  } else {
    lines.push('We also leave this address out whenever we add new contacts to your campaigns.');
  }
  return lines;
}

/** Block на Replies при 'off': Pause нужен только для кампании другого рынка. */
export function engDncBlockPauseHint(removal: EngDncAddRemoval): boolean {
  return removal === 'off';
}

/**
 * Block на Replies, после «Remove from Do not contact». `removal` — режим
 * последнего добавления этого адреса: снятие включено — человека могли уже
 * снять, и обратно его не возвращают (удаление из списка у рассыльщика ничего
 * не делает); ждущие проверки этого адреса отменяются.
 */
export function engDncUnblockLines(removal: EngDncAddRemoval): string[] {
  const lines = [
    'Removed from Do not contact. From now on, this address can be included again when we add new contacts to ' +
      'your campaigns.',
  ];
  if (removal !== 'off') {
    lines.push('If we already took this person out of a campaign, they are not put back into it.');
  }
  return lines;
}

/** «a, b and 3 more» — примеры как прислал роут, плюс остаток числом. */
function examplesText(r: EngBlockedRejected): string {
  const rest = r.count - r.examples.length;
  const list = r.examples.join(', ');
  return rest > 0 ? `${list} and ${fmtCount(rest)} more` : list;
}

/**
 * Строки итога добавления доменов (план §1B, тексты дизайна); каждая верна для
 * любого сочетания чисел. Строка про идущие кампании — всегда, когда домен
 * теперь в списке: снятие с кампаний доменов не касается (engDncRemoval
 * строки '@…' пропускает).
 */
function addDomainsResultLines(r: EngBlockedDomainsResult): string[] {
  const lines: string[] = [];
  if (r.added > 0) lines.push(`Added ${domains(r.added)} to your list.`);
  if (r.already_listed > 0) {
    lines.push(
      r.already_listed === 1
        ? '1 domain was already on your list.'
        : `${fmtCount(r.already_listed)} domains were already on your list.`,
    );
  }
  if (r.added === 0 && r.already_listed === 0) lines.push('Nothing was added.');
  if (r.personal.count > 0) {
    lines.push(
      "Not added, because personal email providers can't be blocked as a whole: " +
        `${examplesText(r.personal)}. Add the person's address instead.`,
    );
  }
  if (r.not_company.count > 0) {
    lines.push(
      `Not added, because ${r.not_company.count === 1 ? 'this is not a company domain' : 'these are not company domains'}: ` +
        `${examplesText(r.not_company)}.`,
    );
  }
  if (r.invalid.count > 0) {
    lines.push(
      `Not added, because ${r.invalid.count === 1 ? 'this is not a domain' : 'these are not domains'}: ` +
        `${examplesText(r.invalid)}.`,
    );
  }
  if (r.subdomains.count > 0) {
    lines.push(
      `Added as you typed: ${examplesText(r.subdomains)}. This blocks only that part of the site. To block the whole ` +
        'company, add the parent domain, for example acme.com for shop.acme.com.',
    );
  }
  if (r.added + r.already_listed > 0) {
    lines.push(
      'People at these companies who are already in a running campaign stay in it. To stop their emails now, add ' +
        'their addresses too, or press «Pause» on Outreach.',
    );
  }
  return lines;
}

/**
 * Строки итога добавления; каждая верна для любого сочетания чисел.
 * `domainsEnabled` — у формы есть режим «Company domains»: строка про домены
 * зовёт туда.
 */
function addResultLines(r: EngBlockedAddResult, domainsEnabled: boolean): string[] {
  const lines: string[] = [];
  if (r.added > 0) lines.push(`Added ${addresses(r.added)} to your list.`);
  if (r.already_listed > 0) {
    lines.push(
      r.already_listed === 1
        ? '1 address was already on your list.'
        : `${fmtCount(r.already_listed)} addresses were already on your list.`,
    );
  }
  if (r.added === 0 && r.already_listed === 0) lines.push('Nothing was added.');
  if (r.domains.count > 0) {
    // В этот класс роут кладёт только токены с явным признаком сайта, домена
    // или шаблона (`@acme.com`, `*@acme.com`, `https://…`, `www.…`, путь) —
    // голое слово с точкой идёт в «not an email address» ниже.
    lines.push(
      domainsEnabled
        ? `Not added here, because these look like websites or domains: ${examplesText(r.domains)}. To block a ` +
            'whole company, add its domain under «Company domains».'
        : 'Not added, because only exact email addresses can be added, not websites, whole domains or patterns: ' +
            `${examplesText(r.domains)}.`,
    );
  }
  if (r.invalid.count > 0) {
    lines.push(
      `Not added, because ${r.invalid.count === 1 ? 'this is not an email address' : 'these are not email addresses'}: ` +
        `${examplesText(r.invalid)}.`,
    );
  }
  const removal = addRemovalLine(r, r.added + r.already_listed);
  if (removal) lines.push(removal);
  return lines;
}

type Note = { tone: 'ok' | 'error'; lines: string[] };

function NoteLines({ note }: { note: Note }) {
  return (
    <div className="mt-3 flex flex-col gap-1">
      {note.lines.map((line, i) => (
        <p
          key={i}
          className="text-sm m-0 break-words"
          style={{ color: note.tone === 'error' ? 'var(--cp-red)' : 'var(--cp-paper)' }}
        >
          {line}
        </p>
      ))}
    </div>
  );
}

function OutreachLink() {
  return (
    <Link href={ENG_OUTREACH_PAGE} prefetch={false} className="underline">
      Outreach
    </Link>
  );
}

/**
 * «How it works» по режиму снятия. `mode` null — список ещё не прочитан или
 * не прочитался: только пункты, верные в обоих режимах.
 */
function HowItWorks({ mode, domainsEnabled }: { mode: EngDncRemovalMode | null; domainsEnabled: boolean }) {
  const item = 'text-sm m-0';
  const color = { color: 'var(--cp-text-m)' };
  return (
    <EngCard>
      <EngEyebrow>How it works</EngEyebrow>
      <ul className="m-0 pl-5 flex flex-col gap-2 list-disc">
        {/* Запуск читает список один раз, в начале (launchTemplate, шаг 5a), и
            грузит контакты через минуты; долив — прямо перед загрузкой. Отсюда
            «at that moment» и оговорка про уже идущий запуск или долив. */}
        <li className={item} style={color}>
          We check this list when a launch starts and each time the daily top-up adds new contacts. Anyone on the
          list at that moment is left out. Someone you add while a launch or a top-up is already running may still
          be included in it.
        </li>
        {domainsEnabled ? (
          <>
            <li className={item} style={color}>
              An email address blocks one person. A company domain blocks the whole company: we don&apos;t collect it
              for your markets, and nobody with an address at that domain or its subdomains, or listed with that
              company website, is added to your campaigns.
            </li>
            <li className={item} style={color}>
              List every domain a company uses, for example waystone.com and waystone.ie.
            </li>
          </>
        ) : (
          <li className={item} style={color}>
            It matches exact email addresses only. A whole domain, such as company.com, can&apos;t be added.
          </li>
        )}
        {mode === 'off' && (
          <>
            <li className={item} style={color}>
              Adding someone here does not take them out of a campaign they are already in. If they were added to a
              campaign before, they keep getting its remaining emails until the sequence ends or they reply.
            </li>
            <li className={item} style={color}>
              If emails to someone must stop right away, open <OutreachLink /> and press «Pause» on the market they
              are in, or on every market if you are not sure. Nothing is sent from a paused market, but their
              remaining emails go out once you press «Resume».
            </li>
          </>
        )}
        {/* Стоявших в списке до включения снятия воркер сам не проверяет —
            проверяет повторное добавление: POST раскладывает по кампаниям и
            уже стоявшие адреса, и каждое добавление проверяет все кампании
            клиента заново (he_eng_dnc_enqueue, since). */}
        {mode === 'on' && (
          <>
            <li className={item} style={color}>
              When you add an address, we also check your campaigns for it and take that person out of any campaign
              they are in. Until we get to an address, it may still get emails from a campaign it is already in.{' '}
              {LONG_LIST_TIMING} If a launch is running when you add someone, it may still add them to a campaign,
              so we check your campaigns for them again once the launch finishes.
            </li>
            <li className={item} style={color}>
              Each time you add an address, even one that is already on your list, we check all your campaigns for it
              again. Addresses that were on your list before we started doing this are not checked until you add them
              again.
            </li>
            <li className={item} style={color}>
              If emails to someone must stop before that, open <OutreachLink /> and press «Pause» on the market they
              are in, or on every market if you are not sure. Nothing is sent from a paused market until you press
              «Resume».
            </li>
          </>
        )}
        {mode === null && (
          <li className={item} style={color}>
            If emails to someone must stop right away, open <OutreachLink /> and press «Pause» on the market they are
            in, or on every market if you are not sure. Nothing is sent from a paused market until you press
            «Resume».
          </li>
        )}
      </ul>
    </EngCard>
  );
}

/**
 * Сводка снятия при 'on': сколько разных адресов ждут проверки кампаний и
 * каких снять не удалось (he_eng_dnc_summary, сверенная роутом со списком и
 * записями клиента: только то, с чем клиент ещё может что-то сделать). Ничего
 * не ждёт и ничего не упало — блока нет. null у числа — сводка не прочиталась:
 * так и сказано, без нуля вместо числа. `checkError` — «Check again» не
 * прочитал свежую сводку: старые числа не показываются как текущие.
 */
function RemovalProgress({
  pending,
  failed,
  failedExamples,
  failedAtLeast,
  checking,
  checkError,
  onCheckAgain,
}: {
  pending: number | null;
  failed: number | null;
  failedExamples: string[];
  failedAtLeast: boolean;
  checking: boolean;
  checkError: boolean;
  onCheckAgain: () => void;
}) {
  const unknown = checkError || pending === null || failed === null;
  if (!unknown && pending === 0 && failed === 0) return null;
  const text = 'text-sm m-0';
  const rest = failed !== null ? failed - failedExamples.length : 0;
  return (
    <EngCard>
      <EngEyebrow>Taking people out of your campaigns</EngEyebrow>
      <div className="flex flex-col gap-2">
        {!checkError && pending !== null && pending > 0 && (
          <p className={text} style={{ color: 'var(--cp-paper)' }}>
            We are still checking {addresses(pending)} against your campaigns and taking out anyone we find in one.
            Until we get to an address, it may still get emails from a campaign it is already in. {LONG_LIST_TIMING}
          </p>
        )}
        {!checkError && failed !== null && failed > 0 && (
          <p className={text} style={{ color: 'var(--cp-red)' }}>
            We could not take {failedAtLeast ? 'at least ' : ''}
            {people(failed)} out of your campaigns
            {failedExamples.length > 0 && (
              <>
                : {failedExamples.join(', ')}
                {rest > 0 ? ` and ${fmtCount(rest)} more` : ''}
              </>
            )}
            . They may still get the remaining emails of a campaign they are in. To try again, add their addresses
            again. If emails to them must stop right away, open <OutreachLink /> and press «Pause» on the market they
            are in, or message us in{' '}
            <Link href={SUPPORT_PAGE} prefetch={false} className="underline">
              Support
            </Link>
            .
          </p>
        )}
        {unknown && (
          <p className={text} style={{ color: 'var(--cp-paper-mute)' }}>
            We could not check how many addresses are still waiting to be checked against your campaigns. Press
            «Check again» in a minute.
          </p>
        )}
        <div>
          <button
            type="button"
            onClick={onCheckAgain}
            disabled={checking}
            className="ds-btn-ghost inline-flex items-center gap-1.5 text-xs disabled:opacity-50"
          >
            {checking && <EngSpinner />}
            {checking ? 'Checking…' : 'Check again'}
          </button>
        </div>
      </div>
    </EngCard>
  );
}

/**
 * Список длиннее потолка: getBlockedEmailSet бросает на count > потолка, и тогда
 * запуск отказывает на шаге 5a (до первой загрузки контактов), а долив падает
 * на шаге 4 и в appendLeads — новых контактов в кампаниях нет, пока список не
 * укоротят. Уже загруженным получателям кампании пишут дальше — эта строка
 * этого и не утверждает. Числа — из `total` списка (точный счёт роута).
 */
function OverLimitNotice({ total }: { total: number }) {
  return (
    <EngCard>
      <p className="text-sm m-0" style={{ color: 'var(--cp-red)' }}>
        Your list holds {entries(total)}, more than the {fmtCount(BLOCKLIST_MAX_ENTRIES)} it can hold. Until you
        remove at least {fmtCount(total - BLOCKLIST_MAX_ENTRIES)}, no new contacts are added to your campaigns: a
        launch stops with an error before adding anyone, and the daily top-up adds no one.
      </p>
    </EngCard>
  );
}

type AddMode = 'emails' | 'domains';

/**
 * Добавление домена: тот же исход, что у адресов, но свои тексты. Поле пустеет,
 * когда отказов нормализации нет (поддомены добавлены — это не отказ).
 */
async function submitDomains(
  text: string,
  setNote: (note: Note) => void,
  setText: (text: string) => void,
  onAdded: () => void,
): Promise<void> {
  const outcome = await addEngBlockedDomains(text);
  if (outcome.ok) {
    const r = outcome.result;
    setNote({ tone: r.added > 0 || r.already_listed > 0 ? 'ok' : 'error', lines: addDomainsResultLines(r) });
    if (r.invalid.count === 0 && r.personal.count === 0 && r.not_company.count === 0) setText('');
    if (r.added > 0) onAdded();
  } else {
    setNote({ tone: 'error', lines: [outcome.error ?? ADD_DOMAINS_NO_ANSWER] });
    // Выключатель доменов погас — перечитанный список уберёт режим доменов.
    if (outcome.reload || outcome.code === 'domains_unavailable') onAdded();
  }
}

function AddAddresses({ onAdded, domainsEnabled }: { onAdded: () => void; domainsEnabled: boolean }) {
  const [text, setText] = useState('');
  const [adding, setAdding] = useState(false);
  const [note, setNote] = useState<Note | null>(null);
  const [modeChoice, setModeChoice] = useState<AddMode>('emails');
  // Выключатель доменов погас (перечитанный список) — режим доменов недоступен.
  const mode: AddMode = domainsEnabled ? modeChoice : 'emails';

  const switchMode = (next: AddMode) => {
    if (next === mode || adding) return;
    setModeChoice(next);
    setNote(null);
  };

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (adding) return;
    if (!text.trim()) {
      setNote({ tone: 'error', lines: [mode === 'domains' ? EMPTY_DOMAINS_PASTE : EMPTY_PASTE] });
      return;
    }
    setAdding(true);
    setNote(null);
    if (mode === 'domains') {
      try {
        await submitDomains(text, setNote, setText, onAdded);
      } catch (err) {
        setNote({ tone: 'error', lines: [engDncErrorText(err, ADD_DOMAINS_NO_ANSWER)] });
        onAdded();
      } finally {
        setAdding(false);
      }
      return;
    }
    try {
      const outcome = await addEngBlockedAddresses(text);
      if (outcome.ok) {
        const r = outcome.result;
        setNote({
          tone: r.added > 0 || r.already_listed > 0 ? 'ok' : 'error',
          lines: addResultLines(r, domainsEnabled),
        });
        // Всё принято — поле пустеет; что-то не добавлено — текст остаётся,
        // чтобы клиент поправил именно его. При 'not_scheduled' — тоже
        // остаётся: «добавьте ещё раз» — это та же кнопка с тем же текстом.
        if (r.domains.count === 0 && r.invalid.count === 0 && r.removal !== 'not_scheduled') setText('');
        // Одни «уже в списке» со снятием тоже меняют сводку наверху: каждое
        // добавление проверяет кампании заново и гасит прежние «не удалось».
        if (r.added > 0 || r.removal !== 'off') onAdded();
      } else {
        // error: null — читаемого ответа не было (502/504 и т. п.), исход
        // неизвестен; reload тогда true, и список перечитывается.
        setNote({ tone: 'error', lines: [outcome.error ?? ADD_NO_ANSWER] });
        if (outcome.reload) onAdded();
      }
    } catch (err) {
      setNote({ tone: 'error', lines: [engDncErrorText(err, ADD_NO_ANSWER)] });
      onAdded();
    } finally {
      setAdding(false);
    }
  };

  const domainMode = mode === 'domains';
  return (
    <EngCard>
      <EngEyebrow>{domainsEnabled ? 'Add to your list' : 'Add addresses'}</EngEyebrow>
      {domainsEnabled && (
        <div role="group" aria-label="What to add" className="mb-3 flex flex-wrap gap-2">
          {(
            [
              ['emails', 'Email addresses'],
              ['domains', 'Company domains'],
            ] as const
          ).map(([value, label]) => (
            <button
              key={value}
              type="button"
              aria-pressed={mode === value}
              onClick={() => switchMode(value)}
              disabled={adding}
              className={`${mode === value ? 'ds-btn-secondary' : 'ds-btn-ghost'} text-xs disabled:opacity-50`}
            >
              {label}
            </button>
          ))}
        </div>
      )}
      <form onSubmit={(e) => void onSubmit(e)} className="flex flex-col gap-2">
        <label className="flex flex-col gap-1">
          <span className="text-[11px] font-semibold" style={{ color: 'var(--cp-text-m)' }}>
            {domainMode ? 'Company domains' : 'Email addresses'}
          </span>
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            rows={5}
            placeholder={domainMode ? 'waystone.com\nfundbank.com' : 'jane@company.com\njohn@company.com'}
            className="ds-input w-full resize-y"
            spellCheck={false}
          />
        </label>
        <p className="text-[11px] m-0" style={{ color: 'var(--cp-text-l)' }}>
          {domainMode
            ? 'Paste company domains or website addresses, one per line or separated by commas. Each domain also ' +
              'covers its subdomains, so waystone.com covers eu.waystone.com and anyone@waystone.com. If you paste ' +
              "email addresses here, we use their domain. Personal email providers such as gmail.com or outlook.com " +
              "can't be added. Up to 1,000 at a time; your list holds up to 10,000 entries."
            : 'Paste one or more addresses: one per line, or separated by commas or spaces. Up to 1,000 at a time; ' +
              'the list holds up to 10,000 entries.'}
        </p>
        <div>
          <button
            type="submit"
            disabled={adding}
            className="ds-btn-primary inline-flex items-center gap-1.5 text-xs disabled:opacity-50"
          >
            {adding && <EngSpinner />}
            {adding ? 'Adding…' : domainMode ? 'Add domains' : 'Add to list'}
          </button>
        </div>
      </form>
      {note && <NoteLines note={note} />}
    </EngCard>
  );
}

function AddressRow({
  entry,
  onRemoved,
}: {
  entry: EngBlockedAddress;
  onRemoved: (entry: EngBlockedAddress, removed: number) => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const remove = async () => {
    if (removing) return;
    setRemoving(true);
    setError(null);
    try {
      const outcome = await removeEngBlockedAddress(entry.id);
      if (outcome.ok) {
        onRemoved(entry, outcome.removed);
      } else {
        setError(outcome.error ?? REMOVE_NO_ANSWER);
        setRemoving(false);
      }
    } catch (err) {
      setError(engDncErrorText(err, REMOVE_NO_ANSWER));
      setRemoving(false);
    }
  };

  const isDomain = engBlockedIsDomain(entry);
  const value = engBlockedValue(entry);
  return (
    <li className="py-2.5 border-b last:border-b-0" style={{ borderColor: 'var(--cp-divider)' }}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="ds-mono text-sm break-all" style={{ color: 'var(--cp-paper)' }}>
          {value}
        </span>
        {isDomain && (
          <span
            className="rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide"
            style={{ border: '1px solid var(--cp-divider)', color: 'var(--cp-text-m)' }}
          >
            Whole company
          </span>
        )}
        <span className="text-xs" style={{ color: 'var(--cp-paper-mute)' }}>
          Added {fmtDate(entry.created_at)}
        </span>
        <span className="ml-auto flex items-center gap-2">
          {confirming ? (
            <>
              <span className="text-xs" style={{ color: 'var(--cp-text-m)' }}>
                {isDomain
                  ? `Remove ${value}? This company can be collected and contacted again. ${DOMAIN_REMOVAL_CAVEAT}`
                  : 'Remove from your list?'}
              </span>
              <button
                type="button"
                onClick={() => void remove()}
                disabled={removing}
                className="ds-btn-secondary inline-flex items-center gap-1.5 text-[11px] disabled:opacity-50"
              >
                {removing && <EngSpinner />}
                {removing ? 'Removing…' : 'Remove'}
              </button>
              <button
                type="button"
                onClick={() => {
                  setConfirming(false);
                  setError(null);
                }}
                disabled={removing}
                className="ds-btn-ghost inline-flex items-center gap-1.5 text-[11px] disabled:opacity-50"
              >
                Keep
              </button>
            </>
          ) : (
            <button
              type="button"
              onClick={() => setConfirming(true)}
              className="ds-btn-ghost inline-flex items-center gap-1.5 text-[11px]"
            >
              Remove
            </button>
          )}
        </span>
      </div>
      {error && (
        <p className="mt-1 text-xs m-0" style={{ color: 'var(--cp-red)' }}>
          {error}
        </p>
      )}
    </li>
  );
}

export function EngDoNotContact() {
  const [list, setList] = useState<EngBlockedListPage | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [moreError, setMoreError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [query, setQuery] = useState('');
  const [removedNote, setRemovedNote] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const [checkError, setCheckError] = useState(false);
  const checkingRef = useRef(false);

  // Перечитать первую страницу: смена поиска или `reloads`. Состояние меняется
  // только по ответу, и ответ устаревшего запроса (поиск сменился) отбрасывается.
  const [reloads, setReloads] = useState(0);
  const queryRef = useRef(query);
  useEffect(() => {
    queryRef.current = query;
  }, [query]);
  useEffect(() => {
    let cancelled = false;
    fetchEngBlockedList({ q: query }).then(
      (page) => {
        if (cancelled) return;
        setList(page);
        setLoadError(null);
        setMoreError(null);
        setCheckError(false);
        setLoading(false);
      },
      (err: unknown) => {
        if (cancelled) return;
        setLoadError(engDncErrorText(err, LOAD_FAILED));
        setLoading(false);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [query, reloads]);

  const reload = useCallback(() => {
    setLoading(true);
    setReloads((n) => n + 1);
  }, []);

  // «Check again» сводки снятия: перечитывает только её (страницы, уже
  // дочитанные «Show more», остаются). Не прочиталась — карточка говорит «не
  // смогли проверить», а не показывает прежние числа как текущие.
  const checkAgain = useCallback(async () => {
    if (checkingRef.current) return;
    checkingRef.current = true;
    setChecking(true);
    try {
      const page = await fetchEngBlockedList({ q: queryRef.current });
      setList((prev) =>
        prev
          ? {
              ...prev,
              in_campaign_removal: page.in_campaign_removal,
              pending: page.pending,
              failed: page.failed,
              failed_examples: page.failed_examples,
              failed_at_least: page.failed_at_least,
            }
          : page,
      );
      setCheckError(false);
    } catch {
      setCheckError(true);
    } finally {
      checkingRef.current = false;
      setChecking(false);
    }
  }, []);

  const loadMore = async () => {
    if (!list || list.next_offset === null || loadingMore) return;
    setLoadingMore(true);
    setMoreError(null);
    const q = query;
    try {
      const page = await fetchEngBlockedList({ offset: list.next_offset, q });
      // Пока страница шла, клиент сменил поиск — она уже не про этот список.
      if (queryRef.current !== q) return;
      setList((prev) => {
        if (!prev) return page;
        const seen = new Set(prev.items.map((r) => r.id));
        return { ...page, items: [...prev.items, ...page.items.filter((r) => !seen.has(r.id))] };
      });
    } catch (err) {
      setMoreError(engDncErrorText(err, LOAD_FAILED));
    } finally {
      setLoadingMore(false);
    }
  };

  const onRemoved = (entry: EngBlockedAddress, removed: number) => {
    const isDomain = engBlockedIsDomain(entry);
    const value = engBlockedValue(entry);
    if (removed === 0) {
      // Строки уже нет (другая вкладка) — список перечитывается целиком.
      setRemovedNote(`${value} was already removed from your list.`);
      reload();
      return;
    }
    setRemovedNote(
      isDomain
        ? `Removed ${value}. From now on, this company can be included again when we collect companies and add ` +
            `contacts. ${DOMAIN_REMOVAL_CAVEAT}`
        : `Removed ${value}. From now on, it can be included again when we add contacts to your campaigns.` +
            (list?.in_campaign_removal === 'on'
              ? ' If we already took this person out of a campaign, they are not put back into it.'
              : ''),
    );
    // Свежие сверху: удалённая строка стояла до следующей страницы, поэтому
    // её граница сдвигается на одну строку вверх.
    setList((prev) =>
      prev
        ? {
            ...prev,
            items: prev.items.filter((r) => r.id !== entry.id),
            total: Math.max(0, prev.total - 1),
            domains_total:
              isDomain && prev.domains_total !== null ? Math.max(0, prev.domains_total - 1) : prev.domains_total,
            matching: Math.max(0, prev.matching - 1),
            next_offset: prev.next_offset === null ? null : Math.max(0, prev.next_offset - 1),
          }
        : prev,
    );
  };

  const onSearch = (e: React.FormEvent) => {
    e.preventDefault();
    setRemovedNote(null);
    const next = search.trim();
    if (next === query) {
      reload();
      return;
    }
    setLoading(true);
    setQuery(next);
  };

  const domainsEnabled = list?.domains_enabled === true;
  // Домены в списке есть или их можно добавить — тексты списка про «entries».
  const hasDomains = domainsEnabled || (list?.domains_total ?? 0) > 0 || (list?.items ?? []).some(engBlockedIsDomain);

  let content: React.ReactNode;
  if (loading && !list) {
    content = (
      <div className="flex items-center gap-2 text-sm" style={{ color: 'var(--cp-paper-mute)' }}>
        <EngSpinner /> Loading your list…
      </div>
    );
  } else if (!list) {
    content = (
      <div>
        <p className="text-sm m-0" style={{ color: 'var(--cp-red)' }}>{loadError ?? LOAD_FAILED}</p>
        <button
          type="button"
          onClick={reload}
          disabled={loading}
          className="ds-btn-ghost mt-3 disabled:opacity-50"
        >
          Try again
        </button>
      </div>
    );
  } else if (list.total === 0) {
    content = (
      <p className="text-sm m-0" style={{ color: 'var(--cp-paper-mute)' }}>
        Your list is empty.
      </p>
    );
  } else if (list.matching === 0) {
    content = (
      <p className="text-sm m-0 break-words" style={{ color: 'var(--cp-paper-mute)' }}>
        {hasDomains ? 'No entry' : 'No address'} on your list contains “{query}”.
      </p>
    );
  } else {
    content = (
      <>
        <ul className="m-0 p-0 list-none">
          {list.items.map((entry) => (
            <AddressRow key={entry.id} entry={entry} onRemoved={onRemoved} />
          ))}
        </ul>
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <span className="text-xs" style={{ color: 'var(--cp-paper-mute)' }}>
            Showing {fmtCount(list.items.length)} of {fmtCount(list.matching)}.
          </span>
          {list.next_offset !== null && (
            <button
              type="button"
              onClick={() => void loadMore()}
              disabled={loadingMore}
              className="ds-btn-ghost inline-flex items-center gap-1.5 disabled:opacity-50"
            >
              {loadingMore ? 'Loading…' : 'Show more'}
            </button>
          )}
        </div>
        {moreError && (
          <p className="mt-2 text-sm m-0" style={{ color: 'var(--cp-red)' }}>{moreError}</p>
        )}
      </>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <header className="mb-2 sm:mb-4">
        <h1 className="text-xl sm:text-2xl font-bold m-0" style={{ color: 'var(--cp-paper)' }}>
          Do not contact
        </h1>
        <p className="mt-1 text-sm m-0" style={{ color: 'var(--cp-paper-mute)' }}>
          {domainsEnabled
            ? 'Your do-not-contact list. Block single people by email address, or whole companies by domain. We check ' +
              'it before we collect companies for your markets and before we add contacts to your campaigns.'
            : 'Your blocked-contacts list. We check it before we add new contacts to your campaigns and leave these ' +
              'addresses out.'}
        </p>
      </header>

      {list && list.total > BLOCKLIST_MAX_ENTRIES && <OverLimitNotice total={list.total} />}

      {list && list.in_campaign_removal === 'on' && (
        <RemovalProgress
          pending={list.pending}
          failed={list.failed}
          failedExamples={list.failed_examples}
          failedAtLeast={list.failed_at_least}
          checking={checking || loading}
          checkError={checkError}
          onCheckAgain={() => void checkAgain()}
        />
      )}

      <HowItWorks mode={list ? list.in_campaign_removal : null} domainsEnabled={domainsEnabled} />

      <AddAddresses onAdded={reload} domainsEnabled={domainsEnabled} />

      <EngCard>
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <EngEyebrow>On your list</EngEyebrow>
          {list && list.total > 0 && (
            <span className="text-xs" style={{ color: 'var(--cp-paper-mute)' }}>
              {/* Счёт доменов не прочитан (null) — только общее число. */}
              {hasDomains
                ? list.domains_total === null
                  ? entries(list.total)
                  : `${entries(list.total)} · ${domains(list.domains_total)}`
                : addresses(list.total)}
            </span>
          )}
          {loading && list && <EngSpinner />}
        </div>
        {list && list.total > 0 && (
          <form onSubmit={onSearch} className="mb-3 flex flex-wrap items-center gap-2">
            <input
              type="search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={hasDomains ? 'Search addresses and domains' : 'Search addresses'}
              className="ds-input text-xs flex-1 min-w-[12rem]"
              spellCheck={false}
            />
            <button type="submit" className="ds-btn-secondary inline-flex items-center gap-1.5 text-xs">
              Search
            </button>
            {query && (
              <button
                type="button"
                onClick={() => {
                  setSearch('');
                  setLoading(true);
                  setQuery('');
                }}
                className="ds-btn-ghost inline-flex items-center gap-1.5 text-xs"
              >
                Clear search
              </button>
            )}
          </form>
        )}
        {removedNote && (
          <p className="mb-3 text-sm m-0 break-words" style={{ color: 'var(--cp-paper)' }}>{removedNote}</p>
        )}
        {list && loadError && (
          <p className="mb-3 text-sm m-0" style={{ color: 'var(--cp-red)' }}>{loadError}</p>
        )}
        {content}
      </EngCard>
    </div>
  );
}
