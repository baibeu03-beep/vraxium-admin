// 검증 — POST /api/admin/sync/grade-stats 가 resyncGradeStatsBatch(1스캔) 결과 shape 반환 + 멱등.
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
const rq = createRequire(resolve("package.json"));
const { createClient } = rq("@supabase/supabase-js");
const { createServerClient } = rq("@supabase/ssr");
const { chromium } = createRequire(resolve("..", "vraxium", "package.json"))("playwright");
const env = readFileSync(".env.local", "utf8");
const get = (k) => env.match(new RegExp(`^${k}=(.+)$`, "m"))?.[1]?.trim();
const URL_ = get("NEXT_PUBLIC_SUPABASE_URL"), ANON = get("NEXT_PUBLIC_SUPABASE_ANON_KEY"), SERVICE = get("SUPABASE_SERVICE_ROLE_KEY");
const sb = createClient(URL_, SERVICE), brow = createClient(URL_, ANON);
const EMAIL = "vanuatu.golden@gmail.com";
let fail = 0; const ck = (l, ok, d="") => { console.log(`  ${ok?"✓":"✗"} ${l}${d?` — ${d}`:""}`); if(!ok) fail++; };
const { data: link } = await sb.auth.admin.generateLink({ type: "magiclink", email: EMAIL });
const { data: v } = await brow.auth.verifyOtp({ email: EMAIL, token: link.properties.email_otp, type: "magiclink" });
const cap = [];
const srv = createServerClient(URL_, ANON, { cookies: { getAll: () => [], setAll: (i) => cap.push(...i) } });
await srv.auth.setSession({ access_token: v.session.access_token, refresh_token: v.session.refresh_token });
const cookies = cap.map((i) => ({ name: i.name, value: i.value, domain: "localhost", path: "/", httpOnly: false, secure: false, sameSite: "Lax" }));
const browser = await chromium.launch({ channel: "chromium", headless: true });
const ctx = await browser.newContext(); await ctx.addCookies(cookies);
const page = await ctx.newPage();

// 사전: 캐시 스냅샷(grade 합) — 멱등 비교용.
const snap = async () => {
  const m = new Map();
  for (let from=0;;from+=1000){ const {data}=await sb.from("user_grade_stats").select("user_id,grade,avg_percentile").order("user_id").range(from,from+999);
    for (const r of data??[]) m.set(r.user_id, `${r.grade}|${r.avg_percentile}`); if((data??[]).length<1000) break; } return m; };
const before = await snap();

const res = await page.request.post("http://localhost:3000/api/admin/sync/grade-stats");
const j = await res.json();
console.log("응답:", JSON.stringify(j.data));
ck("200 success", res.status() === 200 && j.success);
ck("resyncGradeStatsBatch shape(total/graded/nulled)", j.data && typeof j.data.total === "number" && typeof j.data.graded === "number" && typeof j.data.nulled === "number");
ck("syncAllGradeStats 구형 shape(synced/results) 아님", !(j.data && "results" in j.data));

const after = await snap();
let changed = 0; for (const [k,vv] of after) if (before.get(k) !== vv) changed++;
ck("멱등 — 재동기 후 캐시 변화 0(이미 최신)", changed === 0, `changed=${changed}`);

await browser.close();
console.log(fail === 0 ? "✅ grade-stats sync 라우트 정상(빠른 배치·멱등)" : `❌ ${fail} FAILED`);
process.exit(fail === 0 ? 0 : 1);
