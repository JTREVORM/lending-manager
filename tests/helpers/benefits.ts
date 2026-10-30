import { query, queryOne } from './db';
import { asUserCommitted, type TestUser } from './auth-fixtures';
import { enrolMember } from './membership';

/**
 * Fixtures for the Polytos Phase 4 benefit and meeting suites.
 *
 * ## Why these go through the real functions
 *
 * Every helper below calls the function the application calls —
 * `register_member_beneficiary`, `open_benefit_claim`, `assess_benefit_claim`
 * — rather than inserting rows. A fixture that inserted directly could reach
 * a state the product cannot produce, and a test standing on one proves
 * something about the fixture.
 *
 * The two exceptions are both clocks or storage, and both are stated where
 * they happen: an evidence object is written straight into `storage.objects`
 * because there is no HTTP layer in a database test, and a membership's
 * activation date is back-dated so a waiting period can be served without
 * waiting thirty days.
 *
 * ## Why so many helpers take two users
 *
 * Because the controls this phase exists for are separations of duties.
 * Registering and verifying a beneficiary, attaching and checking a document,
 * assessing and approving a claim — each is two people, and a helper that did
 * both halves as one user would be a helper that cannot produce a verified
 * anything.
 */

let memberSeq = 0;

export interface BenefitMember {
  readonly clientId: string;
  readonly membershipId: string;
  readonly membershipNumber: string;
  readonly branchId: string;
}

/**
 * An active member, activated on a chosen date.
 *
 * Enrolled through `enrol_member`, the function the counter calls, so the
 * membership is a real one: the registration fee reaches the ledger and a
 * verified acceptance exists, which are the two preconditions
 * `memberships_guard_transition` has required since ADR-050.
 *
 * The activation date is then **back-dated**, which is the one thing here that
 * is not reachable through the product. A benefit's waiting period and its
 * policy year are both measured from activation, so a suite that needed a
 * member who joined last year would otherwise have to wait a year. It uses the
 * same documented owner-level trigger exemption `forcePolicyStatus` and
 * `resetMonthlyCadence` use, and it moves a clock rather than a rule — no
 * guard is relaxed and no state is reached that the product could not produce
 * on a different day.
 */
export async function makeBenefitMember(
  policyId: string,
  options: {
    readonly activatedOn?: string;
    readonly status?: string;
    /** The staff account the acceptance is witnessed by. */
    readonly witnessProfileId?: string;
    /**
     * The branch to enrol at. Defaults to the first active one.
     *
     * A membership is held at its client's branch and follows it, so this is
     * set on the *client* rather than on the membership — and a test that
     * needs a member at another branch has to say so here rather than move
     * one afterwards, because moving a membership alone is refused.
     */
    readonly branchId?: string;
  } = {},
): Promise<BenefitMember> {
  memberSeq += 1;
  const suffix = String((process.pid % 100) * 1000 + (memberSeq % 1000)).padStart(5, '0');

  const branch =
    options.branchId === undefined
      ? await queryOne<{ id: string }>(
          `select id from public.branches
            where status = 'active' order by branch_code limit 1`,
        )
      : { id: options.branchId };

  const client = await queryOne<{ id: string }>(
    `insert into public.clients
       (full_name, sex, date_of_birth, phone, occupation, village_area, district,
        branch_id)
     values ($1, 'female', '1988-04-12', $2, 'Trader', 'Kalerwe', 'Kampala', $3)
     returning id`,
    [`Benefit Case ${suffix}`, `+2567001${suffix}`, branch.id],
  );

  const witness =
    options.witnessProfileId ??
    (
      await queryOne<{ id: string }>(
        `select id from public.profiles where status = 'active' order by created_at limit 1`,
      )
    ).id;

  // `enrol_member` enrols under the version **in force**, not under one a
  // caller names — which is correct, and which makes a `policyId` argument a
  // promise this helper could otherwise break silently. Only one version may
  // be in force, so the two must be the same version; a suite that published
  // a second one and then called this would get memberships under the wrong
  // rules and tests that passed for the wrong reason. Asserted rather than
  // hoped for.
  const inForce = await queryOne<{ id: string; version: string }>(
    `select id, version from public.membership_policy_versions
      where status = 'active'`,
  );

  if (inForce.id !== policyId) {
    throw new Error(
      `makeBenefitMember was given a policy version that is not in force. ` +
        `Version ${inForce.version} is live, and only one version may be. ` +
        `Supersede it before publishing another, and pass the live one here.`,
    );
  }

  const { membershipId } = await enrolMember(client.id, witness);

  const activatedOn = options.activatedOn ?? '2024-01-15';

  await query(
    `alter table public.memberships disable trigger memberships_guard_transition`,
  );
  try {
    await query(
      `update public.memberships
          set activated_on = $2::date,
              applied_on = $2::date,
              status = $3
        where id = $1`,
      [membershipId, activatedOn, options.status ?? 'active'],
    );
  } finally {
    await query(
      `alter table public.memberships enable trigger memberships_guard_transition`,
    );
  }

  const membership = await queryOne<{ membership_number: string }>(
    `select membership_number from public.memberships where id = $1`,
    [membershipId],
  );

  return {
    clientId: client.id,
    membershipId,
    membershipNumber: membership.membership_number,
    branchId: branch.id,
  };
}

/**
 * A verified beneficiary, registered by one user and verified by another.
 *
 * Two users because `verify_member_beneficiary` refuses a verification from
 * whoever recorded the record — which is the control, so a helper that could
 * get around it would be a hole in every test that used it.
 */
export async function makeVerifiedBeneficiary(
  membershipId: string,
  recorder: Pick<TestUser, 'authUserId'>,
  verifier: Pick<TestUser, 'authUserId'>,
  options: {
    readonly fullName?: string;
    readonly relationship?: string;
    readonly phone?: string;
  } = {},
): Promise<string> {
  memberSeq += 1;

  const registered = await asUserCommitted(recorder, [
    {
      sql: `select public.register_member_beneficiary(
                     $1, $2, $3, $4, null, 'Kalerwe', 'Kampala',
                     'national_id', $5, true, null) as id`,
      params: [
        membershipId,
        options.fullName ?? `Next Of Kin ${memberSeq}`,
        options.relationship ?? 'spouse',
        options.phone ?? `+2567003${String(10000 + memberSeq).slice(-5)}`,
        `NIN${String(100000 + memberSeq)}`,
      ],
    },
  ]);

  if (!registered.ok) {
    throw new Error(`fixture could not register a beneficiary: ${registered.message}`);
  }

  const id = (registered.rows[0] as { id: string }).id;

  const verified = await asUserCommitted(verifier, [
    {
      sql: `select public.verify_member_beneficiary(
                     $1, true, 'witnessed_in_branch', null,
                     'Identity document seen at the branch.') as id`,
      params: [id],
    },
  ]);

  if (!verified.ok) {
    throw new Error(`fixture could not verify a beneficiary: ${verified.message}`);
  }

  return id;
}

/**
 * Put an evidence object into the private bucket, and return its path.
 *
 * Written straight into `storage.objects` because a database test has no HTTP
 * layer to upload through. The *path* is built exactly as
 * `buildBenefitDocumentPath` builds it, so the storage policies and the
 * metadata guard both see what they would see in production — which is the
 * part that matters, because both of them read the path.
 */
export async function putEvidenceObject(
  membershipId: string,
  kind: string,
  subject: string,
): Promise<string> {
  memberSeq += 1;
  const path = `benefits/${membershipId}/${kind}/${subject}/${String(Date.now())}${String(
    memberSeq,
  )}.pdf`;

  await query(
    `insert into storage.objects (bucket_id, name, metadata)
     values ('benefit-documents', $1, jsonb_build_object('size', 20480))`,
    [path],
  );

  return path;
}

/**
 * Attach a document and have somebody else check it.
 *
 * Returns the document id. Two users again, because
 * `verify_benefit_document` refuses a check from whoever attached it.
 */
export async function attachVerifiedDocument(
  claimId: string,
  membershipId: string,
  kind: string,
  uploader: Pick<TestUser, 'authUserId'>,
  checker: Pick<TestUser, 'authUserId'>,
): Promise<string> {
  const path = await putEvidenceObject(membershipId, kind, claimId);

  const attached = await asUserCommitted(uploader, [
    {
      sql: `select public.attach_benefit_document(
                     $1, null, $2, $3, 'application/pdf', 20480, null) as id`,
      params: [claimId, kind, path],
    },
  ]);

  if (!attached.ok) {
    throw new Error(`fixture could not attach a document: ${attached.message}`);
  }

  const id = (attached.rows[0] as { id: string }).id;

  const checked = await asUserCommitted(checker, [
    { sql: `select public.verify_benefit_document($1, true, null) as id`, params: [id] },
  ]);

  if (!checked.ok) {
    throw new Error(`fixture could not check a document: ${checked.message}`);
  }

  return id;
}

/** Remove every object this suite put in the evidence bucket. */
export async function clearEvidenceBucket(): Promise<void> {
  await query(`delete from storage.objects where bucket_id = 'benefit-documents'`);
}

/**
 * The required document kinds for a claim type, from the database.
 *
 * Read rather than hard-coded, so a test that drives a claim to assessment
 * keeps working when the client decides a fourth document is required — and
 * fails loudly if somebody makes a required document optional to get a test
 * green.
 */
export async function requiredKindsFor(claimType: string): Promise<readonly string[]> {
  const rows = await query<{ key: string }>(
    `select key from public.benefit_document_kinds
      where is_required_for_assessment and claim_type = $1
      order by sort_order`,
    [claimType],
  );

  return rows.map((row) => row.key);
}

/**
 * Three other group members, confirming a death.
 *
 * Rule 12. A death-related claim needs the policy's recorded number of
 * confirmations, each naming a **real membership** rather than a typed name —
 * so the fixture has to enrol the confirmers, which is why this takes a
 * policy and not a list of names.
 *
 * The members it creates are ordinary ones: active, enrolled through
 * `enrol_member`, and never the membership the claim is about. The function
 * refuses to confirm with the deceased's own membership, so a fixture cannot
 * accidentally satisfy the rule with one member three times.
 */
export async function recordDeathConfirmations(
  claimId: string,
  policyId: string,
  recorder: Pick<TestUser, 'authUserId'>,
  options: {
    readonly count?: number;
    readonly branchId?: string;
  } = {},
): Promise<readonly string[]> {
  const ids: string[] = [];

  for (let index = 0; index < (options.count ?? 3); index += 1) {
    const confirmer = await makeBenefitMember(policyId, {
      branchId: options.branchId,
    });

    const recorded = await asUserCommitted(recorder, [
      {
        sql: `select public.record_death_confirmation(
                       $1, $2,
                       'I knew the deceased and can confirm the death took place.',
                       'witnessed_by_staff', null, null, 'Fellow member') as id`,
        params: [claimId, confirmer.membershipId],
      },
    ]);

    if (!recorded.ok) {
      throw new Error(`fixture could not record a confirmation: ${recorded.message}`);
    }

    ids.push((recorded.rows[0] as { id: string }).id);
  }

  return ids;
}

/**
 * A next-of-kin record registered **before** a date.
 *
 * Rule 11's second half: the condolence benefit covers a family member who was
 * listed as next of kin, and a record created after the death does not
 * establish that they were listed before it. `created_at` is back-dated with
 * the same documented owner-level exemption `makeBenefitMember` uses to
 * back-date an activation — it moves a clock rather than a rule, and the
 * product reaches the same state on a different day.
 */
export async function makeListedNextOfKin(
  membershipId: string,
  recorder: Pick<TestUser, 'authUserId'>,
  verifier: Pick<TestUser, 'authUserId'>,
  options: {
    readonly relationship?: string;
    readonly listedOn?: string;
    readonly primary?: boolean;
  } = {},
): Promise<string> {
  const id = await makeVerifiedBeneficiary(membershipId, recorder, verifier, {
    relationship: options.relationship ?? 'sibling',
  });

  if (options.listedOn !== undefined) {
    await query(
      `update public.member_beneficiaries
          set created_at = ($1::date + time '09:00') at time zone 'Africa/Kampala'
        where id = $2`,
      [options.listedOn, id],
    );
  }

  return id;
}
