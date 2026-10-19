// Stripe's events for ticket purchases: a paid checkout confirms the ticket, an expired one closes it, a
// refund marks it refunded.
//
// Stripe may deliver an event more than once, late, or after a later one, and delivers it again when the
// answer is not 2xx. So each change applies only to a ticket in the state it expects, and the answer is 2xx
// only once the change is saved.
import { admin, type Charge, cryptoProvider, json, type Session, stripe, ticketCode } from "../_shared/clients.ts";

const WEBHOOK_SECRET = Deno.env.get("STRIPE_WEBHOOK_SECRET")!;
const WAITING = ["pending", "processing"];
const now = () => new Date().toISOString();

async function saved(query: PromiseLike<{ error: unknown }>) {
  const { error } = await query;
  if (error) throw error;
}

// The money is in: confirm a ticket that is still waiting for it. A settled ticket (paid, refunded) is left
// as it is, so a repeated or late event cannot undo a refund.
function paid(session: Session) {
  return saved(
    admin.from("tickets")
      .update({
        status: "paid",
        amount_cents: session.amount_total,
        payment_intent_id: session.payment_intent,
        code: ticketCode(),
        updated_at: now(),
      })
      .eq("checkout_session_id", session.id).in("status", WAITING),
  );
}

async function refunded(charge: Charge) {
  const status = charge.amount_refunded >= charge.amount ? "refunded" : "partially_refunded";
  // On a ticket that knows its payment, a refund only grows: an older event (an earlier partial refund,
  // delivered after a later full one) carries a smaller amount and changes nothing.
  const onKnownTicket = () =>
    saved(
      admin.from("tickets")
        .update({ status, refunded_cents: charge.amount_refunded, updated_at: now() })
        .eq("payment_intent_id", charge.payment_intent).lt("refunded_cents", charge.amount_refunded),
    );

  const { data: known, error } = await admin
    .from("tickets").select("id").eq("payment_intent_id", charge.payment_intent).limit(1);
  if (error) throw error;
  if (known.length) return onKnownTicket();

  // The refund can come before the ticket knows its payment: the confirmation was lost or is still being
  // retried. Find the ticket through the checkout of this payment and record the payment and the refund on
  // it; the late confirmation then finds it settled and leaves it alone. A ticket refunded in part is still
  // valid, so it gets its code here.
  const sessions = await stripe.checkout.sessions.list({ payment_intent: charge.payment_intent as string, limit: 1 });
  if (!sessions.data.length) return;
  const { data: early, error: earlyError } = await admin
    .from("tickets")
    .update({
      status,
      amount_cents: charge.amount,
      payment_intent_id: charge.payment_intent,
      refunded_cents: charge.amount_refunded,
      ...(status === "partially_refunded" ? { code: ticketCode() } : {}),
      updated_at: now(),
    })
    .eq("checkout_session_id", sessions.data[0].id).in("status", WAITING)
    .select("id");
  if (earlyError) throw earlyError;
  // Meanwhile the confirmation, the success page or another refund event may have settled the ticket and
  // recorded its payment: then the refund goes on it as on any ticket that knows its payment.
  if (!early.length) await onKnownTicket();
}

Deno.serve(async (req) => {
  const body = await req.text();
  let event;
  try {
    event = await stripe.webhooks.constructEventAsync(
      body, req.headers.get("Stripe-Signature") ?? "", WEBHOOK_SECRET, undefined, cryptoProvider,
    );
  } catch {
    return json({ error: "Invalid signature" }, 400);
  }

  try {
    switch (event.type) {
      case "checkout.session.completed": {
        const session = event.data.object as Session;
        // A delayed payment method completes the checkout unpaid, before the money arrives: the ticket waits
        // for checkout.session.async_payment_succeeded.
        if (session.payment_status !== "unpaid") await paid(session);
        else {
          await saved(
            admin.from("tickets").update({ status: "processing", updated_at: now() })
              .eq("checkout_session_id", session.id).eq("status", "pending"),
          );
        }
        break;
      }
      case "checkout.session.async_payment_succeeded":
        await paid(event.data.object as Session);
        break;
      // The failure can come before the completed event (lost in an outage, or still being retried): a ticket
      // still pending fails too, and the late completed event leaves it failed.
      case "checkout.session.async_payment_failed":
        await saved(
          admin.from("tickets").update({ status: "failed", updated_at: now() })
            .eq("checkout_session_id", (event.data.object as Session).id).in("status", WAITING),
        );
        break;
      case "checkout.session.expired":
        await saved(
          admin.from("tickets").update({ status: "expired", updated_at: now() })
            .eq("checkout_session_id", (event.data.object as Session).id).eq("status", "pending"),
        );
        break;
      case "charge.refunded":
        await refunded(event.data.object as Charge);
        break;
    }
  } catch (err) {
    console.error(`${event.type} ${event.id} not saved`, err);
    return json({ error: "Not saved; deliver again" }, 500);
  }

  return json({ received: true });
});
