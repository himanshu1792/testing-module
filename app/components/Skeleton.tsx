"use client";

/**
 * Shimmer skeleton primitives used while SWR is fetching. Purely presentational
 * — no data, no side effects. Respects prefers-reduced-motion via the CSS in
 * globals.css (the shimmer collapses to a static tone).
 */

/** A single shimmer block. Width/height come in via inline style for layout. */
export function Skeleton({
  width,
  height = 14,
  radius,
  className = "",
  style,
}: {
  width?: number | string;
  height?: number | string;
  radius?: number | string;
  className?: string;
  style?: React.CSSProperties;
}) {
  return (
    <span
      aria-hidden="true"
      className={`tf-skeleton ${className}`}
      style={{
        display: "block",
        width: width ?? "100%",
        height,
        borderRadius: radius,
        ...style,
      }}
    />
  );
}

/**
 * A skeleton stand-in for the ops tables. Renders the table's hairline frame
 * with N shimmer rows so the layout doesn't jump when real data arrives.
 */
export function TableSkeleton({
  columns,
  rows = 4,
}: {
  /** Relative flex weights per column, e.g. [2, 3, 1.5, 1]. */
  columns: number[];
  rows?: number;
}) {
  return (
    <div
      className="tf-table-wrap"
      role="status"
      aria-busy="true"
      aria-label="Loading"
    >
      {Array.from({ length: rows }).map((_, r) => (
        <div className="tf-skel-row" key={r}>
          {columns.map((weight, c) => (
            <div key={c} style={{ flex: `${weight} 1 0` }}>
              <Skeleton
                height={12}
                width={`${Math.min(92, 48 + ((r + c) % 3) * 18)}%`}
              />
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}
