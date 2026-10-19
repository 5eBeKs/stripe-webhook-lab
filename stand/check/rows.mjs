// The rows: for each rule of the ticket app, what the rule expects and what the version did.
import { app, sleep, stripe, stripeEvent } from "./lib.mjs";

export const RULES = {
  R1: "A paid checkout gives the buyer one paid ticket with a code, whichever comes first, the webhook or the success page. A checkout left unpaid gives none.",
  R2: "A ticket is given only for money received, as Stripe reports it: not for an event without Stripe's signature, not while a bank debit is on its way, never for one that failed. No second checkout while it is on its way.",
  R3: "A settled ticket stays settled: an event delivered again or the success page opened again does not undo a refund. The organiser's figures show every refund.",
  R4: "A refund reaches the ticket even when it comes before the ticket was confirmed.",
  R5: "The webhook answers 2xx only once the change is saved, so that Stripe delivers the event again otherwise.",
  R6: "Only a payment makes a paid ticket: a buyer cannot write one through the database API.",
  R7: "The door admits a paid or partly refunded ticket, once.",
};

const money = (cents) => (Number(cents) / 100).toFixed(2);
const one = (t) => {
  const amount = Number(t.amount_cents);
  const back = Number(t.refunded_cents);
  let text = t.status.replace("_", " ");
  if (back) text += ` ${money(back)} of ${money(amount)}`;
  else if (amount || t.status === "paid") text += ` ${money(amount)}`;
  return t.code ? `${text}, code` : text;
};
const show = (tickets) => tickets.length === 0 ? "no ticket" : tickets.map(one).join(" | ");
const answer = (r) => typeof r.status === "number" ? `answer ${r.status}` : r.status;
const isPaid = (t) => t?.status === "paid" && Number(t.amount_cents) === 2500 && !!t.code;
const is2xx = (r) => typeof r.status === "number" && r.status >= 200 && r.status < 300;
const figuresText = (f) => f ? `${f.sold} sold, gross ${money(f.gross_cents)}, refunds ${money(f.refunds_cents)}, net ${money(f.net_cents)}` : "no figures";
const figuresAre = (f, sold, gross, refunds) =>
  !!f && Number(f.sold) === sold && Number(f.gross_cents) === gross && Number(f.refunds_cents) === refunds &&
  Number(f.net_cents) === gross - refunds;
const door = (r) => r?.admitted ? "admitted" : `not admitted${r?.reason ? ` (${r.reason})` : ""}`;

export async function checkVersion(version) {
  const lab = app(version);
  const rows = [];
  const row = (rule, expected, got, ok) => rows.push({ rule, expected, got, ok: !!ok });
  const part = async (name, steps) => {
    try {
      await steps();
    } catch (e) {
      rows.push({ rule: "-", expected: `${name}: runs to the end`, got: `stopped: ${e.message}`.slice(0, 120), ok: false });
    }
  };
  await lab.outage("off");

  await part("a purchase", async () => {
    const event = await lab.event();
    {
      const buyer = await lab.account("buyer");
      const sid = await lab.checkout(buyer, event);
      await stripe.pay(sid);
      const w = await lab.deliver(await stripeEvent("checkout.session.completed", await stripe.session(sid)));
      const t = await lab.tickets(buyer, event);
      row("R1", "webhook first: answer 200; one paid ticket, 25.00, with a code",
        `${answer(w)}; ${show(t)}`, w.status === 200 && t.length === 1 && isPaid(t[0]));
    }
    {
      const buyer = await lab.account("buyer");
      const sid = await lab.checkout(buyer, event);
      await stripe.pay(sid);
      const page = await lab.successPage(buyer, sid);
      const t1 = await lab.tickets(buyer, event);
      row("R1", "success page first: the page says paid; one paid ticket",
        `page: ${page.data?.status ?? page.status}; ${show(t1)}`, page.data?.status === "paid" && t1.length === 1 && isPaid(t1[0]));
      await lab.deliver(await stripeEvent("checkout.session.completed", await stripe.session(sid)));
      const t2 = await lab.tickets(buyer, event);
      row("R1", "then the webhook: still one paid ticket, with the same code",
        `${show(t2)}${t2[0]?.code && t2[0].code !== t1[0]?.code ? " (a new code)" : ""}`,
        t2.length === 1 && isPaid(t2[0]) && t2[0].code === t1[0]?.code);
    }
    {
      const buyer = await lab.account("buyer");
      const sid = await lab.checkout(buyer, event);
      await stripe.expire(sid);
      const w = await lab.deliver(await stripeEvent("checkout.session.expired", await stripe.session(sid)));
      const t = await lab.tickets(buyer, event);
      row("R1", "checkout left unpaid until it expires: ticket expired, no code",
        `${answer(w)}; ${show(t)}`, t.length === 1 && t[0].status === "expired" && !t[0].code);
    }
  });

  await part("money received", async () => {
    const event = await lab.event();
    {
      const buyer = await lab.account("buyer");
      const sid = await lab.checkout(buyer, event);
      await stripe.pay(sid);
      const w = await lab.deliver(await stripeEvent("checkout.session.completed", await stripe.session(sid)),
        { secret: "whsec_of_some_other_endpoint" });
      const t = await lab.tickets(buyer, event);
      row("R2", "an event without Stripe's signature: answer 400, ticket unchanged",
        `${answer(w)}; ${show(t)}`, w.status === 400 && t.length === 1 && t[0].status === "pending");
    }
    {
      const buyer = await lab.account("buyer");
      const sid = await lab.checkout(buyer, event);
      await stripe.pay(sid, "unpaid");
      await lab.deliver(await stripeEvent("checkout.session.completed", await stripe.session(sid)));
      const t1 = await lab.tickets(buyer, event);
      row("R2", "bank debit: checkout completed, payment unpaid: no paid ticket yet",
        show(t1), t1.length === 1 && t1[0].status !== "paid" && !t1[0].code);
      const again = await lab.buy(buyer, event);
      const shown = again.data?.url ? "a second checkout to pay"
        : again.data?.ticket_id ? `${again.data.status}, ${again.data.ticket_id === t1[0]?.id ? "the same" : "another"} ticket`
        : "no ticket shown";
      row("R2", "the buyer presses Buy again meanwhile: the same ticket, processing",
        `${answer(again)}; ${shown}`,
        again.status === 200 && !again.data?.url && again.data?.status === "processing" && !!t1[0] &&
          again.data?.ticket_id === t1[0].id);
      await lab.deliver(await stripeEvent("checkout.session.async_payment_failed", await stripe.session(sid)));
      const t2 = await lab.tickets(buyer, event);
      row("R2", "the debit fails: ticket failed, no code", show(t2),
        t2.length === 1 && t2[0].status === "failed" && !t2[0].code);
      const retry = await lab.buy(buyer, event);
      row("R2", "then the buyer presses Buy again: a new checkout to pay",
        retry.data?.url ? `${answer(retry)}; a new checkout` : `${answer(retry)}; ${retry.data?.status ?? "no checkout"}`,
        retry.status === 200 && !!retry.data?.url);
    }
    {
      // the completed event is lost in an outage and still being retried when the debit fails
      const buyer = await lab.account("buyer");
      const sid = await lab.checkout(buyer, event);
      await stripe.pay(sid, "unpaid");
      const completed = await stripeEvent("checkout.session.completed", await stripe.session(sid));
      await lab.deliver(await stripeEvent("checkout.session.async_payment_failed", await stripe.session(sid)));
      await lab.deliver(completed);
      const t = await lab.tickets(buyer, event);
      row("R2", "a debit fails before its completed event arrives: failed, no code",
        show(t), t.length === 1 && t[0].status === "failed" && !t[0].code);
    }
    {
      const buyer = await lab.account("buyer");
      const sid = await lab.checkout(buyer, event);
      await stripe.pay(sid, "unpaid");
      await lab.deliver(await stripeEvent("checkout.session.completed", await stripe.session(sid)));
      await stripe.clear(sid);
      await lab.deliver(await stripeEvent("checkout.session.async_payment_succeeded", await stripe.session(sid)));
      const t = await lab.tickets(buyer, event);
      row("R2", "another debit clears: one paid ticket, 25.00, with a code",
        show(t), t.length === 1 && isPaid(t[0]));
    }
  });

  await part("refunds", async () => {
    const staff = await lab.organiser();
    const event = await lab.event();
    const a = await lab.paidTicket("buyer", event);
    await lab.deliver(await lab.refund(staff, a.ticket, 2500));
    const ta1 = await lab.tickets(a.buyer, event);
    row("R3", "refund 25.00 from the app: ticket refunded, 25.00",
      show(ta1), ta1[0]?.status === "refunded" && Number(ta1[0].refunded_cents) === 2500);
    await lab.deliver(a.completed);
    const ta2 = await lab.tickets(a.buyer, event);
    row("R3", "then Stripe delivers the completed event again: still refunded",
      show(ta2), ta2.length === 1 && ta2[0].status === "refunded" && Number(ta2[0].refunded_cents) === 2500);

    const b = await lab.paidTicket("buyer", event);
    await lab.deliver(await lab.refund(staff, b.ticket, 2500));
    const page = await lab.successPage(b.buyer, b.sid);
    const tb = await lab.tickets(b.buyer, event);
    row("R3", "another refunded buyer reopens the success page: still refunded",
      `page: ${page.data?.status ?? page.status}; ${show(tb)}`,
      tb.length === 1 && tb[0].status === "refunded" && Number(tb[0].refunded_cents) === 2500);

    const c = await lab.paidTicket("buyer", event);
    await lab.deliver(await lab.refund(staff, c.ticket, 1000));
    const tc = await lab.tickets(c.buyer, event);
    row("R3", "a third buyer, partial refund 10.00: partly refunded, 10.00",
      show(tc), tc[0]?.status === "partially_refunded" && Number(tc[0].refunded_cents) === 1000);

    const f = await lab.figures(staff, event);
    row("R3", "organiser's figures: 3 sold, gross 75.00, refunds 60.00, net 15.00",
      figuresText(f), figuresAre(f, 3, 7500, 6000));

    // a fourth buyer is refunded 10.00, then the other 15.00; Stripe delivers the first refund's event last
    const d = await lab.paidTicket("buyer", event);
    const first = await lab.refund(staff, d.ticket, 1000);
    const rest = await lab.refund(staff, d.ticket, 1500);
    await lab.deliver(rest);
    await lab.deliver(first);
    const td = await lab.tickets(d.buyer, event);
    row("R3", "the older partial refund event after the full one: still refunded",
      show(td), td.length === 1 && td[0].status === "refunded" && Number(td[0].refunded_cents) === 2500);
  });

  await part("a refund before the confirmation", async () => {
    const staff = await lab.organiser();
    const event = await lab.event();
    const buyer = await lab.account("buyer");
    const sid = await lab.checkout(buyer, event);
    await stripe.pay(sid);
    // the completed event has not arrived yet (lost in an outage, or still being retried) when the organiser
    // refunds the payment in the Stripe Dashboard
    const completed = await stripeEvent("checkout.session.completed", await stripe.session(sid));
    const paymentIntent = (await stripe.session(sid)).payment_intent;
    await stripe.dashboardRefund(paymentIntent, 2500);
    const w = await lab.deliver(await stripeEvent("charge.refunded", await stripe.charge(paymentIntent)));
    const t1 = await lab.tickets(buyer, event);
    row("R4", "refund in the Dashboard before the ticket is confirmed: refunded",
      `${answer(w)}; ${show(t1)}`, t1.length === 1 && t1[0].status === "refunded" && Number(t1[0].refunded_cents) === 2500);
    await lab.deliver(completed);
    const page = await lab.successPage(buyer, sid);
    const t2 = await lab.tickets(buyer, event);
    row("R4", "then the late completed event and the success page: still refunded",
      `page: ${page.data?.status ?? page.status}; ${show(t2)}`,
      t2.length === 1 && t2[0].status === "refunded" && Number(t2[0].refunded_cents) === 2500);
    const f = await lab.figures(staff, event);
    row("R4", "organiser's figures: 1 sold, gross 25.00, refunds 25.00, net 0.00",
      figuresText(f), figuresAre(f, 1, 2500, 2500));

    // another buyer: a partial refund of 10.00 in the Dashboard, also before the confirmation
    const other = await lab.account("buyer");
    const sid2 = await lab.checkout(other, event);
    await stripe.pay(sid2);
    const completed2 = await stripeEvent("checkout.session.completed", await stripe.session(sid2));
    const paymentIntent2 = (await stripe.session(sid2)).payment_intent;
    await stripe.dashboardRefund(paymentIntent2, 1000);
    const w2 = await lab.deliver(await stripeEvent("charge.refunded", await stripe.charge(paymentIntent2)));
    const t3 = await lab.tickets(other, event);
    const partly = (t) => t?.status === "partially_refunded" && Number(t.refunded_cents) === 1000 &&
      Number(t.amount_cents) === 2500 && !!t.code;
    row("R4", "partial refund 10.00 in the Dashboard first: partly refunded, code",
      `${answer(w2)}; ${show(t3)}`, t3.length === 1 && partly(t3[0]));
    await lab.deliver(completed2);
    const t4 = await lab.tickets(other, event);
    const gate = t4[0]?.code ? await lab.checkIn(staff, t4[0].code) : null;
    row("R4", "then the late completed event; the door: partly refunded, admitted",
      `${show(t4)}; ${gate ? door(gate) : "no code to show"}`, t4.length === 1 && partly(t4[0]) && gate?.admitted === true);
  });

  for (const [mode, label] of [["refused", "database refuses"], ["hanging", "database hangs"]]) {
    await part(`an outage (${mode})`, async () => {
      const staff = await lab.organiser();
      const event = await lab.event();
      // a buyer has paid, and the completed event is about to arrive
      const buyer = await lab.account("buyer");
      const sid = await lab.checkout(buyer, event);
      await stripe.pay(sid);
      const completed = await stripeEvent("checkout.session.completed", await stripe.session(sid));
      // another buyer's ticket is refunded from the app, and the refund event is about to arrive
      const other = await lab.paidTicket("buyer", event);
      const refunded = await lab.refund(staff, other.ticket, 2500);

      // both arrive during the outage; the sender waits 10 s for an answer
      await lab.outage(mode);
      const [w1, w2] = await Promise.all([
        lab.deliver(completed, { timeoutMs: 10_000 }),
        lab.deliver(refunded, { timeoutMs: 10_000 }),
      ]);
      await lab.outage("off");
      await lab.settled();
      await sleep(500);

      const t1 = await lab.tickets(buyer, event);
      row("R5", `${label}: completed event answered 2xx only if saved`,
        `${answer(w1)}; ${show(t1)}`, is2xx(w1) ? isPaid(t1[0]) : true);
      // Stripe delivers again only when the answer was not 2xx
      const r1 = is2xx(w1) ? null : await lab.deliver(completed);
      const t2 = await lab.tickets(buyer, event);
      row("R5", "... after Stripe's retry, if any: one paid ticket",
        `${r1 ? `retry answered ${r1.status}` : "no retry"}; ${show(t2)}`, t2.length === 1 && isPaid(t2[0]));

      const u1 = await lab.tickets(other.buyer, event);
      row("R5", `${label}: refund event answered 2xx only if saved`,
        `${answer(w2)}; ${show(u1)}`, is2xx(w2) ? u1[0]?.status === "refunded" : true);
      const r2 = is2xx(w2) ? null : await lab.deliver(refunded);
      const u2 = await lab.tickets(other.buyer, event);
      row("R5", "... after Stripe's retry, if any: ticket refunded, 25.00",
        `${r2 ? `retry answered ${r2.status}` : "no retry"}; ${show(u2)}`,
        u2.length === 1 && u2[0].status === "refunded" && Number(u2[0].refunded_cents) === 2500);
    });
  }

  await part("the door", async () => {
    const staff = await lab.organiser();
    const event = await lab.event();
    const self = await lab.account("buyer");
    const selfCode = `SELF${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
    const ins = await lab.db("tickets", {
      method: "POST", token: self.token,
      data: { event_id: event.id, user_id: self.id, status: "paid", amount_cents: 0, code: selfCode },
    });
    const ts = await lab.tickets(self, event);
    row("R6", "a buyer writes a paid ticket for themselves via the API: refused",
      `answer ${ins.status}; ${show(ts)}`, ins.status >= 400 && ts.length === 0);
    const own = await lab.checkIn(staff, selfCode);
    row("R6", "door: the code of the ticket the buyer wrote: not admitted", door(own), own?.admitted === false);

    const p = await lab.paidTicket("buyer", event);
    const first = await lab.checkIn(staff, p.ticket.code);
    row("R7", "door: a paid ticket: admitted", door(first), first?.admitted === true);
    const second = await lab.checkIn(staff, p.ticket.code);
    row("R7", "door: the same ticket again: not admitted", door(second), second?.admitted === false);

    const q = await lab.paidTicket("buyer", event);
    await lab.deliver(await lab.refund(staff, q.ticket, 1000));
    const partly = await lab.checkIn(staff, q.ticket.code);
    row("R7", "door: a partly refunded ticket: admitted", door(partly), partly?.admitted === true);

    const r = await lab.paidTicket("buyer", event);
    await lab.deliver(await lab.refund(staff, r.ticket, 2500));
    const refunded = await lab.checkIn(staff, r.ticket.code);
    row("R7", "door: a refunded ticket: not admitted", door(refunded), refunded?.admitted === false);
  });

  return rows;
}
