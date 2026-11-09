import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { RecordForm } from '@/components/agency/record-form';
import type { AgencyActionResult } from '@/lib/agency/actions';
import type { AgencyFloatRow, AgencyServiceTypeRow } from '@/lib/domain/agency';
import { toUgx } from '@/lib/domain/money';

/**
 * The agency recording form, and the one thing about it that is not visual.
 *
 * ## Why this file exists
 *
 * Phase 4D minted one idempotency key per mounted form. That is right for a
 * double tap and wrong for the thing a counter actually does: serve the next
 * customer. The second submission carried the first one's key, the database
 * returned the first transaction - correctly, because that is what an
 * idempotency key means - and this form reported success for money nobody
 * had recorded.
 *
 * The database now refuses a key reused against different details
 * (`tests/db/agency-transaction-engine.test.ts`), and that is the control.
 * This file asserts the other half: that the form retires a key when, and
 * only when, a transaction was actually recorded.
 *
 * ## What it cannot assert
 *
 * Anything about posting. The server action is a `'use server'` module
 * reaching `server-only` code, which refuses to load in a client graph - so
 * it is stubbed here, and the real path is driven in a browser against real
 * PostgreSQL by `tests/e2e/specs/agency.write.spec.ts`.
 */

const recordAgencyTransactionAction = vi.fn();

vi.mock('@/lib/agency/actions', () => ({
  recordAgencyTransactionAction: (
    previous: AgencyActionResult | undefined,
    formData: FormData,
  ) => recordAgencyTransactionAction(previous, formData) as unknown,
}));

const SERVICE: AgencyServiceTypeRow = {
  id: 'type-1',
  providerId: 'provider-1',
  providerName: 'MTN Mobile Money',
  code: 'MTN_DEP',
  name: 'Cash in to a wallet',
  direction: 'deposit',
  maxSingleTransaction: toUgx(2_000_000),
  requiresApprovalAbove: null,
  isActive: true,
};

const TILL: AgencyFloatRow = {
  floatAccountId: 'till-1',
  providerId: 'provider-1',
  providerCode: 'MTN',
  providerName: 'MTN Mobile Money',
  branchId: 'branch-1',
  branchCode: 'BR2601',
  tillName: 'main',
  tillIsActive: true,
  ledgerAccountCode: '1320.MTN.BR2601',
  balance: toUgx(1_500_000),
  providerIsActive: true,
  providerIsProvisional: false,
};

/** The key the form would send if it were submitted right now. */
function currentKey(container: HTMLElement): string {
  const field = container.querySelector<HTMLInputElement>('input[name="idempotencyKey"]');
  expect(field).not.toBeNull();
  return field?.value ?? '';
}

async function fillAndSubmit(
  user: ReturnType<typeof userEvent.setup>,
  details: { amount: string; customer: string; reference: string },
): Promise<void> {
  await user.clear(screen.getByLabelText(/amount/i));
  await user.type(screen.getByLabelText(/amount/i), details.amount);
  await user.type(screen.getByLabelText(/customer identifier/i), details.customer);
  await user.type(screen.getByLabelText(/provider reference/i), details.reference);
  await user.click(screen.getByRole('button', { name: /record transaction/i }));
}

describe('the agency recording form carries one key per submission', () => {
  it('keeps the key when a submission fails, and retires it when one succeeds', async () => {
    const user = userEvent.setup();

    // First submission fails: nothing was recorded, so the officer's retry
    // must be the same submission asked again.
    recordAgencyTransactionAction.mockResolvedValueOnce({
      ok: false,
      message: 'The provider is temporarily unavailable.',
    } satisfies AgencyActionResult);

    const { container } = render(
      <RecordForm
        services={[SERVICE]}
        tills={[TILL]}
        terms={{ 'provider-1': { rateBps: 150, fixed: null } }}
      />,
    );

    const firstKey = currentKey(container);
    expect(firstKey).not.toBe('');

    await fillAndSubmit(user, {
      amount: '50000',
      customer: '+256770000001',
      reference: 'MP-0001',
    });

    expect(await screen.findByText(/temporarily unavailable/i)).toBeVisible();
    expect(currentKey(container)).toBe(firstKey);

    // And what the officer typed is still there. React resets an
    // uncontrolled form after a form action completes, whatever the action
    // returned - so before these fields were controlled, a failure left the
    // counter staring at a blank form with the customer still waiting and
    // no way to tell whether the money had moved.
    expect(screen.getByLabelText<HTMLInputElement>(/customer identifier/i).value).toBe(
      '+256770000001',
    );
    expect(screen.getByLabelText<HTMLInputElement>(/provider reference/i).value).toBe(
      'MP-0001',
    );
    expect(screen.getByLabelText<HTMLInputElement>(/amount/i).value).toBe('50000');

    // The retry: same key, so the database can tell it is the same
    // submission rather than a second customer.
    recordAgencyTransactionAction.mockResolvedValueOnce({
      ok: true,
      message: 'Saved to the counter register.',
    } satisfies AgencyActionResult);

    await user.click(screen.getByRole('button', { name: /record transaction/i }));
    expect(await screen.findByText(/saved to the counter register/i)).toBeVisible();

    const sent = recordAgencyTransactionAction.mock.calls.map(
      (call) => (call[1] as FormData).get('idempotencyKey') as string,
    );
    expect(sent).toEqual([firstKey, firstKey]);

    // Recorded. The next customer is a new transaction, so a new key.
    const secondKey = currentKey(container);
    expect(secondKey).not.toBe(firstKey);
  });

  it('clears the customer fields once a transaction is recorded', async () => {
    const user = userEvent.setup();
    recordAgencyTransactionAction.mockResolvedValue({
      ok: true,
      message: 'Saved to the counter register.',
    } satisfies AgencyActionResult);

    render(
      <RecordForm
        services={[SERVICE]}
        tills={[TILL]}
        terms={{ 'provider-1': { rateBps: 150, fixed: null } }}
      />,
    );

    await fillAndSubmit(user, {
      amount: '50000',
      customer: '+256770000002',
      reference: 'MP-0002',
    });
    expect(await screen.findByText(/saved to the counter register/i)).toBeVisible();

    // A form still showing the last customer is a form that invites
    // recording them twice.
    expect(screen.getByLabelText<HTMLInputElement>(/amount/i).value).toBe('');
    expect(screen.getByLabelText<HTMLInputElement>(/customer identifier/i).value).toBe(
      '',
    );
    expect(screen.getByLabelText<HTMLInputElement>(/provider reference/i).value).toBe('');

    // The service stays chosen: a counter works one provider at a time, and
    // re-choosing it per customer is how an officer posts to the wrong till.
    expect(screen.getByLabelText<HTMLSelectElement>(/^service$/i).value).toBe('type-1');
  });

  it('sends a different key for a second customer recorded without reloading', async () => {
    // The defect, stated as the behaviour that replaces it. Two customers,
    // one mounted form, no reload: two keys.
    const user = userEvent.setup();
    recordAgencyTransactionAction.mockResolvedValue({
      ok: true,
      message: 'Saved to the counter register.',
    } satisfies AgencyActionResult);

    render(
      <RecordForm
        services={[SERVICE]}
        tills={[TILL]}
        terms={{ 'provider-1': { rateBps: 150, fixed: null } }}
      />,
    );

    await fillAndSubmit(user, {
      amount: '50000',
      customer: '+256770000003',
      reference: 'MP-0003',
    });
    expect(await screen.findByText(/saved to the counter register/i)).toBeVisible();

    await fillAndSubmit(user, {
      amount: '75000',
      customer: '+256770000004',
      reference: 'MP-0004',
    });

    const sent = recordAgencyTransactionAction.mock.calls.map((call) => ({
      key: (call[1] as FormData).get('idempotencyKey') as string,
      customer: (call[1] as FormData).get('customerIdentifier') as string,
      amount: (call[1] as FormData).get('principalAmount') as string,
    }));

    expect(sent).toHaveLength(2);
    expect(sent[0]?.customer).toBe('+256770000003');
    expect(sent[1]?.customer).toBe('+256770000004');
    expect(sent[1]?.amount).toBe('75000');
    expect(sent[1]?.key).not.toBe(sent[0]?.key);
  });

  it('cannot be submitted twice while the first submission is in flight', async () => {
    // The double tap. React keeps the action pending and the button
    // disabled throughout, so the second press never reaches the server at
    // all - and if one ever did, it would carry the same key.
    const user = userEvent.setup();
    let release: ((value: AgencyActionResult) => void) | undefined;
    recordAgencyTransactionAction.mockImplementationOnce(
      () =>
        new Promise<AgencyActionResult>((resolve) => {
          release = resolve;
        }),
    );

    render(
      <RecordForm
        services={[SERVICE]}
        tills={[TILL]}
        terms={{ 'provider-1': { rateBps: 150, fixed: null } }}
      />,
    );

    await fillAndSubmit(user, {
      amount: '50000',
      customer: '+256770000005',
      reference: 'MP-0005',
    });

    const button = screen.getByRole('button', { name: /record transaction/i });
    expect(button).toBeDisabled();
    await user.click(button);
    expect(recordAgencyTransactionAction).toHaveBeenCalledTimes(1);

    release?.({ ok: true, message: 'Saved to the counter register.' });
    expect(await screen.findByText(/saved to the counter register/i)).toBeVisible();
  });
});
