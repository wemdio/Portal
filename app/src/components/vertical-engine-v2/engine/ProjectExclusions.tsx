'use client';

import { useEffect, useId, useRef, useState } from 'react';
import { VE_API, veEngineCall } from './api';
import { HE } from './design';
import { StatusBox } from './ui';

interface ProjectExclusionsSnapshot {
  revision: number;
  inns: string[];
  domains: string[];
  emails: string[];
  emailsKnown: boolean;
  updated_at: string | null;
}

/** Preserve identifiers as text, including leading zeroes. Exact validation
 * and canonicalization belong to the server used by collection and uploads. */
function parseList(value: string): string[] {
  return [...new Set(value.split(/[\s,;]+/u).map((item) => item.trim()).filter(Boolean))];
}

function readSnapshot(value: unknown): ProjectExclusionsSnapshot | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const item = value as Partial<ProjectExclusionsSnapshot>;
  if (!Number.isSafeInteger(item.revision) || Number(item.revision) < 0
    || !Array.isArray(item.inns) || item.inns.some((entry) => typeof entry !== 'string')
    || !Array.isArray(item.domains) || item.domains.some((entry) => typeof entry !== 'string')
    || (item.emails !== undefined && (!Array.isArray(item.emails) || item.emails.some((entry) => typeof entry !== 'string')))
    || (item.updated_at !== null && typeof item.updated_at !== 'string')) return null;
  // During a rolling deployment, older readers do not expose email rules yet.
  return { ...item, emails: item.emails ?? [], emailsKnown: Array.isArray(item.emails) } as ProjectExclusionsSnapshot;
}

function responseError(value: unknown, fallback: string): string {
  if (value && typeof value === 'object' && 'errors' in value && Array.isArray(value.errors)) {
    const details = value.errors.filter((entry): entry is string => typeof entry === 'string' && Boolean(entry)).slice(0, 10);
    if (details.length) return details.join(' ');
  }
  if (value && typeof value === 'object' && 'error' in value && typeof value.error === 'string' && value.error) return value.error;
  return fallback;
}

export function ProjectExclusions({ projectId, onSaved }: { projectId: string; onSaved?: () => void }) {
  const id = useId();
  const [snapshot, setSnapshot] = useState<ProjectExclusionsSnapshot | null>(null);
  const [inns, setInns] = useState('');
  const [domains, setDomains] = useState('');
  const [emails, setEmails] = useState('');
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [conflict, setConflict] = useState(false);
  const [saved, setSaved] = useState(false);
  const [reload, setReload] = useState(0);
  const identity = useRef(projectId);
  const firstInput = useRef<HTMLTextAreaElement>(null);
  useEffect(() => { identity.current = projectId; return () => { identity.current = ''; }; }, [projectId]);
  useEffect(() => { if (editing) firstInput.current?.focus(); }, [editing]);
  useEffect(() => {
    const controller = new AbortController();
    void veEngineCall<unknown>(`${VE_API}/projects/${projectId}/exclusions`, { signal: controller.signal })
      .then((result) => {
        if (controller.signal.aborted) return;
        const value = readSnapshot(result.data);
        if (!result.ok || !value) throw new Error(responseError(result.data, 'Не удалось загрузить исключения.'));
        setSnapshot(value); setInns(value.inns.join('\n')); setDomains(value.domains.join('\n')); setEmails(value.emails.join('\n'));
        setConflict(false); setError(''); setSaved(false);
      })
      .catch((reason) => { if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : 'Не удалось загрузить исключения.'); })
      .finally(() => { if (!controller.signal.aborted) setBusy(false); });
    return () => controller.abort();
  }, [projectId, reload]);

  const parsedInns = parseList(inns);
  const parsedDomains = parseList(domains);
  const parsedEmails = parseList(emails);
  const changed = snapshot !== null && (JSON.stringify(parsedInns) !== JSON.stringify(snapshot.inns)
    || JSON.stringify(parsedDomains) !== JSON.stringify(snapshot.domains)
    || (snapshot.emailsKnown && JSON.stringify(parsedEmails) !== JSON.stringify(snapshot.emails)));
  const reloadList = () => {
    if (busy || (editing && changed && !window.confirm('Загрузить актуальный список? Несохранённые правки будут заменены.'))) return;
    setBusy(true); setError(''); setSaved(false); setReload((current) => current + 1);
  };
  const save = async () => {
    if (!snapshot || busy || conflict || !changed) return;
    setBusy(true); setSaving(true); setError(''); setSaved(false);
    try {
      const result = await veEngineCall<unknown>(`${VE_API}/projects/${projectId}/exclusions`, {
        method: 'PUT', body: JSON.stringify({ revision: snapshot.revision, inns: parsedInns, domains: parsedDomains,
          ...(snapshot.emailsKnown ? { emails: parsedEmails } : {}) }),
      });
      if (identity.current !== projectId) return;
      if (!result.ok) {
        if (result.status >= 500) {
          setConflict(true);
          setError('Не удалось подтвердить сохранение. Обновите список перед повтором.');
          return;
        }
        if (result.status === 409) setConflict(true);
        setError(responseError(result.data, result.status === 409
          ? 'Список уже изменили. Загрузите актуальную версию.' : 'Не удалось сохранить исключения.'));
        return;
      }
      const value = readSnapshot(result.data);
      // An old writer may ignore an unknown request field. Accept its GET for
      // compatibility, but never claim that email rules were saved by it.
      const emailsConfirmed = !snapshot.emailsKnown || value?.emailsKnown;
      if (!value || !emailsConfirmed) throw new Error('Не удалось подтвердить сохранение. Обновите список перед повтором.');
      setSnapshot(value); setInns(value.inns.join('\n')); setDomains(value.domains.join('\n')); setEmails(value.emails.join('\n'));
      setEditing(false); setConflict(false); setSaved(true);
      onSaved?.();
    } catch {
      if (identity.current === projectId) {
        setConflict(true);
        setError('Не удалось подтвердить сохранение. Обновите список перед повтором.');
      }
    } finally { if (identity.current === projectId) { setBusy(false); setSaving(false); } }
  };

  return <section aria-labelledby={`${id}-title`} className="ve2-panel-line mb-6 p-4 space-y-3">
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div className="min-w-0">
        <h2 id={`${id}-title`} className="ve2-h3">Исключения проекта</h2>
        {snapshot ? <p className={HE.muted}>ИНН: {snapshot.inns.length.toLocaleString('ru-RU')} · домены и сайты: {snapshot.domains.length.toLocaleString('ru-RU')} · email: {snapshot.emailsKnown ? snapshot.emails.length.toLocaleString('ru-RU') : 'не загружены'}</p> : null}
      </div>
      {snapshot && !editing && !conflict ? <button type="button" className={HE.btnGhost} disabled={busy}
        aria-expanded={editing} aria-controls={`${id}-form`}
        onClick={() => { setEditing(true); setError(''); setSaved(false); }}>
        {snapshot.inns.length || snapshot.domains.length || snapshot.emails.length ? 'Изменить исключения' : 'Добавить исключения'}
      </button> : null}
    </div>
    <p className={HE.muted}>Для всех гипотез этого проекта: при сборе и ежедневном пополнении. Уже загруженные контакты остаются в кампаниях.</p>
    {(editing || (snapshot && snapshot.inns.length + snapshot.domains.length + snapshot.emails.length > 0)) ? <p className={HE.muted}>Email исключает только указанный адрес. ИНН, домен или сайт исключают компанию. Если ИНН неизвестен и других совпадений нет, контакт остаётся.</p> : null}
    {editing && snapshot ? <form id={`${id}-form`} className="space-y-3" onSubmit={(event) => { event.preventDefault(); void save(); }}>
      <div className="grid gap-4 md:grid-cols-3">
        <label className="block ve2-label" htmlFor={`${id}-inns`}>ИНН клиентов
          <textarea ref={firstInput} id={`${id}-inns`} rows={5} value={inns} disabled={busy}
            className={`${HE.input} mt-2 w-full resize-y`} placeholder="Вставьте список ИНН" spellCheck={false}
            aria-describedby={`${id}-format`}
            onChange={(event) => { setInns(event.target.value); if (!conflict) setError(''); setSaved(false); }} />
        </label>
        <label className="block ve2-label" htmlFor={`${id}-domains`}>Домены и сайты
          <textarea id={`${id}-domains`} rows={5} value={domains} disabled={busy}
            className={`${HE.input} mt-2 w-full resize-y`} placeholder={'company.ru\nhttps://company.ru/about'} spellCheck={false}
            autoCapitalize="none" aria-describedby={`${id}-format`}
            onChange={(event) => { setDomains(event.target.value); if (!conflict) setError(''); setSaved(false); }} />
        </label>
        <label className="block ve2-label" htmlFor={`${id}-emails`}>Email-адреса
          <textarea id={`${id}-emails`} rows={5} value={emails} disabled={busy || !snapshot.emailsKnown}
            className={`${HE.input} mt-2 w-full resize-y`} placeholder="client@company.ru" spellCheck={false}
            autoCapitalize="none" aria-describedby={`${id}-format${snapshot.emailsKnown ? '' : ` ${id}-email-unavailable`}`}
            onChange={(event) => { setEmails(event.target.value); if (!conflict) setError(''); setSaved(false); }} />
        </label>
      </div>
      {!snapshot.emailsKnown ? <p id={`${id}-email-unavailable`} className={HE.muted}>Обновите список, чтобы редактировать email.</p> : null}
      <p id={`${id}-format`} className={HE.muted}>Вставьте столбец из таблицы или разделите значения запятыми.</p>
      <div className="flex flex-wrap items-center gap-3">
        <button type="submit" className={HE.btnPrimary} disabled={busy || conflict || !changed}>{busy ? saving ? 'Сохраняем…' : 'Загружаем…' : 'Сохранить исключения'}</button>
        <button type="button" className={HE.btnQuiet} disabled={busy} onClick={() => {
          setEditing(false); setInns(snapshot.inns.join('\n')); setDomains(snapshot.domains.join('\n')); setEmails(snapshot.emails.join('\n')); if (!conflict) setError('');
        }}>Отмена</button>
      </div>
    </form> : null}
    {busy && !snapshot ? <p role="status" className={HE.muted}>Загружаем исключения…</p> : null}
    {saved ? <p role="status" className={HE.muted}>Исключения сохранены для этого проекта.</p> : null}
    {error ? <StatusBox tone="error">{error}</StatusBox> : null}
    {!busy && (!snapshot || !snapshot.emailsKnown || conflict || error) ? <button type="button" className={HE.btnQuiet} onClick={reloadList}>Обновить список</button> : null}
  </section>;
}
