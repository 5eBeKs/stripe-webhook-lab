// The stand's Stripe: it answers as api.stripe.com on port 443 inside the stand's network, with a
// certificate from the stand's own test CA, so the functions' Stripe SDK talks to it unchanged.
//
// It answers only the calls the ticket app makes:
//   POST /v1/checkout/sessions          create (prices from PRICES, or price_data)
//   GET  /v1/checkout/sessions/:id      retrieve
//   GET  /v1/checkout/sessions          list, by payment_intent
//   POST /v1/refunds                    create, in full or in part
//   GET  /v1/payment_intents/:id        retrieve
// Any other call is answered 404, and a Checkout in another mode than payment or with a price not in PRICES is
// answered 400; both are listed at /_control/unanswered, so that a call the stand does not know shows in the
// check's output instead of passing unnoticed.
//
// Port 8080 is Stripe's own side, for the check: the buyer pays (or the bank debit clears), a checkout expires,
// the organiser refunds in the Stripe Dashboard; and the objects that Stripe's events carry.

import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import https from "node:https";

const SECRET_KEY = process.env.STRIPE_SECRET_KEY;
const PRICES = JSON.parse(process.env.PRICES || "{}"); // {"price_x": {"unit_amount": 2500, "currency": "eur"}}

const sessions = new Map();
const intents = new Map(); // payment intent id -> {intent, charge}
const unanswered = [];
let apiVersion = null; // the Stripe-Version the SDK sends; the check puts it on its events

const id = (prefix) => `${prefix}_${crypto.randomBytes(12).toString("hex")}`;
const now = () => Math.floor(Date.now() / 1000);

// Stripe's form encoding: line_items[0][price]=x&metadata[k]=v
function parseForm(text) {
  const out = {};
  for (const [key, value] of new URLSearchParams(text)) {
    const parts = key.replace(/\]/g, "").split("[");
    let node = out;
    parts.forEach((part, i) => {
      if (i === parts.length - 1) node[part] = value;
      else node = node[part] ??= /^\d+$/.test(parts[i + 1]) ? [] : {};
    });
  }
  return out;
}

const send = (res, status, body) => {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
};
const fail = (res, status, message, param) =>
  send(res, status, { error: { type: "invalid_request_error", message, ...(param ? { param } : {}) } });

function createSession(p, res) {
  if (p.mode !== "payment") {
    unanswered.push(`POST /v1/checkout/sessions mode=${p.mode}`);
    return fail(res, 400, `stand: mode ${p.mode} is not covered`, "mode");
  }
  let amount = 0;
  let currency = null;
  for (const item of p.line_items ?? []) {
    const price = item.price ? PRICES[item.price] : item.price_data;
    if (!price) {
      unanswered.push(`POST /v1/checkout/sessions price=${item.price}`);
      return fail(res, 400, `No such price: '${item.price}'`, "line_items");
    }
    amount += Number(price.unit_amount) * Number(item.quantity ?? 1);
    currency = price.currency;
  }
  if (!currency) return fail(res, 400, "Missing required param: line_items.", "line_items");
  const s = {
    id: id("cs_test"),
    object: "checkout.session",
    mode: p.mode,
    status: "open",
    payment_status: "unpaid",
    url: null,
    amount_subtotal: amount,
    amount_total: amount,
    currency,
    customer: p.customer ?? null,
    customer_email: p.customer_email ?? null,
    customer_details: null,
    client_reference_id: p.client_reference_id ?? null,
    metadata: p.metadata ?? {},
    payment_intent: null,
    // Stripe keeps these as given, {CHECKOUT_SESSION_ID} included, and fills the id in on the redirect
    success_url: p.success_url ?? null,
    cancel_url: p.cancel_url ?? null,
    created: now(),
    expires_at: now() + 24 * 3600,
    livemode: false,
  };
  s.url = `https://checkout.stripe.com/c/pay/${s.id}`;
  sessions.set(s.id, s);
  return send(res, 200, s);
}

function refund(p, res) {
  const entry = intents.get(p.payment_intent);
  if (!entry) return fail(res, 404, `No such payment_intent: '${p.payment_intent}'`, "payment_intent");
  const { charge } = entry;
  const left = charge.amount - charge.amount_refunded;
  const amount = p.amount === undefined ? left : Number(p.amount);
  if (!(amount > 0) || amount > left) {
    return fail(res, 400, `Refund amount (${amount}) is greater than unrefunded amount on charge (${left})`, "amount");
  }
  charge.amount_refunded += amount;
  charge.refunded = charge.amount_refunded === charge.amount;
  const r = {
    id: id("re"), object: "refund", amount, currency: charge.currency, charge: charge.id,
    payment_intent: charge.payment_intent, status: "succeeded", created: now(),
  };
  return send(res, 200, r);
}

function stripeApi(req, res, url, body) {
  if (req.headers.authorization !== `Bearer ${SECRET_KEY}`) {
    return send(res, 401, { error: { type: "invalid_request_error", message: "Invalid API Key provided" } });
  }
  apiVersion = req.headers["stripe-version"] ?? apiVersion;
  const path = url.pathname;
  if (req.method === "POST" && path === "/v1/checkout/sessions") return createSession(parseForm(body), res);
  if (req.method === "GET" && path === "/v1/checkout/sessions") {
    const pi = url.searchParams.get("payment_intent");
    const data = [...sessions.values()].filter((s) => !pi || s.payment_intent === pi)
      .slice(0, Number(url.searchParams.get("limit") ?? 10));
    return send(res, 200, { object: "list", data, has_more: false, url: "/v1/checkout/sessions" });
  }
  let m = path.match(/^\/v1\/checkout\/sessions\/([^/]+)$/);
  if (req.method === "GET" && m) {
    const s = sessions.get(m[1]);
    return s ? send(res, 200, s) : fail(res, 404, `No such checkout.session: '${m[1]}'`, "id");
  }
  if (req.method === "POST" && path === "/v1/refunds") return refund(parseForm(body), res);
  m = path.match(/^\/v1\/payment_intents\/([^/]+)$/);
  if (req.method === "GET" && m) {
    const entry = intents.get(m[1]);
    return entry ? send(res, 200, entry.intent) : fail(res, 404, `No such payment_intent: '${m[1]}'`, "id");
  }
  unanswered.push(`${req.method} ${path}`);
  return fail(res, 404, `stand: ${req.method} ${path} is not covered`);
}

const read = (req) => new Promise((ok) => {
  let b = "";
  req.on("data", (c) => (b += c));
  req.on("end", () => ok(b));
});

https.createServer(
  { key: fs.readFileSync("/tls/stripe.key"), cert: fs.readFileSync("/tls/stripe.pem") },
  async (req, res) => {
    const body = await read(req);
    const host = (req.headers.host ?? "").split(":")[0];
    const url = new URL(req.url, `https://${host}`);
    if (host !== "api.stripe.com") {
      unanswered.push(`${req.method} ${host}${url.pathname}`);
      return send(res, 404, { error: { message: `stand: unknown host ${host}` } });
    }
    return stripeApi(req, res, url, body);
  },
).listen(443, () => console.log("api.stripe.com on 443"));

// Stripe's own side, for the check
http.createServer(async (req, res) => {
  const body = await read(req);
  const p = body ? JSON.parse(body) : {};
  const path = new URL(req.url, "http://stripe").pathname;
  if (req.method === "GET" && path === "/_control/unanswered") return send(res, 200, unanswered);
  if (req.method === "GET" && path === "/_control/api-version") return send(res, 200, { apiVersion });

  let m = path.match(/^\/_control\/sessions\/([^/]+)(?:\/(pay|clear|expire))?$/);
  const s = m && sessions.get(m[1]);
  if (m && !s) return send(res, 404, { error: "no such checkout" });
  if (req.method === "GET" && m && !m[2]) return send(res, 200, s);
  // the buyer pays on Stripe's page; with a delayed method (a bank debit) the checkout completes unpaid
  if (req.method === "POST" && m?.[2] === "pay") {
    const pi = id("pi");
    const charge = {
      id: id("ch"), object: "charge", amount: s.amount_total, amount_refunded: 0, refunded: false,
      currency: s.currency, payment_intent: pi, status: p.payment_status === "unpaid" ? "pending" : "succeeded",
      created: now(), livemode: false,
    };
    const intent = {
      id: pi, object: "payment_intent", amount: s.amount_total, currency: s.currency,
      status: p.payment_status === "unpaid" ? "processing" : "succeeded", latest_charge: charge.id,
      metadata: {}, created: now(), livemode: false,
    };
    intents.set(pi, { intent, charge });
    Object.assign(s, {
      status: "complete",
      payment_status: p.payment_status ?? "paid",
      payment_intent: pi,
      customer_details: { email: s.customer_email, name: null },
    });
    return send(res, 200, s);
  }
  // the delayed payment clears
  if (req.method === "POST" && m?.[2] === "clear") {
    s.payment_status = "paid";
    const entry = intents.get(s.payment_intent);
    entry.intent.status = "succeeded";
    entry.charge.status = "succeeded";
    return send(res, 200, s);
  }
  if (req.method === "POST" && m?.[2] === "expire") {
    Object.assign(s, { status: "expired", url: null });
    return send(res, 200, s);
  }
  // the organiser refunds in the Stripe Dashboard: the same refund as through the API
  if (req.method === "POST" && path === "/_control/refunds") return refund(p, res);
  m = path.match(/^\/_control\/charges\/([^/]+)$/);
  if (req.method === "GET" && m) {
    const entry = intents.get(m[1]);
    return entry ? send(res, 200, entry.charge) : send(res, 404, { error: "no such payment intent" });
  }
  return send(res, 404, { error: "no such control path" });
}).listen(8080, () => console.log("Stripe's side on 8080"));
