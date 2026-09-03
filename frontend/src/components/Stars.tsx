/**
 * A star rating, to read and to set.
 *
 * One component for both because they must look like the same thing: a client
 * setting four stars and then seeing four stars on the profile should recognise
 * what they did. The interactive mode is real radio buttons under the hood
 * rather than clickable spans, so it is keyboard-operable and announces itself
 * as a rating rather than as decoration.
 */

const LABELS = ['Poor', 'Fair', 'Good', 'Great', 'Excellent'];

export function Stars({ value, size = '1rem' }: { value: number; size?: string }) {
  const rounded = Math.round(value);
  return (
    <span
      // The number is the accessible content — the glyphs are the picture of
      // it, and a screen reader reading five star characters says nothing.
      aria-label={`${value} out of 5`}
      style={{ color: '#c8912a', fontSize: size, letterSpacing: '0.05em' }}
    >
      <span aria-hidden>{'★'.repeat(rounded)}{'☆'.repeat(Math.max(0, 5 - rounded))}</span>
    </span>
  );
}

export function StarInput({
  value,
  onChange,
  disabled = false,
}: {
  value: number;
  onChange: (rating: number) => void;
  disabled?: boolean;
}) {
  return (
    <fieldset style={{ border: 0, padding: 0, margin: '0 0 0.75rem' }}>
      <legend className="sr-only">Your rating</legend>
      <div className="row" style={{ gap: '0.35rem', alignItems: 'center' }}>
        {[1, 2, 3, 4, 5].map((n) => (
          <label key={n} style={{ cursor: disabled ? 'default' : 'pointer' }}>
            <input
              type="radio"
              name="rating"
              className="sr-only"
              checked={value === n}
              disabled={disabled}
              onChange={() => onChange(n)}
            />
            <span
              aria-hidden
              style={{
                fontSize: '1.6rem',
                lineHeight: 1,
                color: n <= value ? '#c8912a' : '#cfcabc',
              }}
            >
              {n <= value ? '★' : '☆'}
            </span>
            <span className="sr-only">
              {n} star{n === 1 ? '' : 's'} — {LABELS[n - 1]}
            </span>
          </label>
        ))}
        {value > 0 && (
          <span className="small muted" style={{ marginLeft: '0.35rem' }}>
            {LABELS[value - 1]}
          </span>
        )}
      </div>
    </fieldset>
  );
}
