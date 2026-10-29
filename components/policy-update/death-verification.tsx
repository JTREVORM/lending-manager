import { Card } from '@/components/ui/card';
import { DateValue } from '@/components/ui/data-value';
import { mapDatabaseError } from '@/lib/db-errors';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { OperationForm } from './operation-form';

export async function DeathVerification({
  claimId,
  membershipId,
  canRecord,
}: {
  readonly claimId: string;
  readonly membershipId: string;
  readonly canRecord: boolean;
}) {
  const db = await createSupabaseServerClient();
  const [confirmations, members, snapshot] = await Promise.all([
    db
      .from('benefit_death_confirmations')
      .select(
        'id, confirming_membership_number, confirmation_method, recorded_by_label, business_date',
      )
      .eq('claim_id', claimId)
      .order('created_at'),
    canRecord
      ? db
          .from('membership_register')
          .select('id, membership_number, full_name')
          .eq('status', 'active')
          .neq('id', membershipId)
          .order('membership_number')
          .limit(500)
      : Promise.resolve({ data: [], error: null }),
    db
      .from('benefit_assessment_snapshots')
      .select(
        'qualification_basis, savings_qualifying_months, savings_months_required, death_confirmations_recorded, death_confirmations_required, medical_cap_mode, deceased_beneficiary_number, deceased_listed_on, outstanding_loan_count',
      )
      .eq('claim_id', claimId)
      .maybeSingle(),
  ]);
  if (confirmations.error) throw mapDatabaseError(confirmations.error);
  if (members.error) throw mapDatabaseError(members.error);
  if (snapshot.error) throw mapDatabaseError(snapshot.error);
  return (
    <Card>
      <h2 className="font-semibold">Death confirmation and policy evidence</h2>
      <p>
        The death certificate is checked in the documents panel. Each confirmation below
        names a distinct real membership, separate from the deceased.
      </p>
      <ul className="mt-3 space-y-2">
        {(confirmations.data ?? []).map((c) => (
          <li key={c.id}>
            {c.confirming_membership_number} ·{' '}
            {c.confirmation_method.replaceAll('_', ' ')} · recorded by{' '}
            {c.recorded_by_label} on <DateValue value={c.business_date} />
          </li>
        ))}
      </ul>
      {canRecord ? (
        <div className="mt-4">
          <OperationForm
            operation="confirm_death"
            values={{ claimId }}
            label="Record group member confirmation"
            fields={[
              {
                name: 'membershipId',
                label: 'Confirming group member',
                required: true,
                options: (members.data ?? [])
                  .filter((m) => m.id)
                  .map((m) => ({
                    value: m.id!,
                    label: `${m.membership_number} — ${m.full_name}`,
                  })),
              },
              {
                name: 'statement',
                label: 'Statement witnessed from the confirming member',
                required: true,
              },
              { name: 'relationship', label: 'How the confirmer knows the deceased' },
            ]}
          />
        </div>
      ) : null}
      {snapshot.data ? (
        <div className="mt-4">
          <h3 className="font-medium">Evidence frozen at assessment</h3>
          <p>
            Qualification basis:{' '}
            {snapshot.data.qualification_basis ?? 'Historical assessment'}.
          </p>
          <p>
            Savings months: {snapshot.data.savings_qualifying_months ?? 'not applicable'}{' '}
            of {snapshot.data.savings_months_required ?? 'not applicable'}.
          </p>
          <p>
            Death confirmations:{' '}
            {snapshot.data.death_confirmations_recorded ?? 'historical'} of{' '}
            {snapshot.data.death_confirmations_required ?? 'historical'}.
          </p>
          {snapshot.data.deceased_beneficiary_number ? (
            <p>
              Listed next of kin: {snapshot.data.deceased_beneficiary_number}, registered{' '}
              <DateValue value={snapshot.data.deceased_listed_on} />.
            </p>
          ) : null}
          <p>
            Outstanding loans at assessment:{' '}
            {snapshot.data.outstanding_loan_count ?? 'historical'}.
          </p>
        </div>
      ) : null}
    </Card>
  );
}
