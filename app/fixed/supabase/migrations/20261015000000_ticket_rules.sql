-- The ticket rules that live in the database: who may write a ticket, its states, who gets in at the door.

-- A ticket becomes paid only through the checkout functions, which use the service role after Stripe reports
-- the payment. The app never writes tickets from the browser, so buyers need no write access at all.
drop policy "buyers add their tickets" on public.tickets;
revoke insert, update, delete on public.tickets from anon, authenticated;

-- A delayed payment (a bank debit, for one) waits in 'processing' and ends in 'paid' or 'failed'.
alter table public.tickets drop constraint tickets_status_check;
alter table public.tickets add constraint tickets_status_check
  check (status in ('pending', 'processing', 'paid', 'partially_refunded', 'refunded', 'expired', 'failed'));

-- The door admits a ticket that is paid or partly refunded, once.
create or replace function public.check_in(p_code text) returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  t public.tickets;
begin
  if not public.is_staff() then
    raise exception 'staff only' using errcode = '42501';
  end if;
  select * into t from public.tickets where code = p_code for update;
  if not found then
    return jsonb_build_object('admitted', false, 'reason', 'unknown code');
  end if;
  if t.status not in ('paid', 'partially_refunded') then
    return jsonb_build_object('admitted', false, 'reason', 'ticket is ' || replace(t.status, '_', ' '));
  end if;
  if t.checked_in_at is not null then
    return jsonb_build_object('admitted', false, 'reason', 'already checked in');
  end if;
  update public.tickets set checked_in_at = now(), updated_at = now() where id = t.id;
  return jsonb_build_object('admitted', true);
end
$$;
