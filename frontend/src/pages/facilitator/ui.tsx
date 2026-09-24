/**
 * Shared layout pieces for the facilitator studio, so every tab speaks the
 * same visual language as the Overview: a serif page header, section cards,
 * and a sticky action bar for forms that save.
 */
import type { ReactNode } from 'react';

export function PageHeader({
  title,
  subtitle,
  back,
  actions,
}: {
  title: string;
  subtitle?: ReactNode;
  back?: { label: string; onClick: () => void };
  actions?: ReactNode;
}) {
  return (
    <header className="fs-pagehead">
      <div>
        {back && (
          <button type="button" className="fs-backlink" onClick={back.onClick}>
            ← {back.label}
          </button>
        )}
        <h1>{title}</h1>
        {subtitle && <p>{subtitle}</p>}
      </div>
      {actions && <div className="fs-pagehead-actions">{actions}</div>}
    </header>
  );
}

export function Section({
  title,
  hint,
  step,
  locked,
  children,
}: {
  title: string;
  hint?: ReactNode;
  /** Optional step number shown as a badge, for multi-part forms. */
  step?: number;
  locked?: boolean;
  children: ReactNode;
}) {
  return (
    <section className={`fs-card fs-section${locked ? ' fs-section--locked' : ''}`}>
      <header className="fs-section-head">
        <h2>
          {step !== undefined && <span className="fs-step">{step}</span>}
          {title}
        </h2>
        {hint && <p>{hint}</p>}
      </header>
      {children}
    </section>
  );
}

export function ActionBar({ status, children }: { status?: ReactNode; children: ReactNode }) {
  return (
    <div className="fs-savebar">
      <span>{status}</span>
      <div className="fs-savebar-actions">{children}</div>
    </div>
  );
}

export type Tone = 'neutral' | 'info' | 'ok' | 'warn' | 'bad';

export function StatusPill({ tone, children }: { tone: Tone; children: ReactNode }) {
  return <span className={`fs-tag fs-tag--${tone}`}>{children}</span>;
}
