// Stripe's events for ticket purchases: a completed checkout confirms the ticket, an expired one closes it,
// a refund marks it refunded.
import { admin, type Charge, cryptoProvider, json, type Session, stripe, ticketCode } from "../_shared/clients.ts";

const WEBHOOK_SECRET = Deno.env.get("STRIPE_WEBHOOK_SECRET")!;

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
    if (event.type === "checkout.session.completed") {
      const session = event.data.object as Session;
      const { data: ticket, error } = await admin
        .from("tickets").select("id, code").eq("checkout_session_id", session.id).maybeSingle();
      if (error || !ticket) {
        console.error("No ticket for checkout", session.id, error);
      } else {
        const { error: updateError } = await admin
          .from("tickets")
          .update({
            status: "paid",
            amount_cents: session.amount_total,
            payment_intent_id: session.payment_intent,
            refunded_cents: 0,
            code: ticket.code ?? ticketCode(),
            updated_at: new Date().toISOString(),
          })
          .eq("id", ticket.id);
        if (updateError) console.error("Could not confirm ticket", ticket.id, updateError);
      }
    }

    if (event.type === "checkout.session.expired") {
      const session = event.data.object as Session;
      const { error } = await admin
        .from("tickets").update({ status: "expired", updated_at: new Date().toISOString() })
        .eq("checkout_session_id", session.id).eq("status", "pending");
      if (error) console.error("Could not expire ticket", session.id, error);
    }

    if (event.type === "charge.refunded") {
      const charge = event.data.object as Charge;
      const status = charge.amount_refunded >= charge.amount ? "refunded" : "partially_refunded";
      const { error } = await admin
        .from("tickets")
        .update({ status, refunded_cents: charge.amount_refunded, updated_at: new Date().toISOString() })
        .eq("payment_intent_id", charge.payment_intent);
      if (error) console.error("Could not record refund", charge.id, error);
    }
  } catch (err) {
    console.error("Webhook handler failed", err);
  }

  return json({ received: true });
});
