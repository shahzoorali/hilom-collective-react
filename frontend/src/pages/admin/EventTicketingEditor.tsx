/**
 * Ticketing configuration for an event: capacity, the registration window, the
 * fields registrants are asked for, and the payment plans on offer.
 *
 * Two things about this screen are load-bearing.
 *
 * **Dates are calendar days, not instants.** Every date input here is a plain
 * `type="date"`, and what is sent is `YYYY-MM-DD`. The backend resolves it to
 * the end (or start) of that day in Asia/Manila. Sending an instant from a
 * `datetime-local` would silently encode whichever midnight the admin's browser
 * was in, so a due date set from a laptop in another timezone would land on the
 * wrong day for everyone in Lipa. Each field echoes the resolved meaning back
 * underneath it, so the rule is visible rather than merely correct.
 *
 * **A plan's parts must sum to its total.** The running total is shown live and
 * the save is blocked until it balances, because the database refuses the write
 * anyway (a deferred trigger, migration 0016) and a constraint violation at
 * commit is a worse way to learn it. This is the screen where ₱8,333.35 × 3
 * would have become a ₱30,000.05 retreat.
 */
import { useCallback, useEffect, useState } from 'react';
import {
  adminGetEventPlans,
  adminReplaceEventPlans,
  REGISTRANT_FIELDS,
  REGISTRANT_FIELD_LABELS,
  type AdminEvent,
  type AdminEventInput,
  type AdminPlan,
  type AdminInstallment,
  type EventFormat,
} from '../../lib/cms';
import { money } from '../../components/Layout';

// ---------------------------------------------------------------------------
// Draft shape
// ---------------------------------------------------------------------------

export interface TicketingDraft {
  ticketing_enabled: boolean;
  format: EventFormat | '';
  capacity: string;
  hold_minutes: string;
  registration_opens_at: string;
  registration_closes_at: string;
  venue_details: string;
  medical_disclaimer_html: string;
  liability_consent_html: string;
  registrant_fields: string[];
}

export const blankTicketing: TicketingDraft = {
  ticketing_enabled: false,
  format: '',
  capacity: '',
  hold_minutes: '60',
  registration_opens_at: '',
  registration_closes_at: '',
  venue_details: '',
  medical_disclaimer_html: '',
  liability_consent_html: '',
  registrant_fields: [],
};

/** An ISO instant back to the Manila calendar day it falls on. */
function manilaDay(iso: string | null): string {
  if (!iso) return '';
  const shifted = new Date(new Date(iso).getTime() + 8 * 3_600_000);
  return Number.isNaN(shifted.getTime()) ? '' : shifted.toISOString().slice(0, 10);
}

export function ticketingToDraft(event: AdminEvent): TicketingDraft {
  return {
    ticketing_enabled: Boolean(event.ticketing_enabled),
    format: event.format ?? '',
    capacity: event.capacity == null ? '' : String(event.capacity),
    hold_minutes: String(event.hold_minutes ?? 60),
    registration_opens_at: manilaDay(event.registration_opens_at),
    registration_closes_at: manilaDay(event.registration_closes_at),
    venue_details: event.venue_details ?? '',
    medical_disclaimer_html: event.medical_disclaimer_html ?? '',
    liability_consent_html: event.liability_consent_html ?? '',
    registrant_fields: event.registrant_fields ?? [],
  };
}

/**
 * The ticketing half of the event write payload.
 *
 * Always sends every key once ticketing has been touched, so the backend's
 * "did the body mention ticketing at all?" check resolves to yes and the whole
 * block is applied together. Half-sending would let a cleared field read as an
 * omission and quietly keep its old value.
 */
export function ticketingToInput(draft: TicketingDraft): Partial<AdminEventInput> {
  return {
    ticketing_enabled: draft.ticketing_enabled,
    format: draft.format || null,
    capacity: draft.capacity.trim() === '' ? null : Number(draft.capacity),
    hold_minutes: Number(draft.hold_minutes) || 60,
    registration_opens_at: draft.registration_opens_at || null,
    registration_closes_at: draft.registration_closes_at || null,
    venue_details: draft.venue_details.trim() || null,
    medical_disclaimer_html: draft.medical_disclaimer_html.trim() || null,
    liability_consent_html: draft.liability_consent_html.trim() || null,
    registrant_fields: draft.registrant_fields,
  };
}

// ---------------------------------------------------------------------------
// Money helpers
// ---------------------------------------------------------------------------

const toCentavos = (pesos: string): number => Math.round(Number(pesos || '0') * 100);
const toPesos = (centavos: number): string => (centavos / 100).toFixed(2);

/** The remainder lands on the last part, so nobody pays the rounding early. */
function splitEvenly(totalCentavos: number, parts: number): number[] {
  const base = Math.floor(totalCentavos / parts);
  const out = new Array<number>(parts).fill(base);
  out[parts - 1] = totalCentavos - base * (parts - 1);
  return out;
}

interface PlanDraft extends Omit<AdminPlan, 'total_centavos' | 'installments'> {
  totalPesos: string;
  installments: (Omit<AdminInstallment, 'amount_centavos' | 'due_at'> & {
    amountPesos: string;
    dueDate: string;
  })[];
}

function planToDraft(plan: AdminPlan): PlanDraft {
  return {
    ...plan,
    totalPesos: toPesos(plan.total_centavos),
    available_from: manilaDay(plan.available_from),
    available_until: manilaDay(plan.available_until),
    installments: plan.installments.map((i) => ({
      ...i,
      amountPesos: toPesos(i.amount_centavos),
      dueDate: manilaDay(i.due_at),
    })),
  };
}

function draftToPlan(draft: PlanDraft): AdminPlan {
  return {
    ...(draft.id ? { id: draft.id } : {}),
    name: draft.name,
    description: draft.description,
    kind: draft.kind,
    total_centavos: toCentavos(draft.totalPesos),
    currency: draft.currency || 'PHP',
    available_from: draft.available_from || null,
    available_until: draft.available_until || null,
    is_active: draft.is_active,
    sort_order: draft.sort_order,
    installments: draft.installments.map((i, idx) => ({
      seq: idx + 1,
      label: i.label,
      amount_centavos: toCentavos(i.amountPesos),
      due_at: i.is_deposit ? null : i.dueDate || null,
      due_offset_days: i.due_offset_days ?? null,
      is_deposit: i.is_deposit,
    })),
  };
}

const newPlan = (sortOrder: number): PlanDraft => ({
  name: '',
  description: null,
  kind: 'full',
  totalPesos: '',
  currency: 'PHP',
  available_from: '',
  available_until: '',
  is_active: true,
  sort_order: sortOrder,
  installments: [{ seq: 1, label: 'Full payment', amountPesos: '', dueDate: '', due_offset_days: null, is_deposit: true }],
});

/** Sum of a plan's parts, in centavos. */
const partsTotal = (plan: PlanDraft): number =>
  plan.installments.reduce((acc, i) => acc + toCentavos(i.amountPesos), 0);

/** The one message an admin needs when a plan will not save. */
function planProblem(plan: PlanDraft): string | null {
  if (!plan.name.trim()) return 'This plan needs a name.';
  if (plan.installments.length === 0) return 'This plan has no payments.';
  if (plan.kind === 'full' && plan.installments.length > 1) {
    return 'A pay-in-full plan can only have one payment.';
  }
  const deposits = plan.installments.filter((i) => i.is_deposit).length;
  if (deposits !== 1) {
    return deposits === 0
      ? 'Mark one payment as the deposit — the one taken at registration.'
      : `${deposits} payments are marked as the deposit; there can only be one.`;
  }
  for (const [idx, inst] of plan.installments.entries()) {
    if (!inst.label.trim()) return `Payment ${idx + 1} needs a label.`;
    if (toCentavos(inst.amountPesos) <= 0) return `Payment ${idx + 1} must be more than zero.`;
    if (!inst.is_deposit && !inst.dueDate) return `Payment ${idx + 1} needs a due date.`;
  }
  const sum = partsTotal(plan);
  const total = toCentavos(plan.totalPesos);
  if (total <= 0) return 'This plan needs a total price.';
  if (sum !== total) {
    const diff = sum - total;
    return `Payments add up to ₱${toPesos(sum)} but the total is ₱${toPesos(total)} — ${
      diff > 0 ? 'over' : 'short'
    } by ₱${toPesos(Math.abs(diff))}.`;
  }
  if (plan.available_from && plan.available_until && plan.available_from > plan.available_until) {
    return 'This plan closes before it opens.';
  }
  return null;
}

// ---------------------------------------------------------------------------

interface Props {
  adminKey: string;
  /** Null for an event that has not been saved yet — plans need an id. */
  eventId: string | null;
  value: TicketingDraft;
  onChange: (next: TicketingDraft) => void;
}

export default function EventTicketingEditor({ adminKey, eventId, value, onChange }: Props) {
  const set = <K extends keyof TicketingDraft>(key: K, next: TicketingDraft[K]) =>
    onChange({ ...value, [key]: next });

  const toggleField = (field: string) =>
    set(
      'registrant_fields',
      value.registrant_fields.includes(field)
        ? value.registrant_fields.filter((f) => f !== field)
        : [...value.registrant_fields, field],
    );

  return (
    <div style={{ display: 'grid', gap: 18 }}>
      <label className="field" style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <input
          type="checkbox"
          checked={value.ticketing_enabled}
          onChange={(e) => set('ticketing_enabled', e.target.checked)}
          style={{ width: 'auto' }}
        />
        <span>
          <strong>Sell places for this event</strong>
          <br />
          <span className="small muted">
            Off means this is a listing only — it appears on the events page with no way to register.
          </span>
        </span>
      </label>

      {value.ticketing_enabled && (
        <>
          <div className="row">
            <label className="field">
              <span>Format</span>
              <select value={value.format} onChange={(e) => set('format', e.target.value as EventFormat | '')}>
                <option value="">Choose…</option>
                <option value="residential">Residential — multi-day, people stay over</option>
                <option value="virtual">Virtual — online</option>
                <option value="day">Day — in person, single day</option>
              </select>
            </label>

            <label className="field">
              <span>Places for sale</span>
              <input
                type="number"
                min={1}
                value={value.capacity}
                onChange={(e) => set('capacity', e.target.value)}
                placeholder="13"
              />
              <span className="small muted">Cannot be lowered below the number already taken.</span>
            </label>
          </div>

          <div className="row">
            <label className="field">
              <span>Registration opens</span>
              <input
                type="date"
                value={value.registration_opens_at}
                onChange={(e) => set('registration_opens_at', e.target.value)}
              />
              <span className="small muted">
                {value.registration_opens_at
                  ? `From 12:00 AM Manila on ${value.registration_opens_at}`
                  : 'Leave blank to open immediately.'}
              </span>
            </label>

            <label className="field">
              <span>Registration closes</span>
              <input
                type="date"
                value={value.registration_closes_at}
                onChange={(e) => set('registration_closes_at', e.target.value)}
              />
              <span className="small muted">
                {value.registration_closes_at
                  ? `Until 11:59 PM Manila on ${value.registration_closes_at}`
                  : 'Leave blank to stay open until the places run out.'}
              </span>
            </label>
          </div>

          <label className="field">
            <span>Hold on an unpaid place (minutes)</span>
            <input
              type="number"
              min={5}
              max={1440}
              value={value.hold_minutes}
              onChange={(e) => set('hold_minutes', e.target.value)}
            />
            <span className="small muted">
              How long someone's place is reserved while they pay. It is released automatically after this.
            </span>
          </label>

          <label className="field">
            <span>Venue details</span>
            <textarea
              rows={3}
              value={value.venue_details}
              onChange={(e) => set('venue_details', e.target.value)}
              placeholder="Shared rooms, all meals included. Transport not provided."
            />
            <span className="small muted">Shown on the registration page and in the confirmation email.</span>
          </label>

          <label className="field">
            <span>Medical / psychological disclaimer</span>
            <textarea
              rows={4}
              value={value.medical_disclaimer_html}
              onChange={(e) => set('medical_disclaimer_html', e.target.value)}
              placeholder="This retreat includes emotionally demanding work. If you have a diagnosed physical, psychological, or psychiatric condition, please consult your own practitioner before registering. Hilom Collective and its facilitators are not medical providers and accept no liability for undisclosed conditions."
            />
            <span className="small muted">
              Shown on the registration page above its own required checkbox. Leave blank to hide the block.
              Basic HTML (paragraphs, lists, links, bold) is allowed.
            </span>
          </label>

          <label className="field">
            <span>Liability &amp; participation consent</span>
            <textarea
              rows={4}
              value={value.liability_consent_html}
              onChange={(e) => set('liability_consent_html', e.target.value)}
              placeholder="I take part in this event voluntarily and at my own risk. I release Hilom Collective, its facilitators, and the venue from liability for any loss, injury, or damage except where caused by gross negligence. I agree to follow the facilitators' guidance and the venue's house rules."
            />
            <span className="small muted">
              Shown on the registration page above its own required checkbox. Leave blank to hide the block.
              Basic HTML is allowed.
            </span>
          </label>

          <div className="field">
            <span>Ask registrants for</span>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, marginTop: 6 }}>
              {REGISTRANT_FIELDS.map((field) => (
                <label
                  key={field}
                  className="small"
                  style={{ display: 'flex', alignItems: 'center', gap: 6, whiteSpace: 'nowrap' }}
                >
                  <input
                    type="checkbox"
                    checked={value.registrant_fields.includes(field)}
                    onChange={() => toggleField(field)}
                    style={{ width: 'auto' }}
                  />
                  {REGISTRANT_FIELD_LABELS[field] ?? field}
                </label>
              ))}
            </div>
            <span className="small muted">
              Name, email and phone are always collected. These end up on the roster you hand to the venue.
            </span>
          </div>

          <PlanBuilder adminKey={adminKey} eventId={eventId} />
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Plans
// ---------------------------------------------------------------------------

function PlanBuilder({ adminKey, eventId }: { adminKey: string; eventId: string | null }) {
  const [plans, setPlans] = useState<PlanDraft[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    if (!eventId) return;
    try {
      const fetched = await adminGetEventPlans(adminKey, eventId);
      setPlans(fetched.map(planToDraft));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load the payment plans.');
      setPlans([]);
    }
  }, [adminKey, eventId]);

  useEffect(() => {
    void load();
  }, [load]);

  if (!eventId) {
    return (
      <div className="panel">
        <strong>Payment plans</strong>
        <p className="small muted" style={{ margin: '6px 0 0' }}>
          Save this event first, then set up how people can pay for it.
        </p>
      </div>
    );
  }

  if (plans === null) return <div className="spinner" aria-label="Loading payment plans" />;

  const problems = plans.map(planProblem);
  const blocking = problems.find((p) => p !== null) ?? null;

  const update = (idx: number, next: PlanDraft) => {
    setPlans(plans.map((p, i) => (i === idx ? next : p)));
    setSaved(false);
  };

  async function save() {
    if (blocking) return;
    setSaving(true);
    setError(null);
    try {
      const written = await adminReplaceEventPlans(adminKey, eventId!, plans!.map(draftToPlan));
      setPlans(written.map(planToDraft));
      setSaved(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save the payment plans.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="panel" style={{ display: 'grid', gap: 14 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12 }}>
        <div>
          <strong>Payment plans</strong>
          <div className="small muted">What a registrant can choose at checkout.</div>
        </div>
        <button
          type="button"
          className="btn btn-ghost"
          onClick={() => {
            setPlans([...plans, newPlan(plans.length)]);
            setSaved(false);
          }}
        >
          + Add a plan
        </button>
      </div>

      {error && <div className="alert alert-error">{error}</div>}

      {plans.length === 0 && (
        <p className="small muted" style={{ margin: 0 }}>
          No plans yet. Without at least one, nobody can register.
        </p>
      )}

      {plans.map((plan, idx) => (
        <PlanCard
          key={plan.id ?? `new-${idx}`}
          plan={plan}
          problem={problems[idx] ?? null}
          onChange={(next) => update(idx, next)}
          onRemove={() => {
            setPlans(plans.filter((_, i) => i !== idx));
            setSaved(false);
          }}
        />
      ))}

      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <button type="button" className="btn btn-primary" onClick={() => void save()} disabled={saving || !!blocking}>
          {saving ? 'Saving…' : 'Save payment plans'}
        </button>
        {blocking && <span className="small" style={{ color: 'var(--danger)' }}>{blocking}</span>}
        {saved && !blocking && <span className="small muted">Saved.</span>}
      </div>
    </div>
  );
}

function PlanCard({
  plan,
  problem,
  onChange,
  onRemove,
}: {
  plan: PlanDraft;
  problem: string | null;
  onChange: (next: PlanDraft) => void;
  onRemove: () => void;
}) {
  const locked = Boolean(plan.schedule_locked);
  const sum = partsTotal(plan);
  const total = toCentavos(plan.totalPesos);
  const balanced = sum === total && total > 0;

  const set = <K extends keyof PlanDraft>(key: K, value: PlanDraft[K]) => onChange({ ...plan, [key]: value });

  const setInstallment = (idx: number, patch: Partial<PlanDraft['installments'][number]>) =>
    onChange({
      ...plan,
      installments: plan.installments.map((inst, i) => (i === idx ? { ...inst, ...patch } : inst)),
    });

  /**
   * Rebuilds the schedule as a deposit plus N equal instalments.
   *
   * The deposit keeps whatever it is already set to — it is a business decision
   * (₱5,000), not an arithmetic one — and the remainder is divided across the
   * rest with the odd centavo on the final payment.
   */
  function splitRemainder() {
    const deposit = plan.installments.find((i) => i.is_deposit);
    const depositCentavos = deposit ? toCentavos(deposit.amountPesos) : 0;
    const rest = plan.installments.filter((i) => !i.is_deposit);
    if (rest.length === 0) return;
    const amounts = splitEvenly(total - depositCentavos, rest.length);
    let n = 0;
    onChange({
      ...plan,
      installments: plan.installments.map((inst) =>
        inst.is_deposit ? inst : { ...inst, amountPesos: toPesos(amounts[n++] ?? 0) },
      ),
    });
  }

  return (
    <div className="card" style={{ display: 'grid', gap: 12, padding: 14 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'flex-start' }}>
        <label className="field" style={{ flex: 1, margin: 0 }}>
          <span>Plan name</span>
          <input
            value={plan.name}
            onChange={(e) => set('name', e.target.value)}
            placeholder="Early bird — 4 payments"
          />
        </label>
        <button type="button" className="btn btn-ghost" onClick={onRemove} style={{ marginTop: 22 }}>
          Remove
        </button>
      </div>

      {locked && (
        <div className="alert alert-info small">
          {plan.registration_count} {plan.registration_count === 1 ? 'person is' : 'people are'} on this plan, so
          the price and schedule are fixed — that is what they agreed to. You can still rename it, change when it
          is offered, or switch it off. To sell at a different price, add a new plan.
        </div>
      )}

      <div className="row">
        <label className="field">
          <span>How they pay</span>
          <select
            value={plan.kind}
            disabled={locked}
            onChange={(e) => {
              const kind = e.target.value as PlanDraft['kind'];
              onChange({
                ...plan,
                kind,
                installments:
                  kind === 'full'
                    ? [
                        {
                          seq: 1,
                          label: 'Full payment',
                          amountPesos: plan.totalPesos,
                          dueDate: '',
                          due_offset_days: null,
                          is_deposit: true,
                        },
                      ]
                    : plan.installments,
              });
            }}
          >
            <option value="full">All at once</option>
            <option value="installment">In instalments</option>
          </select>
        </label>

        <label className="field">
          <span>Total price (₱)</span>
          <input
            type="number"
            min={0}
            step="0.01"
            value={plan.totalPesos}
            disabled={locked}
            onChange={(e) => {
              const next = e.target.value;
              onChange(
                plan.kind === 'full'
                  ? {
                      ...plan,
                      totalPesos: next,
                      installments: plan.installments.map((i, idx) =>
                        idx === 0 ? { ...i, amountPesos: next } : i,
                      ),
                    }
                  : { ...plan, totalPesos: next },
              );
            }}
            placeholder="30000.00"
          />
        </label>
      </div>

      <div className="row">
        <label className="field">
          <span>Offered from</span>
          <input
            type="date"
            value={plan.available_from ?? ''}
            onChange={(e) => set('available_from', e.target.value)}
          />
          <span className="small muted">
            {plan.available_from ? `12:00 AM Manila on ${plan.available_from}` : 'Available straight away.'}
          </span>
        </label>

        <label className="field">
          <span>Offered until</span>
          <input
            type="date"
            value={plan.available_until ?? ''}
            onChange={(e) => set('available_until', e.target.value)}
          />
          <span className="small muted">
            {plan.available_until ? `11:59 PM Manila on ${plan.available_until}` : 'No cutoff.'}
          </span>
        </label>
      </div>

      <label className="small" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <input
          type="checkbox"
          checked={plan.is_active}
          onChange={(e) => set('is_active', e.target.checked)}
          style={{ width: 'auto' }}
        />
        Offer this plan
      </label>

      {plan.kind === 'installment' && (
        <div style={{ display: 'grid', gap: 8 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10 }}>
            <strong className="small">Schedule</strong>
            {!locked && (
              <div style={{ display: 'flex', gap: 8 }}>
                <button type="button" className="btn btn-ghost small" onClick={splitRemainder}>
                  Split the balance evenly
                </button>
                <button
                  type="button"
                  className="btn btn-ghost small"
                  onClick={() =>
                    onChange({
                      ...plan,
                      installments: [
                        ...plan.installments,
                        {
                          seq: plan.installments.length + 1,
                          label: `Payment ${plan.installments.length + 1}`,
                          amountPesos: '',
                          dueDate: '',
                          due_offset_days: null,
                          is_deposit: plan.installments.length === 0,
                        },
                      ],
                    })
                  }
                >
                  + Add a payment
                </button>
              </div>
            )}
          </div>

          {plan.installments.map((inst, idx) => (
            <div
              key={idx}
              style={{ display: 'grid', gridTemplateColumns: '1.4fr 1fr 1.2fr auto auto', gap: 8, alignItems: 'center' }}
            >
              <input
                value={inst.label}
                disabled={locked}
                onChange={(e) => setInstallment(idx, { label: e.target.value })}
                placeholder="Down payment"
              />
              <input
                type="number"
                min={0}
                step="0.01"
                value={inst.amountPesos}
                disabled={locked}
                onChange={(e) => setInstallment(idx, { amountPesos: e.target.value })}
                placeholder="0.00"
              />
              {inst.is_deposit ? (
                <span className="small muted">Due at registration</span>
              ) : (
                <input
                  type="date"
                  value={inst.dueDate}
                  disabled={locked}
                  onChange={(e) => setInstallment(idx, { dueDate: e.target.value })}
                />
              )}
              <label className="small" style={{ display: 'flex', alignItems: 'center', gap: 4, whiteSpace: 'nowrap' }}>
                <input
                  type="radio"
                  name={`deposit-${plan.id ?? plan.name}`}
                  checked={inst.is_deposit}
                  disabled={locked}
                  onChange={() =>
                    onChange({
                      ...plan,
                      installments: plan.installments.map((i, n) => ({ ...i, is_deposit: n === idx })),
                    })
                  }
                  style={{ width: 'auto' }}
                />
                Deposit
              </label>
              <button
                type="button"
                className="btn btn-ghost small"
                disabled={locked}
                onClick={() =>
                  onChange({ ...plan, installments: plan.installments.filter((_, n) => n !== idx) })
                }
              >
                ✕
              </button>
            </div>
          ))}

          <div
            className="small"
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              paddingTop: 6,
              borderTop: '1px solid var(--line)',
              color: balanced ? 'var(--muted)' : 'var(--danger)',
            }}
          >
            <span>Payments add up to</span>
            <strong>
              {money(sum, plan.currency || 'PHP')}
              {total > 0 && ` of ${money(total, plan.currency || 'PHP')}`}
              {balanced && ' ✓'}
            </strong>
          </div>
        </div>
      )}

      {problem && !locked && <div className="small" style={{ color: 'var(--danger)' }}>{problem}</div>}
    </div>
  );
}
