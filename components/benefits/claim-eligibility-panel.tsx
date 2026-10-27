import { Card } from '@/components/ui/card';
import type { EligibilityFailure } from '@/lib/data/benefits';
import {
  BENEFIT_ELIGIBILITY_CODE_LABELS,
  isUndecidedEligibilityCode,
  type BenefitEligibilityCode,
} from '@/lib/domain/benefits';

/**
 * Why a claim cannot be assessed — the database's own answer.
 *
 * `benefit_claim_eligibility()` is the function `assess_benefit_claim` refuses
 * on, so what this panel shows is exactly what pressing Assess would say. The
 * alternative, a screen that worked out its own view, would be seventeen rules
 * implemented twice, and the copy that drifted would be the one a member is
 * standing in front of.
 *
 * ## Two kinds of answer, kept apart
 *
 * "The admission was too short" is a **refusal**: the claim does not qualify,
 * the member can be told, and the business is not waiting on anything.
 *
 * "Nobody has decided which of three ways a day is counted" is the business
 * **owing itself an answer**. It is not the member's fault and it is not a
 * refusal, and presenting it as one would tell somebody they had been turned
 * down when they have not.
 *
 * So the undecided ones are separated, listed second, and labelled as waiting
 * on the client rather than on the member. `UNDECIDED_BENEFIT_ELIGIBILITY_
 * CODES` names the six, and the division is the domain's rather than this
 * component's.
 */
export function ClaimEligibilityPanel({
  failures,
}: {
  /** `null` when the caller may not read eligibility at all. */
  readonly failures: readonly EligibilityFailure[] | null;
}) {
  if (failures === null) return null;

  if (failures.length === 0) {
    return (
      <Card>
        <h2 className="text-text text-sm font-semibold">Eligibility</h2>
        <p className="text-success mt-1 text-sm font-medium">
          Every rule this claim has to pass, passes. It can be assessed.
        </p>
      </Card>
    );
  }

  const undecided = failures.filter((failure) =>
    isUndecidedEligibilityCode(failure.code),
  );
  const refusals = failures.filter(
    (failure) => !isUndecidedEligibilityCode(failure.code),
  );

  return (
    <Card>
      <h2 className="text-text text-sm font-semibold">
        Why this claim cannot be assessed yet
      </h2>
      <p className="text-text-muted mt-1 text-sm">
        Read straight from the rule the assessment runs, so this list and the refusal
        cannot disagree.
      </p>

      {refusals.length === 0 ? null : (
        <ul className="mt-3 space-y-3">
          {refusals.map((failure) => (
            <li key={failure.code} className="min-w-0">
              <p className="text-text text-sm font-medium">{labelFor(failure.code)}</p>
              <p className="text-text-muted text-sm">{failure.detail}</p>
            </li>
          ))}
        </ul>
      )}

      {undecided.length === 0 ? null : (
        <div className="bg-warning-surface border-warning/35 mt-4 min-w-0 rounded-lg border p-3">
          <p className="text-text text-sm font-medium">
            {undecided.length === 1
              ? 'One rule has not been decided by the client'
              : `${String(undecided.length)} rules have not been decided by the client`}
          </p>
          <p className="text-text-muted mt-0.5 text-sm">
            These are not refusals. The claim is held, with its facts and evidence intact,
            until the business settles the rule — and can then be assessed without anybody
            re-entering anything.
          </p>
          <ul className="mt-3 space-y-3">
            {undecided.map((failure) => (
              <li key={failure.code} className="min-w-0">
                <p className="text-text text-sm font-medium">{labelFor(failure.code)}</p>
                <p className="text-text-muted text-sm">{failure.detail}</p>
              </li>
            ))}
          </ul>
        </div>
      )}
    </Card>
  );
}

/**
 * A code's heading, or the code itself.
 *
 * The fallback exists because the database is the authority on this list: a
 * code added there and not yet mirrored in `lib/domain/benefits.ts` should
 * show as itself rather than disappear. A database test asserts the two lists
 * agree, so the fallback should never be reached — and a panel that silently
 * dropped a refusal would be the worst possible way to find out it had been.
 */
function labelFor(code: string): string {
  return (
    BENEFIT_ELIGIBILITY_CODE_LABELS[code as BenefitEligibilityCode] ??
    code.replace(/_/g, ' ')
  );
}
