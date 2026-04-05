import { checkSyntax, isDisposable, isRole, isFreeProvider } from '@/lib/emailValidation/shared';
import * as dns from 'dns';

const dnsResolver = new dns.promises.Resolver();
dnsResolver.setServers(['8.8.8.8', '8.8.4.4', '1.1.1.1']);

const CONCURRENCY = 5;

const domainMxCache = new Map<string, boolean>();

async function hasMx(domain: string): Promise<boolean> {
  if (domainMxCache.has(domain)) return domainMxCache.get(domain)!;

  try {
    const records = await dnsResolver.resolveMx(domain);
    const found = records && records.length > 0;
    domainMxCache.set(domain, found);
    return found;
  } catch {
    domainMxCache.set(domain, false);
    return false;
  }
}

export interface ValidateEmailResult {
  email: string;
  valid: boolean;
  reason?: string;
}

async function validateOne(email: string): Promise<ValidateEmailResult> {
  const syntax = checkSyntax(email);
  if (!syntax.valid) return { email, valid: false, reason: 'syntax' };

  const domain = email.split('@')[1];

  if (isDisposable(email)) return { email, valid: false, reason: 'disposable' };
  if (isFreeProvider(email)) return { email, valid: false, reason: 'free_provider' };
  if (isRole(email)) return { email, valid: false, reason: 'role_address' };

  const mxFound = await hasMx(domain);
  if (!mxFound) return { email, valid: false, reason: 'no_mx' };

  return { email, valid: true };
}

export interface ValidateLeadEmailsInput {
  id: string;
  emails: string[];
}

export interface ValidateLeadEmailsResult {
  id: string;
  validated: string[];
  rejected: Array<{ email: string; reason: string }>;
}

export async function validateLeadEmails(leads: ValidateLeadEmailsInput[]): Promise<ValidateLeadEmailsResult[]> {
  const results: ValidateLeadEmailsResult[] = [];
  let totalValid = 0;
  let totalRejected = 0;

  for (let i = 0; i < leads.length; i += CONCURRENCY) {
    const batch = leads.slice(i, i + CONCURRENCY);
    const batchResults = await Promise.allSettled(
      batch.map(async (lead) => {
        const emailResults = await Promise.all(lead.emails.map(validateOne));
        const validated = emailResults.filter((r) => r.valid).map((r) => r.email);
        const rejected = emailResults.filter((r) => !r.valid).map((r) => ({ email: r.email, reason: r.reason! }));
        return { id: lead.id, validated, rejected };
      }),
    );

    for (const r of batchResults) {
      if (r.status === 'fulfilled') {
        results.push(r.value);
        totalValid += r.value.validated.length;
        totalRejected += r.value.rejected.length;
      }
    }
  }

  console.log(`[bugor-validate] Valid=${totalValid}, Rejected=${totalRejected}`);
  return results;
}
