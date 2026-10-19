-- Tickets for paid events, bought through Stripe Checkout.
--   events   what is on sale, with its Stripe price
--   staff    the organiser's accounts: refunds, figures, check-in at the door
--   tickets  one row per purchase; the checkout functions create and update it with the service role

create table public.events (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  starts_at timestamptz not null,
  price_cents integer not null check (price_cents > 0),
  currency text not null default 'eur',
  stripe_price_id text not null,
  created_at timestamptz not null default now()
);

create table public.staff (
  user_id uuid primary key references auth.users (id) on delete cascade
);

create table public.tickets (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references public.events (id),
  user_id uuid not null references auth.users (id),
  status text not null default 'pending'
    check (status in ('pending', 'paid', 'partially_refunded', 'refunded', 'expired')),
  checkout_session_id text unique,
  payment_intent_id text,
  amount_cents integer not null default 0,
  refunded_cents integer not null default 0,
  code text unique,
  checked_in_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index tickets_payment_intent_id on public.tickets (payment_intent_id);
create index tickets_event_user on public.tickets (event_id, user_id);

create function public.is_staff() returns boolean
language sql stable security definer set search_path = ''
as $$ select exists (select 1 from public.staff where user_id = auth.uid()) $$;

alter table public.events enable row level security;
alter table public.staff enable row level security;
alter table public.tickets enable row level security;

create policy "events are public" on public.events
  for select to anon, authenticated using (true);
create policy "staff manage events" on public.events
  for all to authenticated using (public.is_staff()) with check (public.is_staff());
create policy "staff see staff" on public.staff
  for select to authenticated using (public.is_staff());
create policy "buyers see their tickets" on public.tickets
  for select to authenticated using (user_id = auth.uid() or public.is_staff());
create policy "buyers add their tickets" on public.tickets
  for insert to authenticated with check (user_id = auth.uid());

-- Check-in at the door: staff enter the code from the buyer's ticket.
create function public.check_in(p_code text) returns jsonb
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
  if t.checked_in_at is not null then
    return jsonb_build_object('admitted', false, 'reason', 'already checked in');
  end if;
  update public.tickets set checked_in_at = now(), updated_at = now() where id = t.id;
  return jsonb_build_object('admitted', true);
end
$$;

-- The organiser's figures for one event: tickets sold, money taken, money refunded, what is left.
create function public.event_revenue(p_event_id uuid)
returns table (sold bigint, gross_cents bigint, refunds_cents bigint, net_cents bigint)
language plpgsql stable security definer set search_path = ''
as $$
begin
  if not public.is_staff() then
    raise exception 'staff only' using errcode = '42501';
  end if;
  return query
    select count(*),
           coalesce(sum(t.amount_cents), 0)::bigint,
           coalesce(sum(t.refunded_cents), 0)::bigint,
           coalesce(sum(t.amount_cents - t.refunded_cents), 0)::bigint
    from public.tickets t
    where t.event_id = p_event_id
      and t.status in ('paid', 'partially_refunded', 'refunded');
end
$$;
