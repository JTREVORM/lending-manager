/**
 * Seed the screenshot database with realistic, wholly synthetic data.
 *
 * Every name, phone number, identification number and amount below is
 * invented. The phone numbers sit in a block reserved for the harness, the
 * identification numbers follow the schema's shape without being real, and no
 * value here came from a person.
 *
 * Loans are driven through the real functions — approve_loan,
 * generate_loan_schedule, post_payment, ensure_penalty_applied — so the
 * breakdowns, snapshots, schedules, allocations and balances are the ones the
 * application produces. Only two things are bypassed, both of them clocks:
 * `disbursed_at` is back-dated so loans exist at different points in their
 * life today, and the business clock is set per payment so the ledger has a
 * history rather than everything landing this morning.
 */
import { createRequire } from 'node:module';
const require = createRequire(new URL('../../../package.json', import.meta.url));
const { Client } = require('pg');
const { scryptSync, randomBytes, randomUUID } = require('node:crypto');

const db = new Client({
  connectionString:
    process.env.E2E_DATABASE_URL ?? 'postgresql://lending@localhost:5433/lending_e2e',
});
await db.connect();

const q = async (sql, params = []) => (await db.query(sql, params)).rows;
const one = async (sql, params = []) => (await q(sql, params))[0];

/** Harness password hashing. scrypt, so no plaintext is stored even here. */
function hashPassword(plain) {
  const salt = randomBytes(16).toString('hex');
  const hash = scryptSync(plain, salt, 64).toString('hex');
  return `scrypt$${salt}$${hash}`;
}

const DEMO_PASSWORD = process.env.HARNESS_PASSWORD ?? 'Screenshot#Demo2026';

// ---------------------------------------------------------------------------
// Company identity
// ---------------------------------------------------------------------------
await q(`
  update public.company_settings
     set company_name = 'Kyanja Credit Services',
         legal_name = 'Kyanja Credit Services Limited',
         registration_number = 'HARNESS-000000',
         phone = '+256772100100',
         email = 'office@kyanja.invalid',
         address_line1 = 'Plot 14, Kyanja Ring Road',
         city = 'Kampala',
         receipt_header = 'Kyanja Credit Services — Official Receipt',
         receipt_footer = 'Thank you. Keep this receipt for your records.'
   where id = 1`);

// ---------------------------------------------------------------------------
// Staff
// ---------------------------------------------------------------------------
let staffSeq = 0;

async function createStaff(roleKey, fullName, phone, email) {
  staffSeq += 1;
  const authEmail = `${phone.slice(1)}@phone.lending.invalid`;

  const user = await one(
    `insert into auth.users (email, encrypted_password) values ($1, $2) returning id`,
    [authEmail, hashPassword(DEMO_PASSWORD)],
  );

  const profile = await one(
    `insert into public.profiles (auth_user_id, full_name, phone, email, status)
     values ($1, $2, $3, $4, 'active') returning id`,
    [user.id, fullName, phone, email],
  );

  // `must_change_password` defaults to false and `password_set_at` is only
  // stamped for an administrator-issued temporary password, so these accounts
  // sign straight in — which is what the screenshots need.

  await q(`insert into public.user_roles (profile_id, role_key) values ($1, $2)`, [
    profile.id,
    roleKey,
  ]);

  return { authId: user.id, profileId: profile.id, fullName, phone };
}

const owner = await createStaff(
  'owner_admin',
  'Nalubega Sarah Kiwanuka',
  '+256772100101',
  'sarah@kyanja.invalid',
);
const manager = await createStaff(
  'manager',
  'Okello Daniel Omara',
  '+256772100102',
  'daniel@kyanja.invalid',
);
const secretary = await createStaff(
  'secretary_treasurer',
  'Namirembe Grace Atim',
  '+256772100103',
  'grace@kyanja.invalid',
);
const secondSecretary = await createStaff(
  'secretary_treasurer',
  'Wasswa Peter Lubega',
  '+256772100104',
  'peter@kyanja.invalid',
);
// A suspended account, so the user directory shows more than one status.
const suspended = await createStaff(
  'secretary_treasurer',
  'Akello Betty Anyango',
  '+256772100105',
  'betty@kyanja.invalid',
);
await q(`update public.profiles set status = 'suspended' where id = $1`, [
  suspended.profileId,
]);

console.log('staff seeded');

// ---------------------------------------------------------------------------
// Helpers for running as a signed-in user, and at a chosen business instant
// ---------------------------------------------------------------------------
async function asUser(user, sql, params = [], businessNow) {
  await db.query('begin');
  if (businessNow !== undefined) {
    await db.query(`select set_config('app.business_now', $1, true)`, [businessNow]);
  }
  await db.query(`select set_config('request.jwt.claim.sub', $1, true)`, [user.authId]);
  await db.query('set local role authenticated');
  let rows;
  try {
    rows = (await db.query(sql, params)).rows;
  } catch (error) {
    await db.query('rollback');
    throw error;
  }
  await db.query('reset role');
  await db.query('commit');
  return rows;
}

async function asOwnerAtClock(businessNow, sql, params = []) {
  await db.query('begin');
  if (businessNow !== undefined) {
    await db.query(`select set_config('app.business_now', $1, true)`, [businessNow]);
  }
  let rows;
  try {
    rows = (await db.query(sql, params)).rows;
  } catch (error) {
    await db.query('rollback');
    throw error;
  }
  await db.query('commit');
  return rows;
}

const at = (daysAgo, time = '10:15:00') => {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - daysAgo);
  return `${d.toISOString().slice(0, 10)} ${time}+03`;
};

let ninSeq = 0;
const nextNin = (prefix) => {
  ninSeq += 1;
  return `${prefix}${String(80_000_000 + ninSeq).padStart(8, '0')}WXYZ`.slice(0, 14);
};

let phoneSeq = 0;
const nextClientPhone = () => {
  phoneSeq += 1;
  return `+2567721${String(10_000 + phoneSeq).padStart(5, '0')}`;
};

// ---------------------------------------------------------------------------
// Clients and guarantors
// ---------------------------------------------------------------------------
const PEOPLE = [
  ['Nakimuli Zainabu', 'female', '1989-03-14', 'Market trader', 'Kalerwe', 'Kampala'],
  [
    'Ssemakula Kyagaba John',
    'male',
    '1984-07-02',
    'Boda boda rider',
    'Bwaise',
    'Kampala',
  ],
  [
    'Atuhaire Peace Kembabazi',
    'female',
    '1992-11-23',
    'Salon owner',
    'Ntinda',
    'Kampala',
  ],
  ['Mugisha Robert Tumwine', 'male', '1979-01-30', 'Carpenter', 'Kireka', 'Wakiso'],
  [
    'Nabirye Esther Mukisa',
    'female',
    '1995-05-19',
    'Produce vendor',
    'Kyanja',
    'Kampala',
  ],
  ['Opio Charles Ocen', 'male', '1987-09-08', 'Welder', 'Nansana', 'Wakiso'],
  ['Kabugho Janet Biira', 'female', '1990-12-01', 'Tailor', 'Kawempe', 'Kampala'],
  ['Byamukama Alex Mwesigwa', 'male', '1982-04-17', 'Shopkeeper', 'Kasangati', 'Wakiso'],
  [
    'Namukwaya Rehema Ssali',
    'female',
    '1993-08-25',
    'Food vendor',
    'Mpererwe',
    'Kampala',
  ],
  ['Tumusiime Fred Bagonza', 'male', '1986-02-11', 'Mechanic', 'Kyebando', 'Kampala'],
  ['Achan Doreen Lamwaka', 'female', '1991-06-06', 'Hairdresser', 'Komamboga', 'Kampala'],
  ['Kiggundu Moses Sserunjogi', 'male', '1977-10-29', 'Builder', 'Gayaza', 'Wakiso'],
  // Index 12. Active, and deliberately left without a disbursed loan: the
  // approved-but-not-disbursed fixture below needs a borrower `approve_loan`
  // will accept, and indexes 10 and 11 are the inactive and blacklisted ones.
  [
    'Nalubega Grace Kirabo',
    'female',
    '1994-02-08',
    'Poultry farmer',
    'Namugongo',
    'Wakiso',
  ],
];

const GUARANTOR_NAMES = [
  'Lubwama Patrick Ssentongo',
  'Nankya Milly Nabatanzi',
  'Ochieng Paul Odongo',
  'Birungi Sylvia Kyomuhendo',
  'Katamba Ismail Ssekandi',
  'Auma Florence Akech',
];

const clients = [];

for (const [
  index,
  [fullName, sex, dob, occupation, village, district],
] of PEOPLE.entries()) {
  const phone = nextClientPhone();

  const client = await one(
    `insert into public.clients
       (full_name, sex, date_of_birth, phone, alternative_phone, occupation,
        business_type, village_area, district, status, registered_at)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'active', now() - ($10 || ' days')::interval)
     returning id, client_number`,
    [
      fullName,
      sex,
      dob,
      phone,
      index % 3 === 0 ? nextClientPhone() : null,
      occupation,
      index % 2 === 0 ? 'Retail' : 'Services',
      village,
      district,
      String(120 - index * 6),
    ],
  );

  await q(`insert into public.client_identities (client_id, nin) values ($1, $2)`, [
    client.id,
    nextNin(sex === 'female' ? 'CF' : 'CM'),
  ]);

  const guarantorName = GUARANTOR_NAMES[index % GUARANTOR_NAMES.length];
  const guarantor = await one(
    `insert into public.guarantors
       (full_name, sex, date_of_birth, phone, occupation, location, photo_path)
     values ($1, $2, '1980-01-15', $3, 'Civil servant', $4,
             'guarantors/' || gen_random_uuid()::text || '/photo/a.jpg')
     returning id`,
    [
      `${guarantorName}${index >= GUARANTOR_NAMES.length ? ' II' : ''}`,
      index % 2 === 0 ? 'male' : 'female',
      nextClientPhone(),
      village,
    ],
  );
  await q(`insert into public.guarantor_identities (guarantor_id, nin) values ($1, $2)`, [
    guarantor.id,
    nextNin('CM'),
  ]);
  await q(
    `insert into public.client_guarantors (client_id, guarantor_id, relationship_to_client)
     values ($1, $2, $3)`,
    [client.id, guarantor.id, index % 2 === 0 ? 'Business associate' : 'Neighbour'],
  );

  clients.push({ ...client, fullName, phone });
}

// Two clients with a non-active status, so the directory shows the range.
await q(`update public.clients set status = 'inactive' where id = $1`, [clients[10].id]);
await q(
  `update public.clients
      set status = 'blacklisted',
          status_reason = 'Two written-off loans; not to be lent to again.'
    where id = $1`,
  [clients[11].id],
);

console.log(`${String(clients.length)} clients seeded`);

// ---------------------------------------------------------------------------
// Loans
// ---------------------------------------------------------------------------

/**
 * Attach the client's guarantors to an application, signed.
 *
 * Phase 13 moved a loan's guarantors onto the loan: `validate_loan_for_approval`
 * counts `loan_guarantors` and refuses an unsigned undertaking. This is what
 * the application screen does — offer the borrower's known backers, attach the
 * chosen ones, take each consent — so the seed does the same rather than
 * reaching past the rule it would otherwise trip over.
 *
 * Written as the table owner, which is what lets it set `consented_at`
 * directly. A real consent goes through the server action; what the harness
 * needs is a loan that has one.
 */
async function attachGuarantors(loanId, clientId) {
  await q(
    `insert into public.loan_guarantors
       (loan_id, guarantor_id, relationship_to_client,
        consent_terms_id, consent_version, consented_at,
        signature_name, witness_name, witness_phone, consent_place)
     select
       $1, cg.guarantor_id, cg.relationship_to_client,
       t.id, t.version, pg_catalog.now(),
       g.full_name, 'Nabirye Sarah', '+256700000900', 'Nsumbi, Kyebando'
     from public.client_guarantors cg
     join public.guarantors g on g.id = cg.guarantor_id
     left join public.guarantor_consent_terms t on t.is_current
     where cg.client_id = $2 and cg.active
     on conflict do nothing`,
    [loanId, clientId],
  );
}

/**
 * Create, approve and disburse a loan, with the disbursement back-dated.
 *
 * The draft, the approval and the schedule all go through the real path. Only
 * the disbursement timestamp is written directly, with the transition trigger
 * suspended, because `disbursed_at` is stamped from the transaction clock and
 * the schedule anchors on it — which is the only way to have loans at
 * different points in their life on one screenshot day.
 */
async function openLoan({
  client,
  principal,
  termMonths,
  frequency,
  daysAgo,
  notes,
  // Phase 9. Stops after approval so the disbursement screen has a loan to
  // show. Every other loan here is approved and disbursed together, which is
  // why the pre-Phase-9 screenshot pass could not reach that screen.
  stopAfterApproval = false,
}) {
  const draft = await asUser(
    secretary,
    `insert into public.loans
       (client_id, principal_amount, interest_rate_bps, interest_method,
        loan_term_months, repayment_frequency, min_loan_amount_applied,
        max_loan_amount_applied, grace_period_days_applied,
        penalty_rate_bps_applied, proposed_disbursement_date, notes)
     values ($1, $2, 1500, 'reducing_balance_monthly', $3, $4, 100000, 20000000, 3, 5000,
             current_date - $5::integer, $6)
     returning id`,
    [client.id, principal, termMonths, frequency, daysAgo, notes ?? null],
  );
  const loanId = draft[0].id;

  // Phase 13. Approval reads the application's own guarantors, not the
  // client's register, and refuses an undertaking nobody signed. So the seed
  // does what the application screen does: attach the client's known backers
  // to this loan and take each consent, before asking for a decision.
  await attachGuarantors(loanId, client.id);

  await asUser(
    secretary,
    `update public.loans set status = 'pending_approval' where id = $1`,
    [loanId],
  );
  await asUser(manager, `select public.approve_loan($1)`, [loanId]);

  if (stopAfterApproval) {
    const row = await one(`select loan_number from public.loans where id = $1`, [loanId]);
    return { loanId, ...row, client };
  }

  // Back-date the disbursement, then generate the schedule from it.
  await q(
    `alter table public.loans disable trigger loans_guard_transition_trigger`,
  ).catch(async () => {
    await q(`alter table public.loans disable trigger user`);
  });
  // The whole lifecycle is back-dated together, because the schema requires
  // the timestamps to be in order: submitted, then approved, then disbursed.
  await q(
    `update public.loans
        set status = 'active',
            created_at = $2::timestamptz,
            submitted_at = $3::timestamptz,
            approved_at = $4::timestamptz,
            disbursed_at = $5::timestamptz,
            disbursed_by = $6
      where id = $1`,
    [
      loanId,
      at(daysAgo + 4, '08:00:00'),
      at(daysAgo + 3, '09:30:00'),
      at(daysAgo + 1, '14:00:00'),
      at(daysAgo, '09:00:00'),
      owner.profileId,
    ],
  );
  await q(`alter table public.loans enable trigger user`);

  await asOwnerAtClock(
    at(daysAgo, '09:05:00'),
    `select public.generate_loan_schedule($1)`,
    [loanId],
  );

  const dates = await one(
    `select min(due_date)::text as first_due, max(due_date)::text as final_due,
            count(*)::int as installments,
            (select expected_amount from public.loan_installments
              where loan_id = $1 order by installment_number limit 1)::text as per_collection
       from public.loan_installments where loan_id = $1`,
    [loanId],
  );

  const loanRow = await one(`select loan_number from public.loans where id = $1`, [
    loanId,
  ]);

  return { loanId, ...dates, ...loanRow, client };
}

/** Post a payment at a chosen business instant, as the counter. */
async function collect(
  loanId,
  amount,
  { daysAgo, method = 'cash', reference = null, time = '11:30:00', actor = secretary },
) {
  const rows = await asUser(
    actor,
    `select public.post_payment($1, $2, $3, $4, $5, null) as id`,
    [loanId, amount, method, reference, randomUUID()],
    at(daysAgo, time),
  );
  return rows[0].id;
}

const dueEvery = { daily: 1, every_2_days: 2, every_3_days: 3 };

/**
 * Pay exactly the earliest uncovered obligation, which is the minimum the
 * ledger will accept and never more than is owed. Returns null when the loan
 * owes nothing, so a settled loan is skipped rather than refused.
 */
async function collectMinimum(loanId, options) {
  const next = await one(
    `select remaining_amount::text as amount
       from public.loan_obligations
      where loan_id = $1 and remaining_amount > 0
      order by effective_date, obligation_rank, sequence_number
      limit 1`,
    [loanId],
  );

  if (next === undefined) return null;

  return collect(loanId, Number(next.amount), options);
}

/** Pay every collection due up to `throughDaysAgo`, one payment per due date. */
async function payOnSchedule(
  loan,
  { frequency, throughDaysAgo, method, referencePrefix },
) {
  const step = dueEvery[frequency];
  const perCollection = Number(loan.per_collection);
  let n = 0;

  const dues = await q(
    `select due_date::text as due, expected_amount::text as amount
       from public.loan_installments where loan_id = $1 order by installment_number`,
    [loan.loanId],
  );

  for (const row of dues) {
    const dueDaysAgo = Math.round(
      (Date.now() - new Date(`${row.due}T00:00:00Z`).getTime()) / 86_400_000,
    );
    if (dueDaysAgo < throughDaysAgo) break;

    n += 1;
    await collect(loan.loanId, Number(row.amount), {
      daysAgo: dueDaysAgo,
      method,
      reference: method === 'cash' ? null : `${referencePrefix}${String(1000 + n)}`,
      time: n % 2 === 0 ? '09:40:00' : '14:05:00',
    });
  }

  void perCollection;
  void step;
  return n;
}

const loans = {};

// --- 1. Up to date, mid-schedule, paying daily in cash --------------------
loans.current = await openLoan({
  client: clients[0],
  principal: 600_000,
  termMonths: 1,
  frequency: 'daily',
  daysAgo: 12,
  notes: 'Stock purchase for the market stall.',
});
await payOnSchedule(loans.current, {
  frequency: 'daily',
  throughDaysAgo: 0,
  method: 'cash',
  referencePrefix: 'C',
});

// --- 2. Up to date, every 3 days, MTN -------------------------------------
loans.currentMtn = await openLoan({
  client: clients[1],
  principal: 900_000,
  termMonths: 2,
  frequency: 'every_3_days',
  daysAgo: 20,
  notes: 'Motorcycle repairs and licence renewal.',
});
await payOnSchedule(loans.currentMtn, {
  frequency: 'every_3_days',
  throughDaysAgo: 0,
  method: 'mtn_mobile_money',
  referencePrefix: 'MTN90',
});

// --- 3. Due today, nothing paid yet today ---------------------------------
loans.dueToday = await openLoan({
  client: clients[2],
  principal: 450_000,
  termMonths: 1,
  frequency: 'daily',
  daysAgo: 9,
  notes: 'Salon equipment.',
});
await payOnSchedule(loans.dueToday, {
  frequency: 'daily',
  throughDaysAgo: 1,
  method: 'airtel_money',
  referencePrefix: 'AIR70',
});

// --- 4. In arrears: four collections missed -------------------------------
loans.arrears = await openLoan({
  client: clients[3],
  principal: 750_000,
  termMonths: 1,
  frequency: 'daily',
  daysAgo: 16,
  notes: 'Timber stock.',
});
await payOnSchedule(loans.arrears, {
  frequency: 'daily',
  throughDaysAgo: 5,
  method: 'cash',
  referencePrefix: 'C',
});

// --- 5. In arrears, worse: eight collections missed, one reversal ---------
loans.arrearsDeep = await openLoan({
  client: clients[4],
  principal: 1_200_000,
  termMonths: 2,
  frequency: 'every_2_days',
  daysAgo: 30,
  notes: 'Produce buying round.',
});
await payOnSchedule(loans.arrearsDeep, {
  frequency: 'every_2_days',
  throughDaysAgo: 18,
  method: 'mtn_mobile_money',
  referencePrefix: 'MTN91',
});

// --- 6. In its grace period: term over, still owing ------------------------
loans.grace = await openLoan({
  client: clients[5],
  principal: 500_000,
  termMonths: 1,
  frequency: 'daily',
  daysAgo: 32,
  notes: 'Welding rods and gas.',
});
await payOnSchedule(loans.grace, {
  frequency: 'daily',
  throughDaysAgo: 8,
  method: 'cash',
  referencePrefix: 'C',
});

// --- 7. Charged: past the grace deadline, penalty on the ledger -----------
loans.charged = await openLoan({
  client: clients[6],
  principal: 400_000,
  termMonths: 1,
  frequency: 'daily',
  daysAgo: 45,
  notes: 'Fabric and thread.',
});
await payOnSchedule(loans.charged, {
  frequency: 'daily',
  throughDaysAgo: 33,
  method: 'cash',
  referencePrefix: 'C',
});
{
  const dates = await one(
    `select (max(due_date) + 4)::text as effective
       from public.loan_installments where loan_id = $1`,
    [loans.charged.loanId],
  );
  await asOwnerAtClock(
    `${dates.effective} 08:00:00+03`,
    `select public.ensure_penalty_applied($1)`,
    [loans.charged.loanId],
  );
}

// --- 8. Charged and part-paid against the charge --------------------------
loans.chargedPaying = await openLoan({
  client: clients[7],
  principal: 350_000,
  termMonths: 1,
  frequency: 'every_2_days',
  daysAgo: 50,
  notes: 'Shop restocking.',
});
await payOnSchedule(loans.chargedPaying, {
  frequency: 'every_2_days',
  throughDaysAgo: 34,
  method: 'airtel_money',
  referencePrefix: 'AIR71',
});
{
  const dates = await one(
    `select (max(due_date) + 4)::text as effective
       from public.loan_installments where loan_id = $1`,
    [loans.chargedPaying.loanId],
  );
  await asOwnerAtClock(
    `${dates.effective} 08:00:00+03`,
    `select public.ensure_penalty_applied($1)`,
    [loans.chargedPaying.loanId],
  );

  const owed = await one(
    `select total_outstanding::text as total from public.loan_balances where loan_id = $1`,
    [loans.chargedPaying.loanId],
  );
  // A large payment that clears the contract and spills into the charge.
  await collect(loans.chargedPaying.loanId, Math.round(Number(owed.total) * 0.7), {
    daysAgo: 2,
    method: 'cash',
    time: '10:20:00',
  });
}

// --- 9. Settled in full ----------------------------------------------------
loans.settled = await openLoan({
  client: clients[8],
  principal: 300_000,
  termMonths: 1,
  frequency: 'daily',
  daysAgo: 40,
  notes: 'Catering supplies.',
});
await payOnSchedule(loans.settled, {
  frequency: 'daily',
  throughDaysAgo: 10,
  method: 'cash',
  referencePrefix: 'C',
});
{
  const owed = await one(
    `select total_outstanding::text as total from public.loan_balances where loan_id = $1`,
    [loans.settled.loanId],
  );
  if (Number(owed.total) > 0) {
    await collect(loans.settled.loanId, Number(owed.total), {
      daysAgo: 9,
      method: 'mtn_mobile_money',
      reference: 'MTN920001',
      time: '15:10:00',
    });
  }
}

// --- 10. Settled earlier, second loan now running -------------------------
loans.settledOld = await openLoan({
  client: clients[9],
  principal: 250_000,
  termMonths: 1,
  frequency: 'daily',
  daysAgo: 95,
  notes: 'Spare parts.',
});
await payOnSchedule(loans.settledOld, {
  frequency: 'daily',
  throughDaysAgo: 64,
  method: 'cash',
  referencePrefix: 'C',
});
{
  const owed = await one(
    `select total_outstanding::text as total from public.loan_balances where loan_id = $1`,
    [loans.settledOld.loanId],
  );
  if (Number(owed.total) > 0) {
    await collect(loans.settledOld.loanId, Number(owed.total), {
      daysAgo: 63,
      method: 'cash',
      time: '16:00:00',
    });
  }
}
loans.repeat = await openLoan({
  client: clients[9],
  principal: 800_000,
  termMonths: 2,
  frequency: 'every_2_days',
  daysAgo: 14,
  notes: 'Second loan: workshop tools.',
});
await payOnSchedule(loans.repeat, {
  frequency: 'every_2_days',
  throughDaysAgo: 2,
  method: 'mtn_mobile_money',
  referencePrefix: 'MTN93',
});

// --- 11. Awaiting approval, and a draft -----------------------------------
{
  const pending = await asUser(
    secretary,
    `insert into public.loans
       (client_id, principal_amount, interest_rate_bps, interest_method,
        loan_term_months, repayment_frequency, min_loan_amount_applied,
        max_loan_amount_applied, grace_period_days_applied,
        penalty_rate_bps_applied, proposed_disbursement_date, notes)
     values ($1, 1500000, 1500, 'reducing_balance_monthly', 3, 'every_3_days', 100000,
             20000000, 3, 5000, current_date + 1,
             'Expanding the hardware shop. Guarantor verified in person.')
     returning id`,
    [clients[8].id],
  );
  loans.pending = { loanId: pending[0].id };
  await asUser(
    secretary,
    `update public.loans set status = 'pending_approval' where id = $1`,
    [loans.pending.loanId],
  );

  const draft = await asUser(
    secretary,
    `insert into public.loans
       (client_id, principal_amount, interest_rate_bps, interest_method,
        loan_term_months, repayment_frequency, min_loan_amount_applied,
        max_loan_amount_applied, grace_period_days_applied,
        penalty_rate_bps_applied, proposed_disbursement_date)
     values ($1, 350000, 1500, 'reducing_balance_monthly', 1, 'daily', 100000,
             20000000, 3, 5000, current_date + 2)
     returning id`,
    [clients[11].id],
  );
  loans.draft = { loanId: draft[0].id };
}

console.log('loans seeded');

// ---------------------------------------------------------------------------
// A reversed payment, so the register and the reports show one
// ---------------------------------------------------------------------------
{
  const extra = await collectMinimum(loans.arrears.loanId, {
    daysAgo: 3,
    method: 'mtn_mobile_money',
    reference: 'MTN940001',
    time: '12:00:00',
  });
  await asUser(
    owner,
    `select public.reverse_payment($1, $2)`,
    [extra, 'Recorded against the wrong loan; the borrower was paying for a relative.'],
    at(2, '09:15:00'),
  );
}

// ---------------------------------------------------------------------------
// Payments taken today, so the dashboards are not empty
// ---------------------------------------------------------------------------
await collectMinimum(loans.dueToday.loanId, {
  daysAgo: 0,
  method: 'cash',
  time: '08:45:00',
});
await collectMinimum(loans.currentMtn.loanId, {
  daysAgo: 0,
  method: 'mtn_mobile_money',
  reference: 'MTN950001',
  time: '09:20:00',
  actor: secondSecretary,
});
await collectMinimum(loans.repeat.loanId, {
  daysAgo: 0,
  method: 'airtel_money',
  reference: 'AIR720001',
  time: '10:05:00',
});
await collectMinimum(loans.arrearsDeep.loanId, {
  daysAgo: 0,
  method: 'cash',
  time: '11:40:00',
  actor: secondSecretary,
});
await collectMinimum(loans.grace.loanId, {
  daysAgo: 0,
  method: 'airtel_money',
  reference: 'AIR720002',
  time: '12:30:00',
});

// ---------------------------------------------------------------------------
// Internal remarks on the borrowers who are behind
// ---------------------------------------------------------------------------
const REMARKS = [
  [
    clients[3].id,
    'contact',
    'Visited the workshop. Promised to pay two collections on Friday after a delivery is settled.',
    manager,
  ],
  [
    clients[3].id,
    'payment_concern',
    'Second month running behind. Guarantor contacted and is aware.',
    manager,
  ],
  [
    clients[4].id,
    'payment_concern',
    'Produce round delayed by the rains. Says she will clear arrears within the week.',
    manager,
  ],
  [
    clients[4].id,
    'contact',
    'Called twice, no answer. Left a message with the shop next door.',
    owner,
  ],
  [
    clients[5].id,
    'contact',
    'Told him the grace period ends this week and a late charge follows. He understood.',
    manager,
  ],
  [
    clients[6].id,
    'payment_concern',
    'Late charge applied. Agreed a weekly instalment towards the balance.',
    owner,
  ],
  [
    clients[0].id,
    'business',
    'Stall is doing well; may qualify for a larger loan next cycle.',
    manager,
  ],
];

for (const [clientId, category, body, author] of REMARKS) {
  await asUser(
    author,
    `insert into public.client_remarks (client_id, category, body) values ($1, $2, $3)`,
    [clientId, category, body],
  );
}

console.log('remarks seeded');

// ---------------------------------------------------------------------------
// A borrower portal login, linked to the loan with arrears
// ---------------------------------------------------------------------------
{
  const portalClient = clients[3];
  const authEmail = `${portalClient.phone.slice(1)}@phone.lending.invalid`;

  const user = await one(
    `insert into auth.users (email, encrypted_password) values ($1, $2) returning id`,
    [authEmail, hashPassword(DEMO_PASSWORD)],
  );
  const profile = await one(
    `insert into public.profiles (auth_user_id, full_name, phone, status)
     values ($1, $2, $3, 'active') returning id`,
    [user.id, portalClient.fullName, portalClient.phone],
  );
  await q(`insert into public.user_roles (profile_id, role_key) values ($1, 'client')`, [
    profile.id,
  ]);
  // `link_client_profile` is callable only by `service_role` — the application
  // reaches it through the privileged client for exactly this reason — so the
  // seeder switches into that role rather than pretending to be the Owner.
  await db.query('begin');
  await db.query('set local role service_role');
  await db.query(`select public.link_client_profile($1, $2)`, [
    portalClient.id,
    profile.id,
  ]);
  await db.query('reset role');
  await db.query('commit');

  console.log(`portal borrower: ${portalClient.phone}`);
}

// ---------------------------------------------------------------------------
// Phase 9 fixtures: the two states the screenshot pass could not reach
// ---------------------------------------------------------------------------
{
  // An approved loan that has not been disbursed, so the disbursement screen
  // has something to show. Every other loan in this seed was approved and
  // disbursed together; this one stops one step earlier.
  const approved = await openLoan({
    client: clients[12],
    principal: 500_000,
    termMonths: 1,
    frequency: 'daily',
    daysAgo: 0,
    notes: 'Approved this morning; the money has not left the drawer.',
    stopAfterApproval: true,
  });
  loans.approvedNotDisbursed = approved;
}

{
  // A staff account holding an administrator-issued temporary password, so
  // the forced-password-change flow is reachable. The flag is the database's
  // to maintain, so it is set the way `reset_user_password` sets it.
  await db.query('begin');
  await db.query('set local role service_role');
  await db.query(
    `update public.profiles set must_change_password = true where phone = $1`,
    ['+256772100104'],
  );
  await db.query('reset role');
  await db.query('commit');
  console.log('temporary-password account: +256772100104');
}

// ---------------------------------------------------------------------------
// The fixture manifest
//
// Written as JSON beside the harness so a spec refers to a loan by what it
// *is* — "the loan in arrears" — rather than by a uuid pasted into a test.
// ---------------------------------------------------------------------------
{
  const { writeFileSync } = require('node:fs');

  const manifest = {
    staff: {
      owner: '+256772100101',
      manager: '+256772100102',
      secretary: '+256772100103',
      temporaryPassword: '+256772100104',
    },
    borrower: '+256772110008',
    clients: {
      arrears: clients[3].id,
      current: clients[0].id,
    },
    loans: {
      current: loans.current.loanId,
      arrears: loans.arrears.loanId,
      charged: loans.charged.loanId,
      grace: loans.grace.loanId,
      pending: loans.pending.loanId,
      draft: loans.draft.loanId,
      approvedNotDisbursed: loans.approvedNotDisbursed.loanId,
    },
  };

  writeFileSync(
    new URL('./fixtures.json', import.meta.url),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  console.log('fixtures written');
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------
const summary = await one(
  `select loans_total::text, loans_active::text, loans_cleared::text,
          total_collected::text, total_outstanding::text, arrears_total::text,
          penalty_assessed::text, loans_with_arrears::text,
          loans_state_grace_period::text, loans_penalised::text
     from public.dashboard_portfolio_summary`,
);
const today = await one(
  `select expected_today::text, collected_today::text, remaining_today::text,
          loans_due_today::text, cash_received::text, mtn_received::text,
          airtel_received::text
     from public.dashboard_collection_summary`,
);

console.log('\nportfolio:', summary);
console.log('today:', today);

const states = await q(
  `select delinquency_state, count(*)::int as n from public.loan_delinquency
    group by 1 order by 1`,
);
console.log(
  'states:',
  states.map((r) => `${r.delinquency_state}=${String(r.n)}`).join(' '),
);

// ---------------------------------------------------------------------------
// The ledger
//
// Most of this seed goes through the real functions, which post their own
// journals. The disbursements do not: they are back-dated with the
// transition guard suspended, so `disburse_loan` never runs and its journal
// is never written. `backfill_ledger_history` posts whatever is missing —
// here, the opening capital and the disbursements — and skips everything
// already posted, which is the same idempotency the migration relies on.
// ---------------------------------------------------------------------------
{
  const ledger = await one(`select * from public.backfill_ledger_history()`);
  console.log(
    `ledger: opening ${ledger.opening}, ${ledger.disbursements} disbursements, ` +
      `${ledger.repayments} repayments, ${ledger.reversals} reversals`,
  );

  const trial = await one(
    `select sum(total_debit)::text as debits, sum(total_credit)::text as credits
       from public.trial_balance`,
  );
  if (trial.debits !== trial.credits) {
    throw new Error(
      `seed left the ledger unbalanced: debits ${trial.debits}, credits ${trial.credits}`,
    );
  }
  console.log(`trial balance: ${trial.debits} both sides`);
}

await db.end();
console.log('\nSEED COMPLETE');
