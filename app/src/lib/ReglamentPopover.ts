import { mergeAttributes, Node } from '@tiptap/core';

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

  renderHTML({ HTMLAttributes }) {
    return [
      'span',
      mergeAttributes(HTMLAttributes, {
        'data-reglament-popover': '',
        class: 'reglament-popover-trigger cursor-help border-b border-dashed border-amber-500 text-amber-700 px-0.5 rounded',
      }),
      0,
    ];
  },
});
