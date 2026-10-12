import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import {
  asUser,
  asUserScript,
  createTestUser,
  deleteTestUsers,
} from '../helpers/auth-fixtures';
import {
  approveLoan,
  createDraftLoan,
  createLoanScenario,
  deleteTestLoans,
} from '../helpers/loan-fixtures';
import { closePool, hasDatabase, query, queryOne, skipReason } from '../helpers/db';

/**
 * Loan products, attacked at the database.
 *
 * Phase 12 moved a loan's terms from one global row to a configurable
 * product, which is the kind of change that can quietly introduce a second
 * source of truth. These tests assert the three things that stop it:
 *
 *   1. **The guard rail holds in both directions.** A product cannot step
 *      outside what `business_settings` permits, and `business_settings`
 *      cannot be narrowed so far that it strands an active product. Either
 *      half alone would let the Settings screen and the product disagree.
 *   2. **The terms a loan was approved under do not move.** Repricing a
 *      product afterwards changes nothing about the agreement — the
 *      snapshot is append-only and the loan carries its own figures.
 *   3. **Only the Owner may write a product, and nobody may delete one.**
 *      A product holds the rate the business lends at; a product with loans
 *      against it is named by every one of their snapshots.
 *
 * Everything runs as a real database role with a real JWT subject where
 * authorization is the subject, so nothing the application does can account
 * for a pass.
 */
const describeDb = hasDatabase ? describe : describe.skip;

if (!hasDatabase) {
  describe('loan products suite', () => {
    it.skip(`skipped — ${skipReason}`, () => undefined);
  });
}

afterAll(async () => {
  await closePool();
});

beforeEach(async () => {
  await deleteTestLoans();
  await deleteTestUsers();
});

/** One product by code, as a plain row. */
async function product(code: string): Promise<Record<string, unknown>> {
  return queryOne(`select * from public.loan_products where product_code = $1`, [code]);
}

async function productId(code: string): Promise<string> {
  const row = await queryOne<{ id: string }>(
    `select id from public.loan_products where product_code = $1`,
    [code],
  );
  return row.id;
}

// ===========================================================================
describeDb('the seeded catalogue', () => {
  it('offers the four products the business sells, plus the migrated one', async () => {
    const rows = await query<{
      product_code: string;
      status: string;
      is_default: boolean;
    }>(
      `select product_code, status, is_default from public.loan_products
        order by sort_order`,
    );

    expect(rows.map((row) => row.product_code)).toEqual([
      'QL',
      'SL',
      'BL',
      'IL',
      'IL-LEGACY',
    ]);

    // The migrated product exists so that a loan agreed before products
    // existed can name what it actually was. It is inactive, so it cannot be
    // chosen for a new application.
    expect(rows.find((row) => row.product_code === 'IL-LEGACY')?.status).toBe('inactive');

    // Exactly one default, and it is ordinary personal lending.
    expect(rows.filter((row) => row.is_default).map((row) => row.product_code)).toEqual([
      'IL',
    ]);
  });

  it('refuses a second default, and an inactive one', async () => {
    await expect(
      query(
        `update public.loan_products set is_default = true where product_code = 'QL'`,
      ),
    ).rejects.toThrow(/loan_products_one_default/);

    await expect(
      query(
        `update public.loan_products set is_default = true, status = 'inactive'
          where product_code = 'IL-LEGACY'`,
      ),
    ).rejects.toThrow(/loan_products_default_is_active/);
  });

  it('refuses a product whose standard rate is outside its own band', async () => {
    await expect(
      query(
        `update public.loan_products set default_interest_rate_bps = 2500
          where product_code = 'IL'`,
      ),
    ).rejects.toThrow(/loan_products_default_rate_in_band/);
  });

  it('refuses a product that asks for a guarantor and none at once', async () => {
    await expect(
      query(
        `update public.loan_products set guarantor_required = true, min_guarantors = 0
          where product_code = 'IL'`,
      ),
    ).rejects.toThrow(/loan_products_guarantor_count_consistent/);
  });
});

// ===========================================================================
describeDb('the guard rail', () => {
  it('refuses a product that lends more than the business permits', async () => {
    await expect(
      query(
        `update public.loan_products set max_amount = 50000000 where product_code = 'IL'`,
      ),
    ).rejects.toThrow(/business maximum/);
  });

  it('refuses a product that lends less than the business minimum', async () => {
    await expect(
      query(
        `update public.loan_products set min_amount = 1000 where product_code = 'IL'`,
      ),
    ).rejects.toThrow(/business minimum/);
  });

  it('refuses a rate ceiling more than twice the business rate', async () => {
    await expect(
      query(
        `update public.loan_products set max_interest_rate_bps = 9000
          where product_code = 'IL'`,
      ),
    ).rejects.toThrow(/twice the business rate/);
  });

  it('refuses a duration outside the business range', async () => {
    await expect(
      query(
        `update public.loan_products set max_term_months = 24 where product_code = 'IL'`,
      ),
    ).rejects.toThrow(/business maximum/);
  });

  // -------------------------------------------------------------------------
  // The other direction — migration 20261012000500.
  // -------------------------------------------------------------------------

  it('refuses a business minimum that would strand an active product', async () => {
    // Quick Loans lends from 100,000. Raising the floor above that would make
    // the Settings screen say one thing and the product another.
    await expect(
      query(`update public.business_settings set min_loan_amount = 200000 where id = 1`),
    ).rejects.toThrow(/Quick Loans lends from 100000/);
  });

  it('refuses a business maximum that would strand an active product', async () => {
    await expect(
      query(`update public.business_settings set max_loan_amount = 5000000 where id = 1`),
    ).rejects.toThrow(/above the new business maximum/);
  });

  it('names the product and says what to do about it', async () => {
    const failure = await query(
      `update public.business_settings set max_loan_term_months = 2 where id = 1`,
    ).catch((error: unknown) => (error instanceof Error ? error.message : ''));

    // The refusal has to be actionable: which product, which limit, and the
    // two things the Owner can do about it.
    expect(failure).toMatch(/runs to 3 months/);
    expect(failure).toMatch(/Reprice or withdraw the product first/);
  });

  it('permits the change once the product is brought inside it', async () => {
    // Products first, then the rail closes behind them. The order a
    // business would have to work in, and the only one the database accepts.
    await query(
      `update public.loan_products set min_amount = 200000 where status = 'active'`,
    );

    await expect(
      query(`update public.business_settings set min_loan_amount = 200000 where id = 1`),
    ).resolves.toBeDefined();

    // And back, the other way about: open the rail, then the products.
    await query(
      `update public.business_settings set min_loan_amount = 100000 where id = 1`,
    );
    await query(
      `update public.loan_products
          set min_amount = case product_code
                             when 'SL' then 200000
                             when 'BL' then 300000
                             else 100000
                           end
        where status = 'active'`,
    );
  });

  it('ignores a withdrawn product, which cannot lend anything', async () => {
    // `IL-LEGACY` runs 1–3 months and lends from 100,000, but it is
    // withdrawn: it cannot be chosen for a new application, so it must not
    // be able to block a business decision either. Proven by withdrawing
    // every other product and watching the same change go through.
    await query(
      `update public.loan_products set is_default = false where product_code = 'IL'`,
    );
    await query(
      `update public.loan_products set status = 'inactive' where status = 'active'`,
    );

    try {
      await expect(
        query(
          `update public.business_settings set min_loan_amount = 500000 where id = 1`,
        ),
      ).resolves.toBeDefined();
    } finally {
      await query(
        `update public.business_settings set min_loan_amount = 100000 where id = 1`,
      );
      await query(
        `update public.loan_products set status = 'active'
          where product_code in ('QL', 'SL', 'BL', 'IL')`,
      );
      await query(
        `update public.loan_products set is_default = true where product_code = 'IL'`,
      );
    }
  });

  it('checks a cadence when the list is set, and not on every other edit', async () => {
    // Retiring a cadence must not freeze every product that offered it: an
    // Owner changing a rate has not come to edit cadences, and before
    // migration 20261012000600 that edit was refused with a message about
    // one. What is still refused is *adding* a retired cadence.
    await query(
      `update public.repayment_frequencies set is_active = false where key = 'every_3_days'`,
    );

    try {
      await expect(
        query(
          `update public.loan_products set sort_order = 41 where product_code = 'IL'`,
        ),
      ).resolves.toBeDefined();

      await expect(
        query(
          `update public.loan_products
              set allowed_repayment_frequencies = array['daily', 'every_3_days']
            where product_code = 'IL'`,
        ),
      ).rejects.toThrow(/no active repayment cadence/);
    } finally {
      await query(
        `update public.repayment_frequencies set is_active = true where key = 'every_3_days'`,
      );
      await query(
        `update public.loan_products set sort_order = 40 where product_code = 'IL'`,
      );
    }
  });
});

// ===========================================================================
describeDb('what a product may never be made to do', () => {
  it('cannot be renamed by code, however the update is written', async () => {
    const before = await product('IL');

    await query(
      `update public.loan_products set product_code = 'XX' where product_code = 'IL'`,
    );

    const after = await product('IL');

    // Silently restored rather than refused: the UI never sends it, so a
    // request that carries one was assembled by hand.
    expect(after.product_code).toBe('IL');
    expect(after.id).toBe(before.id);
  });

  it('cannot be deleted, by anybody', async () => {
    // Not a policy somebody can widen: the privilege is simply not granted.
    const grant = await queryOne<{ can_delete: boolean }>(
      `select has_table_privilege('authenticated', 'public.loan_products', 'delete')
                as can_delete`,
    );
    expect(grant.can_delete).toBe(false);
  });

  it('cannot have its authorship reassigned', async () => {
    const owner = await createTestUser('owner_admin');

    await query(
      `update public.loan_products set created_by = $1 where product_code = 'IL'`,
      [owner.profileId],
    );

    const after = await product('IL');
    expect(after.created_by).toBeNull();
  });
});

// ===========================================================================
describeDb('who may change a product', () => {
  it('lets the Owner write one and refuses everybody else', async () => {
    const owner = await createTestUser('owner_admin');
    const manager = await createTestUser('manager');
    const treasurer = await createTestUser('secretary_treasurer');
    const borrower = await createTestUser('client');

    const rename = `update public.loan_products set sort_order = 42 where product_code = 'IL'`;

    expect((await asUser(owner, rename)).rowCount).toBe(1);

    // A Manager reads the catalogue — they have to, to answer "what rate is
    // a Salary Loan" — and cannot change it. RLS reports the refusal as
    // zero rows affected, which is what a policy that admits nothing means.
    expect((await asUser(manager, rename)).rowCount).toBe(0);
    expect((await asUser(treasurer, rename)).rowCount).toBe(0);

    // A borrower cannot even read it.
    const read = await asUser(
      borrower,
      `select count(*)::int as count from public.loan_products`,
    );
    expect(read.ok).toBe(true);
    expect(read.rows[0]?.count).toBe(0);
  });

  it('shows the catalogue to the three staff roles', async () => {
    for (const role of ['owner_admin', 'manager', 'secretary_treasurer'] as const) {
      const user = await createTestUser(role);
      const result = await asUser(
        user,
        `select count(*)::int as count from public.loan_product_catalogue`,
      );

      expect(result.ok, role).toBe(true);
      expect(result.rows[0]?.count, role).toBe(5);
    }
  });

  it('records every change in the audit trail, with the product named', async () => {
    const owner = await createTestUser('owner_admin');

    // One transaction, so the read sees the write: `asUser` rolls back after
    // each statement, which is exactly right for a policy test and useless
    // for observing a trigger's effect.
    const result = await asUserScript(owner, [
      {
        sql: `update public.loan_products set default_interest_rate_bps = 1600
               where product_code = 'IL'`,
      },
      {
        sql: `select action, entity_type, entity_id, actor_label,
                     (old_values->>'default_interest_rate_bps')::int as old_rate,
                     (new_values->>'default_interest_rate_bps')::int as new_rate
                from public.audit_log
               where action = 'product.updated'
               order by id desc limit 1`,
      },
    ]);

    expect(result.ok).toBe(true);

    const entry = result.rows[0] as {
      action: string;
      entity_type: string;
      entity_id: string;
      actor_label: string;
      old_rate: number;
      new_rate: number;
    };

    expect(entry.entity_type).toBe('loan_product');
    expect(entry.entity_id).toBe(await productId('IL'));
    expect(entry.actor_label).toBe(owner.fullName);
    // A rate change is the thing an auditor looks for, so both sides of it
    // are on the record.
    expect(entry.old_rate).toBe(1_500);
    expect(entry.new_rate).toBe(1_600);
  });
});

// ===========================================================================
describeDb('the terms a loan was approved under', () => {
  it('are snapshotted at approval, from the product', async () => {
    const scenario = await createLoanScenario();
    const loanId = await createDraftLoan(scenario.clientId, {
      principal: 600_000,
      termMonths: 3,
    });
    await approveLoan(loanId, scenario);

    const snapshot = await queryOne<{
      product_code: string;
      interest_rate_bps: number;
      grace_period_days: number;
      penalty_rate_bps: number;
      application_profile: string;
      interest_rate_overridden: boolean;
      overridden_by_label: string | null;
    }>(
      `select product_code, interest_rate_bps, grace_period_days, penalty_rate_bps,
              application_profile, interest_rate_overridden, overridden_by_label
         from public.loan_product_snapshots where loan_id = $1`,
      [loanId],
    );

    expect(snapshot.product_code).toBe('IL');
    expect(snapshot.interest_rate_bps).toBe(1_500);
    expect(snapshot.grace_period_days).toBe(3);
    expect(snapshot.penalty_rate_bps).toBe(5_000);
    expect(snapshot.application_profile).toBe('individual');

    // Nobody chose this rate; it is the product's own. A rate that differed
    // with nobody named is what an auditor looks for, so the two fields are
    // written together or not at all.
    expect(snapshot.interest_rate_overridden).toBe(false);
    expect(snapshot.overridden_by_label).toBeNull();
  });

  it('do not move when the product is repriced afterwards', async () => {
    const scenario = await createLoanScenario();
    const loanId = await createDraftLoan(scenario.clientId, {
      principal: 600_000,
      termMonths: 3,
    });
    await approveLoan(loanId, scenario);

    await query(
      `update public.loan_products
          set default_interest_rate_bps = 1700, grace_period_days = 30,
              penalty_rate_bps = 9000, max_interest_rate_bps = 1800
        where product_code = 'IL'`,
    );

    try {
      const snapshot = await queryOne<{
        interest_rate_bps: number;
        grace_period_days: number;
        penalty_rate_bps: number;
      }>(
        `select interest_rate_bps, grace_period_days, penalty_rate_bps
           from public.loan_product_snapshots where loan_id = $1`,
        [loanId],
      );

      expect(snapshot.interest_rate_bps).toBe(1_500);
      expect(snapshot.grace_period_days).toBe(3);
      expect(snapshot.penalty_rate_bps).toBe(5_000);

      // And the loan itself, which is what the engines read.
      const loan = await queryOne<{ interest_rate_bps: number; total_interest: string }>(
        `select interest_rate_bps, total_interest::text as total_interest
           from public.loans where id = $1`,
        [loanId],
      );
      expect(loan.interest_rate_bps).toBe(1_500);
      expect(loan.total_interest).toBe('180000');
    } finally {
      await query(
        `update public.loan_products
            set default_interest_rate_bps = 1500, grace_period_days = 3,
                penalty_rate_bps = 5000, max_interest_rate_bps = 1800
          where product_code = 'IL'`,
      );
    }
  });

  it('cannot be edited or deleted once captured', async () => {
    const scenario = await createLoanScenario();
    const loanId = await createDraftLoan(scenario.clientId);
    await approveLoan(loanId, scenario);

    await expect(
      query(
        `update public.loan_product_snapshots set interest_rate_bps = 1 where loan_id = $1`,
        [loanId],
      ),
    ).rejects.toThrow(/append-only/i);

    await expect(
      query(`delete from public.loan_product_snapshots where loan_id = $1`, [loanId]),
    ).rejects.toThrow(/append-only/i);
  });

  it('is readable by the borrower whose loan it describes, and by nobody else', async () => {
    const scenario = await createLoanScenario();
    const loanId = await createDraftLoan(scenario.clientId);
    await approveLoan(loanId, scenario);

    // The borrower's login is linked to the client, so the self-clause in
    // the policy has something to match — the same wiring `rls-loans` uses.
    const borrower = await createTestUser('client');
    await query(`select public.link_client_profile($1, $2)`, [
      scenario.clientId,
      borrower.profileId,
    ]);

    const own = await asUser(
      borrower,
      `select product_code from public.loan_product_snapshots where loan_id = $1`,
      [loanId],
    );

    expect(own.ok).toBe(true);
    // The terms they agreed to are theirs to see.
    expect(own.rows[0]?.product_code).toBe('IL');

    const stranger = await createTestUser('client');
    const theirs = await asUser(
      stranger,
      `select count(*)::int as count from public.loan_product_snapshots where loan_id = $1`,
      [loanId],
    );

    expect(theirs.rows[0]?.count).toBe(0);
  });
});

// ===========================================================================
describeDb('approval against the product', () => {
  it('refuses an amount the product does not write', async () => {
    const scenario = await createLoanScenario();

    // Quick Loans lends up to 2,000,000 over exactly one month.
    const loanId = await createDraftLoan(scenario.clientId, {
      principal: 3_000_000,
      termMonths: 1,
    });

    await query(`update public.loans set loan_product_id = $1 where id = $2`, [
      await productId('QL'),
      loanId,
    ]);

    await expect(approveLoan(loanId, scenario)).rejects.toThrow(
      /Quick Loans lends between/,
    );
  });

  it('refuses a duration the product does not offer', async () => {
    const scenario = await createLoanScenario();
    const loanId = await createDraftLoan(scenario.clientId, {
      principal: 1_000_000,
      termMonths: 3,
    });

    await query(`update public.loans set loan_product_id = $1 where id = $2`, [
      await productId('QL'),
      loanId,
    ]);

    await expect(approveLoan(loanId, scenario)).rejects.toThrow(/Quick Loans/);
  });

  it('refuses a rate the product does not permit, and records one it does', async () => {
    const scenario = await createLoanScenario();

    // Quick Loans permits no override at all.
    const refused = await createDraftLoan(scenario.clientId, {
      principal: 1_000_000,
      termMonths: 1,
    });
    await query(
      `update public.loans set loan_product_id = $1, proposed_interest_rate_bps = 1700
        where id = $2`,
      [await productId('QL'), refused],
    );

    await expect(approveLoan(refused, scenario)).rejects.toThrow(
      /does not permit a rate other than/,
    );

    // Individual Loans permits one inside 12%–18%.
    const allowed = await createDraftLoan(scenario.clientId, {
      principal: 600_000,
      termMonths: 3,
    });
    await query(
      `update public.loans set proposed_interest_rate_bps = 1700 where id = $1`,
      [allowed],
    );

    await approveLoan(allowed, scenario);

    const snapshot = await queryOne<{
      interest_rate_overridden: boolean;
      overridden_by_label: string | null;
      interest_rate_bps: number;
    }>(
      `select interest_rate_overridden, overridden_by_label, interest_rate_bps
         from public.loan_product_snapshots where loan_id = $1`,
      [allowed],
    );

    expect(snapshot.interest_rate_bps).toBe(1_700);
    // An override with nobody named is the thing this table exists to make
    // impossible.
    expect(snapshot.interest_rate_overridden).toBe(true);
    expect(snapshot.overridden_by_label).not.toBeNull();
  });

  it('refuses a rate outside the product band even where override is allowed', async () => {
    const scenario = await createLoanScenario();
    const loanId = await createDraftLoan(scenario.clientId, {
      principal: 600_000,
      termMonths: 3,
    });

    await query(
      `update public.loans set proposed_interest_rate_bps = 2500 where id = $1`,
      [loanId],
    );

    await expect(approveLoan(loanId, scenario)).rejects.toThrow(/is outside what/);
  });

  it('still approves against a withdrawn product, because the loan was taken under it', async () => {
    const scenario = await createLoanScenario();
    const loanId = await createDraftLoan(scenario.clientId, {
      principal: 600_000,
      termMonths: 3,
    });

    // Retiring a product must not strand an application already in the
    // pipeline. What a withdrawn product cannot do is be chosen for a *new*
    // one, which the picker and the default stamp decide.
    await query(`update public.loans set loan_product_id = $1 where id = $2`, [
      await productId('IL-LEGACY'),
      loanId,
    ]);

    await approveLoan(loanId, scenario);

    const snapshot = await queryOne<{ product_code: string }>(
      `select product_code from public.loan_product_snapshots where loan_id = $1`,
      [loanId],
    );
    expect(snapshot.product_code).toBe('IL-LEGACY');
  });
});

// ===========================================================================
describeDb('the migrated loans', () => {
  it('every loan names a product, and nothing historical was invented', async () => {
    // The seeded demo data is not present in this throwaway database, so
    // what is asserted here is the rule rather than the 33 rows: a loan
    // cannot exist without a product, and the column is NOT NULL.
    const column = await queryOne<{ is_nullable: string }>(
      `select is_nullable from information_schema.columns
        where table_schema = 'public' and table_name = 'loans'
          and column_name = 'loan_product_id'`,
    );
    expect(column.is_nullable).toBe('NO');

    // And the stamp supplies it, so nothing that creates a loan today has to
    // know products exist.
    const scenario = await createLoanScenario();
    const loanId = await createDraftLoan(scenario.clientId);

    const loan = await queryOne<{ product_code: string }>(
      `select p.product_code
         from public.loans l
         join public.loan_products p on p.id = l.loan_product_id
        where l.id = $1`,
      [loanId],
    );

    expect(loan.product_code).toBe('IL');
  });
});
