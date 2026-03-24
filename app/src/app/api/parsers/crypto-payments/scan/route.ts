import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { load } from 'cheerio';
import { createAuthedSupabaseClient, getBearerToken } from '@/lib/supabaseRouteClient';

export const dynamic = 'force-dynamic';

const REQUEST_TIMEOUT_MS = 8000;
const SITE_TIMEOUT_MS = 60_000;
const MAX_HTML_BYTES = 1_200_000;
const KEY_PATHS = ['/', '/payment', '/payments', '/checkout', '/pay', '/pricing', '/buy'];

type ProviderSignature = {
  name: string;
  hostPatterns: string[];
  textPatterns: string[];
};

const PROVIDERS: ProviderSignature[] = [
  {
    name: 'Coinbase Commerce',
    hostPatterns: ['commerce.coinbase.com', 'coinbase.com/commerce'],
    textPatterns: ['coinbase commerce', 'commerce.coinbase.com'],
  },
  {
    name: 'BitPay',
    hostPatterns: ['bitpay.com'],
    textPatterns: ['bitpay'],
  },
  {
    name: 'CoinGate',
    hostPatterns: ['coingate.com'],
    textPatterns: ['coingate'],
  },
  {
    name: 'CoinPayments',
    hostPatterns: ['coinpayments.net'],
    textPatterns: ['coinpayments'],
  },
  {
    name: 'NOWPayments',
    hostPatterns: ['nowpayments.io'],
    textPatterns: ['nowpayments'],
  },
  {
    name: 'Cryptomus',
    hostPatterns: ['cryptomus.com'],
    textPatterns: ['cryptomus'],
  },
  {
    name: 'Binance Pay',
    hostPatterns: ['pay.binance.com'],
    textPatterns: ['binance pay'],
  },
  {
    name: 'Bybit Pay',
    hostPatterns: ['bybit.com/pay'],
    textPatterns: ['bybit pay'],
  },
  {
    name: 'Plisio',
    hostPatterns: ['plisio.net'],
    textPatterns: ['plisio'],
  },
  {
    name: 'CoinRemitter',
    hostPatterns: ['coinremitter.com'],
    textPatterns: ['coinremitter'],
  },
  {
    name: 'BTCPay Server',
    hostPatterns: ['btcpayserver.org'],
    textPatterns: ['btcpay server', 'btcpayserver'],
  },
  {
    name: 'GoCrypto',
    hostPatterns: ['gocrypto.com'],
    textPatterns: ['gocrypto'],
  },
  {
    name: 'TripleA',
    hostPatterns: ['triple-a.io'],
    textPatterns: ['triple-a.io', 'triplea'],
  },
  {
    name: 'Blockonomics',
    hostPatterns: ['blockonomics.co'],
    textPatterns: ['blockonomics'],
  },
  {
    name: 'OpenNode',
    hostPatterns: ['opennode.com'],
    textPatterns: ['opennode'],
  },
  {
    name: 'SpicePay',
    hostPatterns: ['spicepay.com'],
    textPatterns: ['spicepay'],
  },
  {
    name: 'Paybis',
    hostPatterns: ['paybis.com'],
    textPatterns: ['paybis'],
  },
  {
    name: 'Coinify',
    hostPatterns: ['coinify.com'],
    textPatterns: ['coinify'],
  },
  {
    name: 'PayKickstart',
    hostPatterns: ['paykickstart.com'],
    textPatterns: ['paykickstart'],
  },
  {
    name: 'Confirmo',
    hostPatterns: ['confirmo.net'],
    textPatterns: ['confirmo.net', 'confirmo'],
  },
  {
    name: 'Whitepay',
    hostPatterns: ['whitepay.com'],
    textPatterns: ['whitepay'],
  },
  {
    name: 'AlfaCoins',
    hostPatterns: ['alfacoins.com'],
    textPatterns: ['alfacoins'],
  },
  {
    name: 'PayCEC',
    hostPatterns: ['paycec.com'],
    textPatterns: ['paycec'],
  },
  {
    name: 'B2BinPay',
    hostPatterns: ['b2binpay.com'],
    textPatterns: ['b2binpay'],
  },
  {
    name: 'Utrust',
    hostPatterns: ['utrust.com'],
    textPatterns: ['utrust'],
  },
  {
    name: 'MixPay',
    hostPatterns: ['mixpay.me'],
    textPatterns: ['mixpay'],
  },
  {
    name: 'Crypto.com Pay',
    hostPatterns: ['pay.crypto.com'],
    textPatterns: ['crypto.com pay'],
  },
  // --- Web3-native payment infra ---
  {
    name: 'WalletConnect',
    hostPatterns: ['walletconnect.com', 'walletconnect.org'],
    textPatterns: ['walletconnect', 'wallet_connect', 'wallet-connect'],
  },
  {
    name: 'MetaMask',
    hostPatterns: ['metamask.io'],
    textPatterns: ['metamask'],
  },
  {
    name: 'Web3Modal',
    hostPatterns: ['web3modal.com'],
    textPatterns: ['web3modal', 'w3m-'],
  },
  {
    name: 'RainbowKit',
    hostPatterns: ['rainbowkit.com'],
    textPatterns: ['rainbowkit', 'rainbow-me'],
  },
  {
    name: 'ConnectKit',
    hostPatterns: [],
    textPatterns: ['connectkit'],
  },
  {
    name: 'Phantom',
    hostPatterns: ['phantom.app'],
    textPatterns: ['phantom'],
  },
  {
    name: 'TON Connect',
    hostPatterns: ['ton-connect.github.io', 'tonconnect'],
    textPatterns: ['tonconnect', 'ton-connect'],
  },
  {
    name: 'Solana Pay',
    hostPatterns: ['solanapay.com'],
    textPatterns: ['solana-pay', 'solanapay', 'solana pay'],
  },
  {
    name: 'Request Network',
    hostPatterns: ['request.network'],
    textPatterns: ['request network', 'request.network'],
  },
  {
    name: 'Transak',
    hostPatterns: ['transak.com'],
    textPatterns: ['transak'],
  },
  {
    name: 'MoonPay',
    hostPatterns: ['moonpay.com'],
    textPatterns: ['moonpay'],
  },
  {
    name: 'Wert',
    hostPatterns: ['wert.io', 'widget.wert.io'],
    textPatterns: ['wert.io'],
  },
  {
    name: 'Ramp Network',
    hostPatterns: ['ramp.network'],
    textPatterns: ['ramp.network', 'ramp network'],
  },
  {
    name: 'Crossmint',
    hostPatterns: ['crossmint.com'],
    textPatterns: ['crossmint'],
  },
  {
    name: 'Sequence',
    hostPatterns: ['sequence.xyz'],
    textPatterns: ['sequence.xyz'],
  },
  {
    name: 'Thirdweb Pay',
    hostPatterns: ['thirdweb.com'],
    textPatterns: ['thirdweb'],
  },
  {
    name: 'Circle (USDC)',
    hostPatterns: ['circle.com'],
    textPatterns: ['circle.com/pay', 'circle payments'],
  },
  {
    name: 'Stripe Crypto',
    hostPatterns: [],
    textPatterns: ['stripe crypto onramp', 'stripe.crypto'],
  },
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

type ScanItem = { companyName: string; website: string };
type ScanPayload = { items?: unknown };

function jsonError(message: string, status: number) {
  return NextResponse.json({ error: message }, { status });
}

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

async function fetchHtml(url: string): Promise<{ ok: true; html: string; finalUrl: string } | { ok: false }> {
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
    return { ok: true, html, finalUrl: res.url || url };
  } catch {
    return { ok: false };
  } finally {
    clearTimeout(timer);
  }
}

function detectProviders(html: string): string[] {
  const $ = load(html);
  const bodyText = $('body').text().toLowerCase().replace(/\s+/g, ' ');
  const fullHtml = html.toLowerCase();
  const found = new Set<string>();

  const allAttrs: string[] = [];
  $('script[src], link[href], a[href], iframe[src], img[src]').each((_, el) => {
    const src = $(el).attr('src') || '';
    const href = $(el).attr('href') || '';
    if (src) allAttrs.push(src.toLowerCase());
    if (href) allAttrs.push(href.toLowerCase());
  });

  for (const provider of PROVIDERS) {
    for (const pattern of provider.hostPatterns) {
      if (allAttrs.some((attr) => attr.includes(pattern))) {
        found.add(provider.name);
        break;
      }
    }
    if (found.has(provider.name)) continue;
    for (const pattern of provider.textPatterns) {
      if (bodyText.includes(pattern) || fullHtml.includes(pattern)) {
        found.add(provider.name);
        break;
      }
    }
  }

  for (const { pattern, name } of WEB3_CODE_PATTERNS) {
    if (fullHtml.includes(pattern)) {
      found.add(name);
    }
  }

  return Array.from(found);
}

async function detectCryptoOnSite(websiteRaw: string): Promise<{ providers: string[] }> {
  const homeUrl = normalizeUrl(websiteRaw);
  if (!homeUrl) return { providers: [] };

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

  return { providers: Array.from(allProviders) };
}

export async function POST(req: NextRequest) {
  const token = getBearerToken(req.headers.get('authorization'));
  if (!token) return jsonError('Unauthorized', 401);

  const supabase = createAuthedSupabaseClient(token);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return jsonError('Unauthorized', 401);

  let payload: ScanPayload;
  try {
    payload = (await req.json()) as ScanPayload;
  } catch {
    return jsonError('Invalid JSON', 400);
  }

  const rawItems = Array.isArray(payload.items) ? payload.items : [];
  const items: ScanItem[] = rawItems
    .map((item) => {
      const obj = (item ?? {}) as Record<string, unknown>;
      return {
        companyName: String(obj.companyName ?? '').trim(),
        website: String(obj.website ?? '').trim(),
      };
    })
    .filter((item) => item.website);

  if (items.length === 0) return jsonError('No items to scan', 400);
  if (items.length > 50) return jsonError('Too many items per request (max 50)', 400);

  const withTimeout = (item: ScanItem) =>
    Promise.race([
      detectCryptoOnSite(item.website).then((detection) => {
        if (detection.providers.length === 0) return null;
        return {
          companyName: item.companyName,
          website: normalizeUrl(item.website) ?? item.website,
          paymentSystem: detection.providers.join(', '),
        };
      }),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), SITE_TIMEOUT_MS)),
    ]);

  const results = await Promise.allSettled(items.map(withTimeout));

  const matches = results
    .map((r) => (r.status === 'fulfilled' ? r.value : null))
    .filter((v): v is NonNullable<typeof v> => v !== null);

  return NextResponse.json({ matches, checked: items.length });
}
