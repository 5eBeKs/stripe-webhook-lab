// docker compose run --rm check
// Checks that the stand has no way out, then runs the rows on each version and prints a table for each:
// the rule, what it expects, what came back, and whether they match. The last line sums up all versions.
import dns from "node:dns/promises";
import { ready, stripe } from "./lib.mjs";
import { checkVersion, RULES } from "./rows.mjs";

const VERSIONS = (process.env.VERSIONS ?? "").split(/[\s,]+/).filter(Boolean);

const outside = await dns.lookup("example.com").then(() => "resolves", () => "does not resolve");
const address = await fetch("http://1.1.1.1", { signal: AbortSignal.timeout(3000) })
  .then(() => "reachable", () => "unreachable");
const stripeHost = await dns.lookup("api.stripe.com").then((r) => r.address, () => null);
const standStripe = await dns.lookup("stripe").then((r) => r.address, () => null);
if (outside !== "does not resolve" || address !== "unreachable" || !stripeHost || stripeHost !== standStripe) {
  console.log(`the stand has a way out (example.com ${outside}, 1.1.1.1 ${address}) or api.stripe.com is not the stand's: stopping`);
  process.exit(2);
}

const health = await ready(VERSIONS);
console.log("Stripe webhook lab: a ticket app in two versions, on a stand with no way out");
console.log(`network: example.com does not resolve, 1.1.1.1 is unreachable, api.stripe.com is the stand's Stripe`);
console.log("");
// the rules, wrapped to 100 columns
for (const [rule, text] of Object.entries(RULES)) {
  const lines = [""];
  for (const word of text.split(" ")) {
    if (lines.at(-1).length + word.length + 1 > 96) lines.push("");
    lines[lines.length - 1] += (lines.at(-1) ? " " : "") + word;
  }
  lines.forEach((l, i) => console.log(`${i ? "    " : rule.padEnd(4)}${l}`));
}

const results = [];
for (const v of VERSIONS) {
  const rows = await checkVersion(v);
  results.push({ v, rows });
  const w = {
    n: String(rows.length).length,
    expected: Math.max(8, ...rows.map((r) => r.expected.length)),
    got: Math.max(3, ...rows.map((r) => r.got.length)),
  };
  const line = (n, rule, expected, got, verdict) =>
    `${String(n).padStart(w.n)}  ${rule.padEnd(4)}  ${expected.padEnd(w.expected)}  ${got.padEnd(w.got)}  ${verdict}`;
  console.log(`\n${v} (app/${v}: ${health[v].join(", ")})\n`);
  console.log(line("#", "rule", "expected", "got", "verdict"));
  rows.forEach((r, i) => console.log(line(i + 1, r.rule, r.expected, r.got, r.ok ? "match" : "DIFFERS")));
  const differ = rows.filter((r) => !r.ok).length;
  console.log(`\n${v}: ${differ ? `${differ} of ${rows.length} rows differ` : `all ${rows.length} rows match`}`);
}

const unanswered = await stripe.unanswered();
console.log(`\nStripe calls the stand did not answer: ${unanswered.length ? [...new Set(unanswered)].join(", ") : "none"}`);
console.log("");
console.log(results.map(({ v, rows }) => {
  const differ = rows.filter((r) => !r.ok).length;
  return `${v}: ${differ ? `${differ} of ${rows.length} rows differ` : `all ${rows.length} rows match`}`;
}).join(" / "));
process.exit(results.some(({ rows }) => rows.some((r) => r.rule === "-")) ? 1 : 0);
