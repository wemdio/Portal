'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Loader2, Pause, Play, Plus, Settings, Square, Trash2, Users } from 'lucide-react';
import {
  deleteCampaign,
  fetchCampaigns,
  fetchFolders,
  patchCampaign,
  type CampaignDeleteOutreachDto,
  type CampaignDto,
  type SenderFolderDto,
} from './api';
import { CampaignFormModal } from './CampaignFormModal';
import { timezoneLabel, weekdaysLabel } from './CampaignSteps';
import { FolderSettingsModal, chainDaysLabel } from './FolderSettingsModal';
import { RecipientsModal } from './RecipientsModal';

const STATUS_LABELS: Record<CampaignDto['status'], { text: string; className: string }> = {
  draft: { text: 'Черновик', className: 'bg-zinc-100 text-zinc-600' },
  running: { text: 'Идёт', className: 'bg-emerald-100 text-emerald-700' },
  paused: { text: 'Пауза', className: 'bg-amber-100 text-amber-700' },
  done: { text: 'Завершена', className: 'bg-zinc-100 text-zinc-600' },
};

type CampaignAction = 'start' | 'pause' | 'finish' | 'delete';

const ACTION_FAILED: Record<CampaignAction, string> = {
  start: 'Не удалось запустить',
  pause: 'Не удалось поставить на паузу',
  finish: 'Не удалось завершить',
  delete: 'Не удалось удалить',
};

/** Сколько держится подсветка кампании, открытой по ссылке. */
const HIGHLIGHT_MS = 4000;

/**
 * Вопрос перед удалением. У кампании автоаутрича удаление решает и судьбу её
 * компаний (api/tools/sender/campaigns/[id], DELETE): письма уходили — они
 * больше не зальются, не уходили — их можно залить заново. Это надо знать до
 * того, как нажать «ОК».
 */
function deleteConfirmText(campaign: CampaignDto): string {
  const question = `Удалить кампанию «${campaign.name}» вместе с базой получателей и историей писем?`;
  if (!campaign.source_kind || campaign.source_kind === 'manual') return question;
  return (
    `${question}\n\nКомпании в ней — из автоаутрича. Если письма из кампании уже уходили, эти компании больше `
    + 'не зальются в Рассылку — чтобы им не написали второй раз. Если писем ещё не было, их можно будет залить заново.'
  );
}

/** Что стало с компаниями удалённой кампании автоаутрича; null — сказать нечего. */
function deletedOutreachNotice(campaign: CampaignDto, outreach: CampaignDeleteOutreachDto): string | null {
  if (!outreach.rows) return null;
  return outreach.lettersSent
    ? `Кампания «${campaign.name}» удалена. Письма из неё уже уходили, поэтому её компании (${outreach.rows}) больше не зальются в Рассылку.`
    : `Кампания «${campaign.name}» удалена. Писем из неё не было — её компании (${outreach.released}) можно залить заново с экрана запуска автоаутрича.`;
}

/** id строки кампании в разметке — к нему прокручивает ссылка ?campaign=<id>. */
function campaignRowId(campaignId: string): string {
  return `sender-campaign-${campaignId}`;
}

function campaignsLabel(count: number): string {
  const mod10 = count % 10;
  const mod100 = count % 100;
  if (mod10 === 1 && mod100 !== 11) return `${count} кампания`;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return `${count} кампании`;
  return `${count} кампаний`;
}

interface CampaignGroup {
  key: string;
  title: string;
  /** null — кампании вне папок («Остальные»). */
  folder: SenderFolderDto | null;
  campaigns: CampaignDto[];
}

/**
 * Кампании по папкам: папки — в порядке сервера (автоаутрич RU, потом EN), в
 * конце — кампании вне папок. Кампания папки, которой нет в списке (папку
 * удалили между запросами), не пропадает с экрана, а уходит в «Остальные».
 */
function groupCampaigns(campaigns: CampaignDto[], folders: SenderFolderDto[]): CampaignGroup[] {
  const byFolder = new Map<string, CampaignDto[]>(folders.map((folder) => [folder.id, []]));
  const rest: CampaignDto[] = [];
  for (const campaign of campaigns) {
    const bucket = campaign.folder_id ? byFolder.get(campaign.folder_id) : undefined;
    (bucket ?? rest).push(campaign);
  }
  return [
    ...folders.map((folder) => ({
      key: folder.id,
      title: folder.name,
      folder,
      campaigns: byFolder.get(folder.id) ?? [],
    })),
    // Папки не загрузились — тогда это просто все кампании.
    { key: 'rest', title: folders.length ? 'Остальные' : 'Кампании', folder: null, campaigns: rest },
  ];
}

/**
 * Шапка папки: на каких ящиках и когда поедут её новые кампании — и чего не
 * хватает, чтобы они вообще поехали.
 */
function FolderSummary({ folder }: { folder: SenderFolderDto }) {
  return (
    <>
      <p className="mt-1 text-xs text-zinc-500">
        Ящиков: {folder.mailboxCount}, рабочих: {folder.workingMailboxCount}
        {' · '}
        {folder.send_hour_from}:00–{folder.send_hour_to}:00
        {' · '}
        {weekdaysLabel(folder.send_weekdays)}
        {' · '}
        {timezoneLabel(folder.timezone)}
        {' · '}
        письма: {chainDaysLabel(folder.step_delays_hours)}
      </p>
      {folder.mailboxCount === 0 ? (
        <p className="mt-1 text-xs text-amber-600">
          Ящики не выбраны — выберите их в «Настройках», иначе новые кампании папки не запустятся.
        </p>
      ) : folder.workingMailboxCount === 0 ? (
        <p className="mt-1 text-xs text-amber-600">
          Ни один ящик папки сейчас не может отправлять: нужен статус «Готов» и галочка «берём в рассылку» на
          вкладке «Ящики».
        </p>
      ) : null}
    </>
  );
}

function CampaignRow({
  campaign,
  highlighted,
  onEdit,
  onRecipients,
  onAction,
}: {
  campaign: CampaignDto;
  /** Кампания открыта по ссылке — подсвечена, пока на неё смотрят. */
  highlighted: boolean;
  onEdit: () => void;
  onRecipients: () => void;
  onAction: (action: CampaignAction) => void;
}) {
  const status = STATUS_LABELS[campaign.status];
  const stats = campaign.stats;
  // Черновик автоаутрича, залитый, пока в папке не было ящиков: пул он
  // возьмёт из папки при запуске — без подсказки «0 ящиков» пугал бы.
  const poolFromFolder = Boolean(campaign.folder_id) && campaign.mailboxes.length === 0 && campaign.status === 'draft';

  return (
    <div
      id={campaignRowId(campaign.id)}
      className={`flex flex-wrap items-center gap-4 px-5 py-4 transition-colors duration-700 ${
        highlighted ? 'bg-blue-50 ring-2 ring-inset ring-blue-200' : ''
      }`}
    >
      <div className="min-w-48 flex-1">
        <div className="flex items-center gap-2">
          {/* Название — вход в настройки: отдельная кнопка «Изменить» в
              строке была бы четвёртой подряд, а по названию кликают и так,
              ожидая карточку. */}
          <button
            type="button"
            onClick={onEdit}
            className="rounded font-medium text-zinc-900 underline-offset-4 transition-colors hover:text-blue-600 hover:underline"
          >
            {campaign.name}
          </button>
          <span className={`rounded-md px-2 py-0.5 text-xs font-medium ${status.className}`}>{status.text}</span>
        </div>
        <div className="mt-1 text-xs text-zinc-500">
          {stats
            ? `${stats.recipients} получателей · отправлено ${stats.sent} · в очереди ${stats.scheduled}`
              + ` · ответили ${stats.replied}${stats.replyRate != null ? ` (${stats.replyRate}%)` : ''}`
              + (stats.bounced ? ` · отбоев ${stats.bounced}${stats.bounceRate != null ? ` (${stats.bounceRate}%)` : ''}` : '')
              + (stats.failed ? ` · ошибок ${stats.failed}` : '')
            : '—'}
          {' · '}
          {campaign.send_hour_from}:00–{campaign.send_hour_to}:00
          {' · '}
          {weekdaysLabel(campaign.send_weekdays ?? [])}
          {' · '}
          {timezoneLabel(campaign.timezone)}
          {poolFromFolder ? ' · ящики возьмёт из папки при запуске' : ''}
        </div>
      </div>

      <div className="flex items-center gap-2">
        {/* База получателей: кому отправлено, кто ответил, кто отбился —
            раньше только сводная строка цифр. */}
        <button
          type="button"
          onClick={onRecipients}
          className="inline-flex items-center gap-1.5 rounded-lg border border-zinc-300 px-3 py-1.5 text-xs text-zinc-700 hover:bg-zinc-100"
        >
          <Users className="h-3.5 w-3.5" />
          База
        </button>

        {campaign.status === 'running' ? (
          <button
            type="button"
            onClick={() => onAction('pause')}
            className="inline-flex items-center gap-1.5 rounded-lg border border-zinc-300 px-3 py-1.5 text-xs text-zinc-700 hover:bg-zinc-100"
          >
            <Pause className="h-3.5 w-3.5" />
            Пауза
          </button>
        ) : campaign.status !== 'done' ? (
          <button
            type="button"
            onClick={() => onAction('start')}
            className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-emerald-500"
          >
            <Play className="h-3.5 w-3.5" />
            Запустить
          </button>
        ) : null}

        {/* Завершение и удаление до сих пор были только в API: кампания
            навсегда оставалась «на паузе», а ненужные черновики копились в
            списке. */}
        {campaign.status !== 'done' ? (
          <button
            type="button"
            onClick={() => onAction('finish')}
            title="Завершить: запланированные письма отменяются"
            className="inline-flex items-center gap-1.5 rounded-lg border border-zinc-300 px-3 py-1.5 text-xs text-zinc-700 hover:bg-zinc-100"
          >
            <Square className="h-3 w-3" />
            Завершить
          </button>
        ) : null}
        {campaign.status !== 'running' ? (
          <button
            type="button"
            onClick={() => onAction('delete')}
            title="Удалить кампанию"
            aria-label="Удалить кампанию"
            className="rounded-lg p-1.5 text-zinc-400 transition-colors hover:bg-zinc-100 hover:text-red-600"
          >
            <Trash2 className="h-4 w-4" />
          </button>
        ) : null}
      </div>
    </div>
  );
}

/**
 * Вкладка «Кампании»: на экране список, создание — в отдельном окне.
 *
 * Форма создания занимала верх страницы всегда, хотя нужна раз в неделю: список
 * кампаний — то, ради чего сюда заходят каждый день, — оказывался под ней и
 * начинался ниже сгиба.
 *
 * Кампании разложены по папкам: каждый запуск автоаутрича RU / EN кнопкой
 * «Залить в Рассылку» заводит свою кампанию в папке своего аутрича, и одним
 * списком они смешались бы с кампаниями, созданными вручную («Остальные»). У
 * папки — «Настройки»: ящики и расписание, которые получит её новая кампания.
 *
 * focusCampaignId — кампания из ссылки (?campaign=<id>, кнопка «Открыть в
 * Рассылке» на экране запуска аутрича): после первой загрузки список
 * прокручивается к ней, и она ненадолго подсвечивается.
 */
export function CampaignsTab({ focusCampaignId = null }: { focusCampaignId?: string | null } = {}) {
  const [campaigns, setCampaigns] = useState<CampaignDto[]>([]);
  // В список влезли не все кампании: сервер отдаёт последние.
  const [truncated, setTruncated] = useState(false);
  const [folders, setFolders] = useState<SenderFolderDto[]>([]);
  const [foldersError, setFoldersError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [formOpen, setFormOpen] = useState(false);
  // Какую кампанию открыли по названию. null — окно создания новой.
  const [editing, setEditing] = useState<CampaignDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  // Кому показать базу получателей (задача 5.2): список с фильтрами и поиском.
  const [recipientsOf, setRecipientsOf] = useState<CampaignDto | null>(null);
  // Папка, чьи настройки открыты.
  const [folderSettings, setFolderSettings] = useState<SenderFolderDto | null>(null);
  // Кампания из ссылки ищется один раз — после первой загрузки: обновление
  // списка после «Запустить» не должно снова дёргать экран к ней.
  const pendingFocus = useRef(focusCampaignId);
  const [highlightId, setHighlightId] = useState<string | null>(null);
  // Кампании из ссылки нет в списке — сказать, а не молча показать список.
  const [linkMissing, setLinkMissing] = useState<string | null>(null);

  const load = useCallback(async () => {
    // Папки и кампании грузятся независимо: не загрузились папки — кампании
    // всё равно видны, просто одним списком.
    const [campaignsRes, foldersRes] = await Promise.allSettled([fetchCampaigns(), fetchFolders()]);
    if (campaignsRes.status === 'fulfilled') {
      const { campaigns: list, truncated: cut } = campaignsRes.value;
      setCampaigns(list);
      setTruncated(Boolean(cut));
      const target = pendingFocus.current;
      if (target) {
        pendingFocus.current = null;
        if (list.some((campaign) => campaign.id === target)) {
          setHighlightId(target);
        } else {
          setLinkMissing(
            cut
              ? 'Кампании из ссылки нет среди последних в списке — более старые сюда не помещаются.'
              : 'Кампания из ссылки не найдена — возможно, её удалили.',
          );
        }
      }
    } else {
      setError(campaignsRes.reason instanceof Error ? campaignsRes.reason.message : 'Не удалось загрузить кампании');
    }
    if (foldersRes.status === 'fulfilled') {
      setFolders(foldersRes.value.folders);
      setFoldersError(null);
    } else {
      setFoldersError(foldersRes.reason instanceof Error ? foldersRes.reason.message : 'ошибка');
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // Строка уже на экране (подсветка ставится вместе со списком) — прокручиваем
  // к ней и через несколько секунд гасим подсветку.
  useEffect(() => {
    if (!highlightId) return;
    document.getElementById(campaignRowId(highlightId))?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    const timer = window.setTimeout(() => setHighlightId(null), HIGHLIGHT_MS);
    return () => window.clearTimeout(timer);
  }, [highlightId]);

  const act = async (campaign: CampaignDto, action: CampaignAction) => {
    if (action === 'finish' && !window.confirm(`Завершить кампанию «${campaign.name}»? Запланированные письма отменятся.`)) {
      return;
    }
    if (action === 'delete' && !window.confirm(deleteConfirmText(campaign))) {
      return;
    }
    try {
      if (action === 'delete') {
        const res = await deleteCampaign(campaign.id);
        const outreachNotice = res.outreach ? deletedOutreachNotice(campaign, res.outreach) : null;
        if (outreachNotice) setNotice(outreachNotice);
      } else {
        const res = await patchCampaign(campaign.id, action);
        // Кампания без ящиков взяла их из папки — об этом стоит сказать:
        // иначе непонятно, с каких ящиков она поехала.
        if (action === 'start' && res.mailboxesAdded) {
          setNotice(`Кампания «${campaign.name}» запущена. Ящики взяты из настроек папки: ${res.mailboxesAdded}.`);
        }
      }
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : ACTION_FAILED[action]);
    }
  };

  const groups = groupCampaigns(campaigns, folders);

  return (
    <div className="space-y-4">
      {notice ? <p className="text-sm text-emerald-600">{notice}</p> : null}
      {error ? <p className="text-sm text-red-600">{error}</p> : null}
      {linkMissing ? <p className="text-sm text-amber-600">{linkMissing}</p> : null}

      <div className="flex flex-wrap items-center justify-between gap-3">
        {folders.length ? (
          <p className="text-sm text-zinc-500">
            Кампании автоаутричей лежат в своих папках, созданные вручную — в «Остальных».
          </p>
        ) : null}
        <button
          type="button"
          onClick={() => setFormOpen(true)}
          className="ml-auto inline-flex items-center gap-1.5 rounded-lg bg-blue-600 px-3.5 py-2 text-sm font-medium text-white transition-colors hover:bg-blue-500"
        >
          <Plus className="h-4 w-4" />
          Кампания
        </button>
      </div>

      {foldersError ? (
        <p className="text-sm text-amber-600">
          Папки не загрузились: {foldersError}
          {folders.length ? '' : '. Кампании показаны одним списком.'}
        </p>
      ) : null}

      {loading ? (
        <div className="flex items-center justify-center gap-2 rounded-xl border border-zinc-200 bg-white px-5 py-10 text-sm text-zinc-500">
          <Loader2 className="h-4 w-4 animate-spin" />
          Загрузка…
        </div>
      ) : (
        groups.map((group) => {
          const folder = group.folder;
          const shown = group.campaigns.length;
          // Счётчик папки — по всей базе: в список влезают только последние
          // кампании, и «3 кампании» при десяти в папке вводили бы в заблуждение.
          const total = folder ? Math.max(folder.campaignCount, shown) : shown;
          return (
            <section key={group.key} className="rounded-xl border border-zinc-200 bg-white">
              <div className="flex flex-wrap items-start justify-between gap-3 border-b border-zinc-200 px-5 py-3">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-baseline gap-x-2">
                    <h2 className="text-base font-semibold text-zinc-900">{group.title}</h2>
                    <span className="text-sm text-zinc-400">
                      {total === shown ? campaignsLabel(total) : `${campaignsLabel(total)}, показаны последние ${shown}`}
                    </span>
                  </div>
                  {folder ? <FolderSummary folder={folder} /> : null}
                </div>
                {folder ? (
                  <button
                    type="button"
                    onClick={() => setFolderSettings(folder)}
                    className="inline-flex items-center gap-1.5 rounded-lg border border-zinc-300 px-3 py-1.5 text-xs text-zinc-700 transition-colors hover:bg-zinc-100"
                  >
                    <Settings className="h-3.5 w-3.5" />
                    Настройки
                  </button>
                ) : null}
              </div>

              {shown > 0 ? (
                <div className="divide-y divide-zinc-100">
                  {group.campaigns.map((campaign) => (
                    <CampaignRow
                      key={campaign.id}
                      campaign={campaign}
                      highlighted={campaign.id === highlightId}
                      onEdit={() => setEditing(campaign)}
                      onRecipients={() => setRecipientsOf(campaign)}
                      onAction={(action) => void act(campaign, action)}
                    />
                  ))}
                </div>
              ) : folder ? (
                <p className="px-5 py-8 text-center text-sm text-zinc-500">
                  Кампаний пока нет. Они появятся здесь после кнопки «Залить в Рассылку» на экране запуска
                  автоаутрича.
                </p>
              ) : (
                <div className="px-5 py-10 text-center">
                  <p className="text-sm text-zinc-500">
                    {folders.length ? 'Кампаний, созданных вручную, пока нет.' : 'Кампаний пока нет.'}
                  </p>
                  <button
                    type="button"
                    onClick={() => setFormOpen(true)}
                    className="mt-3 text-sm text-blue-600 transition-colors hover:text-blue-500"
                  >
                    {folders.length ? 'Создать кампанию' : 'Создать первую'}
                  </button>
                </div>
              )}
            </section>
          );
        })
      )}

      {truncated ? (
        <p className="text-xs text-zinc-500">
          Показаны последние {campaignsLabel(campaigns.length)} — более старые в список не поместились.
        </p>
      ) : null}

      {formOpen || editing ? (
        <CampaignFormModal
          key={editing?.id ?? 'new'}
          campaign={editing ?? undefined}
          onClose={() => {
            setFormOpen(false);
            setEditing(null);
          }}
          onCreated={async ({ notice: savedNotice, error: savedError }) => {
            setNotice(savedNotice ?? null);
            setError(savedError ?? null);
            await load();
          }}
        />
      ) : null}

      {recipientsOf ? (
        <RecipientsModal
          campaign={recipientsOf}
          onClose={() => setRecipientsOf(null)}
        />
      ) : null}

      {folderSettings ? (
        <FolderSettingsModal
          key={folderSettings.id}
          folder={folderSettings}
          onClose={() => setFolderSettings(null)}
          onSaved={(saved, savedNotice) => {
            setFolders((prev) => prev.map((item) => (item.id === saved.id ? saved : item)));
            setNotice(savedNotice);
            setError(null);
          }}
        />
      ) : null}
    </div>
  );
}
