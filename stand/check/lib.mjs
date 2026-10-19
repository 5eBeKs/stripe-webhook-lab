// What the check does on the stand: makes accounts and an event, calls the app's functions as the browser
// and Stripe call them, plays Stripe's side (payments, refunds, signed events) and reads what came out.
import crypto from "node:crypto";

const { JWT_SECRET, STRIPE_WEBHOOK_SECRET } = process.env;
const GATEWAY = "http://gateway:9000";
const STRIPE = "http://stripe:8080";
// keeps this run's accounts apart from an earlier run's if the stand was not taken down in between
const RUN = crypto.randomBytes(3).toString("hex");

function jwt(payload) {
  const part = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const head = `${part({ alg: "HS256", typ: "JWT" })}.${part(payload)}`;
  return `${head}.${crypto.createHmac("sha256", JWT_SECRET).update(head).digest("base64url")}`;
}
const iat = Math.floor(Date.now() / 1000);
const ANON_KEY = jwt({ iss: "supabase", role: "anon", iat, exp: iat + 3600 });
const SERVICE_KEY = jwt({ iss: "supabase", role: "service_role", iat, exp: iat + 3600 });

const parse = async (res) => {
  const text = await res.text();
  try { return JSON.parse(text); } catch { return text; }
};
export const sleep = (ms) => new Promise((go) => setTimeout(go, ms));

async function stripeSide(path, body) {
  const res = await fetch(`${STRIPE}${path}`, body === undefined ? {} : { method: "POST", body: JSON.stringify(body) });
  const data = await parse(res);
  if (!res.ok) throw new Error(`Stripe's side ${path}: ${res.status} ${JSON.stringify(data)}`);
  return data;
}

// Stripe's side of a purchase
export const stripe = {
  session: (id) => stripeSide(`/_control/sessions/${id}`),
  pay: (id, paymentStatus = "paid") => stripeSide(`/_control/sessions/${id}/pay`, { payment_status: paymentStatus }),
  clear: (id) => stripeSide(`/_control/sessions/${id}/clear`, {}),
  expire: (id) => stripeSide(`/_control/sessions/${id}/expire`, {}),
  dashboardRefund: (paymentIntent, amount) => stripeSide("/_control/refunds", { payment_intent: paymentIntent, amount }),
  charge: (paymentIntent) => stripeSide(`/_control/charges/${paymentIntent}`),
  unanswered: () => stripeSide("/_control/unanswered"),
  apiVersion: async () => (await stripeSide("/_control/api-version")).apiVersion,
};

// A Stripe event as Stripe sends it. The same object delivered twice is the same event (same id).
export async function stripeEvent(type, object) {
  return {
    id: `evt_${crypto.randomBytes(12).toString("hex")}`, object: "event", api_version: await stripe.apiVersion(),
    created: Math.floor(Date.now() / 1000), livemode: false, pending_webhooks: 1,
    request: { id: null, idempotency_key: null }, type, data: { object },
  };
}

export function app(version) {
  const rest = `http://rest-${version}:3000`;
  const auth = `http://auth-${version}:9999`;
  const functions = `${GATEWAY}/${version}/functions/v1`;
  let n = 0;

  const lab = {
    // the database API directly (not through the gateway, so an outage there does not touch the check's reads)
    async db(path, { method = "GET", data, token = SERVICE_KEY } = {}) {
      const res = await fetch(`${rest}/${path}`, {
        method,
        headers: {
          apikey: ANON_KEY, authorization: `Bearer ${token}`, "content-type": "application/json",
          prefer: "return=representation",
        },
        body: data === undefined ? undefined : JSON.stringify(data),
      });
      return { status: res.status, data: await parse(res) };
    },
    async must(path, options) {
      const r = await lab.db(path, options);
      if (r.status >= 300) throw new Error(`${options?.method ?? "GET"} ${path}: ${r.status} ${JSON.stringify(r.data)}`);
      return r.data;
    },

    // a made-up account, signed in
    async account(label) {
      n += 1;
      const email = `${label}-${n}-${RUN}@ticket-lab.test`;
      const password = crypto.randomBytes(12).toString("hex");
      const made = await fetch(`${auth}/admin/users`, {
        method: "POST",
        headers: { apikey: SERVICE_KEY, authorization: `Bearer ${SERVICE_KEY}`, "content-type": "application/json" },
        body: JSON.stringify({ email, password, email_confirm: true }),
      });
      const user = await parse(made);
      if (!made.ok) throw new Error(`make account: ${made.status} ${JSON.stringify(user)}`);
      const signin = await fetch(`${auth}/token?grant_type=password`, {
        method: "POST",
        headers: { apikey: ANON_KEY, "content-type": "application/json" },
        body: JSON.stringify({ email, password }),
      });
      const session = await parse(signin);
      if (!signin.ok) throw new Error(`sign in: ${signin.status} ${JSON.stringify(session)}`);
      return { id: user.id, email, token: session.access_token };
    },
    async organiser() {
      const staff = await lab.account("organiser");
      await lab.must("staff", { method: "POST", data: { user_id: staff.id } });
      return staff;
    },
    // an evening on sale for 25.00
    async event() {
      const [row] = await lab.must("events", {
        method: "POST",
        data: {
          title: "Lab night", starts_at: new Date(Date.now() + 30 * 86400_000).toISOString(),
          price_cents: 2500, currency: "eur", stripe_price_id: "price_lab_night",
        },
      });
      return row;
    },

    // a function, called the way the browser or Stripe calls it
    async call(name, { user, data, headers = {}, raw, timeoutMs = 60_000 } = {}) {
      try {
        const res = await fetch(`${functions}/${name}`, {
          method: "POST",
          headers: {
            apikey: ANON_KEY, authorization: `Bearer ${user ? user.token : ANON_KEY}`,
            "content-type": "application/json", ...headers,
          },
          body: raw ?? JSON.stringify(data ?? {}),
          signal: AbortSignal.timeout(timeoutMs),
        });
        return { status: res.status, data: await parse(res) };
      } catch (e) {
        if (e.name === "TimeoutError") return { status: `no answer in ${timeoutMs / 1000} s`, data: null };
        throw e;
      }
    },
    buy: (buyer, event) => lab.call("create-checkout", { user: buyer, data: { event_id: event.id } }),
    successPage: (buyer, sessionId) => lab.call("verify-checkout", { user: buyer, data: { session_id: sessionId } }),
    refundFromApp: (staff, ticket, amount) =>
      lab.call("refund-ticket", { user: staff, data: { ticket_id: ticket.id, amount_cents: amount } }),

    // Stripe delivers an event: signed with the endpoint's secret the way Stripe signs it,
    // Stripe-Signature: t=<time>,v1=<HMAC-SHA256 of "<time>.<payload>">
    deliver(event, { secret = STRIPE_WEBHOOK_SECRET, timeoutMs } = {}) {
      const payload = JSON.stringify(event);
      const t = Math.floor(Date.now() / 1000);
      const v1 = crypto.createHmac("sha256", secret).update(`${t}.${payload}`).digest("hex");
      return lab.call("stripe-webhook", { raw: payload, headers: { "stripe-signature": `t=${t},v1=${v1}` }, timeoutMs });
    },

    // the buyer presses Buy and lands on Stripe's page
    async checkout(buyer, event) {
      const r = await lab.buy(buyer, event);
      if (r.status !== 200 || !r.data?.url) throw new Error(`checkout did not start: ${r.status} ${JSON.stringify(r.data)}`);
      return r.data.url.split("/").pop();
    },
    // a buyer who paid, and whose ticket the webhook confirmed
    async paidTicket(label, event) {
      const buyer = await lab.account(label);
      const sid = await lab.checkout(buyer, event);
      await stripe.pay(sid);
      const completed = await stripeEvent("checkout.session.completed", await stripe.session(sid));
      await lab.deliver(completed);
      const [ticket] = await lab.tickets(buyer, event);
      return { buyer, sid, completed, ticket, paymentIntent: (await stripe.session(sid)).payment_intent };
    },
    // the organiser refunds from the app; Stripe then reports it to the webhook
    async refund(staff, ticket, amount) {
      const r = await lab.refundFromApp(staff, ticket, amount);
      if (r.status !== 200) throw new Error(`refund from the app: ${r.status} ${JSON.stringify(r.data)}`);
      return stripeEvent("charge.refunded", await stripe.charge(ticket.payment_intent_id));
    },

    tickets: (buyer, event) => lab.must(
      `tickets?user_id=eq.${buyer.id}&event_id=eq.${event.id}&order=created_at` +
        "&select=id,status,amount_cents,refunded_cents,code,payment_intent_id,checked_in_at",
    ),
    async figures(staff, event) {
      const r = await lab.db("rpc/event_revenue", { method: "POST", data: { p_event_id: event.id }, token: staff.token });
      return [].concat(r.data)[0];
    },
    async checkIn(staff, code) {
      return (await lab.db("rpc/check_in", { method: "POST", data: { p_code: code }, token: staff.token })).data;
    },

    // the database API of this version fails, at the gateway: "refused", "hanging" or "off"
    async outage(mode) {
      const res = await fetch(`${GATEWAY}/_stand/outage`, { method: "POST", body: JSON.stringify({ version, mode }) });
      if (!res.ok) throw new Error(`outage ${mode}: ${res.status}`);
    },
    // wait until no function call is running (calls held by an outage finish once it ends)
    async settled() {
      for (let i = 0; i < 300; i++) {
        if ((await (await fetch(`${GATEWAY}/_stand/busy`)).json()).busy === 0) return;
        await sleep(100);
      }
      throw new Error("function calls still running after 30 s");
    },
  };
  return lab;
}

// waits until the gateway knows both versions and each version's auth and database API answer
export async function ready(versions) {
  for (let i = 0; i < 120; i++) {
    try {
      const health = await (await fetch(`${GATEWAY}/_stand/health`)).json();
      let up = versions.every((v) => health[v]?.length);
      for (const v of versions) {
        up &&= (await fetch(`http://rest-${v}:3000/`)).ok && (await fetch(`http://auth-${v}:9999/health`)).ok;
      }
      if (up) return health;
    } catch {
      // not yet
    }
    await sleep(500);
  }
  throw new Error("the stand did not come up in 60 s");
}
