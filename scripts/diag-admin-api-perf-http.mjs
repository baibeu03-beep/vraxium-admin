// 진단(HTTP): 어드민 GET 엔드포인트 실제 응답 시간 + 응답 데이터 크기/row 수.
//   사전조건: admin dev :3000. Usage: node scripts/diag-admin-api-perf-http.mjs
// 매직링크로 admin 세션 쿠키를 만들고 fetch 로 각 엔드포인트를 cold 1회 + warm N회 측정한다.
// 응답 row 수를 direct 측정과 대조할 수 있게 출력한다.
import { createRequire } from "node:module";
import { readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const adminRoot = resolve(__dirname, "..");
const rq = createRequire(resolve(adminRoot, "package.json"));
const { createClient } = rq("@supabase/supabase-js");
const { createServerClient } = rq("@supabase/ssr");
const env = readFileSync(resolve(adminRoot, ".env.local"), "utf8");
const get = (k) => env.match(new RegExp(`^${k}=(.+)$`, "m"))?.[1]?.trim();
const BASE = process.env.BASE || "http://localhost:3000";
const URL_ = get("NEXT_PUBLIC_SUPABASE_URL");
const ANON = get("NEXT_PUBLIC_SUPABASE_ANON_KEY");
const SERVICE = get("SUPABASE_SERVICE_ROLE_KEY");
const EMAIL = process.env.ADMIN_EMAIL || "vanuatu.golden@gmail.com";

const OUT = "C:/Users/vanua/AppData/Local/Temp/claude/admin-perf-http.txt";
const log = (m) => { appendFileSync(OUT, m + "\n"); process.stderr.write(m + "\n"); };

const sb = createClient(URL_, SERVICE);
const brow = createClient(URL_, ANON);

async function loginCookies() {
  const { data: link } = await sb.auth.admin.generateLink({ type: "magiclink", email: EMAIL });
  const { data: v } = await brow.auth.verifyOtp({ email: EMAIL, token: link.properties.email_otp, type: "magiclink" });
  const cap = [];
  const srv = createServerClient(URL_, ANON, { cookies: { getAll: () => [], setAll: (i) => cap.push(...i) } });
  await srv.auth.setSession({ access_token: v.session.access_token, refresh_token: v.session.refresh_token });
  return cap.map((i) => `${i.name}=${i.value}`).join("; ");
}

function rowsOf(json) {
  if (!json) return "?";
  if (Array.isArray(json.data)) return json.data.length;
  if (json.data && typeof json.data === "object") return "obj:" + JSON.stringify(json.data).length + "B";
  if (Array.isArray(json)) return json.length;
  return "obj:" + JSON.stringify(json).length + "B";
}

const ENDPOINTS = [
  ["me (baseline)", "/api/admin/me"],
  ["current-week (baseline)", "/api/admin/cluster4/current-week"],
  ["members/roster", "/api/admin/members/roster?mode=operating"],
  ["members/info-stats", "/api/admin/members/info-stats?mode=operating"],
  ["crews (encre)", "/api/admin/crews?organization=encre&mode=operating"],
  ["cluster4/crews", "/api/admin/cluster4/crews?mode=operating"],
  ["season-weeks", "/api/admin/season-weeks"],
  ["week-recognitions", "/api/admin/week-recognitions"],
  ["season-participations", "/api/admin/season-participations"],
  ["app-users", "/api/admin/app-users?mode=operating"],
];

async function hit(cookie, path) {
  const s = Date.now();
  const res = await fetch(BASE + path, { headers: { cookie } });
  const buf = await res.arrayBuffer();
  const ms = Date.now() - s;
  let json = null;
  try { json = JSON.parse(Buffer.from(buf).toString("utf8")); } catch {}
  return { ms, status: res.status, bytes: buf.byteLength, rows: rowsOf(json) };
}

async function main() {
  writeFileSync(OUT, `admin API perf (HTTP) ${new Date().toISOString()}  BASE=${BASE}\n\n`);
  const cookie = await loginCookies();
  log("logged in, cookies acquired\n");
  log("name".padEnd(26) + "  status  cold(ms)  warm1  warm2  warm3   bytes     rows");
  const summary = [];
  for (const [name, path] of ENDPOINTS) {
    const cold = await hit(cookie, path);
    const w = [];
    for (let i = 0; i < 3; i++) w.push(await hit(cookie, path));
    const warmMed = [...w.map((x) => x.ms)].sort((a, b) => a - b)[1];
    summary.push({ name, warmMed, cold: cold.ms, status: cold.status });
    log(
      name.padEnd(26) +
      `  ${String(cold.status).padStart(3)}   ${String(cold.ms).padStart(7)}  ${String(w[0].ms).padStart(5)}  ${String(w[1].ms).padStart(5)}  ${String(w[2].ms).padStart(5)}  ${String(cold.bytes).padStart(8)}  ${cold.rows}`
    );
  }
  log("\n=== warm median, slowest first ===");
  for (const r of summary.sort((a, b) => b.warmMed - a.warmMed)) {
    log(`${String(r.warmMed).padStart(6)}ms (warm)  cold=${String(r.cold).padStart(6)}ms  [${r.status}]  ${r.name}`);
  }
  log("DONE");
}

main().then(() => process.exit(0), (e) => { log("FATAL: " + (e?.stack || e)); process.exit(1); });
