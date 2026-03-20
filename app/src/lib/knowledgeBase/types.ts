export type KbCategory = 'chat_export' | 'transcript' | 'product_info' | 'sales_script' | 'faq' | 'other';
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
  { value: 'chat_export', label: 'Переписки' },
  { value: 'transcript', label: 'Расшифровки' },
  { value: 'product_info', label: 'О продукте' },
  { value: 'sales_script', label: 'Скрипты продаж' },
  { value: 'faq', label: 'FAQ' },
  { value: 'other', label: 'Другое' },
];
