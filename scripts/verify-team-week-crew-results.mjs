/**
 * 검증(READ-ONLY) — 팀 상세 [B] 조회 전용 결과 3종(성장성공/라인강화율/액트체크율) SoT 배선.
 *   · 검수 미완료 주차 → 3종 전부 null('-').
 *   · 검수 완료 주차   → 3종 real. lineEnhancementRate == snapshot card.weeklyGrowthRate,
 *                       actCheckRate == buildCrewActSummary(card.actLogs) 재현, growthSuccessCount == 누적 재현.
 *   사전조건: dev :3000. 무접촉(쓰기 없음).
 *   Usage: node scripts/verify-team-week-crew-results.mjs
 */
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
const URL_ = get("NEXT_PUBLIC_SUPABASE_URL");
const ANON = get("NEXT_PUBLIC_SUPABASE_ANON_KEY");
const SERVICE = get("SUPABASE_SERVICE_ROLE_KEY");
const sb = createClient(URL_, SERVICE);
const brow = createClient(URL_, ANON);

let fail = 0;
const ck = (l, ok, d = "") => { console.log(`  ${ok ? "✓" : "✗"} ${l}${d ? ` — ${d}` : ""}`); if (!ok) fail++; };
const ORG = "encre";

// buildCrewActSummary.rate 재현(공통 SoT 미러) — 취소·source='line' 제외, C>0=fail.
function actRate(actLogs) {
  if (!Array.isArray(actLogs)) return null;
  const rows = actLogs.filter((l) => (l.source === "regular" || l.source === "irregular") && !l.cancelled);
  if (rows.length === 0) return 0;
  const success = rows.filter((l) => !(Math.abs(l.pointC ?? 0) > 0)).length;
  return Math.round((success / rows.length) * 100);
}

async function cookieHeader() {
  const { data: admins } = await sb.from("admin_users").select("email").eq("is_active", true).not("email", "is", null).limit(1);
  const email = admins?.[0]?.email;
  const { data: link } = await sb.auth.admin.generateLink({ type: "magiclink", email });
  const { data: v } = await brow.auth.verifyOtp({ email, token: link.properties.email_otp, type: "magiclink" });
  const cap = [];
  const srv = createServerClient(URL_, ANON, { cookies: { getAll: () => [], setAll: (i) => cap.push(...i) } });
  await srv.auth.setSession({ access_token: v.session.access_token, refresh_token: v.session.refresh_token });
  console.log(`admin: ${email}`);
  return cap.map((i) => `${i.name}=${i.value}`).join("; ");
}

async function main() {
  const cookie = await cookieHeader();
  const api = (path) => fetch(`${BASE}${path}`, { headers: { cookie } }).then((r) => r.json().then((j) => ({ status: r.status, j })));

  const { data: th } = await sb.from("cluster4_team_halves").select("id,team_name")
    .eq("organization_slug", ORG).eq("is_active", true).eq("is_qa_test", true).order("display_order").limit(1);
  const team = th?.[0];
  if (!team) { console.log("팀 없음 — abort"); process.exit(1); }
  console.log(`팀: ${team.team_name} (${team.id})`);
  const S = (weekId) => `/api/admin/team-parts/info/team-detail/week-summary?organization=${ORG}&teamHalfId=${team.id}&mode=test${weekId ? `&weekId=${weekId}` : ""}`;

  const base = (await api(S())).j.data;
  const weeks = base.selectableWeeks ?? [];
  console.log(`선택 가능 주차 ${weeks.length}개`);

  // 검수 완료 / 미완료 주차 각각 1개 확보(주차별 week-summary 순회).
  let reviewedWeek = null, openWeek = null;
  for (const w of weeks) {
    const d = (await api(S(w.weekId))).j.data;
    if (!d?.week) continue;
    if (d.week.reviewCompleted && !reviewedWeek) reviewedWeek = d;
    if (!d.week.reviewCompleted && !openWeek) openWeek = d;
    if (reviewedWeek && openWeek) break;
  }

  // ── 검수 미완료 주차 → 3종 전부 null ──
  if (openWeek) {
    console.log(`\n[미완료] ${openWeek.week.label} (${openWeek.week.weekStartDate}) reviewCompleted=false`);
    const rows = openWeek.crewRows ?? [];
    const allNull = rows.every((r) => r.growthSuccessCount == null && r.lineEnhancementRate == null && r.actCheckRate == null);
    ck("미완료 주차 3종 전부 null('-')", allNull, `rows=${rows.length}`);
  } else console.log("\n[미완료] 해당 없음 — 스킵");

  // ── 검수 완료 주차 → 3종 real + snapshot SoT 대조 ──
  if (reviewedWeek) {
    const wk = reviewedWeek.week;
    console.log(`\n[완료] ${wk.label} (${wk.weekStartDate}) reviewCompleted=true`);
    const rows = reviewedWeek.crewRows ?? [];
    ck("완료 주차 crewRows 존재", rows.length > 0, `rows=${rows.length}`);

    // snapshot 직접 조회(대조 SoT).
    const uids = rows.map((r) => r.userId);
    const snapMap = new Map();
    for (let i = 0; i < uids.length; i += 50) {
      const { data } = await sb.from("cluster4_weekly_card_snapshots").select("user_id,cards").in("user_id", uids.slice(i, i + 50));
      for (const s of data ?? []) snapMap.set(s.user_id, Array.isArray(s.cards) ? s.cards : []);
    }

    let checked = 0, rateMatch = 0, actMatch = 0, cumMatch = 0, anyReal = 0;
    for (const r of rows) {
      const cards = snapMap.get(r.userId) ?? [];
      const card = cards.find((c) => c.startDate === wk.weekStartDate);
      if (r.lineEnhancementRate != null || r.actCheckRate != null || r.growthSuccessCount != null) anyReal++;
      if (!card) continue;
      checked++;
      // 라인 강화율 == card.weeklyGrowthRate
      if (r.lineEnhancementRate === (typeof card.weeklyGrowthRate === "number" ? card.weeklyGrowthRate : null)) rateMatch++;
      // 액트 체크율 == 재현
      if (r.actCheckRate === actRate(card.actLogs)) actMatch++;
      // 누적 성장 성공 == 재현(ASC 훑기)
      const asc = [...cards].sort((a, b) => (a.startDate < b.startDate ? -1 : a.startDate > b.startDate ? 1 : 0));
      let cum = 0, expect = null;
      for (const c of asc) {
        const und = c.userWeekStatus === "running" || c.userWeekStatus === "tallying";
        if (!und && c.userWeekStatus === "success") cum += 1;
        if (c.startDate === wk.weekStartDate) { expect = und ? null : cum; break; }
      }
      if (r.growthSuccessCount === expect) cumMatch++;
    }
    ck("완료 주차 3종 real 값 존재(≥1 크루)", anyReal > 0, `real rows=${anyReal}/${rows.length}`);
    ck("라인강화율 == snapshot card.weeklyGrowthRate", checked > 0 && rateMatch === checked, `${rateMatch}/${checked}`);
    ck("액트체크율 == buildCrewActSummary 재현", checked > 0 && actMatch === checked, `${actMatch}/${checked}`);
    ck("성장성공 == 누적 재현(as-of)", checked > 0 && cumMatch === checked, `${cumMatch}/${checked}`);

    // 샘플 1건 출력.
    const sample = rows.find((r) => r.lineEnhancementRate != null || r.actCheckRate != null);
    if (sample) console.log(`  · 샘플 ${sample.name}: 성장성공=${sample.growthSuccessCount} 라인강화율=${sample.lineEnhancementRate}% 액트체크율=${sample.actCheckRate}%`);
  } else console.log("\n[완료] 검수 완료 주차 없음 — real 대조 스킵(미완료 null 검증만).");

  console.log(`\n=== RESULT: ${fail === 0 ? "ALL PASS" : fail + " FAIL"} ===`);
  process.exit(fail === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
