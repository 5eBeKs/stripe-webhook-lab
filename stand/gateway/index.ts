// The stand's gateway: the edge-runtime main service, in place of Supabase's API gateway and function router.
// For each version of the app named in VERSIONS:
//   /<version>/functions/v1/<name>  runs that function from /bundles/<version>/<name>.eszip, checking the
//                                   caller's JWT first unless app/<version>/supabase/config.toml sets
//                                   verify_jwt = false for it (the default is true, as in Supabase)
//   /<version>/rest/v1/*            passes through to http://rest-<version>:3000, the database API
//   /<version>/auth/v1/*            passes through to http://auth-<version>:9999
// The functions get SUPABASE_URL = http://gateway:9000/<version>, so all they ask of Supabase goes through
// here; the variables named in FUNCTION_ENV are passed to them as they are.
//
// For the check only:
//   GET  /_stand/health             the versions and their functions
//   GET  /_stand/busy               how many function calls and database API calls are still running
//   POST /_stand/outage             {version, mode}: the database API of that version
//                                     "refused"  answers 503 at once, as when the database refuses connections
//                                     "hanging"  does not answer until the outage ends, as when the database
//                                                stops responding; then the request goes through
//                                     "off"      works again; requests held while hanging go on

const SECRET = Deno.env.get("JWT_SECRET")!;
const list = (name: string) => (Deno.env.get(name) ?? "").split(/[\s,]+/).filter(Boolean);
const VERSIONS = list("VERSIONS");
const PASS_ENV = list("FUNCTION_ENV");

const enc = new TextEncoder();
const hmac = await crypto.subtle.importKey(
  "raw", enc.encode(SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"],
);
const b64url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const unb64url = (s: string) =>
  Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));

// The project's API keys are JWTs signed with the project's secret, as Supabase's legacy keys are.
async function sign(payload: Record<string, unknown>) {
  const head = b64url(enc.encode(JSON.stringify({ alg: "HS256", typ: "JWT" })));
  const body = b64url(enc.encode(JSON.stringify(payload)));
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", hmac, enc.encode(`${head}.${body}`)));
  return `${head}.${body}.${b64url(sig)}`;
}
async function validJwt(token: string) {
  const parts = token.split(".");
  if (parts.length !== 3) return false;
  try {
    if (JSON.parse(new TextDecoder().decode(unb64url(parts[0]))).alg !== "HS256") return false;
    const ok = await crypto.subtle.verify("HMAC", hmac, unb64url(parts[2]), enc.encode(`${parts[0]}.${parts[1]}`));
    const claims = JSON.parse(new TextDecoder().decode(unb64url(parts[1])));
    return ok && (!claims.exp || claims.exp > Date.now() / 1000);
  } catch {
    return false;
  }
}
const iat = Math.floor(Date.now() / 1000);
const ANON_KEY = await sign({ iss: "supabase", role: "anon", iat, exp: iat + 365 * 86400 });
const SERVICE_ROLE_KEY = await sign({ iss: "supabase", role: "service_role", iat, exp: iat + 365 * 86400 });

// verify_jwt = false sections of a supabase/config.toml
function jwtNotChecked(toml: string) {
  const off = new Set<string>();
  let fn: string | null = null;
  for (const line of toml.split("\n")) {
    const section = line.match(/^\s*\[\s*functions\.("?)([^"\]]+)\1\s*\]/);
    if (section) fn = section[2];
    else if (/^\s*\[/.test(line)) fn = null;
    else if (fn && /^\s*verify_jwt\s*=\s*false\b/.test(line)) off.add(fn);
  }
  return off;
}

type Version = { functions: string[]; noJwt: Set<string>; mode: string; held: (() => void)[] };
const versions: Record<string, Version> = {};
for (const v of VERSIONS) {
  const functions: string[] = [];
  for await (const f of Deno.readDir(`/bundles/${v}`)) {
    if (f.name.endsWith(".eszip")) functions.push(f.name.slice(0, -".eszip".length));
  }
  const toml = await Deno.readTextFile(`/app/${v}/supabase/config.toml`).catch(() => "");
  versions[v] = { functions: functions.sort(), noJwt: jwtNotChecked(toml), mode: "off", held: [] };
}
let busy = 0;

async function pass(req: Request, upstream: string, path: string, search: string) {
  const body = req.method === "GET" || req.method === "HEAD" ? undefined : await req.arrayBuffer();
  const headers = new Headers(req.headers);
  headers.delete("host");
  const res = await fetch(`${upstream}/${path}${search}`, { method: req.method, headers, body, redirect: "manual" });
  return new Response(res.body, { status: res.status, headers: res.headers });
}

async function runFunction(req: Request, v: string, name: string) {
  const servicePath = `/app/${v}/supabase/functions/${name}`;
  const envVars: [string, string][] = [
    ["SUPABASE_URL", `http://gateway:9000/${v}`],
    ["SUPABASE_ANON_KEY", ANON_KEY],
    ["SUPABASE_SERVICE_ROLE_KEY", SERVICE_ROLE_KEY],
    ...PASS_ENV.filter((k) => Deno.env.get(k) !== undefined).map((k): [string, string] => [k, Deno.env.get(k)!]),
  ];
  const worker = await EdgeRuntime.userWorkers.create({
    servicePath,
    memoryLimitMb: 256,
    workerTimeoutMs: 10 * 60_000,
    noModuleCache: false,
    envVars,
    forceCreate: false,
    cpuTimeSoftLimitMs: 2000,
    cpuTimeHardLimitMs: 4000,
    maybeEszip: await Deno.readFile(`/bundles/${v}/${name}.eszip`),
    maybeEntrypoint: `file://${servicePath}/index.ts`,
  });
  return await worker.fetch(req);
}

Deno.serve({ port: 9000 }, async (req) => {
  const url = new URL(req.url);
  const [, v, area, apiVersion, ...rest] = url.pathname.split("/");

  if (v === "_stand") {
    if (area === "health") {
      return Response.json(Object.fromEntries(Object.entries(versions).map(([k, x]) => [k, x.functions])));
    }
    if (area === "busy") return Response.json({ busy });
    if (area === "outage" && req.method === "POST") {
      const { version, mode } = await req.json();
      const x = versions[version];
      if (!x || !["refused", "hanging", "off"].includes(mode)) return Response.json({ error: "version, mode" }, { status: 400 });
      x.mode = mode;
      if (mode === "off") x.held.splice(0).forEach((go) => go());
      return Response.json({ version, mode });
    }
    return new Response("not found", { status: 404 });
  }

  const x = versions[v];
  if (!x || apiVersion !== "v1") return new Response("not found", { status: 404 });

  if (area === "rest") {
    if (x.mode === "refused") return Response.json({ message: "stand: the database is unavailable" }, { status: 503 });
    busy += 1;
    try {
      if (x.mode === "hanging") await new Promise<void>((go) => x.held.push(go));
      return await pass(req, `http://rest-${v}:3000`, rest.join("/"), url.search);
    } finally {
      busy -= 1;
    }
  }
  if (area === "auth") return pass(req, `http://auth-${v}:9999`, rest.join("/"), url.search);

  const name = rest[0];
  if (area !== "functions" || !x.functions.includes(name)) return new Response("not found", { status: 404 });
  if (req.method !== "OPTIONS" && !x.noJwt.has(name)) {
    const token = (req.headers.get("authorization") ?? "").replace(/^Bearer /, "");
    if (!(await validJwt(token))) return Response.json({ code: 401, message: "Invalid JWT" }, { status: 401 });
  }
  busy += 1;
  try {
    return await runFunction(req, v, name);
  } catch (err) {
    console.error(`${v}/${name}:`, err);
    return Response.json({ code: 500, message: "stand: the function failed to run" }, { status: 500 });
  } finally {
    busy -= 1;
  }
});
