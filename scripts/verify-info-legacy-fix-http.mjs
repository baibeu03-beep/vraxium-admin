// HTTP 검증 — 레거시 주차 실무정보 강화 정책 수정(대상자=성공) 운영 모드 반영.
//   GET /api/cluster4/weekly-cards?userId=<운영 대상자> 를 admin 세션으로 호출해
//   2026 봄 W11 wisdom(IFBS-NN0001) 강화상태가 success, 미기입(submission not_submitted)인지 확인.
//   - fresh connection(connection: close) — keep-alive 쿼리유실 환경 flake 배제(reference 메모).
//   - direct(저장 snapshot) == HTTP 응답 일치 확인.
//   - 한 명은 is_stale=true 로 만들어 서버 lazy 재계산 경로(=배포 코드)가 success 를 내는지도 확인.
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
const adminEmail = process.env.SMOKE_ADMIN_EMAIL ?? "vanuatu.golden@gmail.com";
const BASE = process.env.SMOKE_BASE_URL ?? "http://localhost:3000";
const U = get("NEXT_PUBLIC_SUPABASE_URL"), AN = get("NEXT_PUBLIC_SUPABASE_ANON_KEY"), SV = get("SUPABASE_SERVICE_ROLE_KEY");
const sb = createClient(U, SV);

let pass = 0, fail = 0;
const check = (l, ok, d = "") => { console.log(`  ${ok ? "✓" : "✗"} ${l}${d ? ` — ${d}` : ""}`); ok ? pass++ : fail++; };

async function cookieHeader() {
  const a = createClient(U, SV), b = createClient(U, AN);
  const { data: l } = await a.auth.admin.generateLink({ type: "magiclink", email: adminEmail });
  const { data: v } = await b.auth.verifyOtp({ email: adminEmail, token: l.properties.email_otp, type: "magiclink" });
  const cap = [];
  const s = createServerClient(U, AN, { cookies: { getAll: () => [], setAll: (it) => cap.push(...it) } });
  await s.auth.setSession({ access_token: v.session.access_token, refresh_token: v.session.refresh_token });
  return cap.map((i) => `${i.name}=${i.value}`).join("; ");
}
const COOKIE = await cookieHeader();

async function httpW11Wisdom(userId) {
  const r = await fetch(`${BASE}/api/cluster4/weekly-cards?userId=${userId}`, { headers: { cookie: COOKIE, connection: "close" } });
  const j = await r.json();
  const cards = j?.data ?? [];
  const c = cards.find((x) => x.weekNumber === 11 && x.seasonKey === "2026-spring");
  const w = (c?.lines ?? []).filter((l) => l.partType === "information").find((l) => l.displayLineCode === "IFBS-NN0001");
  return { status: r.status, wisdom: w ? { enh: w.enhancementStatus, sub: w.submissionStatus } : null, weekStatus: c?.userWeekStatus, growth: c ? `${c.growthNumerator}/${c.growthDenominator}` : null };
}
function storedW11Wisdom(cards) {
  const c = cards.find((x) => x.weekNumber === 11 && x.seasonKey === "2026-spring");
  const w = (c?.lines ?? []).filter((l) => l.partType === "information").find((l) => l.displayLineCode === "IFBS-NN0001");
  return w ? { enh: w.enhancementStatus, sub: w.submissionStatus } : null;
}

async function targetUsers() {
  const { data } = await sb.from("cluster4_line_targets").select("target_user_id")
    .eq("line_id", "66693805-7b41-45b6-8239-3df75ad8f075").eq("week_id", "67e07106-564e-4dab-b180-8f11c909973a").eq("target_mode", "user").limit(2);
  return (data ?? []).map((r) => r.target_user_id);
}

try {
  const users = await targetUsers();
  console.log(`\n=== HTTP weekly-cards W11 wisdom (운영 대상자 ${users.length}명) ===\n`);
  for (const u of users) {
    const { data: p } = await sb.from("user_profiles").select("display_name").eq("user_id", u).maybeSingle();
    const { data: snap } = await sb.from("cluster4_weekly_card_snapshots").select("cards").eq("user_id", u).maybeSingle();
    const stored = storedW11Wisdom(snap?.cards ?? []);
    const http = await httpW11Wisdom(u);
    check(`${p?.display_name}: HTTP enh=success`, http.wisdom?.enh === "success", `enh=${http.wisdom?.enh} sub=${http.wisdom?.sub} weekStatus=${http.weekStatus} growth=${http.growth}`);
    check(`${p?.display_name}: submissionStatus=not_submitted(미기입 유지)`, http.wisdom?.sub === "not_submitted");
    check(`${p?.display_name}: direct(stored)==HTTP`, JSON.stringify(stored) === JSON.stringify(http.wisdom), `stored=${JSON.stringify(stored)} http=${JSON.stringify(http.wisdom)}`);
  }

  // 서버 lazy 재계산 경로(배포 코드) 검증: 한 명을 stale 로 만들고 HTTP → 서버가 재계산 → success.
  const u = users[0];
  await sb.from("cluster4_weekly_card_snapshots").update({ is_stale: true }).eq("user_id", u);
  const { data: afterStale } = await sb.from("cluster4_weekly_card_snapshots").select("is_stale").eq("user_id", u).maybeSingle();
  check("stale 처리됨(is_stale=true)", afterStale?.is_stale === true);
  const http2 = await httpW11Wisdom(u);
  check("stale 후 HTTP(서버 lazy 재계산) enh=success", http2.wisdom?.enh === "success", `enh=${http2.wisdom?.enh}`);
  const { data: afterRead } = await sb.from("cluster4_weekly_card_snapshots").select("is_stale").eq("user_id", u).maybeSingle();
  check("조회 후 재계산되어 is_stale=false", afterRead?.is_stale === false);
} catch (e) {
  check("실행", false, e instanceof Error ? e.message : String(e));
}
console.log(`\n=== HTTP 결과: ${pass} pass / ${fail} fail ===`);
process.exit(fail === 0 ? 0 : 1);
