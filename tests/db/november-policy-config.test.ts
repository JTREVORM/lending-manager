import { afterAll, describe, expect, it } from 'vitest';

import { closePool, hasDatabase, query, queryOne } from '../helpers/db';

afterAll(async () => {
  if (hasDatabase) await closePool();
});

describe.skipIf(!hasDatabase)('November 2026 policy decisions remain staged, not activated', () => {
  it('records the approved proposal in the untouched draft policy only', async () => {
    const row = await queryOne<{
      status: string;
      approved_at: string | null;
      effective_from: string | null;
      medical_benefit_cap_mode: string;
      medical_benefit_annual_cap: string;
      profit_distribution_basis: string;
      benefit_qualification_basis: string;
      benefit_waiting_period_days: number | null;
      is_medical_benefit_enabled: boolean;
      is_profit_sharing_enabled: boolean;
    }>(`
      select status, approved_at, effective_from,
             medical_benefit_cap_mode, medical_benefit_annual_cap::text,
             profit_distribution_basis, benefit_qualification_basis,
             benefit_waiting_period_days,
             is_medical_benefit_enabled, is_profit_sharing_enabled
        from public.membership_policy_versions
       where version = '2.0'
    `);
    expect(row.status).toBe('draft');
    expect(row.approved_at).toBeNull();
    expect(row.effective_from).toBeNull();
    expect(row.medical_benefit_cap_mode).toBe('amount');
    expect(row.medical_benefit_annual_cap).toBe('500000');
    expect(row.profit_distribution_basis).toBe('pro_rata_savings');
    expect(row.benefit_qualification_basis).toBe('savings_qualifying_months');
    expect(row.benefit_waiting_period_days).toBeNull();
    expect(row.is_medical_benefit_enabled).toBe(false);
    expect(row.is_profit_sharing_enabled).toBe(false);
  });

  it('records month-end clamping without prematurely enabling monthly loans', async () => {
    const row = await queryOne<{
      cadence_kind: string;
      month_anchor: string | null;
      is_active: boolean;
    }>(`
      select cadence_kind, month_anchor, is_active
        from public.repayment_frequencies where key = 'monthly'
    `);
    expect(row.cadence_kind).toBe('calendar_month');
    expect(row.month_anchor).toBe('clamp_to_month_end');
    expect(row.is_active).toBe(false);
  });

  it('prepares reported commission for nine real providers without activating them', async () => {
    const providers = await query<{
      code: string;
      commission_source: string;
      is_provisional: boolean;
      is_active: boolean;
      commission_rate_bps: number | null;
      commission_fixed: string | null;
    }>(`
      select code, commission_source, is_provisional, is_active,
             commission_rate_bps, commission_fixed::text
        from public.agency_service_providers
       where code = any (array[
         'MTN_MOMO','AIRTEL_MONEY','STANBIC','UEDCL','NWSC',
         'DSTV','GOTV','LYCAMOBILE','SCHOOL_FEES'
       ])
       order by code
    `);
    expect(providers).toHaveLength(9);
    for (const provider of providers) {
      expect(provider.commission_source, provider.code).toBe('reported');
      expect(provider.is_provisional, provider.code).toBe(true);
      expect(provider.is_active, provider.code).toBe(false);
      expect(provider.commission_rate_bps, provider.code).toBeNull();
      expect(provider.commission_fixed, provider.code).toBeNull();
    }
  });
});
