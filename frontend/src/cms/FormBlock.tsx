/**
 * Renders a CMS-defined form and posts it to the backend, which stores the
 * submission for the admin to read.
 *
 * This is for forms an admin builds under Admin → Forms. The community signup
 * form is a separate component (CommunityForm.tsx) because it emails the team
 * via SES rather than storing anything.
 */
import { useEffect, useState, type Dispatch, type FormEvent, type SetStateAction } from 'react';
import { getForm, submitForm, type CmsForm, type FormFieldDef } from '../lib/cms';

/** Must match HONEYPOT_FIELD in backend/src/handlers/forms.ts. */
const HONEYPOT = '_website';

type Values = Record<string, string | string[]>;

function initialValues(fields: FormFieldDef[]): Values {
  return Object.fromEntries(fields.map((f) => [f.name, f.type === 'checkboxGroup' ? [] : '']));
}

export default function FormBlock({ slug, heading }: { slug: string; heading?: string }) {
  const [form, setForm] = useState<CmsForm | null>(null);
  const [values, setValues] = useState<Values>({});
  const [honeypot, setHoneypot] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<string | null>(null);

  useEffect(() => {
    if (!slug) return;
    getForm(slug)
      .then((f) => {
        setForm(f);
        setValues(initialValues(f.fields));
      })
      .catch((e: Error) => setError(e.message));
  }, [slug]);

  function toggle(name: string, option: string) {
    setValues((prev) => {
      const current = Array.isArray(prev[name]) ? (prev[name] as string[]) : [];
      return {
        ...prev,
        [name]: current.includes(option) ? current.filter((v) => v !== option) : [...current, option],
      };
    });
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (!form) return;
    setBusy(true);
    setError(null);
    try {
      const res = await submitForm(form.slug, { ...values, [HONEYPOT]: honeypot });
      setDone(res.message);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (error && !form) {
    return (
      <section className="section">
        <div className="container" style={{ maxWidth: 640 }}>
          <div className="alert alert-error">Couldn't load this form: {error}</div>
        </div>
      </section>
    );
  }
  if (!form) return null;

  return (
    <section className="section" style={{ paddingTop: 0 }}>
      <div className="container" style={{ maxWidth: 640 }}>
        {heading ? <h2>{heading}</h2> : null}
        {done ? (
          <div className="panel">
            <div className="alert alert-success" style={{ marginBottom: 0 }}>
              {done}
            </div>
          </div>
        ) : (
          <form className="panel" onSubmit={onSubmit}>
            {error && <div className="alert alert-error">{error}</div>}
            {renderFields(form.fields, values, setValues, toggle)}

            {/* Hidden from humans, irresistible to bots. Not `type="hidden"` —
                bots skip those; they fill visible-in-the-DOM inputs. */}
            <input
              type="text"
              name={HONEYPOT}
              value={honeypot}
              onChange={(e) => setHoneypot(e.target.value)}
              tabIndex={-1}
              autoComplete="off"
              aria-hidden="true"
              style={{ position: 'absolute', left: '-9999px', width: 1, height: 1 }}
            />

            <button className="btn btn-accent btn-block" type="submit" disabled={busy}>
              {busy ? 'Sending…' : form.submit_label}
            </button>
          </form>
        )}
      </div>
    </section>
  );
}

function renderFields(
  fields: FormFieldDef[],
  values: Values,
  setValues: Dispatch<SetStateAction<Values>>,
  toggle: (name: string, option: string) => void,
) {
  const output = [];
  for (let i = 0; i < fields.length; i++) {
    const field = fields[i];
    // Two consecutive half-width fields share a row, which is how a
    // First name / Last name pair is laid out.
    if (field.half && fields[i + 1]?.half) {
      output.push(
        <div className="row" key={field.name}>
          <Field field={field} values={values} setValues={setValues} toggle={toggle} />
          <Field field={fields[i + 1]} values={values} setValues={setValues} toggle={toggle} />
        </div>,
      );
      i++;
      continue;
    }
    output.push(
      <Field key={field.name} field={field} values={values} setValues={setValues} toggle={toggle} />,
    );
  }
  return output;
}

function Field({
  field,
  values,
  setValues,
  toggle,
}: {
  field: FormFieldDef;
  values: Values;
  setValues: Dispatch<SetStateAction<Values>>;
  toggle: (name: string, option: string) => void;
}) {
  const value = values[field.name];
  const set = (v: string) => setValues((prev) => ({ ...prev, [field.name]: v }));

  return (
    <div className="field">
      <label htmlFor={field.name}>{field.label}</label>

      {field.type === 'textarea' && (
        <textarea
          id={field.name}
          rows={4}
          required={field.required}
          value={String(value ?? '')}
          onChange={(e) => set(e.target.value)}
          style={{
            width: '100%',
            padding: '0.65rem 0.75rem',
            fontFamily: 'var(--sans)',
            fontSize: '0.95rem',
            border: '1px solid var(--line)',
            borderRadius: 8,
          }}
        />
      )}

      {field.type === 'select' && (
        <select
          id={field.name}
          required={field.required}
          value={String(value ?? '')}
          onChange={(e) => set(e.target.value)}
        >
          <option value="">Choose…</option>
          {(field.options ?? []).map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </select>
      )}

      {field.type === 'checkboxGroup' &&
        (field.options ?? []).map((option) => (
          <label
            key={option}
            className="small"
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '0.5rem',
              fontWeight: 400,
              marginBottom: '0.4rem',
            }}
          >
            <input
              type="checkbox"
              style={{ width: 'auto' }}
              checked={Array.isArray(value) && value.includes(option)}
              onChange={() => toggle(field.name, option)}
            />
            {option}
          </label>
        ))}

      {(field.type === 'text' || field.type === 'email') && (
        <input
          id={field.name}
          type={field.type === 'email' ? 'email' : 'text'}
          required={field.required}
          value={String(value ?? '')}
          onChange={(e) => set(e.target.value)}
        />
      )}

      {field.help ? (
        <p className="small muted" style={{ marginTop: '0.4rem' }}>
          {field.help}
        </p>
      ) : null}
    </div>
  );
}
