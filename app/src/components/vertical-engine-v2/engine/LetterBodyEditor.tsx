'use client';

import { useEffect, useRef, useState } from 'react';
import { EditorContent, useEditor } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import { Slice } from '@tiptap/pm/model';
import { Link2 } from 'lucide-react';
import { veEmailBodyDocument, veEmailBodyText, veEmailLinkUrl } from '@/lib/verticalEngineV2/emailBody';
import { HE } from './design';

interface Props { value: string; onChange: (value: string) => void; disabled: boolean; label: string; campaign: string; content: string }

/** Rich display, plain text + safe links in storage and in the existing sending adapter. */
export function LetterBodyEditor({ value, onChange, disabled, label, campaign, content }: Props) {
  const changed = useRef(onChange);
  useEffect(() => { changed.current = onChange; }, [onChange]);
  const [link, setLink] = useState<{ from: number; to: number; text: string; url: string; existing: boolean } | null>(null);
  const [utmOn, setUtmOn] = useState(false);
  const [utm, setUtm] = useState<Record<string, string>>({});
  const [error, setError] = useState('');
  const editor = useEditor({
    immediatelyRender: false,
    extensions: [StarterKit.configure({
      bold: false, italic: false, underline: false, strike: false, code: false, codeBlock: false,
      heading: false, blockquote: false, bulletList: false, orderedList: false, listItem: false,
      listKeymap: false, horizontalRule: false, trailingNode: false,
      link: { openOnClick: false, autolink: false, linkOnPaste: false, protocols: ['http', 'https'],
        isAllowedUri: url => { try { veEmailLinkUrl(url); return /^https?:\/\//.test(url); } catch { return false; } },
        HTMLAttributes: { class: 'underline underline-offset-2', rel: 'noopener noreferrer', target: '_blank' } },
    })],
    content: veEmailBodyDocument(value),
    editable: !disabled,
    editorProps: {
      attributes: { role: 'textbox', 'aria-label': label, 'aria-multiline': 'true', class: `${HE.input} ve2-letter-body` },
      // Do not import invisible formatting or trackers from pasted rich email HTML.
      handlePaste: (view, event) => {
        const plain = event.clipboardData?.getData('text/plain');
        if (plain === undefined) return false;
        event.preventDefault();
        const nodes = veEmailBodyDocument(plain).content!;
        const fragment = view.state.schema.nodeFromJSON({ type: 'doc', content: nodes }).content;
        view.dispatch(view.state.tr.replaceSelection(new Slice(fragment, 1, 1)));
        return true;
      },
    },
    onUpdate: ({ editor: current }) => changed.current(veEmailBodyText(current.getJSON())),
  });
  useEffect(() => {
    if (editor && veEmailBodyText(editor.getJSON()) !== value) editor.commands.setContent(veEmailBodyDocument(value), { emitUpdate: false });
  }, [editor, value]);
  // Keep the saved selection stable while the inline link form is open.
  useEffect(() => { editor?.setEditable(!disabled && !link, false); }, [editor, disabled, link]);
  const close = () => { setLink(null); setError(''); editor?.commands.focus(); };
  const open = () => {
    if (!editor || disabled) return;
    editor.commands.extendMarkRange('link');
    const { from, to } = editor.state.selection;
    const url = String(editor.getAttributes('link').href ?? '');
    setLink({ from, to, text: editor.state.doc.textBetween(from, to, ' '), url, existing: !!url });
    const params = url ? new URL(url).searchParams : null;
    const defaults: Record<string, string> = { utm_source: 'outreach', utm_medium: 'email', utm_campaign: campaign, utm_content: content };
    if (params?.has('utm_term')) defaults.utm_term = params.get('utm_term')!;
    setUtm(Object.fromEntries(Object.entries(defaults).map(([key, val]) => [key, params?.get(key) ?? val])));
    setUtmOn(!!params && [...params.keys()].some(key => key.startsWith('utm_')));
    setError('');
  };
  const changeUrl = (url: string) => {
    if (!link) return;
    setLink({ ...link, url });
    try {
      const params = new URL(veEmailLinkUrl(url)).searchParams;
      const existing = Object.fromEntries([...params.entries()].filter(([key]) => /^utm_(source|medium|campaign|content|term)$/.test(key)));
      setUtm(current => ({ ...current, ...existing }));
    } catch { /* The user may still be typing the URL. Validation happens on insert. */ }
  };
  const insert = () => {
    if (!editor || !link || disabled) return;
    try {
      const href = veEmailLinkUrl(link.url, utmOn ? utm : link.existing ? { utm_source: '', utm_medium: '', utm_campaign: '', utm_content: '', utm_term: '' } : undefined);
      const text = link.text.trim() || href;
      if (/[\]\r\n]/.test(text)) throw new Error('В тексте ссылки не должно быть переноса строки или символа ].');
      const suffix = link.from === link.to && /\S/.test(editor.state.doc.textBetween(link.to, Math.min(editor.state.doc.content.size, link.to + 1))) ? [{ type: 'text', text: ' ' }] : [];
      const prefix = link.from === link.to && /\S/.test(editor.state.doc.textBetween(Math.max(0, link.from - 1), link.from)) ? [{ type: 'text', text: ' ' }] : [];
      editor.chain().focus().insertContentAt({ from: link.from, to: link.to }, [...prefix, { type: 'text', text, marks: [{ type: 'link', attrs: { href } }] }, ...suffix])
        .command(({ tr, state }) => { tr.removeStoredMark(state.schema.marks.link); return true; }).run();
      close();
    } catch (issue) { setError(issue instanceof Error && issue.message !== 'Invalid URL' ? issue.message : 'Проверьте адрес сайта.'); }
  };
  return <div className="space-y-2">
    <EditorContent editor={editor} />
    {!disabled && !link ? <button type="button" className={`${HE.btnQuiet} ve2-letter-link-button`} onClick={open}><Link2 size={16} aria-hidden /> Вставить ссылку</button> : null}
    {link && !disabled ? <div role="group" aria-label="Ссылка" className="space-y-3 border border-[var(--ve2-line)] rounded-md p-3"
      onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); close(); } else if (event.key === 'Enter' && event.target instanceof HTMLInputElement && event.target.type !== 'checkbox') { event.preventDefault(); insert(); } }}>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="ve2-label">Текст ссылки<input className={`${HE.input} mt-1 w-full`} value={link.text} onChange={event => setLink({ ...link, text: event.target.value })} /></label>
        <label className="ve2-label">Адрес<input autoFocus className={`${HE.input} mt-1 w-full`} placeholder="https://example.com" value={link.url} onChange={event => changeUrl(event.target.value)} /></label>
      </div>
      <label className="flex items-center gap-2"><input type="checkbox" className="ve2-cbx" checked={utmOn} onChange={event => setUtmOn(event.target.checked)} />Добавить UTM</label>
      {utmOn ? <div className="grid gap-3 sm:grid-cols-2">{Object.entries(utm).map(([key, val]) => <label key={key} className="ve2-label">{key}<input className={`${HE.input} mt-1 w-full`} value={val} onChange={event => setUtm({ ...utm, [key]: event.target.value })} /></label>)}</div> : null}
      {error ? <p role="alert" className="ve2-t-dan">{error}</p> : null}
      <div className="flex flex-wrap gap-2">
        <button type="button" className={HE.btnPrimary} onClick={insert}>{link.existing ? 'Применить' : 'Вставить'}</button>
        {link.existing ? <button type="button" className={HE.btnGhost} onClick={() => { editor?.chain().focus().setTextSelection({ from: link.from, to: link.to }).unsetLink().run(); close(); }}>Убрать ссылку</button> : null}
        <button type="button" className={HE.btnQuiet} onClick={close}>Отмена</button>
      </div>
    </div> : null}
  </div>;
}
