"use client";

import type { LucideIcon } from "lucide-react";

/**
 * Icon-bearing empty state with a clear, helpful message. Presentational only.
 * Pass a Lucide icon component (consistent set / stroke width across the app).
 */
export default function EmptyState({
  icon: Icon,
  title,
  description,
  action,
}: {
  icon: LucideIcon;
  title: string;
  description?: string;
  /** Optional call-to-action node (e.g. a button) rendered under the copy. */
  action?: React.ReactNode;
}) {
  return (
    <div className="tf-emptystate">
      <span className="tf-emptystate__icon">
        <Icon strokeWidth={1.75} aria-hidden="true" />
      </span>
      <p className="tf-emptystate__title">{title}</p>
      {description && <p className="tf-emptystate__desc">{description}</p>}
      {action && <div style={{ marginTop: 16 }}>{action}</div>}
    </div>
  );
}
