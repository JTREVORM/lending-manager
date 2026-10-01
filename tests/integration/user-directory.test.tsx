import { render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { UserDirectory } from '@/components/users/user-directory';
import { UserStatusBadge } from '@/components/users/user-status-badge';
import type { DirectoryUser } from '@/lib/data/users';

/**
 * The staff directory.
 *
 * Browser-level layout verification of the authenticated screens needs a live
 * Supabase instance, which this environment cannot run. These assertions cover
 * what can be checked without one: the structural choices that keep the screen
 * usable on a phone, and the accessibility wiring of its controls.
 */
vi.mock('next/navigation', () => ({
  usePathname: () => '/users',
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));

const USERS: readonly DirectoryUser[] = [
  {
    id: '0f8fad5b-d9cb-469f-a165-70867728950e',
    fullName: 'Aisha Nakato',
    phone: '+256772123456',
    email: 'aisha@example.com',
    status: 'active',
    roles: ['manager'],
    mustChangePassword: false,
    lastSignInAt: '2026-10-01T06:30:00Z',
    createdAt: '2026-09-01T06:30:00Z',
    hasLogin: true,
  },
  {
    id: '1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d',
    fullName: 'Joseph Okello',
    phone: '+256772123457',
    email: null,
    status: 'suspended',
    roles: ['secretary_treasurer'],
    mustChangePassword: true,
    lastSignInAt: null,
    createdAt: '2026-09-02T06:30:00Z',
    hasLogin: true,
  },
];

const FILTER = { search: '', role: 'all', status: 'all' };

describe('UserDirectory layout', () => {
  it('renders a card list for phones and a table for wider screens', () => {
    // A table at 320px either scrolls sideways or crushes its columns, so the
    // same data is rendered twice and CSS picks one. Asserting both exist is
    // what stops a later change dropping the phone layout silently.
    const { container } = render(<UserDirectory users={USERS} filter={FILTER} />);

    const cardList = container.querySelector('ul.md\\:hidden');
    expect(cardList, 'phone card list').not.toBeNull();

    const tableWrapper = container.querySelector('div.hidden.md\\:block');
    expect(tableWrapper, 'table shown from md up').not.toBeNull();
    expect(within(tableWrapper as HTMLElement).getByRole('table')).toBeInTheDocument();
  });

  it('gives the table a caption, so its purpose is announced', () => {
    render(<UserDirectory users={USERS} filter={FILTER} />);
    expect(screen.getByRole('table')).toHaveAccessibleName('Staff and client accounts');
  });

  it('uses a row header for each person, so a screen reader can orient', () => {
    render(<UserDirectory users={USERS} filter={FILTER} />);

    const rowHeaders = screen.getAllByRole('rowheader');
    expect(rowHeaders).toHaveLength(USERS.length);
  });

  it('labels every filter control', () => {
    render(<UserDirectory users={USERS} filter={FILTER} />);

    expect(screen.getByLabelText('Search')).toBeInTheDocument();
    expect(screen.getByLabelText('Role')).toBeInTheDocument();
    expect(screen.getByLabelText('Status')).toBeInTheDocument();
  });

  it('keeps every filter control a usable touch target', () => {
    render(<UserDirectory users={USERS} filter={FILTER} />);

    for (const label of ['Search', 'Role', 'Status']) {
      expect(screen.getByLabelText(label).className, label).toContain('min-h-touch');
    }
  });

  it('announces the result count politely rather than interrupting', () => {
    render(<UserDirectory users={USERS} filter={FILTER} />);

    const status = screen.getByText('2 users');
    expect(status).toHaveAttribute('aria-live', 'polite');
  });

  it('says so plainly when nothing matches', () => {
    render(<UserDirectory users={[]} filter={FILTER} />);
    expect(screen.getByText('No users match these filters.')).toBeInTheDocument();
  });

  it('flags an account still holding a temporary password', () => {
    // An administrator needs to see at a glance which accounts are still
    // reachable with a password they themselves issued.
    render(<UserDirectory users={USERS} filter={FILTER} />);
    expect(screen.getAllByText('Temporary password').length).toBeGreaterThan(0);
  });

  it('links each person to their record from both layouts', () => {
    render(<UserDirectory users={USERS} filter={FILTER} />);

    const links = screen
      .getAllByRole('link')
      .filter((link) => link.getAttribute('href') === `/users/${USERS[0]!.id}`);

    // One in the card list, one in the table.
    expect(links).toHaveLength(2);
  });
});

describe('UserStatusBadge', () => {
  it('states the status in words, not only in colour', () => {
    // Works for a colour-blind reader and in a printout.
    for (const [status, label] of [
      ['active', 'Active'],
      ['inactive', 'Inactive'],
      ['suspended', 'Suspended'],
      ['archived', 'Archived'],
    ] as const) {
      const { unmount } = render(<UserStatusBadge status={status} />);
      expect(screen.getByText(label)).toBeInTheDocument();
      unmount();
    }
  });
});
