import { Card } from '@/components/ui/card';
import { DateValue } from '@/components/ui/data-value';
import { getMemberPolicyPosition } from '@/lib/data/policy-update';
import { PolicyAmount } from './amount';

export async function MemberPolicyPosition({ membershipId }: { readonly membershipId: string }) {
  const { savings, benefits } = await getMemberPolicyPosition(membershipId);
  return <section aria-label="Current membership policy position" className="grid min-w-0 gap-4 lg:grid-cols-2">
    {savings ? <Card>
      <h2 className="text-text font-semibold">Savings and borrowing position</h2>
      <p>Governing policy {savings.policy_version}. Original enrollment terms remain in the history.</p>
      <dl className="mt-3 space-y-2">
        <div><dt>Monthly minimum</dt><dd><PolicyAmount value={savings.monthly_minimum} /></dd></div>
        <div><dt>Qualifying savings months</dt><dd>{savings.qualifying_months} of {savings.months_required ?? 'undecided'}; {savings.must_be_consecutive === null ? 'consecutive-month rule awaiting decision' : savings.must_be_consecutive ? 'consecutive' : 'not necessarily consecutive'}</dd></div>
        <div><dt>Savings balance</dt><dd><PolicyAmount value={savings.savings_balance} /></dd></div>
        <div><dt>Pledged savings</dt><dd><PolicyAmount value={savings.pledged_savings} /></dd></div>
        <div><dt>Borrowing ceiling before other eligibility checks</dt><dd><PolicyAmount value={savings.loan_ceiling} /></dd></div>
        <div><dt>Outstanding loans</dt><dd>{savings.outstanding_loan_count}; <PolicyAmount value={savings.outstanding_loan_total} /></dd></div>
      </dl>
      {savings.qualification_reason ? <p className="mt-3">{savings.qualification_reason}</p> : null}
      {savings.withdrawal_block_reason ? <p role="status" className="mt-3">{savings.withdrawal_block_reason}</p> : null}
    </Card> : null}
    {benefits ? <Card>
      <h2 className="text-text font-semibold">Benefit eligibility and verification</h2>
      <p>{benefits.confirmed_member ? 'Confirmed member' : 'Membership status requires review'} · Policy {benefits.policy_version}</p>
      <p>{benefits.savings_months} of {benefits.savings_months_required ?? 'undecided'} qualifying savings months.</p>
      <p>Benefit year: <DateValue value={benefits.benefit_year_from} /> to <DateValue value={benefits.benefit_year_to} /></p>
      <p>Medical claims: {benefits.medical_claims_used} used; {benefits.medical_claims_left ?? 'undecided'} remaining.</p>
      <p>Medical annual ceiling: {benefits.medical_cap_mode === 'no_separate_cap' ? 'No separate ceiling, by recorded decision' : benefits.medical_cap_mode === 'amount' ? <PolicyAmount value={benefits.medical_annual_cap} /> : 'Decision awaiting authorization'}</p>
      <ul className="mt-3 space-y-2">
        <li>Medical: {benefits.medical_blocked_reason ?? 'Policy gate open; evidence and event eligibility still apply.'}</li>
        <li>Family condolence: {benefits.condolence_blocked_reason ?? 'Policy gate open; a prior next-of-kin listing and verified death evidence are required.'}</li>
        <li>Member bereavement: {benefits.bereavement_blocked_reason ?? 'Policy gate open; verified payee, death evidence and loan clearance are required.'}</li>
      </ul>
      <p className="mt-3">Death confirmations required: {benefits.death_confirmations_required ?? 'not decided'} distinct other members.</p>
    </Card> : null}
  </section>;
}
