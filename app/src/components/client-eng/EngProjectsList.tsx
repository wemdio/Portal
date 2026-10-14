'use client';

/**
 * Первая точка клиентского ENG-кабинета: форма создания проекта и список
 * проектов. Данные — GET/POST /api/client/eng/projects (роут сам скоупит:
 * только свои). После создания — переход на мастер проекта (research стартует
 * сразу на бэкенде, мастер его поллит).
 *
 * ОДИН АККАУНТ — ОДИН САЙТ (решение владельца 10.10.2026). Форма есть только
 * у аккаунта, у которого список прочитан и пуст. Проект есть — список
 * перенаправляет на Command Center (/client/eng/dashboard); ?list=1 («All
 * projects» с дашборда) редирект отключает и показывает карточки — без формы.
 * Список не прочитан — ни формы, ни карточек: выдумывать «проектов нет»
 * экран не должен. Удалить проект клиент не может (DELETE у роута проекта
 * нет), сменить сайт — через Support: так говорит отказ роута, если проект
 * появился с другой вкладки. На этом отказе список перечитывается, и экран
 * остаётся на карточках с отказом над ними, без редиректа.
 *
 * Поля под сайтом — ответы, которые читает само исследование, а повторить
 * его кликом клиент не может: описание бизнеса (brief.business_override —
 * бриф клиента EN-промпта профиля, всегда, и промпт гипотез) и рамка ЦА
 * (brief.icp — тот же бриф профиля как пожелание, кого достать, и промпт
 * гипотез). Те же ключи brief, что правит шаг «Brief», те же лимиты
 * (BUSINESS_OVERRIDE_MAX_LENGTH, icpFrame.ts), та же проверка рамки до
 * отправки (parseHeIcpFramePatch). Шлётся только заполненное.
 */

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import type { Route } from 'next';
import { useRouter, useSearchParams } from 'next/navigation';
import { ArrowRight, Globe, LayoutDashboard } from 'lucide-react';
import {
  HE_ICP_LINE_MAX_CHARS,
  parseHeIcpFramePatch,
  type HeIcpField,
  type HeIcpFrame,
  type HeIcpFrameInputError,
} from '@/lib/hypothesisEngine/icpFrame';
import { BUSINESS_OVERRIDE_MAX_LENGTH } from '@/lib/hypothesisEngine/projectBriefPatch';
import {
  EngPaidAccessError,
  createEngProject,
  fetchEngProjects,
  type EngProjectListItem,
} from './api-client';
import { EngPaidAccessNotice, EngVerifyEmailBanner } from './EngPaidAccess';
import { engStageErrorText } from './engText';
import { EngBadge, EngCard, EngSpinner, fmtDate, projectStatusTone } from './ui';

/** Подписи рамки ЦА — те же слова, что у шага «Brief». */
const ICP_LABELS: Record<HeIcpField, string> = {
  include: 'Target',
  exclude: 'Never target',
  size: 'Company size',
  geo: 'Geography',
};

/** Отказ проверки рамки — подписями полей формы (`bad_*` форма не шлёт). */
function icpErrorText(err: HeIcpFrameInputError): string {
  switch (err.code) {
    case 'too_many':
      return `${ICP_LABELS[err.field]}: up to ${err.max} lines.`;
    case 'too_long':
      return err.field === 'include' || err.field === 'exclude'
        ? `${ICP_LABELS[err.field]}: each line can be up to ${err.max} characters.`
        : `${ICP_LABELS[err.field]}: up to ${err.max} characters.`;
    default:
      return 'The target audience answers could not be read.';
  }
}

const EMPTY_ICP: Record<HeIcpField, string> = { include: '', exclude: '', size: '', geo: '' };

export function EngProjectsList() {
  const router = useRouter();
  const searchParams = useSearchParams();
  // ?list=1 — явный заход на список (кнопка «All projects» с дашборда):
  // авто-редирект на Command Center отключён, иначе кнопка зациклится.
  const forceList = searchParams?.get('list') === '1';
  const [projects, setProjects] = useState<EngProjectListItem[] | null>(null);
  /** Список не прочитался — текст вместо формы и карточек. */
  const [loadError, setLoadError] = useState('');
  /** Создание не прошло (не отказ гейта) — текст под формой. */
  const [error, setError] = useState('');
  const [website, setWebsite] = useState('');
  const [name, setName] = useState('');
  const [business, setBusiness] = useState('');
  const [icp, setIcp] = useState<Record<HeIcpField, string>>(EMPTY_ICP);
  const [creating, setCreating] = useState(false);
  /** Отказ гейта платных шагов на создании (почта, один сайт, потолок) — с действием. */
  const [refusal, setRefusal] = useState<EngPaidAccessError | null>(null);

  const load = useCallback(async () => {
    try {
      setProjects(await fetchEngProjects());
      setLoadError('');
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : 'Failed to load projects');
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // Отказ «один сайт» показывается над карточками — без редиректа, иначе
  // клиент не прочитал бы, почему проект не создан.
  const holdOnList = forceList || refusal?.code === 'project_limit';

  // Дефолтная точка после логина: с проектом — сразу Command Center.
  useEffect(() => {
    if (!holdOnList && projects && projects.length > 0) {
      router.replace('/client/eng/dashboard' as Route);
    }
  }, [holdOnList, projects, router]);

  const redirecting = !holdOnList && projects !== null && projects.length > 0;

  const onCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (creating || !website.trim()) return;
    setError('');
    setRefusal(null);

    const lines = (text: string) => text.split('\n').filter((line) => line.trim());
    const icpInput: Partial<HeIcpFrame> = {};
    if (lines(icp.include).length > 0) icpInput.include = lines(icp.include);
    if (lines(icp.exclude).length > 0) icpInput.exclude = lines(icp.exclude);
    if (icp.size.trim()) icpInput.size = icp.size;
    if (icp.geo.trim()) icpInput.geo = icp.geo;
    const hasIcp = Object.keys(icpInput).length > 0;
    if (hasIcp) {
      const checked = parseHeIcpFramePatch(icpInput);
      if (!checked.ok) {
        setError(icpErrorText(checked.error));
        return;
      }
    }

    setCreating(true);
    try {
      const res = await createEngProject({
        website_url: website.trim(),
        name: name.trim() || undefined,
        ...(business.trim() ? { business_override: business.trim() } : {}),
        ...(hasIcp ? { icp: icpInput } : {}),
      });
      if (res.project?.id) {
        router.push(`/client/eng/projects/${res.project.id}` as Route);
        return;
      }
      setError(res.error ?? 'Failed to create the project');
    } catch (err) {
      if (err instanceof EngPaidAccessError) {
        setRefusal(err);
        // Проект появился с другой вкладки — экран должен это показать.
        if (err.code === 'project_limit') void load();
      } else {
        setError(err instanceof Error ? err.message : 'Failed to create the project');
      }
    } finally {
      setCreating(false);
    }
  };

  const hint = (text: string) => (
    <span className="text-[11px]" style={{ color: 'var(--cp-text-l)' }}>
      {text}
    </span>
  );

  return (
    <div className="flex flex-col gap-5">
      <EngVerifyEmailBanner />

      {projects === null ? (
        loadError ? (
          <div className="text-sm" style={{ color: 'var(--cp-red)' }}>
            {loadError}
          </div>
        ) : (
          <div className="flex items-center gap-2 text-sm" style={{ color: 'var(--cp-text-m)' }}>
            <EngSpinner /> Loading projects…
          </div>
        )
      ) : projects.length === 0 ? (
        <>
          <EngCard>
            <h3 className="ds-eyebrow mb-3">Your project</h3>
            <form onSubmit={(e) => void onCreate(e)} className="flex flex-col gap-4">
              <div className="flex flex-col gap-3 sm:flex-row">
                <label className="flex-1 flex flex-col gap-1">
                  <span className="text-[11px]" style={{ color: 'var(--cp-text-l)' }}>
                    Website <span aria-hidden>*</span>
                  </span>
                  <input
                    type="text"
                    value={website}
                    onChange={(e) => setWebsite(e.target.value)}
                    placeholder="acme.com"
                    required
                    className="ds-input w-full"
                  />
                  {hint('One account works with one website, so check the address before you start.')}
                </label>
                <label className="flex-1 flex flex-col gap-1">
                  <span className="text-[11px]" style={{ color: 'var(--cp-text-l)' }}>
                    Project name (optional)
                  </span>
                  <input
                    type="text"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder="Acme outbound"
                    className="ds-input w-full"
                  />
                </label>
              </div>

              <label className="flex flex-col gap-1">
                <span className="text-[11px]" style={{ color: 'var(--cp-text-l)' }}>
                  Describe your business (optional)
                </span>
                <textarea
                  value={business}
                  onChange={(e) => setBusiness(e.target.value)}
                  rows={3}
                  maxLength={BUSINESS_OVERRIDE_MAX_LENGTH}
                  placeholder="What you sell and why clients pick you"
                  className="ds-input w-full resize-y"
                />
                {hint(
                  'The research takes this as facts about your business: it builds your company profile from your site '
                    + 'and this text, and reads it again when it drafts your market hypotheses. Where the two differ, this '
                    + 'text wins; if your site has little text or does not open, the profile is built mostly from it.',
                )}
              </label>

              <fieldset className="flex flex-col gap-2">
                <legend className="text-[11px]" style={{ color: 'var(--cp-text-l)' }}>
                  Who do you sell to? (optional)
                </legend>
                <div className="grid gap-3 sm:grid-cols-2">
                  {(['include', 'exclude'] as const).map((field) => (
                    <label key={field} className="flex flex-col gap-1">
                      <span className="text-[11px]" style={{ color: 'var(--cp-text-l)' }}>
                        {ICP_LABELS[field]} (one per line)
                      </span>
                      <textarea
                        value={icp[field]}
                        onChange={(e) => setIcp((cur) => ({ ...cur, [field]: e.target.value }))}
                        rows={2}
                        placeholder={
                          field === 'include'
                            ? 'e.g. Multi-location dental groups\nIndependent orthodontic practices'
                            : 'e.g. Hospitals\nDental schools'
                        }
                        className="ds-input w-full resize-y"
                      />
                    </label>
                  ))}
                  {(['size', 'geo'] as const).map((field) => (
                    <label key={field} className="flex flex-col gap-1">
                      <span className="text-[11px]" style={{ color: 'var(--cp-text-l)' }}>
                        {ICP_LABELS[field]}
                      </span>
                      <input
                        type="text"
                        value={icp[field]}
                        onChange={(e) => setIcp((cur) => ({ ...cur, [field]: e.target.value }))}
                        maxLength={HE_ICP_LINE_MAX_CHARS}
                        placeholder={field === 'size' ? 'e.g. 20–500 employees' : 'e.g. Texas and Florida'}
                        className="ds-input w-full"
                      />
                    </label>
                  ))}
                </div>
                {hint('These answers steer which market hypotheses the research proposes.')}
              </fieldset>

              <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                <button
                  type="submit"
                  disabled={creating || !website.trim()}
                  className="ds-btn-primary inline-flex items-center gap-2 self-start"
                >
                  {creating && <EngSpinner />}
                  Create &amp; start research
                </button>
                {hint(
                  'Research starts right away: we profile the site, map competitors and find the markets that could buy '
                    + 'your offer.',
                )}
              </div>
            </form>
          </EngCard>

          {error && (
            <div className="text-sm" style={{ color: 'var(--cp-red)' }}>
              {error}
            </div>
          )}
          {refusal && <EngPaidAccessNotice refusal={refusal} />}
          {/* Перечитать список после отказа «один сайт» не вышло. */}
          {loadError && (
            <div className="text-sm" style={{ color: 'var(--cp-red)' }}>
              {loadError}
            </div>
          )}
        </>
      ) : redirecting ? (
        <div className="flex items-center gap-2 text-sm" style={{ color: 'var(--cp-text-m)' }}>
          <EngSpinner /> Opening the Command Center…
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          {refusal && <EngPaidAccessNotice refusal={refusal} />}
          <div className="flex justify-end">
            <Link
              href={'/client/eng/dashboard' as Route}
              prefetch={false}
              className="ds-btn-secondary inline-flex items-center gap-1.5 text-xs"
            >
              <LayoutDashboard className="h-3.5 w-3.5" />
              Command Center
            </Link>
          </div>
          <div className="grid gap-3 md:grid-cols-2">
            {projects.map((p) => (
              <Link
                key={p.id}
                href={`/client/eng/projects/${p.id}` as Route}
                prefetch={false}
                className="ds-card ds-card-pressable p-4 flex flex-col gap-2"
              >
                <div className="flex items-center gap-2">
                  <Globe className="h-4 w-4 shrink-0" style={{ color: 'var(--cp-text-l)' }} />
                  <span className="truncate text-sm font-semibold" style={{ color: 'var(--cp-paper)' }}>
                    {p.name}
                  </span>
                  <span className="ml-auto shrink-0">
                    <EngBadge label={p.status} tone={projectStatusTone(p.status)} />
                  </span>
                </div>
                <div className="truncate text-xs" style={{ color: 'var(--cp-text-l)' }}>
                  {p.website_url}
                </div>
                <div
                  className="mt-1 flex items-center gap-3 text-[11px] ds-mono"
                  style={{ color: 'var(--cp-text-m)' }}
                >
                  <span>{p.vertical_count} markets</span>
                  <span>{p.base_count} bases</span>
                  <span className="ml-auto inline-flex items-center gap-1">
                    {fmtDate(p.created_at)}
                    <ArrowRight className="h-3 w-3" />
                  </span>
                </div>
                {/* he_projects.error (воркер пишет туда русский текст стадии с
                    префиксом её имени) в кабинет не доезжает вовсе: роут отдаёт
                    код причины, экран — английское объяснение по коду. */}
                {p.error_code && (
                  <div className="text-[11px]" style={{ color: 'var(--cp-red)' }}>
                    {engStageErrorText(p.error_code, 'research')}
                  </div>
                )}
              </Link>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
