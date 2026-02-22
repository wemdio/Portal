import { Mark, mergeAttributes } from '@tiptap/core';

export const SpanClass = Mark.create({
  name: 'spanClass',
  addAttributes() {
    return {
      class: {
        default: null,
        parseHTML: (element) => (element as HTMLElement).getAttribute('class'),
      },
    };
  },
  parseHTML() {
    return [{ tag: 'span[class]' }];
  },
  renderHTML({ HTMLAttributes }) {
    return ['span', mergeAttributes(HTMLAttributes), 0];
  },
});
