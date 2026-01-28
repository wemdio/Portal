export type ProjectStatus = 'На паузе' | 'Тест' | 'В работе' | 'Подготовка' | 'Completed';

export type UserRole = 'technician' | 'manager' | 'director' | 'admin' | 'sales' | 'marketer';

export interface UserProfile {
  id: string;
  email?: string;
  role: UserRole | null;
  full_name?: string;
  created_at?: string;
}

export interface Project {
  id: number;
  name: string;
  description?: string;
  region?: string;
  lead_source?: string;
  payment_method?: string;
  work_format?: string;
  budget?: string; // string because it might contain currency symbols or be empty
  contract_date?: string;
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
}

// Mock data based on CSV
export const MOCK_PROJECTS: Project[] = [
  {
    id: 4,
    name: 'Software Cats',
    description: 'QA',
    region: 'Ру',
    lead_source: 'Партнер Колди',
    payment_method: 'Оплата 100%',
    work_format: 'Тест (без кпи)',
    budget: '79000',
    contract_date: '21.7.25',
    launch_date: '16.10.25',
    deadline: '15.11.25',
    kpi_plan: 'без КПИ',
    kpi_fact: '7',
    status: 'На паузе',
    specialist: 'Анастасия Фрил',
    manager: 'Эльвира',
    weekly_tasks: 'пауза 15'
  },
  {
    id: 6,
    name: 'int-ing (b2b leads)',
    description: 'аудиовизуальное оборудование',
    region: 'Ру',
    lead_source: 'Трафик наш',
    payment_method: 'Оплата 100%',
    work_format: 'Тест (без кпи)',
    budget: '79000',
    contract_date: '18.8.25',
    launch_date: '27.10.25',
    deadline: '26/10',
    kpi_plan: 'без кпи',
    kpi_fact: '12',
    status: 'На паузе',
    specialist: 'Анна фрил',
    manager: 'Эльвира',
    weekly_tasks: 'отчет + передать проект спецу + сделать анализ + пройти 2000 контактов',
    comment_elvira: 'пинганула'
  },
  {
    id: 8,
    name: 'robosculptor.co',
    description: 'производитель аппаратов для неинвазивной коррекции фигуры',
    region: 'Eng',
    lead_source: 'Рекомендации',
    payment_method: 'Оплата 100%',
    work_format: 'Первый запуск (2 мес работы, без кпи)',
    budget: '201236',
    contract_date: '29.8.25',
    launch_date: '6.10.25',
    deadline: '5.12.25',
    kpi_plan: '6',
    kpi_fact: '12',
    status: 'Тест',
    specialist: 'Анастасия Фрил',
    manager: 'Максим',
    comment_elvira: '17.12.2025 - 18 декабря 5 почт',
    comment_anya: 'Пятница 11:00'
  },
  {
    id: 13,
    name: 'IFT',
    description: 'оборудование для майнинга биткоина',
    region: 'Ру',
    lead_source: 'Тильда',
    payment_method: 'Оплата 100%',
    work_format: 'Платный период (кпи)',
    budget: '149000',
    contract_date: '26.8.25',
    launch_date: '22.10.25',
    deadline: '22.12.25',
    kpi_plan: 'кпи с 3 нояб',
    kpi_fact: '3',
    status: 'Тест',
    specialist: 'Эльвира',
    manager: 'Эльвира',
    weekly_tasks: 'сделать 2 запуска и проверить почту',
    comment_elvira: '19 December'
  },
  {
    id: 32,
    name: 'SalesAI',
    description: 'платформа речевой аналитики для SMB',
    region: 'Ру',
    lead_source: 'Партнер Колди',
    payment_method: 'Оплата 100%',
    work_format: 'Первый запуск (2 мес работы, без кпи)',
    budget: '149000',
    contract_date: '17/11',
    launch_date: '10.12.25',
    deadline: '1.3.25',
    kpi_plan: '',
    kpi_fact: '',
    status: 'Тест',
    specialist: 'Анна фрил',
    manager: 'Максим',
    comment_elvira: '20 December',
    weekly_tasks: 'На этой неделе уходим на паузу...'
  }
];
