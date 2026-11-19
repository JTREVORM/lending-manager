-- POLYTOS November 2026 decisions: prepare configuration without activation.
--
-- This migration stages recorded Owner proposals on the *unapproved* policy
-- only. The nine provider choices are recorded in a separate rollout manifest. It is not an authorisation
-- to run medical claims, distribute profits or post agency transactions.
--
-- Never update an approved/assigned membership policy or a live provider here.
-- Never guess a provider's contractual monetary thresholds or settlement.
-- No historical loan schedule, journal entry or member account is rewritten.

do $polytos_policy$
declare
  v_policy public.membership_policy_versions%rowtype;
  v_monthly public.repayment_frequencies%rowtype;
  v_provider record;
  v_provider_count integer := 0;
begin
  select * into v_policy
    from public.membership_policy_versions
   where version = '2.0'
   for update;

  if not found then
    raise exception 'Membership Policy 2.0 is missing; cannot stage decisions.';
  end if;
  if v_policy.status <> 'draft' or v_policy.approved_at is not null
     or exists (
       select 1 from public.memberships m
        where m.policy_version_id = v_policy.id
     ) then
    raise exception 'Policy 2.0 has been approved or assigned; create a new version instead.';
  end if;
  if (v_policy.medical_benefit_cap_mode is not null
      and v_policy.medical_benefit_cap_mode <> 'amount')
     or (v_policy.medical_benefit_annual_cap is not null
         and v_policy.medical_benefit_annual_cap <> 500000)
     or (v_policy.profit_distribution_basis is not null
         and v_policy.profit_distribution_basis <> 'pro_rata_savings') then
    raise exception 'Policy 2.0 already has conflicting decisions; manual policy-version review required.';
  end if;

  -- One combined UPDATE respects the paired cap-mode/amount constraint.
  update public.membership_policy_versions
     set medical_benefit_cap_mode = 'amount',
         medical_benefit_annual_cap = 500000,
         profit_distribution_basis = 'pro_rata_savings'
   where id = v_policy.id;
  -- Do not set effective_from, approved_at, status or any derived gate.
  -- The existing six qualifying savings months remain the benefit basis;
  -- an invented number of waiting-period days must not be added.

  select * into v_monthly
    from public.repayment_frequencies
   where key = 'monthly' for update;
  if not found or v_monthly.cadence_kind <> 'calendar_month' then
    raise exception 'Calendar-monthly repayment cadence is unavailable.';
  end if;
  if v_monthly.month_anchor is not null
     and v_monthly.month_anchor <> 'clamp_to_month_end' then
    raise exception 'Monthly anchor is write-once and already conflicts with the approved proposal.';
  end if;

  update public.repayment_frequencies
     set month_anchor = 'clamp_to_month_end'
   where key = 'monthly' and month_anchor is null;
  -- Monthly cadence remains inactive until schedule generation, member-product
  -- frequency rules and release checks have been certified. The anchor alone
  -- is a safely staged contractual scheduling convention.

  -- Readiness preflight ONLY: changing existing agency provider rows inside
  -- a schema migration would create audited changes against an established
  -- financial book. The upgrade-rehearsal gate correctly forbids that.
  --
  -- The desired commission_source='reported' for all nine external providers
  -- is stored in config/policies/november-2026-agency-rollout.json. A separately
  -- authorised Owner action must apply each one through the existing audited
  -- set_agency_provider_commission_source RPC after contractual verification.
  -- No provider status/terms/commission-source row is updated here.
  for v_provider in
    select id, code, is_provisional, is_active,
           commission_source, commission_rate_bps, commission_fixed
      from public.agency_service_providers
     where code = any (array[
       'MTN_MOMO', 'AIRTEL_MONEY', 'STANBIC', 'UEDCL', 'NWSC',
       'DSTV', 'GOTV', 'LYCAMOBILE', 'SCHOOL_FEES'
     ])
     order by code
  loop
    v_provider_count := v_provider_count + 1;
    if not v_provider.is_provisional or v_provider.is_active
       or v_provider.commission_rate_bps is not null
       or v_provider.commission_fixed is not null then
      raise exception 'Provider % differs from provisional zero-rate baseline; review commercial terms before release.',
        v_provider.code;
    end if;
    if v_provider.commission_source not in ('configured', 'reported') then
      raise exception 'Provider % has an unknown commission source.', v_provider.code;
    end if;
  end loop;

  if v_provider_count <> 9 then
    raise exception 'Expected nine registered candidate agency providers; found %.', v_provider_count;
  end if;
end;
$polytos_policy$;

-- Deliberately unchanged: provider records and readiness flags, Stanbic float model,
-- commission source/recognition timing, actual payments, transaction ceilings,
-- approval thresholds, float limits, membership status, effective dates,
-- profit distributions, and posted accounting records.
