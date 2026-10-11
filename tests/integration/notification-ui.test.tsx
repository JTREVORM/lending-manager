import { render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { NotificationBadge } from '@/components/notifications/notification-badge';
import { NotificationList } from '@/components/notifications/notification-list';
import type { NotificationRow } from '@/lib/data/notifications';

/**
 * The Phase 15 screens.
 *
 * Four claims worth checking without a database, because each is a promise the
 * schema cannot keep on its own:
 *
 *   * the bell says its state in words, not only in colour;
 *   * a read notification stays on the list rather than disappearing;
 *   * "mark all read" offers to clear the bell, not the page;
 *   * the empty state explains why a loan becoming late is not in here.
 */
vi.mock('next/navigation', () => ({
  usePathname: () => '/notifications',
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock('@/lib/notifications/actions', () => ({
  markNotificationsReadAction: vi.fn(),
}));

const LOAN_ID = '0f8fad5b-d9cb-469f-a165-70867728950e';

function row(overrides: Partial<NotificationRow> = {}): NotificationRow {
  return {
    id: '1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d',
    category: 'loan_awaiting_approval',
    severity: 'attention',
    title: 'LN260036 is awaiting approval',
    body: 'Nakato Joan — Business Loan, UGX 2,000,000. Submitted for a decision.',
    entityType: 'loan',
    entityId: LOAN_ID,
    actorLabel: 'Nakato Winnie Birungi',
    occurredAt: '2026-10-11T08:30:00Z',
    isPersonal: false,
    isRead: false,
    readAt: null,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
describe('the bell', () => {
  it('says its state in words, not only in colour', () => {
    render(<NotificationBadge unread={3} unreadUrgent={1} />);

    // One in twelve men cannot tell the two badge colours apart, and nobody
    // can in sunlight. The count and the urgency are in the accessible name.
    expect(
      screen.getByRole('link', { name: /Notifications, 3 unread, 1 urgent/i }),
    ).toBeInTheDocument();
  });

  it('drops the urgency clause when nothing is urgent', () => {
    render(<NotificationBadge unread={2} unreadUrgent={0} />);

    expect(
      screen.getByRole('link', { name: 'Notifications, 2 unread' }),
    ).toBeInTheDocument();
  });

  it('shows no badge at all when there is nothing', () => {
    render(<NotificationBadge unread={0} unreadUrgent={0} />);

    const link = screen.getByRole('link', { name: 'Notifications, none unread' });
    expect(link).toBeInTheDocument();
    expect(link.textContent).toBe('Notifications, none unread');
  });

  it('caps the badge rather than letting it overflow the icon', () => {
    render(<NotificationBadge unread={137} unreadUrgent={0} />);

    expect(screen.getByText('99+')).toBeInTheDocument();
    // And the exact figure is still in the name, for anybody who wants it.
    expect(
      screen.getByRole('link', { name: 'Notifications, 137 unread' }),
    ).toBeInTheDocument();
  });

  it('links to the page rather than opening a panel', () => {
    render(<NotificationBadge unread={1} unreadUrgent={0} />);

    expect(screen.getByRole('link', { name: /Notifications/ })).toHaveAttribute(
      'href',
      '/notifications',
    );
  });
});

// ---------------------------------------------------------------------------
describe('the stream', () => {
  it('offers a chip per group and one for everything', () => {
    render(<NotificationList rows={[row()]} page={1} hasMore={false} unread={1} />);

    const chips = screen.getByRole('navigation', { name: 'Notification groups' });

    expect(within(chips).getByRole('button', { name: 'Everything' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    for (const label of ['Needs a decision', 'Collections', 'Lending', 'Money']) {
      expect(within(chips).getByRole('button', { name: label })).toBeInTheDocument();
    }
  });

  it('names the category, the time and the actor on each row', () => {
    render(<NotificationList rows={[row()]} page={1} hasMore={false} unread={1} />);

    expect(screen.getByText('LN260036 is awaiting approval')).toBeInTheDocument();
    expect(screen.getByText(/Awaiting approval/)).toBeInTheDocument();
    expect(screen.getByText(/Nakato Winnie Birungi/)).toBeInTheDocument();
  });

  it('deep-links to the thing it is about', () => {
    render(<NotificationList rows={[row()]} page={1} hasMore={false} unread={1} />);

    expect(screen.getByRole('link', { name: 'Open it' })).toHaveAttribute(
      'href',
      `/loans/${LOAN_ID}`,
    );
  });

  it('offers no link where there is nothing specific to open', () => {
    render(
      <NotificationList
        rows={[row({ entityType: 'loan', entityId: null })]}
        page={1}
        hasMore={false}
        unread={1}
      />,
    );

    // A dead control is worse than no control.
    expect(screen.queryByRole('link', { name: 'Open it' })).toBeNull();
  });

  it('keeps a read notification on the list, visibly quieter', () => {
    render(
      <NotificationList
        rows={[row({ isRead: true, readAt: '2026-10-11T09:00:00Z' })]}
        page={1}
        hasMore={false}
        unread={0}
      />,
    );

    // Hiding it would mean somebody who cleared the bell on the bus cannot
    // find what they cleared.
    expect(screen.getByText('LN260036 is awaiting approval')).toBeInTheDocument();
    expect(screen.getByText('Read')).toBeInTheDocument();
    // And no per-row control, because there is nothing left to do to it.
    expect(screen.queryByRole('button', { name: 'Mark read' })).toBeNull();
  });

  it('offers to clear the bell rather than the page', () => {
    render(
      <NotificationList
        rows={[row(), row({ id: 'bbbbbbbb-0000-4000-8000-000000000002' })]}
        page={1}
        hasMore
        unread={47}
      />,
    );

    // Two rows on screen, forty-seven unread in total. The control names the
    // total, because it submits no ids and the action reads that as
    // "everything I can see".
    expect(screen.getByRole('button', { name: 'Mark all 47 read' })).toBeInTheDocument();
  });

  it('offers no mark-all control when there is nothing unread', () => {
    render(
      <NotificationList
        rows={[row({ isRead: true })]}
        page={1}
        hasMore={false}
        unread={0}
      />,
    );

    expect(screen.queryByRole('button', { name: /Mark all/ })).toBeNull();
  });

  it('marks a personally addressed notification as such', () => {
    render(
      <NotificationList
        rows={[
          row({
            category: 'loan_decided',
            isPersonal: true,
            title: 'LN260036 was refused',
          }),
        ]}
        page={1}
        hasMore={false}
        unread={1}
      />,
    );

    // "Your application was refused" deserves more attention from the person
    // it names than from the others who can also see it.
    expect(screen.getByText('For you')).toBeInTheDocument();
  });

  it('describes each severity in the badge title rather than only colouring it', () => {
    render(
      <NotificationList
        rows={[row({ severity: 'urgent', category: 'payment_reversed' })]}
        page={1}
        hasMore={false}
        unread={1}
      />,
    );

    expect(screen.getByTitle(/money is unaccounted for/i)).toBeInTheDocument();
  });

  it('explains in the empty state why a loan becoming late is not in here', () => {
    render(<NotificationList rows={[]} page={1} hasMore={false} unread={0} />);

    expect(screen.getByText(/reading of the calendar/i)).toBeInTheDocument();
    expect(screen.getByText(/overdue list already answers it/i)).toBeInTheDocument();
  });

  it('distinguishes an empty filter from an empty stream', () => {
    render(<NotificationList rows={[]} page={1} hasMore={false} unread={0} />);

    // With no filters applied the copy explains the stream; the filtered copy
    // is asserted by the browser suite, which can actually set a filter.
    expect(screen.queryByText(/try clearing the filters/i)).toBeNull();
  });

  it('offers the unread toggle and the severity filter', () => {
    render(<NotificationList rows={[row()]} page={1} hasMore={false} unread={1} />);

    expect(screen.getByLabelText('Severity')).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Show unread only', pressed: false }),
    ).toBeInTheDocument();
  });
});
