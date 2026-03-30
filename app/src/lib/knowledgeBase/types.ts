export type KbCategory = 'sales_chats' | 'video_transcripts' | 'product_info' | 'client_chats' | 'other' | 'cases' | 'banks';
export type KbSourceType = 'upload' | 'manual' | 'imported';
export type KbDocStatus = 'processing' | 'ready' | 'error';

export interface KbDocument {
  id: string;
  user_id: string;
  title: string;
  category: KbCategory;
  source_type: KbSourceType;
  description: string;
  file_path: string | null;
  original_filename: string | null;
  content_text: string;
  token_count: number;
  metadata: Record<string, unknown>;
  status: KbDocStatus;
  created_at: string;
  updated_at: string;
}

export interface KbChunk {
  id: string;
  document_id: string;
  chunk_index: number;
  content: string;
  token_count: number;
  metadata: Record<string, unknown>;
  created_at: string;
}

export const KB_CATEGORIES: { value: KbCategory; label: string }[] = [
  { value: 'sales_chats', label: 'Переписки Сейлз менеджеров' },
  { value: 'video_transcripts', label: 'Расшифровки видео встреч' },
  { value: 'product_info', label: 'О продукте' },
  { value: 'cases', label: 'Кейсы' },
  { value: 'client_chats', label: 'Рабочие чаты с клиентами' },
  { value: 'banks', label: 'Банковские выписки' },
  { value: 'other', label: 'Другое' },
];

export const COPILOT_KB_CATEGORIES: KbCategory[] = [
  'sales_chats',
  'video_transcripts',
  'product_info',
  'cases',
];
