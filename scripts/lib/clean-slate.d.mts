/**
 * Types for `clean-slate.mjs`.
 *
 * The module stays `.mjs` so `node scripts/clean-slate.mjs` runs it with no
 * build step, the way the other operational scripts in this directory work.
 * The database suite imports it to rehearse the procedure, and needs types to
 * do that without `any` leaking through every assertion.
 */

/** A connection in pg's shape. The module owns no pool of its own. */
export interface CleanSlateDb {
  query(
    sql: string,
    params?: readonly unknown[],
  ): Promise<{ rows: Record<string, unknown>[] }>;
}

export interface PreservePartialEntry {
  readonly table: string;
  /** A SQL predicate; `$OWNER$` is replaced with the Owner's id. */
  readonly keep: string;
  readonly why: string;
}

export interface NeutraliseProfiles {
  readonly keep: string;
  readonly why: string;
}

export interface ActorReference {
  readonly table: string;
  readonly column: string;
}

/** Counts that say whether the slate is clean. */
export interface BusinessRowCounts {
  readonly [key: string]: number;
}

/** What the schema will not let the procedure remove. */
export interface Residue {
  readonly [key: string]: number;
}

export interface OwnerRow {
  readonly id: string;
  readonly full_name: string;
  readonly status: string;
  readonly auth_user_id: string | null;
  readonly roles: string | null;
}

export interface CleanSlateResult {
  readonly dryRun: boolean;
  readonly owner: OwnerRow;
  readonly before: BusinessRowCounts;
  readonly after?: BusinessRowCounts;
  readonly residue?: Residue;
  readonly plan?: { readonly truncate: number };
}

export declare const PRESERVE_WHOLE: readonly string[];
export declare const PRESERVE_PARTIAL: readonly PreservePartialEntry[];
export declare const NEUTRALISE_PROFILES: NeutraliseProfiles;
export declare const TRUNCATE_TABLES: readonly string[];
export declare const RESET_SEQUENCES: readonly string[];
export declare const PRESERVE_SEQUENCES: readonly string[];
export declare const NULL_PRESERVED_ACTOR_REFERENCES: readonly ActorReference[];
export declare const DEMONSTRATION_POLICY_MATCH: string;

/**
 * Sort the database's tables against the procedure's lists.
 *
 * `unclassified` is a table in the database that no list names — the case the
 * procedure refuses to run on, because a table added by a later migration
 * must be decided about rather than silently emptied or silently skipped.
 * `missing` is the reverse: a table the lists name that the database lacks.
 */
export declare function classify(actualTables: readonly string[]): {
  unclassified: string[];
  missing: string[];
};

export declare function projectRefFromConnectionString(value: string): string | null;

export declare function classifySequences(actualScopes: readonly string[]): {
  unclassified: string[];
  missing: string[];
};

export declare function countBusinessRows(db: CleanSlateDb): Promise<BusinessRowCounts>;

export declare function describeResidue(db: CleanSlateDb): Promise<Residue>;

export declare function runCleanSlate(
  db: CleanSlateDb,
  options: { ownerProfileId: string; dryRun?: boolean },
): Promise<CleanSlateResult>;
