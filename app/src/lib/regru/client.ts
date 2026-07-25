/**
 * Thin client for the reg.ru reseller API (regru2).
 *
 * Extracted from /api/admin/domains so both the admin domain list and the
 * client onboarding domain picker share one implementation.
 *
 * Protocol (https://www.reg.ru/reseller/api2doc):
 *   POST https://api.reg.ru/api/regru2/<method>
 *   Content-Type: application/x-www-form-urlencoded
 *   body: username, password, input_format=json, input_data=<JSON>
 *
 * Top-level response: { result: 'success', answer: … } or
 * { result: 'error', error_code, error_text } — the latter is thrown as Error.
 *
 * Rate limit: 1200 requests/hour per account/IP — batch domain/check calls
 * (one request carries up to 1000 domains) instead of one call per domain.
 */

import 'server-only';

const REGRU_API = 'https://api.reg.ru/api/regru2';

export interface RegruAccount {
  name: string;
  username: string;
  password: string;
}

/** Accounts configured via env: primary pair + optional second pair. */
export function getRegruAccounts(): RegruAccount[] {
  const accounts: RegruAccount[] = [];

  const u1 = process.env.REGRU_USERNAME;
  const p1 = process.env.REGRU_PASSWORD;
  if (u1 && p1) accounts.push({ name: u1, username: u1, password: p1 });

  const u2 = process.env.REGRU_USERNAME_2;
  const p2 = process.env.REGRU_PASSWORD_2;
  if (u2 && p2) accounts.push({ name: u2, username: u2, password: p2 });

  return accounts;
}

export interface RegruApiResponse<TAnswer = unknown> {
  result: string;
  error_code?: string;
  error_text?: string;
  answer?: TAnswer;
}

/**
 * Call a regru2 method with JSON input_data. Throws on HTTP errors and on
 * top-level result != 'success' (e.g. ACCESS_DENIED_FROM_IP,
 * RESELLER_AUTH_FAILED, PASSWORD_AUTH_FAILED). Returns the parsed `answer`.
 */
export async function callRegruApi<TAnswer = unknown>(
  method: string,
  inputData: Record<string, unknown>,
  account: RegruAccount,
): Promise<TAnswer | undefined> {
  const params = new URLSearchParams({
    username: account.username,
    password: account.password,
    input_format: 'json',
    input_data: JSON.stringify(inputData),
    output_content_type: 'plain',
  });

  const res = await fetch(`${REGRU_API}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
  });

  if (!res.ok) {
    throw new Error(`Reg.ru API (${account.name}): HTTP ${res.status}`);
  }

  const data = (await res.json()) as RegruApiResponse<TAnswer>;

  if (data.result !== 'success') {
    throw new Error(
      `Reg.ru (${account.name}): ${data.error_text ?? data.error_code ?? 'API error'}`,
    );
  }

  return data.answer;
}

interface DomainCheckAnswer {
  domains?: Array<{ dname?: string; result?: string; error_code?: string }>;
}

/**
 * Batch availability check via domain/check. One HTTP request for the whole
 * list (API allows up to 1000 domains per call — we stay far below that and
 * far below the 1200 req/hour account limit).
 *
 * A domain is available iff its element has result === 'Available'; occupied
 * or invalid names come back with an error_code (DOMAIN_ALREADY_EXISTS,
 * DOMAIN_BAD_NAME, …) and are reported as unavailable.
 *
 * Uses the PRIMARY account only (domain/check needs just one).
 */
export async function checkDomainsAvailable(
  dnames: string[],
  account?: RegruAccount,
): Promise<Record<string, boolean>> {
  const creds = account ?? getRegruAccounts()[0];
  if (!creds) {
    throw new Error('Reg.ru: no account configured (REGRU_USERNAME/REGRU_PASSWORD)');
  }
  if (dnames.length === 0) return {};

  const answer = await callRegruApi<DomainCheckAnswer>(
    'domain/check',
    { domains: dnames.map((dname) => ({ dname })) },
    creds,
  );

  const availability: Record<string, boolean> = {};
  for (const item of answer?.domains ?? []) {
    if (typeof item.dname !== 'string') continue;
    availability[item.dname.toLowerCase()] = item.result === 'Available';
  }
  return availability;
}
