import { mergeAttributes, Node } from '@tiptap/core';

export const DivBlock = Node.create({
  name: 'divBlock',
  group: 'block',
  content: 'block+',
  defining: false,
  addAttributes() {
    return {
      class: {
        default: null,
        parseHTML: (element) => (element as HTMLElement).getAttribute('class'),
      },
      id: {
        default: null,
        parseHTML: (element) => (element as HTMLElement).getAttribute('id'),
      },
    };
  },
  parseHTML() {
    return [{ tag: 'div' }];
  },
  renderHTML({ HTMLAttributes }) {
    return ['div', mergeAttributes(HTMLAttributes), 0];
  },
});
