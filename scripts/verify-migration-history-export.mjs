#!/usr/bin/env node
// Offline verifier for the POLYTOS stale migration-history export.
//
// Needs no database, no psql and no network. It re-hashes every exported .sql
// file and compares it with the checksum the connector read out of
// supabase_migrations.schema_migrations, then re-checks each record's stated
// relationship to the repository migration file of the same name.
//
// Exit code 0 = every record verified. Non-zero = at least one mismatch.

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const artifact =
  process.argv[2] ?? join(root, 'docs/audit/polytos-migration-history-2026-11-01');

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');
const stripTrailingNewlines = (buf) => {
  let end = buf.length;
  while (end > 0 && (buf[end - 1] === 0x0a || buf[end - 1] === 0x0d)) end -= 1;
  return buf.subarray(0, end);
};

const manifest = JSON.parse(readFileSync(join(artifact, 'manifest.json'), 'utf8'));
let failures = 0;
const fail = (msg) => {
  failures += 1;
  console.error(`FAIL  ${msg}`);
};
const pass = (msg) => console.log(`ok    ${msg}`);

if (manifest.records.length !== 9) {
  fail(`expected 9 exported records, manifest declares ${manifest.records.length}`);
}

for (const record of manifest.records) {
  const label = `${record.version} ${record.name}`;
  const exported = readFileSync(join(artifact, record.file));

  if (sha256(exported) !== record.sha256) {
    fail(
      `${label}: exported SQL hashes ${sha256(exported)}, manifest says ${record.sha256}`,
    );
    continue;
  }
  if (exported.length !== record.sql_bytes) {
    fail(
      `${label}: exported SQL is ${exported.length} bytes, manifest says ${record.sql_bytes}`,
    );
    continue;
  }
  pass(`${label}: ${exported.length} bytes, sha256 matches the database record`);

  // Re-check the stated relationship to the repository file of the same name.
  const repo = readFileSync(join(root, record.repo_file));
  const identical = sha256(repo) === record.sha256;
  const identicalStripped = sha256(stripTrailingNewlines(repo)) === record.sha256;

  if (record.repo_match === 'identical') {
    identical
      ? pass(`${label}: repo file ${record.repo_file} is byte-identical`)
      : fail(`${label}: repo file ${record.repo_file} is NOT byte-identical as claimed`);
  } else if (record.repo_match === 'identical_without_trailing_newline') {
    identicalStripped
      ? pass(`${label}: repo file matches once trailing newlines are removed`)
      : fail(`${label}: repo file does NOT match even without trailing newlines`);
  } else if (record.repo_match === 'DIVERGENT') {
    identical || identicalStripped
      ? fail(`${label}: marked DIVERGENT but the repo file actually matches`)
      : pass(
          `${label}: confirmed DIVERGENT from ${record.repo_file} — this export is the only copy`,
        );
  } else {
    fail(`${label}: unknown repo_match value ${record.repo_match}`);
  }
}

const marker = manifest.canonical_marker_rows.versions;
if (marker.length !== 9)
  fail(`expected 9 canonical marker versions, found ${marker.length}`);
else pass(`nine canonical marker versions recorded: ${marker[0]} … ${marker[8]}`);

console.log(
  failures === 0
    ? `\nAll ${manifest.records.length} records verified against the database checksums.`
    : `\n${failures} check(s) failed.`,
);
process.exit(failures === 0 ? 0 : 1);
