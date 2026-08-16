/**
 * Small contenteditable rich-text editor: bold, italic, headings, lists, links.
 *
 * Deliberately not TipTap/ProseMirror. Those weigh ~110 kB gzipped, which is
 * more than this frontend's entire dependency footprint today (react,
 * react-dom, react-router-dom and nothing else), and the copy across every page
 * of this site is paragraphs, headings, lists, one italic word, and links.
 *
 * Safety does not depend on this component: whatever HTML it produces is
 * allowlist-sanitized server-side on save (backend/src/lib/sanitize.ts), so
 * pasted markup cannot smuggle a script tag into the database.
 */
import { useEffect, useRef } from 'react';

interface ToolbarButton {
  label: string;
  title: string;
  command: string;
  value?: string;
}

const BUTTONS: ToolbarButton[] = [
  { label: 'B', title: 'Bold', command: 'bold' },
  { label: 'I', title: 'Italic', command: 'italic' },
  { label: 'H2', title: 'Heading', command: 'formatBlock', value: 'h2' },
  { label: 'H3', title: 'Subheading', command: 'formatBlock', value: 'h3' },
  { label: '¶', title: 'Paragraph', command: 'formatBlock', value: 'p' },
  { label: '• List', title: 'Bulleted list', command: 'insertUnorderedList' },
  { label: '1. List', title: 'Numbered list', command: 'insertOrderedList' },
];

export default function RichTextEditor({
  value,
  onChange,
}: {
  value: string;
  onChange: (html: string) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);

  // Only write into the DOM when the incoming value differs from what is
  // already there: assigning innerHTML on every render would move the caret to
  // the start of the field on each keystroke.
  useEffect(() => {
    if (ref.current && ref.current.innerHTML !== value) ref.current.innerHTML = value;
  }, [value]);

  function exec(button: ToolbarButton) {
    ref.current?.focus();
    document.execCommand(button.command, false, button.value);
    if (ref.current) onChange(ref.current.innerHTML);
  }

  function addLink() {
    const href = window.prompt('Link URL (a site path like /courses, or https://…)');
    if (!href) return;
    ref.current?.focus();
    document.execCommand('createLink', false, href);
    if (ref.current) onChange(ref.current.innerHTML);
  }

  return (
    <div style={{ border: '1px solid var(--line)', borderRadius: 8, overflow: 'hidden' }}>
      <div
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          gap: '0.25rem',
          padding: '0.35rem',
          borderBottom: '1px solid var(--line)',
          background: 'var(--cream)',
        }}
      >
        {BUTTONS.map((button) => (
          <button
            key={button.label}
            type="button"
            className="btn btn-ghost small"
            title={button.title}
            // onMouseDown, not onClick: clicking a button blurs the editor and
            // collapses the selection before the command would run.
            onMouseDown={(e) => {
              e.preventDefault();
              exec(button);
            }}
          >
            {button.label}
          </button>
        ))}
        <button
          type="button"
          className="btn btn-ghost small"
          title="Link"
          onMouseDown={(e) => {
            e.preventDefault();
            addLink();
          }}
        >
          🔗
        </button>
      </div>

      <div
        ref={ref}
        contentEditable
        suppressContentEditableWarning
        onInput={(e) => onChange(e.currentTarget.innerHTML)}
        // Paste as plain text so copying from Word or the live site doesn't drag
        // in a wall of foreign markup the sanitizer would strip anyway.
        onPaste={(e) => {
          e.preventDefault();
          document.execCommand('insertText', false, e.clipboardData.getData('text/plain'));
        }}
        style={{ minHeight: 140, padding: '0.75rem', outline: 'none', background: '#fff' }}
      />
    </div>
  );
}
