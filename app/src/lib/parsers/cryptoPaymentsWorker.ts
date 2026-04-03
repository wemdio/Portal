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

async function fetchHtml(url: string): Promise<{ ok: true; html: string } | { ok: false }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
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

async function detectCryptoOnSite(websiteRaw: string): Promise<string[]> {
  const homeUrl = normalizeUrl(websiteRaw);
  if (!homeUrl) return [];

  const root = new URL(homeUrl);
  const allProviders = new Set<string>();

  for (const pathname of KEY_PATHS) {
    const url = new URL(root.toString());
    url.pathname = pathname;
    url.search = '';
    url.hash = '';
    const pageUrl = url.toString().replace(/\/+$/, '');

    const response = await fetchHtml(pageUrl);
    if (!response.ok) continue;

    const providers = detectProviders(response.html);
    for (const p of providers) allProviders.add(p);

    if (allProviders.size > 0) break;
  }

  return Array.from(allProviders);
}

async function scanBatch(items: ScanItem[]): Promise<MatchRow[]> {
  const results = await Promise.allSettled(
    items.map((item) =>
      Promise.race([
        detectCryptoOnSite(item.website).then((providers) => {
          if (providers.length === 0) return null;
          return {
            companyName: item.companyName,
            website: normalizeUrl(item.website) ?? item.website,
            paymentSystem: providers.join(', '),
          };
        }),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), SITE_TIMEOUT_MS)),
      ])
    )
  );

  return results
    .map((r) => (r.status === 'fulfilled' ? r.value : null))
    .filter((v): v is MatchRow => v !== null);
}

/**
 * Run a crypto payment scan job. Resumes from checked_count if job was interrupted.
 */
export async function runCryptoPaymentJob(jobId: string, db?: SupabaseClient): Promise<void> {
  const { supabaseAdmin } = await import('@/lib/supabaseAdmin');
  const client = db ?? supabaseAdmin!;

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

  // Mark as running
  await client
    .from('crypto_payment_jobs')
    .update({ status: 'running', updated_at: new Date().toISOString() })
    .eq('id', jobId);

  const allItems: ScanItem[] = job.items as ScanItem[];
  const totalCount = job.total_count as number;
  let checkedCount = job.checked_count as number;
  const existingMatches: MatchRow[] = (job.matches as MatchRow[]) ?? [];
  const matches: MatchRow[] = [...existingMatches];

  // Resume: skip already checked items
  const remaining = allItems.slice(checkedCount);

  console.log(`[crypto-payments] Starting job ${jobId}: total=${totalCount}, checked=${checkedCount}, remaining=${remaining.length}`);

  try {
    const chunks: ScanItem[][] = [];
    for (let i = 0; i < remaining.length; i += BATCH_SIZE) {
      chunks.push(remaining.slice(i, i + BATCH_SIZE));
    }

    let itemsSinceLastPersist = 0;

    for (const chunk of chunks) {
      // Check if job was stopped by user
      const { data: fresh } = await client
        .from('crypto_payment_jobs')
        .select('status')
        .eq('id', jobId)
        .single();

      if (fresh?.status === 'stopped') {
        console.log(`[crypto-payments] Job ${jobId} stopped by user`);
        return;
      }

      const batchMatches = await scanBatch(chunk);
      matches.push(...batchMatches);
      checkedCount += chunk.length;
      itemsSinceLastPersist += chunk.length;

      // Persist progress periodically
      if (itemsSinceLastPersist >= PERSIST_INTERVAL) {
        await client
          .from('crypto_payment_jobs')
          .update({
            checked_count: checkedCount,
            matches: matches as unknown as Record<string, unknown>[],
            updated_at: new Date().toISOString(),
          })
          .eq('id', jobId);
        itemsSinceLastPersist = 0;
      }
    }

    // Final persist
    await client
      .from('crypto_payment_jobs')
      .update({
        status: 'completed',
        checked_count: checkedCount,
        matches: matches as unknown as Record<string, unknown>[],
        updated_at: new Date().toISOString(),
      })
      .eq('id', jobId);

    console.log(`[crypto-payments] Job ${jobId} completed: checked=${checkedCount}, matches=${matches.length}`);
  } catch (err) {
    const raw = err instanceof Error ? err.message : String(err);
    const msg = /^\s*</.test(raw) ? 'Internal error (HTML response)' : raw.slice(0, 500);
    console.error(`[crypto-payments] Job ${jobId} failed:`, raw);

    await client
      .from('crypto_payment_jobs')
      .update({
        status: 'error',
        checked_count: checkedCount,
        matches: matches as unknown as Record<string, unknown>[],
        error_message: msg,
        updated_at: new Date().toISOString(),
      })
      .eq('id', jobId);
  }
}
