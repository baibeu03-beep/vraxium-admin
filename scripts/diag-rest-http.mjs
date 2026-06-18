// 진단(HTTP): /api/admin/members/roster 실제 응답에 휴식류 status 가 내려오는지.
//  사전조건: admin dev :3000. node scripts/diag-rest-http.mjs
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const adminRoot = resolve(__dirname, "..");
const rq = createRequire(resolve(adminRoot, "package.json"));
const { createClient } = rq("@supabase/supabase-js");
const { createServerClient } = rq("@supabase/ssr");
const env = readFileSync(resolve(adminRoot, ".env.local"), "utf8");
const get = (k) => env.match(new RegExp(`^${k}=(.+)$`, "m"))?.[1]?.trim();
const BASE = "http://localhost:3000";
const URL_ = get("NEXT_PUBLIC_SUPABASE_URL"),
  ANON = get("NEXT_PUBLIC_SUPABASE_ANON_KEY"),
  SERVICE = get("SUPABASE_SERVICE_ROLE_KEY");
const sb = createClient(URL_, SERVICE);
const brow = createClient(URL_, ANON);
const EMAIL = "vanuatu.golden@gmail.com";

// 0) growth_status 카운트 재확인(detail 스크립트 0/9 불일치 해소)
const { count: gsCount } = await sb
  .from("user_profiles")
  .select("*", { count: "exact", head: true })
  .eq("growth_status", "seasonal_rest");
const { data: gsRows } = await sb
  .from("user_profiles")
  .select("id, growth_status, display_name")
  .eq("growth_status", "seasonal_rest");
console.log(`growth_status='seasonal_rest' count(head)=${gsCount} rows=${gsRows?.length ?? 0}`);

// 세션 생성 → 쿠키 추출
const { data: link } = await sb.auth.admin.generateLink({ type: "magiclink", email: EMAIL });
const { data: v } = await brow.auth.verifyOtp({
  email: EMAIL,
  token: link.properties.email_otp,
  type: "magiclink",
});
const cap = [];
const srv = createServerClient(URL_, ANON, {
  cookies: { getAll: () => [], setAll: (i) => cap.push(...i) },
});
await srv.auth.setSession({
  access_token: v.session.access_token,
  refresh_token: v.session.refresh_token,
});
const cookieHeader = cap.map((i) => `${i.name}=${i.value}`).join("; ");

async function probe(mode) {
  const res = await fetch(`${BASE}/api/admin/members/roster?mode=${mode}`, {
    headers: { cookie: cookieHeader },
  });
  const json = await res.json();
  const members = json?.data?.members ?? [];
  const dist = {};
  for (const m of members) {
    const k = m.displayGrowthStatus ?? "(null)";
    dist[k] = (dist[k] ?? 0) + 1;
  }
  const restRows = members.filter((m) =>
    ["weekly_rest", "seasonal_rest", "official_rest"].includes(m.displayGrowthStatus),
  );
  console.log(`\n[HTTP mode=${mode}] status=${res.status} members=${members.length}`);
  console.log(`  displayGrowthStatus 분포: ${JSON.stringify(dist)}`);
  console.log(`  휴식류 행 수: ${restRows.length}`);
  // 샘플 키 — 응답에 휴식 전용 필드(seasonRest/weeklyRest)가 있는지
  if (members[0]) console.log(`  row 키: ${Object.keys(members[0]).join(", ")}`);
}

await probe("operating");
await probe("test");
process.exit(0);
