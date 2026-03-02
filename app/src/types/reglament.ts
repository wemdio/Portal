import type { JSONContent } from '@tiptap/core';

export type ReglamentStatus = 'draft' | 'published';

export interface ReglamentDocument {
  id: string;
  slug: string;
  title: string;
  status: ReglamentStatus;
  content: JSONContent;
  summary?: string | null;
  cover_image_url?: string | null;
  order_index?: number | null;
  created_at?: string;
  updated_at?: string;
  published_at?: string | null;
  /** When set, document is in archive; after this time it is eligible for permanent deletion. */
  delete_at?: string | null;
}
