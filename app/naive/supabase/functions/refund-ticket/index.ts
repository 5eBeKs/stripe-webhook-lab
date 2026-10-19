// The organiser refunds a ticket, in full or in part. The money goes back through Stripe; the ticket changes
// when Stripe reports the refund to the webhook (charge.refunded), not here.
import { admin, json, preflight, stripe, userFrom } from "../_shared/clients.ts";

Deno.serve(async (req) => {
  const early = preflight(req);
  if (early) return early;
  const user = await userFrom(req);
  if (!user) return json({ error: "Sign in first" }, 401);

  const { data: staff, error: staffError } = await admin
    .from("staff").select("user_id").eq("user_id", user.id).maybeSingle();
  if (staffError) return json({ error: staffError.message }, 500);
  if (!staff) return json({ error: "Only the organiser can refund" }, 403);

  const { ticket_id, amount_cents } = await req.json();
  const { data: ticket, error } = await admin
    .from("tickets").select("id, payment_intent_id").eq("id", ticket_id).maybeSingle();
  if (error) return json({ error: error.message }, 500);
  if (!ticket?.payment_intent_id) return json({ error: "This ticket has no payment to refund" }, 409);

  const refund = await stripe.refunds.create({ payment_intent: ticket.payment_intent_id, amount: amount_cents });
  return json({ refund_id: refund.id, status: refund.status });
});
