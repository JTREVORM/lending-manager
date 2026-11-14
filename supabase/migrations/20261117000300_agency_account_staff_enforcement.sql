-- ===========================================================================
-- Polytos Agency redesign — the roster applies to float trades and cash
-- banking too
--
-- `20261117000200` put the roster on the transaction engine with a trigger.
-- Two other paths move money against a named agent account and needed the
-- same gate, for the reason the Owner's decision gives: an unassigned officer
-- must not be able to record or post against an account.
--
--   * **float trades** — buying float into an account, selling it off, moving
--     it between two of a provider's accounts. `agency_float_trades` names
--     `float_account_id` and, for a transfer, `counter_float_account_id`.
--     **Both** ends are checked on a transfer: moving float *into* an account
--     somebody may not operate is as much a use of it as moving float out.
--
--   * **cash banking** — `agency_cash_bankings` names no agent account at
--     all. It moves the branch's own cash to the branch's own bank, which is
--     company money rather than an agent account's, so there is nothing to be
--     assigned to. It is deliberately **not** gated here, and the reason is
--     recorded so the omission reads as a decision rather than an oversight.
--     Its control is the one it already has: `agency:write` to record,
--     `agency:settlements` to post, and the two must be different people.
--
-- A trigger again rather than edits to the recording functions, so a path
-- added later is covered without remembering to call anything.
-- ===========================================================================


create or replace function public.agency_float_trade_operator_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    perform public.assert_agency_account_operator(
      new.float_account_id, new.created_by, 'record a float movement');

    -- The receiving end of a transfer. Null for a purchase or a sale, where
    -- `assert_agency_account_operator` returns without complaint.
    perform public.assert_agency_account_operator(
      new.counter_float_account_id, new.created_by,
      'move float into that account');

    return new;
  end if;

  -- Posting. `agency_float_trades` calls the posted state 'posted'.
  if new.status = 'posted' and coalesce(old.status, '') <> 'posted' then
    perform public.assert_agency_account_operator(
      new.float_account_id, new.verified_by, 'post a float movement');
    perform public.assert_agency_account_operator(
      new.counter_float_account_id, new.verified_by,
      'post float into that account');
  end if;

  return new;
end;
$$;

comment on function public.agency_float_trade_operator_guard() is
  'Polytos Agency redesign, client Rule 6. Refuses a float purchase, sale or transfer recorded or posted by an officer not assigned to the agent account. Both ends of a transfer are checked, because moving float into an account somebody may not operate is as much a use of it as moving float out. Rejection and reversal are exempt, like the transaction engine''s guard: one moves no money and the other is a correction that must not be trapped behind a roster change.';

revoke all on function public.agency_float_trade_operator_guard()
  from public, anon, authenticated;

create trigger agency_float_trades_operator_guard
  before insert or update on public.agency_float_trades
  for each row execute function public.agency_float_trade_operator_guard();
