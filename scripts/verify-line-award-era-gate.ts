/**
 * [실 DB + HTTP] 라인 원장 era 게이트 검증 (2026-07-27).
 *
 *   BASE=http://localhost:3000 npx tsx --env-file=.env.local \
 *     scripts/verify-line-award-era-gate.ts
 *
 * 정책:
 *   · 적립 허용 era(operating: weeks.start_date >= CLUSTER4_SLOT_POLICY_EFFECTIVE_FROM) 이전
 *     레거시/PMS 주차에는 'line'·'line_rating' 원장을 **신규 생성하지 않는다**.
 *   · 기존 레거시 원장은 이 게이트 때문에 **자동 회수·삭제되지 않는다**(전체 no-op).
 *   · 호출 경로(관리자 저장·공표·48h 스윕·고아 재정합) 무관 — 공통 함수 한 곳에서 막는다.
 *   · 모드(일반/mode=test/actAsTestUserId/demoUserId)는 era 판정에 관여하지 않는다.
 *
 * ⚠ 쓰기: era **밖** 주차에 대해서만 reconcile 을 호출한다 — 게이트가 정상이면 write 0.
 *   게이트가 없다면 원장이 생겨 즉시 실패로 드러난다(그 경우 스크립트가 생성분을 보고한다).
 *   era **안** 주차는 QA 라인에 한해 멱등 재호출(같은 판정·같은 값)만 한다.
 */
/* eslint-disable @typescript-eslint/no-explicit-any -- 검증 스크립트 */
import { createClient } from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import {
  reconcileLineResultAwardForUser,
  isAccrualAllowedWeek,
} from "@/lib/processPointAccrual";
import { CLUSTER4_SLOT_POLICY_EFFECTIVE_FROM } from "@/lib/lineAvailability";

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
  console.log(`admin = ${email}`);
  return cap.map((c) => `${c.name}=${c.value}`).join("; ");
}
async function get(path: string, cookie: string) {
  const r = await fetch(`${BASE}${path}`, { headers: { cookie }, cache: "no-store" });
  let json: any = null;
  try { json = await r.json(); } catch { /* non-json */ }
  return { status: r.status, json };
}

async function awardsFor(userId: string, lineId: string) {
  const { data } = await supabaseAdmin
    .from("process_point_awards")
    .select("source,point_check,point_advantage,cancelled_at")
    .eq("user_id", userId).eq("ref_id", lineId).in("source", ["line", "line_rating"]);
  return ((data ?? []) as any[]).map((r) => `${r.source}:${r.point_check}/${r.point_advantage}:${r.cancelled_at ? "cancelled" : "active"}`).sort();
}

async function main() {
  const cookie = await cookieHeader();
  console.log(`era 경계: weeks.start_date >= ${CLUSTER4_SLOT_POLICY_EFFECTIVE_FROM}\n`);

  // ── 0. 순수 판정 — 경계 전후 ─────────────────────────────────────────────
  const { data: wkAll } = await supabaseAdmin
    .from("weeks").select("id,season_key,week_number,start_date,iso_year,iso_week").order("start_date");
  const weeks = ((wkAll ?? []) as any[]).filter((w) => w.start_date);
  const before = weeks.filter((w) => w.start_date < CLUSTER4_SLOT_POLICY_EFFECTIVE_FROM);
  const after = weeks.filter((w) => w.start_date >= CLUSTER4_SLOT_POLICY_EFFECTIVE_FROM);
  const lastBefore = before[before.length - 1];
  const firstAfter = after[0];
  console.log("── 0. era 경계 판정(순수 함수) ──");
  console.log(`  경계 직전: ${lastBefore?.season_key} W${lastBefore?.week_number} (${lastBefore?.start_date})`);
  console.log(`  경계 첫 주: ${firstAfter?.season_key} W${firstAfter?.week_number} (${firstAfter?.start_date})`);
  for (const mode of ["operating", "test"] as const) {
    ck(`  [${mode}] 경계 직전 주차 = 적립 불가`, !isAccrualAllowedWeek(mode, lastBefore));
    ck(`  [${mode}] 경계 첫 주차 = 적립 허용`, isAccrualAllowedWeek(mode, firstAfter));
  }
  ck("  operating 과 test 가 동일 경계(예외 폐지 확인)",
    before.every((w) => isAccrualAllowedWeek("operating", w) === isAccrualAllowedWeek("test", w)) &&
    after.every((w) => isAccrualAllowedWeek("operating", w) === isAccrualAllowedWeek("test", w)));

  // ── 1. era 밖 주차에 reconcile 호출 → 원장 무변화 ────────────────────────
  console.log("\n── 1. era 밖(레거시) 주차 — 공통 reconcile 호출해도 원장 무변화 ──");
  const beforeIds = new Set(before.map((w) => w.id));
  const { data: tgtData } = await supabaseAdmin
    .from("cluster4_line_targets").select("id,line_id,week_id,target_user_id")
    .eq("target_mode", "user").not("target_user_id", "is", null).limit(1000);
  const legacyTargets = ((tgtData ?? []) as any[]).filter((t) => beforeIds.has(t.week_id));
  if (legacyTargets.length === 0) console.log("   (레거시 주차 대상자 없음 — 건너뜀)");

  const { count: totalBefore } = await supabaseAdmin
    .from("process_point_awards").select("id", { count: "exact", head: true }).in("source", ["line", "line_rating"]);

  let tested = 0;
  for (const t of legacyTargets.slice(0, 12)) {
    const w = weeks.find((x) => x.id === t.week_id);
    const snapBefore = await awardsFor(t.target_user_id, t.line_id);
    // 성공/실패 양방향 모두 호출 — 생성도 회수도 일어나선 안 된다.
    await reconcileLineResultAwardForUser(t.target_user_id, t.line_id, t.week_id, true, null);
    await reconcileLineResultAwardForUser(t.target_user_id, t.line_id, t.week_id, false, null);
    const snapAfter = await awardsFor(t.target_user_id, t.line_id);
    tested++;
    ck(`  ${w?.season_key} W${w?.week_number} (${w?.start_date}) · 원장 불변(생성·회수 모두 없음)`,
      JSON.stringify(snapBefore) === JSON.stringify(snapAfter),
      JSON.stringify(snapBefore) === JSON.stringify(snapAfter) ? { 기존: snapBefore.length } : { before: snapBefore, after: snapAfter });
  }
  const { count: totalAfter } = await supabaseAdmin
    .from("process_point_awards").select("id", { count: "exact", head: true }).in("source", ["line", "line_rating"]);
  ck(`  라인 원장 총행 불변 (${tested}건 호출 후)`, totalBefore === totalAfter, { before: totalBefore, after: totalAfter });

  // ── 2. 기존 레거시 원장은 회수되지 않는다 ────────────────────────────────
  console.log("\n── 2. 기존 레거시 원장 보존(자동 회수·삭제 없음) ──");
  const { data: legacyAw } = await supabaseAdmin
    .from("process_point_awards").select("ref_id,user_id,year,week_number,source,point_check,cancelled_at")
    .in("source", ["line", "line_rating"]);
  const legacyRows = ((legacyAw ?? []) as any[]).filter((r) => {
    const w = weeks.find((x) => x.iso_year === r.year && x.iso_week === r.week_number);
    return w != null && w.start_date < CLUSTER4_SLOT_POLICY_EFFECTIVE_FROM;
  });
  if (legacyRows.length === 0) {
    console.log("   (era 밖 라인 원장 0건 — 보존 대상 없음)");
  } else {
    console.log(`   era 밖 라인 원장 ${legacyRows.length}건 발견 — 정리는 별도 승인 사항(이번 수정으로 건드리지 않음)`);
    for (const r of legacyRows.slice(0, 5)) {
      const snap1 = await awardsFor(r.user_id, r.ref_id);
      const w = weeks.find((x) => x.iso_year === r.year && x.iso_week === r.week_number);
      await reconcileLineResultAwardForUser(r.user_id, r.ref_id, w!.id, false, null);
      const snap2 = await awardsFor(r.user_id, r.ref_id);
      ck(`  ${w?.season_key} W${w?.week_number} · isSuccess=false 호출해도 기존 원장 보존`,
        JSON.stringify(snap1) === JSON.stringify(snap2), { before: snap1, after: snap2 });
    }
  }

  // ── 3. era 안 주차는 정상 동작(멱등) ─────────────────────────────────────
  console.log("\n── 3. era 안 주차 — 정상 정합 + 멱등 ──");
  const { data: ratingAw } = await supabaseAdmin
    .from("process_point_awards").select("ref_id,user_id,year,week_number")
    .eq("source", "line_rating").is("cancelled_at", null).limit(4);
  for (const r of ((ratingAw ?? []) as any[])) {
    const w = weeks.find((x) => x.iso_year === r.year && x.iso_week === r.week_number);
    if (!w) continue;
    const snap1 = await awardsFor(r.user_id, r.ref_id);
    await reconcileLineResultAwardForUser(r.user_id, r.ref_id, w.id, true, null);
    await reconcileLineResultAwardForUser(r.user_id, r.ref_id, w.id, true, null);
    const snap2 = await awardsFor(r.user_id, r.ref_id);
    ck(`  ${w.season_key} W${w.week_number} (${w.start_date}) · era 안 → 정합 유지·멱등`,
      JSON.stringify(snap1) === JSON.stringify(snap2), { snapshot: snap1 });
  }

  // ── 4. 모드 무관 — 화면 DTO 가 era 판정에 영향받지 않음 ──────────────────
  console.log("\n── 4. 일반 / mode=test / actAsTestUserId / demoUserId 파리티 ──");
  const sample = ((ratingAw ?? []) as any[])[0];
  if (sample) {
    const w = weeks.find((x) => x.iso_year === sample.year && x.iso_week === sample.week_number);
    if (w) {
      for (const p of [
        `/api/admin/members/${sample.user_id}/weeks/${w.id}/lines`,
        `/api/admin/members/${sample.user_id}/weeks/${w.id}/acts`,
      ]) {
        const base = await get(p, cookie);
        for (const [vn, q] of [
          ["mode=test", "?mode=test"],
          ["actAsTestUserId", `?mode=test&actAsTestUserId=${sample.user_id}`],
          ["demoUserId", `?demoUserId=${sample.user_id}`],
        ] as Array<[string, string]>) {
          const v = await get(p + q, cookie);
          ck(`  ${p.endsWith("/lines") ? "라인" : "액트"} · 일반 == ${vn}`,
            v.status === base.status && JSON.stringify(v.json?.data) === JSON.stringify(base.json?.data));
        }
      }
    }
  }

  console.log(failed === 0 ? "\nALL PASS" : `\n${failed} FAIL`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
