import Link from 'next/link';
import { Scale } from 'lucide-react';

import { Card } from '@/components/ui/card';
import { DataTable, TableCell, TableHead, TableRow } from '@/components/ui/data-table';
import { DateValue } from '@/components/ui/data-value';
import { PageHeader } from '@/components/ui/page-header';
import { PolicyAmount } from '@/components/policy-update/amount';
import { guardPermission } from '@/lib/auth/guard';
import { mapDatabaseError } from '@/lib/db-errors';
import { createSupabaseServerClient } from '@/lib/supabase/server';

export const metadata = { title: 'Meeting fines' };

export default async function MeetingFinesPage() {
  await guardPermission('/meetings/fines', 'fines:view');
  const db = await createSupabaseServerClient();
  const [register, summary] = await Promise.all([
    db
      .from('meeting_fine_register')
      .select('*')
      .order('meeting_date', { ascending: false })
      .limit(100),
    db.rpc('meeting_fine_summary', {}),
  ]);
  if (register.error) throw mapDatabaseError(register.error);
  if (summary.error) throw mapDatabaseError(summary.error);
  const totals = summary.data?.[0];
  return (
    <div className="min-w-0 space-y-6">
      <PageHeader
        icon={Scale}
        eyebrow="Membership Meetings"
        title="Meeting fines"
        description="Assessed charges, collections, reversals and reconciliation."
        back={{ href: '/meetings', label: 'Meetings' }}
      />
      {totals ? (
        <Card>
          <h2 className="font-semibold">Current-year meeting fines</h2>
          <p>
            Amounts relate to meetings held this year. Collections include partial
            receipts and are net of reversals.
          </p>
          <dl className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            <div>
              <dt>Assessed</dt>
              <dd>
                <PolicyAmount value={totals.amount_assessed} />
              </dd>
            </div>
            <div>
              <dt>Outstanding</dt>
              <dd>
                <PolicyAmount value={totals.amount_outstanding} />
              </dd>
            </div>
            <div>
              <dt>Collected, net</dt>
              <dd>
                <PolicyAmount value={totals.amount_collected} />
              </dd>
            </div>
            <div>
              <dt>Cancelled</dt>
              <dd>
                <PolicyAmount value={totals.amount_cancelled} />
              </dd>
            </div>
            <div>
              <dt>Receipts reversed</dt>
              <dd>
                <PolicyAmount value={totals.amount_reversed} />
              </dd>
            </div>
            <div>
              <dt>Fine income in the General Ledger</dt>
              <dd>
                <PolicyAmount value={totals.ledger_income} />
              </dd>
            </div>
          </dl>
          <p role="status" className="mt-3">
            {totals.reconciles
              ? 'Fine collections reconcile to the General Ledger.'
              : 'Reconciliation requires investigation.'}
          </p>
        </Card>
      ) : null}
      <Card>
        <h2 className="font-semibold">Fine register</h2>
        <p>
          The latest 100 charges, including cancelled charges. Open a fine for its
          receipts and corrections.
        </p>
        <div className="mt-3">
          <DataTable caption="Meeting fine register">
            <thead>
              <TableRow>
                <TableHead width="ref">Fine</TableHead>
                <TableHead width="name">Member</TableHead>
                <TableHead width="date">Meeting date</TableHead>
                <TableHead width="status">Status</TableHead>
                <TableHead width="money" align="numeric">Charged</TableHead>
                <TableHead width="money" align="numeric">Collected</TableHead>
                <TableHead width="money" align="numeric">Outstanding</TableHead>
              </TableRow>
            </thead>
            <tbody>
              {(register.data ?? []).map((f) => (
                <TableRow key={f.id}>
                  <TableCell header width="ref">
                    <Link
                      className="text-accent underline"
                      href={`/meetings/fines/${f.id}`}
                    >
                      {f.fine_number}
                    </Link>
                  </TableCell>
                  <TableCell width="name" wrap="wrap">{f.member_name}</TableCell>
                  <TableCell width="date">
                    <DateValue value={f.meeting_date} />
                  </TableCell>
                  <TableCell width="status">{f.status}</TableCell>
                  <TableCell width="money" align="numeric">
                    <PolicyAmount value={f.amount} />
                  </TableCell>
                  <TableCell width="money" align="numeric">
                    <PolicyAmount value={f.amount_paid} />
                  </TableCell>
                  <TableCell width="money" align="numeric">
                    <PolicyAmount
                      value={f.status === 'cancelled' ? 0 : f.amount_outstanding}
                    />
                  </TableCell>
                </TableRow>
              ))}
            </tbody>
          </DataTable>
        </div>
        {register.data?.length === 0 ? (
          <p className="mt-3">No fines have been assessed.</p>
        ) : null}
      </Card>
    </div>
  );
}
