-- Preserve immutable assessment evidence under a partial annual medical cap.
-- Previous invariant required every medical assessment to equal the full 5%
-- of its bill, making the new explicit pay_remaining policy impossible.
-- This replacement remains strict: exact original arithmetic for all older
-- policies; exactly min(nominal benefit, remaining annual allowance) for the
-- version that expressly opted into partial capped payment.
-- benefit_snapshot_within_cap and assessment-only permissions remain intact.

alter table public.benefit_assessment_snapshots
  drop constraint benefit_snapshot_medical_arithmetic;

alter table public.benefit_assessment_snapshots
  add constraint benefit_snapshot_medical_arithmetic
  check (
    case
      when claim_type <> 'medical' then true
      when medical_cap_mode = 'amount'
           and medical_benefit_excess_handling = 'pay_remaining'
      then
        annual_cap is not null
        and prior_amount_in_period is not null
        and remaining_cap_before is not null
        and remaining_cap_before = greatest(annual_cap - prior_amount_in_period, 0)
        and assessed_amount > 0
        and assessed_amount = least(
          (bill_amount * benefit_rate_bps + 5000) / 10000,
          greatest(annual_cap - prior_amount_in_period, 0)
        )
      else
        assessed_amount = (bill_amount * benefit_rate_bps + 5000) / 10000
    end
  );

comment on constraint benefit_snapshot_medical_arithmetic
  on public.benefit_assessment_snapshots is
  'A medical assessment must equal its rate-calculated bill benefit, except where the frozen governing policy explicitly chose pay_remaining under an annual amount cap, in which case the assessed amount must equal the smaller of the bill benefit and unconsumed cap, both positive. Historical policies keep exact full-benefit arithmetic; all snapshots also satisfy benefit_snapshot_within_cap.';
