// 프로세스 체크 완료 → 포인트 적립 검증 (era 경계 + W13 테스트 예외 + flip + 멱등 + cleanup).
//   run: npx tsx --env-file=.env.local scripts/verify-process-point-accrual.ts
//   PART1 = 순수 era 가드(DB 무관). PART2 = ledger 테이블 probe. PART3 = 전체 E2E(테이블 적용 후).
//   전제(PART3): admin(:3000) + 2026-06-15_process_point_awards.sql 적용 + 2026-06-15_process_irregular_acts.sql 적용.
import { createClient } from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";
import { isAccrualAllowedWeek } from "@/lib/processPointAccrual";
import {
  TEST_SUMMER_SIM_EFFECTIVE_FROM,
  fetchLegacyUnifiedMasterId,
} from "@/lib/lineAvailability";
import { getExperienceSlotsByMasterIdsRegFirst } from "@/lib/lineRegistrationLookup";
import { getCluster4WeeklyCardsForProfileUser } from "@/lib/cluster4WeeklyCardsData";
import { readWeeklyCardsSnapshot, recomputeAndStoreWeeklyCardsSnapshot } from "@/lib/cluster4WeeklyCardsSnapshot";

const URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const ANON = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const sb = createClient(URL, SERVICE, { auth: { persistSession: false } });
const J = (o: unknown) => JSON.stringify(o);
const TAG = "ZZ-accrual", PAST = "2020-01-01T00:00:00.000Z";
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

async function main() {
  // ── PART 1: 순수 era 가드 ──
  const W13 = { start_date: "2026-05-25", season_key: "2026-spring", week_number: 13 };
  const W12 = { start_date: "2026-05-18", season_key: "2026-spring", week_number: 12 };
  const SUMMER = { start_date: "2026-06-29", season_key: "2026-summer", week_number: 1 };
  ck("[pure] operating + summer → 허용", isAccrualAllowedWeek("operating", SUMMER) === true);
  ck("[pure] operating + W13 → 차단", isAccrualAllowedWeek("operating", W13) === false);
  ck("[pure] test + W13 → 허용(예외)", isAccrualAllowedWeek("test", W13) === true);
  ck("[pure] test + summer → 허용", isAccrualAllowedWeek("test", SUMMER) === true);
  ck("[pure] test + W12(예외 아님) → 차단", isAccrualAllowedWeek("test", W12) === false);
  ck("[pure] operating + summer 미만 일반주차 → 차단", isAccrualAllowedWeek("operating", W12) === false);

  // ── PART 2: ledger 테이블 probe ──
  const probe = await sb.from("process_point_awards").select("id").limit(1);
  if (probe.error) {
    console.log(`\n⚠ process_point_awards 미적용(${probe.error.code}) — db/migrations/2026-06-15_process_point_awards.sql 적용 후 PART3 재실행.`);
    console.log(`\n결과(PART1): ${pass} pass / ${fail} fail · PART3 보류(마이그레이션 대기)`);
    process.exit(fail ? 1 : 2);
  }
  ck("[probe] process_point_awards 테이블 존재", true);

  // ── PART 3: 전체 E2E (test 모드 W13) ──
  const markers = new Set(((await sb.from("test_user_markers").select("user_id")).data ?? []).map((x: any) => x.user_id));
  const oranke = ((await sb.from("user_profiles").select("user_id").eq("organization_slug", "oranke")).data ?? []) as any[];
  const user = oranke.find((u) => markers.has(u.user_id))?.user_id;
  const realUser = oranke.find((u) => !markers.has(u.user_id))?.user_id;
  const week = (await sb.from("weeks").select("id,iso_year,iso_week,week_number,start_date,check_threshold").eq("season_key", "2026-spring").eq("week_number", 13).maybeSingle()).data as any;
  const masters = ((await sb.from("cluster4_experience_line_masters").select("id").eq("is_active", true).limit(60)).data ?? []) as any[];
  const slotMap = await getExperienceSlotsByMasterIdsRegFirst(masters.map((m) => m.id));
  const unifiedId = await fetchLegacyUnifiedMasterId();
  const pick = (n: number) => masters.find((m) => slotMap.get(m.id) === n && m.id !== unifiedId);
  const m1 = pick(1), m2 = pick(2), m3 = pick(3);
  ck("[셋업] test유저·실유저·W13·슬롯1/2/3", !!user && !!realUser && !!week?.id && !!m1 && !!m2 && !!m3, J({ user: !!user, real: !!realUser, m: [!!m1, !!m2, !!m3] }));
  if (!user || !week?.id || !m1 || !m2 || !m3) { process.exit(2); }

  const owt = (await sb.from("org_week_thresholds").select("check_threshold").eq("week_id", week.id).eq("organization_slug", "oranke").maybeSingle()).data as any;
  const threshold = owt?.check_threshold ?? (week.check_threshold ?? 30);
  const iso = { y: week.iso_year as number, w: week.iso_week as number };
  const ck0 = await cookie();
  const api = async (path: string, init: any = {}) => {
    const res = await fetch(`http://localhost:3000${path}`, { ...init, headers: { "Content-Type": "application/json", cookie: ck0, ...(init.headers ?? {}) } });
    return { status: res.status, json: await res.json().catch(() => ({})) };
  };
  const w13Card = async () => {
    const cards = await getCluster4WeeklyCardsForProfileUser(user, { effectiveFromOverride: TEST_SUMMER_SIM_EFFECTIVE_FROM }) as any[];
    return cards.find((c) => c.weekNumber === 13 && c.seasonKey === "2026-spring");
  };

  // 원본 보존
  const origRow = (await sb.from("user_weekly_points").select("id,points,advantages,penalty,checks_migrated").eq("user_id", user).eq("year", iso.y).eq("week_number", iso.w).maybeSingle()).data as any;
  const origUws = (await sb.from("user_week_statuses").select("id,status").eq("user_id", user).eq("week_start_date", week.start_date).maybeSingle()).data as any;
  const cleanupLines = async () => {
    const rows = (await sb.from("cluster4_lines").select("id").eq("part_type", "experience").like("line_code", `${TAG}%`)).data ?? [];
    const ids = rows.map((x: any) => x.id);
    if (ids.length) { await sb.from("cluster4_line_targets").delete().in("line_id", ids); await sb.from("cluster4_lines").delete().in("id", ids); }
  };

  await cleanupLines();
  // 슬롯 라인 3개(과거 마감) + uws success → verdict pass(게이트 평가 대상)
  for (const [i, m] of [m1, m2, m3].entries()) {
    const { data: line } = await sb.from("cluster4_lines").insert({ part_type: "experience", experience_line_master_id: m.id, line_code: `${TAG}-S${i + 1}`, main_title: `${TAG} slot${i + 1}`, submission_opens_at: PAST, submission_closes_at: PAST, is_active: true }).select("id").single();
    await sb.from("cluster4_line_targets").insert({ line_id: (line as any).id, week_id: week.id, target_mode: "user", target_user_id: user, target_rule: {} });
  }
  if (origUws) await sb.from("user_week_statuses").update({ status: "success" }).eq("id", origUws.id);
  else await sb.from("user_week_statuses").upsert({ user_id: user, year: iso.y, week_number: week.week_number, week_start_date: week.start_date, status: "success", season_key: "2026-spring" }, { onConflict: "user_id,year,week_number" });

  const { accrueForCompletedIrregular } = await import("@/lib/processPointAccrual");
  const PER = Math.min(20, threshold); // 액트당 포인트 상한 20 → threshold(37) 돌파에 2회 필요
  const expSum = PER * 2;
  const grants: string[] = [];
  const pointsOf = async () => ((await sb.from("user_weekly_points").select("points").eq("user_id", user).eq("year", iso.y).eq("week_number", iso.w).maybeSingle()).data as any)?.points ?? 0;
  const postGrant = async (n: number) => {
    const r = await api("/api/admin/processes/check/irregular", { method: "POST", body: J({ organization: "oranke", mode: "test", kind: "manual_grant", act_name: `${TAG} 적립${n}`, target_user_ids: [user], point_a: PER, point_b: 0, point_c: 0 }) });
    return { status: r.status, id: r.json?.data?.id };
  };

  // (1) 적립 허용 + (4) user_weekly_points 반영 — 누적 2회로 threshold 돌파(Σ원장 덮어쓰기)
  const g1 = await postGrant(1); grants.push(g1.id);
  ck("[1] test+W13+테스트유저 manual_grant 201", g1.status === 201 && !!g1.id, `status=${g1.status}`);
  ck("[4a] 적립1 → user_weekly_points.points=PER", (await pointsOf()) === PER, `points=${await pointsOf()}/${PER}`);
  const g2 = await postGrant(2); grants.push(g2.id);
  ck("[4b] 적립2 누적 → points=PER*2", (await pointsOf()) === expSum, `points=${await pointsOf()}/${expSum}`);

  // (5) ledger 생성
  const ledgerCount = (await sb.from("process_point_awards").select("id", { count: "exact", head: true }).eq("user_id", user).eq("year", iso.y).eq("week_number", iso.w)).count ?? 0;
  ck("[5] process_point_awards ledger 2행 생성", ledgerCount === 2, `rows=${ledgerCount}`);

  // (7) snapshot 재계산 + (8) DTO flip(success)
  const snap = await readWeeklyCardsSnapshot(user);
  ck("[7] 적립 후 snapshot hit", snap.status === "hit", `status=${snap.status}`);
  let c = await w13Card();
  ck("[8] DTO W13 points.star=Σ·checkGate.passed=true·success(flip)", c?.points?.star === expSum && c?.experienceGrowth?.checkGate?.passed === true && c?.userWeekStatus === "success", `star=${c?.points?.star} gate=${J(c?.experienceGrowth?.checkGate)} st=${c?.userWeekStatus}`);

  // (10) direct == HTTP
  const httpRes = await api(`/api/cluster4/weekly-cards?demoUserId=${user}&mode=test`);
  const hc = (httpRes.json?.data ?? []).find((x: any) => x.weekNumber === 13 && x.seasonKey === "2026-spring");
  ck("[10] direct == HTTP (star/gate/status 동일)", hc?.points?.star === c?.points?.star && hc?.experienceGrowth?.checkGate?.passed === c?.experienceGrowth?.checkGate?.passed && hc?.userWeekStatus === c?.userWeekStatus, `http star=${hc?.points?.star} st=${hc?.userWeekStatus}`);

  // (6) 멱등 — 동일 act 재적립 2회 → 합 불변
  await accrueForCompletedIrregular(g1.id); await accrueForCompletedIrregular(g1.id);
  ck("[6] 동일 act 재적립 2회 → points 불변(중복 0)", (await pointsOf()) === expSum, `points=${await pointsOf()}`);

  // (3) operating + W13 → era_blocked (적립 레이어 직접 검증, write 0)
  try {
    const { data: opAct } = await sb.from("process_irregular_acts").insert({ organization_slug: "oranke", week_id: week.id, kind: "manual_grant", act_name: `${TAG} op`, applicant_admin_name: "op", target_user_id: null, scope_mode: "operating", point_a: PER, point_b: 0, point_c: 0, status: "completed", completed_at: new Date().toISOString(), scheduled_check_at: new Date().toISOString() }).select("id").single();
    const opId = (opAct as any).id;
    await sb.from("process_check_review_recipients").insert({ source: "irregular", ref_id: opId, organization_slug: "oranke", scope_mode: "operating", user_id: realUser, nickname: "op", match_type: "matched", match_reason: "manual" });
    const res: any = await accrueForCompletedIrregular(opId);
    const led = (await sb.from("process_point_awards").select("id", { count: "exact", head: true }).eq("source", "irregular").eq("ref_id", opId)).count ?? 0;
    ck("[3] operating+W13 → era_blocked · ledger 0(write 0)", res?.skipped === true && String(res?.reason).startsWith("era_blocked") && led === 0, `skipped=${res?.reason} led=${led}`);
    await sb.from("process_check_review_recipients").delete().eq("ref_id", opId);
    await sb.from("process_irregular_acts").delete().eq("id", opId);
  } catch (e) { ck("[3] operating+W13 차단", false, `직접삽입 실패: ${e instanceof Error ? e.message : String(e)}`); }

  // (2) test + W13 + 실사용자 → 422 · write 0
  const real = await api("/api/admin/processes/check/irregular", { method: "POST", body: J({ organization: "oranke", mode: "test", kind: "manual_grant", act_name: `${TAG} 실유저`, target_user_ids: [realUser], point_a: 10 }) });
  ck("[2] test+W13+실사용자 → 422", real.status === 422, `status=${real.status}`);

  // (9-flip) 회수 — 삭제 시 revoke → points 감소 → fail flip
  await api("/api/admin/processes/check/irregular", { method: "DELETE", body: J({ id: g2.id, organization: "oranke", mode: "test" }) });
  c = await w13Card();
  ck("[9a] grant2 삭제 → revoke → points=PER · fail flip", (await pointsOf()) === PER && c?.userWeekStatus === "fail", `points=${await pointsOf()} st=${c?.userWeekStatus}`);
  await api("/api/admin/processes/check/irregular", { method: "DELETE", body: J({ id: g1.id, organization: "oranke", mode: "test" }) });
  ck("[9b] grant1 삭제 → revoke → points 0", (await pointsOf()) === 0, `points=${await pointsOf()}`);

  // (9) cleanup 원복
  await cleanupLines();
  await sb.from("process_point_awards").delete().eq("user_id", user).eq("year", iso.y).eq("week_number", iso.w);
  for (const id of grants) { if (!id) continue; await sb.from("process_check_review_recipients").delete().eq("ref_id", id); await sb.from("process_irregular_acts").delete().eq("id", id); }
  if (origRow) await sb.from("user_weekly_points").update({ points: origRow.points, advantages: origRow.advantages, penalty: origRow.penalty, checks_migrated: origRow.checks_migrated }).eq("id", origRow.id);
  else await sb.from("user_weekly_points").delete().eq("user_id", user).eq("year", iso.y).eq("week_number", iso.w);
  if (origUws) await sb.from("user_week_statuses").update({ status: origUws.status }).eq("id", origUws.id);
  else await sb.from("user_week_statuses").delete().eq("user_id", user).eq("week_start_date", week.start_date);
  await recomputeAndStoreWeeklyCardsSnapshot(user);
  const { syncGradeStats } = await import("@/lib/cluster3ClubRankData");
  await syncGradeStats(user); // 등급 캐시 원복(복원된 points 기준)
  const ledgerLeft = (await sb.from("process_point_awards").select("id", { count: "exact", head: true }).eq("user_id", user).eq("year", iso.y).eq("week_number", iso.w)).count ?? 0;
  const uwpFinal = await pointsOf();
  ck("[9] cleanup — ledger 0 · user_weekly_points 원복", ledgerLeft === 0 && uwpFinal === (origRow?.points ?? 0), `ledger=${ledgerLeft} points=${uwpFinal}/${origRow?.points ?? "(none)"}`);

  console.log(`\n결과: ${pass} pass / ${fail} fail`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error("FATAL:", e?.stack ?? e); process.exit(1); });
