import { createHmac } from 'node:crypto';
import { Client } from 'pg';
import { authEnvironment } from './real-auth-config.mjs';

const db = new Client({ connectionString: authEnvironment.GOTRUE_DB_DATABASE_URL });
await db.connect();
await db.query(
  "update auth.users set aud='authenticated',role='authenticated',instance_id='00000000-0000-0000-0000-000000000000',email_confirmed_at=now(),updated_at=coalesce(updated_at,created_at,now()) where email like '%@phone.lending.invalid'",
);
for (const column of [
  'confirmation_token',
  'recovery_token',
  'email_change_token_new',
  'email_change',
  'email_change_token_current',
  'phone_change',
  'phone_change_token',
  'reauthentication_token',
]) {
  await db.query(
    'update auth.users set "' +
      column +
      '"=coalesce("' +
      column +
      "\",'') where email like '%@phone.lending.invalid'",
  );
}
const { rows } = await db.query(
  "select id from auth.users where email like '%@phone.lending.invalid'",
);
const encode = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
const unsigned =
  encode({ alg: 'HS256', typ: 'JWT' }) +
  '.' +
  encode({
    role: 'service_role',
    exp: Math.floor(Date.now() / 1000) + 300,
  });
const token =
  unsigned +
  '.' +
  createHmac('sha256', authEnvironment.GOTRUE_JWT_SECRET)
    .update(unsigned)
    .digest('base64url');
for (const row of rows) {
  const response = await fetch('http://127.0.0.1:9999/admin/users/' + row.id, {
    method: 'PUT',
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      password: process.env.HARNESS_PASSWORD ?? 'Screenshot#Demo2026',
      email_confirm: true,
    }),
  });
  if (!response.ok)
    throw new Error(
      'Could not provision the disposable real-Auth fixture: ' + response.status,
    );
}
await db.end();
console.log('Synthetic fixtures provisioned through real Auth; no credentials logged.');
