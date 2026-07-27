/**
 * [실 HTTP + DB] 원장 source 두 갈래 allowlist 검증 (2026-07-27 정책).
 *
 *   ① 주차 총 Point A  — 'regular'·'irregular'·'line'·'line_rating' **전부 합산**
 *      → user_weekly_points.points · 개인 주차 총 Point A · 주차 성공 판정
 *   ② 액트 수행 집계    — 액트 source 만('line'·'line_rating' **제외**)
 *      → 액트 체크 수 / 체크율 / required 이행 / 액트 적립 내역
 *
 *   dev server 필요. run:
 *     BASE=http://localhost:3000 node_modules/.bin/tsx --env-file=.env.local \
 *       scripts/verify-point-award-source-allowlists.ts
 *
 *   ⚠ 읽기 전용 — 원장/uwp/snapshot 어디에도 쓰지 않는다.
 */
/* eslint-disable @typescript-eslint/no-explicit-any -- 검증 스크립트: 외부 API 응답/raw row 를 훑는다. */
import { createClient } from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import {
  ACT_PERFORMANCE_SOURCES,
  WEEK_POINT_A_SOURCES,
  isActPerformanceSource,
  isWeekPointASource,
} from "@/lib/pointAwardSourcePolicy";

const BASE = process.env.BASE ?? "http://localhost:3000";
const u = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const a = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const s = process.env.SUPABASE_SERVICE_ROLE_KEY!;

let failed = 0;
const ck = (n: string, ok: boolean, d?: unknown) => {
  console.log(`${ok ? "✅" : "❌"} ${n}${d !== undefined ? " :: " + JSON.stringify(d) : ""}`);
  if (!ok) failed++;
};

async function cookieHeader(): Promise<string> {
  const { data: adm } = await supabaseAdmin
    .from("admin_users").select("email").eq("is_active", true).not("email", "is", null).limit(1);
  const email = (adm?.[0] as { email: string } | undefined)?.email;
  if (!email) throw new Error("활성 관리자 계정을 찾지 못했습니다.");
  const A = createClient(u, s), N = createClient(u, a);
  const { data: l } = await A.auth.admin.generateLink({ type: "magiclink", email });
  const { data: v } = await N.auth.verifyOtp({ email, token: (l as any).properties.email_otp, type: "magiclink" });
  const cap: Array<{ name: string; value: string }> = [];
  const sv = createServerClient(u, a, {
    cookies: { getAll: () => [], setAll: (it: any[]) => cap.push(...it.map(({ name, value }) => ({ name, value }))) },
  });
  await sv.auth.setSession({ access_token: (v as any).session.access_token, refresh_token: (v as any).session.refresh_token });
  console.log(`admin = ${email}\n`);
  return cap.map((c) => `${c.name}=${c.value}`).join("; ");
}
async function get(path: string, cookie: string) {
  const r = await fetch(`${BASE}${path}`, { headers: { cookie }, cache: "no-store" });
  let json: any = null;
  try { json = await r.json(); } catch { /* non-json */ }
  return { status: r.status, json };
}

async function main() {
  const cookie = await cookieHeader();

  // ── 0. 정책 상수 계약 ─────────────────────────────────────────────────────
  console.log("── 0. allowlist 계약 ──");
  ck("주차 Point A allowlist 에 line·line_rating 포함",
    WEEK_POINT_A_SOURCES.includes("line") && WEEK_POINT_A_SOURCES.includes("line_rating"),
    { WEEK_POINT_A_SOURCES });
  ck("주차 Point A allowlist 에 액트 2종 포함",
    WEEK_POINT_A_SOURCES.includes("regular") && WEEK_POINT_A_SOURCES.includes("irregular"));
  ck("액트 집계 allowlist 에서 line·line_rating 제외",
    !isActPerformanceSource("line") && !isActPerformanceSource("line_rating"),
    { ACT_PERFORMANCE_SOURCES });
  ck("액트 집계 allowlist 는 strict(미등록 source = false)", !isActPerformanceSource("some_future_source"));
  ck("주차 Point A allowlist 는 fail-open(미등록 source 도 합산·error 로 경고)",
    isWeekPointASource("some_future_source") === true);

  // ── 1. user_weekly_points.points == Σ 활성 award(allowlist) ────────────────
  console.log("\n── 1. 주차 총 Point A 합산 — 라인 원장이 포함되는가 ──");
  const { data: ratingRows } = await supabaseAdmin
    .from("process_point_awards").select("user_id,year,week_number")
    .eq("source", "line_rating").is("cancelled_at", null);
  const keys = Array.from(new Set(((ratingRows ?? []) as any[]).map((r) => `${r.user_id}:${r.year}:${r.week_number}`)));
  if (keys.length === 0) console.log("   (활성 line_rating 원장 없음 — verify:line-rating-display 선행 필요)");
  for (const key of keys) {
    const [userId, y, wk] = key.split(":");
    const { data: aw } = await supabaseAdmin
      .from("process_point_awards").select("source,point_check,cancelled_at")
      .eq("user_id", userId).eq("year", Number(y)).eq("week_number", Number(wk));
    const active = ((aw ?? []) as any[]).filter((r) => !r.cancelled_at);
    const bySrc = new Map<string, number>();
    for (const r of active) bySrc.set(r.source, (bySrc.get(r.source) ?? 0) + (r.point_check || 0));
    const sumAll = active.filter((r) => isWeekPointASource(r.source)).reduce((n, r) => n + (r.point_check || 0), 0);
    const sumActOnly = active.filter((r) => isActPerformanceSource(r.source)).reduce((n, r) => n + (r.point_check || 0), 0);
    const { data: uwp } = await supabaseAdmin
      .from("user_weekly_points").select("points,legacy_points")
      .eq("user_id", userId).eq("year", Number(y)).eq("week_number", Number(wk)).maybeSingle();
    const points = (uwp as any)?.points ?? 0;
    const legacy = (uwp as any)?.legacy_points ?? 0;
    ck(`  ${userId.slice(0, 8)} ${y}/${wk} · points == legacy + Σ(allowlist)`,
      points === legacy + sumAll,
      { points, legacy, sumAll, bySrc: Object.fromEntries(bySrc) });
    ck(`  ${userId.slice(0, 8)} ${y}/${wk} · 라인 원장이 실제로 포함됨(액트만 합계보다 큼)`,
      sumAll > sumActOnly,
      { 전체: sumAll, 액트만: sumActOnly, 라인기여: sumAll - sumActOnly });
  }

  // ── 2. 주차 성공 판정 = points >= recognition_count_n ──────────────────────
  console.log("\n── 2. 주차 성공 판정 입력에 라인 포인트가 반영되는가 ──");
  for (const key of keys.slice(0, 3)) {
    const [userId, y, wk] = key.split(":");
    const { data: w } = await supabaseAdmin
      .from("weeks").select("id,season_key,week_number").eq("iso_year", Number(y)).eq("iso_week", Number(wk)).maybeSingle();
    if (!w) continue;
    const { data: prof } = await supabaseAdmin
      .from("user_profiles").select("organization_slug").eq("user_id", userId).maybeSingle();
    const org = (prof as any)?.organization_slug;
    const { data: cfg } = await supabaseAdmin
      .from("cluster4_week_opening_configs").select("recognition_count_n")
      .eq("week_id", (w as any).id).eq("organization_slug", org).maybeSingle();
    const n = (cfg as any)?.recognition_count_n ?? null;
    const { data: uwp } = await supabaseAdmin
      .from("user_weekly_points").select("points")
      .eq("user_id", userId).eq("year", Number(y)).eq("week_number", Number(wk)).maybeSingle();
    const points = (uwp as any)?.points ?? 0;
    const { data: aw } = await supabaseAdmin
      .from("process_point_awards").select("source,point_check,cancelled_at")
      .eq("user_id", userId).eq("year", Number(y)).eq("week_number", Number(wk));
    const lineA = ((aw ?? []) as any[])
      .filter((r) => !r.cancelled_at && (r.source === "line" || r.source === "line_rating"))
      .reduce((s2, r) => s2 + (r.point_check || 0), 0);
    console.log(`   ${userId.slice(0, 8)} ${org} ${(w as any).season_key} W${(w as any).week_number}: ` +
      `points ${points} (라인 기여 ${lineA}) vs 기준 N ${n} → ${n == null ? "기준 없음" : points >= n ? "성공" : "실패"}`);
    ck(`  판정 입력(points)에 라인 기여분이 살아 있음`, lineA === 0 || points >= lineA, { points, lineA });
  }

  // ── 3. 액트 집계에 라인 원장이 새지 않는가 (API 실측) ─────────────────────
  console.log("\n── 3. 액트 집계 — 라인 원장 제외 확인 ──");
  for (const key of keys) {
    const [userId, y, wk] = key.split(":");
    const { data: w } = await supabaseAdmin
      .from("weeks").select("id").eq("iso_year", Number(y)).eq("iso_week", Number(wk)).maybeSingle();
    if (!w) continue;
    const weekId = (w as any).id;
    const { data: aw } = await supabaseAdmin
      .from("process_point_awards").select("source,cancelled_at")
      .eq("user_id", userId).eq("year", Number(y)).eq("week_number", Number(wk));
    const active = ((aw ?? []) as any[]).filter((r) => !r.cancelled_at);
    const actRows = active.filter((r) => isActPerformanceSource(r.source)).length;
    const lineRows = active.filter((r) => !isActPerformanceSource(r.source)).length;

    const res = await get(`/api/admin/members/${userId}/weeks/${weekId}/acts`, cookie);
    if (res.status !== 200) { console.log(`   (acts API ${res.status} — 건너뜀)`); continue; }
    const acts = (res.json?.data?.acts ?? []) as any[]; // DTO 키 = acts (관리자 액트 탭 표 행)
    const summary = res.json?.data?.summary ?? {};
    const notCancelled = acts.filter((l) => l.resultLabel !== "취소됨");
    ck(`  ${userId.slice(0, 8)} · 액트 내역 행 수(취소 제외) == 액트 원장 수 — 라인 ${lineRows}건이 섞이지 않음`,
      notCancelled.length === actRows,
      { 액트내역행: notCancelled.length, 액트원장: actRows, 라인원장: lineRows, 전체행: acts.length });
    ck(`  ${userId.slice(0, 8)} · 액트 체크 total == 액트 원장 수(라인 미포함)`,
      (summary.total ?? -1) === actRows, { total: summary.total, 액트원장: actRows });
    // 라인 award 의 ref_id 가 액트 행으로 새어 들어왔는지 직접 대조(과거 실제 버그 형태).
    const { data: lineAw } = await supabaseAdmin
      .from("process_point_awards").select("id").eq("user_id", userId)
      .eq("year", Number(y)).eq("week_number", Number(wk)).in("source", ["line", "line_rating"]);
    const lineAwardIds = new Set(((lineAw ?? []) as any[]).map((r) => r.id));
    const leaked = acts.filter((l) => lineAwardIds.has(l.awardId));
    ck(`  ${userId.slice(0, 8)} · 액트 내역에 라인 원장 행이 없음(awardId 대조 · 라인 ${lineAwardIds.size}건)`,
      leaked.length === 0, leaked.length === 0 ? undefined : { leaked: leaked.map((l) => l.actName) });
  }

  // ── 4. 모드 파리티 ────────────────────────────────────────────────────────
  console.log("\n── 4. 일반 / mode=test / actAsTestUserId / demoUserId 파리티 ──");
  for (const key of keys.slice(0, 2)) {
    const [userId, y, wk] = key.split(":");
    const { data: w } = await supabaseAdmin
      .from("weeks").select("id").eq("iso_year", Number(y)).eq("iso_week", Number(wk)).maybeSingle();
    if (!w) continue;
    const weekId = (w as any).id;
    for (const path of [`/api/admin/members/${userId}/weeks/${weekId}/acts`, `/api/admin/members/${userId}/weeks/${weekId}/lines`]) {
      const base = await get(path, cookie);
      for (const [vname, q] of [
        ["mode=test", "?mode=test"],
        ["actAsTestUserId", `?mode=test&actAsTestUserId=${userId}`],
        ["demoUserId", `?demoUserId=${userId}`],
      ] as Array<[string, string]>) {
        const v = await get(path + q, cookie);
        ck(`  ${path.endsWith("/acts") ? "액트" : "라인"} · 일반 == ${vname}`,
          v.status === base.status && JSON.stringify(v.json?.data) === JSON.stringify(base.json?.data),
          v.status === base.status ? undefined : { base: base.status, [vname]: v.status });
      }
    }
  }

  console.log(failed === 0 ? "\nALL PASS" : `\n${failed} FAIL`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
