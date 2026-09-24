/**
 * The amount box for a pay-what-you-want price — event plans and group classes.
 *
 * Presets and a free-entry field together: the buttons are what most people
 * use, the box is what makes the offer honest. The minimum is stated up front
 * rather than enforced silently on submit.
 *
 * Nothing here is authoritative — the server and the database row lock both
 * re-check the floor.
 */
import { money } from './Layout';

/** Pesos typed into the box → centavos, or null while it is empty. */
export function pesoInputToCentavos(value: string): number | null {
  return value.trim() === '' ? null : Math.round(Number(value) * 100);
}

export function isValidAmount(centavos: number | null, floorCentavos: number): boolean {
  return centavos !== null && Number.isFinite(centavos) && centavos >= floorCentavos;
}

export default function AmountChooser({
  suggestedCentavos,
  currency,
  value,
  onChange,
  floorCentavos,
  valid,
}: {
  suggestedCentavos?: number[] | null;
  currency: string;
  value: string;
  onChange: (next: string) => void;
  floorCentavos: number;
  valid: boolean;
}) {
  const presets = (suggestedCentavos ?? []).filter((c) => c >= floorCentavos);
  // Whole amounts lose the ".00" so a preset click leaves "100" in the field.
  const toPesoString = (centavos: number) =>
    centavos % 100 === 0 ? String(centavos / 100) : (centavos / 100).toFixed(2);

  const typed = value.trim();
  const showError = typed !== '' && !valid;

  return (
    <div className="field" style={{ display: 'grid', gap: 8 }}>
      <span style={{ fontWeight: 600 }}>How much would you like to pay?</span>
      <span className="small muted" style={{ marginTop: -4 }}>
        This class is donation-based — you choose the amount. Minimum{' '}
        {money(floorCentavos, currency)}.
      </span>

      {presets.length > 0 && (
        <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
          {presets.map((centavos) => {
            const asString = toPesoString(centavos);
            return (
              <button
                key={centavos}
                type="button"
                className={typed === asString ? 'btn btn-small' : 'btn btn-secondary btn-small'}
                onClick={() => onChange(asString)}
              >
                {money(centavos, currency)}
              </button>
            );
          })}
        </div>
      )}

      <label style={{ display: 'grid', gap: 4 }}>
        <span className="small muted">Or enter your own amount</span>
        <input
          type="number"
          inputMode="decimal"
          min={floorCentavos / 100}
          step="0.01"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={toPesoString(floorCentavos)}
          aria-label={`Amount in ${currency}`}
          aria-invalid={showError || undefined}
        />
      </label>

      {showError && (
        <span className="small" style={{ color: 'var(--error, #a33)' }}>
          Please enter at least {money(floorCentavos, currency)}.
        </span>
      )}
    </div>
  );
}
