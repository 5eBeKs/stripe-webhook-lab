// The success page calls this with the checkout id from its URL, so that the buyer sees the ticket
// at once instead of waiting for the webhook.
import { admin, json, preflight, stripe, ticketCode, userFrom } from "../_shared/clients.ts";

Deno.serve(async (req) => {
  const early = preflight(req);
  if (early) return early;
  const user = await userFrom(req);
  if (!user) return json({ error: "Sign in to see your ticket" }, 401);
  const { session_id } = await req.json();

  const session = await stripe.checkout.sessions.retrieve(session_id);
  const { data: ticket, error } = await admin
    .from("tickets").select("id, status, code")
    .eq("checkout_session_id", session.id).eq("user_id", user.id)
    .maybeSingle();
  if (error) return json({ error: error.message }, 500);
  if (!ticket) return json({ error: "No ticket for this checkout" }, 404);

  if (session.payment_status !== "paid") return json({ status: ticket.status });

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
  if (updateError) return json({ error: updateError.message }, 500);

  return json({ status: "paid" });
});
