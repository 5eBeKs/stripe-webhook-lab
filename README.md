# Stripe webhook lab: a ticket app in two versions, one command

This repository holds a small Supabase + Stripe app that sells event tickets, in two versions, and a stand that runs both on your machine with no way out to the internet. The stand plays Stripe's side and checks each version against the same written rules.

- The app was written for this demonstration and is kept short on purpose.
- `app/naive` has six defects in its payment flow. Each follows a pattern common in Supabase + Stripe apps.
- `app/fixed` is the same app with those six defects fixed, and with one more case that the naive version also gets wrong: an older refund event that arrives after a newer one.

None of the topics is new. Stripe's documentation says that an event can arrive more than once and out of order, and that it is delivered again when the answer is not 2xx. It also covers payment methods that pay later. What this repository adds is a stand where each case happens in both versions, with one command and a table of what came back.

## Run it

With Docker (Compose v2 or later), from the repository's folder:

```
docker compose run --rm check
```

The first run downloads the official images, about 3.3 GB on disk. Every run also downloads, in a separate step, the npm packages the functions import, so it needs the internet. Then it checks both versions and prints a table for each: the rule, what it expects, what came back, and whether they match. The last line sums up both versions:

```
naive: 21 of 36 rows differ / fixed: all 36 rows match
```

`runs/check.txt` is the full output of that command on a clean clone. A run takes about a minute once the images are there. No port is opened on your machine.

- `.env` makes Compose pull the images one at a time. If a registry still answers `Rate exceeded`, run the command again; the images already pulled are kept.
- On a host with SELinux enforcing (Fedora, RHEL), add `:z` to every mount from the repository in `compose.yaml`, files as well as folders (`./app:/app:ro,z`, `./stand/certs.sh:/certs.sh:ro,z`, `./stand/bundle.sh`, `./stand/db/init.sql`, and so on), or the containers cannot read them.

To remove the stand and its volumes:

```
docker compose down -v
```

## The stand

- **Supabase**: one per version, from Supabase's official images. Each has Postgres (`supabase/postgres`), auth (GoTrue) and the database API (PostgREST).
  - The version's migrations are applied in name order, each file in one transaction, as `supabase db reset` applies them.
  - The database lives in memory and is gone after `docker compose down`.
- **Functions**: they run in Supabase's edge-runtime, each from one eszip bundle with its imports, behind the stand's gateway (`stand/gateway/index.ts`). The gateway stands in for Supabase's API gateway:
  - it checks the caller's JWT unless the version's `supabase/config.toml` sets `verify_jwt = false`;
  - it passes calls through to that version's auth and database API.
- **Stripe**: `stand/stripe/server.mjs` answers as `api.stripe.com` inside the stand's network, with a certificate from a test CA made for this stand. The functions use the official Stripe SDK unchanged; the edge-runtime is given that CA as the one to trust.
- **Stripe's events**: the check signs them the way Stripe does, with the endpoint's secret:
  - the header is `Stripe-Signature: t=<time>,v1=<HMAC-SHA256 of "<time>.<payload>">`;
  - the webhook verifies it with the SDK's `constructEventAsync`.
- **Network**: the stand's network has no way out. Before any row, the check makes sure that `example.com` does not resolve, `1.1.1.1` cannot be reached, and `api.stripe.com` is the stand's Stripe; otherwise it stops.
  - Only the bundle step goes online, on a network of its own. It downloads the functions' imports and packs them; it does not run the functions. The two top-level packages are pinned in the code; their dependencies resolve at bundle time (there is no lock file).
- **Outages**: the gateway can make one version's database API fail in two ways:
  - **refuses**: it answers 503 at once, as when the database refuses connections;
  - **hangs**: it does not answer until the outage ends, as when the database stops responding; then the held requests go on.
- **The check** stands in for Stripe during an outage. It waits 10 seconds for the webhook's answer. When the answer is not 2xx, it delivers the same event once more after the outage, as Stripe's retry would, and waits up to 60 seconds for that answer.

The images are pinned by digest. The secrets in `compose.yaml` are placeholders that work only inside the stand; none of them is a real key.

## The rules

The rules come from Stripe's documentation and from what the app itself sets out to do. The [webhooks page](https://docs.stripe.com/webhooks) says three things:
- an endpoint "might occasionally receive the same event more than once";
- Stripe does not guarantee the order of events;
- an event is delivered again when the answer is not 2xx, for up to three days in live mode and three times over a few hours in a sandbox ([automatic retries](https://docs.stripe.com/webhooks#automatic-retries)).

The [Checkout fulfilment guide](https://docs.stripe.com/checkout/fulfillment) says to fulfil by `payment_status` and to wait for `checkout.session.async_payment_succeeded` when the payment method pays later. It also says that fulfilment may be triggered from both the webhook and the success page, more than once.

| Rule | What the app must do | Rows |
|---|---|---|
| R1 | A paid checkout gives the buyer one paid ticket with a code, whichever comes first, the webhook or the success page. A checkout left unpaid gives none. | 1–4 |
| R2 | A ticket is given only for money received, as Stripe reports it: not for an event without Stripe's signature, not while a bank debit is on its way, never for one that failed. No second checkout while it is on its way. | 5–11 |
| R3 | A settled ticket stays settled: an event delivered again or the success page opened again does not undo a refund. The organiser's figures show every refund. | 12–17 |
| R4 | A refund reaches the ticket even when it comes before the ticket was confirmed. | 18–22 |
| R5 | The webhook answers 2xx only once the change is saved, so that Stripe delivers the event again otherwise. | 23–30 |
| R6 | Only a payment makes a paid ticket: a buyer cannot write one through the database API. | 31–32 |
| R7 | The door admits a paid or partly refunded ticket, once. | 33–36 |

Each group of rows starts from its own event at 25.00 EUR and its own buyers. Within a group, a row may go on from the one before it: row 3 is the webhook arriving after row 2's success page, for one.

## The six defects, and the rows that show them

In `app/naive`, 21 of the 36 rows differ. In `app/fixed`, all 36 match. To see every change between the two versions:

```
git diff --no-index app/naive app/fixed
```

### 1. A confirmation overwrites a refund (rows 13, 14, 16; with defect 4, rows 19, 20, 22)

Both the webhook and the success page confirm a ticket by writing all of its payment fields, whatever state the ticket is in:

```ts
.update({
  status: "paid",
  amount_cents: session.amount_total,
  payment_intent_id: session.payment_intent,
  refunded_cents: 0,
  code: ticket.code ?? ticketCode(),
  updated_at: new Date().toISOString(),
})
.eq("id", ticket.id);
```

So a refunded ticket becomes paid again, with no refund on it, in two cases: Stripe delivers `checkout.session.completed` again (row 13), or the buyer opens the success page again from the browser's history (row 14). The buyer gets a valid ticket back. The organiser's figures lose the refunds (row 16): 10.00 refunded and 65.00 net, instead of 60.00 and 15.00.

The fix: only a ticket that is still waiting for its payment is confirmed (`.in("status", ["pending", "processing"])`). A settled ticket is left as it is, and the success page shows it as it is. Rows 19, 20 and 22 need this fix as well as the fix for defect 4: once the refund reaches the ticket, the late confirmation must not overwrite it.

### 2. A ticket for a checkout that is not paid yet (rows 6–10)

With a payment method that pays later, such as a bank debit, Checkout completes before the money arrives: `checkout.session.completed` comes with `payment_status: "unpaid"`. The naive webhook does not look at `payment_status`. So it gives a paid ticket with a code at once (row 6), and Buy shows it as paid (row 7). It ignores `checkout.session.async_payment_failed`, so the ticket stays valid when the debit fails (row 8), and Buy shows that ticket instead of a new checkout (row 9); a completed event that arrives after the failure makes it paid (row 10).

The fix:
- an unpaid completed checkout puts the ticket in `processing`;
- `async_payment_succeeded` makes it paid; `async_payment_failed` makes it `failed`, also when it comes before the completed event (row 10), so that the late completed event finds it failed and leaves it;
- while a ticket is `processing`, Buy shows it, as processing, instead of opening a second checkout (row 7); once it has failed, Buy opens a new checkout (row 9).

### 3. 200 when the database fails (rows 23–26)

The naive webhook logs a failed read or write and answers 200 anyway. When the database refuses:
- for a purchase, the paid buyer's ticket stays pending (rows 23, 24);
- for a refund, the refund never reaches the ticket (rows 25, 26);
- in both cases Stripe takes the 200 as done and does not deliver the event again.

When the database hangs instead (rows 27–30), the webhook gives no answer, so Stripe delivers again, and both versions end with the right ticket. In the two versions here, rows 27 and 29 cannot differ: each waits on the database, so there is no 2xx to check.

The fix: any error while saving answers 500, so that Stripe delivers the event again. Stripe advises answering 2xx quickly, before any complex logic. Here the work is a read and one or two short writes, and a refund that comes early adds one call to Stripe, so the webhook saves the change and then answers; a handler with slow work would first save the event (in a queue, for one), answer, and do the work after.

### 4. A refund that comes before the confirmation is lost (rows 18–22)

A pending ticket does not know its payment yet: it learns the payment intent from `checkout.session.completed`. So when that event was lost or is still being retried, and the organiser refunds in the Stripe Dashboard, `charge.refunded` finds no ticket. The naive webhook answers 200 and the refund is gone (row 18). The late confirmation then makes the ticket paid (row 19), and the figures show 25.00 net instead of 0.00 (row 20). A partial refund is lost the same way (row 21), and the late confirmation then makes the ticket paid in full (row 22).

The fix: when no ticket has the refunded payment yet, the webhook asks Stripe for the checkout of that payment and records the payment and the refund on its ticket. A ticket refunded in part is still valid, so it gets its code there, and the door admits it (row 22). The late confirmation then finds the ticket settled and leaves it alone. If the confirmation, the success page or another refund event settles the ticket while the webhook is looking for it, the refund goes on the ticket by its payment, as on any confirmed ticket.

### 5. Buyers may write to the paid table (rows 31, 32)

The first migration has an insert policy on `tickets` for signed-in buyers:

```sql
create policy "buyers add their tickets" on public.tickets
  for insert to authenticated with check (user_id = auth.uid());
```

The app never writes tickets from the browser; only the functions do, with the service role. But with this policy, any signed-in account can give itself a paid ticket with a code and an amount of 0 through the database API (row 31), and the door admits it (row 32). A door that checks the status would not stop it: the ticket says paid.

The fix, a new migration: the policy is dropped, and the insert, update and delete grants on `tickets` are revoked from `anon` and `authenticated`.

### 6. The door ignores the ticket's status (row 36)

`check_in` finds a ticket by its code and admits it, whatever its status, so a refunded ticket gets in (row 36). The fix: the door admits a paid or partly refunded ticket only (rows 35, 36).

### Also in the rows: an older refund event after a newer one (row 17)

This case is not one of the six patterns, and `app/naive` gets it wrong as well. A buyer is refunded 10.00 and then the other 15.00, and Stripe delivers the first refund's `charge.refunded` last. The webhook writes whatever amount the event carries, so the ticket, refunded in full, becomes partly refunded again, with a valid code.

The fix: a refund on a ticket only grows. The webhook updates the ticket only when the event's refunded amount is larger than the one already recorded (`.lt("refunded_cents", charge.amount_refunded)`), so an older event changes nothing.

## What the rows do not show

- **Stripe's test mode.** The events and objects here come from the stand's Stripe. They carry the fields the app reads, in Stripe's shape, but they are not Stripe's own. A run against a real test-mode account, with `stripe listen` forwarding its events to the stand, would be a separate step.
- **The browser.** The front end is not part of the app; the check calls the functions the way a browser would.
- **Retry timing.** Stripe's retry timing and its wait for an answer are not reproduced. During an outage the check waits 10 seconds for an answer; it then delivers again once, right after the outage, and waits up to 60 seconds for that answer.
- **A refund event that meets the confirmation.** A refund event finds no ticket for its payment, and before it writes, the late confirmation, the success page or another refund event settles the ticket. `app/fixed` then puts the refund on the ticket by its payment; the code covers this, but no row makes the two calls meet at that moment.
- **Cases outside the rows**, in both versions:
  - two deliveries of the same event at the same moment;
  - disputes, coupons, several tickets in one checkout.

## Pointing the stand at another Supabase + Stripe repository

The stand is not tied to this app. To run it on another project, follow the steps below. After any change under `app/`, run `docker compose down -v` before the next run: otherwise the migration step finds its earlier work and skips ("migrations already applied"), and the gateway keeps the functions it loaded first.

1. **Versions.** Put each version of the project under `app/<version>/`, with its `supabase/` folder: `migrations/`, `functions/` and `config.toml`. For example, the commit as received in `app/as-received` and your fixes in `app/fixed`.
2. **Names.** In `compose.yaml`, the names `naive` and `fixed` appear in three places:
   - `VERSIONS` of the `bundle`, `gateway` and `check` services;
   - the four services per version: `db-`, `auth-`, `migrate-` and `rest-`;
   - the gateway's `depends_on`, which names each version's `auth-` and `rest-` services.

   Rename them, or copy the four services for a third version and add it to the gateway's `depends_on`.
3. **Migrations.** `stand/db/migrate.sh` applies `supabase/migrations/*.sql` in name order, as the `postgres` role, then `supabase/seed.sql` if there is one. If a file fails, `docker compose logs migrate-<version>` names it.
   - A common cause is an object made by a Supabase service the stand does not run, such as Storage or Realtime.
   - Either add that service from Supabase's self-hosting setup, or create the objects in `stand/db/before-migrations.sql`, which runs first, as the superuser.
   - Settings a project keeps outside its migrations (Vault secrets, for one) go in the same file.
4. **Functions.** `stand/bundle.sh` packs every folder in `supabase/functions/` that has an `index.ts`. Folders whose names start with `_` count as shared code.
   - Imports must be reachable at bundle time (`npm:`, `jsr:`, `https:`).
   - If the functions use an import map, pass it to `edge-runtime bundle` in that script.
5. **Environment.** The gateway gives every function three variables: `SUPABASE_URL` (which points back at the gateway), `SUPABASE_ANON_KEY` and `SUPABASE_SERVICE_ROLE_KEY`. It does not give the newer `SUPABASE_PUBLISHABLE_KEY` and `SUPABASE_SECRET_KEY`.
   - Name any other variable the functions read in `FUNCTION_ENV`, and give it a placeholder value in the gateway's `environment`. `FUNCTION_ENV` gives the same value to every version.
   - So a function that connects to Postgres directly (`SUPABASE_DB_URL`) needs a change in `stand/gateway/index.ts`: add the variable where the gateway sets `SUPABASE_URL`, with the address of that version's `db-<version>` service. That connection bypasses the gateway, so the stand's outages do not reach it.
6. **Stripe.** The stand's Stripe answers the calls listed at the top of `stand/stripe/server.mjs`.
   - The output's line "Stripe calls the stand did not answer" names any other call the functions make. Add it to that file.
   - Checkout is covered in `payment` mode only. A Checkout in another mode, or with a price that is not in `PRICES`, is answered 400 and named on the same line.
   - Prices go in `PRICES` in `compose.yaml`; inline `price_data` works as it is.
7. **Other outside services** (email, SMS): the network has no way out, so their calls fail. To answer one:
   - add a stand-in service with the real host name as a network alias, as the `stripe` service has, with the `tls` volume and `depends_on: certs`;
   - add that service to the gateway's `depends_on`;
   - add the name to `subjectAltName` in `stand/certs.sh`;
   - run `docker compose down -v`, so that the certificate is made again.
8. **Rows.** `stand/check/rows.mjs` holds the rows and the rule texts. `stand/check/lib.mjs` holds the helpers:
   - accounts, a checkout and the buyer's payment on Stripe's side;
   - signed events, refunds from the app and from the Dashboard;
   - outages, and reads through the database API.

   The parts that know this app (its tables, its function names, `event()`, `tickets()`, `figures()`, `checkIn()`) are the ones to rewrite. Accounts are made through GoTrue's admin API.

## What is here

| Path | What it is |
|---|---|
| `app/naive/supabase/` | The app with the six defects: one migration, four functions, `config.toml` |
| `app/fixed/supabase/` | The same app fixed: a second migration and changes to three of the functions |
| `compose.yaml` | The stand and the `check` service |
| `.env` | Compose settings: pull the images one at a time |
| `stand/gateway/index.ts` | The gateway: functions from their bundles, the JWT check, pass-through to auth and the database API, outages |
| `stand/stripe/server.mjs` | The stand's Stripe, as `api.stripe.com` |
| `stand/db/` | The database's first-start script and the migration step |
| `stand/certs.sh`, `stand/bundle.sh` | The stand's test CA and certificate; the bundle step |
| `stand/check/` | The check: `run.mjs` (network, tables, summary), `rows.mjs` (the rows), `lib.mjs` (the helpers) |
| `runs/check.txt` | The output of `docker compose run --rm check` on a clean clone |
| `LICENSE` | MIT |

The functions:
- `create-checkout` opens a Stripe Checkout for one ticket and makes a pending ticket;
- `verify-checkout` is the success page's call;
- `stripe-webhook` handles Stripe's events;
- `refund-ticket` lets the organiser refund in full or in part. The money goes back through Stripe, and the ticket changes when Stripe reports the refund to the webhook.
