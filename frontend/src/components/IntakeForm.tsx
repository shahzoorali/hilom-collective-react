/**
 * A facilitator's pre-session intake form, rendered for the client.
 *
 * Used in two places with the same fields: on the booking flow, before payment,
 * and on `/account/bookings` afterwards, where the client can revise what they
 * said until the session starts. Sharing the component is the point — the two
 * must ask the same questions in the same way, and a form that looked different
 * on revision would read as a different form.
 *
 * This is a controlled component with no submit button of its own. Both callers
 * already have one (a "Pay" button and a "Save" button), and a form with two
 * ways to submit is a form people submit halfway.
 *
 * Required questions are marked here but enforced on the server. For wellness
 * work these are often screening — a heart condition, a pregnancy, a consent to
 * scope of practice — and a check that lives only in the browser is one a
 * facilitator would be relying on without it being true.
 */
import type { IntakeQuestion } from '../lib/booking';

export default function IntakeForm({
  questions,
  values,
  onChange,
  disabled = false,
}: {
  questions: IntakeQuestion[];
  /** Answers keyed by question id. A checkbox is 'yes' or 'no'. */
  values: Record<string, string>;
  onChange: (id: string, value: string) => void;
  disabled?: boolean;
}) {
  if (questions.length === 0) return null;

  return (
    <>
      {questions.map((q) => {
        const value = values[q.id] ?? '';

        if (q.type === 'checkbox') {
          return (
            <label
              key={q.id}
              className="field row"
              style={{ gap: '0.5rem', alignItems: 'flex-start' }}
            >
              <input
                type="checkbox"
                checked={value === 'yes'}
                disabled={disabled}
                onChange={(e) => onChange(q.id, e.target.checked ? 'yes' : 'no')}
                style={{ marginTop: '0.2rem' }}
              />
              <span>
                {q.label}
                {q.required && <span aria-hidden> *</span>}
                {q.help && (
                  <>
                    <br />
                    <small className="muted">{q.help}</small>
                  </>
                )}
              </span>
            </label>
          );
        }

        return (
          <label key={q.id} className="field">
            <span>
              {q.label}
              {q.required && <span aria-hidden> *</span>}
            </span>

            {q.type === 'longtext' && (
              <textarea
                rows={3}
                value={value}
                disabled={disabled}
                required={q.required}
                onChange={(e) => onChange(q.id, e.target.value)}
              />
            )}

            {q.type === 'text' && (
              <input
                value={value}
                disabled={disabled}
                required={q.required}
                onChange={(e) => onChange(q.id, e.target.value)}
              />
            )}

            {q.type === 'choice' && (
              <select
                value={value}
                disabled={disabled}
                required={q.required}
                onChange={(e) => onChange(q.id, e.target.value)}
              >
                {/* Present even on a required question: a pre-selected first
                    option is an answer nobody gave, and on a screening form
                    that is exactly the answer you do not want by default. */}
                <option value="">Choose…</option>
                {q.options.map((option) => (
                  <option key={option} value={option}>
                    {option}
                  </option>
                ))}
              </select>
            )}

            {q.help && <small className="muted">{q.help}</small>}
          </label>
        );
      })}
    </>
  );
}
