import { BUSINESS_TIMEZONE, DEFAULT_LOCALE } from '@/config/app';
import {
  formatBusinessDate,
  formatInstant,
  isBusinessDate,
  type BusinessDate,
} from '@/lib/domain/datetime';
import { formatUgandanPhoneInternational, isUgandanPhone } from '@/lib/domain/phone';
import { cn } from '@/lib/utils/cn';

/**
 * Dates, times and phone numbers, rendered one way across the whole system.
 *
 * The pre-Phase-9 review found the same value written two ways depending on
 * which screen you were on: `077 211 0015` on the client list and
 * `+256772110015` on the overdue page, for the same borrower. Two formats for
 * one fact makes a reader check twice, and on a collections round that is a
 * phone call to the wrong person.
 *
 * So there is one phone format (international, grouped) and one date format
 * (`4 Oct 2026`), and both live here rather than being chosen per page.
 */

// ---------------------------------------------------------------------------
// Dates
// ---------------------------------------------------------------------------

export interface DateValueProps {
  /** A calendar date (`YYYY-MM-DD`) or a stored instant. */
  readonly value: BusinessDate | string | Date | null | undefined;
  /**
   * `'date'` → `4 Oct 2026`
   * `'datetime'` → `4 Oct 2026, 14:32`, in the business timezone
   */
  readonly variant?: 'date' | 'datetime';
  readonly locale?: string;
  readonly timeZone?: string;
  readonly placeholder?: string;
  readonly className?: string;
}

/**
 * Render a date the one way this application writes dates.
 *
 * Wrapped in `<time>` with a machine-readable `dateTime`, so a screen reader
 * and a scraper both get the unambiguous value while the human reads
 * `4 Oct 2026`. `whitespace-nowrap` for the same reason money carries it: a
 * date broken across two lines in a narrow column is harder to scan than a
 * column that widens.
 */
export function DateValue({
  value,
  variant = 'date',
  locale = DEFAULT_LOCALE,
  timeZone = BUSINESS_TIMEZONE,
  placeholder = '—',
  className,
}: DateValueProps) {
  if (value === null || value === undefined || value === '') {
    return <span className={cn('text-text-muted', className)}>{placeholder}</span>;
  }

  if (variant === 'date' && typeof value === 'string' && isBusinessDate(value)) {
    return (
      <time
        dateTime={value}
        className={cn('whitespace-nowrap', className)}
        data-date-value=""
      >
        {formatBusinessDate(value, { locale })}
      </time>
    );
  }

  const instant = typeof value === 'string' ? new Date(value) : value;

  if (!(instant instanceof Date) || Number.isNaN(instant.getTime())) {
    return <span className={cn('text-text-muted', className)}>{placeholder}</span>;
  }

  return (
    <time
      dateTime={instant.toISOString()}
      className={cn('whitespace-nowrap', className)}
      data-date-value=""
    >
      {formatInstant(instant, {
        locale,
        timeZone,
        withTime: variant === 'datetime',
      })}
    </time>
  );
}

// ---------------------------------------------------------------------------
// Phone numbers
// ---------------------------------------------------------------------------

export interface PhoneValueProps {
  /** Canonical E.164, as every phone column stores it. */
  readonly value: string | null | undefined;
  /**
   * Render as a `tel:` link. Staff ring late borrowers from this screen, and
   * on the phone they are holding that is one tap instead of nine digits
   * copied by eye.
   */
  readonly linked?: boolean;
  readonly placeholder?: string;
  readonly className?: string;
}

/**
 * Render a Ugandan phone number as `+256 772 123 456`.
 *
 * International rather than local (`0772 123 456`): the stored value is
 * E.164, the business sends Mobile Money to these numbers, and one format
 * that matches what is stored removes a translation step every time somebody
 * compares a screen against a record.
 *
 * A value that is not a Ugandan number is printed as it stands rather than
 * mangled — the formatter is a display helper, not a validator, and the
 * validation that matters already ran before the value was stored.
 */
export function PhoneValue({
  value,
  linked = false,
  placeholder = '—',
  className,
}: PhoneValueProps) {
  if (value === null || value === undefined || value === '') {
    return <span className={cn('text-text-muted', className)}>{placeholder}</span>;
  }

  const display = isUgandanPhone(value) ? formatUgandanPhoneInternational(value) : value;
  const classes = cn('whitespace-nowrap tabular', className);

  if (!linked) {
    return (
      <span className={classes} data-phone-value="">
        {display}
      </span>
    );
  }

  return (
    <a
      href={`tel:${value}`}
      className={cn(classes, 'hover:text-brand-700 underline-offset-2 hover:underline')}
      data-phone-value=""
    >
      {display}
    </a>
  );
}
