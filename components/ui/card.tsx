import type { ComponentProps, ReactNode } from 'react';

import { cn } from '@/lib/utils/cn';

export function Card({ className, ...props }: ComponentProps<'div'>) {
  return (
    <div
      className={cn(
        // The reference's panel, exactly: `rounded-lg border border-slate-200
        // bg-white shadow-xs`. A flat, bordered white surface — dense figures
        // are easiest to read on plain white, which is why the reference keeps
        // its gradients on the chrome and its banners and never on a panel.
        'border-border bg-surface rounded-lg border shadow-xs',
        // Padding follows the reference's filter and list cards: `p-4`,
        // opening slightly on a wider screen.
        'p-4 sm:p-5',
        // `min-w-0` matters here. A grid or flex item defaults to
        // `min-width: auto`, so its min-content width can force the track
        // wider than the viewport. Without this, one long unbreakable string
        // inside a card scrolls the entire page sideways on a 320px phone.
        'min-w-0',
        className,
      )}
      {...props}
    />
  );
}

export interface CardHeaderProps {
  readonly title: string;
  readonly description?: ReactNode;
  readonly action?: ReactNode;
  /**
   * Heading level. Defaults to `h2`. Pass the level that fits the page's
   * outline — skipping levels makes the document hard to navigate with a
   * screen reader.
   */
  readonly as?: 'h2' | 'h3' | 'h4';
}

export function CardHeader({
  title,
  description,
  action,
  as: Heading = 'h2',
}: CardHeaderProps) {
  return (
    <div className="mb-3 flex items-start justify-between gap-3">
      {/* min-w-0 lets the text wrap instead of pushing the action off the edge
          on a narrow screen. The heading wraps rather than truncating: an
          ellipsis hides information, and two lines on a small phone is the
          better trade. */}
      <div className="min-w-0">
        {/* The reference's list-row heading: `text-[15px] font-bold
            text-slate-900`, with a 12px muted line under it. */}
        <Heading className="t-card-title text-text break-words">{title}</Heading>
        {description !== undefined ? (
          <p className="text-text-muted mt-0.5 text-xs leading-snug">{description}</p>
        ) : null}
      </div>
      {action !== undefined ? <div className="shrink-0">{action}</div> : null}
    </div>
  );
}
