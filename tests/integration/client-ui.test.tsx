import { render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { ClientDirectory } from '@/components/clients/client-directory';
import { ClientForm } from '@/components/clients/client-form';
import { ClientRemarks } from '@/components/clients/client-remarks';
import { ClientStatusBadge } from '@/components/clients/client-status-badge';
import { GuarantorDirectory } from '@/components/guarantors/guarantor-directory';
import { CLIENT_STATUSES } from '@/lib/domain/client';
import type { ClientPage } from '@/lib/data/clients';
import type { ClientRemark } from '@/lib/data/clients';
import type { GuarantorPage } from '@/lib/data/guarantors';

/**
 * The Phase 3 screens.
 *
 * Browser-level layout verification needs a live Supabase instance, which this
 * environment cannot run. These assertions cover what can be checked without
 * one, and they are the parts that break silently:
 *
 *   - the structural choices that keep a screen usable at 320px, where a
 *     grid item's default `min-width: auto` is enough to push a page sideways;
 *   - the accessibility wiring of each control, which is invisible when it is
 *     wrong;
 *   - that untrusted text is rendered as text, which is the actual
 *     cross-site-scripting defence.
 */
vi.mock('next/navigation', () => ({
  usePathname: () => '/clients',
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));

/**
 * The Server Action modules are stubbed out.
 *
 * They are `'use server'` modules that reach the privileged Supabase client
 * and the storage helper, both of which carry `import 'server-only'` and
 * refuse to load in a client-component graph — correctly, since that guard is
 * what keeps the secret key out of the browser bundle.
 *
 * Nothing is lost by stubbing them here. What these tests are about is the
 * markup a form produces: its labels, its groups, its required-state
 * semantics, its escaping. What the actions *do* is tested where it is
 * actually enforced — `tests/db/rls-clients.test.ts` drives every write as a
 * real database role, and `tests/unit/client-validation.test.ts` drives the
 * schemas directly.
 */
vi.mock('@/lib/clients/actions', () => ({
  createClientAndRedirect: vi.fn(),
  createClientAction: vi.fn(),
  updateClientAction: vi.fn(),
  updateClientIdentityAction: vi.fn(),
  changeClientStatusAction: vi.fn(),
  replaceClientDocumentAction: vi.fn(),
  createRemarkAction: vi.fn(),
  retractRemarkAction: vi.fn(),
  linkClientProfileAction: vi.fn(),
}));

vi.mock('@/lib/guarantors/actions', () => ({
  createGuarantorAction: vi.fn(),
  updateGuarantorAction: vi.fn(),
  linkGuarantorAction: vi.fn(),
  detachGuarantorAction: vi.fn(),
}));

const CLIENT_PAGE: ClientPage = {
  clients: [
    {
      id: '0f8fad5b-d9cb-469f-a165-70867728950e',
      clientNumber: 'CL26001',
      fullName: 'Nakato Beatrice',
      phone: '+256771234567',
      villageArea: 'Kalerwe',
      district: 'Kampala',
      status: 'active',
      registeredAt: '2026-09-01T06:30:00Z',
      hasPortalLogin: true,
    },
    {
      id: '1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d',
      clientNumber: 'CL26002',
      fullName: 'Okello Joseph',
      phone: '+256781234567',
      villageArea: 'Bweyogerere',
      district: 'Wakiso',
      status: 'blacklisted',
      registeredAt: '2026-09-05T06:30:00Z',
      hasPortalLogin: false,
    },
  ],
  page: 1,
  hasMore: false,
};

describe('the client directory', () => {
  it('offers a labelled search box and status filter', () => {
    render(<ClientDirectory page={CLIENT_PAGE} filter={{ query: '', status: '' }} />);

    // `getByLabelText` only finds these if the label is genuinely associated,
    // which is the thing worth asserting.
    expect(screen.getByLabelText('Search')).toBeTruthy();
    expect(screen.getByLabelText('Status')).toBeTruthy();
  });

  it('offers every status as a filter', () => {
    render(<ClientDirectory page={CLIENT_PAGE} filter={{ query: '', status: '' }} />);

    const select = screen.getByLabelText('Status');
    const options = within(select).getAllByRole('option');

    // Every status plus the default "active and inactive" view.
    expect(options).toHaveLength(CLIENT_STATUSES.length + 1);
  });

  it('renders both a card list and a table, so neither layout is a scroll', () => {
    const { container } = render(
      <ClientDirectory page={CLIENT_PAGE} filter={{ query: '', status: '' }} />,
    );

    // Cards up to `md`, a table from `md`. A table at 320px either scrolls
    // sideways or crushes its columns, and neither is usable one-handed.
    expect(container.querySelector('ul.md\\:hidden')).toBeTruthy();
    expect(container.querySelector('.hidden.md\\:block')).toBeTruthy();
  });

  it('gives the table a caption for screen readers', () => {
    render(<ClientDirectory page={CLIENT_PAGE} filter={{ query: '', status: '' }} />);

    expect(screen.getByText(/Client directory, newest registration first/)).toBeTruthy();
  });

  it('announces the result count politely rather than silently', () => {
    const { container } = render(
      <ClientDirectory page={CLIENT_PAGE} filter={{ query: '', status: '' }} />,
    );

    const live = container.querySelector('[aria-live="polite"]');
    expect(live).toBeTruthy();
    expect(live?.textContent).toMatch(/2 clients/);
  });

  it('constrains every card and cell against a 320px overflow', () => {
    const { container } = render(
      <ClientDirectory page={CLIENT_PAGE} filter={{ query: '', status: '' }} />,
    );

    // A grid item defaults to `min-width: auto`, so one long unbroken value
    // widens the whole row past the viewport. `min-w-0` plus `truncate` is
    // what prevents it.
    const minWidthZero = container.querySelectorAll('.min-w-0');
    expect(minWidthZero.length).toBeGreaterThan(4);
  });

  it('shows no National Identification Number anywhere', () => {
    const { container } = render(
      <ClientDirectory page={CLIENT_PAGE} filter={{ query: '', status: '' }} />,
    );

    // Not a display decision: the column lives in a different table behind a
    // different policy, so the component has nothing to render even if it
    // tried. This asserts the shape of the data it receives.
    expect(container.textContent).not.toMatch(/C[MF]\d{8}/);
    expect(container.textContent).not.toMatch(/nin/i);
  });

  it('states the status in words, not only in colour', () => {
    render(<ClientDirectory page={CLIENT_PAGE} filter={{ query: '', status: '' }} />);

    // Colour alone fails a colour-blind reader and a printout.
    expect(screen.getAllByText('Active').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Blacklisted').length).toBeGreaterThan(0);
  });

  it('explains an empty result instead of showing a blank page', () => {
    render(
      <ClientDirectory
        page={{ clients: [], page: 1, hasMore: false }}
        filter={{ query: 'zzz', status: '' }}
      />,
    );

    expect(screen.getByText(/No clients match that search/)).toBeTruthy();
    expect(screen.getByText(/Try a shorter search/)).toBeTruthy();
  });

  it('suggests registering the first client when nothing is filtered', () => {
    render(
      <ClientDirectory
        page={{ clients: [], page: 1, hasMore: false }}
        filter={{ query: '', status: '' }}
      />,
    );

    expect(screen.getByText(/Register the first one/)).toBeTruthy();
  });

  it('labels its pagination and disables the unavailable direction', () => {
    render(
      <ClientDirectory
        page={{ ...CLIENT_PAGE, page: 1, hasMore: true }}
        filter={{ query: '', status: '' }}
      />,
    );

    expect(screen.getByRole('navigation', { name: 'Pagination' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Previous' })).toHaveProperty(
      'disabled',
      true,
    );
    expect(screen.getByRole('button', { name: 'Next' })).toHaveProperty(
      'disabled',
      false,
    );
  });

  it('renders a hostile name as text rather than as markup', () => {
    const { container } = render(
      <ClientDirectory
        page={{
          ...CLIENT_PAGE,
          clients: [
            {
              ...CLIENT_PAGE.clients[0]!,
              fullName: '<img src=x onerror="alert(1)">',
              villageArea: '<script>alert(2)</script>',
            },
          ],
        }}
        filter={{ query: '', status: '' }}
      />,
    );

    // React escapes interpolated text. The payload must appear as characters
    // on the page and not as elements in the tree.
    expect(container.querySelector('img[onerror]')).toBeNull();
    expect(container.querySelector('script')).toBeNull();
    expect(container.textContent).toContain('<img src=x onerror="alert(1)">');
  });
});

describe('the client registration form', () => {
  it('groups its fields, each group announced to assistive technology', () => {
    render(<ClientForm canRecordNin canUploadDocuments />);

    // A `fieldset` with a `legend` is what tells a screen reader these
    // controls belong together, so "NIN" is heard as "Identification, NIN".
    for (const group of [
      'Personal information',
      'Identification',
      'Location',
      'Work',
      'Photograph and documents',
      'Notes',
    ]) {
      expect(screen.getByRole('group', { name: group }), group).toBeTruthy();
    }
  });

  it('labels every control', () => {
    render(<ClientForm canRecordNin canUploadDocuments />);

    for (const label of [
      'Full name',
      'Sex',
      'Date of birth',
      'Phone number',
      'Alternative phone',
      'National Identification Number',
      'Village or area',
      'District',
      'Occupation',
      'Business type',
      'Photograph',
      'Identification document',
      'Notes',
    ]) {
      expect(screen.getByLabelText(new RegExp(label)), label).toBeTruthy();
    }
  });

  it('marks required fields in a way that is announced, not only drawn', () => {
    const { container } = render(<ClientForm canRecordNin canUploadDocuments />);

    // An asterisk alone is `aria-hidden`; the screen-reader text is what
    // carries the meaning.
    expect(container.querySelectorAll('.sr-only').length).toBeGreaterThan(3);
    expect(screen.getByLabelText(/Full name/)).toHaveProperty('required', true);
  });

  it('hides the identification section from somebody who may not record one', () => {
    render(<ClientForm canRecordNin={false} canUploadDocuments={false} />);

    // Not merely cosmetic: the policy on `client_identities` would refuse the
    // insert, so offering the field would be offering work that cannot save.
    expect(screen.queryByRole('group', { name: 'Identification' })).toBeNull();
    expect(screen.queryByLabelText(/National Identification Number/)).toBeNull();
  });

  it('hides the upload section from somebody without the documents capability', () => {
    render(<ClientForm canRecordNin canUploadDocuments={false} />);

    expect(screen.queryByLabelText('Photograph')).toBeNull();
  });

  it('accepts no SVG upload', () => {
    render(<ClientForm canRecordNin canUploadDocuments />);

    const photo = screen.getByLabelText('Photograph');
    const accept = photo.getAttribute('accept') ?? '';

    // An SVG is a document that can carry script. The `accept` attribute is a
    // courtesy; the server checks the magic bytes.
    expect(accept).not.toContain('svg');
    expect(accept).toContain('image/jpeg');
  });

  it('turns off the browser’s own validation bubbles', () => {
    const { container } = render(<ClientForm canRecordNin canUploadDocuments />);

    // They cannot be styled, are announced inconsistently, and would show a
    // message that disagrees with the server's.
    expect(container.querySelector('form')?.hasAttribute('noValidate')).toBe(true);
  });

  it('sets multipart encoding, without which the files never arrive', () => {
    const { container } = render(<ClientForm canRecordNin canUploadDocuments />);

    expect(container.querySelector('form')?.getAttribute('enctype')).toBe(
      'multipart/form-data',
    );
  });

  it('explains the phone format rather than rejecting silently', () => {
    render(<ClientForm canRecordNin canUploadDocuments />);

    expect(screen.getByText(/07xx xxx xxx, or \+256/)).toBeTruthy();
  });

  it('says the minimum age up front', () => {
    render(<ClientForm canRecordNin canUploadDocuments />);

    expect(screen.getByText(/at least 18/)).toBeTruthy();
  });
});

describe('client remarks', () => {
  const REMARKS: readonly ClientRemark[] = [
    {
      id: 'aaaaaaaa-1111-4111-8111-111111111111',
      body: 'Payment was two weeks late in March.',
      category: 'payment_concern',
      authorLabel: 'Aisha Nakato',
      createdAt: '2026-09-10T06:30:00Z',
      retractsRemarkId: null,
      retracted: true,
    },
    {
      id: 'bbbbbbbb-2222-4222-8222-222222222222',
      body: 'Recorded against the wrong client.',
      category: 'retraction',
      authorLabel: 'Aisha Nakato',
      createdAt: '2026-09-11T06:30:00Z',
      retractsRemarkId: 'aaaaaaaa-1111-4111-8111-111111111111',
      retracted: false,
    },
  ];

  it('warns that a remark is permanent before one is written', () => {
    render(
      <ClientRemarks
        clientId="0f8fad5b-d9cb-469f-a165-70867728950e"
        remarks={[]}
        canCreate
      />,
    );

    // Somebody about to write something permanent should know it is
    // permanent. Hiding that would be the unkind choice.
    expect(screen.getByText(/cannot be\s+edited or deleted/)).toBeTruthy();
  });

  it('offers no edit or delete control, because none exists', () => {
    render(
      <ClientRemarks
        clientId="0f8fad5b-d9cb-469f-a165-70867728950e"
        remarks={REMARKS}
        canCreate
      />,
    );

    expect(screen.queryByRole('button', { name: /^Edit/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /^Delete/ })).toBeNull();
  });

  it('shows a withdrawn remark struck through, with the withdrawal beneath', () => {
    const { container } = render(
      <ClientRemarks
        clientId="0f8fad5b-d9cb-469f-a165-70867728950e"
        remarks={REMARKS}
        canCreate
      />,
    );

    // Hiding a withdrawn remark would make the history look like it never
    // happened, which is the opposite of what an append-only table is for.
    expect(screen.getByText('Withdrawn')).toBeTruthy();
    expect(container.querySelector('.line-through')).toBeTruthy();
    expect(screen.getByText(/Recorded against the wrong client/)).toBeTruthy();
  });

  it('does not list a retraction as an event of its own', () => {
    render(
      <ClientRemarks
        clientId="0f8fad5b-d9cb-469f-a165-70867728950e"
        remarks={REMARKS}
        canCreate
      />,
    );

    // Two rows for one event reads as two events.
    const items = screen.getAllByRole('listitem');
    expect(items).toHaveLength(1);
  });

  it('hides the compose form from somebody who may only read', () => {
    render(
      <ClientRemarks
        clientId="0f8fad5b-d9cb-469f-a165-70867728950e"
        remarks={REMARKS}
        canCreate={false}
      />,
    );

    expect(screen.queryByLabelText(/^Remark/)).toBeNull();
    expect(screen.queryByRole('button', { name: /Withdraw/ })).toBeNull();
  });

  it('renders a hostile remark body as text', () => {
    const { container } = render(
      <ClientRemarks
        clientId="0f8fad5b-d9cb-469f-a165-70867728950e"
        remarks={[
          {
            ...REMARKS[0]!,
            body: '<img src=x onerror="alert(1)">',
            retracted: false,
          },
        ]}
        canCreate
      />,
    );

    expect(container.querySelector('img[onerror]')).toBeNull();
    expect(container.textContent).toContain('<img src=x onerror="alert(1)">');
  });

  it('preserves the line breaks a person typed, without using raw HTML', () => {
    const { container } = render(
      <ClientRemarks
        clientId="0f8fad5b-d9cb-469f-a165-70867728950e"
        remarks={[{ ...REMARKS[0]!, body: 'Line one\nLine two', retracted: false }]}
        canCreate
      />,
    );

    // `whitespace-pre-wrap` rather than replacing newlines with `<br>` via
    // `dangerouslySetInnerHTML`, which is how this is usually got wrong.
    expect(container.querySelector('.whitespace-pre-wrap')).toBeTruthy();
  });

  it('says so plainly when there are none', () => {
    render(
      <ClientRemarks
        clientId="0f8fad5b-d9cb-469f-a165-70867728950e"
        remarks={[]}
        canCreate={false}
      />,
    );

    expect(screen.getByText('No remarks have been recorded.')).toBeTruthy();
  });
});

describe('the guarantor directory', () => {
  const GUARANTOR_PAGE: GuarantorPage = {
    guarantors: [
      {
        id: 'cccccccc-3333-4333-8333-333333333333',
        fullName: 'Okello John',
        phone: '+256781234567',
        location: 'Bweyogerere',
        occupation: 'Teacher',
        createdAt: '2026-09-01T06:30:00Z',
        activeClientCount: 3,
      },
    ],
    page: 1,
    hasMore: false,
  };

  it('shows how many clients each guarantor stands for', () => {
    render(<GuarantorDirectory page={GUARANTOR_PAGE} query="" />);

    // The number that matters when deciding whether to accept them again. It
    // is invisible if the same person has been entered three times.
    expect(screen.getByText('3 clients')).toBeTruthy();
  });

  it('uses the singular for one client', () => {
    render(
      <GuarantorDirectory
        page={{
          ...GUARANTOR_PAGE,
          guarantors: [{ ...GUARANTOR_PAGE.guarantors[0]!, activeClientCount: 1 }],
        }}
        query=""
      />,
    );

    expect(screen.getByText('1 client')).toBeTruthy();
  });

  it('says so when a guarantor stands for nobody', () => {
    render(
      <GuarantorDirectory
        page={{
          ...GUARANTOR_PAGE,
          guarantors: [{ ...GUARANTOR_PAGE.guarantors[0]!, activeClientCount: 0 }],
        }}
        query=""
      />,
    );

    expect(screen.getByText('No clients')).toBeTruthy();
  });

  it('shows no identification number', () => {
    const { container } = render(<GuarantorDirectory page={GUARANTOR_PAGE} query="" />);

    expect(container.textContent).not.toMatch(/C[MF]\d{8}/);
  });

  it('points somebody at the client page to register one', () => {
    render(
      <GuarantorDirectory
        page={{ guarantors: [], page: 1, hasMore: false }}
        query="zzz"
      />,
    );

    expect(screen.getByText(/registered from a client/)).toBeTruthy();
  });
});

describe('the client status badge', () => {
  it.each(CLIENT_STATUSES)('names %s in words', (status) => {
    const { container } = render(<ClientStatusBadge status={status} />);

    expect(container.textContent?.length).toBeGreaterThan(0);
    // Never only a colour.
    expect(container.textContent).not.toBe('');
  });

  it('distinguishes a temporary restriction from a standing one', () => {
    const suspended = render(<ClientStatusBadge status="suspended" />);
    const blacklisted = render(<ClientStatusBadge status="blacklisted" />);

    // A suspension is expected to be resolved; a blacklisting is a decision.
    // Showing them identically would flatten a distinction the business cares
    // about.
    expect(suspended.container.innerHTML).not.toBe(blacklisted.container.innerHTML);
  });
});
