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
import { Table } from '@tiptap/extension-table/table';
import { TableRow } from '@tiptap/extension-table/row';
import { TableCell } from '@tiptap/extension-table/cell';
import { TableHeader } from '@tiptap/extension-table/header';
import type { JSONContent } from '@tiptap/core';
import { Callout } from '@/components/ReglamentCallout';
import { SectionBlock } from '@/components/ReglamentSectionBlock';
import { DivBlock } from '@/components/ReglamentDivBlock';
import { SpanClass } from '@/components/ReglamentSpanClass';
import { ReglamentButton } from '@/lib/ReglamentButton';
import { ReglamentPopover } from '@/lib/ReglamentPopover';

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
  HeadingWithClass.configure({ levels: [1, 2, 3, 4] }),
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
  Table.configure({ resizable: true }),
  TableRow,
  TableCell,
  TableHeader,
  Callout,
  SectionBlock,
  DivBlock,
  ReglamentButton,
  ReglamentPopover,
];

export const REGLAMENT_FONT_OPTIONS = [
  { label: 'По умолчанию', value: '' },
  { label: 'Georgia', value: 'Georgia, serif' },
  { label: 'Times New Roman', value: '"Times New Roman", Times, serif' },
  { label: 'Arial', value: 'Arial, sans-serif' },
  { label: 'Courier New', value: '"Courier New", Courier, monospace' },
];

export const REGLAMENT_TEXT_COLORS = [
  // Neutrals
  { label: 'Черный', value: '#000000' },
  { label: 'Темно-серый', value: '#1f2937' },
  { label: 'Серый', value: '#6b7280' },
  { label: 'Серебристый', value: '#9ca3af' },
  { label: 'Белый', value: '#ffffff' },
  // Blues
  { label: 'Темно-синий', value: '#1e3a8a' },
  { label: 'Синий', value: '#1d4ed8' },
  { label: 'Голубой', value: '#0284c7' },
  { label: 'Циан', value: '#0891b2' },
  { label: 'Бирюзовый', value: '#0d9488' },
  // Purples & Pinks
  { label: 'Фиолетовый темный', value: '#4c1d95' },
  { label: 'Фиолетовый', value: '#7c3aed' },
  { label: 'Сиреневый', value: '#a855f7' },
  { label: 'Фуксия', value: '#c026d3' },
  { label: 'Розовый', value: '#db2777' },
  // Reds & Oranges
  { label: 'Темно-красный', value: '#991b1b' },
  { label: 'Красный', value: '#dc2626' },
  { label: 'Оранжевый', value: '#ea580c' },
  { label: 'Янтарный', value: '#d97706' },
  { label: 'Желтый', value: '#ca8a04' },
  // Greens
  { label: 'Темно-зеленый', value: '#14532d' },
  { label: 'Зеленый', value: '#16a34a' },
  { label: 'Изумрудный', value: '#059669' },
  { label: 'Лайм', value: '#65a30d' },
  { label: 'Коричневый', value: '#92400e' },
];

export const REGLAMENT_HIGHLIGHT_COLORS = [
  // Yellows & Oranges
  { label: 'Желтый', value: '#fef08a' },
  { label: 'Светло-оранжевый', value: '#fed7aa' },
  { label: 'Персиковый', value: '#fde68a' },
  // Pinks & Reds
  { label: 'Розовый', value: '#fbcfe8' },
  { label: 'Красный пастель', value: '#fecaca' },
  // Purples
  { label: 'Лавандовый', value: '#e9d5ff' },
  { label: 'Индиго', value: '#c7d2fe' },
  // Blues & Cyans
  { label: 'Синий', value: '#bfdbfe' },
  { label: 'Голубой', value: '#bae6fd' },
  { label: 'Циан', value: '#a5f3fc' },
  // Greens
  { label: 'Мятный', value: '#a7f3d0' },
  { label: 'Зеленый', value: '#bbf7d0' },
  { label: 'Лайм', value: '#d9f99d' },
  // Neutrals
  { label: 'Серый', value: '#e5e7eb' },
  { label: 'Слоновая кость', value: '#fef9c3' },
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
  const CYR_MAP: Record<string, string> = {
    а:'a',б:'b',в:'v',г:'g',д:'d',е:'e',ё:'yo',ж:'zh',з:'z',и:'i',й:'j',
    к:'k',л:'l',м:'m',н:'n',о:'o',п:'p',р:'r',с:'s',т:'t',у:'u',ф:'f',
    х:'kh',ц:'ts',ч:'ch',ш:'sh',щ:'shch',ъ:'',ы:'y',ь:'',э:'e',ю:'yu',я:'ya',
  };
  const cleaned = value.trim().toLowerCase();
  if (!cleaned) return '';
  return cleaned
    .split('')
    .map((ch) => CYR_MAP[ch] ?? ch)
    .join('')
    .replace(/[\s_]+/g, '-')
    .replace(/[^a-z0-9-]/g, '')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}
