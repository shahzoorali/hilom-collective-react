/**
 * The participant agreement PDF that rides along on a retreat confirmation.
 *
 * One document, one gate: `PARTICIPANT_AGREEMENT_EVENT_IDS` lists the event
 * ids whose `sendRegistrationConfirmed` email carries it. Nothing is attached
 * for an event that is not on that list, so a course purchase never receives a
 * retreat waiver by accident.
 *
 * The bytes are pulled into the bundle at build time by the esbuild `binary`
 * loader (infra/lib/hilom-shared.ts) — see types/asset-modules.d.ts.
 */
import agreementPdf from '../assets/return-to-self-participant-agreement.pdf';

/** ASCII only — it becomes a MIME filename param. See lib/mime.ts. */
export const AGREEMENT_PDF_FILENAME = 'Return to Self - Participant Agreement.pdf';

const AGREEMENT_EVENT_IDS = new Set(
  (process.env.PARTICIPANT_AGREEMENT_EVENT_IDS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
);

/** The PDF bytes for an event that should get them, or null. */
export function agreementPdfForEvent(eventId: string): Uint8Array | null {
  return AGREEMENT_EVENT_IDS.has(eventId) ? agreementPdf : null;
}
