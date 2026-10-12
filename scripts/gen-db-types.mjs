#!/usr/bin/env node
/**
 * Emit the `types/database.types.ts` block for one or more relations.
 *
 * `supabase gen types` needs the Supabase CLI and a reachable project or a
 * Docker stack, neither of which this sandbox has. The throwaway PostgreSQL
 * cluster in `scripts/pg-local.sh` has the identical schema, because it is
 * built by applying the same migrations — so the shapes can be read straight
 * out of its catalogue.
 *
 * This prints; it does not edit. Splicing the output into the types file is a
 * deliberate act, because the file also carries hand-written commentary that
 * a regenerate-everything script would silently discard.
 *
 *   node scripts/gen-db-types.mjs table account_transfers expenses
 *   node scripts/gen-db-types.mjs view transfer_register
 */

import pg from 'pg';

const DEFAULT_URL = 'postgresql://lending@localhost:5433/lending_test';

/** PostgreSQL type → the TypeScript the generated file uses. */
function tsType(dataType, udtName) {
  switch (udtName) {
    case 'bool':
      return 'boolean';
    case 'int2':
    case 'int4':
    case 'int8':
    case 'float4':
    case 'float8':
    case 'numeric':
      return 'number';
    case 'json':
    case 'jsonb':
      return 'Json';
    default:
      break;
  }

  // An array's element type is its `udt_name` with a leading underscore:
  // `_int4` for integer[], `_text` for text[]. Reading only `dataType` here
  // typed `allowed_term_months integer[]` as `string[]`, which compiles and
  // is wrong — PostgREST sends integers as numbers.
  if (dataType === 'ARRAY') {
    switch (udtName) {
      case '_int2':
      case '_int4':
      case '_int8':
      case '_float4':
      case '_float8':
      case '_numeric':
        return 'number[]';
      case '_bool':
        return 'boolean[]';
      default:
        return 'string[]';
    }
  }

  // uuid, text, varchar, date, timestamptz, inet and the rest all arrive as
  // strings over PostgREST.
  return 'string';
}

async function main() {
  const [kind, ...names] = process.argv.slice(2);

  if (kind !== 'table' && kind !== 'view') {
    console.error('usage: gen-db-types.mjs <table|view> <name> [name...]');
    process.exit(1);
  }

  if (names.length === 0) {
    console.error('Name at least one relation.');
    process.exit(1);
  }

  const client = new pg.Client({
    connectionString: process.env.DATABASE_URL ?? DEFAULT_URL,
  });
  await client.connect();

  for (const name of names) {
    const { rows } = await client.query(
      `select c.column_name, c.data_type, c.udt_name, c.is_nullable,
              c.column_default,
              coalesce(a.attidentity <> '', false) as is_identity,
              coalesce(a.attgenerated <> '', false) as is_generated
         from information_schema.columns c
         left join pg_catalog.pg_attribute a
           on a.attrelid = ('public.' || c.table_name)::regclass
          and a.attname = c.column_name
        where c.table_schema = 'public' and c.table_name = $1
        order by c.ordinal_position`,
      [name],
    );

    if (rows.length === 0) {
      console.error(`-- no such relation: ${name}`);
      continue;
    }

    const lines = [`      ${name}: {`, '        Row: {'];

    for (const col of rows) {
      const type = tsType(col.data_type, col.udt_name);
      const nullable = col.is_nullable === 'YES' ? ' | null' : '';
      lines.push(`          ${col.column_name}: ${type}${nullable};`);
    }
    lines.push('        };');

    if (kind === 'table') {
      for (const section of ['Insert', 'Update']) {
        lines.push(`        ${section}: {`);
        for (const col of rows) {
          const type = tsType(col.data_type, col.udt_name);
          const nullable = col.is_nullable === 'YES' ? ' | null' : '';
          // A column is optional on insert when something else supplies it: a
          // default, an identity, or a generated expression. On update
          // everything is optional.
          const supplied =
            col.column_default !== null || col.is_identity || col.is_generated;
          const optional =
            section === 'Update' || supplied || col.is_nullable === 'YES' ? '?' : '';
          lines.push(`          ${col.column_name}${optional}: ${type}${nullable};`);
        }
        lines.push('        };');
      }
    }

    // Every relation carries it, views included: the client's type machinery
    // unions tables and views, and a view missing the key breaks resolution
    // for the whole schema rather than just for itself.
    lines.push('        Relationships: [];');
    lines.push('      };');
    console.log(lines.join('\n'));
  }

  await client.end();
}

await main();
