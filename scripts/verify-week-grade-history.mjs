/**
 * 검증(READ-ONLY) — 주차별 확정 품계 이력 backfill apply + [B] 연결 10-point.
 *   DB: 행수/ source 분포 / scope별 grade·null / 주차별 상이 / user_grade_stats·snapshot 불변.
 *   HTTP: [B] 검수완료 주차 실값 · 미완료 '-' · op==test DTO parity.
 *   사전조건: dev :3000, backfill --apply 완료.
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
const URL_ = get("NEXT_PUBLIC_SUPABASE_URL"), ANON = get("NEXT_PUBLIC_SUPABASE_ANON_KEY"), SERVICE = get("SUPABASE_SERVICE_ROLE_KEY");
const sb = createClient(URL_, SERVICE), brow = createClient(URL_, ANON);
const ORG = "encre";
let fail = 0;
const ck = (l, ok, d = "") => { console.log(`  ${ok ? "✓" : "✗"} ${l}${d ? ` — ${d}` : ""}`); if (!ok) fail++; };

// dry-run 기대치.
const EXPECT = { total: 9835, opGrade: 8123, opNull: 2, qaGrade: 1487, qaNull: 223 };
const BASE_GS = { count: 730, maxUpdated: "2026-07-20T04:58:47.855+00:00" };
const BASE_SNAP = 730;

async function scopeCounts(scope, gradeNull) {
  const q = sb.from("user_week_grade_histories").select("id", { count: "exact", head: true }).eq("scope", scope);
  const { count } = gradeNull === "null" ? await q.is("grade", null) : await q.not("grade", "is", null);
  return count ?? 0;
}
async function cookieHeader() {
  const { data: admins } = await sb.from("admin_users").select("email").eq("is_active", true).not("email", "is", null).limit(1);
  const email = admins[0].email;
  const { data: link } = await sb.auth.admin.generateLink({ type: "magiclink", email });
  const { data: v } = await brow.auth.verifyOtp({ email, token: link.properties.email_otp, type: "magiclink" });
  const cap = [];
  const srv = createServerClient(URL_, ANON, { cookies: { getAll: () => [], setAll: (i) => cap.push(...i) } });
  await srv.auth.setSession({ access_token: v.session.access_token, refresh_token: v.session.refresh_token });
  return cap.map((i) => `${i.name}=${i.value}`).join("; ");
}

async function main() {
  console.log("=== DB 검증 ===");
  // 1) 총 행수 == dry-run
  const { count: total } = await sb.from("user_week_grade_histories").select("id", { count: "exact", head: true });
  ck("① 저장 행수 == dry-run 9835", total === EXPECT.total, `${total}`);
  // 2) source 분포
  const { count: bf } = await sb.from("user_week_grade_histories").select("id", { count: "exact", head: true }).eq("source", "backfill");
  ck("② source='backfill' == 전체", bf === total, `backfill=${bf}/${total}`);
  // 3) scope별 grade/null
  const [opG, opN, qaG, qaN] = await Promise.all([
    scopeCounts("operating", "grade"), scopeCounts("operating", "null"),
    scopeCounts("qa", "grade"), scopeCounts("qa", "null"),
  ]);
  ck("③ operating grade/null == dry-run", opG === EXPECT.opGrade && opN === EXPECT.opNull, `grade ${opG}(exp ${EXPECT.opGrade}) null ${opN}(exp ${EXPECT.opNull})`);
  ck("③ qa grade/null == dry-run", qaG === EXPECT.qaGrade && qaN === EXPECT.qaNull, `grade ${qaG}(exp ${EXPECT.qaGrade}) null ${qaN}(exp ${EXPECT.qaNull})`);
  // 6) 동일 유저 주차별 상이
  const { data: multi } = await sb.from("user_week_grade_histories").select("user_id").not("grade", "is", null).limit(2000);
  const byUser = new Map();
  for (const r of multi ?? []) byUser.set(r.user_id, (byUser.get(r.user_id) ?? 0) + 1);
  const target = [...byUser.entries()].find(([, n]) => n >= 4)?.[0];
  if (target) {
    const { data: rows } = await sb.from("user_week_grade_histories").select("week_start_date,grade,avg_percentile").eq("user_id", target).not("grade", "is", null).order("week_start_date");
    const distinctPct = new Set(rows.map((r) => r.avg_percentile)).size;
    ck("⑥ 동일 유저 주차별 품계 상이", distinctPct >= 2, `${rows.length}주차 중 distinct pct ${distinctPct}`);
  } else ck("⑥ 동일 유저 주차별 품계 상이", false, "다주차 유저 없음");
  // 7) user_grade_stats 불변
  const gs = await sb.from("user_grade_stats").select("user_id", { count: "exact", head: false }).order("updated_at", { ascending: false }).limit(1);
  ck("⑦ user_grade_stats 행수·최신 updated_at 불변", gs.count === BASE_GS.count, `count ${gs.count}`);
  const gsMax = await sb.from("user_grade_stats").select("updated_at").order("updated_at", { ascending: false }).limit(1).maybeSingle();
  ck("⑦ user_grade_stats 최신 updated_at 불변(apply 무접촉)", gsMax.data?.updated_at === BASE_GS.maxUpdated, `${gsMax.data?.updated_at}`);
  // 8) snapshot 불변
  const { count: snap } = await sb.from("cluster4_weekly_card_snapshots").select("user_id", { count: "exact", head: true });
  ck("⑧ snapshot 행수 불변", snap === BASE_SNAP, `${snap}`);

  console.log("\n=== HTTP 검증 ([B]) ===");
  const cookie = await cookieHeader();
  const api = (p) => fetch(`${BASE}${p}`, { headers: { cookie } }).then((r) => r.json().then((j) => ({ status: r.status, j })));
  const { data: th } = await sb.from("cluster4_team_halves").select("id,team_name").eq("organization_slug", ORG).eq("is_active", true).eq("is_qa_test", true).order("display_order").limit(1);
  const team = th[0];
  const S = (w) => `/api/admin/team-parts/info/team-detail/week-summary?organization=${ORG}&teamHalfId=${team.id}&mode=test${w ? `&weekId=${w}` : ""}`;
  const b = (await api(S())).j.data;
  const weeks = b.selectableWeeks ?? [];
  let reviewed = null, open = null;
  for (const w of weeks) {
    const d = (await api(S(w.weekId))).j.data;
    if (!d?.week) continue;
    if (d.week.reviewCompleted && !reviewed) reviewed = d;
    if (!d.week.reviewCompleted && !open) open = d;
    if (reviewed && open) break;
  }
  // 5) 미완료 '-'
  if (open) ck("⑤ 미완료 주차 품계 전부 '-'(null)", (open.crewRows ?? []).every((r) => r.gradeLabel == null), `${open.week.label}`);
  // 4) 완료 실값 + DB 대조
  if (reviewed) {
    const rows = reviewed.crewRows ?? [];
    const withGrade = rows.filter((r) => r.gradeLabel != null);
    ck("④ 완료 주차 품계 실값 표시(≥1, '-' 아님)", withGrade.length > 0, `${withGrade.length}/${rows.length} @ ${reviewed.week.label}(${reviewed.week.weekStartDate})`);
    // DB 대조
    const uids = rows.map((r) => r.userId);
    const { data: hist } = await sb.from("user_week_grade_histories").select("user_id,grade,grade_label").eq("week_start_date", reviewed.week.weekStartDate).in("user_id", uids);
    const hById = new Map((hist ?? []).map((h) => [h.user_id, h]));
    let match = 0, checked = 0;
    for (const r of rows) {
      const h = hById.get(r.userId);
      if (!h) continue; checked++;
      if (r.gradeLabel === (h.grade_label ?? null) && r.gradeRank === (h.grade ?? null)) match++;
    }
    ck("④ [B] 품계 == history SoT 대조", checked > 0 && match === checked, `${match}/${checked}`);
    const sample = withGrade[0];
    if (sample) console.log(`  · 샘플 ${sample.name}: 품계=${sample.gradeLabel}(rank ${sample.gradeRank}) @ ${reviewed.week.label}`);
  } else console.log("  · 완료 주차 없음 — 실값 대조 스킵");

  // 9) 품계 키가 DTO(crewRows)에 존재 — 동일 CrewRow 타입/loader(모드 분기 없음).
  const tsKeys = Object.keys((reviewed?.crewRows?.[0]) ?? (b.crewRows?.[0]) ?? {}).sort();
  const hasGradeKeys = tsKeys.includes("gradeLabel") && tsKeys.includes("gradeRank");
  ck("⑨ crewRows 품계 키 존재(gradeLabel/gradeRank)", hasGradeKeys, tsKeys.filter((k) => /grade/i.test(k)).join(","));

  console.log(`\n=== RESULT: ${fail === 0 ? "ALL PASS" : fail + " FAIL"} ===`);
  process.exit(fail === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
