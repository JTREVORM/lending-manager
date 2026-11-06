/**
 * Apply, or verify, the production branch's protection.
 *
 * Read-only by default. It prints what GitHub currently enforces, diffs that
 * against `config/branch-protection.json`, and says what would change. With
 * `--apply` it PUTs the configuration and then reads it straight back, because
 * a 200 from GitHub is not the same thing as the rule being in force — a
 * setting the plan does not support can be accepted and silently dropped.
 *
 *   node scripts/apply-branch-protection.mjs            verify only
 *   node scripts/apply-branch-protection.mjs --apply    configure, then verify
 *
 * Needs a token with admin rights on the repository, in GITHUB_TOKEN or GH_TOKEN.
 * Applying changes who can push to the branch production is promoted from, so
 * it is the Product Owner's decision, not this script's.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const CONFIG_PATH = path.join(ROOT, 'config', 'branch-protection.json');

const OWNER = 'JTREVORM';
const REPO = 'lending-manager';

const apply = process.argv.includes('--apply');
const token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;

if (!token) {
  console.error('Set GITHUB_TOKEN (or GH_TOKEN) to a token with admin on the repo.');
  process.exit(2);
}

const config = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
const branch = config.branch;
const wanted = config.protection;

async function gh(method, endpoint, body) {
  const response = await fetch(`https://api.github.com${endpoint}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
      'content-type': 'application/json',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let parsed = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = { raw: text };
  }
  return { status: response.status, body: parsed };
}

/** The subset of GitHub's protection payload this configuration speaks to. */
function normalize(live) {
  if (live === null) return null;
  return {
    required_status_checks: live.required_status_checks
      ? {
          strict: live.required_status_checks.strict,
          contexts: [...(live.required_status_checks.contexts ?? [])].sort(),
        }
      : null,
    enforce_admins: live.enforce_admins?.enabled ?? false,
    required_pull_request_reviews: live.required_pull_request_reviews
      ? {
          required_approving_review_count:
            live.required_pull_request_reviews.required_approving_review_count ?? 0,
          dismiss_stale_reviews:
            live.required_pull_request_reviews.dismiss_stale_reviews ?? false,
          require_code_owner_reviews:
            live.required_pull_request_reviews.require_code_owner_reviews ?? false,
        }
      : null,
    allow_force_pushes: live.allow_force_pushes?.enabled ?? false,
    allow_deletions: live.allow_deletions?.enabled ?? false,
    required_conversation_resolution:
      live.required_conversation_resolution?.enabled ?? false,
    required_linear_history: live.required_linear_history?.enabled ?? false,
  };
}

function expected() {
  return {
    required_status_checks: {
      strict: wanted.required_status_checks.strict,
      contexts: [...wanted.required_status_checks.contexts].sort(),
    },
    enforce_admins: wanted.enforce_admins,
    required_pull_request_reviews: {
      required_approving_review_count:
        wanted.required_pull_request_reviews.required_approving_review_count,
      dismiss_stale_reviews: wanted.required_pull_request_reviews.dismiss_stale_reviews,
      require_code_owner_reviews:
        wanted.required_pull_request_reviews.require_code_owner_reviews,
    },
    allow_force_pushes: wanted.allow_force_pushes,
    allow_deletions: wanted.allow_deletions,
    required_conversation_resolution: wanted.required_conversation_resolution,
    required_linear_history: wanted.required_linear_history,
  };
}

async function readProtection() {
  const { status, body } = await gh(
    'GET',
    `/repos/${OWNER}/${REPO}/branches/${encodeURIComponent(branch)}/protection`,
  );
  if (status === 200) return body;
  if (status === 404 || status === 403) return null;
  throw new Error(`GET protection failed: ${status} ${JSON.stringify(body)}`);
}

async function main() {
  console.log(`Repository : ${OWNER}/${REPO}`);
  console.log(`Branch     : ${branch}`);

  // The single-collaborator constraint is a property of the repository, not of
  // this file, so it is re-checked here rather than trusted from the comment.
  const collaborators = await gh(
    'GET',
    `/repos/${OWNER}/${REPO}/collaborators?affiliation=all&per_page=100`,
  );
  const count = Array.isArray(collaborators.body) ? collaborators.body.length : null;
  if (count !== null) {
    console.log(`Collaborators: ${count}`);
    const requested =
      wanted.required_pull_request_reviews?.required_approving_review_count ?? 0;
    if (count < 2 && requested > 0) {
      console.error(
        `\nRefusing to apply: ${requested} approving review(s) required but only ` +
          `${count} collaborator(s) exist. GitHub does not let an author approve ` +
          `their own pull request, so this would make every merge impossible.`,
      );
      process.exit(1);
    }
  } else {
    console.log('Collaborators: not readable with this token (continuing)');
  }

  const before = normalize(await readProtection());
  console.log(`\nCurrently enforced:\n${JSON.stringify(before, null, 2)}`);

  if (!apply) {
    const target = expected();
    const same = JSON.stringify(before) === JSON.stringify(target);
    console.log(`\nDesired:\n${JSON.stringify(target, null, 2)}`);
    console.log(
      same
        ? '\nIn force and matching the reviewed configuration.'
        : '\nNOT in force as configured. Re-run with --apply (Product Owner decision).',
    );
    process.exit(same ? 0 : 1);
  }

  console.log('\nApplying...');
  const put = await gh(
    'PUT',
    `/repos/${OWNER}/${REPO}/branches/${encodeURIComponent(branch)}/protection`,
    {
      required_status_checks: wanted.required_status_checks,
      enforce_admins: wanted.enforce_admins,
      required_pull_request_reviews: wanted.required_pull_request_reviews,
      restrictions: wanted.restrictions,
      allow_force_pushes: wanted.allow_force_pushes,
      allow_deletions: wanted.allow_deletions,
      block_creations: wanted.block_creations,
      required_conversation_resolution: wanted.required_conversation_resolution,
      required_linear_history: wanted.required_linear_history,
      lock_branch: wanted.lock_branch,
      allow_fork_syncing: wanted.allow_fork_syncing,
    },
  );

  if (put.status >= 300) {
    console.error(`PUT failed: ${put.status} ${JSON.stringify(put.body, null, 2)}`);
    process.exit(1);
  }

  // Read back. GitHub can accept a field and not enforce it.
  const after = normalize(await readProtection());
  const target = expected();
  console.log(`\nNow enforced:\n${JSON.stringify(after, null, 2)}`);

  if (JSON.stringify(after) !== JSON.stringify(target)) {
    console.error(
      '\nApplied, but what GitHub reports back does not match the reviewed ' +
        'configuration. Treat the branch as unprotected until this is reconciled.',
    );
    process.exit(1);
  }

  console.log('\nVerified in force, read back from GitHub.');
}

main().catch((error) => {
  console.error(error);
  process.exit(2);
});
