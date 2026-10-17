/**
 * The receipt's binary assets, embedded in the Lambda bundle by esbuild's
 * `binary` loader (infra/lib/hilom-shared.ts). Logo, watermark and signature
 * were lifted from the original Canva receipt; Montserrat is OFL (see
 * assets/fonts/README.md).
 */
import regular from '../assets/fonts/Montserrat-Regular.ttf';
import bold from '../assets/fonts/Montserrat-Bold.ttf';
import italic from '../assets/fonts/Montserrat-Italic.ttf';
import logo from '../assets/receipt/logo.png';
import watermark from '../assets/receipt/watermark.png';
import signature from '../assets/receipt/signature.png';
import type { ReceiptAssets } from './acknowledgment-receipt.js';

export const receiptAssets: ReceiptAssets = { regular, bold, italic, logo, watermark, signature };
