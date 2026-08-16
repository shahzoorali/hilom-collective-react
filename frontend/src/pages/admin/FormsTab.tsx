/**
 * Form field editor plus the submissions each form has collected.
 *
 * These are forms an admin builds. The community signup form is not listed here
 * — it emails the team via SES and has no stored submissions to show.
 */
import { useEffect, useState } from 'react';
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
    const escape = (v: unknown) => `"${String(Array.isArray(v) ? v.join('; ') : v ?? '').replace(/"/g, '""')}"`;
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

            <div style={{ display: 'flex', gap: '0.5rem' }}>
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

            {submissions.length === 0 ? (
              <p className="muted" style={{ marginTop: '1rem' }}>Nothing submitted yet.</p>
            ) : (
              <div style={{ overflowX: 'auto', marginTop: '1rem' }}>
                <table>
                  <thead>
                    <tr>
                      <th>Received</th>
                      {open.fields.map((f) => (
                        <th key={f.name}>{f.label}</th>
                      ))}
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {submissions.map((s) => (
                      <tr key={s.id} style={s.is_spam ? { opacity: 0.5 } : undefined}>
                        <td className="small">
                          {new Date(s.created_at).toLocaleString()}
                          {s.is_spam && <div className="small muted">flagged as spam</div>}
                        </td>
                        {open.fields.map((f) => (
                          <td className="small" key={f.name}>
                            {Array.isArray(s.data[f.name])
                              ? (s.data[f.name] as string[]).join(', ')
                              : String(s.data[f.name] ?? '')}
                          </td>
                        ))}
                        <td>
                          <button
                            className="btn btn-ghost small"
                            onClick={async () => {
                              if (!window.confirm('Delete this submission?')) return;
                              await adminDeleteSubmission(adminKey, open.id, s.id);
                              setSubmissions((prev) => prev.filter((x) => x.id !== s.id));
                            }}
                          >
                            Delete
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </>
      )}
    </>
  );
}
