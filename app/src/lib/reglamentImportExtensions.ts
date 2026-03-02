/**
 * Minimal TipTap extensions for parsing HTML during import.
 * Used server-side to avoid loading React components.
 */
import StarterKit from '@tiptap/starter-kit';
import Underline from '@tiptap/extension-underline';
import { TextStyle } from '@tiptap/extension-text-style';
import Color from '@tiptap/extension-color';
import Highlight from '@tiptap/extension-highlight';
import Image from '@tiptap/extension-image';
import Link from '@tiptap/extension-link';
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

const ParagraphWithClass = Paragraph.extend({
  addAttributes() {
    return {
      ...this.parent?.(),
      class: {
        default: null,
        parseHTML: (element: HTMLElement) => element.getAttribute('class'),
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
        parseHTML: (element: HTMLElement) => element.getAttribute('class'),
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
        parseHTML: (element: HTMLElement) => element.getAttribute('class'),
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
        parseHTML: (element: HTMLElement) => element.getAttribute('class'),
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
        parseHTML: (element: HTMLElement) => element.getAttribute('class'),
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
        parseHTML: (element: HTMLElement) => element.getAttribute('class'),
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
        parseHTML: (element: HTMLElement) => element.getAttribute('class'),
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
        parseHTML: (element: HTMLElement) => element.getAttribute('class'),
      },
    };
  },
});

export const REGLAMENT_IMPORT_EXTENSIONS = [
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
  Color,
  Highlight.configure({ multicolor: true }),
  LinkWithClass.configure({
    openOnClick: false,
    linkOnPaste: true,
    autolink: true,
  }),
  ImageWithClass.configure({
    inline: false,
    allowBase64: false,
  }),
  Table.configure({ resizable: true }),
  TableRow,
  TableCell,
  TableHeader,
];
