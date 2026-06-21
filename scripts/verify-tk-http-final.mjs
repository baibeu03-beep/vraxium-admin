// 최종 HTTP 검증 (read-only): 23개 라인 crew GET + T권소율 고객 카드 — 실제 엔드포인트 응답 기준.
// 실행: node scripts/verify-tk-http-final.mjs   (사전: dev 서버 localhost:3000)
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");
const req = createRequire(resolve(root, "package.json"));
const { createClient } = req("@supabase/supabase-js");
const { createServerClient } = req("@supabase/ssr");
const env = readFileSync(resolve(root, ".env.local"), "utf8");
const get = (k) => env.match(new RegExp(`^${k}=(.+)$`, "m"))?.[1]?.trim();
const SUPABASE_URL = get("NEXT_PUBLIC_SUPABASE_URL");
const ANON = get("NEXT_PUBLIC_SUPABASE_ANON_KEY");
const SERVICE = get("SUPABASE_SERVICE_ROLE_KEY");
const BASE = process.env.SMOKE_BASE_URL ?? "http://localhost:3000";
const ADMIN_EMAIL = process.env.SMOKE_ADMIN_EMAIL ?? "vanuatu.golden@gmail.com";
const ORG = "oranke";
const TARGET = "28a39131-a719-4264-b2a4-96dbda64cbb6";

let pass = 0, fail = 0;
const check = (l, ok, d = "") => { console.log(`  ${ok ? "✓" : "✗"} ${l}${d ? ` — ${d}` : ""}`); ok ? pass++ : fail++; };

async function cookieHeader() {
  const admin = createClient(SUPABASE_URL, SERVICE);
  const browser = createClient(SUPABASE_URL, ANON);
  const { data: link } = await admin.auth.admin.generateLink({ type: "magiclink", email: ADMIN_EMAIL });
  const { data: v } = await browser.auth.verifyOtp({ email: ADMIN_EMAIL, token: link.properties.email_otp, type: "magiclink" });
  const cap = [];
  const s = createServerClient(SUPABASE_URL, ANON, { cookies: { getAll: () => [], setAll: (i) => cap.push(...i) } });
  await s.auth.setSession({ access_token: v.session.access_token, refresh_token: v.session.refresh_token });
  return cap.map((i) => `${i.name}=${i.value}`).join("; ");
}
const COOKIE = await cookieHeader();
async function getCrew(lineId, weekId) {
  const sp = new URLSearchParams({ line_id: lineId, week_id: weekId, organization: ORG });
  const r = await fetch(`${BASE}/api/admin/cluster4/info-lines/crew?${sp}`, { headers: { cookie: COOKIE, connection: "close" } });
  return { status: r.status, json: await r.json() };
}
async function getCards(userId) {
  const r = await fetch(`${BASE}/api/cluster4/weekly-cards?userId=${userId}`, { headers: { cookie: COOKIE, connection: "close" } });
  return { status: r.status, json: await r.json() };
}

const diag = JSON.parse(readFileSync(resolve(root, "claudedocs/diag-tkwonsoyul-info-lines.json"), "utf8"));
const lines = diag.classified;
const codeSet = new Set(lines.map((l) => l.lineCode));

console.log(`\n=== 최종 HTTP 검증: ${lines.length}개 라인 crew GET ===`);
let tkPresent = 0, zero = 0, withCrew = 0, crewTotal = 0, ok200 = 0;
for (const l of lines) {
  const g = await getCrew(l.lineId, l.weekId);
  if (g.status === 200 && g.json?.success) ok200++;
  const targets = g.json?.data?.targets ?? [];
  const count = g.json?.data?.count ?? -1;
  if (targets.some((t) => t.userId === TARGET)) tkPresent++;
  if (count === 0) zero++; else { withCrew++; crewTotal += count; }
}
check("23건 crew GET 모두 HTTP 200 success", ok200 === lines.length, `${ok200}/${lines.length}`);
check("T권소율 잔존 0건 (전 라인 HTTP 응답 기준)", tkPresent === 0, `잔존=${tkPresent}`);
check("0명 라인 18 + 크루보유 라인 5 (실크루 유지)", zero === 18 && withCrew === 5, `zero=${zero} withCrew=${withCrew} crewTotal=${crewTotal}`);

console.log(`\n=== 고객 화면(weekly-cards HTTP) T권소율 실무정보 강화 성공 ===`);
const cards = await getCards(TARGET);
let infoSucc = 0; const succCodes = [];
for (const c of cards.json?.data ?? []) for (const ln of c.lines ?? []) {
  if (ln.partType === "information" && codeSet.has(ln.lineCode) && ln.enhancementStatus === "success") { infoSucc++; succCodes.push(ln.lineCode); }
}
check("고객 카드 HTTP 응답: 23개 라인 강화 성공 = 0", infoSucc === 0, succCodes.join(",") || "none");

console.log(`\n=== 결과: ${pass} pass / ${fail} fail ===`);
process.exit(fail === 0 ? 0 : 1);
