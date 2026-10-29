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
  // Indexes 13, 14 and 15. Polytos Phase 3, and left out of the loan book on
  // purpose: `active_loan_exists` refuses a second live loan to anybody, and
  // every one of the five members above was chosen for what their *savings*
  // demonstrate — all five already hold a live loan. So the members a member
  // loan can actually be written against are people whose only loan is that
  // member loan.
  //
  // Three of them, not two, and the third is not padding. The browser suite
  // approves a member loan in a real browser, and an approval takes a pledge
  // against the member's savings and makes them hold a live loan — so a
  // member used for that cannot also be the member whose eligibility panel is
  // asserted to read "may borrow". Index 15 exists so the write spec has
  // somebody of its own to approve and the read-only spec does not depend on
  // which file ran first.
  [
    'Nsubuga Ronald Kaggwa',
    'male',
    '1988-06-21',
    'Dairy trader',
    'Kyaliwajjala',
    'Wakiso',
  ],
  ['Namutebi Sarah Nakato', 'female', '1991-03-04', 'Grocer', 'Bukoto', 'Kampala'],
  [
    'Wasswa Emmanuel Kizza',
    'male',
    '1986-11-12',
    'Hardware dealer',
    'Kiwatule',
    'Kampala',
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
// Polytos Phase 2: membership and savings
//
// Four members, their savings histories, a withdrawal through its whole
// lifecycle, and one application still waiting on its consent. The shapes
// mirror `scripts/seed-demo.ts` — which is the seeder the business will run —
// but this one is written for the browser suite: it seeds exactly what the
// savings specs assert against and nothing more.
//
// Everything goes through the real functions: `enrol_member`,
// `post_savings_deposit`, `request_savings_withdrawal`,
// `decide_savings_withdrawal`, `post_savings_withdrawal` and
// `reverse_savings_transaction`. A seeder that wrote the rows directly would
// produce a database the application cannot produce, and the browser suite
// would be testing screens against data they will never meet.
//
// Only one thing is bypassed, and it is a clock: `app.business_now` is set per
// deposit so the savings history has months in it rather than everything
// landing this morning. The override is honoured only for a direct owner
// session, which no application path has.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Skipped where the Polytos schema is not there
//
// This file has two callers. The browser harness runs it against a database
// with every migration applied, which is where the block below belongs. But
// `scripts/verify-membership-upgrade.mjs` runs it against the schema as it
// stood **before** Polytos — deliberately, because the whole point of that
// script is to build a representative book on the released schema and then
// prove the Polytos migrations move none of it.
//
// So the block is conditional on the tables existing rather than on a flag.
// A flag would be a second thing to keep in step; asking the catalogue is
// the same question the database would answer anyway.
// ---------------------------------------------------------------------------
const polytosPresent = await one(
  `select pg_catalog.to_regclass('public.savings_accounts') is not null as present`,
);

const polytos = polytosPresent.present
  ? await seedMembershipAndSavings()
  : (console.log('membership and savings skipped: the Polytos schema is not present'),
    null);

async function seedMembershipAndSavings() {
  // A policy version in force, with the savings rules decided — which is what
  // `is_savings_enabled` waits on, and therefore what makes the savings module
  // open at all. The migration seeds version 1.0 as an unapproved draft, so the
  // harness publishes its own rather than editing the seed's.
  // Polytos Phase 3. The savings-to-loan multiplier the harness lends at.
  //
  // ## Why the harness answers three of the four decisions and not the fourth
  //
  // Member lending needs four answers: the interest basis, the interest
  // method, the savings-to-loan multiplier, and what a monthly collection
  // does in a month that has no such day. The business has settled none of
  // them, and the hosted demonstration shows exactly that — four decisions
  // outstanding, applications preparable, nothing approvable.
  //
  // A browser suite that only ever met that state could not see the member
  // loan screens at all: no eligibility ceiling, no repayment preview, no
  // approved loan, no pledge, no schedule. So this harness answers the three
  // **policy** questions with figures of its own — illustrative, and said to
  // be so in the version's own notes, like every other figure here — and
  // leaves the fourth, the month anchor, open.
  //
  // That is not a convenience. It is the most informative single state the
  // system has:
  //
  //   * weekly member loans of one and two months can be priced, approved,
  //     scheduled and collected, so every Phase 3 screen has real data;
  //   * three-, four- and five-month loans are still refused, because they
  //     need the monthly cadence and the monthly cadence needs the anchor —
  //     which is the consequence of answering only three of the four, and the
  //     one nobody would guess from reading the questions;
  //   * the status banner still names an outstanding decision, so the screen
  //     that exists to say what is missing has something to say.
  //
  // The fully blocked state — nothing priceable at all — is covered by the
  // database suite's refusals and by `scripts/demo-member-loans.ts`.
  //
  // They are written into this INSERT rather than updated afterwards because
  // an approved version is immutable: `membership_policy_versions_guard`
  // refuses to let anybody answer an open question on a version members are
  // already enrolled under, which is the whole point of freezing it.
  const MEMBER_MULTIPLIER_BPS = 15_000;

  // Polytos Phase 4. The harness's own illustrative answers to the benefit
  // rules, and **not** decisions of the business. Three of them have to be
  // answered or `is_benefits_enabled` stays false and no claim in the harness
  // could be assessed at all; the fourth, the benefit year, is the tenth
  // decision §9 of the brief names.
  //
  // The cap is deliberately small — two ordinary hospital bills reach it — so
  // the screen that explains a claim held by the ceiling has a real claim to
  // explain. The waiting period is 30 days, which is why the memberships are
  // back-dated below: measured from an activation this morning, every claim in
  // the harness would be held for that one reason and nine other things would
  // be hidden.
  const BENEFIT_ANNUAL_CAP = 150_000;
  const BENEFIT_CLAIMS_PER_YEAR = 3;
  const BENEFIT_WAITING_DAYS = 30;
  const BENEFIT_YEAR_BASIS = 'calendar_year';
  const BENEFIT_ACTIVATION_DAYS_AGO = 220;

  const policyVersion = await one(
    `insert into public.membership_policy_versions
     (version, title, effective_from, status, approved_at, approved_by_label,
      approval_reference,
      registration_fee, monthly_savings_minimum, savings_qualifying_months,
      member_loan_interest_rate_bps, member_loan_max_term_months,
      member_loan_weekly_cadence_max_months, non_member_loan_max_term_months,
      medical_benefit_rate_bps, medical_benefit_min_admission_days,
      family_condolence_benefit, member_bereavement_benefit,
      qualifying_months_consecutive, savings_withdrawal_with_active_loan,
      interest_basis, interest_method, savings_to_loan_multiplier_bps,
      medical_benefit_annual_cap, medical_benefit_claims_per_year,
      benefit_waiting_period_days, medical_benefit_year_basis,
      medical_benefit_cap_mode, benefit_qualification_basis, death_confirmations_required,
      notes)
   values
     ('998.2', 'Polytos membership terms (harness)',
      (public.business_date() - 400), 'active',
      now(), 'Harness', 'HARNESS-2026-01',
      5000, 50000, 6,
      500, 5, 2, 3,
      500, 1, 100000, 200000,
      false, 'allowed',
      'per_month', 'reducing_balance_monthly', $1::int,
      $2::bigint, $3::int, $4::int, $5,
      'amount', 'waiting_period_days', 3,
      'Published by the browser-test harness. Illustrative figures. The '
        || 'interest basis, the interest method and the savings multiplier '
        || 'are the harness''s own illustrative answers and are NOT decisions '
        || 'of the business; the monthly collection anchor is left open, which '
        || 'is why member loans beyond two months are still refused. Polytos '
        || 'Phase 4 adds four more illustrative answers — the medical annual '
        || 'cap, the claims a member may make in a year, the waiting period '
        || 'and whether the benefit year runs from January — because '
        || 'is_benefits_enabled waits on three of them and nothing could be '
        || 'assessed without them. The profit distribution basis is left open, '
        || 'so the policy screen still has an undecided rule to name.')
   returning id, version`,
    [
      MEMBER_MULTIPLIER_BPS,
      BENEFIT_ANNUAL_CAP,
      BENEFIT_CLAIMS_PER_YEAR,
      BENEFIT_WAITING_DAYS,
      BENEFIT_YEAR_BASIS,
    ],
  );

  /** The first day of the month `back` months before today. */
  const monthDay = (back, day) => {
    const now = new Date();
    const shifted = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - back, day),
    );
    return shifted.toISOString().slice(0, 10);
  };

  /**
   * Enrol a member and post a dated savings history.
   *
   * The witness is the Manager and the enrolling session is the owner's, so the
   * acceptance guard's "a witness cannot be the person recording it" rule is
   * satisfied honestly rather than worked around.
   */
  async function enrolWithSavings(client, deposits) {
    const enrolled = await one(
      `select public.enrol_member(
              $1, 'cash', null, 'witnessed_in_branch', $2, gen_random_uuid(),
              null, $3::uuid, null, null, null, null, 'Harness enrolment') as id`,
      [client.id, client.fullName, manager.profileId],
    );

    const account = await one(
      `select id, account_number from public.savings_accounts where membership_id = $1`,
      [enrolled.id],
    );

    for (const [monthsBack, amounts] of deposits) {
      for (const amount of amounts) {
        await asOwnerAtClock(
          `${monthDay(monthsBack, monthsBack === 0 ? new Date().getUTCDate() : 12)} 10:00:00+03`,
          `select public.post_savings_deposit($1, $2, 'cash', null, gen_random_uuid(),
                                            'Harness deposit')`,
          [account.id, amount],
        );
      }
    }

    const membership = await one(
      `select membership_number, status from public.memberships where id = $1`,
      [enrolled.id],
    );

    return {
      membershipId: enrolled.id,
      membershipNumber: membership.membership_number,
      savingsAccountId: account.id,
      accountNumber: account.account_number,
    };
  }

  // The member who has served the whole qualifying period: six unbroken months
  // at the minimum. The one a Phase 3 member loan will be approved against.
  //
  // Deliberately `clients[3]` — the borrower who already has a portal login and
  // a loan in arrears. Two things follow from that, both wanted: the portal's
  // savings panel has a real history to render, and the withdrawal screen meets
  // a member who also holds a live loan, which is what exercises
  // `client_has_live_loan` and the policy's rule about it.
  const memberQualified = await enrolWithSavings(clients[3], [
    [6, [50_000]],
    [5, [50_000]],
    [4, [50_000]],
    [3, [50_000]],
    [2, [50_000]],
    [1, [50_000]],
  ]);

  // Six qualifying months with a gap in the middle — six months, longest
  // unbroken run of three. The whole difference the undecided consecutive rule
  // makes, in one member.
  const memberGapped = await enrolWithSavings(clients[1], [
    [7, [50_000]],
    [6, [50_000]],
    [5, [50_000]],
    [3, [50_000]],
    [2, [50_000]],
    [1, [50_000]],
  ]);

  // On track, and this month met by two deposits rather than one — which is how
  // a member who cannot find UGX 50,000 at once still makes the month.
  const memberSaving = await enrolWithSavings(clients[2], [
    [2, [50_000]],
    [1, [30_000, 20_000]],
    [0, [25_000, 25_000]],
  ]);

  // Saved, then withdrew. Carries the withdrawal that went all the way through,
  // and a duplicate deposit that was reversed.
  const memberWithdrawn = await enrolWithSavings(clients[4], [
    [3, [60_000]],
    [2, [60_000]],
    [1, [60_000]],
  ]);

  // The withdrawal. Prepared as the Secretary and decided as the Manager,
  // through real `authenticated` sessions — so `decide_savings_withdrawal`'s
  // refusal of a decision from the requester is a control this data went
  // through rather than one it skipped.
  const withdrawalRequestId = await (async () => {
    await db.query('begin');
    await db.query(`select set_config('request.jwt.claim.sub', $1, true)`, [
      secretary.authId,
    ]);
    await db.query('set local role authenticated');
    const prepared = (
      await db.query(
        `select public.request_savings_withdrawal(
                $1, 40000, 'School fees for the second term') as id`,
        [memberWithdrawn.savingsAccountId],
      )
    ).rows[0];
    await db.query('reset role');
    await db.query('commit');

    await db.query('begin');
    await db.query(`select set_config('request.jwt.claim.sub', $1, true)`, [
      manager.authId,
    ]);
    await db.query('set local role authenticated');
    await db.query(
      `select public.decide_savings_withdrawal($1, true, 'Checked the balance and the loan position')`,
      [prepared.id],
    );
    await db.query(
      `select public.post_savings_withdrawal($1, 'cash', null, gen_random_uuid())`,
      [prepared.id],
    );
    await db.query('reset role');
    await db.query('commit');

    return prepared.id;
  })();

  // A deposit recorded twice and reversed, so the statement screens have a
  // correction to render. A reversal is a contra row, never an edit, so the
  // original stays in the statement beside it.
  {
    const duplicate = await one(
      `select public.post_savings_deposit($1, 15000, 'cash', null, gen_random_uuid(),
                                        'Recorded twice at the counter') as id`,
      [memberWithdrawn.savingsAccountId],
    );
    await q(
      `select public.reverse_savings_transaction(
              $1, 'The same deposit was recorded twice at the counter')`,
      [duplicate.id],
    );
  }

  // A withdrawal waiting for a decision, so the queue is not empty when a
  // Manager opens it. Prepared as the Secretary, who may prepare one and may
  // not decide it.
  const pendingWithdrawalId = await (async () => {
    await db.query('begin');
    await db.query(`select set_config('request.jwt.claim.sub', $1, true)`, [
      secretary.authId,
    ]);
    await db.query('set local role authenticated');
    const prepared = (
      await db.query(
        `select public.request_savings_withdrawal(
                $1, 75000, 'Stock for the shop before the school term') as id`,
        [memberSaving.savingsAccountId],
      )
    ).rows[0];
    await db.query('reset role');
    await db.query('commit');
    return prepared.id;
  })();

  // An application whose fee is paid and whose consent is not verified, so it
  // stays `pending`. The ADR-050 activation preconditions seen from the
  // outside, and the state the membership record's own panel explains.
  const memberPending = await (async () => {
    const membership = await one(
      `insert into public.memberships (client_id, applied_on, policy_version_id, notes)
     values ($1, (public.business_date() - 9), $2,
             'Application taken at the branch. The terms have not been accepted yet.')
     returning id, membership_number`,
      [clients[6].id, policyVersion.id],
    );

    await q(
      `select public.record_membership_fee($1, 5000, 'cash', null, gen_random_uuid(),
                                         'Registration fee, paid at the counter')`,
      [membership.id],
    );

    return {
      membershipId: membership.id,
      membershipNumber: membership.membership_number,
    };
  })();

  // A membership card for the qualified member, so the card panel has one to
  // render and a verification code to show.
  await q(`select public.issue_membership_card($1, 'first_issue')`, [
    memberQualified.membershipId,
  ]);

  // -------------------------------------------------------------------------
  // Polytos Phase 3: member lending
  //
  // The three policy answers are in the version above, where they had to be.
  // What is left is the configuration the business would change on a screen:
  // the product, and the cadence it may be collected on.
  //
  // The product the business would activate once it had decided. Member loans
  // are priced from the borrower's own policy version rather than from the
  // product, which is what `interest_source = 'membership_policy'` means, so
  // activating it settles nothing the policy has not already settled.
  //
  // Weekly only, because the monthly cadence has no anchor and is therefore
  // still inactive. A product offering a cadence the business cannot schedule
  // would be an application form that leads to a refusal.
  await q(
    `update public.loan_products
        set status = 'active',
            allowed_repayment_frequencies = array['weekly'],
            default_repayment_frequency = 'weekly'
      where product_code = 'ML'`,
  );

  const memberProduct = await one(
    `select id, min_amount::text, max_amount::text, grace_period_days::text,
            penalty_rate_bps::text
       from public.loan_products where product_code = 'ML'`,
  );

  /**
   * Enrol a member with six unbroken qualifying months and no other loan.
   *
   * Six months at the minimum is what `savings_qualifying_months` requires, so
   * these two qualify under either arm of the consecutive rule — which keeps
   * them qualified whichever way the business eventually answers question 4.
   */
  const enrolBorrowingMember = (client) =>
    enrolWithSavings(client, [
      [6, [50_000]],
      [5, [50_000]],
      [4, [50_000]],
      [3, [50_000]],
      [2, [50_000]],
      [1, [50_000]],
    ]);

  const memberBorrowing = await enrolBorrowingMember(clients[13]);
  const memberApplying = await enrolBorrowingMember(clients[14]);
  const memberApproving = await enrolBorrowingMember(clients[15]);

  /**
   * Drive a member loan through the real path, as the real people.
   *
   * Nothing here is written around the engine. The draft carries no rate —
   * `approve_loan` reads the borrower's own frozen policy version and prices
   * it, writes the eligibility snapshot the decision was made on, and pledges
   * the savings that secure it. Approval is the Manager's and disbursement is
   * the Owner's, because the Manager does not hold `loans:disburse`: a
   * harness that used one profile for both would render that separation as
   * though it were not there.
   */
  async function openMemberLoan({
    client,
    membershipId,
    principal,
    termMonths,
    daysAgo,
  }) {
    void membershipId;

    const draft = await asUser(
      secretary,
      `insert into public.loans
         (client_id, loan_product_id, principal_amount, interest_rate_bps,
          interest_method, loan_term_months, repayment_frequency,
          min_loan_amount_applied, max_loan_amount_applied,
          grace_period_days_applied, penalty_rate_bps_applied,
          proposed_disbursement_date, notes)
       values ($1, $2, $3, 0, 'reducing_balance_monthly', $4, 'weekly',
               $5, $6, $7, $8,
               -- An application still waiting for a decision proposes today,
               -- not a day in the past: daysAgo is null for that case.
               current_date - coalesce($9::integer, 0), $10)
       returning id`,
      [
        client.id,
        memberProduct.id,
        principal,
        termMonths,
        Number(memberProduct.min_amount),
        Number(memberProduct.max_amount),
        Number(memberProduct.grace_period_days),
        Number(memberProduct.penalty_rate_bps),
        daysAgo,
        'Member loan against savings, secured by the pledge.',
      ],
    );

    const loanId = draft[0].id;
    await attachGuarantors(loanId, client.id);

    if (daysAgo === null) {
      // Left as a draft on purpose: the approval screen exists to show an
      // application waiting for a decision, and a harness without one could
      // not reach it.
      const row = await one(`select loan_number from public.loans where id = $1`, [
        loanId,
      ]);
      return { loanId, ...row, client };
    }

    await asUser(
      secretary,
      `update public.loans set status = 'pending_approval' where id = $1`,
      [loanId],
    );
    await asUser(manager, `select public.approve_loan($1)`, [loanId]);

    // Back-dated the same way every other loan here is, and for the same
    // reason: the schedule anchors on `disbursed_at`, so a loan disbursed
    // today has every collection still ahead of it and nothing to show.
    await q(`alter table public.loans disable trigger user`);
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

    const row = await one(
      `select l.loan_number,
              (select count(*)::int from public.loan_installments i
                where i.loan_id = l.id) as installments,
              (select p.pledged_amount::text from public.member_loan_savings_pledges p
                where p.loan_id = l.id) as pledged
         from public.loans l where l.id = $1`,
      [loanId],
    );

    return { loanId, ...row, client };
  }

  // Running, with two of its eight weekly collections made. 300,000 against
  // 300,000 saved at 1.5×, so 200,000 of the member's savings is pledged and
  // 100,000 of it is still theirs to withdraw — the arithmetic the eligibility
  // panel exists to show, with a figure on either side of it.
  const memberLoanActive = await openMemberLoan({
    client: clients[13],
    membershipId: memberBorrowing.membershipId,
    principal: 300_000,
    termMonths: 2,
    daysAgo: 20,
  });

  for (const collectionDaysAgo of [13, 6]) {
    await collectMinimum(memberLoanActive.loanId, {
      daysAgo: collectionDaysAgo,
      method: 'cash',
      reference: null,
    });
  }

  // And two waiting for a decision. One is read-only evidence that an
  // application can sit in the pipeline; the other is the one the browser
  // suite actually submits and approves, which is why it belongs to a member
  // nothing else asserts about.
  const memberLoanDraft = await openMemberLoan({
    client: clients[14],
    membershipId: memberApplying.membershipId,
    principal: 200_000,
    termMonths: 1,
    daysAgo: null,
  });

  const memberLoanToApprove = await openMemberLoan({
    client: clients[15],
    membershipId: memberApproving.membershipId,
    principal: 250_000,
    termMonths: 2,
    daysAgo: null,
  });

  {
    const pledged = await one(
      `select coalesce(sum(pledged_amount), 0)::text as total,
              count(*)::int as n
         from public.member_loan_savings_pledges where released_at is null`,
    );

    const liability = await one(
      `select
       (select coalesce(sum(signed_amount), 0)::bigint
          from public.savings_transactions)::text as subledger,
       (select balance::text from public.ledger_account_balances where code = '2100')
         as ledger`,
    );

    // A pledge restricts savings; it does not spend them. If this ever failed,
    // member lending would be quietly taking money out of members' accounts.
    if (liability.subledger !== liability.ledger) {
      throw new Error(
        `a pledge moved money: subledger ${liability.subledger} against ` +
          `ledger 2100 ${liability.ledger}`,
      );
    }

    console.log(
      `member lending: ${String(pledged.n)} pledge(s) holding ${pledged.total}; ` +
        `${memberLoanActive.loan_number} active with ` +
        `${String(memberLoanActive.installments)} weekly collections, ` +
        `${memberLoanDraft.loan_number} and ${memberLoanToApprove.loan_number} ` +
        'awaiting approval',
    );
  }

  // -------------------------------------------------------------------------
  // Polytos Phase 4: next of kin, benefit claims and meetings
  //
  // Everything here goes through the same functions the screens call, as the
  // same people: the Secretary records and brings the papers, the Manager
  // checks the papers and assesses, the Owner approves, the Manager pays. Not
  // one of those steps could be done by another of them —
  // `verify_benefit_document` refuses the person who attached the document and
  // `approve_benefit_claim` refuses whoever assessed the claim — so a harness
  // that used one session throughout would seed data the product cannot
  // produce, and the screens would be demonstrating controls that were never
  // exercised.
  // -------------------------------------------------------------------------
  const benefits = await (async () => {
    // The memberships are enrolled this morning, and the waiting period above
    // is measured from activation. So they are moved back, under the same
    // owner-level trigger exemption the test fixtures and the demonstration
    // seeder use — and the result is more coherent rather than less, because
    // six months of savings deposits on a membership activated today never
    // made sense either.
    await q(
      `alter table public.memberships disable trigger memberships_guard_transition`,
    );
    try {
      await q(
        `update public.memberships
            set applied_on = (public.business_date() - $1::int),
                activated_on = case
                  when activated_on is null then null
                  else (public.business_date() - $1::int)
                end
          where applied_on > (public.business_date() - $1::int)`,
        [BENEFIT_ACTIVATION_DAYS_AGO],
      );
    } finally {
      await q(
        `alter table public.memberships enable trigger memberships_guard_transition`,
      );
    }

    // Which relatives a condolence benefit covers is undecided, and the
    // harness answers it for three of them so one arm of the rule can be seen
    // working. The label says TEST ONLY because the label is what a reader
    // sees on the form; every other relationship stays NULL, so a cousin still
    // produces `relationship_eligibility_undecided`.
    await q(
      `update public.beneficiary_relationships
          set condolence_eligible = true,
              label = label || ' (harness: treated as eligible)'
        where key in ('spouse', 'child', 'parent') and condolence_eligible is null`,
    );

    /** An object in the evidence bucket, so a document can be attached to it. */
    const putObject = async (membershipId, kind, subject, seed) => {
      const path = `benefits/${membershipId}/${kind}/${subject}/${seed}.pdf`;
      await q(
        `insert into storage.objects (bucket_id, name, metadata)
         values ('benefit-documents', $1, jsonb_build_object('size', 20480))
         on conflict (bucket_id, name) do nothing`,
        [path],
      );
      return path;
    };

    /** Attach the evidence a claim of this type cannot be assessed without. */
    const attachRequired = async (claimId, membershipId, kinds) => {
      const ids = [];
      for (const kind of kinds) {
        const path = await putObject(membershipId, kind, claimId, `${kind}-harness`);
        const [row] = await asUser(
          secretary,
          `select public.attach_benefit_document(
                    $1, null, $2, $3, 'application/pdf', 20480,
                    'Harness evidence') as id`,
          [claimId, kind, path],
        );
        ids.push(row.id);
      }
      return ids;
    };

    // --- The next of kin ---------------------------------------------------
    //
    // One verified and one left unchecked. The unchecked one is the state the
    // register exists to find: a bereavement benefit that cannot be paid, and
    // nobody discovers it at a convenient moment.
    const [verifiedBeneficiary] = await asUser(
      secretary,
      `select public.register_member_beneficiary(
                $1, 'Hadija Nakato', 'spouse', '+256772120001', null,
                'Kalerwe', 'Kampala', 'national_id', 'CM91000001HARN', true, null) as id`,
      [memberQualified.membershipId],
    );

    {
      const path = await putObject(
        memberQualified.membershipId,
        'relationship_evidence',
        'beneficiary',
        'beneficiary-harness',
      );

      await asUser(
        secretary,
        `select public.attach_benefit_document(
                  null, $1, 'relationship_evidence', $2, 'application/pdf', 20480,
                  'Harness relationship evidence')`,
        [verifiedBeneficiary.id, path],
      );

      // The Manager, never the Secretary who recorded it: two hands, enforced
      // in the database rather than by this harness remembering.
      await asUser(
        manager,
        `select public.verify_member_beneficiary(
                  $1, true, 'relationship_document', $2,
                  'Checked against the marriage certificate.')`,
        [verifiedBeneficiary.id, path],
      );
    }

    const [pendingBeneficiary] = await asUser(
      secretary,
      `select public.register_member_beneficiary(
                $1, 'Peter Atim', 'child', '+256772120002', null,
                'Kawempe', 'Kampala', null, null, true, null) as id`,
      [memberSaving.membershipId],
    );

    // --- A medical claim paid end to end ----------------------------------
    //
    // Four nights, five ward days, four clock days: longer than one day on
    // every reading, so the measure question does not arise. 5% of 400,000 is
    // exactly 20,000 — the figure the brief itself quotes.
    const paidClaim = await (async () => {
      const [opened] = await asUser(
        secretary,
        `select public.open_benefit_claim(
                  $1, 'medical', null, 'Mulago Specialised Hospital',
                  (((public.business_date() - 24) + interval '8 hours')
                     at time zone 'Africa/Kampala'),
                  (((public.business_date() - 20) + interval '10 hours')
                     at time zone 'Africa/Kampala'),
                  400000, null, null, null) as id`,
        [memberQualified.membershipId],
      );

      const documents = await attachRequired(opened.id, memberQualified.membershipId, [
        'hospital_admission',
        'medical_invoice',
      ]);

      await asUser(secretary, `select public.submit_benefit_claim($1)`, [opened.id]);
      await asUser(manager, `select public.begin_benefit_verification($1)`, [opened.id]);

      for (const documentId of documents) {
        await asUser(
          manager,
          `select public.verify_benefit_document($1, true,
                    'Checked against the admission record.')`,
          [documentId],
        );
      }

      await asUser(
        manager,
        `select public.assess_benefit_claim($1,
                  'Four nights, invoice and admission record both checked.')`,
        [opened.id],
      );

      // The Owner, because `approve_benefit_claim` refuses an approval from
      // whoever assessed — by name as well as by account, so it holds even for
      // somebody who holds both capabilities.
      await asUser(
        owner,
        `select public.approve_benefit_claim($1, null, 'Approved at the assessed figure.')`,
        [opened.id],
      );

      await asUser(
        manager,
        `select public.post_benefit_payment($1, 'cash', null, gen_random_uuid())`,
        [opened.id],
      );

      return one(
        `select id, claim_number, approved_amount::text as amount
           from public.benefit_claims where id = $1`,
        [opened.id],
      );
    })();

    // --- A medical claim assessed and waiting for an approver -------------
    //
    // So the approval queue is not empty when an Owner opens it, and so the
    // browser suite has a claim to approve and pay without first having to
    // build one.
    const claimToApprove = await (async () => {
      const [opened] = await asUser(
        secretary,
        `select public.open_benefit_claim(
                  $1, 'medical', null, 'Nsambya Hospital',
                  (((public.business_date() - 14) + interval '7 hours')
                     at time zone 'Africa/Kampala'),
                  (((public.business_date() - 11) + interval '11 hours')
                     at time zone 'Africa/Kampala'),
                  260000, null, null, null) as id`,
        [memberGapped.membershipId],
      );

      const documents = await attachRequired(opened.id, memberGapped.membershipId, [
        'hospital_admission',
        'medical_invoice',
      ]);

      await asUser(secretary, `select public.submit_benefit_claim($1)`, [opened.id]);
      await asUser(manager, `select public.begin_benefit_verification($1)`, [opened.id]);

      for (const documentId of documents) {
        await asUser(
          manager,
          `select public.verify_benefit_document($1, true, 'Checked at the counter.')`,
          [documentId],
        );
      }

      await asUser(
        manager,
        `select public.assess_benefit_claim($1, 'Three nights, both documents checked.')`,
        [opened.id],
      );

      return one(
        `select id, claim_number, assessed_amount::text as amount
           from public.benefit_claims where id = $1`,
        [opened.id],
      );
    })();

    // --- A second claim assessed and waiting ------------------------------
    //
    // Two, not one, and the reason is scheduling rather than coverage:
    // `benefits.write.spec.ts` approves and pays the one above, and
    // Playwright runs files in parallel across workers — so a read spec
    // asserting that the approval queue is not empty would pass or fail
    // depending on which worker got there first. This one is never written
    // to, which is what makes that assertion stable.
    const claimAwaiting = await (async () => {
      const [opened] = await asUser(
        secretary,
        `select public.open_benefit_claim(
                  $1, 'medical', null, 'Kiruddu Hospital',
                  (((public.business_date() - 18) + interval '9 hours')
                     at time zone 'Africa/Kampala'),
                  (((public.business_date() - 15) + interval '12 hours')
                     at time zone 'Africa/Kampala'),
                  180000, null, null, null) as id`,
        [memberBorrowing.membershipId],
      );

      const documents = await attachRequired(opened.id, memberBorrowing.membershipId, [
        'hospital_admission',
        'medical_invoice',
      ]);

      await asUser(secretary, `select public.submit_benefit_claim($1)`, [opened.id]);
      await asUser(manager, `select public.begin_benefit_verification($1)`, [opened.id]);

      for (const documentId of documents) {
        await asUser(
          manager,
          `select public.verify_benefit_document($1, true, 'Both documents seen.')`,
          [documentId],
        );
      }

      await asUser(
        manager,
        `select public.assess_benefit_claim($1, 'Three nights; invoice checked.')`,
        [opened.id],
      );

      return one(
        `select id, claim_number, assessed_amount::text as amount
           from public.benefit_claims where id = $1`,
        [opened.id],
      );
    })();

    // --- A condolence claim held on an undecided rule ---------------------
    //
    // A cousin. The evidence is complete and checked, the membership is in
    // good standing, and the claim still cannot be assessed — because nobody
    // has defined which family members the benefit covers. That is the screen
    // worth having: a claim held with the decision named rather than a
    // "not available" nobody can act on.
    const heldClaim = await (async () => {
      const [opened] = await asUser(
        secretary,
        `select public.open_benefit_claim(
                  $1, 'family_condolence', (public.business_date() - 9),
                  null, null, null, null,
                  'Alice Mugisha', 'cousin', null) as id`,
        [memberWithdrawn.membershipId],
      );

      const documents = await attachRequired(opened.id, memberWithdrawn.membershipId, [
        'family_death_evidence',
        'relationship_evidence',
      ]);

      await asUser(secretary, `select public.submit_benefit_claim($1)`, [opened.id]);
      await asUser(manager, `select public.begin_benefit_verification($1)`, [opened.id]);

      for (const documentId of documents) {
        await asUser(
          manager,
          `select public.verify_benefit_document($1, true,
                    'Burial programme and the local council letter both seen.')`,
          [documentId],
        );
      }

      return one(`select id, claim_number from public.benefit_claims where id = $1`, [
        opened.id,
      ]);
    })();

    // --- The meetings ------------------------------------------------------
    //
    // One held last month with a register, minutes and two action items, and
    // one still to come. The held one carries a correction, because a register
    // that could be silently rewritten would not be evidence of anything —
    // and the correction trail is a screen.
    // The branch the demonstration members belong to, read from one of them
    // rather than assumed: `clients_stamp_branch` fills it, and a meeting's
    // register is its own branch's live memberships, so a meeting convened at
    // any other branch would have nobody to mark.
    const meetingBranch = await one(
      `select c.branch_id as id
         from public.memberships m
         join public.clients c on c.id = m.client_id
        where m.id = $1`,
      [memberQualified.membershipId],
    );

    const heldMeeting = await (async () => {
      const [scheduled] = await asUser(
        secretary,
        `select public.schedule_membership_meeting(
                  $1, 'monthly_general', 'Monthly general meeting',
                  'The branch hall, Kalerwe',
                  (((public.business_date() - interval '1 month')::date
                     + interval '14 hours') at time zone 'Africa/Kampala'),
                  'Savings for the month, the benefits scheme, and next of kin records.')
           as id`,
        [meetingBranch.id],
      );

      // Marking the first member present is what moves the meeting to `held`:
      // the status is derived from the register rather than set by hand.
      const register = [
        [memberQualified.membershipId, 'present', null],
        [memberGapped.membershipId, 'present', null],
        [memberSaving.membershipId, 'apology', 'travel'],
        [memberWithdrawn.membershipId, 'absent', 'work'],
        [memberBorrowing.membershipId, 'represented', 'work'],
      ];

      for (const [membershipId, attendance, reason] of register) {
        await asUser(
          secretary,
          `select public.mark_meeting_attendance($1, $2, $3, $4, null, null)`,
          [scheduled.id, membershipId, attendance, reason],
        );
      }

      // One answer changed afterwards. The previous entry is kept in an
      // append-only table with the reason beside it.
      await asUser(
        secretary,
        `select public.mark_meeting_attendance($1, $2, 'present', null, null, $3)`,
        [
          scheduled.id,
          memberWithdrawn.membershipId,
          'Marked absent in error — the member signed the sheet late.',
        ],
      );

      await asUser(secretary, `select public.record_meeting_minutes($1, $2, null)`, [
        scheduled.id,
        'The meeting reviewed savings for the month, heard that the benefits ' +
          'scheme is recorded in the system but that four rules remain ' +
          'undecided — the medical ceiling, the number of claims a year, any ' +
          'waiting period and which relatives a condolence benefit covers — ' +
          'and agreed to put all four to the next general meeting. Members ' +
          'were asked to bring next of kin details.',
      ]);

      await asUser(owner, `select public.finalise_meeting_minutes($1)`, [scheduled.id]);

      const [done] = await asUser(
        secretary,
        `select public.add_meeting_action_item(
                  $1, 'Visit the three members who have not saved this month.',
                  $2::uuid, (public.business_date() - 10)) as id`,
        [scheduled.id, manager.profileId],
      );

      await asUser(
        secretary,
        `select public.update_meeting_action_item($1, 'completed',
                  'All three visited; two have since paid in.')`,
        [done.id],
      );

      // Overdue and still open, so the dashboard has something to chase. An
      // item with a date somebody has passed is the one thing a minute book
      // never surfaces.
      await asUser(
        secretary,
        `select public.add_meeting_action_item(
                  $1, 'Obtain next of kin details from every member.',
                  $2::uuid, (public.business_date() - 3)) as id`,
        [scheduled.id, secretary.profileId],
      );

      return one(
        `select id, meeting_number from public.membership_meetings where id = $1`,
        [scheduled.id],
      );
    })();

    const upcomingMeeting = await (async () => {
      const [scheduled] = await asUser(
        secretary,
        `select public.schedule_membership_meeting(
                  $1, 'monthly_general', 'Monthly general meeting',
                  'The branch hall, Kalerwe',
                  (((public.business_date() + interval '1 month')::date
                     + interval '14 hours') at time zone 'Africa/Kampala'),
                  'The four undecided benefit rules, and the year-end share.') as id`,
        [meetingBranch.id],
      );

      return one(
        `select id, meeting_number from public.membership_meetings where id = $1`,
        [scheduled.id],
      );
    })();

    // A meeting for the browser suite to mark, write up and add an item to.
    // Separate from the two above for the reason the second assessed claim is
    // separate: a write spec that marked the upcoming monthly meeting would
    // move it to `held`, and the read spec asserting "when is the next one"
    // would then pass or fail depending on worker order.
    //
    // `special` rather than `monthly_general`, because one monthly general
    // meeting per branch per calendar month is the one rule the client's
    // documents do state and the database enforces it.
    const meetingToWorkOn = await (async () => {
      const [scheduled] = await asUser(
        secretary,
        `select public.schedule_membership_meeting(
                  $1, 'special', 'Special meeting on the benefits scheme',
                  'The branch hall, Kalerwe',
                  (((public.business_date() + 3) + interval '15 hours')
                     at time zone 'Africa/Kampala'),
                  'The four undecided benefit rules.') as id`,
        [meetingBranch.id],
      );

      return one(
        `select id, meeting_number from public.membership_meetings where id = $1`,
        [scheduled.id],
      );
    })();

    // The benefit payments and the General Ledger must agree, to the shilling.
    // There is no second ledger: `post_benefit_payment` writes one journal
    // entry through `post_journal`, like every other movement in this system.
    {
      const expense = await one(
        `select
           (select coalesce(sum(case when reversed_at is null then amount else 0 end), 0)
              ::bigint from public.benefit_payments)::text as paid,
           (select coalesce(sum(b.balance), 0)::bigint
              from public.ledger_account_balances b
             where b.code in ('5210', '5220', '5230'))::text as ledger`,
      );

      if (expense.paid !== expense.ledger) {
        throw new Error(
          `benefit payments ${expense.paid} do not match the benefits expense ` +
            `accounts ${expense.ledger}`,
        );
      }

      console.log(
        `benefits: ${paidClaim.claim_number} paid ${expense.paid} both sides; ` +
          `${claimToApprove.claim_number} and ${claimAwaiting.claim_number} ` +
          `awaiting approval; ${heldClaim.claim_number} held on an undecided rule`,
      );
    }

    return {
      beneficiaries: {
        verified: verifiedBeneficiary.id,
        pending: pendingBeneficiary.id,
      },
      benefitClaims: {
        paid: paidClaim.id,
        paidNumber: paidClaim.claim_number,
        paidAmount: Number(paidClaim.amount),
        toApprove: claimToApprove.id,
        toApproveNumber: claimToApprove.claim_number,
        toApproveAmount: Number(claimToApprove.amount),
        awaiting: claimAwaiting.id,
        awaitingNumber: claimAwaiting.claim_number,
        held: heldClaim.id,
        heldNumber: heldClaim.claim_number,
      },
      meetings: {
        held: heldMeeting.id,
        heldNumber: heldMeeting.meeting_number,
        upcoming: upcomingMeeting.id,
        upcomingNumber: upcomingMeeting.meeting_number,
        toWorkOn: meetingToWorkOn.id,
        toWorkOnNumber: meetingToWorkOn.meeting_number,
      },
      benefitPolicy: {
        annualCap: BENEFIT_ANNUAL_CAP,
        claimsPerYear: BENEFIT_CLAIMS_PER_YEAR,
        waitingDays: BENEFIT_WAITING_DAYS,
        yearBasis: BENEFIT_YEAR_BASIS,
      },
    };
  })();

  // What the policy in force actually decides, read back from the database
  // rather than counted by hand.
  //
  // The policy screen renders the version in force, and two of its assertions
  // are counts: how many of the nine open questions are still open, and how many
  // of the five activities the version opens. Hard-coding those in the spec
  // would mean editing the spec every time this harness changed a figure — and
  // the edit that got forgotten would be a spec asserting the wrong number
  // against a screen that was right.
  //
  // So the figures come from the generated readiness columns and from counting
  // the nulls among the nine. The spec then asserts that the *screen* agrees
  // with the database, which is the claim worth making.
  const policyFacts = await one(
    `select
     (select count(*)
        from (values
          (v.interest_basis), (v.interest_method),
          (v.savings_to_loan_multiplier_bps::text),
          (v.qualifying_months_consecutive::text),
          (v.savings_withdrawal_with_active_loan),
          (v.profit_distribution_basis),
          (v.medical_benefit_annual_cap::text),
          (v.medical_benefit_claims_per_year::text),
          (v.benefit_waiting_period_days::text)
        ) as nine(answer)
       where nine.answer is null)::int as undecided,
     (v.is_enrolment_enabled::int + v.is_savings_enabled::int
      + v.is_member_lending_enabled::int + v.is_benefits_enabled::int
      + v.is_profit_sharing_enabled::int) as activities_open
   from public.membership_policy_versions v
   where v.id = $1`,
    [policyVersion.id],
  );

  console.log(
    `policy ${policyVersion.version}: ${String(policyFacts.undecided)} rules undecided, ` +
      `${String(policyFacts.activities_open)} of 5 activities open`,
  );

  {
    const liability = await one(
      `select
       (select coalesce(sum(signed_amount), 0)::bigint
          from public.savings_transactions)::text as subledger,
       (select balance::text from public.ledger_account_balances where code = '2100')
         as ledger`,
    );

    if (liability.subledger !== liability.ledger) {
      throw new Error(
        `savings subledger ${liability.subledger} does not match ledger 2100 ${liability.ledger}`,
      );
    }

    console.log(
      `5 memberships seeded; savings liability ${liability.subledger} both sides`,
    );
  }

  return {
    memberships: {
      qualified: memberQualified.membershipId,
      gapped: memberGapped.membershipId,
      saving: memberSaving.membershipId,
      withdrawn: memberWithdrawn.membershipId,
      pendingConsent: memberPending.membershipId,
      borrowing: memberBorrowing.membershipId,
      applying: memberApplying.membershipId,
      approving: memberApproving.membershipId,
    },
    membershipNumbers: {
      qualified: memberQualified.membershipNumber,
      pendingConsent: memberPending.membershipNumber,
      borrowing: memberBorrowing.membershipNumber,
    },
    savings: {
      qualified: memberQualified.savingsAccountId,
      gapped: memberGapped.savingsAccountId,
      saving: memberSaving.savingsAccountId,
      withdrawn: memberWithdrawn.savingsAccountId,
      borrowing: memberBorrowing.savingsAccountId,
    },
    savingsAccountNumbers: {
      qualified: memberQualified.accountNumber,
      withdrawn: memberWithdrawn.accountNumber,
    },
    // Polytos Phase 3.
    memberClients: {
      borrowing: clients[13].id,
      applying: clients[14].id,
      approving: clients[15].id,
    },
    memberLoans: {
      active: memberLoanActive.loanId,
      activeNumber: memberLoanActive.loan_number,
      draft: memberLoanDraft.loanId,
      draftNumber: memberLoanDraft.loan_number,
      toApprove: memberLoanToApprove.loanId,
      toApproveNumber: memberLoanToApprove.loan_number,
      toApprovePrincipal: 250_000,
      principal: 300_000,
      pledged: Number(memberLoanActive.pledged),
      installments: Number(memberLoanActive.installments),
    },
    memberLending: {
      multiplierBps: MEMBER_MULTIPLIER_BPS,
      interestBasis: 'per_month',
      interestMethod: 'reducing_balance_monthly',
      // Left open on purpose; see the long note above the policy INSERT.
      monthAnchor: null,
      weeklyCadenceMaxMonths: 2,
      maxTermMonths: 5,
    },
    withdrawals: {
      paid: withdrawalRequestId,
      pending: pendingWithdrawalId,
    },
    policy: {
      version: policyVersion.version,
      undecidedRules: Number(policyFacts.undecided),
      activitiesOpen: Number(policyFacts.activities_open),
      activitiesClosed: 5 - Number(policyFacts.activities_open),
    },
    // Polytos Phase 4.
    ...benefits,
  };
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
    // Polytos Phase 2. Named by what each member *is*, so a savings spec
    // refers to "the member who has served the qualifying period" rather than
    // to a uuid pasted into a test.
    //
    // Spread, and absent entirely where the Polytos schema was not there to
    // seed — which is the upgrade verifier's case. A manifest carrying nulls
    // would let a spec read one and fail somewhere confusing; a manifest
    // missing the keys makes the spec's own type the thing that complains.
    ...(polytos ?? {}),
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

// ---------------------------------------------------------------------------
// Statistics
//
// A database built by applying the migrations from zero has no planner
// statistics, and autovacuum's analyse worker will not have run yet on a
// stack that was created seconds ago. For the flat tables that costs nothing.
// For the derived views it is the difference between a good plan and a
// disastrous one, because they are stacked —
// `dashboard_portfolio_summary` reads `loan_portfolio_report`, which reads
// `loan_delinquency` and `loan_balances`, which read
// `loan_installment_coverage` — and each wrong row estimate is multiplied by
// the one above it.
//
// Measured on this seed, reading as an authenticated owner:
//
//   dashboard_portfolio_summary   1,981 ms  ->  80 ms
//   collections_today             1,373 ms  ->  79 ms
//   loan_portfolio_report           320 ms  ->  88 ms
//
// Twenty-five times, on fourteen loans, from statistics alone. Without this
// the browser suite and any benchmark run against the harness measure the
// planner guessing rather than the queries.
//
// It belongs here rather than in a migration: the migrations run against an
// empty database, so an ANALYZE in the chain would find nothing to measure.
// The same step is needed after restoring a backup — see
// docs/BACKUP-RESTORE.md.
// ---------------------------------------------------------------------------
await q('analyze');
console.log('statistics collected');

await db.end();
console.log('\nSEED COMPLETE');
