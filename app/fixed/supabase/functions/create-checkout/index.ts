// "Buy ticket": a Stripe Checkout for one ticket, and a pending ticket that the webhook or the
// success page confirms once the buyer has paid.
import { admin, json, preflight, SITE_URL, stripe, userFrom } from "../_shared/clients.ts";

Deno.serve(async (req) => {
  const early = preflight(req);
  if (early) return early;
  const user = await userFrom(req);
  if (!user) return json({ error: "Sign in to buy a ticket" }, 401);
  const { event_id } = await req.json();

  const { data: event, error } = await admin
    .from("events").select("id, stripe_price_id").eq("id", event_id).maybeSingle();
  if (error) return json({ error: error.message }, 500);
  if (!event) return json({ error: "No such event" }, 404);

  // A buyer who already holds a ticket for this event, or whose delayed payment for it is on its way, is
  // shown it instead of paying again.
  const { data: held, error: heldError } = await admin
    .from("tickets").select("id, status")
    .eq("event_id", event.id).eq("user_id", user.id)
    .in("status", ["paid", "partially_refunded", "processing"])
    .limit(1);
  if (heldError) return json({ error: heldError.message }, 500);
  if (held.length) return json({ status: held[0].status, ticket_id: held[0].id });

  const session = await stripe.checkout.sessions.create({
    mode: "payment",
    line_items: [{ price: event.stripe_price_id, quantity: 1 }],
    customer_email: user.email,
    metadata: { event_id: event.id, user_id: user.id },
    success_url: `${SITE_URL}/tickets/success?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${SITE_URL}/events/${event.id}`,
  });

  const { error: insertError } = await admin
    .from("tickets").insert({ event_id: event.id, user_id: user.id, checkout_session_id: session.id });
  if (insertError) return json({ error: insertError.message }, 500);

  return json({ url: session.url });
});
