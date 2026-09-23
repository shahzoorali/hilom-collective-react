/**
 * Form field editor plus the submissions each form has collected.
 *
 * These are forms an admin builds. The community signup form is not listed here
 * — it emails the team via SES and has no stored submissions to show.
 */
import { useEffect, useMemo, useState } from 'react';
import { DataTable, type Column } from './ui/DataTable';
import { BarList } from './ui/Charts';
import {
  adminCreateForm,
  adminDeleteSubmission,
  adminListForms,
  adminListSubmissions,
  adminUpdateForm,
  type AdminForm,
  type FormFieldDef,
  type FormSubmission,
} from '../../lib/cms';
import { adminConfirm, adminToast } from './ui/feedback';

const FIELD_TYPES: FormFieldDef['type'][] = ['text', 'email', 'textarea', 'checkboxGroup', 'select'];

const blankField = (): FormFieldDef => ({
  name: '',
  label: '',
  type: 'text',
  required: false,
  options: [],
});

export default function FormsTab({ adminKey }: { adminKey: string }) {
  const [forms, setForms] = useState<AdminForm[]>([]);
  const [openId, setOpenId] = useState<string | null>(null);
  const [submissions, setSubmissions] = useState<FormSubmission[]>([]);
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function reload() {
    try {
      setForms(await adminListForms(adminKey));
    } catch (e) {
      setError((e as Error).message);
    }
  }

  useEffect(() => {
    void reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [adminKey]);

  const open = forms.find((f) => f.id === openId) ?? null;

  useEffect(() => {
    if (!openId) return;
    adminListSubmissions(adminKey, openId).then(setSubmissions).catch(() => setSubmissions([]));
  }, [adminKey, openId]);

  function patchOpen(next: Partial<AdminForm>) {
    setForms((prev) => prev.map((f) => (f.id === openId ? { ...f, ...next } : f)));
  }

  async function create() {
    if (!name.trim()) return;
    setBusy(true);
    try {
      const form = await adminCreateForm(adminKey, { name: name.trim() });
      setName('');
      await reload();
      setOpenId(form.id);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function save() {
    if (!open) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await adminUpdateForm(adminKey, open.id, {
        name: open.name,
        fields: open.fields,
        submit_label: open.submit_label,
        success_message: open.success_message,
        requires_captcha: open.requires_captcha,
      });
      setNotice('Form saved.');
      await reload();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  /** CSV is built in the browser from rows already loaded — no extra endpoint,
   *  and no submission data passing through anything new. */
  function exportCsv() {
    if (!open || submissions.length === 0) return;
    const columns = open.fields.map((f) => f.name);
    const escape = (v: unknown) => {
      const text = String(Array.isArray(v) ? v.join('; ') : v ?? '');
      // Quoting alone does not stop a spreadsheet treating a leading =, +, -,
      // @ or control character as a formula. Anyone on the internet can type
      // into these fields, so a submission could otherwise run =HYPERLINK(...)
      // the moment an admin opens the export. The apostrophe forces text.
      const safe = /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
      return `"${safe.replace(/"/g, '""')}"`;
    };
    const csv = [
      ['submitted_at', ...columns].join(','),
      ...submissions.map((s) => [s.created_at, ...columns.map((c) => s.data[c])].map(escape).join(',')),
    ].join('\n');

    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `${open.slug}-submissions.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <>
      {error && <div className="alert alert-error">{error}</div>}
      {notice && <div className="alert alert-success">{notice}</div>}

      <div className="panel" style={{ marginBottom: '1.5rem' }}>
        <h2 style={{ fontSize: '1.15rem', marginTop: 0 }}>Forms</h2>
        <div style={{ display: 'flex', gap: '0.5rem', marginBottom: '0.8rem' }}>
          <input
            style={{ flex: 1 }}
            placeholder="New form name"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          <button className="btn btn-primary" onClick={create} disabled={busy || !name.trim()}>
            Create
          </button>
        </div>

        {forms.map((form) => (
          <button
            key={form.id}
            className={form.id === openId ? 'btn btn-primary small' : 'btn btn-ghost small'}
            style={{ marginRight: '0.4rem', marginBottom: '0.4rem' }}
            onClick={() => setOpenId(form.id)}
          >
            {form.name} ({form.submission_count ?? 0})
          </button>
        ))}
        <p className="small muted" style={{ marginBottom: 0 }}>
          Put a form on a page with the “Custom form” block, using its slug. The community signup
          form is separate — it emails the team rather than storing submissions here.
        </p>
      </div>

      {open && (
        <>
          <div className="panel" style={{ marginBottom: '1.5rem' }}>
            <h2 style={{ fontSize: '1.15rem', marginTop: 0 }}>
              {open.name} <span className="small mono muted">{open.slug}</span>
            </h2>

            {open.fields.map((field, i) => {
              const replace = (next: Partial<FormFieldDef>) =>
                patchOpen({ fields: open.fields.map((f, j) => (j === i ? { ...f, ...next } : f)) });
              const move = (delta: number) => {
                const target = i + delta;
                if (target < 0 || target >= open.fields.length) return;
                const next = [...open.fields];
                [next[i], next[target]] = [next[target], next[i]];
                patchOpen({ fields: next });
              };

              return (
                <fieldset
                  key={i}
                  style={{ border: '1px solid var(--line)', borderRadius: 8, padding: '0.8rem', marginBottom: '0.7rem' }}
                >
                  <legend className="small muted">Field {i + 1}</legend>
                  <div style={{ display: 'flex', gap: '0.4rem', flexWrap: 'wrap' }}>
                    <input
                      placeholder="Label"
                      style={{ flex: '1 1 160px' }}
                      value={field.label}
                      onChange={(e) => replace({ label: e.target.value })}
                    />
                    <input
                      placeholder="name (no spaces)"
                      style={{ flex: '1 1 140px' }}
                      value={field.name}
                      onChange={(e) => replace({ name: e.target.value })}
                    />
                    <select value={field.type} onChange={(e) => replace({ type: e.target.value as FormFieldDef['type'] })}>
                      {FIELD_TYPES.map((t) => (
                        <option key={t} value={t}>
                          {t}
                        </option>
                      ))}
                    </select>
                    <label className="small" style={{ display: 'flex', gap: '0.3rem', margin: 0 }}>
                      <input
                        type="checkbox"
                        style={{ width: 'auto' }}
                        checked={field.required}
                        onChange={(e) => replace({ required: e.target.checked })}
                      />
                      Required
                    </label>
                    <label className="small" style={{ display: 'flex', gap: '0.3rem', margin: 0 }}>
                      <input
                        type="checkbox"
                        style={{ width: 'auto' }}
                        checked={Boolean(field.half)}
                        onChange={(e) => replace({ half: e.target.checked })}
                      />
                      Half width
                    </label>
                    <button className="btn btn-ghost small" onClick={() => move(-1)}>↑</button>
                    <button className="btn btn-ghost small" onClick={() => move(1)}>↓</button>
                    <button
                      className="btn btn-ghost small"
                      onClick={() => patchOpen({ fields: open.fields.filter((_, j) => j !== i) })}
                    >
                      ✕
                    </button>
                  </div>

                  {(field.type === 'checkboxGroup' || field.type === 'select') && (
                    <textarea
                      rows={3}
                      style={{ width: '100%', marginTop: '0.5rem' }}
                      placeholder="One option per line"
                      value={(field.options ?? []).join('\n')}
                      onChange={(e) => replace({ options: e.target.value.split('\n') })}
                    />
                  )}

                  <input
                    style={{ width: '100%', marginTop: '0.5rem' }}
                    placeholder="Help text shown under the field (optional)"
                    value={field.help ?? ''}
                    onChange={(e) => replace({ help: e.target.value })}
                  />
                </fieldset>
              );
            })}

            <div className="field">
              <label>Button text</label>
              <input value={open.submit_label} onChange={(e) => patchOpen({ submit_label: e.target.value })} />
            </div>
            <div className="field">
              <label>Message shown after submitting</label>
              <input
                value={open.success_message}
                onChange={(e) => patchOpen({ success_message: e.target.value })}
              />
            </div>

            <label className="small" style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', fontWeight: 400 }}>
              <input
                type="checkbox"
                style={{ width: 'auto' }}
                checked={open.requires_captcha}
                onChange={(e) => patchOpen({ requires_captcha: e.target.checked })}
              />
              Require reCAPTCHA to submit (recommended — protects against bot spam)
            </label>

            <div style={{ display: 'flex', gap: '0.5rem', marginTop: '0.75rem' }}>
              <button
                className="btn btn-ghost small"
                onClick={() => patchOpen({ fields: [...open.fields, blankField()] })}
              >
                + Add field
              </button>
              <button className="btn btn-primary small" onClick={save} disabled={busy}>
                Save form
              </button>
            </div>
          </div>

          <div className="panel">
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem' }}>
              <h2 style={{ fontSize: '1.15rem', margin: 0 }}>Submissions</h2>
              <button
                className="btn btn-ghost small"
                style={{ marginLeft: 'auto' }}
                onClick={exportCsv}
                disabled={submissions.length === 0}
              >
                Export CSV
              </button>
            </div>

            <SubmissionsInbox
              formId={open.id}
              fields={open.fields}
              submissions={submissions}
              onDelete={async (sub) => {
                if (!(await adminConfirm({ title: 'Delete this submission?', body: 'It is removed permanently.', confirmLabel: 'Delete', danger: true }))) return;
                try {
                  setError(null);
                  await adminDeleteSubmission(adminKey, open.id, sub.id);
                  setSubmissions((prev) => prev.filter((x) => x.id !== sub.id));
                  adminToast.success('Submission deleted');
                } catch (e) {
                  // Without this the rejection was swallowed: the row stayed put
                  // with no message, which reads exactly like a delete that worked.
                  setError(`Delete failed: ${(e as Error).message}`);
                }
              }}
            />
          </div>
        </>
      )}
    </>
  );
}

type Field = { name: string; label: string; type?: string; options?: string[] };

const cell = (v: unknown) => (Array.isArray(v) ? (v as string[]).join(', ') : String(v ?? ''));

/** Read state is per browser — a convenience for whoever works the inbox, not a record. */
const readKey = (formId: string) => `hilom.admin.forms.${formId}.read`;
const loadRead = (formId: string): Set<string> => {
  try {
    return new Set(JSON.parse(localStorage.getItem(readKey(formId)) ?? '[]') as string[]);
  } catch {
    return new Set();
  }
};

/**
 * Submissions as an inbox: unread in bold, spam hidden by default, searchable
 * and sortable, and a per-field breakdown for any field with fixed options
 * (select / radio / checkbox) — the "what did people answer?" question that the
 * raw table made you count by hand.
 */
function SubmissionsInbox({
  formId,
  fields,
  submissions,
  onDelete,
}: {
  formId: string;
  fields: Field[];
  submissions: FormSubmission[];
  onDelete: (s: FormSubmission) => void;
}) {
  const [read, setRead] = useState<Set<string>>(() => loadRead(formId));
  const [showSpam, setShowSpam] = useState(false);
  const [unreadOnly, setUnreadOnly] = useState(false);
  useEffect(() => setRead(loadRead(formId)), [formId]);
  const persist = (next: Set<string>) => {
    setRead(next);
    try {
      localStorage.setItem(readKey(formId), JSON.stringify([...next]));
    } catch {
      /* not persisted */
    }
  };
  const markRead = (ids: string[], v: boolean) => {
    const n = new Set(read);
    for (const id of ids) {
      if (v) n.add(id);
      else n.delete(id);
    }
    persist(n);
  };

  const rows = submissions.filter((s) => (showSpam || !s.is_spam) && (!unreadOnly || !read.has(s.id)));
  const unread = submissions.filter((s) => !s.is_spam && !read.has(s.id)).length;
  const spam = submissions.filter((s) => s.is_spam).length;

  const breakdowns = useMemo(() => {
    const live = submissions.filter((s) => !s.is_spam);
    return fields
      .filter((f) => (f.options?.length ?? 0) > 0 || f.type === 'select' || f.type === 'radio' || f.type === 'checkbox')
      .map((f) => {
        const counts = new Map<string, number>();
        for (const s of live) {
          const v = s.data[f.name];
          for (const x of Array.isArray(v) ? v : v == null || v === '' ? [] : [v]) counts.set(String(x), (counts.get(String(x)) ?? 0) + 1);
        }
        return { field: f, items: [...counts].map(([label, value]) => ({ label, value })).sort((a, b) => b.value - a.value).slice(0, 8) };
      })
      .filter((b) => b.items.length);
  }, [fields, submissions]);

  const columns: Column<FormSubmission>[] = [
    {
      key: 'received',
      header: 'Received',
      pinned: true,
      sortValue: (s) => s.created_at,
      render: (s) => (
        <span className="small" style={{ fontWeight: read.has(s.id) ? 400 : 700 }}>
          {!read.has(s.id) && <span aria-label="unread" style={{ display: 'inline-block', width: 7, height: 7, borderRadius: 9, background: 'var(--ochre)', marginRight: 6 }} />}
          {new Date(s.created_at).toLocaleString()}
          {s.is_spam && <span className="pill pill-bad" style={{ marginLeft: 6 }}>spam</span>}
        </span>
      ),
    },
    ...fields.map<Column<FormSubmission>>((f, i) => ({
      key: `f_${f.name}`,
      header: f.label,
      defaultHidden: i >= 4,
      sortValue: (s) => cell(s.data[f.name]),
      render: (s) => <span className="small" style={{ fontWeight: read.has(s.id) ? 400 : 600 }}>{cell(s.data[f.name]).slice(0, 120)}</span>,
    })),
    {
      key: 'actions',
      header: '',
      pinned: true,
      render: (s) => (
        <button className="btn btn-ghost small" onClick={() => onDelete(s)}>
          Delete
        </button>
      ),
    },
  ];

  return (
    <div style={{ marginTop: '1rem' }}>
      {breakdowns.length > 0 && (
        <div className="dash-grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))' }}>
          {breakdowns.map((b) => (
            <div key={b.field.name} className="dash-card">
              <h3>{b.field.label}</h3>
              <BarList items={b.items} />
            </div>
          ))}
        </div>
      )}
      <DataTable
        id={`form-${formId}`}
        rows={rows}
        rowKey={(s) => s.id}
        columns={columns}
        searchText={(s) => Object.values(s.data).map(cell).join(' ')}
        searchPlaceholder="Search responses…"
        csvName={`form-${formId}`}
        defaultSort={{ key: 'received', dir: 'desc' }}
        rowClassName={(s) => (s.is_spam ? 'row-muted' : undefined)}
        toolbar={
          <>
            <label className="row" style={{ gap: '0.35rem', margin: 0, fontWeight: 500 }}>
              <input type="checkbox" style={{ width: 'auto', margin: 0 }} checked={unreadOnly} onChange={(e) => setUnreadOnly(e.target.checked)} />
              Unread ({unread})
            </label>
            {spam > 0 && (
              <label className="row" style={{ gap: '0.35rem', margin: 0, fontWeight: 500 }}>
                <input type="checkbox" style={{ width: 'auto', margin: 0 }} checked={showSpam} onChange={(e) => setShowSpam(e.target.checked)} />
                Show spam ({spam})
              </label>
            )}
          </>
        }
        bulkActions={[
          { label: 'Mark read', run: (list) => markRead(list.map((s) => s.id), true) },
          { label: 'Mark unread', run: (list) => markRead(list.map((s) => s.id), false) },
        ]}
        expand={(s) => {
          if (!read.has(s.id)) window.setTimeout(() => markRead([s.id], true), 0);
          return (
            <dl style={{ display: 'grid', gridTemplateColumns: 'minmax(120px, max-content) 1fr', gap: '0.35rem 1rem', margin: 0 }}>
              {fields.map((f) => (
                <div key={f.name} style={{ display: 'contents' }}>
                  <dt className="small muted" style={{ fontWeight: 700 }}>{f.label}</dt>
                  <dd style={{ margin: 0, whiteSpace: 'pre-wrap' }}>{cell(s.data[f.name]) || <span className="muted">—</span>}</dd>
                </div>
              ))}
            </dl>
          );
        }}
        empty={{ title: 'Nothing submitted yet', body: 'Responses appear here as soon as someone submits the form.' }}
      />
    </div>
  );
}
