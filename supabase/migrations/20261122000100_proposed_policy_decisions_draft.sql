-- POLYTOS policy decision configuration (draft only).
-- This migration records the Owner's proposed values without publishing
-- membership terms, enabling a module, posting money or rewriting history.
-- Final approval and effective date remain separate controlled actions.
--
-- Decisions: annual medical cap UGX 500,000; profit sharing pro rata to
-- savings held; calendar-month repayment dates clamp to month end.
-- The remaining decisions need additional application/RPC work or
-- contractual provider data and are deliberately NOT silently activated.
DO $policy$
DECLARE
  p public.membership_policy_versions%ROWTYPE;
BEGIN
  SELECT * INTO p
    FROM public.membership_policy_versions
   WHERE version = '2.0'
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'POLYTOS policy 2.0 is missing; refuse to create or activate substitute terms';
  END IF;
  IF p.status <> 'draft' OR p.approved_at IS NOT NULL
     OR p.effective_from IS NOT NULL THEN
    RAISE EXCEPTION 'Policy 2.0 is not an undated, unapproved draft; publish a new version instead of changing governing terms';
  END IF;
  IF (p.medical_benefit_annual_cap IS NOT NULL AND p.medical_benefit_annual_cap <> 500000)
     OR (p.medical_benefit_cap_mode IS NOT NULL AND p.medical_benefit_cap_mode <> 'amount')
     OR (p.profit_distribution_basis IS NOT NULL AND p.profit_distribution_basis <> 'pro_rata_savings') THEN
    RAISE EXCEPTION 'Policy 2.0 already carries different decisions; refuse to overwrite without review';
  END IF;
  IF EXISTS (SELECT 1 FROM public.memberships WHERE policy_version_id = p.id) THEN
    RAISE EXCEPTION 'Memberships already reference policy 2.0; do not alter their contractual terms';
  END IF;

  UPDATE public.membership_policy_versions
     SET medical_benefit_annual_cap = 500000,
         medical_benefit_cap_mode = 'amount',
         profit_distribution_basis = 'pro_rata_savings'
   WHERE id = p.id;

  IF NOT EXISTS (
    SELECT 1 FROM public.membership_policy_versions
     WHERE id = p.id AND status = 'draft' AND approved_at IS NULL
       AND effective_from IS NULL
       AND medical_benefit_annual_cap = 500000
       AND medical_benefit_cap_mode = 'amount'
       AND profit_distribution_basis = 'pro_rata_savings'
       AND NOT is_medical_benefit_enabled
       AND NOT is_profit_sharing_enabled
  ) THEN
    RAISE EXCEPTION 'Draft membership safety gates changed unexpectedly';
  END IF;
END
$policy$;

DO $calendar$
DECLARE
  m public.repayment_frequencies%ROWTYPE;
BEGIN
  SELECT * INTO m
    FROM public.repayment_frequencies
   WHERE key = 'monthly'
   FOR UPDATE;
  IF NOT FOUND OR m.cadence_kind <> 'calendar_month' THEN
    RAISE EXCEPTION 'Calendar-month repayment frequency missing or structurally changed';
  END IF;
  IF m.month_anchor IS NOT NULL AND m.month_anchor <> 'clamp_to_month_end' THEN
    RAISE EXCEPTION 'Monthly schedule anchor conflicts with the approved policy decision';
  END IF;
  IF m.is_active THEN
    RAISE EXCEPTION 'Monthly cadence already enabled; review affected loan products before changing scheduling';
  END IF;

  UPDATE public.repayment_frequencies
     SET month_anchor = 'clamp_to_month_end'
   WHERE key = 'monthly';

  -- Intentionally leave is_active=false until supported product-specific
  -- schedules and approval tests are released and management enables it.
  IF NOT EXISTS (
    SELECT 1 FROM public.repayment_frequencies
     WHERE key = 'monthly' AND month_anchor = 'clamp_to_month_end'
       AND is_active = false
  ) THEN
    RAISE EXCEPTION 'Monthly cadence was activated unexpectedly';
  END IF;
END
$calendar$;
