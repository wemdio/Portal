#!/usr/bin/env node
/**
 * Offline preparation only: no DB/API imports, no notifications, no model calls.
 * Inputs are private read-only exports, never checked-in fixtures.
 * Historical decisions are a baseline, NEVER expected/reference labels.
 * See docs/integrations/instantly-weekly-evaluation-20260919.md.
 */
import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir, realpath, chmod } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const sha = value => createHash('sha256').update(value).digest('hex');
const clean = value => typeof value === 'string' ? value.trim() : '';
const lower = value => clean(value).toLowerCase();
const time = value => typeof value === 'string' && /(?:Z|[+-]\d\d:\d\d)$/i.test(value)
  ? Date.parse(value) : NaN;
const counts = values => values.reduce((r, v) => { r[v] = (r[v] || 0) + 1; return r; }, {});

export function prepareDataset({ qualifications, emails, projects, knownIds, start, end, seed }) {
  if (![qualifications, emails, projects, knownIds].every(Array.isArray)) throw new Error('Expected array exports');
  if (knownIds.some(id => typeof id !== 'string' || !id.trim())) throw new Error('Invalid known ID');
  if (qualifications.some(q => !Number.isFinite(time(q.reply_timestamp)))) throw new Error('Qualification has no valid reply timestamp');
  if (!Number.isFinite(time(start)) || !Number.isFinite(time(end)) || time(start) >= time(end)) throw new Error('Invalid UTC interval');
  if (!clean(seed)) throw new Error('Explicit split seed required');
  const uniqueMap = (rows, field) => {
    const map = new Map();
    for (const row of rows) {
      const id = clean(row[field]);
      if (!id || map.has(id)) throw new Error('Missing or duplicate input ID: ' + field);
      map.set(id, row);
    }
    return map;
  };
  uniqueMap(qualifications, 'id');
  const byEmail = uniqueMap(emails, 'id');
  const byProject = uniqueMap(projects, 'id');
  const seenEmail = new Set(), byThread = new Map();
  for (const e of emails) {
    if (!clean(e.thread_id)) continue;
    const messages = byThread.get(e.thread_id) || [];
    messages.push(e); byThread.set(e.thread_id, messages);
  }
  const message = e => ({
    id: e.id, thread_id: e.thread_id || null, campaign_id: e.campaign_id || null,
    timestamp: e.timestamp_email || null, account: e.eaccount || null,
    type: e.type_label || 'unknown', from: e.from_email || null, to: e.to_email || null,
    from_addresses: e.from_address ?? null, to_addresses: e.to_address ?? null,
    cc: e.cc ?? null,
    subject: e.subject || '', body: e.body_text || '',
  });
  // Connected components keep both threads and repeat correspondents together.
  // Never use our sending account as a grouping key (it spans many customers).
  const parent = new Map();
  const find = key => {
    if (!parent.has(key)) parent.set(key, key);
    if (parent.get(key) !== key) parent.set(key, find(parent.get(key)));
    return parent.get(key);
  };
  const union = (a, b) => { const x = find(a), y = find(b); if (x !== y) parent.set(y, x); };
  const rows = qualifications.filter(q => time(q.reply_timestamp) >= time(start) && time(q.reply_timestamp) < time(end)).map(q => {
    if (!clean(q.instantly_email_id) || seenEmail.has(q.instantly_email_id)) throw new Error('Missing or duplicate qualification email ID');
    seenEmail.add(q.instantly_email_id);
    const raw = byEmail.get(q.instantly_email_id);
    const problems = [];
    if (!raw) problems.push('reply_absent_from_archive');
    if (raw?.thread_id && q.thread_id && raw.thread_id !== q.thread_id) problems.push('thread_id_conflict');
    if (raw?.timestamp_email && time(raw.timestamp_email) !== time(q.reply_timestamp)) problems.push('reply_timestamp_conflict');
    const thread = raw?.thread_id || q.thread_id;
    const cutoff = Number.isFinite(time(raw?.timestamp_email))
      ? Math.min(time(q.reply_timestamp), time(raw.timestamp_email)) : time(q.reply_timestamp);
    const prior = (byThread.get(thread) || []).filter(e => e.id !== q.instantly_email_id && time(e.timestamp_email) < cutoff)
      .sort((a, b) => time(a.timestamp_email) - time(b.timestamp_email) || a.id.localeCompare(b.id));
    if ((byThread.get(thread) || []).some(e => !Number.isFinite(time(e.timestamp_email)))) problems.push('unknown_message_timestamp');
    const fullBody = clean(raw?.body_text) || clean(q.reply_body);
    if (!fullBody) problems.push('missing_reply_body');
    if (!prior.some(e => ['sent', 'our_reply'].includes(e.type_label) && clean(e.body_text))) problems.push('no_archived_prior_outbound');
    const accounts = new Set([raw?.eaccount, ...prior.map(e => e.eaccount)].map(lower).filter(Boolean));
    if (accounts.size > 1) problems.push('mixed_sending_accounts');
    const campaigns = new Set([raw?.campaign_id, ...prior.map(e => e.campaign_id)].filter(Boolean));
    if (campaigns.size > 1) problems.push('mixed_campaigns');
    const project = byProject.get(q.qualified_project_id);
    if (!project) problems.push('project_policy_unresolved');
    if (project && q.qualified_project_owner_proven !== true) problems.push('project_owner_not_proven');
    if (project?.client_user_id) problems.push('client_policy_requires_separate_verification');
    const currentReply = raw ? message(raw) : {
      id: q.instantly_email_id, thread_id: thread || null, campaign_id: q.campaign_id || null,
      timestamp: q.reply_timestamp, account: q.eaccount || null, type: 'unverified',
      from: q.lead_email || null, to: q.eaccount || null, subject: q.reply_subject || '', body: '',
      from_addresses: null, to_addresses: null, cc: null,
    };
    currentReply.body = fullBody;
    const groupKey = 'case:' + q.id;
    find(groupKey);
    for (const t of new Set([q.thread_id, raw?.thread_id].filter(Boolean))) union(groupKey, 'thread:' + t);
    if (lower(q.lead_email)) union(groupKey, 'correspondent:' + lower(q.lead_email));
    return {
      id: q.id, email_id: q.instantly_email_id, group_key: groupKey,
      baseline: {
        status: q.status, proposal_seen: q.proposal_seen, confidence: q.ai_confidence,
        reason: q.ai_reason, created_at: q.created_at, updated_at: q.updated_at,
        kind: 'mutable_stored_production_decision_not_ground_truth',
      },
      reference: { label: null, source: 'unlabelled', reviewer: null },
      input: {
        latest_reply: currentReply, prior_messages: prior.map(message),
        project: project ? {
          id: project.id, name: project.name, brief: project.brief_text || null,
          criteria: project.lead_criteria || null, updated_at: project.updated_at,
          provenance: 'current_project_snapshot_not_historical_prompt',
        } : null,
      },
      coverage: {
        problems, reply_body_source: clean(raw?.body_text) ? 'archive' : fullBody ? 'qualification_body' : 'missing',
        policy_history_verified: false, exact_historical_input_available: false,
        // A full body is NOT a guarantee that every preceding email was synced.
        context_completeness_verified: false,
        stored_outbound_preview_used: false,
      },
    };
  });
  const groups = new Map(), known = new Set(knownIds);
  for (const row of rows) {
    const key = find(row.group_key), group = groups.get(key) || [];
    group.push(row); groups.set(key, group);
  }
  for (const members of groups.values()) {
    const ids = members.map(r => r.id).sort();
    const groupId = sha(ids.join('\n'));
    const exposed = members.some(r => known.has(r.id) || known.has(r.email_id));
    const split = exposed || parseInt(sha(seed + ':' + groupId).slice(0, 8), 16) % 5 === 0 ? 'tuning' : 'holdout';
    for (const row of members) {
      delete row.group_key;
      row.group_id = groupId; row.split = split;
      row.previously_exposed_group = exposed;
    }
  }
  rows.sort((a, b) => a.id.localeCompare(b.id));
  const summary = {
    interval: { start_inclusive: start, end_exclusive: end }, rows: rows.length, groups: groups.size,
    status_counts: counts(rows.map(r => r.baseline.status)), split_counts: counts(rows.map(r => r.split)),
    coverage_issues: counts(rows.flatMap(r => r.coverage.problems)),
    archived_reply_matches: rows.filter(r => byEmail.has(r.email_id)).length,
    prior_outbound_available: rows.filter(r => !r.coverage.problems.includes('no_archived_prior_outbound')).length,
    current_project_policy_available: rows.filter(r => r.input.project !== null).length,
    previously_exposed_rows: rows.filter(r => r.previously_exposed_group).length,
    reference_labelled: 0, eligible_for_accuracy_claim: 0,
    note: 'Split is frozen for this export only. Inspect tuning, keep holdout closed until policy freeze. Unresolved coverage is a separate stratum, never a silent negative.',
  };
  return { schema_version: 1, seed, summary, cases: rows };
}

async function main() {
  const args = Object.create(null);
  const flags = ['qualifications', 'emails', 'projects', 'known-ids', 'start', 'end', 'seed', 'out'];
  for (let i = 2; i < process.argv.length; i += 2) {
    const flag = process.argv[i]?.slice(2), value = process.argv[i + 1];
    if (!flags.includes(flag) || !process.argv[i].startsWith('--') || !value || value.startsWith('--') || args[flag]) throw new Error('Invalid arguments');
    args[flag] = value;
  }
  if (flags.some(f => !args[f]) || !path.isAbsolute(args.out)) throw new Error('All input flags and an absolute NEW --out directory are required');
  const sources = {};
  for (const key of ['qualifications', 'emails', 'projects', 'known-ids']) {
    const text = await readFile(args[key], 'utf8');
    sources[key] = { parsed: JSON.parse(text), sha256: sha(text) };
  }
  const data = prepareDataset({
    qualifications: sources.qualifications.parsed, emails: sources.emails.parsed,
    projects: sources.projects.parsed, knownIds: sources['known-ids'].parsed,
    start: args.start, end: args.end, seed: args.seed,
  });
  // Resolve symlinks and keep raw correspondence strictly outside this checkout.
  const repo = await realpath(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..'));
  const out = path.join(await realpath(path.dirname(args.out)), path.basename(args.out));
  const rel = path.relative(repo, out);
  if (!rel || (!rel.startsWith('..' + path.sep) && rel !== '..' && !path.isAbsolute(rel))) throw new Error('Private export must be outside the checkout');
  await mkdir(out, { mode: 0o700 }); // fail if an earlier frozen set already exists
  await chmod(out, 0o700);
  const save = (name, value) => writeFile(path.join(out, name), JSON.stringify(value, null, 2), { mode: 0o600, flag: 'wx' });
  const { cases, ...metadata } = data;
  await save('tuning.json', { ...metadata, cases: cases.filter(r => r.split === 'tuning') });
  await save('holdout.json', { ...metadata, cases: cases.filter(r => r.split === 'holdout') });
  await save('manifest.json', {
    ...metadata, exported_at: new Date().toISOString(), preparer_sha256: sha(await readFile(fileURLToPath(import.meta.url))),
    input_sha256: Object.fromEntries(Object.entries(sources).map(([key, source]) => [key, source.sha256])),
    cases_sha256: sha(JSON.stringify(cases)), network_calls: 0, production_writes: 0,
  });
  console.log(JSON.stringify({ out, ...data.summary }, null, 2));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(() => { console.error('Preparation failed: check input schema, IDs, interval and new private output directory. No network calls were made.'); process.exitCode = 1; });
}
