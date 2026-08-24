/**
 * `/account/registrations/:registrationId/receipts/:chargeId` — a receipt.
 *
 * No PDF library. This is a page styled to print cleanly and a browser print
 * button — the `@media print` block in index.css hides the site chrome and
 * the shell's own tabs, leaving just the receipt. Nobody is going to style a
 * downloadable PDF twice for a document this simple, and every browser
 * already has a perfectly good "print to PDF" built in.
 */
import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { money } from '../../components/Layout';
import { getReceipt, formatDueDate, type Receipt as ReceiptData } from '../../lib/registrations';

export default function Receipt() {
  const { registrationId, chargeId } = useParams<{ registrationId: string; chargeId: string }>();
  const [receipt, setReceipt] = useState<ReceiptData | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!registrationId || !chargeId) return;
    getReceipt(registrationId, chargeId)
      .then(setReceipt)
      .catch((err: Error) => setError(err.message));
  }, [registrationId, chargeId]);

  if (error) return <div className="alert alert-error">{error}</div>;
  if (!receipt) return <div className="spinner" aria-label="Loading" />;

  return (
    <div className="print-area">
      <div className="panel" style={{ maxWidth: 480, margin: '0 auto' }}>
        <div style={{ textAlign: 'center', marginBottom: 20 }}>
          <strong style={{ fontSize: '1.1em' }}>Hilom Collective</strong>
          <br />
          <span className="small muted">kumusta@hilomcollective.com</span>
        </div>

        <h2 style={{ textAlign: 'center', marginTop: 0 }}>Receipt</h2>
        {receipt.receiptNo && (
          <p className="small muted" style={{ textAlign: 'center', marginTop: -8 }}>
            {receipt.receiptNo}
          </p>
        )}

        <table style={{ width: '100%', marginTop: 20 }}>
          <tbody>
            <Row label="Paid by" value={receipt.registrantName} />
            <Row label="Email" value={receipt.buyerEmail} />
            {receipt.event && <Row label="Event" value={receipt.event.title} />}
            <Row label="For" value={receipt.label} />
            {receipt.paidAt && <Row label="Paid on" value={formatDueDate(receipt.paidAt)} />}
            {receipt.paidMethod && <Row label="Method" value={receipt.paidMethod} />}
            <Row label="Amount" value={money(receipt.amountCentavos, receipt.currency)} strong />
          </tbody>
        </table>

        <p className="small muted" style={{ textAlign: 'center', marginTop: 24 }}>
          Thank you.
        </p>
      </div>

      <div style={{ textAlign: 'center', marginTop: 16 }} className="no-print">
        <button type="button" className="btn btn-accent" onClick={() => window.print()}>
          Print or save as PDF
        </button>
      </div>
    </div>
  );
}

function Row({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <tr>
      <td className="small muted" style={{ padding: '4px 0' }}>
        {label}
      </td>
      <td style={{ padding: '4px 0', textAlign: 'right', fontWeight: strong ? 700 : undefined }}>{value}</td>
    </tr>
  );
}
