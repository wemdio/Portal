'use client';

import { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { AlertCircle, ArrowRight, Check, CheckCircle2, Database, FileSpreadsheet, LoaderCircle, Search, Upload, X } from 'lucide-react';

import { call, errorText, upload } from './liApi';
import styles from './NewBaseModal.module.css';

/**
 * Окно «Создать базу» кампании LinkedIn: база собирается скрапером (параметры
 * и результат — здесь же) или грузится из CSV. Порядок баз в очереди кампании
 * определяется порядком сохранения.
 */

export interface NewBaseAccount {
  id: string;
  label: string;
}

interface ScrapedLead {
  id: string;
  name: string;
  position: string | null;
  company: string | null;
  profile_url: string | null;
}

type Method = 'scraper' | 'csv';
type ScrapeType = 'search' | 'reactions';
type Phase = 'form' | 'running' | 'done' | 'failed';

const POLL_MS = 3000;
const SHOWN = 100;

export default function NewBaseModal({
  campaignId,
  activeListId,
  accounts,
  onClose,
  onSaved,
}: {
  campaignId: string;
  activeListId: string | null;
  accounts: NewBaseAccount[];
  onClose: () => void;
  /** База сохранена в кампании — перечитать список. */
  onSaved: () => Promise<void>;
}) {
  const [name, setName] = useState('');
  const [method, setMethod] = useState<Method>('scraper');
  const [error, setError] = useState<string | null>(null);

  const [scrapeType, setScrapeType] = useState<ScrapeType>('search');
  const [url, setUrl] = useState('');
  const [accountId, setAccountId] = useState(accounts[0]?.id ?? '');
  const [max, setMax] = useState(100);
  const [phase, setPhase] = useState<Phase>('form');
  const [progress, setProgress] = useState({ done: 0, total: 0 });
  const [leads, setLeads] = useState<ScrapedLead[]>([]);
  const [leadsTotal, setLeadsTotal] = useState(0);
  const draft = useRef<{ listId: string | null; taskId: string | null }>({ listId: null, taskId: null });
  const timer = useRef<number | null>(null);

  const [csvKind, setCsvKind] = useState<'plain' | 'invites'>('plain');
  const [file, setFile] = useState<File | null>(null);
  const [saving, setSaving] = useState(false);
  const [summary, setSummary] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const dialog = useRef<HTMLDivElement>(null);
  const nameInput = useRef<HTMLInputElement>(null);
  const id = useId();

  const stopPolling = () => {
    if (timer.current) window.clearTimeout(timer.current);
    timer.current = null;
  };

  /** Черновая база скрапера: идущую задачу отменяем, базу удаляем. */
  const dropDraft = async () => {
    stopPolling();
    const { listId, taskId } = draft.current;
    draft.current = { listId: null, taskId: null };
    try {
      if (taskId) await call(`/scraper/tasks/${taskId}/cancel`, 'POST', {}).catch(() => undefined);
      if (listId) await call(`/lead-lists/${listId}`, 'DELETE');
    } catch {
      // Не удалилась — останется базой без кампании, её видно в общем списке.
    }
  };

  useEffect(() => () => stopPolling(), []);

  const close = async () => {
    if (saving) return;
    if (draft.current.listId) await dropDraft();
    onClose();
  };

  useEffect(() => {
    const esc = (event: KeyboardEvent) => { if (event.key === 'Escape' && !saving) void close(); };
    document.addEventListener('keydown', esc);
    return () => document.removeEventListener('keydown', esc);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [saving]);

  useEffect(() => {
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    nameInput.current?.focus();
    const trapFocus = (event: KeyboardEvent) => {
      if (event.key !== 'Tab') return;
      const controls = dialog.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), a[href]');
      if (!controls?.length) return;
      const first = controls[0];
      const last = controls[controls.length - 1];
      if (event.shiftKey && (document.activeElement === first || !dialog.current?.contains(document.activeElement))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (document.activeElement === last || !dialog.current?.contains(document.activeElement))) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', trapFocus);
    return () => {
      document.removeEventListener('keydown', trapFocus);
      document.body.style.overflow = previousOverflow;
      previousFocus?.focus();
    };
  }, []);

  const poll = (taskId: string, listId: string) => {
    timer.current = window.setTimeout(async () => {
      try {
        const { task } = await call<{ task: { status: string; progress: number; total: number; error_message: string | null } }>(`/scraper/tasks/${taskId}`, 'GET');
        setProgress({ done: task.progress ?? 0, total: task.total ?? 0 });
        if (task.status === 'completed') {
          const d = await call<{ leads: ScrapedLead[]; total: number }>(`/scraper/tasks/${taskId}/leads`, 'GET');
          if (draft.current.listId !== listId) return;
          setLeads(d.leads);
          setLeadsTotal(d.total);
          setPhase('done');
          return;
        }
        if (task.status === 'failed' || task.status === 'cancelled') {
          setError(task.error_message || 'Сбор не удался');
          setPhase('failed');
          return;
        }
      } catch (e) {
        setError(errorText(e));
        setPhase('failed');
        return;
      }
      if (draft.current.listId === listId) poll(taskId, listId);
    }, POLL_MS);
  };

  const startScrape = async () => {
    const baseName = name.trim();
    if (!baseName) return setError('Введите название базы');
    if (!accountId) return setError('Выберите LinkedIn-аккаунт');
    if (!url.trim()) {
      return setError(scrapeType === 'search'
        ? 'Вставьте URL поиска LinkedIn People'
        : 'Вставьте URL поста LinkedIn — скрапер соберёт реакции');
    }
    setError(null);
    await dropDraft();
    setPhase('running');
    setProgress({ done: 0, total: 0 });
    setLeads([]);
    try {
      const { lead_list } = await call<{ lead_list: { id: string } }>('/lead-lists', 'POST', { name: baseName });
      draft.current.listId = lead_list.id;
      const accountName = accounts.find((a) => a.id === accountId)?.label ?? null;
      const common = { account_id: accountId, account_name: accountName, lead_list_id: lead_list.id, lead_list_name: baseName, max_results: max };
      const body = scrapeType === 'search' ? { search_url: url.trim(), ...common } : { post_url: url.trim(), ...common };
      const { task_id } = await call<{ task_id: string }>(scrapeType === 'search' ? '/scraper/search' : '/scraper/reactions', 'POST', body);
      draft.current.taskId = task_id;
      poll(task_id, lead_list.id);
    } catch (e) {
      setError(errorText(e));
      setPhase('failed');
    }
  };

  const makeActive = (listId: string) => call(`/campaigns/${campaignId}`, 'PUT', { lead_list_id: listId });

  const applyScraped = async () => {
    const listId = draft.current.listId;
    if (!listId) return;
    setSaving(true);
    try {
      await call(`/lead-lists/${listId}`, 'PUT', { campaign_id: campaignId });
      if (!activeListId) await makeActive(listId);
      draft.current = { listId: null, taskId: null };
      await onSaved();
      onClose();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setSaving(false);
    }
  };

  const saveCsv = async () => {
    const baseName = name.trim();
    if (!baseName) return setError('Введите название базы');
    if (!file) return setError('Выберите CSV-файл');
    setError(null);
    setSaving(true);
    let createdId: string | null = null;
    try {
      if (csvKind === 'invites') {
        const data = await upload('/leads/import-with-invites', { campaign_id: campaignId, list_name: baseName }, file);
        const list = data.lead_list as { id: string } | null | undefined;
        createdId = list?.id ?? null;
        const parts = [`Загружено контактов: ${Number(data.imported ?? 0)}`];
        if (Number(data.skipped) > 0) parts.push(`Пропущено (нет имени или инвайта): ${data.skipped}`);
        setSummary(parts.join('\n'));
      } else {
        const { lead_list } = await call<{ lead_list: { id: string } }>('/lead-lists', 'POST', { name: baseName, campaign_id: campaignId });
        createdId = lead_list.id;
        let data: Record<string, unknown>;
        try {
          data = await upload('/leads/import', { lead_list_id: lead_list.id }, file);
        } catch (e) {
          await call(`/lead-lists/${lead_list.id}`, 'DELETE').catch(() => undefined);
          createdId = null;
          throw e;
        }
        const parts = [`Загружено новых: ${Number(data.imported ?? 0)}`];
        if (Number(data.already_contacted_skipped) > 0) parts.push(`Уже контактировали (пропущено): ${data.already_contacted_skipped}`);
        if (Number(data.dup_in_file_skipped) > 0) parts.push(`Дублей в файле (пропущено): ${data.dup_in_file_skipped}`);
        if (Number(data.skipped) > 0) parts.push(`Без валидных данных: ${data.skipped}`);
        setSummary(parts.join('\n'));
      }
      if (createdId && !activeListId) await makeActive(createdId);
      await onSaved();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setSaving(false);
    }
  };

  const busy = phase === 'running';
  const locked = busy || saving || phase === 'done';
  const editScrape = async () => {
    setSaving(true);
    await dropDraft();
    setError(null);
    setPhase('form');
    setSaving(false);
  };
  const selectFile = (selected: File | null) => {
    if (selected && !selected.name.toLowerCase().endsWith('.csv')) {
      setError('Выберите файл в формате CSV');
      return;
    }
    setFile(selected);
    setError(null);
  };

  return createPortal(
    <div className={styles.overlay} onMouseDown={() => { if (!busy && !saving) void close(); }}>
      <div
        ref={dialog}
        role="dialog"
        aria-modal="true"
        aria-labelledby={`${id}-title`}
        aria-describedby={`${id}-description`}
        onMouseDown={(e) => e.stopPropagation()}
        className={styles.modal}
      >
        <header className={styles.header}>
          <span className={styles.headerIcon}><Database size={22} aria-hidden="true" /></span>
          <div className={styles.heading}>
            <h3 id={`${id}-title`}>Создать базу</h3>
            <p id={`${id}-description`}>Соберите контакты LinkedIn или загрузите готовый список.</p>
          </div>
          <button type="button" onClick={() => void close()} disabled={saving} aria-label="Закрыть" className={styles.close}>
            <X size={20} />
          </button>
        </header>

        <div className={styles.body}>
          {summary ? (
            <div className={styles.success} role="status">
              <CheckCircle2 size={36} aria-hidden="true" />
              <h4>База загружена</h4>
              <p className={styles.summary}>{summary}</p>
              <p className={styles.hint}>База появилась на вкладке «Базы» и встала в конец очереди кампании.</p>
            </div>
          ) : (
            <>
              <label className={styles.label}>
                Название базы
                <input
                  ref={nameInput}
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  disabled={locked}
                  placeholder="Например, Италия · IT-компании"
                  className={styles.field}
                />
              </label>

              <fieldset className={styles.section}>
                <legend className={styles.legend}>Как добавить контакты</legend>
                <div className={styles.methods}>
                  {(['scraper', 'csv'] as const).map((m) => {
                    const Icon = m === 'scraper' ? Search : Upload;
                    return (
                      <button
                        key={m}
                        type="button"
                        aria-pressed={method === m}
                        disabled={locked}
                        onClick={() => { setMethod(m); setError(null); }}
                        className={styles.method}
                      >
                        <span className={styles.methodIcon}><Icon size={20} aria-hidden="true" /></span>
                        <span className={styles.methodCopy}>
                          <strong>{m === 'scraper' ? 'Собрать скрапером' : 'Загрузить CSV'}</strong>
                          <span>{m === 'scraper' ? 'Из поиска или реакций на пост' : 'Из файла с контактами'}</span>
                        </span>
                        <span className={styles.indicator}>{method === m && <Check size={12} strokeWidth={3} aria-hidden="true" />}</span>
                      </button>
                    );
                  })}
                </div>
              </fieldset>

              {method === 'scraper' ? (
                phase === 'form' || phase === 'failed' ? (
                  <div className={styles.section}>
                    <fieldset className={styles.section}>
                      <legend className={styles.legend}>Источник контактов</legend>
                      <div className={styles.segments}>
                        <button type="button" aria-pressed={scrapeType === 'search'} onClick={() => setScrapeType('search')} className={styles.segment}>Поиск по URL</button>
                        <button type="button" aria-pressed={scrapeType === 'reactions'} onClick={() => setScrapeType('reactions')} className={styles.segment}>Реакции на пост</button>
                      </div>
                    </fieldset>
                    <label className={styles.label}>
                      {scrapeType === 'search' ? 'Ссылка на поиск LinkedIn People' : 'Ссылка на пост LinkedIn'}
                      <input
                        type="url"
                        value={url}
                        onChange={(e) => setUrl(e.target.value)}
                        placeholder={scrapeType === 'search' ? 'https://www.linkedin.com/search/results/people/…' : 'https://www.linkedin.com/posts/…'}
                        className={styles.field}
                        aria-describedby={`${id}-url-hint`}
                      />
                    </label>
                    <p id={`${id}-url-hint`} className={styles.hint}>
                      {scrapeType === 'search' ? 'Откройте поиск людей, настройте фильтры и скопируйте ссылку.' : 'Соберём людей, которые поставили реакцию на этот пост.'}
                    </p>
                    <div className={styles.row}>
                      <label className={styles.label}>
                        LinkedIn-аккаунт
                        <select value={accountId} onChange={(e) => setAccountId(e.target.value)} className={styles.field}>
                          <option value="">Выберите аккаунт</option>
                          {accounts.map((a) => <option key={a.id} value={a.id}>{a.label}</option>)}
                        </select>
                      </label>
                      <label className={styles.label}>
                        Количество контактов
                        <input type="number" min={1} value={max} onChange={(e) => setMax(Math.max(1, Number(e.target.value) || 1))} className={styles.field} />
                      </label>
                    </div>
                    {accounts.length === 0 && <p className={styles.hint}>Для сбора подключите LinkedIn-аккаунт на вкладке «Аккаунты».</p>}
                  </div>
                ) : (
                  <div className={styles.section}>
                    {phase === 'running' ? (
                      <div className={styles.progress} role="status">
                        <LoaderCircle size={28} className={styles.spinner} aria-hidden="true" />
                        <strong>Собираем контакты</strong>
                        <p className={styles.hint}>{progress.total > 0 ? `${progress.done} из ${progress.total}` : 'Запускаем задачу…'}</p>
                        {progress.total > 0 && <progress aria-label="Сбор контактов" max={progress.total} value={progress.done} />}
                      </div>
                    ) : (
                      <>
                        <p className={styles.result} role="status"><CheckCircle2 size={18} aria-hidden="true" />
                          {leadsTotal > leads.length ? `Собрано ${leadsTotal}, показаны первые ${leads.length}` : `Собрано контактов: ${leadsTotal}`}
                        </p>
                        {leads.length === 0 ? <p className={styles.hint}>Скрапер никого не нашёл. Измените параметры и пересоберите.</p> : (
                          <div className={styles.tableWrap}>
                            <table className={styles.table}>
                              <thead>
                                <tr>
                                  <th>Имя</th>
                                  <th>Должность</th>
                                  <th>Компания</th>
                                </tr>
                              </thead>
                              <tbody>
                                {leads.slice(0, SHOWN).map((lead) => (
                                  <tr key={lead.id}>
                                    <td>
                                      {lead.profile_url ? <a href={lead.profile_url} target="_blank" rel="noopener noreferrer">{lead.name}</a> : lead.name}
                                    </td>
                                    <td title={lead.position ?? ''}>{lead.position ?? '—'}</td>
                                    <td title={lead.company ?? ''}>{lead.company ?? '—'}</td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          </div>
                        )}
                      </>
                    )}
                  </div>
                )
              ) : (
                <div className={styles.section}>
                  <fieldset className={styles.section} disabled={saving}>
                    <legend className={styles.legend}>Формат базы</legend>
                    <div className={styles.segments}>
                      <button type="button" aria-pressed={csvKind === 'plain'} onClick={() => setCsvKind('plain')} className={styles.segment}>Обычный список</button>
                      <button type="button" aria-pressed={csvKind === 'invites'} onClick={() => setCsvKind('invites')} className={styles.segment}>С персональными инвайтами</button>
                    </div>
                  </fieldset>
                  <div className={styles.csvHelp} id={`${id}-csv-hint`}>
                    <span className={styles.legend}>Колонки в CSV</span>
                    <p>{csvKind === 'plain'
                      ? <><code>name</code> или <code>first_name</code> + <code>last_name</code> и <code>profile_url</code> — ссылка на профиль LinkedIn.</>
                      : <><code>LinkedIn ID</code> — имя контакта, <code>Invite</code> — персональный текст инвайта.</>}</p>
                    <p className={styles.hint}>Необязательно: {csvKind === 'plain' ? 'position, company' : 'position, company, profile_url'}.</p>
                  </div>
                  <label
                    className={styles.filePicker}
                    data-dragging={dragging}
                    data-selected={Boolean(file)}
                    data-disabled={saving}
                    onDragOver={(e) => { e.preventDefault(); if (!saving) setDragging(true); }}
                    onDragLeave={() => setDragging(false)}
                    onDrop={(e) => { e.preventDefault(); setDragging(false); if (!saving) selectFile(e.dataTransfer.files[0] ?? null); }}
                  >
                    <input type="file" accept=".csv,text/csv" disabled={saving} aria-label="CSV-файл" aria-describedby={`${id}-csv-hint`} onChange={(e) => selectFile(e.target.files?.[0] ?? null)} />
                    {file ? <FileSpreadsheet size={26} aria-hidden="true" /> : <Upload size={26} aria-hidden="true" />}
                    <strong title={file?.name}>{file ? file.name : 'Выбрать CSV-файл'}</strong>
                    <span>{file ? `${new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 1 }).format(file.size / 1024)} КБ · Нажмите, чтобы заменить` : 'или перетащите его сюда'}</span>
                  </label>
                </div>
              )}
            </>
          )}
          {error && <div className={styles.error} role="alert"><AlertCircle size={18} aria-hidden="true" /><p>{error}</p></div>}
        </div>

        <footer className={styles.footer}>
          <p className={styles.footerHint}>{summary ? 'Контакты готовы к работе' : 'База добавится в очередь кампании'}</p>
          <div className={styles.actions}>
            {summary ? <button type="button" onClick={onClose} className={styles.primary}>Готово<Check size={16} aria-hidden="true" /></button> : (
              <>
                {!busy && <button type="button" onClick={() => void close()} disabled={saving} className={styles.secondary}>Отмена</button>}
                {method === 'scraper' ? (
                  phase === 'form' || phase === 'failed' ? (
                    <button type="button" onClick={() => void startScrape()} className={styles.primary}>Собрать контакты<ArrowRight size={16} aria-hidden="true" /></button>
                  ) : phase === 'done' ? (
                    <>
                      <button type="button" onClick={() => void editScrape()} disabled={saving} className={styles.secondary}>Изменить параметры</button>
                      <button type="button" onClick={() => void applyScraped()} disabled={saving || leads.length === 0} className={styles.primary}>
                        {saving && <LoaderCircle size={16} className={styles.spinner} aria-hidden="true" />}{saving ? 'Сохраняем…' : 'Добавить базу'}
                      </button>
                    </>
                  ) : (
                    <button type="button" onClick={() => void close()} className={styles.secondary}>Отменить сбор</button>
                  )
                ) : (
                  <button type="button" onClick={() => void saveCsv()} disabled={saving} className={styles.primary}>
                    {saving ? <LoaderCircle size={16} className={styles.spinner} aria-hidden="true" /> : <Upload size={16} aria-hidden="true" />}{saving ? 'Загружаем…' : 'Загрузить базу'}
                  </button>
                )}
              </>
            )}
          </div>
        </footer>
      </div>
    </div>,
    document.body,
  );
}
