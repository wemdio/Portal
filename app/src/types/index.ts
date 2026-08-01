export type ProjectStatus =
  | 'В работе'
  | 'Тестирование'
  | 'На паузе'
  | 'Подготовка'
  | 'Завершен'
  | 'Отменен';

export * from './parsers';
export * from './email-sequence';
export * from './email-sequence-v2';
export * from './sales-chat-analyzer';
export * from './reglament';
export * from './lpr';

import type { Locale } from '@/lib/i18n';

export type UserRole = 'technician' | 'manager' | 'director' | 'admin' | 'sales' | 'marketer' | 'lead' | 'client';

export interface UserProfile {
  id: string;
  email?: string;
  role: UserRole | null;
  locale?: Locale;
  full_name?: string;
  avatar_url?: string;
  created_at?: string;
}

export interface Project {
  id: string;
  client?: string;
  name: string;
  description?: string;
  created_at?: string;
  updated_at?: string;
  region?: string;
  lead_source?: string;
  payment_method?: string;
  work_format?: string;
  budget?: string; // string because it might contain currency symbols or be empty
  margin?: string;
  contract_date?: string;
  contract_link?: string;
  handoff_link?: string;
  launch_date?: string;
  deadline?: string;
  kpi_plan?: string;
  kpi_fact?: string;
  status: ProjectStatus;
  specialist?: string;
  specialist_user_id?: string | null;
  manager?: string;
  weekly_tasks?: string;
  comment_elvira?: string;
  comment_anya?: string;
  comments?: string;
  client_feedback?: string;
  hypotheses?: string;
  hypotheses_result?: string;
  subtasks?: string;
  materials_links?: string;
  project_type?: 'Продажа' | 'Продление' | null;

  payment_date?: string;
  contacts_obligation?: string;
  contacts_done?: string;
  contacts_done_synced_at?: string | null;

  client_user_id?: string | null;

  brief_file_path?: string | null;
  brief_file_name?: string | null;
  brief_text?: string | null;
  brief_uploaded_at?: string | null;
  lead_source_hypotheses?: string | null;
  lead_source_hypotheses_generated_at?: string | null;
  lead_source_hypotheses_error?: string | null;
  lead_source_hypotheses_stale?: boolean | null;

  /** Lead handoff to client (auto-передача). Empty handoff_email = disabled. */
  handoff_email?: string | null;
  handoff_legend?: string | null;
  /** ON: ИИ адаптирует легенду под ответ лида; OFF/NULL: легенда дословно. */
  handoff_ai_adapt?: boolean | null;
  /** ON: передача уходит сразу без кнопки-подтверждения спеца в TG; OFF/NULL: кнопка. */
  handoff_auto_send?: boolean | null;

  /** Кастомное определение лида для ИИ-квалификатора (все кампании проекта). Пусто = дефолтные критерии. */
  lead_criteria?: string | null;
}

export type TaskStatus = 'pending' | 'in_progress' | 'done';

export interface Task {
  id: string;
  project_id: string | null;
  title: string;
  result?: string;
  description?: string | null;
  image_url?: string | null;
  status: TaskStatus;
  specialist?: string;
  deadline?: string | null;
  created_by?: string;
  created_at?: string;
  updated_at?: string;
  project?: Project;
  board_id?: string | null;
  column_id?: string | null;
}

export interface ProjectNote {
  id: string;
  project_id: string;
  title: string;
  created_at?: string;
}

export interface TaskBoard {
  id: string;
  name: string;
  is_default: boolean;
  position: number;
  created_at?: string;
}

export interface TaskBoardColumn {
  id: string;
  board_id: string;
  title: string;
  position: number;
  status: string | null;
  created_at?: string;
}
