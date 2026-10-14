import { normalizeVeCompanyInn } from './collectionIdentity';

/** Public discovery hints, not approved leads or cached ownership verdicts.
 * Exact INNs recover brands hidden behind neutral registry names/OKVEDs.
 * Every candidate still passes website ownership, relevance and email gates.
 * No emails, project IDs or paid lookups belong in this catalogue. */
export const VE_PAYMENT_DIRECTORY_REVISION = 'payments-2026-10-12' as const;
export interface VePaymentCompanyHint {
  brand: string;
  inns: readonly string[];
  website: string;
  source: string;
  checkedAt: string;
}

const checkedAt = '2026-10-12';
const companies: readonly VePaymentCompanyHint[] = [
  ['PayMaster', ['7723887394'], 'https://info.paymaster.ru/contact/'],
  ['PayKeeper', ['5047186409', '5008053934'], 'https://paykeeper.ru/credits/'],
  ['Robokassa', ['5047063929'], 'https://robokassa.com/about/contacts/'],
  ['CloudPayments', ['7708806062'], 'https://cloudpayments.ru/contacts/'],
  ['Unitpay', ['3666191762'], 'https://unitpay.ru/support'],
  ['PayAnyWay', ['1215192632'], 'https://payanyway.ru/info/w/ru/public/w/about.html'],
  ['ArsenalPay', ['2536154341'], 'https://arsenalpay.ru/pay/about/service'],
  ['Platron', ['9718064247'], 'https://pay.platron.ru/en/contacts/'],
  ['Assist', ['7825478305'], 'https://www.assist.ru/ob-assist/'],
  ['Payture', ['7701870710'], 'https://payture.com/contacts'],
  ['Best2Pay', ['7813531811'], 'https://best2pay.net/contacts/'],
  ['Mandarin', ['7708816952'], 'https://mandarin.io/conditions'],
  ['IntellectMoney', ['7743736523'], 'https://intellectmoney.ru/legal-information'],
  ['Prodamus', ['1215156909'], 'https://prodamus.ru/contacts'],
  ['Onpay', ['7720551124'], 'https://onpay.ru/about/'],
  ['LIFE PAY', ['9701010050'], 'https://life-pay.ru/company/contacts/'],
  ['PAYMO', ['7722849318'], 'https://www.paymo.ru/contact/'],
  ['Invoice', ['9710076508'], 'https://invoice.su/about/contacts'],
  ['YooKassa', ['7750005725'], 'https://yookassa.ru/contacts/',
    'https://yoomoney.ru/document/rekviziti-ooo-nko-yoomoney?lang=ru'],
].map(([brand, inns, website, source]) => ({
  brand: brand as string, inns: inns as string[], website: website as string,
  source: (source ?? website) as string, checkedAt,
}));

const byInn = new Map(companies.flatMap((company) => company.inns.map((inn) => [inn, company] as const)));

export function vePaymentCompanyInns(): string[] { return [...byInn.keys()]; }

/** Never bind by fuzzy brand, email domain or a payment logo on a merchant. */
export function vePaymentCompanyHint(inn: unknown): VePaymentCompanyHint | undefined {
  return typeof inn === 'string' ? byInn.get(normalizeVeCompanyInn(inn)) : undefined;
}
