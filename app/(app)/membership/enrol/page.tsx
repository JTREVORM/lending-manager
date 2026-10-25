import { ArrowLeft, BadgeCheck } from 'lucide-react';

import { EnrolmentForm } from '@/components/membership/enrolment-form';
import { Alert } from '@/components/ui/alert';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { PageHeader } from '@/components/ui/page-header';
import { RowLink } from '@/components/ui/row-link';
import { ROUTES } from '@/config/app';
import { guardPermission } from '@/lib/auth/guard';
import { getClient, listClients } from '@/lib/data/clients';
import { getActiveMembershipPolicy, listClientMemberships } from '@/lib/data/membership';
import { listWitnessCandidates } from '@/lib/data/savings';
import { activityBlockedReason } from '@/lib/domain/membership';
import { mintEnrolmentKey } from '@/lib/membership/actions';
import { uuidSchema } from '@/lib/validation/common';

export const metadata = { title: 'Enrol a member' };

/**
 * Enrolling a client as a member.
 *
 * ## A member is a client with a membership
 *
 * So this screen starts from a client, and never asks for a name, a phone
 * number or a National Identification Number. There is one identity table for
 * the people this business deals with and it is `clients`; a member is a
 * client with a membership, and a non-member is a client without one who
 * remains a perfectly valid client.
 *
 * That is also why a client who must first be registered is sent to the client
 * register rather than being offered a second, parallel "add a person" form
 * here. Two routes into one identity table is how duplicate records start.
 *
 * ## The fast path
 *
 * Search by name or client number, tap the client, fill one form. The same
 * shape the payment screen uses, for the same reason: somebody is standing at
 * the counter.
 *
 * ## Four refusals, stated before the form
 *
 * Enrolment not open under the policy in force, a client who does not exist or
 * cannot be seen, a client who is already a member, and a client who has a
 * membership in progress. Each is refused again by `enrol_member`, so none of
 * these panels is the control — but a counter who is told before the
 * conversation starts is in a different position from one refused after taking
 * the money.
 */
export default async function EnrolMemberPage({
  searchParams,
}: {
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const context = await guardPermission(ROUTES.enrolMember, 'membership:create');

  const params = await searchParams;
  const single = (key: string): string => {
    const value = params[key];
    return typeof value === 'string' ? value : '';
  };

  const clientId = single('clientId');
  const query = single('query');

  const policy = await getActiveMembershipPolicy();

  const enrolmentBlocked =
    policy === null
      ? 'No membership policy version is in force yet. Enrolment waits on one being approved.'
      : activityBlockedReason(policy, 'enrolment');

  const header = (
    <PageHeader
      eyebrow="Member Register"
      icon={BadgeCheck}
      back={{ href: ROUTES.membership, label: 'Membership' }}
      title="Enrol a member"
      description="Take the registration fee, record the member's acceptance of the terms and open their savings account — in one step."
    />
  );

  if (enrolmentBlocked !== null || policy === null) {
    return (
      <div className="min-w-0 space-y-4">
        {header}
        <Alert tone="warning" title="Enrolment is not open yet">
          {enrolmentBlocked ?? 'No membership policy version is in force.'} Nobody can be
          enrolled until that is settled.
        </Alert>
      </div>
    );
  }

  // --- A client is chosen: show the form ---------------------------------
  if (clientId !== '') {
    if (!uuidSchema.safeParse(clientId).success) {
      return (
        <div className="min-w-0 space-y-4">
          <ChooseDifferentClient />
          <Alert tone="danger">That is not a client reference.</Alert>
        </div>
      );
    }

    const [client, memberships, witnesses, idempotencyKey] = await Promise.all([
      // Fetched by id, not searched for: the register is paginated, so looking
      // the client up in page one would silently fail to find them once the
      // business has more than a screenful.
      getClient(clientId),
      listClientMemberships(clientId),
      listWitnessCandidates(context.profileId),
      mintEnrolmentKey(),
    ]);

    // A missing client and an unauthorised one look the same, deliberately.
    if (client === null) {
      return (
        <div className="min-w-0 space-y-4">
          <ChooseDifferentClient />
          <Alert tone="danger">
            That client cannot be found. They may have been registered at another branch.
          </Alert>
        </div>
      );
    }

    const live = memberships.find((membership) =>
      ['pending', 'active', 'suspended'].includes(membership.status),
    );

    if (live !== undefined) {
      return (
        <div className="min-w-0 space-y-4">
          <ChooseDifferentClient />
          <Alert tone="info" title={`${client.fullName} already has a membership`}>
            Membership {live.membershipNumber} is {live.status}.{' '}
            <RowLink
              href={`${ROUTES.membership}/${live.id}`}
              className="underline underline-offset-2"
            >
              Open it
            </RowLink>{' '}
            to take the fee or record an acceptance against it.
          </Alert>
        </div>
      );
    }

    if (witnesses.length === 0) {
      return (
        <div className="min-w-0 space-y-4">
          {header}
          <Alert tone="warning" title="There is nobody to witness this">
            An acceptance has to be witnessed by another active member of staff, and you
            are the only one. A witness who is also the person recording the enrolment
            would not be a witness, so the database refuses it — which means somebody else
            has to be signed in, or the member&rsquo;s application has to be taken and the
            acceptance recorded later.
          </Alert>
        </div>
      );
    }

    return (
      <div className="min-w-0 space-y-4">
        <PageHeader
          eyebrow="Member Register"
          icon={BadgeCheck}
          back={{ href: ROUTES.enrolMember, label: 'Choose a different client' }}
          title="Enrol a member"
          description="Check the figures against what the member hands over. The fee, the acceptance, the activation and the savings account are recorded together."
        />

        <EnrolmentForm
          clientId={client.id}
          clientName={client.fullName}
          clientNumber={client.clientNumber}
          registrationFee={policy.registrationFee}
          monthlySavingsMinimum={policy.monthlySavingsMinimum}
          witnesses={witnesses}
          idempotencyKey={idempotencyKey}
        />
      </div>
    );
  }

  // --- No client yet: choose one ----------------------------------------
  const { clients } = await listClients({
    query: query === '' ? null : query,
    status: 'active',
    page: 1,
  });

  return (
    <div className="min-w-0 space-y-4">
      {header}

      <Card>
        <form method="get" className="flex min-w-0 flex-wrap gap-2">
          <div className="min-w-0 grow">
            <label htmlFor="client-search" className="sr-only">
              Search by client name or client number
            </label>
            <Input
              id="client-search"
              name="query"
              type="search"
              placeholder="Name or client number"
              defaultValue={query}
              autoFocus
            />
          </div>
          <button
            type="submit"
            className="bg-accent text-accent-contrast focus-visible:outline-accent inline-flex min-h-11 items-center justify-center rounded-lg px-4 text-sm font-medium focus-visible:outline-2 focus-visible:outline-offset-2"
          >
            Search
          </button>
        </form>
      </Card>

      {clients.length === 0 ? (
        <Card>
          <p className="text-text-muted text-sm">
            No active client matches.{' '}
            <RowLink
              href={ROUTES.clients}
              className="text-accent underline-offset-2 hover:underline"
            >
              Register them as a client first
            </RowLink>{' '}
            — a member is a client with a membership, so there is one place a person is
            recorded and this is not it.
          </p>
        </Card>
      ) : (
        <ul className="min-w-0 space-y-2">
          {clients.map((client) => (
            <li key={client.id} className="min-w-0">
              {/* RowLink, not Link: one per client in the picker, and
                  prefetching each one downloads an enrolment screen for every
                  client the clerk scrolled past. */}
              <RowLink
                href={`${ROUTES.enrolMember}?clientId=${client.id}`}
                className="border-border bg-surface focus-visible:outline-accent block min-w-0 rounded-lg border p-3 focus-visible:outline-2 focus-visible:outline-offset-2"
              >
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <span className="text-text font-medium break-words">
                    {client.fullName}
                  </span>
                  <span className="text-text-muted font-mono text-sm">
                    {client.clientNumber}
                  </span>
                </div>
                <div className="text-text-muted mt-1 flex flex-wrap gap-x-3 text-xs">
                  <span>{client.phone}</span>
                  <span>
                    {client.villageArea}, {client.district}
                  </span>
                </div>
              </RowLink>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * Back to the client chooser.
 *
 * The short "this client cannot be enrolled" panels carry no banner, so they
 * keep a plain back link — the same text link `PageHeader` renders above its
 * banner, so the two read identically wherever the reader meets them.
 */
function ChooseDifferentClient() {
  return (
    <RowLink
      href={ROUTES.enrolMember}
      className="text-text-muted hover:text-accent inline-flex min-h-8 items-center gap-1.5 text-xs font-medium"
    >
      <ArrowLeft aria-hidden="true" className="size-4" />
      Choose a different client
    </RowLink>
  );
}
