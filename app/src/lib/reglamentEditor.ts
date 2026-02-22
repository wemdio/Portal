import StarterKit from '@tiptap/starter-kit';
import Underline from '@tiptap/extension-underline';
import { TextStyle } from '@tiptap/extension-text-style';
import Color from '@tiptap/extension-color';
import Highlight from '@tiptap/extension-highlight';
import Image from '@tiptap/extension-image';
import Link from '@tiptap/extension-link';
import FontFamily from '@tiptap/extension-font-family';
import Paragraph from '@tiptap/extension-paragraph';
import Heading from '@tiptap/extension-heading';
import BulletList from '@tiptap/extension-bullet-list';
import OrderedList from '@tiptap/extension-ordered-list';
import ListItem from '@tiptap/extension-list-item';
import Blockquote from '@tiptap/extension-blockquote';
import type { JSONContent } from '@tiptap/core';
import { Callout } from '@/components/ReglamentCallout';
import { SectionBlock } from '@/components/ReglamentSectionBlock';
import { DivBlock } from '@/components/ReglamentDivBlock';
import { SpanClass } from '@/components/ReglamentSpanClass';

export const DEFAULT_REGLAMENT_CONTENT: JSONContent = {
  type: 'doc',
  content: [{ type: 'paragraph', content: [] }],
};

const ParagraphWithClass = Paragraph.extend({
  addAttributes() {
    return {
      ...this.parent?.(),
      class: {
        default: null,
        parseHTML: (element) => (element as HTMLElement).getAttribute('class'),
      },
    };
  },
});

const HeadingWithClass = Heading.extend({
  addAttributes() {
    return {
      ...this.parent?.(),
      class: {
        default: null,
        parseHTML: (element) => (element as HTMLElement).getAttribute('class'),
      },
    };
  },
});

const BulletListWithClass = BulletList.extend({
  addAttributes() {
    return {
      ...this.parent?.(),
      class: {
        default: null,
        parseHTML: (element) => (element as HTMLElement).getAttribute('class'),
      },
    };
  },
});

const OrderedListWithClass = OrderedList.extend({
  addAttributes() {
    return {
      ...this.parent?.(),
      class: {
        default: null,
        parseHTML: (element) => (element as HTMLElement).getAttribute('class'),
      },
    };
  },
});

const ListItemWithClass = ListItem.extend({
  addAttributes() {
    return {
      ...this.parent?.(),
      class: {
        default: null,
        parseHTML: (element) => (element as HTMLElement).getAttribute('class'),
      },
    };
  },
});

const BlockquoteWithClass = Blockquote.extend({
  addAttributes() {
    return {
      ...this.parent?.(),
      class: {
        default: null,
        parseHTML: (element) => (element as HTMLElement).getAttribute('class'),
      },
    };
  },
});

const ImageWithClass = Image.extend({
  addAttributes() {
    return {
      ...this.parent?.(),
      class: {
        default: null,
        parseHTML: (element) => (element as HTMLElement).getAttribute('class'),
      },
    };
  },
});

const LinkWithClass = Link.extend({
  addAttributes() {
    return {
      ...this.parent?.(),
      class: {
        default: null,
        parseHTML: (element) => (element as HTMLElement).getAttribute('class'),
      },
    };
  },
});

export const REGLAMENT_EXTENSIONS = [
  StarterKit.configure({
    heading: false,
    paragraph: false,
    bulletList: false,
    orderedList: false,
    listItem: false,
    blockquote: false,
  }),
  ParagraphWithClass,
  HeadingWithClass.configure({ levels: [2, 3, 4] }),
  BulletListWithClass,
  OrderedListWithClass,
  ListItemWithClass,
  BlockquoteWithClass,
  Underline,
  TextStyle,
  SpanClass,
  Color,
  Highlight.configure({ multicolor: true }),
  FontFamily.configure({ types: ['textStyle'] }),
  LinkWithClass.configure({
    openOnClick: false,
    linkOnPaste: true,
    autolink: true,
  }),
   ImageWithClass.configure({
     inline: false,
     allowBase64: false,
     resize: {
       enabled: true,
     },
   }),
  Callout,
  SectionBlock,
  DivBlock,
];

export const REGLAMENT_FONT_OPTIONS = [
  { label: 'По умолчанию', value: '' },
  { label: 'Georgia', value: 'Georgia, serif' },
  { label: 'Times New Roman', value: '"Times New Roman", Times, serif' },
  { label: 'Arial', value: 'Arial, sans-serif' },
  { label: 'Courier New', value: '"Courier New", Courier, monospace' },
];

export const REGLAMENT_TEXT_COLORS = [
  { label: 'Черный', value: '#111827' },
  { label: 'Серый', value: '#4B5563' },
  { label: 'Синий', value: '#1D4ED8' },
  { label: 'Фиолетовый', value: '#6D28D9' },
  { label: 'Красный', value: '#B91C1C' },
  { label: 'Зеленый', value: '#15803D' },
];

export const REGLAMENT_HIGHLIGHT_COLORS = [
  { label: 'Желтый', value: '#FEF3C7' },
  { label: 'Зеленый', value: '#DCFCE7' },
  { label: 'Синий', value: '#DBEAFE' },
  { label: 'Розовый', value: '#FCE7F3' },
  { label: 'Оранжевый', value: '#FFEDD5' },
];

export const REGLAMENT_CALLOUT_VARIANTS = [
  { label: 'Инфо', value: 'info' },
  { label: 'Внимание', value: 'warning' },
  { label: 'Важно', value: 'danger' },
  { label: 'Успех', value: 'success' },
  { label: 'Заметка', value: 'note' },
  { label: 'Произвольный', value: 'custom' },
];

export const REGLAMENT_STORAGE_BUCKET =
  process.env.NEXT_PUBLIC_REGLAMENT_STORAGE_BUCKET ?? 'reglament-assets';
export const REGLAMENT_STORAGE_PREFIX = 'reglament';

export function createReglamentSlug(value: string): string {
  const cleaned = value.trim().toLowerCase();
  if (!cleaned) return '';
  return cleaned
    .replace(/[\s_]+/g, '-')
    .replace(/[^a-z0-9а-яё-]/gi, '')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}
