export type ProjectStatus =
  | 'В работе'
  | 'Тестирование'
  | 'На паузе'
  | 'Подготовка'
  | 'Завершен'
  | 'Отменен';

export * from './parsers';
export * from './email-sequence';

export type UserRole = 'technician' | 'manager' | 'director' | 'admin' | 'sales' | 'marketer' | 'lead';

export interface UserProfile {
  id: string;
  email?: string;
  role: UserRole | null;
  full_name?: string;
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
}

export type TaskStatus = 'pending' | 'in_progress' | 'done';

export interface Task {
  id: string;
  project_id: string;
  title: string;
  result?: string;
  status: TaskStatus;
  created_by?: string;
  created_at?: string;
  updated_at?: string;
  project?: Project;
}
