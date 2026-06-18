// 등급(user_grade_stats) 당사자 즉시 갱신 hook 검증 — 변동 수동부여 적립 경로.
//   run: npx tsx --env-file=.env.local scripts/verify-grade-accrual-hook.ts
//   확인: ① 적립 후 당사자 user_grade_stats 갱신(hook) ② 타 사용자 미갱신(전체 재계산 X)
//        ③ 고객앱 profile 등급 = live getClubRank(=admin /api/cluster3/club-rank) 즉시 반영
//        ④ direct(getClubRank) == HTTP(/api/cluster3/club-rank) ⑤ cleanup 원복.
//   ⚠ 고객 등급 SoT = live getClubRank(캐시 아님). hook 은 user_grade_stats 캐시 소비처용 당사자 동기화.
import { createClient } from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";
import { getClubRank } from "@/lib/cluster3ClubRankData";
import { accrueForCompletedIrregular } from "@/lib/processPointAccrual";

const URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const ANON = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const KEY = process.env.INTERNAL_API_KEY ?? "";
const sb = createClient(URL, SERVICE, { auth: { persistSession: false } });
const J = (o: unknown) => JSON.stringify(o);
const TAG = "ZZ-grade";
let pass = 0, fail = 0;
const ck = (l: string, ok: boolean, d = "") => { console.log(`  ${ok ? "✓" : "✗"} ${l}${d ? ` — ${d}` : ""}`); ok ? pass++ : fail++; };

async function cookie() {
  const brow = createClient(URL, ANON);
  const { data: link } = await sb.auth.admin.generateLink({ type: "magiclink", email: "vanuatu.golden@gmail.com" });
  const { data: v } = await brow.auth.verifyOtp({ email: "vanuatu.golden@gmail.com", token: link!.properties.email_otp, type: "magiclink" });
  const cap: any[] = []; const srv = createServerClient(URL, ANON, { cookies: { getAll: () => [], setAll: (i: any) => cap.push(...i) } });
  await srv.auth.setSession({ access_token: v.session!.access_token, refresh_token: v.session!.refresh_token });
  return cap.map((i) => `${i.name}=${i.value}`).join("; ");
}
const gradeRow = async (u: string) => (await sb.from("user_grade_stats").select("avg_percentile,grade,grade_label,updated_at").eq("user_id", u).maybeSingle()).data as any;

async function main() {
  if ((await sb.from("process_point_awards").select("id").limit(1)).error) { console.log("⚠ ledger 미적용"); process.exit(2); }

  const markers = new Set(((await sb.from("test_user_markers").select("user_id")).data ?? []).map((x: any) => x.user_id));
  const graded = ((await sb.from("user_grade_stats").select("user_id,updated_at").limit(2000)).data ?? []) as any[];
  const gradedSet = new Map(graded.map((g) => [g.user_id, g.updated_at]));
  const oranke = ((await sb.from("user_profiles").select("user_id").eq("organization_slug", "oranke")).data ?? []) as any[];
  const target = oranke.find((u) => markers.has(u.user_id) && gradedSet.has(u.user_id))?.user_id ?? oranke.find((u) => markers.has(u.user_id))?.user_id;
  const controls = graded.filter((g) => g.user_id !== target).slice(0, 3);
  const week = (await sb.from("weeks").select("id,iso_year,iso_week,week_number,start_date").eq("season_key", "2026-spring").eq("week_number", 13).maybeSingle()).data as any;
  ck("[전제] 테스트유저(target)·W13·control 등급행", !!target && !!week?.id && controls.length > 0, J({ target: !!target, controls: controls.length }));
  if (!target || !week?.id) process.exit(2);

  const iso = { y: week.iso_year as number, w: week.iso_week as number };
  const ck0 = await cookie();
  const api = async (path: string, init: any = {}) => {
    const res = await fetch(`http://localhost:3000${path}`, { ...init, headers: { "Content-Type": "application/json", cookie: ck0, ...(init.headers ?? {}) } });
    return { status: res.status, json: await res.json().catch(() => ({})) };
  };
  const httpClubRank = async (u: string) => {
    const res = await fetch(`http://localhost:3000/api/cluster3/club-rank?userId=${u}`, { headers: { "x-internal-api-key": KEY } });
    return { status: res.status, json: await res.json().catch(() => ({})) };
  };
  const pointsOf = async () => ((await sb.from("user_weekly_points").select("points").eq("user_id", target).eq("year", iso.y).eq("week_number", iso.w).maybeSingle()).data as any)?.points ?? 0;

  // 원본 보존
  const origRow = (await sb.from("user_weekly_points").select("id,points,advantages,penalty,checks_migrated").eq("user_id", target).eq("year", iso.y).eq("week_number", iso.w).maybeSingle()).data as any;
  const gradeBefore = await gradeRow(target);
  const liveBefore = await getClubRank(target);
  const controlBefore = controls.map((c) => ({ id: c.user_id, updated_at: c.updated_at }));

  const cleanIrr = async () => {
    const rows = (await sb.from("process_irregular_acts").select("id").like("act_name", `${TAG}%`)).data ?? [];
    for (const r of rows as any[]) { await sb.from("process_check_review_recipients").delete().eq("ref_id", r.id); await sb.from("process_point_awards").delete().eq("ref_id", r.id); }
    if ((rows as any[]).length) await sb.from("process_irregular_acts").delete().in("id", (rows as any[]).map((r) => r.id));
  };
  await cleanIrr();

  // ── 적립: 변동 수동부여 2회(test, W13, point_a=20) → 40 (>base 34, 등급 상향) ──
  const grants: string[] = [];
  for (const n of [1, 2]) {
    const g = await api("/api/admin/processes/check/irregular", { method: "POST", body: J({ organization: "oranke", mode: "test", kind: "manual_grant", act_name: `${TAG} ${n}`, target_user_ids: [target], point_a: 20, point_b: 0, point_c: 0 }) });
    grants.push(g.json?.data?.id);
  }
  ck("[전제] 적립 2회 → W13 points=40", (await pointsOf()) === 40, `points=${await pointsOf()}`);

  // (1) 당사자 user_grade_stats 갱신(hook 실행 — updated_at bump)
  const gradeAfter = await gradeRow(target);
  ck("[1] 적립 후 당사자 user_grade_stats 갱신(updated_at bump)", !!gradeAfter && gradeAfter.updated_at !== gradeBefore?.updated_at, `before=${gradeBefore?.updated_at} after=${gradeAfter?.updated_at}`);

  // 캐시 == live getClubRank (당사자 일관성)
  const liveAfter = await getClubRank(target);
  ck("[일관성] user_grade_stats.avg_percentile == getClubRank(live)", Number(gradeAfter?.avg_percentile) === Number(liveAfter.avgPercentile), `cache=${gradeAfter?.avg_percentile} live=${liveAfter.avgPercentile}`);

  // (3) 타 사용자 등급 미갱신(전체 재계산 X)
  let controlsUnchanged = true;
  for (const c of controlBefore) { const now = (await gradeRow(c.id))?.updated_at; if (now !== c.updated_at) controlsUnchanged = false; }
  ck("[3] 타 사용자 user_grade_stats 미갱신(syncAllGradeStats 미실행)", controlsUnchanged, `controls=${controlBefore.length}`);

  // (4) 고객앱 profile 등급 = live getClubRank 즉시 반영(점수 변동 반영)
  ck("[4] 고객 등급(live) 적립 전후 변동 반영", Number(liveAfter.avgPercentile) !== Number(liveBefore.avgPercentile) || liveAfter.rankGrade !== liveBefore.rankGrade, `before=${liveBefore.avgPercentile}/${liveBefore.rankGrade} after=${liveAfter.avgPercentile}/${liveAfter.rankGrade}`);

  // (6) direct == HTTP (고객 등급 SoT 경로)
  const http = await httpClubRank(target);
  ck("[6] direct(getClubRank) == HTTP(/api/cluster3/club-rank)", http.status === 200 && Number(http.json?.data?.avgPercentile) === Number(liveAfter.avgPercentile), `http=${http.json?.data?.avgPercentile} direct=${liveAfter.avgPercentile}`);

  // (5) cleanup — 삭제(revoke→points 복원+등급 재동기) + uwp 원복 + 등급 캐시 원복
  for (const id of grants) { if (id) await api("/api/admin/processes/check/irregular", { method: "DELETE", body: J({ id, organization: "oranke", mode: "test" }) }); }
  await cleanIrr();
  await sb.from("process_point_awards").delete().eq("user_id", target).eq("year", iso.y).eq("week_number", iso.w);
  if (origRow) await sb.from("user_weekly_points").update({ points: origRow.points, advantages: origRow.advantages, penalty: origRow.penalty, checks_migrated: origRow.checks_migrated }).eq("id", origRow.id);
  else await sb.from("user_weekly_points").delete().eq("user_id", target).eq("year", iso.y).eq("week_number", iso.w);
  const { syncGradeStats } = await import("@/lib/cluster3ClubRankData");
  await syncGradeStats(target); // 캐시 원복(복원된 points 기준)
  const gradeFinal = await gradeRow(target);
  const liveFinal = await getClubRank(target);
  ck("[5] cleanup — points 원복 · 등급 캐시==live 복원", (await pointsOf()) === (origRow?.points ?? 0) && Number(gradeFinal?.avg_percentile) === Number(liveFinal.avgPercentile), `points=${await pointsOf()} cache=${gradeFinal?.avg_percentile} live=${liveFinal.avgPercentile}`);

  console.log(`\n결과: ${pass} pass / ${fail} fail`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error("FATAL:", e?.stack ?? e); process.exit(1); });
