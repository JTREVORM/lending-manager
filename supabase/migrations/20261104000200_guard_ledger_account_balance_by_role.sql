-- Close the authenticated borrower balance-disclosure gap:
-- active identities were able to call this SECURITY DEFINER RPC without
-- ledger:view, despite the ledger tables/views being capability-filtered.
-- Preserve the validated financial calculation, return type, service-role
-- paths and forced-password guard. No data mutation.
CREATE OR REPLACE FUNCTION public.ledger_account_balance(p_account_id uuid)
 RETURNS bigint
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_side    text;
  v_debit   bigint;
  v_credit  bigint;
begin
  perform public.require_business_identity();

  -- Finance roles may inspect GL account balances; borrowers may not.
  -- Trusted no-JWT maintenance/seed paths keep their existing bypass.
  if (select auth.uid()) is not null
     and not (select public.user_has_permission('ledger:view')) then
    raise exception 'Not authorized to view company ledger balances.'
      using errcode = '42501';
  end if;

  select a.normal_side into v_side
  from public.ledger_accounts a where a.id = p_account_id;

  if v_side is null then
    raise exception 'No such ledger account.' using errcode = 'P0001';
  end if;

  select coalesce(pg_catalog.sum(l.debit), 0), coalesce(pg_catalog.sum(l.credit), 0)
    into v_debit, v_credit
  from public.journal_lines l
  where l.account_id = p_account_id;

  if v_side = 'debit' then
    return v_debit - v_credit;
  end if;

  return v_credit - v_debit;
end;
$function$

