/**
 * Политика «только публичный адрес» для чтения сайтов по чужому URL (SSRF).
 *
 * Сайт вводит клиент английского кабинета, источники доказательств приносит
 * поиск, а читает их воркер на нашем сервере. Гейт до первого запроса
 * (`assertPublicWebsite` в lib/clientDemo/personalize.ts) проверяет только
 * первый хост — редирект с публичного сайта на 127.0.0.1, 10.x или адрес
 * метаданных облака (169.254.169.254) он не видит. Здесь — проверка для
 * КАЖДОГО запроса и каждого шага редиректа: её подключает опция `guard` парсера
 * (WebsiteFetchGuard в lib/enrich/websiteParser.ts), а передают эту опцию
 * движок гипотез (hypothesisEngine/stages/io.ts) и EN-джобы конструктора баз
 * (tools/processingSteps.ts: шаг описаний — парсеру, поиск почт — scrapeEmails
 * в enrich/emailScraper.ts). Остальные вызывающие её не получают и читают как
 * прежде.
 *
 * Две линии, и обе нужны:
 *  - checkUrl — перед запросом: адрес-литерал проверяется сразу, имя —
 *    нашим резолвером. Имя ведёт на непубличный адрес → запрос не уходит.
 *    Резолвер не ответил → решает маршрут (ниже), а не эта проверка: иначе
 *    сбой нашего DNS превращался бы в «сайта нет» даже там, где хост за нас
 *    резолвит прокси;
 *  - directDispatcher — прямой маршрут (прокси не выбран): адрес проверяется
 *    ещё раз в момент соединения, тем ответом DNS, по которому undici и
 *    соединяется. Это закрывает подмену ответа между проверкой и запросом
 *    (DNS rebinding с TTL 0). Адрес-литерал undici не резолвит, его закрывает
 *    checkUrl.
 * Через прокси соединяется нода прокси и резолвит хост сама; непубличный
 * адрес на её стороне — это сеть провайдера прокси, не наша.
 *
 * Сверх «только публичный адрес» вызывающий может включить ещё два отказа
 * (опции allowedPorts и refusedAddresses, см. ExtraRefusals): порт только из
 * списка и запрет адресов наших собственных серверов. checkUrl проверяет
 * оба; соединение прямого маршрута — ещё раз адрес (порт оно берёт из того же,
 * уже проверенного URL). Движок гипотез включает их только у рынка 'us'.
 *
 * Политика английского рынка целиком — createUsWebsiteFetchGuard ниже: только
 * публичный адрес, адреса наших серверов (OWN_SERVER_ADDRESSES) отклоняются,
 * порт только 80/443 (STANDARD_WEB_PORTS), редирект https → http не
 * проходится, шагов редиректа не больше maxRedirects. Её зовут движок гипотез
 * (hypothesisEngine/stages/io.ts) для рынка 'us' и EN-джобы конструктора баз
 * (tools/processingSteps.ts, enSiteGuard); любой другой читатель сайтов по
 * чужому URL может взять ту же фабрику и получить ту же политику.
 */

import { lookup as lookupCallback, type LookupAddress, type LookupOptions } from 'node:dns';
import { lookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';
import { Agent, type Dispatcher } from 'undici';
import { WebsiteAddressRefusedError, type WebsiteFetchGuard } from '@/lib/enrich/websiteParser';

/**
 * Непубличные диапазоны IPv4 (IANA special-purpose, «not globally reachable»):
 * «эта сеть», частные, CGNAT (в нём и адрес метаданных 100.100.100.200),
 * loopback, link-local (169.254.169.254 — метаданные облака), служебные
 * IETF, документационные, бенчмарк, multicast и зарезервированные.
 */
const PRIVATE_V4: Array<[string, number]> = [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
];

/**
 * Непубличные диапазоны IPv6: :: и ::1 (входят в ::/96 вместе с устаревшими
 * IPv4-compatible), discard, служебные IETF (Teredo в их числе),
 * документационные, 6to4 (несёт IPv4 внутри), уникальные локальные (в них
 * fd00:ec2::254 — метаданные AWS), link-local, site-local и multicast.
 * IPv4-mapped (::ffff:a.b.c.d) BlockList сверяет с правилами IPv4 сам; NAT64
 * (64:ff9b::/96) — ниже, каждым диапазоном IPv4 внутри префикса.
 */
const PRIVATE_V6: Array<[string, number]> = [
  ['::', 96],
  ['64:ff9b:1::', 48],
  ['100::', 64],
  ['2001::', 23],
  ['2001:db8::', 32],
  ['2002::', 16],
  ['fc00::', 7],
  ['fe80::', 10],
  ['fec0::', 10],
  ['ff00::', 8],
];

function v4AsV6Tail(address: string): string {
  const [a, b, c, d] = address.split('.').map(Number);
  return `${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
}

const NON_PUBLIC = (() => {
  const list = new BlockList();
  for (const [address, prefix] of PRIVATE_V4) {
    list.addSubnet(address, prefix, 'ipv4');
    list.addSubnet(`64:ff9b::${v4AsV6Tail(address)}`, 96 + prefix, 'ipv6');
  }
  for (const [address, prefix] of PRIVATE_V6) list.addSubnet(address, prefix, 'ipv6');
  return list;
})();

/** Публичный ли адрес-литерал. Не разбирается как IP — не публичный. */
export function isPublicIpAddress(ip: string): boolean {
  const address = ip.replace(/^\[|\]$/g, '').replace(/%.*$/, '');
  const family = isIP(address);
  if (family === 0) return false;
  return !NON_PUBLIC.check(address, family === 4 ? 'ipv4' : 'ipv6');
}

/** Имена, которые не уходят в публичный DNS: их не спрашиваем вовсе. */
function isServiceHostname(host: string): boolean {
  return (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host.endsWith('.local') ||
    host.endsWith('.internal')
  );
}

/**
 * Дополнительные отказы политики сверх «только публичный адрес» — ОПЦИИ
 * createPublicWebsiteGuard, у вызывающего без них поведение прежнее:
 *  - allowedPorts — порт адреса только из списка; адрес без порта (порт схемы
 *    по умолчанию) проходит всегда; пустой список — как не переданный;
 *  - refused — адреса, которые публичны, но читать их нельзя (наши собственные
 *    серверы): прямое соединение с ними изнутри воркера может дойти до
 *    служебных сервисов хоста. Сверяются тем же BlockList, что и непубличные
 *    диапазоны: IPv4-mapped (::ffff:a.b.c.d) он сверяет с IPv4 сам, NAT64
 *    (64:ff9b::/96) добавляется явно.
 */
interface ExtraRefusals {
  allowedPorts: readonly number[] | null;
  refused: BlockList | null;
}

const NO_EXTRA_REFUSALS: ExtraRefusals = { allowedPorts: null, refused: null };

function refusedAddressList(addresses: readonly string[] | undefined): BlockList | null {
  if (!addresses?.length) return null;
  const list = new BlockList();
  for (const address of addresses) {
    const family = isIP(address);
    if (family === 4) {
      list.addAddress(address, 'ipv4');
      list.addAddress(`64:ff9b::${v4AsV6Tail(address)}`, 'ipv6');
    } else if (family === 6) {
      list.addAddress(address, 'ipv6');
    }
  }
  return list;
}

/** Адрес-литерал из списка отказов (refused). */
function isRefusedAddress(ip: string, refused: BlockList | null): boolean {
  if (!refused) return false;
  const address = ip.replace(/^\[|\]$/g, '').replace(/%.*$/, '');
  const family = isIP(address);
  return family !== 0 && refused.check(address, family === 4 ? 'ipv4' : 'ipv6');
}

async function checkPublicUrl(url: URL, extra: ExtraRefusals = NO_EXTRA_REFUSALS): Promise<void> {
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new WebsiteAddressRefusedError(`схема ${url.protocol}`);
  }
  // url.port пуст, когда порт — порт схемы по умолчанию (80 у http, 443 у https).
  if (extra.allowedPorts && url.port !== '' && !extra.allowedPorts.includes(Number(url.port))) {
    throw new WebsiteAddressRefusedError(`порт ${url.port} (разрешены ${extra.allowedPorts.join(', ')})`);
  }
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (isServiceHostname(host)) throw new WebsiteAddressRefusedError(`служебное имя ${host}`);
  if (isIP(host)) {
    if (!isPublicIpAddress(host)) throw new WebsiteAddressRefusedError(`непубличный адрес ${host}`);
    if (isRefusedAddress(host, extra.refused)) throw new WebsiteAddressRefusedError(`адрес нашего сервера ${host}`);
    return;
  }
  let addresses: LookupAddress[];
  try {
    addresses = await lookup(host, { all: true, verbatim: true });
  } catch {
    // Резолвер не ответил — решает маршрут: прямой проверит адрес при
    // соединении (publicOnlyLookup), прокси резолвит хост на своей стороне.
    return;
  }
  const blocked = addresses.find((entry) => !isPublicIpAddress(entry.address));
  if (blocked) throw new WebsiteAddressRefusedError(`${host} ведёт на непубличный адрес ${blocked.address}`);
  const own = addresses.find((entry) => isRefusedAddress(entry.address, extra.refused));
  if (own) throw new WebsiteAddressRefusedError(`${host} ведёт на адрес нашего сервера ${own.address}`);
}

/**
 * lookup для соединения прямого маршрута: тот же резолвер, что у undici по
 * умолчанию, но непубличный адрес в ответе (и адрес из списка отказов
 * политики, если он задан) — отказ соединения. Отказ — это
 * WebsiteAddressRefusedError: парсер находит его в cause ошибки fetch и
 * считает адрес отклонённым, а не сетевым сбоем.
 */
function publicOnlyLookup(refused: BlockList | null) {
  return (
    hostname: string,
    options: LookupOptions,
    callback: (err: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void,
  ): void => {
    lookupCallback(hostname, { ...options, all: true }, (err, addresses) => {
      if (err) {
        callback(err, '');
        return;
      }
      const blocked = addresses.find((entry) => !isPublicIpAddress(entry.address));
      if (blocked || addresses.length === 0) {
        callback(
          new WebsiteAddressRefusedError(
            `${hostname} ведёт на непубличный адрес ${blocked?.address ?? '(пустой ответ DNS)'}`,
          ),
          '',
        );
        return;
      }
      const own = addresses.find((entry) => isRefusedAddress(entry.address, refused));
      if (own) {
        callback(new WebsiteAddressRefusedError(`${hostname} ведёт на адрес нашего сервера ${own.address}`), '');
        return;
      }
      if (options.all) callback(null, addresses);
      else callback(null, addresses[0].address, addresses[0].family);
    });
  };
}

/** Диспетчеры прямого маршрута по набору отказанных адресов ('' — без него) и режиму TLS. */
const directDispatchers = new Map<string, Dispatcher>();

/**
 * Один диспетчер на процесс, набор отказов и режим: пул соединений прямого
 * маршрута общий. lenientTls — как у поиска почт (enrich/emailScraper.ts):
 * сертификат сайта не проверяется, заголовки ответа до 64 КиБ. Сайт с
 * просроченным сертификатом остаётся сайтом компании, а корпоративные сайты
 * за Akamai/F5 присылают куки больше 16 КиБ по умолчанию undici, и вся
 * страница терялась как «fetch failed». Проверка адреса при соединении та же.
 */
function publicOnlyDirectDispatcher(refusedKey: string, refused: BlockList | null, lenientTls = false): Dispatcher {
  const key = `${lenientTls ? 'lenient:' : ''}${refusedKey}`;
  let dispatcher = directDispatchers.get(key);
  if (!dispatcher) {
    dispatcher = new Agent(lenientTls
      ? { connect: { lookup: publicOnlyLookup(refused), rejectUnauthorized: false }, maxHeaderSize: 64 * 1024 }
      : { connect: { lookup: publicOnlyLookup(refused) } });
    directDispatchers.set(key, dispatcher);
  }
  return dispatcher;
}

/**
 * Защита чтения для опции `guard` парсера. `allowHttpDowngrade` выбирает
 * вызывающий (движок гипотез: false у рынка 'us'), `maxRedirects` — тоже.
 * `allowedPorts` и `refusedAddresses` — дополнительные отказы (ExtraRefusals);
 * не переданы — их нет, политика та же, что была без них.
 */
export function createPublicWebsiteGuard(options: {
  allowHttpDowngrade: boolean;
  maxRedirects: number;
  allowedPorts?: readonly number[];
  refusedAddresses?: readonly string[];
  /** Прямой маршрут без проверки сертификата и с заголовками до 64 КиБ (publicOnlyDirectDispatcher). */
  lenientTls?: boolean;
}): WebsiteFetchGuard {
  const extra: ExtraRefusals = {
    allowedPorts: options.allowedPorts?.length ? options.allowedPorts : null,
    refused: refusedAddressList(options.refusedAddresses),
  };
  const refusedKey = extra.refused ? [...(options.refusedAddresses ?? [])].sort().join(',') : '';
  return {
    checkUrl: (url) => checkPublicUrl(url, extra),
    maxRedirects: options.maxRedirects,
    allowHttpDowngrade: options.allowHttpDowngrade,
    directDispatcher: publicOnlyDirectDispatcher(refusedKey, extra.refused, options.lenientTls === true),
  };
}

/**
 * Адреса НАШИХ серверов (решение владельца, раунды 9–11): сайт, источник или
 * шаг редиректа, который ведёт на них, политика английского рынка не читает.
 * Адрес публичный, поэтому общая проверка его пропускает, а прямое соединение
 * с ним изнутри воркера может дойти до служебных сервисов хоста, которые
 * доверяют нашему адресу. Список собран по репозиторию:
 *  - 139.60.162.24 — текущий прод и US-egress (docs/ssh-access.md,
 *    lib/enrich/proxyPool.ts);
 *  - 139.60.162.12 — прежний прод и БД (CLAUDE.md, services/health-check);
 *  - 144.31.54.166 — хост рассыльщика и прежний сервер БД
 *    (deploy/sender/docker-compose.yml, AGENTS.md);
 *  - 89.19.209.252 — Timeweb «Звонилка VPS», третий SMTP-пробник: доверяет
 *    нашему прод-адресу по источнику (AGENTS.md, services/smtp-proxy/standalone/README.md,
 *    docs/incidents/2026-09-14-smtp-timeweb-stale-portal-allowlist.md).
 * Новый сервер (почтовый пилот и любой следующий) — дописать сюда: списка
 * в другом месте нет.
 */
export const OWN_SERVER_ADDRESSES: readonly string[] = [
  '139.60.162.24',
  '139.60.162.12',
  '144.31.54.166',
  '89.19.209.252',
];

/**
 * Порты, которые читает политика английского рынка (решение владельца, раунды
 * 9–11): только порты схем — 80 и 443. Адрес без порта — порт схемы по
 * умолчанию, он проходит всегда. Сайт клиента на нестандартном порту —
 * редкость, а любой порт открывал путь к сервисам, опубликованным на хосте.
 */
export const STANDARD_WEB_PORTS: readonly number[] = [80, 443];

/** Шагов редиректа по умолчанию у политики английского рынка (как у Go net/http). */
export const US_WEBSITE_MAX_REDIRECTS = 10;

/**
 * Защита чтения английского рынка — для опции `guard` парсера (websiteParser)
 * у любого вызывающего: только публичный адрес перед каждым запросом и шагом
 * редиректа и ещё раз при соединении прямого маршрута; адреса
 * OWN_SERVER_ADDRESSES отклоняются (литерал, IPv4-mapped, NAT64, ответ
 * резолвера); порт только STANDARD_WEB_PORTS; редирект https → http не
 * проходится (адрес ввёл клиент, а ответ по открытому каналу может подменить
 * любой узел по пути); шагов редиректа не больше `maxRedirects`
 * (US_WEBSITE_MAX_REDIRECTS по умолчанию). Прямой маршрут читает сайт с
 * негодным сертификатом и большими заголовками, как поиск почт (lenientTls):
 * иначе проверка компании теряла сайт, из которого конструктор потом всё равно
 * берёт адреса. Ничего, кроме GET страницы, этот маршрут сайту не отправляет.
 */
export function createUsWebsiteFetchGuard(options: { maxRedirects?: number } = {}): WebsiteFetchGuard {
  return createPublicWebsiteGuard({
    allowHttpDowngrade: false,
    maxRedirects: options.maxRedirects ?? US_WEBSITE_MAX_REDIRECTS,
    allowedPorts: STANDARD_WEB_PORTS,
    refusedAddresses: OWN_SERVER_ADDRESSES,
    lenientTls: true,
  });
}
