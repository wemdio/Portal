'use client';

import { useState, useEffect, useRef } from 'react';
import { Project, ProjectNote, ProjectStatus, Task, TaskStatus, UserProfile } from '@/types';
import { supabase } from '@/lib/supabaseClient';
import { authFetch } from '@/lib/authFetch';
import Link from 'next/link';
import { canCreateProjects, canEditProjects, canDeleteProjects } from '@/lib/roles';
import { useUser } from '@/lib/UserProvider';
import { logAudit, logError } from '@/lib/loggerClient';
import { useIsTma } from '@/lib/useIsTma';
import { buildAssigneeOptions, buildRenameMap, ensureCurrentAssigneeOption } from '@/lib/projectAssignees';
import { normalizePublicAvatarUrl } from '@/lib/publicAvatarUrl';
import { AlertTriangle, Clock } from 'lucide-react';
import { ProjectBriefSection } from '@/components/projects/ProjectBriefSection';
import { SERVICE_OPTIONS } from '@/lib/projectServices';

/**
 * Формат темпа для tooltip'ов «Анализ KPI» и «Анализ контактов».
 * Раньше показывали Math.round(avgPerDay) — для медленных проектов
 * (типичный b2b: 3 лида за 14 дней = 0.21/день) выходило 0, и юзер видел
 * «темп 0, нет прогноза», хотя на самом деле проект движется.
 *
 * Правила:
 *   - ≥10 → целое («15/день»)
 *   - ≥1  → 1 знак после запятой («2.4/день»)
 *   - >0  → 2 знака («0.21/день»)
 *   - =0  → «0»
 */
function formatPaceValue(v: number): string {
  if (v >= 10) return Math.round(v).toString();
  if (v >= 1) return v.toFixed(1);
  if (v > 0) return v.toFixed(2);
  return '0';
}
import {
  loadAllProjectsPace,
  loadContactsPaceData,
  loadKpiPaceData,
  summarizeProjectRisk,
  type PaceData,
  type ProjectPace,
  type ProjectPaceInput,
} from '@/lib/projects/paceCalculator';

type ViewMode = 'table' | 'cards' | 'kanban';

/* ── KPI pace tooltip (hover on KPI Факт cell) ── */

function KpiPaceTooltip({
  projectId, kpiPlan, kpiFact, deadline, children,
}: {
  projectId: string; kpiPlan: number; kpiFact: number; deadline: string | null;
  children: React.ReactNode;
}) {
  const [pace, setPace] = useState<PaceData | null>(null);
  const [loading, setLoading] = useState(false);
  const [show, setShow] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const loadPace = async () => {
    if (pace || loading || kpiPlan <= 0) return;
    setLoading(true);
    try {
      const result = await loadKpiPaceData(supabase, {
        projectId,
        kpiPlan,
        kpiFact,
        deadline,
      });
      if (result) setPace(result);
    } catch { /* ignore */ }
    finally { setLoading(false); }
  };

  const handleEnter = () => {
    timerRef.current = setTimeout(() => { setShow(true); void loadPace(); }, 400);
  };
  const handleLeave = () => {
    if (timerRef.current) clearTimeout(timerRef.current);
    setShow(false);
  };

  if (kpiPlan <= 0) return <>{children}</>;

  return (
    <div className="relative" onMouseEnter={handleEnter} onMouseLeave={handleLeave}>
      {children}
      {show && (
        <div className="absolute z-50 bottom-full left-1/2 -translate-x-1/2 mb-2 w-64 rounded-lg border border-zinc-200 bg-white p-3 shadow-xl text-xs text-zinc-700 pointer-events-none">
          <div className="absolute top-full left-1/2 -translate-x-1/2 -mt-px border-4 border-transparent border-t-white" />
          <div className="absolute top-full left-1/2 -translate-x-1/2 border-4 border-transparent border-t-zinc-200" />
          {loading ? (
            <div className="text-center text-zinc-400">Загрузка...</div>
          ) : !pace || pace.dataPoints < 2 ? (
            <div className="text-center text-zinc-400">Недостаточно данных (нужно 2+ дня)</div>
          ) : (
            <div className="space-y-1.5">
              <div className="font-semibold text-zinc-900 text-[13px]">Анализ KPI</div>
              <div className="flex justify-between">
                <span className="text-zinc-500">Темп</span>
                <span className="font-medium tabular-nums">~{formatPaceValue(pace.avgPerDay)}/день</span>
              </div>
              <div className="flex justify-between">
                <span className="text-zinc-500">Осталось</span>
                <span className="font-medium tabular-nums">{pace.remaining}</span>
              </div>
              {pace.forecastDays !== null && pace.forecastDays > 0 && (
                <div className="flex justify-between">
                  <span className="text-zinc-500">Прогноз</span>
                  <span className="font-medium tabular-nums">{pace.forecastDays} дн. ({pace.forecastDate})</span>
                </div>
              )}
              {pace.forecastDays === 0 && (
                <div className="text-emerald-600 font-medium">KPI выполнен</div>
              )}
              {pace.deadline && (
                <>
                  <div className="flex justify-between">
                    <span className="text-zinc-500">Дедлайн</span>
                    <span className="font-medium">{new Date(pace.deadline).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' })}</span>
                  </div>
                  {pace.onTrack !== null && (
                    <div className={`flex items-center gap-1 font-medium ${pace.onTrack ? 'text-emerald-600' : 'text-red-500'}`}>
                      {pace.onTrack ? '✓ Успеваем' : '✗ Не успеваем'}
                      {!pace.onTrack && pace.requiredPace !== null && (
                        <span className="text-zinc-400 font-normal ml-1">(нужно ~{pace.requiredPace}/день)</span>
                      )}
                    </div>
                  )}
                </>
              )}
              <div className="text-[10px] text-zinc-400 pt-0.5 border-t border-zinc-100">
                На основе {pace.periodDays} дн. ({pace.dataPoints} точек)
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/* ── Contacts pace tooltip (hover on contacts cell) ── */

function ContactsPaceTooltip({
  projectId, obligation, done, deadline, children,
}: {
  projectId: string; obligation: number; done: number; deadline: string | null;
  children: React.ReactNode;
}) {
  const [pace, setPace] = useState<PaceData | null>(null);
  const [loading, setLoading] = useState(false);
  const [show, setShow] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const loadPace = async () => {
    if (pace || loading || obligation <= 0) return;
    setLoading(true);
    try {
      const result = await loadContactsPaceData(supabase, {
        projectId,
        obligation,
        done,
        deadline,
      });
      if (result) setPace(result);
    } catch { /* ignore */ }
    finally { setLoading(false); }
  };

  const handleEnter = () => {
    timerRef.current = setTimeout(() => { setShow(true); void loadPace(); }, 400);
  };
  const handleLeave = () => {
    if (timerRef.current) clearTimeout(timerRef.current);
    setShow(false);
  };

  if (obligation <= 0) return <>{children}</>;

  return (
    <div className="relative" onMouseEnter={handleEnter} onMouseLeave={handleLeave}>
      {children}
      {show && (
        <div className="absolute z-50 bottom-full left-1/2 -translate-x-1/2 mb-2 w-64 rounded-lg border border-zinc-200 bg-white p-3 shadow-xl text-xs text-zinc-700 pointer-events-none">
          <div className="absolute top-full left-1/2 -translate-x-1/2 -mt-px border-4 border-transparent border-t-white" />
          <div className="absolute top-full left-1/2 -translate-x-1/2 border-4 border-transparent border-t-zinc-200" />
          {loading ? (
            <div className="text-center text-zinc-400">Загрузка...</div>
          ) : !pace || pace.dataPoints < 2 ? (
            <div className="text-center text-zinc-400">Недостаточно данных (нужно 2+ дня)</div>
          ) : (
            <div className="space-y-1.5">
              <div className="font-semibold text-zinc-900 text-[13px]">Анализ темпа</div>
              <div className="flex justify-between">
                <span className="text-zinc-500">Темп</span>
                <span className="font-medium tabular-nums">~{formatPaceValue(pace.avgPerDay)}/день</span>
              </div>
              <div className="flex justify-between">
                <span className="text-zinc-500">Осталось</span>
                <span className="font-medium tabular-nums">{pace.remaining.toLocaleString('ru-RU')}</span>
              </div>
              {pace.forecastDays !== null && pace.forecastDays > 0 && (
                <div className="flex justify-between">
                  <span className="text-zinc-500">Прогноз</span>
                  <span className="font-medium tabular-nums">{pace.forecastDays} дн. ({pace.forecastDate})</span>
                </div>
              )}
              {pace.forecastDays === 0 && (
                <div className="text-emerald-600 font-medium">Обязательство выполнено</div>
              )}
              {pace.deadline && (
                <>
                  <div className="flex justify-between">
                    <span className="text-zinc-500">Дедлайн</span>
                    <span className="font-medium">{new Date(pace.deadline).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' })}</span>
                  </div>
                  {pace.onTrack !== null && (
                    <div className={`flex items-center gap-1 font-medium ${pace.onTrack ? 'text-emerald-600' : 'text-red-500'}`}>
                      {pace.onTrack ? '✓ Успеваем' : '✗ Не успеваем'}
                      {!pace.onTrack && pace.requiredPace !== null && (
                        <span className="text-zinc-400 font-normal ml-1">(нужно ~{pace.requiredPace}/день)</span>
                      )}
                    </div>
                  )}
                </>
              )}
              <div className="text-[10px] text-zinc-400 pt-0.5 border-t border-zinc-100">
                На основе {pace.periodDays} дн. ({pace.dataPoints} точек)
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

const WORK_FORMAT_OPTIONS = ['Колди', 'Тригга', 'Инстантли'];
const LEAD_SOURCE_OPTIONS = ['Аутрич', 'Телеграм', 'Лидскан', 'ЛинкедИн', 'Перфоманс', 'Органика', 'Партнер'];
const PROJECT_TYPE_OPTIONS = ['Продажа', 'Продление'];
const STATUS_OPTIONS = ['В работе', 'Тестирование', 'На паузе', 'Подготовка', 'Завершен', 'Отменен'];

/** Parse comma-separated services string into array */
const parseServices = (value: string | undefined | null): string[] => {
  if (!value) return [];
  return value.split(',').map((s) => s.trim()).filter(Boolean);
};

function resolveWorkFormat(value: string) {
  if (!value) return '';
  const match = WORK_FORMAT_OPTIONS.find(
    (option) => option.toLowerCase() === value.toLowerCase(),
  );
  return match ?? value;
}

const STATUS_CONFIG: Record<string, { label: string; color: string; bg: string; border: string }> = {
  'в работе': { label: 'В работе', color: 'text-emerald-700', bg: 'bg-emerald-50/50', border: 'border-emerald-200/50' },
  'тестирование': { label: 'Тестирование', color: 'text-blue-700', bg: 'bg-blue-50/50', border: 'border-blue-200/50' },
  'на паузе': { label: 'На паузе', color: 'text-amber-700', bg: 'bg-amber-50/50', border: 'border-amber-200/50' },
  'подготовка': { label: 'Подготовка', color: 'text-purple-700', bg: 'bg-purple-50/50', border: 'border-purple-200/50' },
  'завершен': { label: 'Завершен', color: 'text-zinc-600', bg: 'bg-zinc-100/50', border: 'border-zinc-200/50' },
  'отменен': { label: 'Отменен', color: 'text-red-700', bg: 'bg-red-50/50', border: 'border-red-200/50' },
};

function translateStatusLabel(label: string, locale: 'ru' | 'en'): string {
  const normalized = label.toLowerCase().replace(/ё/g, 'е');
  if (normalized.includes('в работе')) return locale === 'en' ? 'In progress' : 'В работе';
  if (normalized.includes('тест')) return locale === 'en' ? 'Testing' : 'Тестирование';
  if (normalized.includes('на паузе')) return locale === 'en' ? 'Paused' : 'На паузе';
  if (normalized.includes('подготов')) return locale === 'en' ? 'Preparation' : 'Подготовка';
  if (normalized.includes('заверш')) return locale === 'en' ? 'Completed' : 'Завершен';
  if (normalized.includes('отмен')) return locale === 'en' ? 'Cancelled' : 'Отменен';
  return label;
}

function getStatusConfig(status: string | null | undefined) {
  if (!status) return STATUS_CONFIG['в работе'];
  const key = status.toLowerCase().replace(/ё/g, 'е');
  for (const [k, v] of Object.entries(STATUS_CONFIG)) {
    if (key.includes(k)) return v;
  }
  return { label: status, color: 'text-zinc-600', bg: 'bg-zinc-100', border: 'border-zinc-200' };
}

function normalizeStatus(status: string | null | undefined): string {
  return (status || '').toLowerCase().replace(/ё/g, 'е');
}

function normalizeAssigneeName(value: string | null | undefined): string {
  return value?.trim() || '';
}

function AssigneeAvatar({
  name,
  signedUrl,
  publicUrl,
  tone,
}: {
  name: string;
  signedUrl?: string | null;
  publicUrl?: string | null;
  tone: 'specialist' | 'manager';
}) {
  const [failedUrls, setFailedUrls] = useState<Set<string>>(new Set());
  const normalizedPublicUrl = normalizePublicAvatarUrl(publicUrl);
  const avatarUrl = (signedUrl && !failedUrls.has(signedUrl)) ? signedUrl
    : (normalizedPublicUrl && !failedUrls.has(normalizedPublicUrl)) ? normalizedPublicUrl
    : null;
  const fallbackClass = tone === 'manager'
    ? 'bg-blue-100 text-blue-700'
    : 'bg-emerald-100 text-emerald-700';

  if (avatarUrl) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        key={avatarUrl}
        src={avatarUrl}
        alt=""
        className="w-5 h-5 rounded-full object-cover flex-shrink-0"
        loading="lazy"
        decoding="async"
        fetchPriority="low"
        onError={() => setFailedUrls((prev) => new Set(prev).add(avatarUrl))}
      />
    );
  }

  return (
    <span
      className={`w-5 h-5 rounded-full flex items-center justify-center text-[10px] font-medium flex-shrink-0 ${fallbackClass}`}
    >
      {name.charAt(0).toUpperCase()}
    </span>
  );
}

function isCompletedStatus(status: string | null | undefined): boolean {
  return normalizeStatus(status).includes('заверш');
}

function pluralizeDays(n: number): string {
  const abs = Math.abs(n) % 100;
  const last = abs % 10;
  if (abs > 10 && abs < 20) return 'дн.';
  if (last === 1) return 'день';
  if (last >= 2 && last <= 4) return 'дня';
  return 'дн.';
}

function getDeadlineStatus(deadline: string | null | undefined): 'overdue' | 'soon' | 'ok' | null {
  if (!deadline) return null;
  try {
    const deadlineDate = new Date(deadline);
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const diffDays = Math.ceil((deadlineDate.getTime() - today.getTime()) / (1000 * 60 * 60 * 24));
    if (diffDays < 0) return 'overdue';
    if (diffDays <= 7) return 'soon';
    return 'ok';
  } catch {
    return null;
  }
}

function formatDate(dateStr: string | null | undefined): string {
  if (!dateStr) return '';
  try {
    const date = new Date(dateStr);
    return date.toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' });
  } catch {
    return dateStr;
  }
}

const PLATFORM_CONFIG: Record<string, { label: string; className: string }> = {
  колди: { label: 'Колди', className: 'bg-sky-100 text-sky-800' },
  тригга: { label: 'Тригга', className: 'bg-violet-100 text-violet-800' },
  инстантли: { label: 'Инстантли', className: 'bg-emerald-100 text-emerald-800' },
};

function getPlatformConfig(value: string | null | undefined) {
  if (!value) return null;
  const key = value.toLowerCase();
  for (const [platformKey, config] of Object.entries(PLATFORM_CONFIG)) {
    if (key.includes(platformKey)) return config;
  }
  return { label: value, className: 'bg-zinc-100 text-zinc-700' };
}

function normalizeUrl(value: string | null | undefined) {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  return `https://${trimmed}`;
}

function formatUrlLabel(value: string) {
  return value.replace(/^https?:\/\//i, '').replace(/^www\./i, '');
}

function parseMaterials(value: string | null | undefined) {
  if (!value) return [];
  return value
    .split(/\r?\n|,|;/)
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

function getKpiValue(project: Project) {
  if (project.kpi_plan && project.kpi_fact) {
    return `${project.kpi_plan} / ${project.kpi_fact}`;
  }
  return project.kpi_plan || project.kpi_fact || '';
}

function getCommentValue(project: Project) {
  return project.comments || project.comment_elvira || project.comment_anya || '';
}

type PopoverItem = { id: string; title: string; status?: string; deadline?: string | null };
type TaskDeadlineDefaultMode = 'tomorrow' | 'fixed';

type ItemPopoverProps = {
  items: PopoverItem[];
  title: string;
  popoverRef: React.RefObject<HTMLDivElement | null>;
  pos: { top: number; left: number; openUp: boolean };
  canEdit: boolean;
  deleteConfirmId: string | null;
  setDeleteConfirmId: (id: string | null) => void;
  onDelete: (id: string) => void;
  onClose: () => void;
  newValue: string;
  setNewValue: (v: string) => void;
  onAdd: () => void;
  placeholder: string;
  showStatusDot?: boolean;
  onDeadlineChange?: (id: string, deadline: string | null) => void;
  onItemClick?: (item: PopoverItem) => void;
};

function formatDeadlineLabel(deadline: string): { text: string; color: string } {
  const now = new Date();
  const dl = new Date(deadline);
  const diffMs = dl.getTime() - now.getTime();
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));
  const dateFmt = dl.toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' });
  const timeFmt = dl.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
  const hasTime = !/^[\d-]+$/.test(deadline) && (dl.getHours() !== 0 || dl.getMinutes() !== 0);
  const formatted = hasTime ? `${dateFmt}, ${timeFmt}` : dateFmt;
  if (diffMs < 0) return { text: `${formatted} (просрочено)`, color: 'text-red-600 bg-red-50' };
  if (diffDays === 0) return { text: `${formatted} (сегодня)`, color: 'text-amber-700 bg-amber-50' };
  if (diffDays <= 2) return { text: formatted, color: 'text-amber-600 bg-amber-50' };
  return { text: formatted, color: 'text-zinc-500 bg-zinc-100' };
}

function getDefaultTaskDeadlineIso(
  enabled: boolean,
  mode: TaskDeadlineDefaultMode,
  at: string,
  time: string
): string | null {
  if (!enabled) return null;
  if (mode === 'fixed') {
    if (!at) return null;
    const fixed = new Date(at);
    if (Number.isNaN(fixed.getTime())) return null;
    return fixed.toISOString();
  }
  const [hoursRaw, minutesRaw] = time.split(':');
  const hours = Number(hoursRaw);
  const minutes = Number(minutesRaw);
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  tomorrow.setHours(Number.isFinite(hours) ? hours : 12, Number.isFinite(minutes) ? minutes : 0, 0, 0);
  return tomorrow.toISOString();
}

function formatTaskDeadlineInput(deadline: string | null | undefined): string {
  if (!deadline) return '';
  const d = new Date(deadline);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function getTaskStatusLabel(status: TaskStatus, locale: 'ru' | 'en'): string {
  if (status === 'in_progress') return locale === 'en' ? 'In progress' : 'В работе';
  if (status === 'done') return locale === 'en' ? 'Completed' : 'Завершено';
  return locale === 'en' ? 'Pending' : 'Ожидает';
}

function ItemPopover({ items, title, popoverRef, pos, canEdit, deleteConfirmId, setDeleteConfirmId, onDelete, onClose, newValue, setNewValue, onAdd, placeholder, showStatusDot, onDeadlineChange, onItemClick }: ItemPopoverProps) {
  const { locale } = useUser();

  // Закрытие по ESC — обязательная страховка для случая, когда попап
  // визуально улетел за экран (рамка задач у проекта с большим списком).
  // Раньше при openUp=true и высоком списке header с крестиком оказывался
  // выше верхней границы вьюпорта, и закрыть было нечем.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  // Динамический maxHeight: попап никогда не должен выходить за вьюпорт.
  // 80vh — это было «80% высоты окна», но если openUp=true и pos.top меньше
  // высоты попапа, header уезжал за верхний край. Считаем реально доступное
  // место в нужном направлении и ограничиваем им (минимум 200px чтобы хоть
  // header + поле ввода поместились).
  const viewportH = typeof window !== 'undefined' ? window.innerHeight : 800;
  const GAP = 16; // отступ от края экрана
  const availableSpace = pos.openUp
    ? Math.max(200, pos.top - GAP)
    : Math.max(200, viewportH - pos.top - GAP - 4);

  return (
    <div
      ref={popoverRef}
      className="fixed z-50 w-[480px] bg-white rounded-xl border border-zinc-200/80 shadow-2xl flex flex-col"
      style={{
        maxHeight: `${availableSpace}px`,
        ...(pos.openUp
          ? { bottom: `${viewportH - pos.top + 4}px`, left: `${pos.left}px` }
          : { top: `${pos.top + 4}px`, left: `${pos.left}px` }),
      }}
    >
      <div className="flex items-center justify-between px-3.5 py-2.5 border-b border-zinc-100">
        <span className="text-sm font-semibold text-zinc-800">{title}</span>
        <button type="button" onClick={onClose} className="flex items-center justify-center w-6 h-6 rounded-md text-zinc-400 hover:text-zinc-600 hover:bg-zinc-100 transition-colors">
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M10.5 3.5L3.5 10.5M3.5 3.5l7 7" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/></svg>
        </button>
      </div>
      <div className="flex-1 overflow-y-auto overscroll-contain px-2 py-2 space-y-1" style={{ minHeight: 0 }}>
        {items.map((item) => {
          const isDone = item.status === 'done';
          const dlInfo = item.deadline && !isDone ? formatDeadlineLabel(item.deadline) : null;
          const interactive = Boolean(onItemClick);
          const inlineActionsEnabled = canEdit && !interactive;
          return (
            <div
              key={item.id}
              role={interactive ? 'button' : undefined}
              tabIndex={interactive ? 0 : undefined}
              onClick={interactive ? () => onItemClick?.(item) : undefined}
              onKeyDown={interactive ? (e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  onItemClick?.(item);
                }
              } : undefined}
              className={`flex items-start gap-2.5 rounded-lg p-2.5 text-[13px] group transition-colors ${isDone ? 'bg-zinc-50/80' : 'bg-zinc-50 hover:bg-zinc-100/80'} ${interactive ? 'cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-300/60' : ''}`}
            >
              {showStatusDot && (
                <span className={`mt-1 w-2 h-2 rounded-full flex-shrink-0 ${isDone ? 'bg-emerald-400' : item.status === 'in_progress' ? 'bg-blue-500' : 'bg-zinc-300'}`} />
              )}
              <div className="flex-1 min-w-0">
                <span className={`break-words leading-relaxed ${isDone ? 'line-through text-zinc-400' : 'text-zinc-700'}`}>{item.title}</span>
                <div className="flex items-center gap-1.5 mt-1">
                  {dlInfo && (
                    <span className={`inline-flex items-center gap-1 text-[10px] font-medium px-1.5 py-0.5 rounded-md ${dlInfo.color}`}>
                      <svg width="10" height="10" viewBox="0 0 16 16" fill="none"><path d="M12 2H4a2 2 0 00-2 2v8a2 2 0 002 2h8a2 2 0 002-2V4a2 2 0 00-2-2zM2 6h12M5 1v2M11 1v2" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/></svg>
                      {dlInfo.text}
                    </span>
                  )}
                  {inlineActionsEnabled && onDeadlineChange && !isDone && (
                    <span className="relative inline-flex items-center opacity-0 group-hover:opacity-100 transition-colors">
                      <input
                        type="datetime-local"
                        value={item.deadline ? (() => { const d = new Date(item.deadline); const pad = (n: number) => String(n).padStart(2, '0'); return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`; })() : ''}
                        onChange={(e) => onDeadlineChange(item.id, e.target.value ? new Date(e.target.value).toISOString() : null)}
                        className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
                        style={{ colorScheme: 'light' }}
                      />
                      <span className="inline-flex items-center gap-1 text-[10px] text-zinc-400 hover:text-zinc-600 pointer-events-none">
                        {item.deadline ? '✏' : (locale === 'en' ? '+ due date' : '+ срок')}
                      </span>
                    </span>
                  )}
                  {inlineActionsEnabled && onDeadlineChange && item.deadline && !isDone && (
                    <button
                      type="button"
                      onClick={() => onDeadlineChange(item.id, null)}
                      className="text-[10px] text-zinc-400 hover:text-red-500 opacity-0 group-hover:opacity-100 transition-all"
                      title={locale === 'en' ? 'Remove deadline' : 'Убрать дедлайн'}
                    >
                      ✕
                    </button>
                  )}
                </div>
              </div>
              {inlineActionsEnabled && (
                deleteConfirmId === item.id ? (
                  <div className="flex items-center gap-1 flex-shrink-0">
                    <button type="button" onClick={() => { onDelete(item.id); setDeleteConfirmId(null); }} className="text-[11px] text-red-600 hover:text-red-700 font-medium px-1.5 py-0.5 rounded bg-red-50 hover:bg-red-100 transition-colors">{locale === 'en' ? 'Yes' : 'Да'}</button>
                    <button type="button" onClick={() => setDeleteConfirmId(null)} className="text-[11px] text-zinc-500 hover:text-zinc-700 font-medium px-1.5 py-0.5 rounded hover:bg-zinc-100 transition-colors">{locale === 'en' ? 'No' : 'Нет'}</button>
                  </div>
                ) : (
                  <button type="button" onClick={() => setDeleteConfirmId(item.id)} className="flex-shrink-0 flex items-center justify-center w-5 h-5 rounded text-zinc-300 hover:text-red-500 hover:bg-red-50 transition-colors" title={locale === 'en' ? 'Delete' : 'Удалить'}>
                    <svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M2.5 3.5h7M4.5 3.5V2.5a1 1 0 011-1h1a1 1 0 011 1v1M5 5.5v3M7 5.5v3M3.5 3.5l.5 6a1 1 0 001 1h2a1 1 0 001-1l.5-6" stroke="currentColor" strokeWidth="1" strokeLinecap="round" strokeLinejoin="round"/></svg>
                  </button>
                )
              )}
            </div>
          );
        })}
        {items.length === 0 && <p className="text-[13px] text-zinc-400 text-center py-4">{locale === 'en' ? 'Empty' : 'Пусто'}</p>}
      </div>
      {canEdit && (
        <div className="flex gap-1.5 px-3 py-2.5 border-t border-zinc-100">
          <input
            type="text"
            value={newValue}
            onChange={(e) => setNewValue(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') onAdd(); }}
            placeholder={placeholder}
            className="flex-1 text-[13px] border border-zinc-200 rounded-lg px-2.5 py-1.5 outline-none focus:border-blue-400 focus:ring-1 focus:ring-blue-400/20 transition-all"
          />
          <button type="button" onClick={onAdd} className="text-[13px] bg-zinc-900 text-white px-3 py-1.5 rounded-lg hover:bg-zinc-800 transition-colors font-medium">+</button>
        </div>
      )}
    </div>
  );
}

export function ProjectList() {
  const isTma = useIsTma();
  const { userRole, locale } = useUser();
  const [projects, setProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchTerm, setSearchTerm] = useState('');
  const [viewMode] = useState<ViewMode>('table');
  const [statusFilter, setStatusFilter] = useState<string>('all');
  const [leadFilter, setLeadFilter] = useState<string>('all');
  // Фильтр «только проблемные»: проекты, где summarizeProjectRisk вернул
  // непустой axes — отстают по контактам или по KPI. Проекты без плана
  // (contacts_obligation=0 и kpi_plan=0) сюда не попадают — у них нет
  // обязательств, считать их «проблемными» некорректно.
  const [showOnlyProblems, setShowOnlyProblems] = useState(false);
  const [openMenuId, setOpenMenuId] = useState<string | null>(null);
  const [canCreate, setCanCreate] = useState(false);
  const [canEdit, setCanEdit] = useState(false);
  const [canDelete, setCanDelete] = useState(false);
  const [drafts, setDrafts] = useState<Record<string, Partial<Project>>>({});
  const [savingRows, setSavingRows] = useState<Record<string, boolean>>({});
  const [isTableEditing, setIsTableEditing] = useState(false);
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);
  const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [assigneeOptions, setAssigneeOptions] = useState<string[]>([]);
  const [assigneeNameToId, setAssigneeNameToId] = useState<Map<string, string>>(new Map());
  const [assigneeAvatars, setAssigneeAvatars] = useState<Map<string, string>>(new Map());
  const [assigneePublicAvatars, setAssigneePublicAvatars] = useState<Map<string, string>>(new Map());
  const [showProjectSettings, setShowProjectSettings] = useState(false);
  const [panelLinkedCampaigns, setPanelLinkedCampaigns] = useState<{ campaign_id: string; campaign_name: string; match_source: string }[]>([]);
  const [panelAllCampaigns, setPanelAllCampaigns] = useState<{ id: string; name: string }[]>([]);
  const [panelCampaignSearch, setPanelCampaignSearch] = useState('');
  const [showPanelCampaignPicker, setShowPanelCampaignPicker] = useState(false);
  const [editingContactsId, setEditingContactsId] = useState<string | null>(null);
  const [editingContactsValue, setEditingContactsValue] = useState('');
  const [projectTasks, setProjectTasks] = useState<Record<string, Task[]>>({});
  const [taskPopoverId, setTaskPopoverId] = useState<string | null>(null);
  const [taskPopoverPos, setTaskPopoverPos] = useState<{ top: number; left: number; openUp: boolean } | null>(null);
  const [newTaskTitle, setNewTaskTitle] = useState('');
  const [deleteConfirmTaskId, setDeleteConfirmTaskId] = useState<string | null>(null);
  const taskPopoverRef = useRef<HTMLDivElement>(null);
  const [taskModalContext, setTaskModalContext] = useState<{ projectId: string; taskId: string } | null>(null);
  const [taskModalTitle, setTaskModalTitle] = useState('');
  const [taskModalStatus, setTaskModalStatus] = useState<TaskStatus>('pending');
  const [taskModalDeadline, setTaskModalDeadline] = useState('');
  const [taskModalSaving, setTaskModalSaving] = useState(false);
  const [taskModalDeleting, setTaskModalDeleting] = useState(false);
  const [taskDeadlineDefaultEnabled, setTaskDeadlineDefaultEnabled] = useState(false);
  const [taskDeadlineDefaultMode, setTaskDeadlineDefaultMode] = useState<TaskDeadlineDefaultMode>('tomorrow');
  const [taskDeadlineDefaultAt, setTaskDeadlineDefaultAt] = useState('');
  const [taskDeadlineDefaultTime, setTaskDeadlineDefaultTime] = useState('12:00');

  // Bulk-loaded pace per project (заполняется один раз после fetchProjects).
  // Питает индикатор риска "не успеваем" между колонками KPI Факт и Контакты.
  const [paceByProjectId, setPaceByProjectId] = useState<Map<string, ProjectPace>>(new Map());

  const [projectNotes, setProjectNotes] = useState<Record<string, ProjectNote[]>>({});
  const [notePopoverId, setNotePopoverId] = useState<string | null>(null);
  const [notePopoverPos, setNotePopoverPos] = useState<{ top: number; left: number; openUp: boolean } | null>(null);
  const [newNoteTitle, setNewNoteTitle] = useState('');
  const [deleteConfirmNoteId, setDeleteConfirmNoteId] = useState<string | null>(null);
  const notePopoverRef = useRef<HTMLDivElement>(null);

  const taskModalTask = taskModalContext
    ? (projectTasks[taskModalContext.projectId] ?? []).find((t) => t.id === taskModalContext.taskId) ?? null
    : null;

  useEffect(() => {
    void fetchProjects();
    void fetchAssigneeOptions();
    void fetchAllTasks();
    void fetchAllNotes();
    void fetchTaskDeadlineDefault();
    // Intentionally run once on mount; fetchers are stable in behavior
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Bulk-load pace для всех проектов. Один запрос к project_contacts_history
  // → индикатор риска у строки получает данные мгновенно (без on-hover).
  // Re-runs при изменении project IDs или их числовых KPI/contacts полей —
  // редактирование тех же полей сразу обновляет иконку.
  const paceInputsKey = projects
    .map(
      (p) =>
        `${p.id}|${p.contacts_obligation ?? ''}|${p.contacts_done ?? ''}|${p.kpi_plan ?? ''}|${p.kpi_fact ?? ''}|${p.deadline ?? ''}`,
    )
    .join(';');
  useEffect(() => {
    if (projects.length === 0) {
      setPaceByProjectId(new Map());
      return;
    }
    let cancelled = false;
    const inputs: ProjectPaceInput[] = projects.map((p) => ({
      projectId: p.id,
      contactsObligation: parseInt(p.contacts_obligation ?? '0', 10) || 0,
      contactsDone: parseInt(p.contacts_done ?? '0', 10) || 0,
      kpiPlan: parseInt(p.kpi_plan ?? '0', 10) || 0,
      kpiFact: parseInt(p.kpi_fact ?? '0', 10) || 0,
      deadline: p.deadline ?? null,
    }));
    void loadAllProjectsPace(supabase, inputs)
      .then((result) => {
        if (!cancelled) setPaceByProjectId(result);
      })
      .catch(() => {
        // graceful: tooltip всё равно работает on-hover, индикатор просто не покажется
        if (!cancelled) setPaceByProjectId(new Map());
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paceInputsKey]);

  useEffect(() => {
    const interval = setInterval(() => void fetchSignedAvatars(), 30 * 60 * 1000);
    const onVisibility = () => {
      if (document.visibilityState === 'visible') void fetchSignedAvatars();
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      clearInterval(interval);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, []);

  useEffect(() => {
    if (!taskPopoverId) return;
    const close = (e: Event) => {
      if (taskPopoverRef.current?.contains(e.target as Node)) return;
      setTaskPopoverId(null);
      setTaskPopoverPos(null);
    };
    window.addEventListener('scroll', close, true);
    return () => window.removeEventListener('scroll', close, true);
  }, [taskPopoverId]);

  useEffect(() => {
    if (!notePopoverId) return;
    const close = (e: Event) => {
      if (notePopoverRef.current?.contains(e.target as Node)) return;
      setNotePopoverId(null);
      setNotePopoverPos(null);
    };
    window.addEventListener('scroll', close, true);
    return () => window.removeEventListener('scroll', close, true);
  }, [notePopoverId]);

  useEffect(() => {
    setCanCreate(canCreateProjects(userRole));
    setCanEdit(canEditProjects(userRole));
    setCanDelete(canDeleteProjects(userRole));
  }, [userRole]);

  useEffect(() => {
    if (selectedProjectId) {
      void fetchPanelCampaigns(selectedProjectId);
      void fetchPanelAllCampaigns();
    } else {
      setPanelLinkedCampaigns([]);
      setShowPanelCampaignPicker(false);
      setPanelCampaignSearch('');
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedProjectId]);

  async function fetchProjects() {
    try {
      setLoading(true);
      const { data, error } = await supabase
        .from('projects')
        .select('*')
        .order('created_at', { ascending: false });
      
      if (error) throw error;
      if (data) setProjects(data as Project[]);
    } catch (error) {
      void logError('projects.list.fetch.failed', error);
    } finally {
      setLoading(false);
    }
  }

  async function fetchAssigneeOptions() {
    try {
      const { data, error } = await supabase
        .from('profiles')
        .select('id, email, full_name, avatar_url');

      if (error) throw error;
      const profiles = (data ?? []) as Array<Pick<UserProfile, 'id' | 'email' | 'full_name' | 'avatar_url'>>;
      setAssigneeOptions(buildAssigneeOptions(profiles, locale));
      const nameIdMap = new Map<string, string>();
      const publicAvatarMap = new Map<string, string>();
      for (const profile of profiles) {
        const name = normalizeAssigneeName(profile.full_name?.trim() || profile.email?.split('@')[0]?.trim());
        if (name && profile.id) nameIdMap.set(name, profile.id);
        const avatarUrl = typeof profile.avatar_url === 'string' ? profile.avatar_url.trim() : '';
        if (name && avatarUrl) publicAvatarMap.set(name, avatarUrl);
      }
      setAssigneeNameToId(nameIdMap);
      setAssigneePublicAvatars(publicAvatarMap);

      void fetchSignedAvatars();

      const renameMap = buildRenameMap(profiles);
      if (renameMap.size > 0) {
        void syncStaleAssigneeNames(renameMap);
      }
    } catch (error) {
      void logError('projects.assignees.fetch.failed', error);
    }
  }

  async function fetchSignedAvatars() {
    try {
      const res = await authFetch('/api/avatars/batch-signed');
      if (!res.ok) return;

      const map = (await res.json()) as Record<string, string>;
      const avatarMap = new Map<string, string>();
      for (const [name, url] of Object.entries(map)) {
        const normalizedName = normalizeAssigneeName(name);
        if (normalizedName && url) avatarMap.set(normalizedName, url);
      }
      setAssigneeAvatars(avatarMap);
    } catch {
      // non-critical, letter fallbacks remain
    }
  }

  async function syncStaleAssigneeNames(renameMap: Map<string, string>) {
    setProjects((prev) => {
      const updates: { id: string; fields: Partial<Project> }[] = [];

      const next = prev.map((p) => {
        const patch: Partial<Project> = {};
        if (p.specialist && renameMap.has(p.specialist)) {
          patch.specialist = renameMap.get(p.specialist)!;
        }
        if (p.manager && renameMap.has(p.manager)) {
          patch.manager = renameMap.get(p.manager)!;
        }
        if (Object.keys(patch).length === 0) return p;
        updates.push({ id: p.id, fields: patch });
        return { ...p, ...patch };
      });

      if (updates.length > 0) {
        void (async () => {
          for (const { id, fields } of updates) {
            await supabase.from('projects').update(fields).eq('id', id);
          }
        })();
      }

      return next;
    });
  }

  async function fetchPanelCampaigns(projectId: string) {
    try {
      const res = await authFetch(`/api/projects/${projectId}/campaigns`);
      if (!res.ok) return;
      const json = await res.json() as { items: { campaign_id: string; campaign_name: string; match_source: string }[] };
      setPanelLinkedCampaigns(json.items ?? []);
    } catch { /* non-critical */ }
  }

  async function fetchPanelAllCampaigns() {
    if (panelAllCampaigns.length > 0) return;
    try {
      const res = await authFetch('/api/instantly/campaigns?limit=all');
      if (!res.ok) return;
      const json = await res.json() as { items?: { id: string; name: string }[] };
      setPanelAllCampaigns((json.items ?? []).map((c) => ({ id: c.id, name: c.name })));
    } catch { /* non-critical */ }
  }

  async function addPanelCampaign(projectId: string, campaignId: string) {
    try {
      await authFetch(`/api/projects/${projectId}/campaigns`, {
        method: 'POST',
        body: JSON.stringify({ campaign_id: campaignId }),
      });
      void fetchPanelCampaigns(projectId);
      setShowPanelCampaignPicker(false);
      setPanelCampaignSearch('');
    } catch { /* non-critical */ }
  }

  async function removePanelCampaign(projectId: string, campaignId: string) {
    try {
      await authFetch(`/api/projects/${projectId}/campaigns?campaign_id=${campaignId}`, {
        method: 'DELETE',
      });
      setPanelLinkedCampaigns((prev) => prev.filter((c) => c.campaign_id !== campaignId));
    } catch { /* non-critical */ }
  }

  async function fetchAllTasks() {
    try {
      const { data, error } = await supabase
        .from('tasks')
        .select('*')
        .order('created_at', { ascending: false });
      if (error) throw error;
      const grouped: Record<string, Task[]> = {};
      const key = (id: string | null) => id ?? '__no_project__';
      for (const t of (data ?? []) as Task[]) {
        const k = key(t.project_id);
        if (!grouped[k]) grouped[k] = [];
        grouped[k].push(t);
      }
      setProjectTasks(grouped);
    } catch {
      // tasks table may not exist yet
    }
  }

  async function fetchTaskDeadlineDefault() {
    try {
      const res = await authFetch('/api/user/task-deadline-preference');
      if (!res.ok) return;
      const data = (await res.json()) as { enabled?: boolean; mode?: string; at?: string | null; time?: string | null };
      setTaskDeadlineDefaultEnabled(Boolean(data.enabled));
      setTaskDeadlineDefaultMode(data.mode === 'fixed' ? 'fixed' : 'tomorrow');
      setTaskDeadlineDefaultAt(data.at ?? '');
      setTaskDeadlineDefaultTime(
        data.time && /^([01][0-9]|2[0-3]):[0-5][0-9]$/.test(data.time)
          ? data.time
          : '12:00'
      );
    } catch {
      // non-critical
    }
  }

  async function addTask(projectId: string, title: string, specialist?: string) {
    if (!title.trim()) return;
    const deadline = getDefaultTaskDeadlineIso(
      taskDeadlineDefaultEnabled,
      taskDeadlineDefaultMode,
      taskDeadlineDefaultAt,
      taskDeadlineDefaultTime
    );
    const { data, error } = await supabase
      .from('tasks')
      .insert({ project_id: projectId, title: title.trim(), specialist: specialist || null, deadline })
      .select()
      .single();
    if (error) return;
    const task = data as Task;
    setProjectTasks((prev) => ({
      ...prev,
      [projectId]: [task, ...(prev[projectId] ?? [])],
    }));
    setNewTaskTitle('');
  }

  async function deleteTask(taskId: string, projectId: string) {
    await supabase.from('tasks').delete().eq('id', taskId);
    setProjectTasks((prev) => ({
      ...prev,
      [projectId]: (prev[projectId] ?? []).filter((t) => t.id !== taskId),
    }));
  }

  async function updateTaskDeadline(taskId: string, projectId: string, deadline: string | null) {
    await supabase.from('tasks').update({ deadline }).eq('id', taskId);
    setProjectTasks((prev) => ({
      ...prev,
      [projectId]: (prev[projectId] ?? []).map((t) =>
        t.id === taskId ? { ...t, deadline } : t,
      ),
    }));
  }

  function openTaskModal(projectId: string, item: PopoverItem) {
    const sourceTask = (projectTasks[projectId] ?? []).find((t) => t.id === item.id);
    if (!sourceTask) return;
    setTaskModalContext({ projectId, taskId: item.id });
    setTaskModalTitle(sourceTask.title);
    setTaskModalStatus(sourceTask.status);
    setTaskModalDeadline(formatTaskDeadlineInput(sourceTask.deadline));
    setDeleteConfirmTaskId(null);
  }

  async function saveTaskFromModal() {
    if (!taskModalContext) return;
    const title = taskModalTitle.trim();
    if (!title) return;
    const deadline = taskModalDeadline ? new Date(taskModalDeadline).toISOString() : null;
    const updatedAt = new Date().toISOString();
    setTaskModalSaving(true);
    try {
      const { error } = await supabase
        .from('tasks')
        .update({ title, status: taskModalStatus, deadline, updated_at: updatedAt })
        .eq('id', taskModalContext.taskId);
      if (error) throw error;
      setProjectTasks((prev) => ({
        ...prev,
        [taskModalContext.projectId]: (prev[taskModalContext.projectId] ?? []).map((t) =>
          t.id === taskModalContext.taskId
            ? { ...t, title, status: taskModalStatus, deadline, updated_at: updatedAt }
            : t,
        ),
      }));
      setTaskModalContext(null);
    } catch (error) {
      void logError('tasks.modal.save.failed', error, {
        projectId: taskModalContext.projectId,
        taskId: taskModalContext.taskId,
      });
    } finally {
      setTaskModalSaving(false);
    }
  }

  async function deleteTaskFromModal() {
    if (!taskModalContext) return;
    setTaskModalDeleting(true);
    try {
      await deleteTask(taskModalContext.taskId, taskModalContext.projectId);
      setTaskModalContext(null);
      setDeleteConfirmTaskId(null);
    } finally {
      setTaskModalDeleting(false);
    }
  }

  async function fetchAllNotes() {
    try {
      const { data, error } = await supabase
        .from('project_notes')
        .select('*')
        .order('created_at', { ascending: false });
      if (error) throw error;
      const grouped: Record<string, ProjectNote[]> = {};
      for (const n of (data ?? []) as ProjectNote[]) {
        if (!grouped[n.project_id]) grouped[n.project_id] = [];
        grouped[n.project_id].push(n);
      }
      setProjectNotes(grouped);
    } catch {
      // table may not exist yet
    }
  }

  async function addNote(projectId: string, title: string) {
    if (!title.trim()) return;
    const { data, error } = await supabase
      .from('project_notes')
      .insert({ project_id: projectId, title: title.trim() })
      .select()
      .single();
    if (error) return;
    const note = data as ProjectNote;
    setProjectNotes((prev) => ({
      ...prev,
      [projectId]: [note, ...(prev[projectId] ?? [])],
    }));
    setNewNoteTitle('');
  }

  async function deleteNote(noteId: string, projectId: string) {
    await supabase.from('project_notes').delete().eq('id', noteId);
    setProjectNotes((prev) => ({
      ...prev,
      [projectId]: (prev[projectId] ?? []).filter((n) => n.id !== noteId),
    }));
  }

  async function updateProjectStatus(id: string, newStatus: string) {
    try {
      const { error } = await supabase
        .from('projects')
        .update({ status: newStatus, updated_at: new Date().toISOString() })
        .eq('id', id);
      
      if (error) throw error;
      
      const updatedAt = new Date().toISOString();
      setProjects(prev => prev.map(p => 
        p.id === id ? { ...p, status: newStatus as ProjectStatus, updated_at: updatedAt } : p
      ));
      void logAudit('projects.status.update.success', 'Project status updated', {
        projectId: id,
        status: newStatus,
      });
    } catch (error) {
      void logError('projects.status.update.failed', error, { projectId: id, status: newStatus });
    }
    setOpenMenuId(null);
  }

  async function deleteProject(id: string) {
    setDeleting(true);
    setDeleteError(null);
    try {
      const res = await authFetch(`/api/projects/${id}`, {
        method: 'DELETE',
      });

      if (!res.ok) {
        let message = 'Не удалось удалить проект';
        try {
          const payload = (await res.json()) as { error?: string };
          if (payload?.error) message = payload.error;
        } catch {
          // ignore JSON parse errors
        }
        throw new Error(message);
      }

      setProjects((prev) => prev.filter((p) => p.id !== id));
      if (selectedProjectId === id) setSelectedProjectId(null);
      void logAudit('projects.delete.success', 'Project deleted', { projectId: id });
      setDeleteConfirmId(null);
    } catch (error) {
      void logError('projects.delete.failed', error, { projectId: id });
      setDeleteError(error instanceof Error ? error.message : 'Не удалось удалить проект');
    } finally {
      setDeleting(false);
      setOpenMenuId(null);
    }
  }

  const requestDeleteProject = (id: string) => {
    setDeleteError(null);
    setDeleteConfirmId(id);
  };

  const setDraftValue = (id: string, field: keyof Project, value: string) => {
    setDrafts((prev) => ({
      ...prev,
      [id]: {
        ...prev[id],
        [field]: value,
      },
    }));
  };

  const clearDraftFields = (id: string, fields: Array<keyof Project>) => {
    setDrafts((prev) => {
      const entry = { ...(prev[id] || {}) };
      fields.forEach((field) => {
        delete entry[field];
      });
      if (Object.keys(entry).length === 0) {
        const next = { ...prev };
        delete next[id];
        return next;
      }
      return { ...prev, [id]: entry };
    });
  };

  const getDraftValue = (project: Project, field: keyof Project) => {
    const draft = drafts[project.id];
    if (draft && draft[field] !== undefined) {
      return String(draft[field] ?? '');
    }
    return String((project[field] as string | null | undefined) ?? '');
  };

  const getDraftValueWithFallback = (
    project: Project,
    field: keyof Project,
    fallback: string,
  ) => {
    const draft = drafts[project.id];
    if (draft && draft[field] !== undefined) {
      return String(draft[field] ?? '');
    }
    const currentValue = (project[field] as string | null | undefined) ?? '';
    return currentValue || fallback;
  };

  const commitProjectUpdate = async (project: Project, updates: Partial<Project>) => {
    if (!canEdit) return;

    const payload: Partial<Project> = {};
    Object.entries(updates).forEach(([key, value]) => {
      const field = key as keyof Project;
      const currentValue = (project[field] as string | null | undefined) ?? '';
      const nextValue = (value as string | null | undefined) ?? '';

      if (nextValue !== currentValue) {
        (payload as Record<string, string | null>)[field] = nextValue === '' ? null : nextValue;
      }
    });

    if (Object.keys(payload).length === 0) {
      clearDraftFields(project.id, Object.keys(updates) as Array<keyof Project>);
      return;
    }

    if ('specialist' in payload) {
      const specialistName = payload.specialist;
      payload.specialist_user_id = specialistName ? (assigneeNameToId.get(specialistName) ?? null) : null;
    }

    payload.updated_at = new Date().toISOString();
    setSavingRows((prev) => ({ ...prev, [project.id]: true }));

    try {
      const { error } = await supabase
        .from('projects')
        .update(payload)
        .eq('id', project.id);

      if (error) throw error;

      setProjects((prev) =>
        prev.map((item) => (item.id === project.id ? { ...item, ...payload } : item)),
      );
      clearDraftFields(project.id, Object.keys(updates) as Array<keyof Project>);
      void logAudit('projects.update.success', 'Project updated', {
        projectId: project.id,
        fields: Object.keys(payload).filter((field) => field !== 'updated_at'),
      });
    } catch (error) {
      void logError('projects.update.failed', error, { projectId: project.id });
    } finally {
      setSavingRows((prev) => ({ ...prev, [project.id]: false }));
    }
  };

  const commitAllDrafts = async () => {
    const entries = Object.entries(drafts);
    if (entries.length === 0) return;

    await Promise.all(
      entries.map(([id, updates]) => {
        const project = projects.find((item) => item.id === id);
        if (!project) return Promise.resolve();
        return commitProjectUpdate(project, updates);
      }),
    );
  };

  const handleToggleEditing = async () => {
    if (isTableEditing) {
      await commitAllDrafts();
    }
    setIsTableEditing((prev) => !prev);
  };

  const selectedProject = selectedProjectId
    ? projects.find((project) => project.id === selectedProjectId) || null
    : null;

  const uniqueLeads = Array.from(
    new Set(projects.map((p) => p.manager?.trim()).filter(Boolean)),
  ).sort((a, b) => a!.localeCompare(b!, 'ru-RU')) as string[];

  // Хелпер: проект считается «проблемным» если он отстаёт по любой
  // активной оси. У проектов без плана (no contacts_obligation и no kpi_plan)
  // ни одно из условий не сработает — они «не проблемные».
  //
  // Логика проверки идёт ОТ ДЕШЁВОГО К ДОРОГОМУ, чтобы фильтр работал даже
  // когда paceByProjectId ещё не подгрузился (он async после fetchProjects):
  //
  //   1) HARD-FAILURE: дедлайн уже прошёл, обязательство не выполнено.
  //      Самый болезненный случай, ЛПР всегда хочет видеть. Не требует истории.
  //   2) PACE-BASED: forecastDays > daysUntilDeadline (summarizeProjectRisk).
  //      Требует ≥2 точек истории и положительный темп — иначе onTrack=null
  //      и проект не считается «проблемным» по pace. Но если темп НУЛЕВОЙ
  //      или отрицательный, а обязательство значительное — это тоже проблема,
  //      она ловится через п.3.
  //   3) ZERO-PACE: дедлайн близко (≤14 дней) и осталось значимое обязательство,
  //      а pace либо null либо ≤ 0 (контакты/KPI не растут).
  const isProblemProject = (project: typeof projects[number]): boolean => {
    if (isCompletedStatus(project.status)) return false;

    const contactsOblig = parseInt(project.contacts_obligation ?? '0', 10) || 0;
    const contactsDone = parseInt(project.contacts_done ?? '0', 10) || 0;
    const kpiPlan = parseInt(project.kpi_plan ?? '0', 10) || 0;
    const kpiFact = parseInt(project.kpi_fact ?? '0', 10) || 0;

    // У проекта вообще нет обязательств — никогда не проблемный.
    if (contactsOblig === 0 && kpiPlan === 0) return false;

    const deadlineStr = project.deadline?.trim();
    let daysUntilDeadline: number | null = null;
    if (deadlineStr) {
      const dl = new Date(deadlineStr);
      if (!isNaN(dl.getTime())) {
        daysUntilDeadline = Math.ceil((dl.getTime() - Date.now()) / 86_400_000);
      }
    }

    // 1) HARD-FAILURE: дедлайн в прошлом, не доехали.
    if (daysUntilDeadline !== null && daysUntilDeadline < 0) {
      if (contactsOblig > 0 && contactsDone < contactsOblig) return true;
      if (kpiPlan > 0 && kpiFact < kpiPlan) return true;
    }

    // 2) PACE-BASED (форкаст видим только если есть история).
    const risk = summarizeProjectRisk(
      paceByProjectId.get(project.id),
      false, // isCompleted уже отсеян выше
    );
    if (risk.axes.length > 0) return true;

    // 3) ZERO/NEGATIVE-PACE: дедлайн ≤14 дней и темп нулевой/отрицательный.
    if (daysUntilDeadline !== null && daysUntilDeadline >= 0 && daysUntilDeadline <= 14) {
      const pace = paceByProjectId.get(project.id);
      const contactsRemaining = Math.max(0, contactsOblig - contactsDone);
      const kpiRemaining = Math.max(0, kpiPlan - kpiFact);
      // Контакты: pace.contacts == null (нет истории/плана) ИЛИ avg≤0 ИЛИ форкаст недостижим.
      if (contactsOblig > 0 && contactsRemaining > 0) {
        const c = pace?.contacts;
        if (!c || c.avgPerDay <= 0) return true;
      }
      if (kpiPlan > 0 && kpiRemaining > 0) {
        const k = pace?.kpi;
        if (!k || k.avgPerDay <= 0) return true;
      }
    }

    return false;
  };

  const filteredProjects = projects.filter((project) => {
    const normalizedSearch = searchTerm.trim().toLowerCase();
    const matchesSearch = !normalizedSearch
      || [
        project.client,
        project.name,
        project.budget,
        project.contract_link,
        project.handoff_link,
        project.deadline,
        project.kpi_plan,
        project.specialist,
        project.manager,
        project.comments,
        project.work_format,
      ]
        .filter(Boolean)
        .some((value) => value?.toLowerCase().includes(normalizedSearch));

    const matchesLead = leadFilter === 'all'
      || (project.manager?.trim() ?? '') === leadFilter;

    const matchesProblem = !showOnlyProblems || isProblemProject(project);

    if (statusFilter === 'all') {
      return matchesSearch && matchesLead && matchesProblem && !isCompletedStatus(project.status);
    }

    const status = normalizeStatus(project.status);
    return matchesSearch && matchesLead && matchesProblem && status.includes(statusFilter);
  });

  const leadScopedProjects = leadFilter === 'all'
    ? projects
    : projects.filter((p) => (p.manager?.trim() ?? '') === leadFilter);

  const statusCounts = {
    all: leadScopedProjects.filter((p) => !isCompletedStatus(p.status)).length,
    'подготовка': leadScopedProjects.filter(p => p.status?.toLowerCase().includes('подготовк')).length,
    'в работе': leadScopedProjects.filter(p => p.status?.toLowerCase().includes('работ')).length,
    'тестирование': leadScopedProjects.filter(p => p.status?.toLowerCase().includes('тест')).length,
    'на паузе': leadScopedProjects.filter(p => p.status?.toLowerCase().includes('пауз')).length,
    'завершен': leadScopedProjects.filter(p => p.status?.toLowerCase().includes('заверш')).length,
  };

  // Счётчик «проблемных» среди активных (некомплитнутых) проектов в области
  // текущего leadFilter — чтобы значок «Проблемные (N)» совпадал с тем,
  // что увидит пользователь после клика по тоглу.
  const problemCount = leadScopedProjects.filter(
    (p) => !isCompletedStatus(p.status) && isProblemProject(p),
  ).length;

  const sortedProjects = filteredProjects;

  if (loading) {
    return (
      <div className="flex h-64 items-center justify-center">
        <div className="text-zinc-400 text-sm">Загрузка...</div>
      </div>
    );
  }

  // Group projects by status for Kanban view
  const kanbanColumns = [
    { key: 'подготовка', ...STATUS_CONFIG['подготовка'] },
    { key: 'в работе', ...STATUS_CONFIG['в работе'] },
    { key: 'тестирование', ...STATUS_CONFIG['тестирование'] },
    { key: 'на паузе', ...STATUS_CONFIG['на паузе'] },
    { key: 'завершен', ...STATUS_CONFIG['завершен'] },
  ];

  const getProjectsForColumn = (columnKey: string) => {
    return filteredProjects.filter(p => {
      const status = p.status?.toLowerCase() || '';
      return status.includes(columnKey);
    });
  };

  return (
    <div className={isTma ? 'space-y-4' : 'flex flex-1 min-h-0 flex-col gap-4'}>
      {/* Header + Controls — single row */}
      <div className={isTma ? 'flex flex-col gap-3' : 'flex flex-wrap items-center gap-2'}>
        <h1 className={`${isTma ? 'text-xl' : 'text-lg'} font-semibold tracking-tight text-zinc-900 mr-auto`}>
          {locale === 'en' ? 'Projects' : 'Проекты'}
        </h1>

        {/* Search */}
        <div className="relative">
          <svg className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-zinc-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
          </svg>
          <input
            type="text"
            className="w-44 rounded-xl border border-zinc-200/80 bg-white py-2 pl-8 pr-3 text-xs text-zinc-900 placeholder-zinc-400 focus:ring-2 focus:ring-zinc-200 focus:border-transparent outline-none transition-all shadow-sm hover:shadow-md"
            placeholder={locale === 'en' ? 'Search...' : 'Поиск...'}
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
          />
        </div>

        {/* Lead Filter */}
        {uniqueLeads.length > 0 && (
          <div className="relative">
            <select
              value={leadFilter}
              onChange={(e) => setLeadFilter(e.target.value)}
              className={`appearance-none rounded-xl border border-zinc-200/80 bg-white py-2 pl-3 ${isTma ? 'pr-3' : 'pr-7'} text-xs font-medium text-zinc-700 focus:ring-2 focus:ring-zinc-200 focus:border-transparent outline-none transition-all shadow-sm hover:shadow-md cursor-pointer`}
            >
              <option value="all">{locale === 'en' ? 'All leads' : 'Все лиды'}</option>
              {uniqueLeads.map((lead) => (
                <option key={lead} value={lead}>{lead}</option>
              ))}
            </select>
            {!isTma && (
              <svg className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-zinc-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
              </svg>
            )}
          </div>
        )}

        {/* Тоггл «Проблемные»: проекты с реальным отставанием по контактам/KPI.
            Когда нечего показать (никто не в риске) — кнопка приглушается, но не
            прячется: визуальная подсказка «сегодня всё ок». */}
        {viewMode !== 'kanban' && (
          <button
            type="button"
            onClick={() => setShowOnlyProblems((v) => !v)}
            disabled={problemCount === 0 && !showOnlyProblems}
            title={
              problemCount === 0
                ? 'Сейчас отстающих проектов нет'
                : showOnlyProblems
                ? 'Показать все'
                : `Показать только отстающие (${problemCount})`
            }
            className={`flex items-center gap-1.5 rounded-xl border px-2.5 py-2 text-xs font-medium whitespace-nowrap shadow-sm transition-all ${
              showOnlyProblems
                ? 'border-red-200 bg-red-50 text-red-700 hover:bg-red-100'
                : problemCount === 0
                ? 'border-zinc-200/80 bg-white text-zinc-300 cursor-not-allowed'
                : 'border-zinc-200/80 bg-white text-zinc-700 hover:shadow-md'
            }`}
          >
            <AlertTriangle className={`w-3.5 h-3.5 ${showOnlyProblems || problemCount > 0 ? 'text-red-500' : 'text-zinc-300'}`} />
            {locale === 'en' ? 'Issues' : 'Проблемные'}
            <span
              className={`px-1.5 py-px rounded-full text-[10px] ${
                showOnlyProblems
                  ? 'bg-white text-red-700 shadow-sm'
                  : problemCount === 0
                  ? 'bg-zinc-100 text-zinc-300'
                  : 'bg-red-100 text-red-700'
              }`}
            >
              {problemCount}
            </span>
          </button>
        )}

        {/* Status Filter Tabs */}
        {viewMode !== 'kanban' && (
          <div className={isTma ? 'flex w-full items-center gap-0.5 overflow-x-auto no-scrollbar' : 'flex items-center gap-0.5 overflow-x-auto no-scrollbar bg-white px-1 py-0.5 rounded-xl shadow-sm border border-zinc-200/80'}>
            {[
              { key: 'all', label: locale === 'en' ? 'All' : 'Все' },
              { key: 'подготовка', label: locale === 'en' ? 'Preparation' : 'Подготовка' },
              { key: 'в работе', label: locale === 'en' ? 'In progress' : 'В работе' },
              { key: 'тестирование', label: locale === 'en' ? 'Test' : 'Тест' },
              { key: 'на паузе', label: locale === 'en' ? 'Paused' : 'Пауза' },
              { key: 'завершен', label: locale === 'en' ? 'Completed' : 'Завершено' },
            ].map((tab) => (
              <button
                key={tab.key}
                onClick={() => setStatusFilter(tab.key)}
                className={`flex items-center px-2.5 py-1.5 rounded-lg text-xs font-medium whitespace-nowrap transition-all duration-300 ${
                  statusFilter === tab.key
                    ? 'bg-zinc-100 text-zinc-900 shadow-sm'
                    : 'text-zinc-500 hover:text-zinc-800 hover:bg-zinc-50'
                }`}
              >
                {tab.label}
                <span className={`ml-1.5 px-1.5 py-px rounded-full text-[10px] transition-colors duration-300 ${
                  statusFilter === tab.key ? 'bg-white text-zinc-700 shadow-sm' : 'bg-zinc-100 text-zinc-400'
                }`}>
                  {statusCounts[tab.key as keyof typeof statusCounts] || 0}
                </span>
              </button>
            ))}
          </div>
        )}

        {canEdit && (
          <button
            type="button"
            onClick={() => void handleToggleEditing()}
            className={`inline-flex items-center justify-center rounded-xl px-4 py-2 text-xs font-medium transition-all duration-200 ${isTma ? 'w-full' : ''} ${
              isTableEditing
                ? 'bg-emerald-50 text-emerald-700 hover:bg-emerald-100'
                : 'bg-white text-zinc-700 shadow-sm hover:shadow-md border border-zinc-200/80'
            }`}
          >
            {isTableEditing ? (locale === 'en' ? 'Done' : 'Завершить') : (locale === 'en' ? 'Edit' : 'Редактировать')}
          </button>
        )}
        {canCreate && (
          <Link
            href="/projects/new"
            className={`inline-flex items-center justify-center rounded-xl bg-zinc-900 px-4 py-2 text-xs font-medium text-white shadow-sm hover:bg-zinc-800 transition-all duration-200 ${isTma ? 'w-full' : ''}`}
          >
            <span className="mr-1.5 text-sm leading-none">+</span> {locale === 'en' ? 'New project' : 'Новый проект'}
          </Link>
        )}
      </div>

      {/* Empty State */}
      {filteredProjects.length === 0 && (
        <div className="text-center py-16 bg-white rounded-2xl border border-dashed border-zinc-200">
          <h3 className="mt-4 text-lg font-medium text-zinc-900">{locale === 'en' ? 'No projects' : 'Нет проектов'}</h3>
          <p className="mt-2 text-sm text-zinc-500">
            {searchTerm
              ? (locale === 'en' ? 'Try changing your search' : 'Попробуйте изменить поиск')
              : (locale === 'en' ? 'Create your first project or import data' : 'Создайте первый проект или импортируйте данные')}
          </p>
          {canCreate && (
            <Link 
              href="/projects/new"
              className="mt-4 inline-flex items-center text-sm font-medium text-zinc-900 hover:text-zinc-600 underline underline-offset-4"
            >
              {locale === 'en' ? 'Create project' : 'Создать проект'}
            </Link>
          )}
        </div>
      )}

      {isTma && filteredProjects.length > 0 && (
        <div className="space-y-3">
          {sortedProjects.map((project) => (
            <ProjectCard 
              key={project.id} 
              project={project} 
              onStatusChange={updateProjectStatus}
              openMenuId={openMenuId}
              setOpenMenuId={setOpenMenuId}
              onDeleteRequest={requestDeleteProject}
              canDelete={canDelete}
            />
          ))}
        </div>
      )}

      {/* Cards View */}
      {!isTma && viewMode === 'cards' && filteredProjects.length > 0 && (
        <div className="space-y-5">
          {sortedProjects.map((project) => (
            <ProjectCard 
              key={project.id} 
              project={project} 
              onStatusChange={updateProjectStatus}
              openMenuId={openMenuId}
              setOpenMenuId={setOpenMenuId}
              onDeleteRequest={requestDeleteProject}
              canDelete={canDelete}
            />
          ))}
        </div>
      )}

      {/* Kanban View */}
      {!isTma && viewMode === 'kanban' && (
        <div className="flex gap-4 overflow-x-auto pb-4">
          {kanbanColumns.map((column) => (
            <div 
              key={column.key}
              className="flex-shrink-0 w-72 bg-zinc-50 rounded-xl p-3 border border-zinc-200"
            >
              <div className={`flex items-center justify-between mb-3 px-2`}>
                <div className="flex items-center">
                  <div className={`w-2 h-2 rounded-full mr-2 ${column.bg.replace('bg-', 'bg-').replace('-50', '-500')}`} 
                       style={{ backgroundColor: column.color.replace('text-', '').replace('-700', '') }} />
                  <h3 className={`text-sm font-semibold ${column.color}`}>{column.label}</h3>
                </div>
                <span className="text-xs text-zinc-400 font-medium">
                  {getProjectsForColumn(column.key).length}
                </span>
              </div>
              <div className="space-y-2">
                {getProjectsForColumn(column.key).map((project) => (
                  <KanbanCard 
                    key={project.id} 
                    project={project}
                    onStatusChange={updateProjectStatus}
                    columns={kanbanColumns}
                    onDeleteRequest={requestDeleteProject}
                    canDelete={canDelete}
                  />
                ))}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Table View */}
      {!isTma && viewMode === 'table' && filteredProjects.length > 0 && (
        <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden rounded-[24px] bg-white shadow-sm border border-zinc-200/80">
          <div className="min-h-0 flex-1 overflow-auto">
            <table className="w-full divide-y divide-zinc-200/50 text-xs min-w-[1400px]">
              <thead className="bg-white/95 backdrop-blur sticky top-0 z-10">
                <tr>
                  <th className="px-3 py-3 text-left text-[10px] font-semibold text-zinc-400 uppercase tracking-wider min-w-[140px]">{locale === 'en' ? 'Project' : 'Проект'}</th>
                  <th className="px-2 py-3 text-center text-[10px] font-semibold text-zinc-400 uppercase tracking-wider min-w-[100px]">{locale === 'en' ? 'Status' : 'Статус'}</th>
                  <th className="px-2 py-3 text-left text-[10px] font-semibold text-zinc-400 uppercase tracking-wider min-w-[80px]">{locale === 'en' ? 'Amount' : 'Сумма'}</th>
                  <th className="px-1.5 py-3 text-center text-[10px] font-semibold text-zinc-400 uppercase tracking-wider min-w-[48px]">{locale === 'en' ? 'Ctr.' : 'Дог.'}</th>
                  <th className="px-1.5 py-3 text-center text-[10px] font-semibold text-zinc-400 uppercase tracking-wider min-w-[48px]">{locale === 'en' ? 'Mo.' : 'Пер.'}</th>
                  <th className="px-2 py-3 text-left text-[10px] font-semibold text-zinc-400 uppercase tracking-wider min-w-[100px]">{locale === 'en' ? 'Deadline' : 'Дедлайн'}</th>
                  <th className="px-2 py-3 text-left text-[10px] font-semibold text-zinc-400 uppercase tracking-wider min-w-[80px]">{locale === 'en' ? 'KPI Plan' : 'KPI План'}</th>
                  <th className="px-2 py-3 text-center text-[10px] font-semibold text-zinc-400 uppercase tracking-wider min-w-[70px]">{locale === 'en' ? 'KPI Fact' : 'KPI Факт'}</th>
                  {/* Risk indicator (Clock icon when project is behind schedule). Header пуст — иконка self-explanatory. */}
                  <th className="px-1 py-3 w-6" aria-label={locale === 'en' ? 'Risk' : 'Риск'} />
                  <th className="px-2 py-3 text-left text-[10px] font-semibold text-zinc-400 uppercase tracking-wider min-w-[100px]">{locale === 'en' ? 'Contacts' : 'Контакты'}</th>
                  <th className="px-2 py-3 text-left text-[10px] font-semibold text-zinc-400 uppercase tracking-wider min-w-[120px]">{locale === 'en' ? 'Specialist' : 'Специалист'}</th>
                  <th className="px-2 py-3 text-left text-[10px] font-semibold text-zinc-400 uppercase tracking-wider min-w-[120px]">{locale === 'en' ? 'Lead (PM)' : 'Лид (PM)'}</th>
                  <th className="px-2 py-3 text-left text-[10px] font-semibold text-zinc-400 uppercase tracking-wider min-w-[80px]">{locale === 'en' ? 'Format' : 'Формат'}</th>
                  <th className="px-2 py-3 text-left text-[10px] font-semibold text-zinc-400 uppercase tracking-wider min-w-[120px]">{locale === 'en' ? 'Tasks' : 'Задачи'}</th>
                  <th className="px-2 py-3 text-left text-[10px] font-semibold text-zinc-400 uppercase tracking-wider min-w-[120px]">{locale === 'en' ? 'Notes' : 'Заметки'}</th>
              </tr>
            </thead>
              <tbody className="divide-y divide-zinc-200/50 bg-white">
                {sortedProjects.map((project) => {
                  const isSaving = Boolean(savingRows[project.id]);
                  const isDisabled = !canEdit || isSaving;
                  const nameValue = getDraftValue(project, 'name');
                  const budgetValue = getDraftValue(project, 'budget');
                  const contractValue = getDraftValue(project, 'contract_link');
                  const handoffValue = getDraftValue(project, 'handoff_link');
                  const deadlineValue = getDraftValue(project, 'deadline');
                  const kpiValue = getDraftValue(project, 'kpi_plan');
                  const kpiFactValue = getDraftValue(project, 'kpi_fact');
                  const specialistValue = getDraftValue(project, 'specialist');
                  const managerValue = getDraftValue(project, 'manager');
                  const specialistSelectOptions = ensureCurrentAssigneeOption(assigneeOptions, specialistValue);
                  const managerSelectOptions = ensureCurrentAssigneeOption(assigneeOptions, managerValue);
                  const workFormatValue = resolveWorkFormat(getDraftValue(project, 'work_format'));
                  const contractHref = normalizeUrl(project.contract_link);
                  const handoffHref = normalizeUrl(project.handoff_link);
                  const platformConfig = getPlatformConfig(project.work_format);
                  const readOnlyProjectTitle = project.client || '—';
                  const services = parseServices(project.name);
                  const readOnlyBudget = project.budget || '—';
                  const readOnlyDeadline = project.deadline || '—';
                  const readOnlyKpi = project.kpi_plan || '—';
                  const readOnlyKpiFact = project.kpi_fact || '—';
                  const readOnlySpecialist = project.specialist || '—';
                  const readOnlyManager = project.manager || '—';
                return (
                    <tr key={project.id} className="hover:bg-zinc-50/50 transition-colors group">
                      <td className="px-3 py-3 align-top overflow-hidden">
                        {isTableEditing ? (
                          <div className="space-y-1">
                            <div className="flex items-center gap-1.5">
                              <span className="text-xs font-semibold text-zinc-500 truncate">{project.client || '—'}</span>
                              <button
                                type="button"
                                onClick={() => setSelectedProjectId(project.id)}
                                className="p-0.5 text-zinc-400 hover:text-zinc-900 rounded hover:bg-zinc-100 transition-colors flex-shrink-0"
                                title="Открыть карточку"
                              >
                                ↗
                              </button>
                            </div>
                            <InlineInput
                              value={nameValue}
                              onChange={(value) => setDraftValue(project.id, 'name', value)}
                              onCommit={(value) => void commitProjectUpdate(project, { name: value })}
                              disabled={isDisabled}
                              placeholder="Название проекта"
                              className="font-medium"
                            />
                          </div>
                        ) : (
                          <button
                            type="button"
                            onClick={() => setSelectedProjectId(project.id)}
                            className="text-left font-medium text-zinc-900 hover:text-zinc-600 transition-colors group/btn"
                          >
                            <div className="flex items-start gap-2">
                              <span className="break-words">{readOnlyProjectTitle}</span>
                              <span className="opacity-0 group-hover/btn:opacity-100 transition-opacity text-zinc-400 mt-1 flex-shrink-0 text-xs">↗</span>
                            </div>
                            {services.length > 0 && (
                              <span className="flex flex-wrap gap-1 mt-1">
                                {services.map((s) => (
                                  <span key={s} className="inline-flex items-center bg-zinc-100/80 text-zinc-700 text-[10px] font-medium px-1.5 py-0.5 rounded">{s}</span>
                                ))}
                              </span>
                            )}
                          </button>
                      )}
                    </td>
                      <td className="px-2 py-3 align-top whitespace-nowrap text-center">
                        {(() => {
                          const cfg = getStatusConfig(project.status);
                          return canEdit ? (
                            <select
                              value={project.status || ''}
                              onChange={(e) => {
                                void commitProjectUpdate(project, { status: e.target.value as ProjectStatus });
                              }}
                              disabled={isSaving}
                              className={`appearance-none cursor-pointer text-xs font-medium px-2.5 py-1 rounded-full border-0 ring-1 ring-inset ring-black/5 ${cfg.bg} ${cfg.color} focus:outline-none focus:ring-2 focus:ring-blue-500/30`}
                            >
                              {STATUS_OPTIONS.map((s) => (
                                <option key={s} value={s}>{translateStatusLabel(s, locale)}</option>
                              ))}
                            </select>
                          ) : (
                            <span className={`inline-flex items-center px-2.5 py-1 rounded-full text-xs font-medium ring-1 ring-inset ring-black/5 ${cfg.bg} ${cfg.color}`}>
                              {translateStatusLabel(cfg.label, locale)}
                            </span>
                          );
                        })()}
                      </td>
                      <td className="px-2 py-3 align-top whitespace-nowrap">
                        {isTableEditing ? (
                          <InlineInput
                            value={budgetValue}
                            onChange={(value) => setDraftValue(project.id, 'budget', value)}
                            onCommit={(value) => void commitProjectUpdate(project, { budget: value })}
                            disabled={isDisabled}
                            placeholder={locale === 'en' ? 'Amount' : 'Сумма'}
                          />
                        ) : (
                          <span className="text-zinc-900 font-medium">{readOnlyBudget}</span>
                      )}
                    </td>
                      <td className="px-2 py-3 align-top whitespace-nowrap text-center">
                        {isTableEditing ? (
                          <InlineInput
                            value={contractValue}
                            onChange={(value) => setDraftValue(project.id, 'contract_link', value)}
                            onCommit={(value) => void commitProjectUpdate(project, { contract_link: value })}
                            disabled={isDisabled}
                            placeholder="https://..."
                          />
                        ) : contractHref ? (
                          <a href={contractHref} target="_blank" rel="noreferrer" className="inline-flex items-center justify-center w-7 h-7 rounded-lg bg-blue-50 text-blue-600 hover:bg-blue-100 transition-colors text-[10px] font-medium" title="Открыть договор">
                            Дог.
                          </a>
                        ) : (
                          <span className="text-zinc-300">—</span>
                        )}
                      </td>
                      <td className="px-2 py-3 align-top whitespace-nowrap text-center">
                        {isTableEditing ? (
                          <InlineInput
                            value={handoffValue}
                            onChange={(value) => setDraftValue(project.id, 'handoff_link', value)}
                            onCommit={(value) => void commitProjectUpdate(project, { handoff_link: value })}
                            disabled={isDisabled}
                            placeholder="https://..."
                          />
                        ) : handoffHref ? (
                          <a href={handoffHref} target="_blank" rel="noreferrer" className="inline-flex items-center justify-center w-7 h-7 rounded-lg bg-indigo-50 text-indigo-600 hover:bg-indigo-100 transition-colors text-[10px] font-medium" title="Открыть передачу">
                            Пер.
                          </a>
                        ) : (
                          <span className="text-zinc-300">—</span>
                        )}
                      </td>
                      <td className="px-2 py-3 align-top whitespace-nowrap">
                        {isTableEditing ? (
                          <InlineInput
                            value={deadlineValue}
                            onChange={(value) => setDraftValue(project.id, 'deadline', value)}
                            onCommit={(value) => void commitProjectUpdate(project, { deadline: value })}
                            disabled={isDisabled}
                            placeholder="DD.MM.YY"
                          />
                        ) : (() => {
                          const dlStatus = getDeadlineStatus(project.deadline);
                          return (
                            <span className={
                              dlStatus === 'overdue' ? 'text-red-600 font-semibold' :
                              dlStatus === 'soon' ? 'text-amber-600 font-medium' :
                              'text-zinc-600'
                            }>
                              {readOnlyDeadline}
                              {dlStatus === 'overdue' && <span className="ml-1 text-[10px]">●</span>}
                            </span>
                          );
                        })()}
                      </td>
                      <td className="px-2 py-3 align-top">
                        {isTableEditing ? (
                          <InlineInput
                            value={kpiValue}
                            onChange={(value) => setDraftValue(project.id, 'kpi_plan', value)}
                            onCommit={(value) => void commitProjectUpdate(project, { kpi_plan: value })}
                            disabled={isDisabled}
                            placeholder="KPI План"
                          />
                        ) : (
                          <span className="text-zinc-900">{readOnlyKpi}</span>
                        )}
                      </td>
                      <td className="px-2 py-3 align-top whitespace-nowrap">
                        {isTableEditing ? (
                          <InlineStepper
                            value={kpiFactValue}
                            onChange={(value) => setDraftValue(project.id, 'kpi_fact', value)}
                            onCommit={(value) => void commitProjectUpdate(project, { kpi_fact: value })}
                            disabled={isDisabled}
                            placeholder="Факт"
                          />
                        ) : (() => {
                          const kpiPlanNum = parseInt(project.kpi_plan ?? '0', 10) || 0;
                          const kpiFactNum = parseInt(project.kpi_fact ?? '0', 10) || 0;
                          return (
                          <KpiPaceTooltip
                            projectId={project.id}
                            kpiPlan={kpiPlanNum}
                            kpiFact={kpiFactNum}
                            deadline={project.deadline ?? null}
                          >
                          <div className="flex items-center gap-1">
                            <span className="text-zinc-900 tabular-nums">{readOnlyKpiFact}</span>
                            {canEdit && (
                              <div className="flex flex-col gap-px ml-0.5">
                                <button
                                  type="button"
                                  disabled={isSaving}
                                  onClick={() => {
                                    const cur = parseInt(project.kpi_fact ?? '0', 10);
                                    const next = (isNaN(cur) ? 0 : cur) + 1;
                                    void commitProjectUpdate(project, { kpi_fact: next.toString() });
                                  }}
                                  className="flex items-center justify-center w-4 h-3 text-zinc-300 hover:text-zinc-600 transition-colors disabled:opacity-30 leading-none"
                                  style={{ fontSize: '8px' }}
                                  title="Увеличить"
                                >
                                  ▲
                                </button>
                                <button
                                  type="button"
                                  disabled={isSaving}
                                  onClick={() => {
                                    const cur = parseInt(project.kpi_fact ?? '0', 10);
                                    const next = (isNaN(cur) ? 0 : cur) - 1;
                                    void commitProjectUpdate(project, { kpi_fact: next.toString() });
                                  }}
                                  className="flex items-center justify-center w-4 h-3 text-zinc-300 hover:text-zinc-600 transition-colors disabled:opacity-30 leading-none"
                                  style={{ fontSize: '8px' }}
                                  title="Уменьшить"
                                >
                                  ▼
                                </button>
                              </div>
                            )}
                          </div>
                          </KpiPaceTooltip>
                          );
                        })()}
                      </td>
                      <td className="px-1 py-3 align-middle text-center">
                        {(() => {
                          const risk = summarizeProjectRisk(
                            paceByProjectId.get(project.id),
                            isCompletedStatus(project.status),
                          );
                          if (risk.axes.length === 0) return null;
                          const axisLabel =
                            risk.axes.length === 2
                              ? 'KPI и контактам'
                              : risk.axes[0] === 'kpi'
                              ? 'KPI'
                              : 'контактам';
                          const tail =
                            risk.daysBehind > 0
                              ? ` на ${risk.daysBehind} ${pluralizeDays(risk.daysBehind)}`
                              : '';
                          const tooltip = `Не успеваем по ${axisLabel}${tail}`;
                          return (
                            <span
                              role="img"
                              aria-label={tooltip}
                              title={tooltip}
                              className="inline-flex items-center justify-center cursor-help"
                            >
                              <Clock className="w-3.5 h-3.5 text-red-500" strokeWidth={1.75} aria-hidden="true" />
                            </span>
                          );
                        })()}
                      </td>
                      <td className="px-2 py-3 align-top">
                        {(() => {
                          const obligation = parseInt(project.contacts_obligation ?? '0', 10) || 0;
                          const done = parseInt(project.contacts_done ?? '0', 10) || 0;
                          const pct = obligation > 0 ? Math.min(Math.round((done / obligation) * 100), 100) : 0;
                          const barColor = pct >= 100 ? 'bg-emerald-500' : pct >= 50 ? 'bg-blue-500' : 'bg-amber-500';
                          const isEditingThis = editingContactsId === project.id;

                          if (isEditingThis) {
                            return (
                              <input
                                type="text"
                                autoFocus
                                value={editingContactsValue}
                                onChange={(e) => setEditingContactsValue(e.target.value)}
                                onBlur={() => {
                                  const val = editingContactsValue;
                                  setProjects((prev) =>
                                    prev.map((p) => p.id === project.id ? { ...p, contacts_done: val } : p),
                                  );
                                  setEditingContactsId(null);
                                  void commitProjectUpdate(project, { contacts_done: val });
                                }}
                                onKeyDown={(e) => {
                                  if (e.key === 'Enter') e.currentTarget.blur();
                                  if (e.key === 'Escape') setEditingContactsId(null);
                                }}
                                className="w-full rounded-md border border-blue-400 bg-white px-2 py-1 text-sm text-zinc-900 outline-none ring-2 ring-blue-500/20"
                              />
                            );
                          }

                          const syncedAt = project.contacts_done_synced_at
                            ? new Date(project.contacts_done_synced_at)
                            : null;
                          const syncTitle = syncedAt && !isNaN(syncedAt.getTime())
                            ? `Автозаполнение из Instantly ${syncedAt.toLocaleString('ru-RU', {
                                day: '2-digit',
                                month: '2-digit',
                                year: 'numeric',
                                hour: '2-digit',
                                minute: '2-digit',
                                timeZone: 'Europe/Moscow',
                              })} МСК. Можно перезаписать вручную — следующее обновление в 10:00 МСК.`
                            : undefined;

                          return (
                            <ContactsPaceTooltip
                              projectId={project.id}
                              obligation={obligation}
                              done={done}
                              deadline={project.deadline ?? null}
                            >
                            <div
                              className={canEdit ? 'cursor-pointer hover:bg-zinc-100 rounded-md px-1 py-0.5 -mx-1 transition-colors' : ''}
                              title={syncTitle}
                              onClick={() => {
                                if (!canEdit || isSaving) return;
                                setEditingContactsValue(project.contacts_done || '0');
                                setEditingContactsId(project.id);
                              }}
                            >
                              {obligation > 0 ? (
                                <>
                                  <div className="flex items-baseline gap-0.5 mb-0.5">
                                    <span className="text-xs font-medium text-zinc-900 tabular-nums">{done.toLocaleString('ru-RU')}</span>
                                    <span className="text-[10px] text-zinc-400">/{obligation.toLocaleString('ru-RU')}</span>
                                  </div>
                                  <div className="w-full h-1 bg-zinc-200 rounded-full overflow-hidden">
                                    <div className={`h-full rounded-full transition-all ${barColor}`} style={{ width: `${pct}%` }} />
                                  </div>
                                </>
                              ) : done > 0 ? (
                                <span className="text-xs font-medium text-zinc-900 tabular-nums">{done.toLocaleString('ru-RU')}</span>
                              ) : (
                                <span className="text-zinc-300">—</span>
                              )}
                            </div>
                            </ContactsPaceTooltip>
                          );
                        })()}
                      </td>
                      <td className="px-2 py-3 align-top truncate">
                        {isTableEditing ? (
                          <InlineSelect
                            value={specialistValue}
                            options={specialistSelectOptions}
                            onChange={(value) => {
                              setDraftValue(project.id, 'specialist', value);
                              void commitProjectUpdate(project, { specialist: value });
                            }}
                            disabled={isDisabled}
                          />
                        ) : (
                          readOnlySpecialist !== '—' ? (
                             <div className="flex items-center gap-1">
                                <AssigneeAvatar
                                  name={readOnlySpecialist}
                                  signedUrl={assigneeAvatars.get(normalizeAssigneeName(readOnlySpecialist))}
                                  publicUrl={assigneePublicAvatars.get(normalizeAssigneeName(readOnlySpecialist))}
                                  tone="specialist"
                                />
                                <span className="text-zinc-700 truncate">{readOnlySpecialist}</span>
                             </div>
                          ) : <span className="text-zinc-300">—</span>
                        )}
                      </td>
                      <td className="px-2 py-3 align-top truncate">
                        {isTableEditing ? (
                          <InlineSelect
                            value={managerValue}
                            options={managerSelectOptions}
                            onChange={(value) => {
                              setDraftValue(project.id, 'manager', value);
                              void commitProjectUpdate(project, { manager: value });
                            }}
                            disabled={isDisabled}
                          />
                        ) : (
                           readOnlyManager !== '—' ? (
                             <div className="flex items-center gap-1">
                                <AssigneeAvatar
                                  name={readOnlyManager}
                                  signedUrl={assigneeAvatars.get(normalizeAssigneeName(readOnlyManager))}
                                  publicUrl={assigneePublicAvatars.get(normalizeAssigneeName(readOnlyManager))}
                                  tone="manager"
                                />
                                <span className="text-zinc-700 truncate">{readOnlyManager}</span>
                             </div>
                          ) : <span className="text-zinc-300">—</span>
                        )}
                      </td>
                      <td className="px-2 py-3 align-top whitespace-nowrap">
                        {isTableEditing ? (
                          <InlineSelect
                            value={workFormatValue}
                            options={WORK_FORMAT_OPTIONS}
                            onChange={(value) => {
                              setDraftValue(project.id, 'work_format', value);
                              void commitProjectUpdate(project, { work_format: value });
                            }}
                            disabled={isDisabled}
                          />
                        ) : platformConfig?.label ? (
                          <span className={`inline-flex items-center rounded-md px-2 py-1 text-xs font-medium ${platformConfig.className} ring-1 ring-inset ring-black/5`}>
                            {platformConfig.label}
                          </span>
                        ) : (
                          <span className="text-zinc-300">—</span>
                        )}
                    </td>
                      <td className="px-2 py-3 align-top relative">
                        {(() => {
                          const tasks = projectTasks[project.id] ?? [];
                          const latestTask = tasks[0];
                          const isOpen = taskPopoverId === project.id;
                          return (
                            <>
                              <div
                                className={`cursor-pointer rounded-md px-2 py-1 -mx-1 transition-colors ${isOpen ? 'bg-blue-50' : 'hover:bg-zinc-100'}`}
                                onClick={(e) => {
                                  if (isOpen) { setTaskPopoverId(null); setTaskPopoverPos(null); } else {
                                    const rect = e.currentTarget.getBoundingClientRect();
                                    const popoverW = 480;
                                    const openUp = rect.bottom + 300 > window.innerHeight;
                                    let left = rect.left;
                                    if (left + popoverW > window.innerWidth - 8) left = window.innerWidth - popoverW - 8;
                                    if (left < 8) left = 8;
                                    setTaskPopoverId(project.id);
                                    setTaskPopoverPos({ top: openUp ? rect.top : rect.bottom, left, openUp });
                                  }
                                }}
                              >
                                {latestTask ? (() => {
                                  const nearestDl = tasks.filter((t) => t.deadline && t.status !== 'done')
                                    .sort((a, b) => (a.deadline ?? '').localeCompare(b.deadline ?? ''))[0];
                                  const dlLabel = nearestDl?.deadline ? formatDeadlineLabel(nearestDl.deadline) : null;
                                  return (
                                    <div>
                                      <p className="text-xs text-zinc-900 line-clamp-2">{latestTask.title}</p>
                                      <div className="flex items-center gap-1.5 mt-0.5">
                                        {tasks.length > 1 && <span className="text-[10px] text-zinc-400">+{tasks.length - 1} ещё</span>}
                                        {dlLabel && (
                                          <span className={`inline-flex items-center gap-0.5 text-[10px] font-medium px-1 py-px rounded ${dlLabel.color}`}>
                                            <svg width="8" height="8" viewBox="0 0 16 16" fill="none"><path d="M12 2H4a2 2 0 00-2 2v8a2 2 0 002 2h8a2 2 0 002-2V4a2 2 0 00-2-2zM2 6h12M5 1v2M11 1v2" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/></svg>
                                            {dlLabel.text}
                                          </span>
                                        )}
                                      </div>
                                    </div>
                                  );
                                })() : (
                                  <span className="text-zinc-300 text-xs">{canEdit ? '+ задача' : '—'}</span>
                                )}
                              </div>
                              {isOpen && taskPopoverPos && (
                                <ItemPopover
                                  items={tasks}
                                  title="Задачи"
                                  popoverRef={taskPopoverRef}
                                  pos={taskPopoverPos}
                                  canEdit={canEdit}
                                  deleteConfirmId={deleteConfirmTaskId}
                                  setDeleteConfirmId={setDeleteConfirmTaskId}
                                  onDelete={(id) => void deleteTask(id, project.id)}
                                  onClose={() => { setTaskPopoverId(null); setTaskPopoverPos(null); }}
                                  newValue={newTaskTitle}
                                  setNewValue={setNewTaskTitle}
                                  onAdd={() => void addTask(project.id, newTaskTitle, project.specialist)}
                                  placeholder="Новая задача..."
                                  showStatusDot
                                  onItemClick={(item) => openTaskModal(project.id, item)}
                                />
                              )}
                            </>
                          );
                        })()}
                      </td>
                      <td className="px-2 py-3 align-top relative">
                        {(() => {
                          const notes = projectNotes[project.id] ?? [];
                          const latestNote = notes[0];
                          const isOpen = notePopoverId === project.id;
                          return (
                            <>
                              <div
                                className={`cursor-pointer rounded-md px-2 py-1 -mx-1 transition-colors ${isOpen ? 'bg-amber-50' : 'hover:bg-zinc-100'}`}
                                onClick={(e) => {
                                  if (isOpen) { setNotePopoverId(null); setNotePopoverPos(null); } else {
                                    const rect = e.currentTarget.getBoundingClientRect();
                                    const popoverW = 480;
                                    const openUp = rect.bottom + 300 > window.innerHeight;
                                    let left = rect.left;
                                    if (left + popoverW > window.innerWidth - 8) left = window.innerWidth - popoverW - 8;
                                    if (left < 8) left = 8;
                                    setNotePopoverId(project.id);
                                    setNotePopoverPos({ top: openUp ? rect.top : rect.bottom, left, openUp });
                                  }
                                }}
                              >
                                {latestNote ? (
                                  <div>
                                    <p className="text-xs text-zinc-900 line-clamp-2">{latestNote.title}</p>
                                    {notes.length > 1 && <p className="text-[10px] text-zinc-400 mt-0.5">+{notes.length - 1} ещё</p>}
                                  </div>
                                ) : (
                                  <span className="text-zinc-300 text-xs">{canEdit ? '+ заметка' : '—'}</span>
                                )}
                              </div>
                              {isOpen && notePopoverPos && (
                                <ItemPopover
                                  items={notes}
                                  title="Заметки"
                                  popoverRef={notePopoverRef}
                                  pos={notePopoverPos}
                                  canEdit={canEdit}
                                  deleteConfirmId={deleteConfirmNoteId}
                                  setDeleteConfirmId={setDeleteConfirmNoteId}
                                  onDelete={(id) => void deleteNote(id, project.id)}
                                  onClose={() => { setNotePopoverId(null); setNotePopoverPos(null); }}
                                  newValue={newNoteTitle}
                                  setNewValue={setNewNoteTitle}
                                  onAdd={() => void addNote(project.id, newNoteTitle)}
                                  placeholder="Новая заметка..."
                                />
                              )}
                            </>
                          );
                        })()}
                      </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          </div>
        </div>
      )}

      {selectedProject && (
        <div className={isTma ? 'fixed inset-0 z-50 flex items-stretch justify-center p-0' : 'fixed inset-0 z-50 flex items-center justify-center p-2 sm:p-3'}>
          <div
            className="absolute inset-0 bg-zinc-900/30 backdrop-blur-sm transition-opacity"
            onClick={() => setSelectedProjectId(null)}
          />
          <div className={isTma ? 'relative w-full h-[100dvh] overflow-y-auto rounded-none bg-white shadow-2xl ring-1 ring-zinc-900/5 flex flex-col' : 'project-modal-compact relative w-full max-w-3xl max-h-[90vh] overflow-y-auto rounded-2xl bg-white shadow-[0_8px_30px_rgb(0,0,0,0.08)] border border-zinc-200/60 flex flex-col'}>
            <div className={isTma ? 'flex flex-col gap-4 border-b border-zinc-100 px-4 py-4 sticky top-0 bg-white/95 backdrop-blur z-20 transition-all' : 'flex items-start justify-between border-b border-zinc-100 px-4 py-3 sticky top-0 bg-white/95 backdrop-blur z-20 transition-all'}>
              <div className={isTma ? 'flex-1' : 'flex-1 pr-4'}>
                <div className="flex items-center gap-3 mb-2">
                  <h2 className="text-xl font-medium text-zinc-900 leading-tight">
                    {selectedProject.client || (locale === 'en' ? 'Untitled' : 'Без названия')}
                  </h2>
                  {selectedProject.name && (
                    <div className="flex flex-wrap gap-1.5 mt-1">
                      {parseServices(selectedProject.name).map((service) => (
                        <span key={service} className="inline-flex items-center bg-blue-100 text-blue-800 text-xs font-medium px-2.5 py-0.5 rounded-full">{service}</span>
                      ))}
                    </div>
                  )}
                  {selectedProject.status && (
                     <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ring-1 ring-inset ${
                        getStatusConfig(selectedProject.status).bg.replace('bg-', 'bg-').replace('text-', 'text-').replace('border-', 'ring-')
                     } ${getStatusConfig(selectedProject.status).color}`}>
                       {translateStatusLabel(getStatusConfig(selectedProject.status).label, locale)}
                     </span>
                  )}
                </div>
                <div className="flex items-center gap-3 text-xs text-zinc-500">
                   <div className="flex items-center gap-1.5">
                     <span>
                      {locale === 'en' ? 'Deadline' : 'Дедлайн'}: {selectedProject.deadline ? formatDate(selectedProject.deadline) : (locale === 'en' ? 'Not set' : 'Не указан')}
                    </span>
                   </div>
                   {selectedProject.budget && (
                     <div className="flex items-center gap-1.5">
                       <span className="font-semibold text-zinc-700">{selectedProject.budget}</span>
                     </div>
                   )}
                </div>
              </div>
              <div className="flex items-center gap-2">
                {canDelete && (
                  <button
                    type="button"
                    onClick={() => requestDeleteProject(selectedProject.id)}
                    className="rounded-full p-2 text-zinc-400 hover:bg-red-50 hover:text-red-500 transition-all"
                    title={locale === 'en' ? 'Delete project' : 'Удалить проект'}
                  >
                    <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" /></svg>
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => setSelectedProjectId(null)}
                  className="group relative rounded-full p-2 text-zinc-400 hover:bg-zinc-100 hover:text-zinc-500 transition-all text-xl leading-none"
                >
                  &times;
                </button>
              </div>
            </div>

            <div className={isTma ? 'p-4 space-y-6 bg-white min-h-[500px]' : 'p-4 space-y-6 bg-white'}>
              
              <section className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div className="bg-zinc-50 rounded-xl p-3 border border-zinc-200 transition-colors group hover:bg-zinc-100/50">
                  <div className="flex items-center gap-3 mb-3">
                    <label className="text-xs font-medium text-zinc-700 tracking-wide uppercase">{locale === 'en' ? 'Specialist' : 'Специалист'}</label>
                  </div>
                  <InlineSelect
                    value={getDraftValue(selectedProject, 'specialist')}
                    options={ensureCurrentAssigneeOption(
                      assigneeOptions,
                      getDraftValue(selectedProject, 'specialist'),
                    )}
                    onChange={(value) => {
                      setDraftValue(selectedProject.id, 'specialist', value);
                      void commitProjectUpdate(selectedProject, { specialist: value });
                    }}
                    disabled={!canEdit || Boolean(savingRows[selectedProject.id])}
                    className="bg-white border border-zinc-300 shadow-sm focus:border-blue-500 px-2.5 py-1.5 text-xs font-medium rounded-lg text-zinc-900 placeholder:text-zinc-400"
                  />
                </div>
                
                <div className="bg-zinc-50 rounded-xl p-3 border border-zinc-200 transition-colors group hover:bg-zinc-100/50">
                  <div className="flex items-center gap-3 mb-3">
                    <label className="text-xs font-medium text-zinc-700 tracking-wide uppercase">Лид (PM)</label>
                  </div>
                  <InlineSelect
                    value={getDraftValue(selectedProject, 'manager')}
                    options={ensureCurrentAssigneeOption(
                      assigneeOptions,
                      getDraftValue(selectedProject, 'manager'),
                    )}
                    onChange={(value) => {
                      setDraftValue(selectedProject.id, 'manager', value);
                      void commitProjectUpdate(selectedProject, { manager: value });
                    }}
                    disabled={!canEdit || Boolean(savingRows[selectedProject.id])}
                    className="bg-white border border-zinc-300 shadow-sm focus:border-blue-500 px-2.5 py-1.5 text-xs font-medium rounded-lg text-zinc-900 placeholder:text-zinc-400"
                  />
                </div>
              </section>

              <section>
                <h3 className="text-sm font-medium text-zinc-900 mb-2 flex items-center gap-2 tracking-tight">
                  ОБРАТНАЯ СВЯЗЬ
                </h3>
                <div className="relative group">
                   <div className="absolute -inset-1 rounded-xl bg-zinc-100 opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none" />
                   <div className="relative">
                      <InlineTextarea
                        value={getDraftValue(selectedProject, 'client_feedback')}
                        onChange={(value) => setDraftValue(selectedProject.id, 'client_feedback', value)}
                        onCommit={(value) => void commitProjectUpdate(selectedProject, { client_feedback: value })}
                        disabled={!canEdit || Boolean(savingRows[selectedProject.id])}
                        placeholder="Добавьте обратную связь от заказчика..."
                        rows={2}
                        className="bg-white border border-zinc-300 shadow-sm focus:border-blue-500 p-2 text-sm text-zinc-700 leading-relaxed resize-none rounded-lg placeholder:text-zinc-400"
                      />
                   </div>
                </div>
              </section>

              <section className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div className="flex flex-col h-full rounded-xl bg-blue-50/30 border border-blue-100 p-3 transition-all hover:shadow-md hover:border-blue-200">
                   <h3 className="text-xs font-medium text-blue-900 uppercase tracking-wide mb-2 flex items-center gap-2">
                     <span className="w-2 h-2 rounded-full bg-blue-600 ring-2 ring-blue-100"></span>
                     Гипотезы и Задачи
                   </h3>
                   <InlineTextarea
                      value={getDraftValueWithFallback(
                        selectedProject,
                        'hypotheses',
                        selectedProject.weekly_tasks || '',
                      )}
                      onChange={(value) => setDraftValue(selectedProject.id, 'hypotheses', value)}
                      onCommit={(value) => void commitProjectUpdate(selectedProject, { hypotheses: value })}
                      disabled={!canEdit || Boolean(savingRows[selectedProject.id])}
                      placeholder="Опишите гипотезы и задачи..."
                      rows={6}
                      className="flex-1 bg-white border border-zinc-200 shadow-sm focus:border-blue-500 text-sm text-zinc-700 leading-relaxed rounded-lg placeholder:text-zinc-400 p-2"
                   />
                </div>
                
                <div className="flex flex-col h-full rounded-xl bg-emerald-50/30 border border-emerald-100 p-3 transition-all hover:shadow-md hover:border-emerald-200">
                   <h3 className="text-xs font-medium text-emerald-900 uppercase tracking-wide mb-2 flex items-center gap-2">
                     <span className="w-2 h-2 rounded-full bg-emerald-600 ring-2 ring-emerald-100"></span>
                     Результат
                   </h3>
                   <InlineTextarea
                      value={getDraftValue(selectedProject, 'hypotheses_result')}
                      onChange={(value) => setDraftValue(selectedProject.id, 'hypotheses_result', value)}
                      onCommit={(value) => void commitProjectUpdate(selectedProject, { hypotheses_result: value })}
                      disabled={!canEdit || Boolean(savingRows[selectedProject.id])}
                      placeholder="Каков результат?"
                      rows={6}
                      className="flex-1 bg-white border border-zinc-200 shadow-sm focus:border-emerald-500 text-sm text-zinc-700 leading-relaxed rounded-lg placeholder:text-zinc-400 p-2"
                   />
                </div>
              </section>

              <section>
                <h3 className="text-sm font-medium text-zinc-900 mb-2">Подзадачи и комментарии</h3>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div>
                    <label className="block text-xs font-medium text-zinc-700 mb-2">Подзадачи</label>
                    <InlineTextarea
                      value={getDraftValue(selectedProject, 'subtasks')}
                      onChange={(value) => setDraftValue(selectedProject.id, 'subtasks', value)}
                      onCommit={(value) => void commitProjectUpdate(selectedProject, { subtasks: value })}
                      disabled={!canEdit || Boolean(savingRows[selectedProject.id])}
                      placeholder="Список подзадач..."
                      rows={3}
                      className="bg-white border border-zinc-300 shadow-sm focus:border-blue-500 text-sm text-zinc-700 rounded-lg placeholder:text-zinc-400 p-2"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-zinc-700 mb-2">Комментарий передачи</label>
                    <InlineTextarea
                      value={getDraftValue(selectedProject, 'comments')}
                      onChange={(value) => setDraftValue(selectedProject.id, 'comments', value)}
                      onCommit={(value) => void commitProjectUpdate(selectedProject, { comments: value })}
                      disabled={!canEdit || Boolean(savingRows[selectedProject.id])}
                      placeholder="Внутренний комментарий..."
                      rows={3}
                      className="bg-white border border-zinc-300 shadow-sm focus:border-blue-500 text-sm text-zinc-700 rounded-lg placeholder:text-zinc-400 p-2"
                    />
                  </div>
                </div>
              </section>

              <section>
                <div className="flex items-center justify-between mb-2">
                  <h3 className="text-sm font-medium text-zinc-900">Материалы и ссылки</h3>
                </div>
                <div className="bg-zinc-50/80 rounded-xl p-3 border border-zinc-100">
                  <InlineTextarea
                    value={getDraftValue(selectedProject, 'materials_links')}
                    onChange={(value) => setDraftValue(selectedProject.id, 'materials_links', value)}
                    onCommit={(value) => void commitProjectUpdate(selectedProject, { materials_links: value })}
                    disabled={!canEdit || Boolean(savingRows[selectedProject.id])}
                    placeholder="Вставьте ссылки (каждая с новой строки)..."
                    rows={2}
                    className="bg-white border border-zinc-300 shadow-sm mb-3 focus:ring-2 focus:ring-blue-500/10 focus:border-blue-500 rounded-lg"
                  />
                  
                  {parseMaterials(getDraftValue(selectedProject, 'materials_links')).length > 0 && (
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                        {parseMaterials(getDraftValue(selectedProject, 'materials_links')).map((item, index) => {
                          const url = normalizeUrl(item);
                          return (
                            <div key={`${item}-${index}`} className="group relative flex items-center p-2 bg-white rounded-lg border border-zinc-200 shadow-sm hover:border-blue-400 hover:shadow-md transition-all duration-200">
                              {url ? (
                                <a
                                  href={url}
                                  target="_blank"
                                  rel="noreferrer"
                                  className="flex items-center w-full min-w-0"
                                >
                                  <div className="flex-shrink-0 w-6 h-6 flex items-center justify-center rounded-md bg-blue-50 text-blue-600 group-hover:bg-blue-600 group-hover:text-white transition-colors mr-2 text-[10px] font-medium">
                                    ↗
                                  </div>
                                  <div className="flex-1 min-w-0">
                                    <p className="text-xs font-medium text-zinc-900 truncate group-hover:text-blue-600 transition-colors">
                                      {formatUrlLabel(url)}
                                    </p>
                                    <p className="text-xs text-zinc-400 truncate">Открыть ссылку</p>
                                  </div>
                                </a>
                              ) : (
                                <div className="flex items-center w-full min-w-0">
                                  <div className="flex-shrink-0 w-6 h-6 flex items-center justify-center rounded-md bg-zinc-100 text-zinc-500 mr-2 text-[10px] font-medium">
                                    TXT
                                  </div>
                                  <span className="text-xs font-medium text-zinc-700 truncate">{item}</span>
                                </div>
                              )}
                            </div>
                          );
                        })}
                    </div>
                  )}
                </div>
              </section>

              {/* Instantly Campaigns */}
              <section>
                <h3 className="text-sm font-medium text-zinc-900 mb-2">Кампании Instantly</h3>
                {panelLinkedCampaigns.length === 0 ? (
                  <p className="text-xs text-zinc-400 mb-2">Нет привязанных кампаний</p>
                ) : (
                  <div className="space-y-1 mb-2">
                    {panelLinkedCampaigns.map((camp) => (
                      <div key={camp.campaign_id} className="flex items-center justify-between gap-2 rounded-lg border border-zinc-100 px-2.5 py-1.5 text-xs">
                        <div className="flex items-center gap-1.5 min-w-0">
                          <span className="truncate text-zinc-700">{camp.campaign_name}</span>
                          <span className={`shrink-0 rounded px-1 py-0.5 text-[9px] font-medium ${camp.match_source === 'auto' ? 'bg-blue-50 text-blue-500' : 'bg-violet-50 text-violet-500'}`}>
                            {camp.match_source === 'auto' ? 'авто' : 'вручную'}
                          </span>
                        </div>
                        {canEdit && (
                          <button
                            type="button"
                            onClick={() => void removePanelCampaign(selectedProject.id, camp.campaign_id)}
                            className="shrink-0 text-zinc-300 hover:text-red-400 transition-colors"
                          >
                            <svg xmlns="http://www.w3.org/2000/svg" className="h-3.5 w-3.5" viewBox="0 0 20 20" fill="currentColor">
                              <path fillRule="evenodd" d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z" clipRule="evenodd" />
                            </svg>
                          </button>
                        )}
                      </div>
                    ))}
                  </div>
                )}
                {canEdit && (
                  <div>
                    {!showPanelCampaignPicker ? (
                      <button
                        type="button"
                        onClick={() => setShowPanelCampaignPicker(true)}
                        className="inline-flex items-center gap-1 text-xs text-blue-600 hover:text-blue-700"
                      >
                        <svg xmlns="http://www.w3.org/2000/svg" className="h-3.5 w-3.5" viewBox="0 0 20 20" fill="currentColor">
                          <path fillRule="evenodd" d="M10 3a1 1 0 011 1v5h5a1 1 0 110 2h-5v5a1 1 0 11-2 0v-5H4a1 1 0 110-2h5V4a1 1 0 011-1z" clipRule="evenodd" />
                        </svg>
                        Привязать кампанию
                      </button>
                    ) : (
                      <div className="space-y-1.5">
                        <input
                          type="text"
                          value={panelCampaignSearch}
                          onChange={(e) => setPanelCampaignSearch(e.target.value)}
                          placeholder="Поиск кампании..."
                          className="w-full rounded-lg border border-zinc-200 px-2.5 py-1.5 text-xs focus:border-blue-400 focus:outline-none"
                          autoFocus
                        />
                        <div className="max-h-36 overflow-y-auto rounded-lg border border-zinc-100">
                          {(() => {
                            const linkedIds = new Set(panelLinkedCampaigns.map((c) => c.campaign_id));
                            const filtered = panelAllCampaigns
                              .filter((c) => !linkedIds.has(c.id))
                              .filter((c) => !panelCampaignSearch || c.name.toLowerCase().includes(panelCampaignSearch.toLowerCase()));
                            if (filtered.length === 0) return <p className="px-2.5 py-2 text-xs text-zinc-400">Не найдено</p>;
                            return filtered.slice(0, 15).map((c) => (
                              <button
                                key={c.id}
                                type="button"
                                onClick={() => void addPanelCampaign(selectedProject.id, c.id)}
                                className="w-full text-left px-2.5 py-1.5 text-xs text-zinc-600 hover:bg-blue-50 hover:text-blue-700 border-b border-zinc-50 last:border-0"
                              >
                                {c.name}
                              </button>
                            ));
                          })()}
                        </div>
                        <button
                          type="button"
                          onClick={() => { setShowPanelCampaignPicker(false); setPanelCampaignSearch(''); }}
                          className="text-[10px] text-zinc-400 hover:text-zinc-600"
                        >
                          Отмена
                        </button>
                      </div>
                    )}
                  </div>
                )}
              </section>

              {/* Client brief PDF + AI lead-source hypotheses */}
              <section>
                <ProjectBriefSection
                  projectId={selectedProject.id}
                  brief={{
                    brief_file_path: selectedProject.brief_file_path,
                    brief_file_name: selectedProject.brief_file_name,
                    brief_uploaded_at: selectedProject.brief_uploaded_at,
                    lead_source_hypotheses: selectedProject.lead_source_hypotheses,
                    lead_source_hypotheses_generated_at: selectedProject.lead_source_hypotheses_generated_at,
                    lead_source_hypotheses_error: selectedProject.lead_source_hypotheses_error,
                  }}
                  canEdit={canEdit}
                  onChange={(next) => {
                    setProjects((prev) =>
                      prev.map((item) =>
                        item.id === selectedProject.id ? { ...item, ...next } : item,
                      ),
                    );
                  }}
                />
              </section>

              {/* Collapsible Project Settings */}
              {canEdit && (
                <section className="border-t border-zinc-200 pt-4">
                  <button
                    type="button"
                    onClick={() => setShowProjectSettings(!showProjectSettings)}
                    className="flex items-center gap-2 w-full px-3 py-2 bg-zinc-100 hover:bg-zinc-200 rounded-lg transition-colors"
                  >
                    <svg className={`w-4 h-4 text-zinc-600 transition-transform ${showProjectSettings ? 'rotate-90' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                    </svg>
                    <span className="text-xs font-medium text-zinc-700 uppercase tracking-wide">Настройки проекта</span>
                    <span className="text-[10px] text-zinc-400 ml-auto">{showProjectSettings ? 'Свернуть' : 'Развернуть'}</span>
                  </button>

                  {showProjectSettings && (
                    <div className="mt-3 space-y-3">
                      {/* Client & Status */}
                      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                        <div>
                          <label className="block text-xs font-medium text-zinc-500 uppercase tracking-wide mb-2">Клиент</label>
                          <InlineInput
                            value={getDraftValue(selectedProject, 'client')}
                            onChange={(value) => setDraftValue(selectedProject.id, 'client', value)}
                            onCommit={(value) => void commitProjectUpdate(selectedProject, { client: value })}
                            disabled={Boolean(savingRows[selectedProject.id])}
                            placeholder="Название компании"
                          />
                        </div>
                        <div>
                          <label className="block text-xs font-medium text-zinc-500 uppercase tracking-wide mb-2">Статус</label>
                          <InlineSelect
                            value={getDraftValue(selectedProject, 'status')}
                            options={STATUS_OPTIONS}
                            onChange={(value) => {
                              setDraftValue(selectedProject.id, 'status', value);
                              void commitProjectUpdate(selectedProject, { status: value as ProjectStatus });
                            }}
                            disabled={Boolean(savingRows[selectedProject.id])}
                          />
                        </div>
                      </div>

                      {/* Services */}
                      <div>
                        <label className="block text-xs font-medium text-zinc-500 uppercase tracking-wide mb-2">Услуги</label>
                        <div className="flex flex-wrap gap-2">
                          {SERVICE_OPTIONS.map((service) => {
                            const currentServices = parseServices(getDraftValue(selectedProject, 'name'));
                            const isSelected = currentServices.includes(service);
                            return (
                              <button
                                key={service}
                                type="button"
                                disabled={Boolean(savingRows[selectedProject.id])}
                                onClick={() => {
                                  const updated = isSelected
                                    ? currentServices.filter((s) => s !== service)
                                    : [...currentServices, service];
                                  const newValue = updated.join(', ');
                                  setDraftValue(selectedProject.id, 'name', newValue);
                                  void commitProjectUpdate(selectedProject, { name: newValue });
                                }}
                                className={`px-2.5 py-1 rounded-md border text-xs font-medium transition-colors disabled:opacity-50 ${
                                  isSelected
                                    ? 'bg-blue-600 text-white border-blue-600'
                                    : 'bg-white text-zinc-700 border-zinc-300 hover:border-blue-400 hover:bg-blue-50'
                                }`}
                              >
                                {service}
                              </button>
                            );
                          })}
                        </div>
                      </div>

                      {/* Financial */}
                      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                        <div>
                          <label className="block text-xs font-medium text-zinc-500 uppercase tracking-wide mb-2">Сумма договора</label>
                          <InlineInput
                            value={getDraftValue(selectedProject, 'budget')}
                            onChange={(value) => setDraftValue(selectedProject.id, 'budget', value)}
                            onCommit={(value) => void commitProjectUpdate(selectedProject, { budget: value })}
                            disabled={Boolean(savingRows[selectedProject.id])}
                            placeholder="150000"
                          />
                        </div>
                        <div>
                          <label className="block text-xs font-medium text-zinc-500 uppercase tracking-wide mb-2">Маржа</label>
                          <InlineInput
                            value={getDraftValue(selectedProject, 'margin')}
                            onChange={(value) => setDraftValue(selectedProject.id, 'margin', value)}
                            onCommit={(value) => void commitProjectUpdate(selectedProject, { margin: value })}
                            disabled={Boolean(savingRows[selectedProject.id])}
                            placeholder="Маржа %"
                          />
                        </div>
                        <div>
                          <label className="block text-xs font-medium text-zinc-500 uppercase tracking-wide mb-2">Тип проекта</label>
                          <InlineSelect
                            value={getDraftValue(selectedProject, 'project_type')}
                            options={PROJECT_TYPE_OPTIONS}
                            onChange={(value) => {
                              setDraftValue(selectedProject.id, 'project_type', value);
                              void commitProjectUpdate(selectedProject, { project_type: value as Project['project_type'] });
                            }}
                            disabled={Boolean(savingRows[selectedProject.id])}
                          />
                        </div>
                      </div>

                      {/* Platform & Source */}
                      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                        <div>
                          <label className="block text-xs font-medium text-zinc-500 uppercase tracking-wide mb-2">Где ведется проект</label>
                          <InlineSelect
                            value={getDraftValue(selectedProject, 'work_format')}
                            options={WORK_FORMAT_OPTIONS}
                            onChange={(value) => {
                              setDraftValue(selectedProject.id, 'work_format', value);
                              void commitProjectUpdate(selectedProject, { work_format: value });
                            }}
                            disabled={Boolean(savingRows[selectedProject.id])}
                          />
                        </div>
                        <div>
                          <label className="block text-xs font-medium text-zinc-500 uppercase tracking-wide mb-2">Источник лида</label>
                          <InlineSelect
                            value={getDraftValue(selectedProject, 'lead_source')}
                            options={LEAD_SOURCE_OPTIONS}
                            onChange={(value) => {
                              setDraftValue(selectedProject.id, 'lead_source', value);
                              void commitProjectUpdate(selectedProject, { lead_source: value });
                            }}
                            disabled={Boolean(savingRows[selectedProject.id])}
                          />
                        </div>
                      </div>

                      {/* Dates */}
                      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                        <div>
                          <label className="block text-xs font-medium text-zinc-500 uppercase tracking-wide mb-2">Дата оплаты</label>
                          <InlineInput
                            value={getDraftValue(selectedProject, 'payment_date')}
                            onChange={(value) => setDraftValue(selectedProject.id, 'payment_date', value)}
                            onCommit={(value) => void commitProjectUpdate(selectedProject, { payment_date: value })}
                            disabled={Boolean(savingRows[selectedProject.id])}
                            type="date"
                          />
                        </div>
                        <div>
                          <label className="block text-xs font-medium text-zinc-500 uppercase tracking-wide mb-2">Дата договора</label>
                          <InlineInput
                            value={getDraftValue(selectedProject, 'contract_date')}
                            onChange={(value) => setDraftValue(selectedProject.id, 'contract_date', value)}
                            onCommit={(value) => void commitProjectUpdate(selectedProject, { contract_date: value })}
                            disabled={Boolean(savingRows[selectedProject.id])}
                            type="date"
                          />
                        </div>
                      </div>

                      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                        <div>
                          <label className="block text-xs font-medium text-zinc-500 uppercase tracking-wide mb-2">Дата запуска</label>
                          <InlineInput
                            value={getDraftValue(selectedProject, 'launch_date')}
                            onChange={(value) => setDraftValue(selectedProject.id, 'launch_date', value)}
                            onCommit={(value) => void commitProjectUpdate(selectedProject, { launch_date: value })}
                            disabled={Boolean(savingRows[selectedProject.id])}
                            type="date"
                          />
                        </div>
                        <div>
                          <label className="block text-xs font-medium text-zinc-500 uppercase tracking-wide mb-2">Дедлайн</label>
                          <InlineInput
                            value={getDraftValue(selectedProject, 'deadline')}
                            onChange={(value) => setDraftValue(selectedProject.id, 'deadline', value)}
                            onCommit={(value) => void commitProjectUpdate(selectedProject, { deadline: value })}
                            disabled={Boolean(savingRows[selectedProject.id])}
                            type="date"
                          />
                        </div>
                      </div>

                      {/* Links */}
                      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                        <div>
                          <label className="block text-xs font-medium text-zinc-500 uppercase tracking-wide mb-2">Ссылка на договор</label>
                          <InlineInput
                            value={getDraftValue(selectedProject, 'contract_link')}
                            onChange={(value) => setDraftValue(selectedProject.id, 'contract_link', value)}
                            onCommit={(value) => void commitProjectUpdate(selectedProject, { contract_link: value })}
                            disabled={Boolean(savingRows[selectedProject.id])}
                            placeholder="https://..."
                          />
                        </div>
                        <div>
                          <label className="block text-xs font-medium text-zinc-500 uppercase tracking-wide mb-2">Ссылка на передачу</label>
                          <InlineInput
                            value={getDraftValue(selectedProject, 'handoff_link')}
                            onChange={(value) => setDraftValue(selectedProject.id, 'handoff_link', value)}
                            onCommit={(value) => void commitProjectUpdate(selectedProject, { handoff_link: value })}
                            disabled={Boolean(savingRows[selectedProject.id])}
                            placeholder="https://..."
                          />
                        </div>
                      </div>

                      {/* KPI */}
                      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                        <div>
                          <label className="block text-xs font-medium text-zinc-500 uppercase tracking-wide mb-2">KPI План</label>
                          <InlineInput
                            value={getDraftValue(selectedProject, 'kpi_plan')}
                            onChange={(value) => setDraftValue(selectedProject.id, 'kpi_plan', value)}
                            onCommit={(value) => void commitProjectUpdate(selectedProject, { kpi_plan: value })}
                            disabled={Boolean(savingRows[selectedProject.id])}
                            placeholder="KPI план"
                          />
                        </div>
                        <div>
                          <label className="block text-xs font-medium text-zinc-500 uppercase tracking-wide mb-2">KPI Факт</label>
                          <InlineInput
                            value={getDraftValue(selectedProject, 'kpi_fact')}
                            onChange={(value) => setDraftValue(selectedProject.id, 'kpi_fact', value)}
                            onCommit={(value) => void commitProjectUpdate(selectedProject, { kpi_fact: value })}
                            disabled={Boolean(savingRows[selectedProject.id])}
                            placeholder="KPI факт"
                          />
                        </div>
                      </div>

                      {/* Contacts */}
                      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                        <div>
                          <label className="block text-xs font-medium text-zinc-500 uppercase tracking-wide mb-2">Обязательство по контактам</label>
                          <InlineInput
                            value={getDraftValue(selectedProject, 'contacts_obligation')}
                            onChange={(value) => setDraftValue(selectedProject.id, 'contacts_obligation', value)}
                            onCommit={(value) => void commitProjectUpdate(selectedProject, { contacts_obligation: value })}
                            disabled={Boolean(savingRows[selectedProject.id])}
                            placeholder="Например 4000"
                          />
                        </div>
                        <div>
                          <label className="block text-xs font-medium text-zinc-500 uppercase tracking-wide mb-2">Контактов пройдено</label>
                          <InlineInput
                            value={getDraftValue(selectedProject, 'contacts_done')}
                            onChange={(value) => setDraftValue(selectedProject.id, 'contacts_done', value)}
                            onCommit={(value) => void commitProjectUpdate(selectedProject, { contacts_done: value })}
                            disabled={Boolean(savingRows[selectedProject.id])}
                            placeholder="0"
                          />
                        </div>
                      </div>
                    </div>
                  )}
                </section>
              )}
            </div>
            
             {selectedProject.updated_at && (
               <div className={isTma ? 'px-4 py-3 border-t border-zinc-100' : 'px-8 py-3 rounded-b-3xl border-t border-zinc-100'}>
                 <span className="text-xs text-zinc-400">
                    Последнее обновление: {new Date(selectedProject.updated_at).toLocaleDateString()}
                 </span>
               </div>
             )}
          </div>
        </div>
      )}

      {taskModalContext && taskModalTask && (
        <div className="fixed inset-0 z-[65] flex items-center justify-center p-4">
          <div
            className="fixed inset-0 bg-black/30 backdrop-blur-[1px]"
            onClick={() => {
              if (!taskModalSaving && !taskModalDeleting) setTaskModalContext(null);
            }}
          />
          <div className="relative w-full max-w-md rounded-2xl border border-zinc-200/80 bg-white shadow-2xl">
            <div className="flex items-center justify-between border-b border-zinc-100 px-4 py-3">
              <h3 className="text-base font-semibold text-zinc-900">{locale === 'en' ? 'Task' : 'Задача'}</h3>
              <button
                type="button"
                onClick={() => setTaskModalContext(null)}
                disabled={taskModalSaving || taskModalDeleting}
                className="flex h-7 w-7 items-center justify-center rounded-lg text-zinc-400 transition-colors hover:bg-zinc-100 hover:text-zinc-600 disabled:opacity-50"
                aria-label={locale === 'en' ? 'Close' : 'Закрыть'}
              >
                ×
              </button>
            </div>
            <div className="space-y-4 p-4">
              <div>
                <label className="mb-1 block text-xs font-medium uppercase tracking-wide text-zinc-500">
                  {locale === 'en' ? 'Title' : 'Название'}
                </label>
                <input
                  type="text"
                  value={taskModalTitle}
                  onChange={(e) => setTaskModalTitle(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') void saveTaskFromModal();
                  }}
                  className="w-full rounded-lg border border-zinc-200 px-3 py-2 text-sm text-zinc-800 outline-none transition-colors focus:border-blue-400"
                  placeholder={locale === 'en' ? 'Task title...' : 'Название задачи...'}
                />
              </div>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <div>
                  <label className="mb-1 block text-xs font-medium uppercase tracking-wide text-zinc-500">
                    {locale === 'en' ? 'Status' : 'Статус'}
                  </label>
                  <select
                    value={taskModalStatus}
                    onChange={(e) => setTaskModalStatus(e.target.value as TaskStatus)}
                    className="w-full rounded-lg border border-zinc-200 bg-white px-3 py-2 text-sm text-zinc-800 outline-none transition-colors focus:border-blue-400"
                  >
                    {(['pending', 'in_progress', 'done'] as TaskStatus[]).map((status) => (
                      <option key={status} value={status}>
                        {getTaskStatusLabel(status, locale)}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="mb-1 block text-xs font-medium uppercase tracking-wide text-zinc-500">
                    {locale === 'en' ? 'Deadline' : 'Срок'}
                  </label>
                  <input
                    type="datetime-local"
                    value={taskModalDeadline}
                    onChange={(e) => setTaskModalDeadline(e.target.value)}
                    className="w-full rounded-lg border border-zinc-200 px-3 py-2 text-sm text-zinc-800 outline-none transition-colors focus:border-blue-400"
                  />
                </div>
              </div>
              <div className="flex items-center justify-between border-t border-zinc-100 pt-3">
                <button
                  type="button"
                  onClick={() => setDeleteConfirmTaskId(taskModalTask.id)}
                  disabled={taskModalSaving || taskModalDeleting}
                  className="rounded-lg border border-red-200 px-3 py-2 text-sm font-medium text-red-600 transition-colors hover:bg-red-50 disabled:opacity-50"
                >
                  {locale === 'en' ? 'Delete' : 'Удалить'}
                </button>
                <div className="flex items-center gap-2">
                  {taskModalDeadline && (
                    <button
                      type="button"
                      onClick={() => setTaskModalDeadline('')}
                      disabled={taskModalSaving || taskModalDeleting}
                      className="rounded-lg border border-zinc-200 px-3 py-2 text-sm font-medium text-zinc-600 transition-colors hover:bg-zinc-50 disabled:opacity-50"
                    >
                      {locale === 'en' ? 'Clear date' : 'Убрать срок'}
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => setTaskModalContext(null)}
                    disabled={taskModalSaving || taskModalDeleting}
                    className="rounded-lg border border-zinc-200 px-3 py-2 text-sm font-medium text-zinc-600 transition-colors hover:bg-zinc-50 disabled:opacity-50"
                  >
                    {locale === 'en' ? 'Cancel' : 'Отмена'}
                  </button>
                  <button
                    type="button"
                    onClick={() => void saveTaskFromModal()}
                    disabled={taskModalSaving || taskModalDeleting || !taskModalTitle.trim()}
                    className="rounded-lg bg-zinc-900 px-3 py-2 text-sm font-medium text-white transition-colors hover:bg-zinc-800 disabled:opacity-50"
                  >
                    {taskModalSaving ? (locale === 'en' ? 'Saving...' : 'Сохранение...') : (locale === 'en' ? 'Save' : 'Сохранить')}
                  </button>
                </div>
              </div>
              {deleteConfirmTaskId === taskModalTask.id && (
                <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2">
                  <p className="text-xs text-red-700">
                    {locale === 'en' ? 'Delete this task permanently?' : 'Удалить эту задачу без возможности восстановления?'}
                  </p>
                  <div className="mt-2 flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => void deleteTaskFromModal()}
                      disabled={taskModalDeleting || taskModalSaving}
                      className="rounded-md bg-red-600 px-2.5 py-1.5 text-xs font-medium text-white hover:bg-red-700 disabled:opacity-50"
                    >
                      {taskModalDeleting ? (locale === 'en' ? 'Deleting...' : 'Удаление...') : (locale === 'en' ? 'Yes, delete' : 'Да, удалить')}
                    </button>
                    <button
                      type="button"
                      onClick={() => setDeleteConfirmTaskId(null)}
                      disabled={taskModalDeleting || taskModalSaving}
                      className="rounded-md border border-zinc-200 px-2.5 py-1.5 text-xs font-medium text-zinc-600 hover:bg-white disabled:opacity-50"
                    >
                      {locale === 'en' ? 'Cancel' : 'Отмена'}
                    </button>
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Delete confirmation modal */}
      {deleteConfirmId && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center">
          <div
            className="fixed inset-0 bg-black/50"
            onClick={() => {
              if (!deleting) {
                setDeleteConfirmId(null);
                setDeleteError(null);
              }
            }}
          />
          <div className="relative bg-white rounded-2xl shadow-2xl max-w-md w-full mx-4 p-6">
            <div className="flex items-center justify-center w-12 h-12 mx-auto rounded-full bg-red-100 mb-4">
              <svg xmlns="http://www.w3.org/2000/svg" className="h-6 w-6 text-red-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4c-.77-.833-1.964-.833-2.732 0L4.082 16.5c-.77.833.192 2.5 1.732 2.5z" />
              </svg>
            </div>
            <h3 className="text-lg font-semibold text-zinc-900 text-center">Удалить проект?</h3>
            <p className="mt-2 text-sm text-zinc-500 text-center">
              Вы уверены, что хотите удалить проект{' '}
              <span className="font-medium text-zinc-700">
                {projects.find((p) => p.id === deleteConfirmId)?.client || 'Без названия'}
              </span>
              ? Это действие нельзя отменить.
            </p>
            {deleteError && (
              <div className="mt-4 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
                {deleteError}
              </div>
            )}
            <div className="mt-6 flex gap-3">
              <button
                type="button"
                onClick={() => {
                  setDeleteConfirmId(null);
                  setDeleteError(null);
                }}
                disabled={deleting}
                className="flex-1 px-4 py-2.5 border border-zinc-300 rounded-lg text-sm font-medium text-zinc-700 hover:bg-zinc-50 transition-colors disabled:opacity-50"
              >
                Отмена
              </button>
              <button
                type="button"
                onClick={() => deleteConfirmId && deleteProject(deleteConfirmId)}
                disabled={deleting}
                className="flex-1 px-4 py-2.5 bg-red-600 text-white rounded-lg text-sm font-medium hover:bg-red-700 transition-colors disabled:opacity-50"
              >
                {deleting ? 'Удаление...' : 'Да, удалить'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function InlineStepper({
  value,
  onChange,
  onCommit,
  disabled,
  placeholder,
  className,
}: {
  value: string;
  onChange: (value: string) => void;
  onCommit?: (value: string) => void;
  disabled?: boolean;
  placeholder?: string;
  className?: string;
}) {
  const numericValue = parseInt(value, 10);
  const isValidNumber = !isNaN(numericValue);

  const handleStep = (step: number) => {
    if (disabled) return;
    const current = isValidNumber ? numericValue : 0;
    const newValue = (current + step).toString();
    onChange(newValue);
    onCommit?.(newValue);
  };

  return (
    <div className={`relative flex items-center ${className || ''}`}>
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onBlur={(e) => onCommit?.(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.currentTarget.blur();
          }
        }}
        disabled={disabled}
        placeholder={placeholder}
        className="w-full rounded-lg border border-zinc-200 bg-white pl-3 pr-8 py-2 text-sm text-zinc-900 placeholder-zinc-400 focus:border-zinc-400 focus:ring-4 focus:ring-zinc-900/5 outline-none transition-all disabled:bg-zinc-50 disabled:text-zinc-500 disabled:cursor-not-allowed"
      />
      <div className="absolute right-1 top-1/2 -translate-y-1/2 flex flex-col gap-0.5">
        <button
          type="button"
          onClick={(e) => {
            e.preventDefault(); // prevent focus loss
            handleStep(1);
          }}
          disabled={disabled}
          className="flex h-3.5 w-5 items-center justify-center rounded-sm bg-zinc-100 text-zinc-500 hover:bg-zinc-200 hover:text-zinc-700 disabled:opacity-50 text-[10px]"
        >
          ▲
        </button>
        <button
          type="button"
          onClick={(e) => {
             e.preventDefault();
             handleStep(-1);
          }}
          disabled={disabled}
          className="flex h-3.5 w-5 items-center justify-center rounded-sm bg-zinc-100 text-zinc-500 hover:bg-zinc-200 hover:text-zinc-700 disabled:opacity-50 text-[10px]"
        >
          ▼
        </button>
      </div>
    </div>
  );
}

function InlineInput({
  value,
  onChange,
  onCommit,
  disabled,
  placeholder,
  className,
  type = 'text',
}: {
  value: string;
  onChange: (value: string) => void;
  onCommit?: (value: string) => void;
  disabled?: boolean;
  placeholder?: string;
  className?: string;
  type?: string;
}) {
  return (
    <input
      type={type}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      onBlur={(e) => onCommit?.(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.currentTarget.blur();
        }
      }}
      disabled={disabled}
      placeholder={placeholder}
      className={`w-full rounded-lg border border-zinc-200 bg-white px-3 py-2 text-sm text-zinc-900 placeholder-zinc-400 focus:border-zinc-400 focus:ring-4 focus:ring-zinc-900/5 outline-none transition-all disabled:bg-zinc-50 disabled:text-zinc-500 disabled:cursor-not-allowed ${className || ''}`}
    />
  );
}

function InlineTextarea({
  value,
  onChange,
  onCommit,
  disabled,
  placeholder,
  rows = 2,
  className,
}: {
  value: string;
  onChange: (value: string) => void;
  onCommit?: (value: string) => void;
  disabled?: boolean;
  placeholder?: string;
  rows?: number;
  className?: string;
}) {
  return (
    <textarea
      rows={rows}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      onBlur={(e) => onCommit?.(e.target.value)}
      disabled={disabled}
      placeholder={placeholder}
      className={`w-full resize-none rounded-lg border border-zinc-200 bg-white px-3 py-2 text-sm text-zinc-900 placeholder-zinc-400 focus:border-zinc-400 focus:ring-4 focus:ring-zinc-900/5 outline-none transition-all disabled:bg-zinc-50 disabled:text-zinc-500 disabled:cursor-not-allowed ${className || ''}`}
    />
  );
}

function InlineSelect({
  value,
  onChange,
  options,
  disabled,
  className,
}: {
  value: string;
  onChange: (value: string) => void;
  options: string[];
  disabled?: boolean;
  className?: string;
}) {
  return (
    <div className="relative">
      <select
        value={value || ''}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled}
        className={`w-full appearance-none rounded-lg border border-zinc-200 bg-white px-3 py-2 text-sm text-zinc-900 focus:border-zinc-400 focus:ring-4 focus:ring-zinc-900/5 outline-none transition-all disabled:bg-zinc-50 disabled:text-zinc-500 disabled:cursor-not-allowed ${className || ''}`}
      >
        <option value="">Не выбрано</option>
        {options.map((option) => (
          <option key={option} value={option}>
            {option}
          </option>
        ))}
      </select>
      <div className="pointer-events-none absolute inset-y-0 right-0 flex items-center px-2 text-zinc-500 text-xs">
        ▼
      </div>
    </div>
  );
}

type InfoItemProps = {
  label: string;
  value?: string | null;
  href?: string | null;
  className?: string;
  valueClassName?: string;
};

function InfoItem({ label, value, href, className, valueClassName }: InfoItemProps) {
  const displayValue = value?.trim();
  const containerClassName = `flex flex-col gap-1 min-w-0${className ? ` ${className}` : ''}`;
  const baseValueClassName = valueClassName
    ? `text-sm ${valueClassName}`
    : 'text-sm text-zinc-900';

  return (
    <div className={containerClassName}>
      <span className="text-[11px] uppercase tracking-wide text-zinc-400">{label}</span>
      {displayValue ? (
        href ? (
          <a
            href={href}
            target="_blank"
            rel="noreferrer"
            className={`${baseValueClassName} text-blue-600 hover:underline`}
          >
            {displayValue}
          </a>
        ) : (
          <span className={baseValueClassName}>{displayValue}</span>
        )
      ) : (
        <span className="text-sm text-zinc-400">—</span>
      )}
    </div>
  );
}

// Project Card Component
function ProjectCard({ 
  project, 
  onStatusChange,
  openMenuId,
  setOpenMenuId,
  onDeleteRequest,
  canDelete,
}: { 
  project: Project; 
  onStatusChange: (id: string, status: string) => void;
  openMenuId: string | null;
  setOpenMenuId: (id: string | null) => void;
  onDeleteRequest?: (id: string) => void;
  canDelete?: boolean;
}) {
  const isTma = useIsTma();
  const { locale } = useUser();
  const statusConfig = getStatusConfig(project.status);
  const deadlineStatus = getDeadlineStatus(project.deadline);
  const isMenuOpen = openMenuId === project.id;
  const platformConfig = getPlatformConfig(project.work_format);
  const kpiValue = getKpiValue(project);
  const commentValue = getCommentValue(project);
  const deadlineLabel = project.deadline ? formatDate(project.deadline) : '';
  const contractHref = normalizeUrl(project.contract_link);
  const handoffHref = normalizeUrl(project.handoff_link);
  const cardTitle = project.client || 'Без названия';
  const cardServices = parseServices(project.name);

  const deadlineClassName =
    deadlineStatus === 'overdue'
      ? 'inline-flex items-center rounded-full bg-red-100 px-2.5 py-1 text-xs font-semibold text-red-700'
      : deadlineStatus === 'soon'
        ? 'inline-flex items-center rounded-full bg-amber-100 px-2.5 py-1 text-xs font-semibold text-amber-700'
        : 'inline-flex items-center rounded-full bg-zinc-100 px-2.5 py-1 text-xs font-semibold text-zinc-700';

  return (
    <div
      className={`bg-white rounded-3xl border shadow-[0_2px_8px_rgba(0,0,0,0.02)] hover:shadow-[0_8px_24px_rgba(0,0,0,0.04)] transition-all ${
        deadlineStatus === 'overdue'
          ? 'border-red-100 border-l-[6px] border-l-red-400'
          : deadlineStatus === 'soon'
            ? 'border-amber-100 border-l-[6px] border-l-amber-400'
            : 'border-zinc-200/80 border-l-[6px] border-l-zinc-200'
      } ${isTma ? 'p-5' : 'p-6'}`}
    >
      <div className="flex items-start justify-between gap-3">
        <Link href={`/projects/${project.id}`} className="flex-1 min-w-0">
          <h3 className="text-base font-semibold text-zinc-900 hover:text-blue-600 transition-colors truncate">
            {cardTitle}
          </h3>
          {cardServices.length > 0 && (
            <div className="flex flex-wrap gap-1 mt-1">
              {cardServices.map((s) => (
                <span key={s} className="inline-flex items-center bg-blue-50 text-blue-700 text-[10px] font-medium px-1.5 py-0.5 rounded">{s}</span>
              ))}
            </div>
          )}
        </Link>
        <div className="flex items-center gap-2">
          <span className={`inline-flex px-2.5 py-1 rounded-lg text-xs font-medium ${statusConfig.bg} ${statusConfig.color}`}>
            {translateStatusLabel(statusConfig.label, locale)}
          </span>
          <div className="relative">
          <button 
            onClick={() => setOpenMenuId(isMenuOpen ? null : project.id)}
            className="p-1.5 rounded-lg hover:bg-zinc-100 text-zinc-400 font-medium"
          >
            •••
          </button>
          {isMenuOpen && (
            <>
              <div className="fixed inset-0 z-10" onClick={() => setOpenMenuId(null)} />
              <div className="absolute right-0 top-8 z-20 w-48 bg-white rounded-xl shadow-xl border border-zinc-200 py-1">
                <Link 
                  href={`/projects/${project.id}`}
                  className="flex items-center px-3 py-2 text-sm text-zinc-700 hover:bg-zinc-50"
                >
                  {locale === 'en' ? 'Open' : 'Открыть'}
                </Link>
                <Link 
                    href={`/projects/${project.id}?mode=edit`}
                  className="flex items-center px-3 py-2 text-sm text-zinc-700 hover:bg-zinc-50"
                >
                  {locale === 'en' ? 'Edit' : 'Редактировать'}
                </Link>
                <div className="border-t border-zinc-100 my-1" />
                <div className="px-3 py-1 text-xs text-zinc-400 uppercase">{locale === 'en' ? 'Status' : 'Статус'}</div>
                {Object.entries(STATUS_CONFIG).map(([key, config]) => (
                  <button
                    key={key}
                    onClick={() => onStatusChange(project.id, config.label)}
                    className="w-full flex items-center px-3 py-2 text-sm text-zinc-700 hover:bg-zinc-50"
                  >
                    <span className={`w-2 h-2 rounded-full mr-2 ${config.bg.replace('-50', '-500')}`} />
                    {translateStatusLabel(config.label, locale)}
                  </button>
                ))}
                {canDelete && onDeleteRequest && (
                  <>
                    <div className="border-t border-zinc-100 my-1" />
                    <button
                      onClick={() => onDeleteRequest(project.id)}
                      className="w-full flex items-center px-3 py-2 text-sm text-red-600 hover:bg-red-50"
                    >
                      <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4 mr-2" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" /></svg>
                      {locale === 'en' ? 'Delete' : 'Удалить'}
                    </button>
                  </>
                )}
              </div>
            </>
          )}
        </div>
      </div>
      </div>

      <div className={`mt-4 grid grid-cols-1 gap-4 ${isTma ? '' : 'md:grid-cols-2 xl:grid-cols-4'}`}>
        <InfoItem label={locale === 'en' ? 'Contract amount' : 'Сумма договора'} value={project.budget} />
        <InfoItem
          label={locale === 'en' ? 'Deadline' : 'Дедлайн'}
          value={deadlineLabel}
          valueClassName={deadlineClassName}
        />
        <InfoItem
          label={locale === 'en' ? 'Specialist' : 'Специалист'}
          value={project.specialist}
          valueClassName="inline-flex items-center rounded-full bg-sky-100 px-2.5 py-1 text-xs font-semibold text-sky-800"
        />
        <InfoItem
          label={locale === 'en' ? 'Lead' : 'Лид'}
          value={project.manager}
          valueClassName="inline-flex items-center rounded-full bg-lime-100 px-2.5 py-1 text-xs font-semibold text-lime-800"
        />
        {!isTma && (
          <>
            <InfoItem label={locale === 'en' ? 'Margin' : 'Маржа'} value={project.margin} />
            <InfoItem label="KPI" value={kpiValue} />
            <InfoItem
              label={locale === 'en' ? 'Contract link' : 'Ссылка на договор'}
              value={contractHref ? formatUrlLabel(contractHref) : ''}
              href={contractHref}
            />
            <InfoItem
              label={locale === 'en' ? 'Handoff link' : 'Ссылка на передачу'}
              value={handoffHref ? formatUrlLabel(handoffHref) : ''}
              href={handoffHref}
            />
            <InfoItem
              label={locale === 'en' ? 'Project platform' : 'Где ведется проект'}
              value={platformConfig?.label}
              valueClassName={
                platformConfig?.className
                  ? `inline-flex items-center rounded-full px-2.5 py-1 text-xs font-semibold ${platformConfig.className}`
                  : undefined
              }
            />
            <InfoItem
              label={locale === 'en' ? 'Comment' : 'Комментарий'}
              value={commentValue}
              className="md:col-span-2 xl:col-span-4"
              valueClassName="text-zinc-700 break-words"
            />
          </>
        )}
          </div>
    </div>
  );
}

// Kanban Card Component
function KanbanCard({ 
  project,
  onStatusChange,
  columns,
  onDeleteRequest,
  canDelete,
}: { 
  project: Project;
  onStatusChange: (id: string, status: string) => void;
  columns: Array<{ key: string; label: string }>;
  onDeleteRequest?: (id: string) => void;
  canDelete?: boolean;
}) {
  const { locale } = useUser();
  const [showMenu, setShowMenu] = useState(false);
  const deadlineStatus = getDeadlineStatus(project.deadline);

  return (
    <div className={`bg-white rounded-2xl border ${
      deadlineStatus === 'overdue' ? 'border-red-100' :
      deadlineStatus === 'soon' ? 'border-amber-100' :
      'border-zinc-200/80'
    } p-3.5 shadow-sm hover:shadow-[0_4px_12px_rgba(0,0,0,0.03)] transition-all cursor-pointer group`}>
      <div className="flex items-start justify-between">
        <Link href={`/projects/${project.id}`} className="flex-1 min-w-0">
          <h4 className="text-sm font-medium text-zinc-900 group-hover:text-blue-600 truncate">
            {project.client || (locale === 'en' ? 'Untitled' : 'Без названия')}
          </h4>
          {project.name && (
            <div className="flex flex-wrap gap-1 mt-0.5">
              {parseServices(project.name).map((s) => (
                <span key={s} className="inline-flex items-center bg-blue-50 text-blue-700 text-[9px] font-medium px-1 py-0.5 rounded">{s}</span>
              ))}
            </div>
          )}
        </Link>
        <div className="relative">
          <button 
            onClick={(e) => { e.stopPropagation(); setShowMenu(!showMenu); }}
            className="p-1 rounded hover:bg-zinc-100 opacity-0 group-hover:opacity-100 transition-opacity font-medium text-xs text-zinc-400"
          >
            •••
          </button>
          {showMenu && (
            <>
              <div className="fixed inset-0 z-10" onClick={() => setShowMenu(false)} />
              <div className="absolute right-0 top-6 z-20 w-36 bg-white rounded-lg shadow-lg border border-zinc-200 py-1">
                {columns.map((col) => (
                  <button
                    key={col.key}
                    onClick={() => { onStatusChange(project.id, col.label); setShowMenu(false); }}
                    className="w-full text-left px-3 py-1.5 text-xs text-zinc-700 hover:bg-zinc-50"
                  >
                    {col.label}
                  </button>
                ))}
                {canDelete && onDeleteRequest && (
                  <>
                    <div className="border-t border-zinc-100 my-1" />
                    <button
                      onClick={() => { onDeleteRequest(project.id); setShowMenu(false); }}
                      className="w-full text-left px-3 py-1.5 text-xs text-red-600 hover:bg-red-50"
                    >
                      {locale === 'en' ? 'Delete' : 'Удалить'}
                    </button>
                  </>
                )}
              </div>
            </>
          )}
        </div>
      </div>
      
      <div className="mt-2 flex items-center gap-2 text-xs text-zinc-500">
        {project.manager && (
          <span className="flex items-center">
            {project.manager.split(' ')[0]}
          </span>
        )}
        {project.deadline && (
          <span className={`flex items-center ${
            deadlineStatus === 'overdue' ? 'text-red-600' :
            deadlineStatus === 'soon' ? 'text-amber-600' : ''
          }`}>
            {formatDate(project.deadline)}
          </span>
        )}
      </div>
    </div>
  );
}
