/**
 * Every ambiguous PostgREST embed names its foreign key.
 *
 * ## Why this test exists, and why it is a source-level one
 *
 * `user_roles` reaches `profiles` twice: once as `profile_id`, the profile the
 * role belongs to, and once as `granted_by`, the profile that granted it. An
 * embed written `user_roles(role_key)` is therefore ambiguous, and PostgREST
 * refuses the whole request with PGRST201 — "Could not embed because more than
 * one relationship was found" — rather than guessing.
 *
 * That has now cost this project twice. First the user directory, which would
 * not load at all; `lib/data/users.ts` carries the hint and a note explaining
 * why. Then `getBankingStaffOptions`, written later and without it, which
 * failed quietly: the Agency authorisations screen could offer nobody to
 * authorise, so no mandate could be granted through the application at all,
 * and the cash banking form could not name who carried the cash. Both screens
 * kept rendering and said what they could not do, which is why every database
 * test still passed and only a browser found it.
 *
 * A type cannot catch this: the embed is a string, and the generated types
 * accept it. A database test cannot: PostgreSQL answers the equivalent join
 * happily, because the ambiguity is PostgREST's resolution step and not SQL's.
 * So this reads the source, the way `tests/integration/migrations.test.ts`
 * reads the SQL, and the next unqualified embed fails here rather than in a
 * screen.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * Tables that reach another table more than once, so an embed of them must
 * name which relationship it means.
 *
 * Keyed by the embedded table, with the hint its embeds must carry. Add a row
 * here when a second foreign key to the same table is introduced — that is
 * the moment every existing embed of it becomes ambiguous.
 */
const AMBIGUOUS: Readonly<Record<string, string>> = {
  // `profile_id` (the holder) and `granted_by` (the grantor).
  user_roles: 'user_roles_profile_id_fkey',
};

function sourceFiles(dir: string): readonly string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === '.next' || entry.startsWith('.')) continue;
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      out.push(...sourceFiles(path));
    } else if (/\.tsx?$/.test(entry)) {
      out.push(path);
    }
  }
  return out;
}

/** Comments stripped, so a note *about* an embed is not read as one. */
function code(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

/**
 * Every `.select(...)` argument in a file.
 *
 * Found by walking parentheses rather than by a regex, because an embed's own
 * column list contains a `)` — a non-greedy match would stop at the first one
 * and miss any embed after it in the same select.
 */
function selectArguments(text: string): readonly string[] {
  const out: string[] = [];
  const marker = '.select(';
  let from = 0;

  for (;;) {
    const start = text.indexOf(marker, from);
    if (start === -1) return out;

    let depth = 0;
    let index = start + marker.length - 1;
    for (; index < text.length; index += 1) {
      const character = text[index];
      if (character === '(') depth += 1;
      else if (character === ')') {
        depth -= 1;
        if (depth === 0) break;
      }
    }

    out.push(text.slice(start + marker.length, index));
    from = index === start ? start + marker.length : index;
  }
}

describe('PostgREST embeds', () => {
  const roots = ['lib', 'app', 'components', 'scripts'].filter((dir) => {
    try {
      return statSync(join(process.cwd(), dir)).isDirectory();
    } catch {
      return false;
    }
  });

  const files = roots.flatMap((dir) => sourceFiles(join(process.cwd(), dir)));

  it('finds source to check, so a passing run is not a vacuous one', () => {
    expect(files.length).toBeGreaterThan(100);
  });

  for (const [table, hint] of Object.entries(AMBIGUOUS)) {
    it(`names the foreign key on every embed of ${table}`, () => {
      const offenders: string[] = [];

      for (const file of files) {
        const text = code(readFileSync(file, 'utf8'));

        // Only inside a `.select(...)` argument. The first version of this
        // test scanned whole files and flagged
        // `insert into public.user_roles (profile_id, role_key)` in a seed
        // script — a SQL column list, not a PostgREST embed. A guard that
        // cries wolf on correct code gets widened until it catches nothing.
        for (const argument of selectArguments(text)) {
          // An embed is the table's name, optionally with `!` modifiers,
          // followed by its column list. A filter path such as
          // `user_roles.role_key` is followed by a dot and is not matched.
          const pattern = new RegExp(`\\b${table}(![A-Za-z_]+)*\\s*\\(`, 'g');
          for (const match of argument.matchAll(pattern)) {
            if (!match[0].includes(hint)) {
              offenders.push(
                `${file.replace(process.cwd(), '.')}: ${match[0].trim()} — needs !${hint}`,
              );
            }
          }
        }
      }

      expect(offenders, offenders.join('\n')).toEqual([]);
    });
  }

  it('has the hint where the two readers that need it live', () => {
    // Positive assertions as well as the sweep, so a refactor that renames
    // either reader out of existence is visible rather than silently making
    // the sweep pass over nothing.
    const users = readFileSync(join(process.cwd(), 'lib/data/users.ts'), 'utf8');
    const agency = readFileSync(join(process.cwd(), 'lib/data/agency.ts'), 'utf8');
    expect(users).toContain('user_roles!user_roles_profile_id_fkey');
    expect(agency).toContain('user_roles!user_roles_profile_id_fkey');
  });
});
