// 검증 — 라인 개설 후보 풀에서 현재 시즌 휴식자 제외 (cafe-line-crew direct==HTTP + 실데이터).
//   사전조건: admin dev :3000. node scripts/verify-line-opening-rest-exclusion.mjs
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
const __dirname = dirname(fileURLToPath(import.meta.url));
const adminRoot = resolve(__dirname, "..");
const frontRoot = resolve(adminRoot, "..", "vraxium");
const { chromium } = createRequire(resolve(frontRoot, "package.json"))("playwright");
const rq = createRequire(resolve(adminRoot, "package.json"));
const { createClient } = rq("@supabase/supabase-js");
const { createServerClient } = rq("@supabase/ssr");
const env = readFileSync(resolve(adminRoot, ".env.local"), "utf8");
const get = (k) => env.match(new RegExp(`^${k}=(.+)$`, "m"))?.[1]?.trim();
const BASE = "http://localhost:3000";
const URL_ = get("NEXT_PUBLIC_SUPABASE_URL"), ANON = get("NEXT_PUBLIC_SUPABASE_ANON_KEY"), SERVICE = get("SUPABASE_SERVICE_ROLE_KEY");
const sb = createClient(URL_, SERVICE), brow = createClient(URL_, ANON);
const EMAIL = "vanuatu.golden@gmail.com";
let fail = 0;
const ck = (l, ok, d = "") => { console.log(`  ${ok ? "✓" : "✗"} ${l}${d ? ` — ${d}` : ""}`); if (!ok) fail++; };
const hr = () => console.log("─".repeat(72));

// 현재 시즌 + 휴식자 집합(direct)
const today = new Date().toISOString().slice(0, 10);
const { data: wk } = await sb.from("weeks").select("season_key").lte("start_date", today).gte("end_date", today).order("start_date", { ascending: false }).limit(1).maybeSingle();
const curKey = wk?.season_key ?? null;
const restIds = new Set();
for (let from = 0; ; from += 1000) {
  const { data } = await sb.from("user_season_statuses").select("user_id").eq("season_key", curKey).eq("status", "rest").order("user_id").range(from, from + 999);
  for (const r of data ?? []) restIds.add(r.user_id);
  if ((data ?? []).length < 1000) break;
}
console.log(`현재 시즌=${curKey} · 휴식자(direct)=${restIds.size}`);

// 테스트 크루: 강지원(encre, 봄 휴식) / 현유빈(encre, 봄 활동)
const { data: rest1 } = await sb.from("user_profiles").select("user_id").eq("organization_slug", "encre").eq("display_name", "강지원").maybeSingle();
const { data: act1 } = await sb.from("user_profiles").select("user_id").eq("organization_slug", "encre").eq("display_name", "현유빈").maybeSingle();
ck("강지원 ∈ 휴식자(direct)", rest1 && restIds.has(rest1.user_id));
ck("현유빈 ∉ 휴식자(direct)", act1 && !restIds.has(act1.user_id));

// 인증
const { data: link } = await sb.auth.admin.generateLink({ type: "magiclink", email: EMAIL });
const { data: v } = await brow.auth.verifyOtp({ email: EMAIL, token: link.properties.email_otp, type: "magiclink" });
const cap = [];
const srv = createServerClient(URL_, ANON, { cookies: { getAll: () => [], setAll: (i) => cap.push(...i) } });
await srv.auth.setSession({ access_token: v.session.access_token, refresh_token: v.session.refresh_token });
const cookies = cap.map((i) => ({ name: i.name, value: i.value, domain: "localhost", path: "/", httpOnly: false, secure: false, sameSite: "Lax" }));
const browser = await chromium.launch({ channel: "chromium", headless: true });
const context = await browser.newContext(); await context.addCookies(cookies);
const page = await context.newPage();

async function search(name, exclude) {
  const sp = new URLSearchParams({ q: name, organization: "encre" });
  if (exclude) sp.set("excludeSeasonRest", "1");
  const res = await page.request.get(`${BASE}/api/admin/cluster4/cafe-line-crew?${sp.toString()}`);
  const j = await res.json();
  return (j?.data?.crews ?? []);
}

hr(); console.log("▶ cafe-line-crew GET (라인 개설 후보) — excludeSeasonRest 효과"); hr();
const restNoFlag = await search("강지원", false);
const restFlag = await search("강지원", true);
const hasRestNo = restNoFlag.some((c) => c.userId === rest1?.user_id);
const hasRestYes = restFlag.some((c) => c.userId === rest1?.user_id);
console.log(`  강지원 검색: 플래그없음 ${restNoFlag.length}건(포함=${hasRestNo}) · excludeSeasonRest=1 ${restFlag.length}건(포함=${hasRestYes})`);
ck("플래그 없으면 휴식자(강지원) 후보에 포함(기존동작 보존)", hasRestNo);
ck("excludeSeasonRest=1 이면 휴식자(강지원) 후보에서 제외", !hasRestYes);

const actNoFlag = await search("현유빈", false);
const actFlag = await search("현유빈", true);
ck("활동자(현유빈)는 플래그 유무 무관 후보에 포함", actNoFlag.some((c) => c.userId === act1?.user_id) && actFlag.some((c) => c.userId === act1?.user_id));

hr(); console.log("▶ direct == HTTP (excludeSeasonRest=1 결과에 휴식자 0)"); hr();
// 광범위 검색(한 글자) 으로 다수 후보 → 결과 중 restIds 교집합 0 이어야
const broad = await search("김", true);
const leaked = broad.filter((c) => restIds.has(c.userId));
console.log(`  '김' 후보 ${broad.length}건 중 휴식자 누수 ${leaked.length}`);
ck("HTTP 후보에 현재 시즌 휴식자 0 (direct restIds 와 일치)", leaked.length === 0, `누수=${leaked.length}`);

await browser.close();
hr();
console.log(fail === 0 ? "✅ 라인 개설(cafe-line-crew) 휴식 제외 PASS" : `❌ ${fail} FAILED`);
process.exit(fail === 0 ? 0 : 1);
