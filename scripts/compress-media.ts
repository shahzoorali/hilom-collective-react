/**
 * One-off backfill: re-compress the heavy images already in the media library.
 *
 *   npx tsx scripts/compress-media.ts                 # dry run, writes nothing
 *   npx tsx scripts/compress-media.ts --apply         # do it
 *   npx tsx scripts/compress-media.ts --min-kb 500    # widen the net
 *   npx tsx scripts/compress-media.ts --apply --id <uuid>   # one asset
 *
 * New uploads are compressed in the browser (frontend/src/lib/image-compress.ts).
 * This handles the ones uploaded before that existed — mostly facilitator
 * photos straight off a phone, and photos saved as PNG.
 *
 * ## Why the S3 key is reused
 *
 * A media URL is referenced from page and post blocks, event rows and
 * `facilitators.photo_url` as a plain string. There is no join table to
 * rewrite, so writing a new key would mean finding and updating every one of
 * those references, and missing one would break an image on the live site.
 * Overwriting the same key keeps every existing reference correct, and the
 * only cost is that the extension in the key may now disagree with the
 * content. Browsers and CloudFront go by the `Content-Type` header, which is
 * set correctly, so the mismatch is cosmetic.
 *
 * ## Reversibility
 *
 * Overwriting an object in place destroys the original, so `--apply` copies
 * each original to `media-originals/<key>` in the same bucket first and
 * refuses to proceed if that copy fails. Nothing here is a one-way door
 * afterwards: `--restore` puts every backed-up original back.
 *
 * Animated GIFs are skipped — re-encoding one keeps a single frame.
 *
 * Needs AWS credentials for ap-southeast-1 and `psql` on PATH; the connection
 * string comes from the `hilom/supabase` secret, same as the Lambdas.
 */
import {
  S3Client,
  GetObjectCommand,
  PutObjectCommand,
  CopyObjectCommand,
  HeadObjectCommand,
} from '@aws-sdk/client-s3';
import { CloudFrontClient, CreateInvalidationCommand } from '@aws-sdk/client-cloudfront';
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import sharp from 'sharp';

const run = promisify(execFile);

/** psql field separator. A control character cannot occur in a filename or URL. */
const SEP = String.fromCharCode(1);
const NEWLINE = String.fromCharCode(10);

const REGION = 'ap-southeast-1';
const BUCKET = 'hilombackendstack-mediabucketbcbb02ba-tw1ga526rpxa';
const DISTRIBUTION_ID = 'EZ04TRVPUG2XO';
const BACKUP_PREFIX = 'media-originals/';

const MAX_DIMENSION = 2400;
const QUALITY = 82;
/** Below this the round trip is not worth it — matches the browser-side skip. */
const DEFAULT_MIN_KB = 300;
/** Keep the re-encode only if it saves at least this much; see the note below. */
const MIN_GAIN = 0.1;

const argv = process.argv.slice(2);
const has = (flag: string) => argv.includes(flag);
const valueOf = (flag: string): string | undefined => {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : undefined;
};

const APPLY = has('--apply');
const RESTORE = has('--restore');
const ONLY_ID = valueOf('--id');
const MIN_BYTES = Number(valueOf('--min-kb') ?? DEFAULT_MIN_KB) * 1024;

const s3 = new S3Client({ region: REGION });
const cloudfront = new CloudFrontClient({ region: 'us-east-1' });

interface Asset {
  id: string;
  key: string;
  url: string;
  filename: string;
  content_type: string;
  bytes: number | null;
  width: number | null;
  height: number | null;
}

const fmt = (b: number) => (b >= 1048576 ? `${(b / 1048576).toFixed(1)} MB` : `${Math.round(b / 1024)} KB`);
const pad = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s.padEnd(n));

let cachedDbUrl: string | null = null;

async function dbUrl(): Promise<string> {
  if (cachedDbUrl) return cachedDbUrl;
  const secrets = new SecretsManagerClient({ region: REGION });
  const res = await secrets.send(new GetSecretValueCommand({ SecretId: 'hilom/supabase' }));
  const parsed = JSON.parse(res.SecretString ?? '{}') as { dbUrl?: string };
  if (!parsed.dbUrl) throw new Error('hilom/supabase is missing dbUrl');
  cachedDbUrl = parsed.dbUrl;
  return cachedDbUrl;
}

/**
 * Runs one statement through psql.
 *
 * psql rather than a Postgres driver because the pooler host is the only route
 * that resolves from here (the direct db.<ref> host is IPv6-only), and psql is
 * already the tool used for every other migration and one-off in this repo.
 */
async function sql(statement: string): Promise<string> {
  const { stdout } = await run('psql', [await dbUrl(), `-tAF${SEP}`, '--no-psqlrc', '-v', 'ON_ERROR_STOP=1', '-c', statement], {
    maxBuffer: 32 * 1024 * 1024,
  });
  return stdout;
}

/** Single-quoted SQL literal. Only ever wraps ids and content types from our own rows. */
const lit = (v: string) => `'${v.replace(/'/g, "''")}'`;

async function loadAssets(where: string): Promise<Asset[]> {
  const out = await sql(
    `select id, key, url, filename, content_type, coalesce(bytes,0), coalesce(width,0), coalesce(height,0)
     from media_assets where ${where} order by bytes desc nulls last`,
  );
  return out
    .split(NEWLINE)
    .filter((line) => line.trim())
    .map((line) => {
      const [id, key, url, filename, content_type, bytes, width, height] = line.split(SEP);
      return {
        id,
        key,
        url,
        filename,
        content_type,
        bytes: Number(bytes),
        width: Number(width) || null,
        height: Number(height) || null,
      };
    });
}

async function body(key: string): Promise<Buffer> {
  const res = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }));
  return Buffer.from(await res.Body!.transformToByteArray());
}

async function main() {
  if (RESTORE) return restore();

  const data = await loadAssets(ONLY_ID ? `id = ${lit(ONLY_ID)}` : 'true');

  const candidates = data.filter(
    (a) => a.key && (a.bytes ?? 0) >= MIN_BYTES && a.content_type !== 'image/gif',
  );
  const skippedGifs = data.filter((a) => a.content_type === 'image/gif' && (a.bytes ?? 0) >= MIN_BYTES);

  console.log(
    `${APPLY ? 'APPLYING' : 'DRY RUN'} — ${candidates.length} asset(s) at or over ${fmt(MIN_BYTES)}` +
      (skippedGifs.length ? `, ${skippedGifs.length} animated GIF(s) skipped` : ''),
  );
  console.log(`Target: WebP q${QUALITY}, longest edge ${MAX_DIMENSION}px, same S3 key\n`);

  if (candidates.length === 0) {
    console.log('Nothing to do.');
    return;
  }

  console.log(`${pad('FILE', 42)} ${pad('BEFORE', 10)} ${pad('AFTER', 10)} SAVING`);
  console.log('-'.repeat(84));

  let before = 0;
  let after = 0;
  let changed = 0;
  const invalidate: string[] = [];

  for (const asset of candidates) {
    let original: Buffer;
    try {
      original = await body(asset.key);
    } catch {
      console.log(`${pad(asset.filename, 42)} ${pad(fmt(asset.bytes ?? 0), 10)} — object missing in S3`);
      continue;
    }

    const image = sharp(original, { failOn: 'none' });
    const meta = await image.metadata();
    // `rotate()` with no argument bakes in the EXIF orientation, which is lost
    // on re-encode — without it, portrait phone photos come back sideways.
    const output = await image
      .rotate()
      .resize({
        width: MAX_DIMENSION,
        height: MAX_DIMENSION,
        fit: 'inside',
        withoutEnlargement: true,
      })
      .webp({ quality: QUALITY })
      .toBuffer({ resolveWithObject: true });

    const originalBytes = original.byteLength;
    const newBytes = output.info.size;
    before += originalBytes;

    // A file that barely shrinks is not worth overwriting a production object
    // and busting its CDN cache for.
    if (newBytes >= originalBytes * (1 - MIN_GAIN)) {
      after += originalBytes;
      console.log(`${pad(asset.filename, 42)} ${pad(fmt(originalBytes), 10)} ${pad('—', 10)} skipped (no real gain)`);
      continue;
    }

    after += newBytes;
    changed++;
    const pct = Math.round((1 - newBytes / originalBytes) * 100);
    console.log(
      `${pad(asset.filename, 42)} ${pad(fmt(originalBytes), 10)} ${pad(fmt(newBytes), 10)} ${pct}% smaller` +
        (meta.width ? `  (${meta.width}×${meta.height} → ${output.info.width}×${output.info.height})` : ''),
    );

    if (!APPLY) continue;

    // Back up before overwriting. A failure here must stop this asset, not be
    // logged and pushed past — the original is otherwise unrecoverable.
    //
    // Guarded so a second --apply cannot overwrite a pristine backup with an
    // already-compressed object, which would quietly turn --restore into a
    // no-op that looks like it worked.
    const backupKey = `${BACKUP_PREFIX}${asset.key}`;
    const alreadyBacked = await s3
      .send(new HeadObjectCommand({ Bucket: BUCKET, Key: backupKey }))
      .then(() => true)
      .catch(() => false);
    if (!alreadyBacked) {
      await s3.send(
        new CopyObjectCommand({
          Bucket: BUCKET,
          CopySource: encodeURI(`${BUCKET}/${asset.key}`),
          Key: backupKey,
          MetadataDirective: 'COPY',
        }),
      );
    }

    await s3.send(
      new PutObjectCommand({
        Bucket: BUCKET,
        Key: asset.key,
        Body: output.data,
        ContentType: 'image/webp',
        CacheControl: 'public, max-age=31536000, immutable',
      }),
    );

    await sql(
      `update media_assets set content_type = 'image/webp', bytes = ${newBytes},
       width = ${output.info.width}, height = ${output.info.height} where id = ${lit(asset.id)}`,
    );

    invalidate.push(`/${asset.key}`);
  }

  console.log('-'.repeat(84));
  console.log(`Total: ${fmt(before)} → ${fmt(after)} (${Math.round((1 - after / before) * 100)}% smaller), ${changed} file(s)`);

  if (!APPLY) {
    console.log('\nDry run — nothing was written. Re-run with --apply to do it.');
    return;
  }

  if (invalidate.length) {
    // The objects are cached at the edge under the same paths, so without this
    // the old heavy versions keep being served until the TTL expires.
    const res = await cloudfront.send(
      new CreateInvalidationCommand({
        DistributionId: DISTRIBUTION_ID,
        InvalidationBatch: {
          CallerReference: `compress-media-${Date.now()}`,
          Paths: { Quantity: invalidate.length, Items: invalidate },
        },
      }),
    );
    console.log(`\nCloudFront invalidation ${res.Invalidation?.Id} created for ${invalidate.length} path(s).`);
  }
  console.log(`Originals kept at s3://${BUCKET}/${BACKUP_PREFIX} — re-run with --restore to undo.`);
}

/** Puts every backed-up original back, and restores its row. */
async function restore() {
  const data = await loadAssets(ONLY_ID ? `id = ${lit(ONLY_ID)}` : 'true');

  const paths: string[] = [];
  for (const asset of data) {
    const backupKey = `${BACKUP_PREFIX}${asset.key}`;
    let head;
    try {
      head = await s3.send(new HeadObjectCommand({ Bucket: BUCKET, Key: backupKey }));
    } catch {
      continue; // never compressed
    }

    if (!APPLY) {
      console.log(`would restore ${asset.filename} (${fmt(head.ContentLength ?? 0)})`);
      continue;
    }

    const original = await body(backupKey);
    const meta = await sharp(original, { failOn: 'none' }).metadata();
    await s3.send(
      new PutObjectCommand({
        Bucket: BUCKET,
        Key: asset.key,
        Body: original,
        ContentType: head.ContentType ?? 'application/octet-stream',
        CacheControl: 'public, max-age=31536000, immutable',
      }),
    );
    await sql(
      `update media_assets set content_type = ${lit(head.ContentType ?? asset.content_type)},
       bytes = ${original.byteLength}, width = ${meta.width ?? 'null'}, height = ${meta.height ?? 'null'}
       where id = ${lit(asset.id)}`,
    );
    paths.push(`/${asset.key}`);
    console.log(`restored ${asset.filename}`);
  }

  if (APPLY && paths.length) {
    await cloudfront.send(
      new CreateInvalidationCommand({
        DistributionId: DISTRIBUTION_ID,
        InvalidationBatch: {
          CallerReference: `compress-media-restore-${Date.now()}`,
          Paths: { Quantity: paths.length, Items: paths },
        },
      }),
    );
    console.log(`\nRestored ${paths.length} file(s) and invalidated the CDN.`);
  } else if (!APPLY) {
    console.log('\nDry run — add --apply to actually restore.');
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
