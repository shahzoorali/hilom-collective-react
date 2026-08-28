/**
 * Skeleton placeholders for content that is still loading.
 *
 * These stand in for the real layout while a fetch is in flight, so a page
 * settles into its final shape instead of flashing a spinner and then jumping.
 * The rule followed throughout: a skeleton should occupy roughly the space its
 * real content will, using the same card / grid classes, so nothing reflows
 * when the data lands.
 *
 * Accessibility: the shimmer bars themselves are `aria-hidden`. Wrap a loading
 * region in `<SkeletonBoundary>` (or your own `role="status"` element) so a
 * screen reader hears "Loading …" once rather than nothing.
 */
import type { CSSProperties, ReactNode } from 'react';

type Size = number | string;

const toCss = (v: Size | undefined): string | undefined =>
  typeof v === 'number' ? `${v}px` : v;

/** One shimmer bar. Everything else here composes this. */
export function Skeleton({
  width,
  height = '1em',
  radius = 6,
  circle = false,
  className,
  style,
}: {
  width?: Size;
  height?: Size;
  radius?: Size;
  circle?: boolean;
  className?: string;
  style?: CSSProperties;
}) {
  return (
    <span
      aria-hidden="true"
      className={`skeleton${className ? ` ${className}` : ''}`}
      style={{
        width: toCss(width) ?? '100%',
        height: toCss(height),
        borderRadius: circle ? '50%' : toCss(radius),
        ...style,
      }}
    />
  );
}

/**
 * A media placeholder sized by aspect ratio (image / cover / hero slot).
 *
 * Kept separate from `Skeleton` because `aspect-ratio` only drives height when
 * the height is `auto`; the base bar sets an explicit `min-height` for text,
 * which would otherwise collapse this to a sliver.
 */
export function SkeletonMedia({
  ratio = '16 / 9',
  radius = 8,
  style,
}: {
  ratio?: string;
  radius?: Size;
  style?: CSSProperties;
}) {
  return (
    <Skeleton
      height="auto"
      radius={radius}
      style={{ aspectRatio: ratio, minHeight: 0, ...style }}
    />
  );
}

/**
 * A block of text lines. The last line is shortened so the block reads as a
 * paragraph rather than a solid rectangle.
 */
export function SkeletonText({
  lines = 3,
  lastLineWidth = '60%',
  gap = 8,
  lineHeight = '0.8em',
  style,
}: {
  lines?: number;
  lastLineWidth?: Size;
  gap?: number;
  lineHeight?: Size;
  style?: CSSProperties;
}) {
  return (
    <span style={{ display: 'flex', flexDirection: 'column', gap, ...style }}>
      {Array.from({ length: lines }, (_, i) => (
        <Skeleton
          key={i}
          height={lineHeight}
          width={i === lines - 1 && lines > 1 ? lastLineWidth : '100%'}
        />
      ))}
    </span>
  );
}

/**
 * A stand-in for one `.card`: media strip, heading, a few text lines, and a
 * button. `media` off is for cards with no image (course/product blocks on
 * some pages).
 */
export function SkeletonCard({ media = true, lines = 2 }: { media?: boolean; lines?: number }) {
  return (
    <div className="card" aria-hidden="true" style={{ gap: '0.75rem' }}>
      {media && <SkeletonMedia />}
      <Skeleton height="1.4em" width="70%" />
      <SkeletonText lines={lines} />
      <Skeleton height="2.4em" width="9rem" radius={999} style={{ marginTop: '0.4rem' }} />
    </div>
  );
}

/** A `.grid` of {count} card skeletons — the shape most listing pages load into. */
export function SkeletonCardGrid({
  count = 6,
  media = true,
  className = 'grid',
  style,
}: {
  count?: number;
  media?: boolean;
  className?: string;
  style?: CSSProperties;
}) {
  return (
    <SkeletonBoundary label="Loading" className={className} style={{ marginTop: '1.5rem', ...style }}>
      {Array.from({ length: count }, (_, i) => (
        <SkeletonCard key={i} media={media} />
      ))}
    </SkeletonBoundary>
  );
}

/**
 * Wraps a loading region: announces itself once to assistive tech and hides
 * the placeholder bars inside from it. Use directly when the shape does not
 * match `SkeletonCardGrid`.
 */
export function SkeletonBoundary({
  label = 'Loading',
  className,
  style,
  children,
}: {
  label?: string;
  className?: string;
  style?: CSSProperties;
  children: ReactNode;
}) {
  return (
    <div role="status" aria-live="polite" className={className} style={style}>
      <span className="sr-only">{label}…</span>
      {children}
    </div>
  );
}
