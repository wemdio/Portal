import type { SupabaseClient } from '@supabase/supabase-js';

type ScanItem = { companyName: string; website: string };
type MatchRow = { companyName: string; website: string; paymentSystem: string };

// Re-export scan logic inline to avoid circular deps with the route handler
const REQUEST_TIMEOUT_MS = 8000;
const SITE_TIMEOUT_MS = 60_000;
const MAX_HTML_BYTES = 1_200_000;
const KEY_PATHS = ['/', '/payment', '/payments', '/checkout', '/pay', '/pricing', '/buy'];
const BATCH_SIZE = 10;
const PERSIST_INTERVAL = 10; // save to DB every N items

type ProviderSignature = { name: string; hostPatterns: string[]; textPatterns: string[] };

const PROVIDERS: ProviderSignature[] = [
  { name: 'Coinbase Commerce', hostPatterns: ['commerce.coinbase.com', 'coinbase.com/commerce'], textPatterns: ['coinbase commerce', 'commerce.coinbase.com'] },
  { name: 'BitPay', hostPatterns: ['bitpay.com'], textPatterns: ['bitpay'] },
  { name: 'CoinGate', hostPatterns: ['coingate.com'], textPatterns: ['coingate'] },
  { name: 'CoinPayments', hostPatterns: ['coinpayments.net'], textPatterns: ['coinpayments'] },
  { name: 'NOWPayments', hostPatterns: ['nowpayments.io'], textPatterns: ['nowpayments'] },
  { name: 'Cryptomus', hostPatterns: ['cryptomus.com'], textPatterns: ['cryptomus'] },
  { name: 'Binance Pay', hostPatterns: ['pay.binance.com'], textPatterns: ['binance pay'] },
  { name: 'Bybit Pay', hostPatterns: ['bybit.com/pay'], textPatterns: ['bybit pay'] },
  { name: 'Plisio', hostPatterns: ['plisio.net'], textPatterns: ['plisio'] },
  { name: 'CoinRemitter', hostPatterns: ['coinremitter.com'], textPatterns: ['coinremitter'] },
  { name: 'BTCPay Server', hostPatterns: ['btcpayserver.org'], textPatterns: ['btcpay server', 'btcpayserver'] },
  { name: 'GoCrypto', hostPatterns: ['gocrypto.com'], textPatterns: ['gocrypto'] },
  { name: 'TripleA', hostPatterns: ['triple-a.io'], textPatterns: ['triple-a.io', 'triplea'] },
  { name: 'Blockonomics', hostPatterns: ['blockonomics.co'], textPatterns: ['blockonomics'] },
  { name: 'OpenNode', hostPatterns: ['opennode.com'], textPatterns: ['opennode'] },
  { name: 'SpicePay', hostPatterns: ['spicepay.com'], textPatterns: ['spicepay'] },
  { name: 'Paybis', hostPatterns: ['paybis.com'], textPatterns: ['paybis'] },
  { name: 'Coinify', hostPatterns: ['coinify.com'], textPatterns: ['coinify'] },
  { name: 'PayKickstart', hostPatterns: ['paykickstart.com'], textPatterns: ['paykickstart'] },
  { name: 'Confirmo', hostPatterns: ['confirmo.net'], textPatterns: ['confirmo.net', 'confirmo'] },
  { name: 'Whitepay', hostPatterns: ['whitepay.com'], textPatterns: ['whitepay'] },
  { name: 'AlfaCoins', hostPatterns: ['alfacoins.com'], textPatterns: ['alfacoins'] },
  { name: 'PayCEC', hostPatterns: ['paycec.com'], textPatterns: ['paycec'] },
  { name: 'B2BinPay', hostPatterns: ['b2binpay.com'], textPatterns: ['b2binpay'] },
  { name: 'Utrust', hostPatterns: ['utrust.com'], textPatterns: ['utrust'] },
  { name: 'MixPay', hostPatterns: ['mixpay.me'], textPatterns: ['mixpay'] },
  { name: 'Crypto.com Pay', hostPatterns: ['pay.crypto.com'], textPatterns: ['crypto.com pay'] },
  { name: 'WalletConnect', hostPatterns: ['walletconnect.com', 'walletconnect.org'], textPatterns: ['walletconnect', 'wallet_connect', 'wallet-connect'] },
  { name: 'MetaMask', hostPatterns: ['metamask.io'], textPatterns: ['metamask'] },
  { name: 'Web3Modal', hostPatterns: ['web3modal.com'], textPatterns: ['web3modal', 'w3m-'] },
  { name: 'RainbowKit', hostPatterns: ['rainbowkit.com'], textPatterns: ['rainbowkit', 'rainbow-me'] },
  { name: 'ConnectKit', hostPatterns: [], textPatterns: ['connectkit'] },
  { name: 'Phantom', hostPatterns: ['phantom.app'], textPatterns: ['phantom'] },
  { name: 'TON Connect', hostPatterns: ['ton-connect.github.io', 'tonconnect'], textPatterns: ['tonconnect', 'ton-connect'] },
  { name: 'Solana Pay', hostPatterns: ['solanapay.com'], textPatterns: ['solana-pay', 'solanapay', 'solana pay'] },
  { name: 'Request Network', hostPatterns: ['request.network'], textPatterns: ['request network', 'request.network'] },
  { name: 'Transak', hostPatterns: ['transak.com'], textPatterns: ['transak'] },
  { name: 'MoonPay', hostPatterns: ['moonpay.com'], textPatterns: ['moonpay'] },
  { name: 'Wert', hostPatterns: ['wert.io', 'widget.wert.io'], textPatterns: ['wert.io'] },
  { name: 'Ramp Network', hostPatterns: ['ramp.network'], textPatterns: ['ramp.network', 'ramp network'] },
  { name: 'Crossmint', hostPatterns: ['crossmint.com'], textPatterns: ['crossmint'] },
  { name: 'Sequence', hostPatterns: ['sequence.xyz'], textPatterns: ['sequence.xyz'] },
  { name: 'Thirdweb Pay', hostPatterns: ['thirdweb.com'], textPatterns: ['thirdweb'] },
  { name: 'Circle (USDC)', hostPatterns: ['circle.com'], textPatterns: ['circle.com/pay', 'circle payments'] },
  { name: 'Stripe Crypto', hostPatterns: [], textPatterns: ['stripe crypto onramp', 'stripe.crypto'] },
];

const WEB3_CODE_PATTERNS = [
  { pattern: 'window.ethereum', name: 'Web3 (window.ethereum)' },
  { pattern: 'ethers.js', name: 'Ethers.js' },
  { pattern: 'from "ethers"', name: 'Ethers.js' },
  { pattern: "from 'ethers'", name: 'Ethers.js' },
  { pattern: '@ethersproject', name: 'Ethers.js' },
  { pattern: 'web3.js', name: 'Web3.js' },
  { pattern: 'new web3(', name: 'Web3.js' },
  { pattern: 'from "web3"', name: 'Web3.js' },
  { pattern: "from 'web3'", name: 'Web3.js' },
  { pattern: 'wagmi', name: 'Wagmi' },
  { pattern: '@web3-react', name: 'Web3-React' },
  { pattern: 'usepreparecontractwrite', name: 'Wagmi' },
  { pattern: 'usecontractwrite', name: 'Wagmi' },
  { pattern: 'viem', name: 'Viem' },
  { pattern: '@solana/web3', name: 'Solana Web3' },
  { pattern: 'solana-wallets', name: 'Solana Wallets' },
  { pattern: '@tonconnect', name: 'TON Connect' },
  { pattern: 'connect wallet', name: 'Connect Wallet' },
  { pattern: 'connect your wallet', name: 'Connect Wallet' },
  { pattern: 'подключить кошелёк', name: 'Connect Wallet' },
  { pattern: 'подключить кошелек', name: 'Connect Wallet' },
];

function normalizeUrl(raw: string): string | null {
  const value = String(raw ?? '').trim();
  if (!value || /\s/.test(value)) return null;
  const prefixed = /^https?:\/\//i.test(value) ? value : `https://${value}`;
  try {
    const url = new URL(prefixed);
    if (!url.hostname || !url.hostname.includes('.')) return null;
    url.hash = '';
    return url.toString().replace(/\/+$/, '');
  } catch {
    return null;
  }
}

async function fetchHtml(
  url: string,
  /** Сигнал остановки задачи: рвёт запрос, не дожидаясь своего таймаута. */
  external?: AbortSignal | null,
): Promise<{ ok: true; html: string } | { ok: false }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  // Внешний сигнал транслируем в свой контроллер, а не подменяем им: у запроса
  // остаётся собственный таймаут, а слушателя снимаем в finally — иначе на
  // одном сигнале за большую задачу копятся тысячи подписок.
  const relay = () => controller.abort();
  if (external?.aborted) controller.abort();
  else external?.addEventListener('abort', relay, { once: true });
  try {
    const res = await fetch(url, {
      method: 'GET',
      signal: controller.signal,
      redirect: 'follow',
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; CryptoPaymentProbe/1.0)',
        Accept: 'text/html,application/xhtml+xml',
      },
      cache: 'no-store',
    });
    if (!res.ok) return { ok: false };
    const contentType = res.headers.get('content-type') || '';
    if (!contentType.includes('text/html')) return { ok: false };
    const html = (await res.text()).slice(0, MAX_HTML_BYTES);
    return { ok: true, html };
  } catch {
    return { ok: false };
  } finally {
    clearTimeout(timer);
    external?.removeEventListener('abort', relay);
  }
}

function detectProviders(html: string): string[] {
  // Lightweight detection without cheerio (avoid heavy dependency in worker)
  const lowerHtml = html.toLowerCase();
  const found = new Set<string>();

  // Extract src/href attributes
  const attrRegex = /(?:src|href)\s*=\s*["']([^"']+)["']/gi;
  const allAttrs: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = attrRegex.exec(html)) !== null) {
    allAttrs.push(match[1].toLowerCase());
  }

  for (const provider of PROVIDERS) {
    for (const pattern of provider.hostPatterns) {
      if (allAttrs.some((attr) => attr.includes(pattern))) {
        found.add(provider.name);
        break;
      }
    }
    if (found.has(provider.name)) continue;
    for (const pattern of provider.textPatterns) {
      if (lowerHtml.includes(pattern)) {
        found.add(provider.name);
        break;
      }
    }
  }

  for (const { pattern, name } of WEB3_CODE_PATTERNS) {
    if (lowerHtml.includes(pattern)) {
      found.add(name);
    }
  }

  return Array.from(found);
}

async function detectCryptoOnSite(
  websiteRaw: string,
  signal?: AbortSignal | null,
): Promise<string[]> {
  const homeUrl = normalizeUrl(websiteRaw);
  if (!homeUrl) return [];

  const root = new URL(homeUrl);
  const allProviders = new Set<string>();

  for (const pathname of KEY_PATHS) {
    if (signal?.aborted) break;
    const url = new URL(root.toString());
    url.pathname = pathname;
    url.search = '';
    url.hash = '';
    const pageUrl = url.toString().replace(/\/+$/, '');

    const response = await fetchHtml(pageUrl, signal);
    if (!response.ok) continue;

    const providers = detectProviders(response.html);
    for (const p of providers) allProviders.add(p);

    if (allProviders.size > 0) break;
  }

  return Array.from(allProviders);
}

/**
 * Потолок на один сайт. Таймер снимаем, когда обход закончился раньше: иначе
 * десять висящих setTimeout на пачку держали бы event loop до минуты после
 * остановки воркера — и бюджет docker stop уходил бы в ожидание пустоты.
 */
function withDeadline<T>(promise: Promise<T>, ms: number, onTimeout: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const guard = new Promise<T>((resolve) => { timer = setTimeout(() => resolve(onTimeout), ms); });
  return Promise.race([promise, guard]).finally(() => { if (timer) clearTimeout(timer); });
}

async function scanBatch(items: ScanItem[], signal?: AbortSignal | null): Promise<MatchRow[]> {
  const results = await Promise.allSettled(
    items.map((item) =>
      withDeadline<MatchRow | null>(
        detectCryptoOnSite(item.website, signal).then((providers) => {
          if (providers.length === 0) return null;
          return {
            companyName: item.companyName,
            website: normalizeUrl(item.website) ?? item.website,
            paymentSystem: providers.join(', '),
          };
        }),
        SITE_TIMEOUT_MS,
        null,
      )
    )
  );

  return results
    .map((r) => (r.status === 'fulfilled' ? r.value : null))
    .filter((v): v is MatchRow => v !== null);
}

/** Чекпойнт единого жизненного цикла: сколько позиций уже проверено. */
export type CryptoPaymentCheckpoint = { checked: number };

/**
 * Контекст запуска из единого жизненного цикла задач (lib/jobs/lifecycle.ts).
 *
 * Необязателен: без него тело ведёт себя ровно как до перевода — пишет в строку
 * без ограждения и не умеет узнать об остановке. Сегодня единственный вызов —
 * из worker/enrich.ts, и он контекст передаёт.
 */
export interface CryptoPaymentRunContext {
  /** Взводится на SIGTERM воркера, при потере аренды и при остановке задачи пользователем. */
  signal: AbortSignal;
  /**
   * Жетон текущего захвата. Им ограждаются ВСЕ записи в строку задачи: при
   * manageTerminalStatus=false терминальный статус пишет само тело, и без
   * жетона старый исполнитель после перехвата проштамповал бы completed/error
   * поверх работы нового владельца.
   */
  runToken: string;
  /** false — задачу перехватили: прекратить работу без терминальной записи. */
  saveCheckpoint(data: CryptoPaymentCheckpoint): Promise<boolean>;
}

/**
 * Run a crypto payment scan job. Resumes from checked_count if job was interrupted.
 */
export async function runCryptoPaymentJob(
  jobId: string,
  ctx?: CryptoPaymentRunContext,
  db?: SupabaseClient,
): Promise<void> {
  const { supabaseAdmin } = await import('@/lib/supabaseAdmin');
  const client = db ?? supabaseAdmin!;
  const runToken = ctx?.runToken ?? null;
  const signal = ctx?.signal ?? null;
  /**
   * Работа прервана извне: остановка воркера, потеря аренды или остановка
   * задачи пользователем (кнопка «Стоп» пишет status='stopped', продление
   * аренды его не проходит — фильтр status=running — и библиотека взводит
   * сигнал). Решаем ТОЛЬКО по сигналу и никогда по имени/тексту ошибки:
   * прерванный fetch бросает AbortError, но так же назвалась бы и любая чужая
   * отмена внутри сети.
   */
  const interrupted = () => signal?.aborted === true;

  /**
   * Единственный путь записи в строку задачи.
   *
   * Ограждение двойное. Жетон — обязательное: строку мог перехватить сосед, и
   * тогда она уже не наша. Статус — подстраховка: остановка пользователем,
   * вытеснение новой загрузкой и повтор через resume снимают жетон сами
   * (маршруты api/parsers/crypto-payments/**), но если хоть один писатель это
   * когда-нибудь забудет, фильтр status=running всё равно не даст работающему
   * телу дописать что-либо в уже закрытую строку — вплоть до 'completed'
   * поверх остановленной задачи.
   *
   * Без жетона (вызов без контекста) фильтров нет вовсе — поведение ровно как
   * до перевода на единый жизненный цикл.
   *
   * tries > 1 — только для терминальной записи: один моргнувший запрос иначе
   * оставил бы законченную задачу в running, и она стоила бы простоя, попытки
   * и повторного обхода последней пачки. Прогресс так защищать незачем — его
   * перепишет следующая пачка. Та же логика, что у TERMINAL_WRITE_TRIES в
   * lib/jobs/lifecycle.ts.
   */
  const updateJob = async (patch: Record<string, unknown>, tries = 1): Promise<void> => {
    for (let attempt = 0; attempt < tries; attempt += 1) {
      if (attempt > 0) await new Promise((r) => { setTimeout(r, 500 * attempt); });
      const base = client.from('crypto_payment_jobs').update(patch).eq('id', jobId);
      const { error } = await (
        runToken ? base.eq('run_token', runToken).eq('status', 'running') : base
      );
      if (!error) return;
      console.warn(`[crypto-payments] update of ${jobId} failed:`, error.message);
    }
  };
  const TERMINAL_WRITE_TRIES = 3;
  /** Терминальная запись снимает и владение — иначе оно остаётся на строке навсегда. */
  const CLEAR_OWNERSHIP = { lease_until: null, run_token: null, worker_id: null };

  /**
   * Объявлены ДО try, потому что их читает catch. Всё остальное — загрузка
   * строки, пульс, нарезка — переехало ВНУТРЬ try намеренно: исключение оттуда
   * улетело бы в библиотеку, а она при manageTerminalStatus=false отпускает
   * аренду обнулением lease_until — то есть ровно так же, как выглядит чистая
   * передача при остановке. Перехват такую строку попыткой не считает, и
   * задача переклеймивалась бы вечно без единой записи о падении. Сегодня
   * бросить там нечему (supabase-js возвращает ошибку, а не бросает), но цена
   * ошибки слишком велика, чтобы держать это на честном слове.
   */
  let totalCount = 0;
  let checkedCount = 0;
  const matches: MatchRow[] = [];

  try {
    // Load job
    const { data: job, error: loadErr } = await client
      .from('crypto_payment_jobs')
      .select('*')
      .eq('id', jobId)
      .single();

    if (loadErr || !job) {
      console.error('[crypto-payments] Job not found', jobId, loadErr?.message);
      return;
    }

    /**
     * Первый удар пульса. Монитор здоровья считает простой ЭТОЙ очереди по
     * updated_at (services/health-check/main.py, спецификация crypto_payment_jobs,
     * updated_column='updated_at'), а штампует эту колонку само тело: триггера на
     * таблице нет (миграция 20260402_0001 создаёт её без единого триггера).
     * Поэтому захват и продление аренды updated_at не трогают вовсе — иначе
     * перехват зависшей задачи каждые ~3,5 минуты обновлял бы отметку и тревога
     * «Долго висит» не наступила бы никогда. Здесь же отметка нужна: строка могла
     * пролежать в pending часами, и без неё монитор счёл бы только что взятую
     * задачу зависшей в ту же секунду.
     *
     * Цена размена названа честно: КАЖДЫЙ перехват зависшей задачи начинается с
     * этой отметки, то есть заводит часы монитора заново. Бесконечно это длиться
     * не может — перехваты считаются попытками, и на третьей строка уходит в
     * 'error', о чём монитор сообщит уже по другому признаку. Обратный размен
     * (не ставить отметку) хуже: тревога приходила бы на каждую здоровую задачу,
     * подобранную из давно лежавшего pending.
     *
     * status здесь больше НЕ пишем: в running строку перевёл захват. Прежняя
     * безусловная запись status='running' воскресила бы задачу, остановленную
     * пользователем в окне между захватом и стартом тела.
     */
    await updateJob({ updated_at: new Date().toISOString() });

    const allItems: ScanItem[] = job.items as ScanItem[];
    totalCount = job.total_count as number;
    checkedCount = job.checked_count as number;
    matches.push(...((job.matches as MatchRow[]) ?? []));

    // Resume: skip already checked items
    const remaining = allItems.slice(checkedCount);

    console.log(`[crypto-payments] Starting job ${jobId}: total=${totalCount}, checked=${checkedCount}, remaining=${remaining.length}`);

    const chunks: ScanItem[][] = [];
    for (let i = 0; i < remaining.length; i += BATCH_SIZE) {
      chunks.push(remaining.slice(i, i + BATCH_SIZE));
    }

    let itemsSinceLastPersist = 0;

    for (const chunk of chunks) {
      // Прежде здесь шёл самоопрос строки на предмет status='stopped'. Теперь
      // об остановке (пользователем, деплоем, потерей аренды) говорит сигнал:
      // выходим БЕЗ терминальной записи — строку либо уже закрыл пользователь,
      // либо её подберёт соседняя реплика и продолжит с checked_count.
      if (interrupted()) {
        console.log(`[crypto-payments] Job ${jobId} interrupted at ${checkedCount}/${totalCount}`);
        return;
      }

      const batchMatches = await scanBatch(chunk, signal);
      // Прерванную пачку не засчитываем: сигнал рвёт запросы на полпути, и
      // часть сайтов осталась бы «проверенной» вообще без обхода.
      if (interrupted()) {
        console.log(`[crypto-payments] Job ${jobId} interrupted at ${checkedCount}/${totalCount}`);
        return;
      }
      matches.push(...batchMatches);
      checkedCount += chunk.length;
      itemsSinceLastPersist += chunk.length;

      // Persist progress periodically
      if (itemsSinceLastPersist >= PERSIST_INTERVAL) {
        await updateJob({
          checked_count: checkedCount,
          matches: matches as unknown as Record<string, unknown>[],
          updated_at: new Date().toISOString(),
        });
        itemsSinceLastPersist = 0;
        /**
         * Чекпойнт не хранилище: настоящее возобновление и так идёт из колонки
         * checked_count, которую мы только что записали. Он нужен ради двух
         * побочных эффектов библиотеки — продлить аренду в момент реального
         * прогресса и обнулить бюджет попыток, — и ради третьего ответа:
         * false означает, что строку перехватили, и работать дальше нельзя.
         */
        if (ctx && !(await ctx.saveCheckpoint({ checked: checkedCount }))) return;
      }
    }

    if (interrupted()) {
      console.log(`[crypto-payments] Job ${jobId} interrupted at ${checkedCount}/${totalCount}`);
      return;
    }

    // Final persist
    await updateJob({
      status: 'completed',
      checked_count: checkedCount,
      matches: matches as unknown as Record<string, unknown>[],
      updated_at: new Date().toISOString(),
      ...CLEAR_OWNERSHIP,
    }, TERMINAL_WRITE_TRIES);

    console.log(`[crypto-payments] Job ${jobId} completed: checked=${checkedCount}, matches=${matches.length}`);
  } catch (err) {
    // Прерывание — не итог задачи: строка остаётся в работе с записанным
    // прогрессом, аренду отпустит библиотека, продолжит сосед. Решаем по
    // сигналу, а не по имени ошибки.
    if (interrupted()) {
      console.log(`[crypto-payments] Job ${jobId} interrupted at ${checkedCount}/${totalCount}`);
      return;
    }
    const raw = err instanceof Error ? err.message : String(err);
    const msg = /^\s*</.test(raw) ? 'Internal error (HTML response)' : raw.slice(0, 500);
    console.error(`[crypto-payments] Job ${jobId} failed:`, raw);

    await updateJob({
      status: 'error',
      checked_count: checkedCount,
      matches: matches as unknown as Record<string, unknown>[],
      error_message: msg,
      updated_at: new Date().toISOString(),
      ...CLEAR_OWNERSHIP,
    }, TERMINAL_WRITE_TRIES);
  }
}
