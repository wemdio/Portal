'use client';

/**
 * Шаг 1 «Brief» клиентского ENG-кабинета: карточки site_profile (что движок
 * понял с сайта), редактируемые offer/style/signature overrides (уточняют
 * генерацию писем), настройка проекта «до N адресов одной компании» и
 * «Re-run research» с дедупом на бэкенде.
 *
 * «Re-run research» удаляет оплаченное: кластеризация пересобирает вертикали, и
 * каскадом уходят базы, шаблоны, цепочки писем, вокабуляры и досье вертикалей.
 * Поэтому роут отвечает 409 со списком последствий, экран показывает их в
 * диалоге и только после явного согласия повторяет запрос с confirm: true.
 * Запущенный проект и проект с идущей работой роут отклоняет и с
 * подтверждением — текст отказа приходит с сервера.
 *
 * Настройка живёт здесь, а не на шаге сборки баз: это ДЕФОЛТ ПРОЕКТА для всех
 * будущих сборок (на поставленной базе лимит уже проштампован), то есть тот же
 * уровень, что и остальные настройки проекта на этом шаге.
 */

import { useEffect, useMemo, useState } from 'react';
import { RefreshCw, Save } from 'lucide-react';
import {
  patchEngProject,
  startEngResearch,
  type EngResearchRerunConsequences,
  type HeJobSummary,
} from './api-client';
import { EngBadge, EngCard, EngEyebrow, EngSpinner } from './ui';
import type { EngDetail } from './EngProjectWizard';

const RESEARCH_STAGES = ['site_profile', 'competitors', 'brand_cloud', 'hypotheses', 'evidence', 'clustering'];

/** Подписи полей site_profile (EN) в порядке показа. */
const PROFILE_FIELDS: Array<{ key: string; label: string }> = [
  { key: 'company_name', label: 'Company' },
  { key: 'product_summary', label: 'Product' },
  { key: 'usp', label: 'USP' },
  { key: 'target_audience', label: 'Target audience' },
  { key: 'business_model', label: 'Business model' },
  { key: 'price_tier', label: 'Price tier' },
  { key: 'deal_cycle', label: 'Deal cycle' },
  { key: 'geo', label: 'Geo' },
  { key: 'current_clients', label: 'Current clients' },
  { key: 'cases', label: 'Cases' },
];

/**
 * Варианты «сколько адресов одной компании брать в работу». Список короткий
 * намеренно: роут принимает 1..100, но клиенту нужен выбор, а не поле ввода с
 * границами, которые он должен угадывать.
 */
const CONTACT_CAP_OPTIONS = [1, 2, 3, 5, 10];

/**
 * Что действует, пока клиент ничего не выбрал. Зеркалит
 * HE_MAX_EMAILS_PER_COMPANY_DEFAULT движка; импортировать константу нельзя —
 * модуль постановки сборки уехал бы в клиентский бандл вместе с именами таблиц
 * и логикой дедупа. Авторитет всё равно на сервере: пустая колонка = дефолт
 * движка, а сохранённый выбор уезжает числом.
 */
const CONTACT_CAP_DEFAULT = 5;

/**
 * Действующее значение из строки проекта. Тип `EngProject` (api-client) поле
 * пока не объявляет — читаем через unknown, а не расширяем чужой DTO.
 * Границы не проверяем: их держит check-ограничение колонки, здесь достаточно
 * «целое положительное», иначе показываем дефолт.
 */
function contactCapOf(project: unknown): number {
  const raw = (project as { max_emails_per_company?: unknown } | null)?.max_emails_per_company;
  return typeof raw === 'number' && Number.isSafeInteger(raw) && raw > 0 ? raw : CONTACT_CAP_DEFAULT;
}

/** «1 audience» / «3 audiences»; число — en-US. */
function plural(n: number, one: string, many: string): string {
  return `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;
}

/**
 * Пункты диалога — только то, что в ответе роута не ноль. Каждый пункт правдив
 * для любого набора чисел:
 *  - аудитория — любая база, кроме упавшей без строк (её роут в счёт не берёт).
 *    Поэтому «audience», а не «collected audience»: в счёт входит и база, которая
 *    ещё собирается (у неё может быть 0 строк). Строки — в скобках и только
 *    ненулевые; `rows` — строки базы, то есть адреса, не компании, поэтому и
 *    подпись «rows»;
 *  - шаблоны, цепочки писем, вокабуляры и досье вертикалей — строки, которые
 *    удалит каскад кластеризации; цепочки, вокабуляры и досье роут считает без
 *    упавших (status 'failed'), а пишут их стадии сразу готовыми.
 */
function rerunConsequenceLines(c: EngResearchRerunConsequences): string[] {
  const lines: string[] = [];
  if (c.audiences > 0) {
    lines.push(
      `${plural(c.audiences, 'audience', 'audiences')}${c.rows > 0 ? ` (${plural(c.rows, 'row', 'rows')})` : ''}`,
    );
  }
  if (c.templates > 0) lines.push(plural(c.templates, 'letter template', 'letter templates'));
  if (c.letter_sequences > 0) {
    lines.push(`${plural(c.letter_sequences, 'letter sequence', 'letter sequences')} written for your verticals`);
  }
  if (c.vocabularies > 0) {
    lines.push(`${plural(c.vocabularies, 'targeting vocabulary', 'targeting vocabularies')} built for your verticals`);
  }
  if (c.dossiers > 0) {
    lines.push(`${plural(c.dossiers, 'market dossier', 'market dossiers')} built for your verticals`);
  }
  return lines;
}

function isResearchActive(jobs: HeJobSummary[]): boolean {
  return jobs.some(
    (j) => RESEARCH_STAGES.includes(j.stage) && (j.status === 'pending' || j.status === 'running'),
  );
}

/**
 * Подсказка у поля «Business description» — по тому, ЧТО именно вышло с сайтом.
 *
 * Два факта, не один. `site_unreachable` — сайт не открылся (домена нет в DNS
 * либо ни один адрес не отдал HTML): читать было нечего вообще, и описание
 * бизнеса здесь не «рекомендуем», а единственный способ доделать research —
 * стадия без него отказывает, и тот же экран показывает карточку отказа.
 * `site_thin` — сайт открылся, но текста мало (или это JS-заглушка); стадия
 * доработала, описание улучшает результат. Стадия ставит `site_thin` и в первом
 * случае тоже, поэтому порядок проверок именно такой, иначе мёртвый домен
 * рассказывал бы клиенту про «мало текста».
 *
 * Оба поля приходят БУЛЕВЫМИ из проекции кабинета (clientEngProjection):
 * служебная пометка стадии с русской причиной в кабинет не уезжает.
 *
 * ОБА ФАКТА — ПРО ПОСЛЕДНЮЮ ЗАПИСАННУЮ ПРОВЕРКУ САЙТА, А НЕ ПРО СЕЙЧАС. Стадия
 * пишет их ровно в двух местах: отказом «сайт не открылся» и финальной записью
 * удачного прогона. Прогон, который сайт открыл, но упал дальше (биллинг,
 * таймаут модели, отмена), не пишет ничего — пометка прошлого прогона остаётся.
 * Поэтому подсказка говорит в прошедшем времени и ставит условие: «нужно, если
 * сайт всё ещё не открывается». В настоящем времени («we could not open your
 * site») она была ложью рядом с карточкой биллинга, когда сайт уже ожил.
 */
function businessDescriptionHint(brief: Record<string, unknown>): string {
  if (brief.site_unreachable === true) {
    return ' — required while your site does not open: our last recorded check could not open it';
  }
  if (brief.site_thin === true) {
    return ' — recommended: our last recorded read of your site found very little text';
  }
  return '';
}

/** Значение поля site_profile → строка (массивы — списком через точку с запятой). */
function profileValue(value: unknown): string {
  if (Array.isArray(value)) {
    return value.filter((v): v is string => typeof v === 'string' && v.trim() !== '').join('; ');
  }
  if (typeof value === 'string') return value;
  return '';
}

export function EngStepBrief({ detail, onChanged }: { detail: EngDetail; onChanged: () => void }) {
  const { project, jobs = [] } = detail;
  const brief = (project.brief ?? {}) as Record<string, unknown>;
  const siteProfile = (brief.site_profile ?? null) as Record<string, unknown> | null;
  const businessHint = businessDescriptionHint(brief);

  const [offer, setOffer] = useState('');
  const [style, setStyle] = useState('');
  const [signature, setSignature] = useState('');
  const [business, setBusiness] = useState('');
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState(0);
  const [researchBusy, setResearchBusy] = useState(false);
  // Открытый диалог подтверждения повторного исследования (null — закрыт).
  const [rerunConfirm, setRerunConfirm] = useState<EngResearchRerunConsequences | null>(null);
  const [error, setError] = useState('');
  // Селект настройки: начальное значение берём из проекта сразу (в отличие от
  // overrides, пустое поле здесь означало бы «одна компания = один адрес»).
  const [cap, setCap] = useState(() => contactCapOf(project));
  const [capSaving, setCapSaving] = useState(false);
  const [capSavedAt, setCapSavedAt] = useState(0);

  // Перечитываем overrides из деталки (первый рендер и после поллов) —
  // React-паттерн «правка state при смене пропа во время рендера», как в
  // client/layout (prevActiveId), без set-state-in-effect.
  const [prevUpdatedAt, setPrevUpdatedAt] = useState(project.updated_at);
  if (project.updated_at !== prevUpdatedAt) {
    setPrevUpdatedAt(project.updated_at);
    setOffer(typeof brief.offer_override === 'string' ? brief.offer_override : '');
    setStyle(typeof brief.style_override === 'string' ? brief.style_override : '');
    setSignature(typeof brief.signature_override === 'string' ? brief.signature_override : '');
    setBusiness(typeof brief.business_override === 'string' ? brief.business_override : '');
    setCap(contactCapOf(project));
  }

  const researchActive = useMemo(() => isResearchActive(jobs), [jobs]);

  // Значение, выставленное вне этого селекта (поддержка попросила 7), обязано
  // остаться видимым: иначе экран показывал бы не то, что действует.
  const capOptions = useMemo(
    () => (CONTACT_CAP_OPTIONS.includes(cap) ? CONTACT_CAP_OPTIONS : [...CONTACT_CAP_OPTIONS, cap].sort((a, b) => a - b)),
    [cap],
  );

  const onSave = async () => {
    if (saving) return;
    setSaving(true);
    setError('');
    try {
      await patchEngProject(project.id, {
        offer_override: offer,
        style_override: style,
        signature_override: signature,
        business_override: business,
      });
      setSavedAt(Date.now());
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to save');
    } finally {
      setSaving(false);
    }
  };

  const onSaveCap = async () => {
    if (capSaving) return;
    setCapSaving(true);
    setError('');
    try {
      // Тело PATCH в api-client объявлено только полями брифа — расширяем тип
      // на месте вызова, чтобы не править общий модуль чужой полосы (см.
      // handoff в отчёте). На провод уезжает { max_emails_per_company: <число> }.
      const body: Parameters<typeof patchEngProject>[1] & { max_emails_per_company: number } = {
        max_emails_per_company: cap,
      };
      const saved = await patchEngProject(project.id, body);
      // Показываем то, что БД действительно сохранила (ответ идёт через ту же
      // клиентскую проекцию, что и деталка): `updated_at` у he_projects по этой
      // записи не меняется, поэтому блок перечитывания деталки выше не
      // сработает и синхронизировать селект больше нечему.
      setCap(contactCapOf(saved?.project));
      setCapSavedAt(Date.now());
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to save');
    } finally {
      setCapSaving(false);
    }
  };

  // Первый клик идёт БЕЗ подтверждения: если удалять нечего, исследование
  // просто стартует. Если есть — сервер отвечает 409 с последствиями, и
  // открывается диалог; confirm: true уходит только из его кнопки.
  const onResearch = async (confirmed: boolean) => {
    if (researchBusy || researchActive) return;
    setResearchBusy(true);
    setError('');
    try {
      const res = await startEngResearch(project.id, confirmed ? { confirm: true } : undefined);
      if (res.kind === 'confirm_required') {
        setRerunConfirm(res.consequences);
        return;
      }
      setRerunConfirm(null);
      onChanged();
    } catch (e) {
      setRerunConfirm(null);
      setError(e instanceof Error ? e.message : 'Failed to start research');
    } finally {
      setResearchBusy(false);
    }
  };

  // Escape закрывает диалог, как и клик по подложке.
  useEffect(() => {
    if (!rerunConfirm) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setRerunConfirm(null);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [rerunConfirm]);

  return (
    <div className="flex flex-col gap-4">
      <EngCard>
        <div className="flex items-center gap-2">
          <EngEyebrow>Site profile</EngEyebrow>
          <span className="mb-2">
            {researchActive ? (
              <span className="inline-flex items-center gap-1.5 text-[11px]" style={{ color: 'var(--cp-amber)' }}>
                <EngSpinner className="h-3 w-3" /> research in progress…
              </span>
            ) : (
              <EngBadge label={project.status} tone={project.status === 'researched' ? 'green' : 'neutral'} />
            )}
          </span>
          <button
            type="button"
            onClick={() => void onResearch(false)}
            disabled={researchBusy || researchActive}
            className="ds-btn-ghost ml-auto mb-2 inline-flex items-center gap-1.5 text-[11px]"
          >
            {researchBusy ? <EngSpinner className="h-3 w-3" /> : <RefreshCw className="h-3 w-3" />}
            Re-run research
          </button>
        </div>

        {siteProfile ? (
          <dl className="grid gap-3 sm:grid-cols-2">
            {PROFILE_FIELDS.map(({ key, label }) => {
              const value = profileValue(siteProfile[key]);
              if (!value) return null;
              return (
                <div
                  key={key}
                  className="rounded-md p-3"
                  style={{ border: '1px solid var(--cp-divider)' }}
                >
                  <dt className="text-[10px] font-semibold uppercase tracking-wide" style={{ color: 'var(--cp-text-l)' }}>
                    {label}
                  </dt>
                  <dd className="mt-1 text-sm whitespace-pre-wrap" style={{ color: 'var(--cp-paper)' }}>
                    {value}
                  </dd>
                </div>
              );
            })}
          </dl>
        ) : (
          <p className="text-sm" style={{ color: 'var(--cp-text-m)' }}>
            {researchActive
              ? 'Profiling the site — the brief will appear here as soon as the research finishes.'
              : 'No site profile yet. Run the research to build it from your website.'}
          </p>
        )}
      </EngCard>

      <EngCard>
        <EngEyebrow>Offer &amp; style overrides</EngEyebrow>
        <p className="mb-3 text-[11px]" style={{ color: 'var(--cp-text-l)' }}>
          These notes steer letter generation. Leave empty to use what the research inferred.
        </p>
        <div className="flex flex-col gap-3">
          <label className="flex flex-col gap-1">
            <span className="text-[11px] font-semibold" style={{ color: businessHint ? 'var(--cp-amber)' : 'var(--cp-text-m)' }}>
              Business description (manual, max 3000 chars)
              {businessHint}
            </span>
            <textarea
              value={business}
              onChange={(e) => setBusiness(e.target.value)}
              rows={4}
              maxLength={3000}
              placeholder="What you sell, to whom, and why clients pick you. Used above the site profile when the site is thin, JS-heavy, or could not be opened at all."
              className="ds-input w-full resize-y"
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-[11px] font-semibold" style={{ color: 'var(--cp-text-m)' }}>
              Offer override
            </span>
            <textarea
              value={offer}
              onChange={(e) => setOffer(e.target.value)}
              rows={2}
              placeholder="e.g. 4–6 qualified meetings per month with US clinic owners, pay-per-meeting"
              className="ds-input w-full resize-y"
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-[11px] font-semibold" style={{ color: 'var(--cp-text-m)' }}>
              Style reference (1–2 “perfect” emails to imitate)
            </span>
            <textarea
              value={style}
              onChange={(e) => setStyle(e.target.value)}
              rows={4}
              placeholder="Paste an email whose tone the generator should copy"
              className="ds-input w-full resize-y"
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-[11px] font-semibold" style={{ color: 'var(--cp-text-m)' }}>
              Sender signature (used verbatim at the end of every letter)
            </span>
            <textarea
              value={signature}
              onChange={(e) => setSignature(e.target.value)}
              rows={2}
              placeholder="Jane Doe, Acme, acme.com"
              className="ds-input w-full resize-y"
            />
          </label>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => void onSave()}
              disabled={saving}
              className="ds-btn-primary inline-flex items-center gap-1.5 text-xs"
            >
              {saving ? <EngSpinner className="h-3 w-3" /> : <Save className="h-3 w-3" />}
              Save overrides
            </button>
            {savedAt > 0 && !saving && (
              <span className="text-[11px]" style={{ color: 'var(--cp-green)' }}>
                Saved
              </span>
            )}
          </div>
        </div>
      </EngCard>

      <EngCard>
        <EngEyebrow>Contacts per company</EngEyebrow>
        <p className="mb-3 text-[11px]" style={{ color: 'var(--cp-text-l)' }}>
          The most people we may write to at one company. Applies to lists collected from now on —
          a list you have already collected keeps the number it was collected with.
        </p>
        <div className="flex flex-wrap items-end gap-3">
          <label className="text-[10px]" style={{ color: 'var(--cp-text-l)' }}>
            Email addresses per company
            <select
              value={cap}
              onChange={(e) => setCap(Number(e.target.value))}
              className="ds-input mt-1 w-full text-xs"
            >
              {capOptions.map((n) => (
                <option key={n} value={n}>
                  {n === 1 ? 'Up to 1 address' : `Up to ${n} addresses`}
                </option>
              ))}
            </select>
          </label>
          <button
            type="button"
            onClick={() => void onSaveCap()}
            disabled={capSaving}
            className="ds-btn-primary inline-flex items-center gap-1.5 text-xs"
          >
            {capSaving ? <EngSpinner className="h-3 w-3" /> : <Save className="h-3 w-3" />}
            Save
          </button>
          {capSavedAt > 0 && !capSaving && (
            <span className="text-[11px]" style={{ color: 'var(--cp-green)' }}>
              Saved
            </span>
          )}
        </div>
      </EngCard>

      {error && (
        <div className="text-sm" style={{ color: 'var(--cp-red)' }}>
          {error}
        </div>
      )}

      {rerunConfirm && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="eng-rerun-research-title"
          onClick={() => setRerunConfirm(null)}
          className="fixed inset-0 z-[100] flex items-center justify-center p-4"
          style={{ background: 'rgba(0,0,0,0.6)' }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            className="ds-card w-full max-w-md p-5"
            style={{ background: 'var(--cp-surface-elev)' }}
          >
            <h2 id="eng-rerun-research-title" className="text-base font-bold mb-2" style={{ color: 'var(--cp-paper)' }}>
              Re-run research?
            </h2>
            {/* «When the new research finishes»: удаляет последняя стадия
                (кластеризация); исследование, упавшее раньше неё, ничего не
                удалит, поэтому безусловное «is deleted» было бы неправдой. */}
            <p className="text-sm mb-2" style={{ color: 'var(--cp-text-m)' }}>
              When the new research finishes, it rebuilds the verticals of this project from scratch and
              deletes everything built on the current ones. This cannot be undone.
            </p>
            {rerunConsequenceLines(rerunConfirm).length > 0 && (
              <>
                <p className="text-sm mb-1" style={{ color: 'var(--cp-text-m)' }}>
                  Built on the current verticals now:
                </p>
                <ul className="mb-3 list-disc pl-5 text-sm" style={{ color: 'var(--cp-paper)' }}>
                  {rerunConsequenceLines(rerunConfirm).map((line) => (
                    <li key={line}>{line}</li>
                  ))}
                </ul>
              </>
            )}
            <p className="text-[11px] mb-4" style={{ color: 'var(--cp-text-l)' }}>
              The verticals themselves come from the new research, so they may differ from the ones you see
              now.
            </p>
            <div className="flex flex-wrap items-center gap-3">
              <button
                type="button"
                onClick={() => void onResearch(true)}
                disabled={researchBusy}
                className="ds-btn-primary inline-flex items-center gap-1.5 text-xs"
                style={{ background: 'var(--cp-red)' }}
              >
                {researchBusy ? <EngSpinner className="h-3 w-3" /> : <RefreshCw className="h-3 w-3" />}
                Delete and re-run research
              </button>
              <button
                type="button"
                onClick={() => setRerunConfirm(null)}
                disabled={researchBusy}
                className="ds-btn-ghost text-xs"
              >
                Keep everything
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
