import { mergeAttributes, Node } from '@tiptap/core';

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    reglamentPopover: {
      setReglamentPopover: (attrs: { popoverContent?: string }) => ReturnType;
      updateReglamentPopover: (attrs: { popoverContent?: string }) => ReturnType;
    };
  }
}

export const ReglamentPopover = Node.create({
  name: 'reglamentPopover',
  group: 'inline',
  inline: true,
  content: 'text*',

  addAttributes() {
    return {
      popoverContent: {
        default: '',
        parseHTML: (el) => (el as HTMLElement).dataset.popoverContent ?? '',
        renderHTML: (attrs) => ({ 'data-popover-content': attrs.popoverContent }),
      },
    };
  },

  parseHTML() {
    return [{ tag: 'span[data-reglament-popover]' }];
  },

  renderHTML({ node, HTMLAttributes }) {
    return [
      'span',
      mergeAttributes(HTMLAttributes, {
        'data-reglament-popover': '',
        class: 'reglament-popover-trigger cursor-help border-b border-dashed border-amber-500 text-amber-700 px-0.5 rounded',
      }),
      0,
    ];
  },

  addCommands() {
    return {
      setReglamentPopover:
        (attrs: { popoverContent?: string }) =>
        ({ commands }) =>
          commands.insertContent({
            type: this.name,
            attrs: { popoverContent: attrs?.popoverContent ?? '' },
            content: [{ type: 'text', text: 'Подсказка' }],
          }),
      updateReglamentPopover:
        (attrs: { popoverContent?: string }) =>
        ({ commands }) =>
          commands.updateAttributes(this.name, attrs),
    };
  },
});
