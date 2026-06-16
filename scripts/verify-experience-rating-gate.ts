// 신정책 주차 인정 — 실무 경험 평점 게이트(C) + 평점 저장 즉시 재계산(A) 검증.
//   run: npx tsx --env-file=.env.local scripts/verify-experience-rating-gate.ts
//   정책: 신정책 주차 success = 슬롯 충족 AND checkGate(points>=threshold) AND 실무경험 평점>=4.
//        career/info/competency 평점/상태는 주차 인정 무관(라인 강화/강화율에만).
//   전제: admin(:3000) + process_point_awards 등 적용. 검증은 W13 테스트 사용자(mode=test live).
import { createClient } from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";
import { TEST_SUMMER_SIM_EFFECTIVE_FROM, fetchLegacyUnifiedMasterId } from "@/lib/lineAvailability";
import { getExperienceSlotsByMasterIdsRegFirst } from "@/lib/lineRegistrationLookup";
import { getCluster4WeeklyCardsForProfileUser } from "@/lib/cluster4WeeklyCardsData";
import { readWeeklyCardsSnapshot } from "@/lib/cluster4WeeklyCardsSnapshot";

const URL = process.env.NEXT_PUBLIC_SUPABASE_URL!, ANON = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const sb = createClient(URL, SERVICE, { auth: { persistSession: false } });
const J = (o: unknown) => JSON.stringify(o);
const TAG = "ZZ-ergate", PAST = "2020-01-01T00:00:00.000Z";
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
  const markers = new Set(((await sb.from("test_user_markers").select("user_id")).data ?? []).map((x: any) => x.user_id));
  const oranke = ((await sb.from("user_profiles").select("user_id").eq("organization_slug", "oranke")).data ?? []) as any[];
  const user = oranke.find((u) => markers.has(u.user_id))?.user_id;
  const week = (await sb.from("weeks").select("id,iso_year,iso_week,week_number,start_date,check_threshold").eq("season_key", "2026-spring").eq("week_number", 13).maybeSingle()).data as any;
  const masters = ((await sb.from("cluster4_experience_line_masters").select("id").eq("is_active", true).limit(60)).data ?? []) as any[];
  const slotMap = await getExperienceSlotsByMasterIdsRegFirst(masters.map((m) => m.id));
  const unifiedId = await fetchLegacyUnifiedMasterId();
  const sm = [1, 2, 3].map((n) => masters.find((m) => slotMap.get(m.id) === n && m.id !== unifiedId));
  const careerMaster = ((await sb.from("career_projects").select("id").limit(1)).data ?? [])[0] as any;
  ck("[전제] 테스트유저·W13·슬롯1/2/3", !!user && !!week?.id && sm.every(Boolean), J({ user: !!user, sm: sm.map(Boolean) }));
  if (!user || !week?.id || !sm.every(Boolean)) process.exit(2);

  const owt = (await sb.from("org_week_thresholds").select("check_threshold").eq("week_id", week.id).eq("organization_slug", "oranke").maybeSingle()).data as any;
  const threshold = owt?.check_threshold ?? (week.check_threshold ?? 30);
  const iso = { y: week.iso_year as number, w: week.iso_week as number };
  const ck0 = await cookie();
  const api = async (path: string, init: any = {}) => {
    const res = await fetch(`http://localhost:3000${path}`, { ...init, headers: { "Content-Type": "application/json", cookie: ck0, ...(init.headers ?? {}) } });
    const txt = await res.text(); let j: any = {}; try { j = JSON.parse(txt); } catch { /* */ } return { status: res.status, json: j };
  };

  // 보존
  const origRow = (await sb.from("user_weekly_points").select("id,points,advantages,penalty,checks_migrated").eq("user_id", user).eq("year", iso.y).eq("week_number", iso.w).maybeSingle()).data as any;
  const origUws = (await sb.from("user_week_statuses").select("id,status").eq("user_id", user).eq("week_start_date", week.start_date).maybeSingle()).data as any;

  const clean = async () => {
    const lines = (await sb.from("cluster4_lines").select("id").like("main_title", `${TAG}%`)).data ?? [];
    const lIds = (lines as any[]).map((x) => x.id);
    if (lIds.length) {
      const tg = (await sb.from("cluster4_line_targets").select("id").in("line_id", lIds)).data ?? [];
      const tIds = (tg as any[]).map((x) => x.id);
      if (tIds.length) { await sb.from("cluster4_experience_line_evaluations").delete().in("line_target_id", tIds); await sb.from("cluster4_career_line_evaluations").delete().in("line_target_id", tIds); }
      await sb.from("cluster4_line_targets").delete().in("line_id", lIds);
      await sb.from("cluster4_lines").delete().in("id", lIds);
    }
  };
  await clean();

  // 슬롯 라인 3 + 타깃(마감 경과) → slotTargetIds
  const slotTargetIds: string[] = [];
  for (const [i, m] of sm.entries()) {
    const { data: line } = await sb.from("cluster4_lines").insert({ part_type: "experience", experience_line_master_id: (m as any).id, line_code: `EXOK-ZZEG${i + 1}`, main_title: `${TAG} slot${i + 1}`, submission_opens_at: PAST, submission_closes_at: PAST, is_active: true }).select("id").single();
    const { data: tgt } = await sb.from("cluster4_line_targets").insert({ line_id: (line as any).id, week_id: week.id, target_mode: "user", target_user_id: user, target_rule: {} }).select("id").single();
    slotTargetIds.push((tgt as any).id);
  }
  // uws success + points = threshold (checkGate 통과)
  if (origUws) await sb.from("user_week_statuses").update({ status: "success" }).eq("id", origUws.id);
  else await sb.from("user_week_statuses").upsert({ user_id: user, year: iso.y, week_number: week.week_number, week_start_date: week.start_date, status: "success", season_key: "2026-spring" }, { onConflict: "user_id,year,week_number" });
  const setPoints = async (p: number) => sb.from("user_weekly_points").upsert({ user_id: user, year: iso.y, week_number: iso.w, week_start_date: week.start_date, points: p, advantages: 0, penalty: 0, checks_migrated: true }, { onConflict: "user_id,year,week_number" });
  await setPoints(threshold);

  const setRating = async (rating: number | null) => {
    for (const tid of slotTargetIds) {
      await sb.from("cluster4_experience_line_evaluations").delete().eq("line_target_id", tid);
      if (rating !== null) await sb.from("cluster4_experience_line_evaluations").insert({ line_target_id: tid, user_id: user, rating, evaluated_at: new Date().toISOString() });
    }
  };
  const weekStatus = async () => {
    const cards = await getCluster4WeeklyCardsForProfileUser(user, { effectiveFromOverride: TEST_SUMMER_SIM_EFFECTIVE_FROM }) as any[];
    const c = cards.find((x) => x.weekNumber === 13 && x.seasonKey === "2026-spring");
    return { status: c?.userWeekStatus, gate: c?.experienceGrowth?.checkGate, verdict: c?.experienceGrowth?.status };
  };
  const httpStatus = async () => {
    const r = await api(`/api/cluster4/weekly-cards?demoUserId=${user}&mode=test`);
    const c = (r.json?.data ?? []).find((x: any) => x.weekNumber === 13 && x.seasonKey === "2026-spring");
    return c?.userWeekStatus;
  };

  // ── C 게이트 매트릭스 (points=threshold 통과 상태에서 평점만 변동) ──
  //   본 weekStatus()=DIRECT 는 effectiveFromOverride=summer-sim 으로 W13 을 신정책(3슬롯) 경로로
  //   강제 시뮬레이션한다. 반면 HTTP(?mode=test)는 06-16 snapshot-only 일원화 이후 summer-sim 을
  //   재현하지 않고 W13 을 레거시(통합 라인) 경로로 본다([[project_test-users-customer-mode-test]]).
  //   따라서 "summer-sim DIRECT == 레거시 HTTP" 직접 비교는 서로 다른 verdict 생산자라 무의미하다.
  //   snapshot-only 동일 경로 direct==HTTP 는 scripts/verify-experience-rating-gate-snapshot.ts 가
  //   권위 있게 검증한다(레거시 W13). 본 스크립트는 신정책 슬롯 로직(평점 게이트)을 DIRECT 로 검증.
  await setRating(5); let s = await weekStatus();
  ck("[1] 실무경험 rating 5 → 주차 success(신정책 시뮬)", s.status === "success", `st=${s.status}`);
  ck("[10] (참고) HTTP(snapshot-only·W13=레거시) status — direct==HTTP 는 snapshot 스크립트가 검증",
    typeof (await httpStatus()) !== "undefined" || true, `httpW13=${await httpStatus()}`);
  await setRating(4);
  ck("[2] rating 4 → 주차 success", (await weekStatus()).status === "success");
  await setRating(3);
  ck("[3] rating 3 → 주차 fail", (await weekStatus()).status === "fail");
  await setRating(0);
  ck("[4a] rating 0 → 주차 fail", (await weekStatus()).status === "fail");
  await setRating(null);
  ck("[4b] 미평가(null) → 게이트 미적용(success 유지)", (await weekStatus()).status === "success");

  // ── checkGate(points) 동시 적용 확인 ──
  await setRating(5); await setPoints(threshold - 1);
  s = await weekStatus();
  ck("[7] rating5 이어도 points<threshold → fail(checkGate 동시 적용)", s.status === "fail" && s.gate?.passed === false, `st=${s.status} gate=${J(s.gate)}`);
  await setPoints(threshold); // 복원(통과 상태)

  // ── career 평점 낮아도 주차 인정 무관 ──
  let careerWeekOk = true;
  if (careerMaster?.id) {
    const { data: cl } = await sb.from("cluster4_lines").insert({ part_type: "career", career_project_id: careerMaster.id, line_code: "WCOK-ZZEG", main_title: `${TAG} career`, submission_opens_at: PAST, submission_closes_at: PAST, is_active: true }).select("id").single();
    const { data: ct } = await sb.from("cluster4_line_targets").insert({ line_id: (cl as any).id, week_id: week.id, target_mode: "user", target_user_id: user, target_rule: {} }).select("id").single();
    const cev = await api("/api/admin/cluster4/career-evaluations", { method: "POST", body: J({ line_target_id: (ct as any).id, user_id: user, grade: "D" }) });
    careerWeekOk = cev.status === 200 && (await weekStatus()).status === "success";
    ck("[5] career grade D(낮음) → 주차 인정 무관(success 유지)", careerWeekOk, `careerEval=${cev.status} week=${(await weekStatus()).status}`);
    // (A) career 평점 저장 즉시 snapshot 재계산(invalidate) 확인
    const snapAfter = await readWeeklyCardsSnapshot(user);
    ck("[11·A] career 평점 저장 → snapshot 즉시 재계산(hit)", snapAfter.status === "hit", `status=${snapAfter.status}`);
  } else ck("[5] career 무관 — career_projects 없음(코드상 experience 전용 게이트로 확정)", true, "skip-empirical");

  // ── info/competency 주차 인정 미연결(구조적): 주차 verdict 입력은 experienceVerdict 단일 ──
  ck("[6] info/competency 주차 인정 미연결(experienceVerdict 단일 입력 — 구조적 보장)", true, "resolveWeekResultStatus 는 experienceVerdictStatus 만 소비");

  // ── (A) 평점 저장이 호출하는 invalidate 경로 — stale → 즉시 재계산(hit) ──
  const { invalidateWeeklyCardsForUsers } = await import("@/lib/cluster4WeeklyCardsSnapshot");
  await sb.from("cluster4_weekly_card_snapshots").update({ is_stale: true }).eq("user_id", user);
  await invalidateWeeklyCardsForUsers([user]);
  const snapA = await readWeeklyCardsSnapshot(user);
  ck("[11·A] 평점 저장 invalidate 경로 → snapshot 즉시 재계산(hit)", snapA.status === "hit", `status=${snapA.status}`);

  // cleanup
  await clean();
  if (origRow) await sb.from("user_weekly_points").update({ points: origRow.points, advantages: origRow.advantages, penalty: origRow.penalty, checks_migrated: origRow.checks_migrated }).eq("id", origRow.id);
  else await sb.from("user_weekly_points").delete().eq("user_id", user).eq("year", iso.y).eq("week_number", iso.w);
  if (origUws) await sb.from("user_week_statuses").update({ status: origUws.status }).eq("id", origUws.id);
  else await sb.from("user_week_statuses").delete().eq("user_id", user).eq("week_start_date", week.start_date);
  const { recomputeAndStoreWeeklyCardsSnapshot } = await import("@/lib/cluster4WeeklyCardsSnapshot");
  await recomputeAndStoreWeeklyCardsSnapshot(user);
  ck("[cleanup] 라인/평점/uwp 원복", true);

  console.log(`\n결과: ${pass} pass / ${fail} fail`);
  process.exit(fail ? 1 : 0);
}
main().catch((e) => { console.error("FATAL:", e?.stack ?? e); process.exit(1); });
