import { mergeAttributes, Node } from '@tiptap/core';

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    reglamentButton: {
      setReglamentButton: (attrs: { label?: string; href?: string; style?: string }) => ReturnType;
      updateReglamentButton: (attrs: { label?: string; href?: string; style?: string }) => ReturnType;
    };
  }
}

const BUTTON_STYLES = ['primary', 'secondary', 'outline'] as const;

export const ReglamentButton = Node.create({
  name: 'reglamentButton',
  group: 'block',
  atom: true,

  addAttributes() {
    return {
      label: {
        default: 'Кнопка',
        parseHTML: (el) => (el as HTMLElement).textContent?.trim() || (el as HTMLElement).getAttribute('data-label') || 'Кнопка',
        renderHTML: (attrs) => ({ 'data-label': attrs.label }),
      },
      href: {
        default: '#',
        parseHTML: (el) => (el as HTMLAnchorElement).getAttribute('href') || '#',
        renderHTML: (attrs) => ({ href: attrs.href }),
      },
      style: {
        default: 'primary',
        parseHTML: (el) => (el as HTMLElement).dataset.style || 'primary',
        renderHTML: (attrs) => ({ 'data-style': attrs.style }),
      },
    };
  },

  parseHTML() {
    return [{ tag: 'a[data-reglament-button]' }];
  },

  renderHTML({ node, HTMLAttributes }) {
    const { label, href, style } = node.attrs as { label: string; href: string; style: string };
    const styleClass =
      style === 'primary'
        ? 'inline-flex items-center gap-1.5 px-4 py-2 rounded-lg font-medium text-sm text-white bg-blue-600 hover:bg-blue-700 border border-transparent shadow-sm'
        : style === 'outline'
          ? 'inline-flex items-center gap-1.5 px-4 py-2 rounded-lg font-medium text-sm text-gray-700 bg-white border border-gray-300 hover:bg-gray-50'
          : 'inline-flex items-center gap-1.5 px-4 py-2 rounded-lg font-medium text-sm text-gray-700 bg-gray-100 border border-gray-200 hover:bg-gray-200';
    return [
      'a',
      mergeAttributes(HTMLAttributes, {
        'data-reglament-button': '',
        href: href || '#',
        class: styleClass,
        target: '_blank',
        rel: 'noopener noreferrer',
      }),
      label || 'Кнопка',
    ];
  },

  addCommands() {
    return {
      setReglamentButton:
        (attrs: { label?: string; href?: string; style?: string }) =>
        ({ commands }) =>
          commands.insertContent({
            type: this.name,
            attrs: {
              label: attrs?.label ?? 'Кнопка',
              href: attrs?.href ?? '#',
              style: BUTTON_STYLES.includes(attrs?.style as (typeof BUTTON_STYLES)[number]) ? attrs.style : 'primary',
            },
          }),
      updateReglamentButton:
        (attrs: { label?: string; href?: string; style?: string }) =>
        ({ commands }) =>
          commands.updateAttributes(this.name, attrs),
    };
  },
});
