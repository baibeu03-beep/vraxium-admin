/**
 * 실무 경험 평점 Point A 소급 적립(backfill) — dry-run 기본 / --apply 시에만 write.
 *
 *   dry-run : npx tsx --env-file=.env.local scripts/backfill-line-rating-awards.ts
 *   적용    : npx tsx --env-file=.env.local scripts/backfill-line-rating-awards.ts --apply
 *   옵션    : --org=<slug>  --week=<season_key:week_number>  (범위 축소)
 *             --include-qa  (기본은 운영 scope 만 — QA 테스트 라인 제외)
 *
 * 정책(2026-07-27): 강화 성공 + 대상자 + experience(도출·분석·견문·관리) + 평가 완료 + rating>=4
 *   → 평점을 그대로 Point A 로 적립(원장 source='line_rating').
 *
 * ── 쓰기 방식 ───────────────────────────────────────────────────────────────
 *   **공통 reconcile 함수만 사용한다**: reconcileLineResultAwardForUser(원장 정합) →
 *   recomputeWeeklyPointsForUsers(uwp 재합산). 원장 직접 INSERT/UPDATE 나
 *   user_weekly_points 직접 UPDATE 는 **하지 않는다** — 운영 경로(관리자 저장/공표/48h 스윕)와
 *   완전히 같은 코드를 타야 결과가 갈리지 않고 멱등성도 그대로 보장된다.
 *   강화 성공 여부는 **재판정하지 않는다** — resolveCrewWeekCard 의 enhancementStatus 를 그대로 쓴다.
 *
 * ── 건드리지 않는 것 ────────────────────────────────────────────────────────
 *   공표 snapshot(cluster4_week_finalize_run_*) · user_week_statuses(주차 성공/실패) ·
 *   recognition_count_n · 라인 강화 상태 · 평점 원본 · 재공표.
 *   ⚠ uwp.points 는 reconcile 의 정상 결과로 **변한다**(평점 Point A 가 총점에 포함되는 정책).
 *     주차 성공/실패 재판정(uws)은 이 스크립트가 하지 않는다 — 별도 승인·별도 경로.
 */
/* eslint-disable @typescript-eslint/no-explicit-any -- 백필 스크립트: raw row 를 직접 훑는다. */
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { resolveCrewWeekCard } from "@/lib/adminCrewWeekDetail";
import {
  reconcileLineResultAwardForUser,
  recomputeWeeklyPointsForUsers,
  experienceCategoryToConfigKey,
} from "@/lib/processPointAccrual";
import {
  EXPERIENCE_RATING_AWARD_MIN_RATING,
  isRatingAwardExperienceType,
} from "@/lib/experienceRatingPolicy";
import { isAccrualAllowedWeek } from "@/lib/processPointAccrual";
import { mapWithConcurrency } from "@/lib/concurrency";

const APPLY = process.argv.includes("--apply");
const INCLUDE_QA = process.argv.includes("--include-qa");
const ORG_FILTER = process.argv.find((x) => x.startsWith("--org="))?.slice(6) ?? null;
const WEEK_FILTER = process.argv.find((x) => x.startsWith("--week="))?.slice(7) ?? null;

const pad = (v: unknown, n: number) => String(v ?? "").padEnd(n);
const padS = (v: unknown, n: number) => String(v ?? "").padStart(n);
const EXP_LABEL: Record<string, string> = {
  derive: "도출", analysis: "분석", research: "견문", management: "관리", expansion: "확장",
};

type Plan = {
  org: string; weekLabel: string; weekId: string; isoYear: number; isoWeek: number;
  userId: string; userName: string; lineId: string; cat: string;
  rating: number; enhancement: string;
  existingRatingA: number | null; // 활성 원장(없으면 null)
  desiredRatingA: number; // 0 = 회수/미지급
  action: "create" | "update" | "revoke" | "noop";
  isQaLine: boolean;
};

async function main() {
  console.log(APPLY ? "▶ APPLY 모드 — DB 를 씁니다.\n" : "▶ DRY-RUN — DB write 0.\n");
  console.log(`범위: ${ORG_FILTER ?? "전 조직"} / ${WEEK_FILTER ?? "전 주차"} / QA 라인 ${INCLUDE_QA ? "포함" : "제외(운영만)"}\n`);

  // ── 대상 후보 = experience 라인 대상자(target_mode='user') 전량 ─────────────
  const { data: lineData } = await supabaseAdmin
    .from("cluster4_lines")
    .select("id,experience_line_master_id,is_qa_test")
    .eq("part_type", "experience").eq("is_active", true);
  const lines = ((lineData ?? []) as any[]).filter((l) => INCLUDE_QA || l.is_qa_test !== true);
  if (lines.length === 0) { console.log("대상 라인 없음."); return; }
  const lineById = new Map(lines.map((l) => [l.id, l]));

  const { data: masterData } = await supabaseAdmin
    .from("cluster4_experience_line_masters").select("id,experience_category");
  const catByMaster = new Map(((masterData ?? []) as any[]).map((m) => [m.id, m.experience_category]));

  const tgts: any[] = [];
  const lineIds = lines.map((l) => l.id);
  for (let i = 0; i < lineIds.length; i += 60) {
    const { data } = await supabaseAdmin
      .from("cluster4_line_targets").select("id,line_id,week_id,target_user_id")
      .in("line_id", lineIds.slice(i, i + 60)).eq("target_mode", "user").not("target_user_id", "is", null);
    tgts.push(...((data ?? []) as any[]));
  }
  if (tgts.length === 0) { console.log("대상자 없음."); return; }

  const { data: wkData } = await supabaseAdmin
    .from("weeks").select("id,season_key,week_number,iso_year,iso_week,start_date");
  const W = new Map(((wkData ?? []) as any[]).map((w) => [w.id, w]));

  const uids = Array.from(new Set(tgts.map((t) => t.target_user_id)));
  const profs: any[] = [];
  for (let i = 0; i < uids.length; i += 60) {
    const { data } = await supabaseAdmin
      .from("user_profiles").select("user_id,display_name,organization_slug").in("user_id", uids.slice(i, i + 60));
    profs.push(...((data ?? []) as any[]));
  }
  const P = new Map(profs.map((p) => [p.user_id, p]));

  // 평가행
  const evs: any[] = [];
  const tgtIds = tgts.map((t) => t.id);
  for (let i = 0; i < tgtIds.length; i += 60) {
    const { data } = await supabaseAdmin
      .from("cluster4_experience_line_evaluations").select("line_target_id,user_id,rating,evaluated_by")
      .in("line_target_id", tgtIds.slice(i, i + 60));
    evs.push(...((data ?? []) as any[]));
  }
  const E = new Map(evs.map((e) => [`${e.line_target_id}:${e.user_id}`, e]));

  // 기존 line_rating 원장(활성/취소 구분)
  const { data: awData } = await supabaseAdmin
    .from("process_point_awards").select("ref_id,user_id,point_check,cancelled_at").eq("source", "line_rating");
  const AW = new Map(((awData ?? []) as any[]).map((r) => [`${r.ref_id}:${r.user_id}`, r]));

  // ── 필터 적용 후 (user, week) 단위로 묶어 카드 1회만 로드 ────────────────
  // ⚠ era 게이트 필수 — reconcileLineResultAwardForUser 는 isAccrualAllowedWeek 를 거치지 않아
  //   레거시 주차(2026-summer W1 이전)에도 원장을 만들 수 있다. 적립 정책은 그 주차를 명시적으로
  //   제외하므로(processPointAccrual 헤더 "그 외 주차(레거시/PMS) → 적립 스킵 → 과거 데이터 무접촉"),
  //   백필도 반드시 같은 경계를 적용한다. 게이트 없이 돌리면 2025-autumn 등 레거시 주차의
  //   user_weekly_points 가 새로 생기거나 바뀐다(실측: 게이트 없을 때 542건/+3,756 A 중 대부분이 레거시).
  let eraBlocked = 0;
  const scoped = tgts.filter((t) => {
    const w = W.get(t.week_id);
    if (!w || w.iso_year == null) return false;
    const p = P.get(t.target_user_id);
    if (!p) return false;
    if (ORG_FILTER && p.organization_slug !== ORG_FILTER) return false;
    if (WEEK_FILTER && `${w.season_key}:${w.week_number}` !== WEEK_FILTER) return false;
    // 라인이 QA면 test 모드 경계, 아니면 operating 경계(reconcile 내부 판정과 동일 규칙).
    const raw = lineById.get(t.line_id);
    const mode = raw?.is_qa_test === true ? "test" : "operating";
    if (!isAccrualAllowedWeek(mode, { start_date: w.start_date, season_key: w.season_key, week_number: w.week_number })) {
      eraBlocked++;
      return false;
    }
    return true;
  });
  console.log(`era 게이트로 제외된 레거시 주차 대상: ${eraBlocked}건 (적립 정책상 무접촉)`);
  const byUserWeek = new Map<string, any[]>();
  for (const t of scoped) {
    const k = `${t.target_user_id}:${t.week_id}`;
    if (!byUserWeek.has(k)) byUserWeek.set(k, []);
    byUserWeek.get(k)!.push(t);
  }
  console.log(`후보 (사용자 × 주차) ${byUserWeek.size}건 · 라인 대상 ${scoped.length}건 — 카드 판정 로드 중...\n`);

  const plans: Plan[] = [];
  let cardFailed = 0;
  await mapWithConcurrency([...byUserWeek.entries()], 6, async ([key, group]) => {
    const [userId, weekId] = key.split(":");
    const w = W.get(weekId);
    const p = P.get(userId);
    let resolved;
    try { resolved = await resolveCrewWeekCard(userId, weekId); } catch { cardFailed++; return; }
    if (!resolved.ok) { cardFailed++; return; }
    for (const t of group) {
      const line = resolved.card.lines.find((l) => l.lineId === t.line_id && l.lineTargetId === t.id);
      if (!line) continue;
      const raw = lineById.get(t.line_id);
      const cat = experienceCategoryToConfigKey(
        raw?.experience_line_master_id ? catByMaster.get(raw.experience_line_master_id) : null,
      );
      if (!cat) continue;
      const ev = E.get(`${t.id}:${userId}`);
      const evaluated = ev != null && ev.evaluated_by != null;
      const rating = ev ? (ev.rating ?? 0) : 0;
      const success = line.enhancementStatus === "success";
      const desired =
        success && isRatingAwardExperienceType(cat) && evaluated && rating >= EXPERIENCE_RATING_AWARD_MIN_RATING
          ? rating : 0;
      const aw = AW.get(`${t.line_id}:${userId}`);
      const existing = aw && !aw.cancelled_at ? (aw.point_check ?? 0) : null;

      let action: Plan["action"] = "noop";
      if (desired > 0 && existing == null) action = "create";
      else if (desired > 0 && existing !== desired) action = "update";
      else if (desired === 0 && existing != null) action = "revoke";
      if (action === "noop") continue;

      plans.push({
        org: p.organization_slug, weekLabel: `${w.season_key} W${w.week_number}`, weekId,
        isoYear: w.iso_year, isoWeek: w.iso_week,
        userId, userName: p.display_name ?? userId.slice(0, 8),
        lineId: t.line_id, cat, rating, enhancement: line.enhancementStatus,
        existingRatingA: existing, desiredRatingA: desired, action,
        isQaLine: raw?.is_qa_test === true,
      });
    }
  });

  if (plans.length === 0) {
    console.log("변경 대상 0건 — 이미 정합 상태입니다(멱등).");
    return;
  }

  // ── 사용자×주차 단위 영향(uwp / 주차 성공) ──────────────────────────────
  type UW = {
    org: string; weekLabel: string; weekId: string; userId: string; userName: string;
    isoYear: number; isoWeek: number;
    deltaA: number; before: number; after: number;
    n: number | null; uwsStatus: string | null;
    okBefore: boolean | null; okAfter: boolean | null;
    publishedResult: string | null;
  };
  const uwMap = new Map<string, UW>();
  for (const pl of plans) {
    const k = `${pl.userId}:${pl.weekId}`;
    const cur = uwMap.get(k) ?? {
      org: pl.org, weekLabel: pl.weekLabel, weekId: pl.weekId, userId: pl.userId, userName: pl.userName,
      isoYear: pl.isoYear, isoWeek: pl.isoWeek,
      deltaA: 0, before: 0, after: 0, n: null, uwsStatus: null,
      okBefore: null, okAfter: null, publishedResult: null,
    };
    cur.deltaA += pl.desiredRatingA - (pl.existingRatingA ?? 0);
    uwMap.set(k, cur);
  }
  for (const [, uw] of uwMap) {
    const { data: uwp } = await supabaseAdmin
      .from("user_weekly_points").select("points")
      .eq("user_id", uw.userId).eq("year", uw.isoYear).eq("week_number", uw.isoWeek).maybeSingle();
    uw.before = (uwp as any)?.points ?? 0;
    uw.after = uw.before + uw.deltaA;
    const { data: cfg } = await supabaseAdmin
      .from("cluster4_week_opening_configs").select("recognition_count_n")
      .eq("week_id", uw.weekId).eq("organization_slug", uw.org).maybeSingle();
    uw.n = (cfg as any)?.recognition_count_n ?? null;
    if (uw.n != null) { uw.okBefore = uw.before >= uw.n; uw.okAfter = uw.after >= uw.n; }
    const { data: uws } = await supabaseAdmin
      .from("user_week_statuses").select("status")
      .eq("user_id", uw.userId).eq("year", uw.isoYear).eq("week_number", uw.isoWeek).maybeSingle();
    uw.uwsStatus = (uws as any)?.status ?? null;
    // 공표 snapshot 상의 결과(활성 run)
    const { data: run } = await supabaseAdmin
      .from("cluster4_week_finalize_runs").select("id")
      .eq("week_id", uw.weekId).eq("organization_slug", uw.org)
      .is("reverted_at", null).eq("snapshot_captured", true).limit(1);
    const runId = ((run ?? []) as any[])[0]?.id ?? null;
    if (runId) {
      const { data: cr } = await supabaseAdmin
        .from("cluster4_week_finalize_run_crew_results").select("result")
        .eq("run_id", runId).eq("user_id", uw.userId).maybeSingle();
      uw.publishedResult = (cr as any)?.result ?? null;
    }
  }

  // ── 보고 ────────────────────────────────────────────────────────────────
  console.log("── 라인별 계획 ──");
  console.log(
    "  " + pad("조직", 9) + pad("주차", 16) + pad("사용자", 14) + pad("라인", 6) +
      padS("평점", 5) + pad("  강화", 12) + padS("기존원장", 9) + padS("변경후", 8) + pad("  동작", 9) + pad("QA", 4),
  );
  for (const pl of plans.slice(0, 60)) {
    console.log(
      "  " + pad(pl.org, 9) + pad(pl.weekLabel, 16) + pad(pl.userName, 14) + pad(EXP_LABEL[pl.cat] ?? pl.cat, 6) +
        padS(pl.rating, 5) + pad("  " + pl.enhancement, 12) +
        padS(pl.existingRatingA ?? "없음", 9) + padS(pl.desiredRatingA, 8) + pad("  " + pl.action, 9) +
        pad(pl.isQaLine ? "QA" : "", 4),
    );
  }
  if (plans.length > 60) console.log(`  … 외 ${plans.length - 60}건`);

  console.log("\n── 사용자 × 주차 영향 ──");
  console.log(
    "  " + pad("조직", 9) + pad("주차", 16) + pad("사용자", 14) +
      padS("ΔA", 6) + padS("points 전", 10) + padS("points 후", 10) + padS("기준 N", 8) +
      pad("  판정 전", 10) + pad("판정 후", 10) + pad("uws", 10) + pad("공표 결과", 10),
  );
  const uwList = [...uwMap.values()];
  for (const uw of uwList.slice(0, 60)) {
    console.log(
      "  " + pad(uw.org, 9) + pad(uw.weekLabel, 16) + pad(uw.userName, 14) +
        padS(uw.deltaA >= 0 ? `+${uw.deltaA}` : uw.deltaA, 6) + padS(uw.before, 10) + padS(uw.after, 10) + padS(uw.n ?? "-", 8) +
        pad("  " + (uw.okBefore == null ? "-" : uw.okBefore ? "성공" : "실패"), 10) +
        pad(uw.okAfter == null ? "-" : uw.okAfter ? "성공" : "실패", 10) +
        pad(uw.uwsStatus ?? "-", 10) + pad(uw.publishedResult ?? "-", 10),
    );
  }
  if (uwList.length > 60) console.log(`  … 외 ${uwList.length - 60}건`);

  // ── 집계 ────────────────────────────────────────────────────────────────
  const created = plans.filter((p) => p.action === "create").length;
  const updated = plans.filter((p) => p.action === "update").length;
  const revoked = plans.filter((p) => p.action === "revoke").length;
  const totalAdded = plans.reduce((n, p) => n + (p.desiredRatingA - (p.existingRatingA ?? 0)), 0);
  const failToSuccess = uwList.filter((u) => u.okBefore === false && u.okAfter === true).length;
  const successToFail = uwList.filter((u) => u.okBefore === true && u.okAfter === false).length;
  const divergePublished = uwList.filter((u) => {
    if (u.publishedResult == null || u.okAfter == null) return false;
    const pubOk = u.publishedResult === "success";
    return pubOk !== u.okAfter;
  }).length;

  console.log("\n══ 집계 ══");
  console.log(`  신규 원장 생성          ${created}건`);
  console.log(`  기존 원장 수정          ${updated}건`);
  console.log(`  회수 대상               ${revoked}건`);
  console.log(`  총 추가 Point A         ${totalAdded >= 0 ? "+" : ""}${totalAdded}`);
  console.log(`  영향 (사용자 × 주차)    ${uwList.length}건`);
  console.log(`  실패→성공               ${failToSuccess}명`);
  console.log(`  성공→실패               ${successToFail}명`);
  console.log(`  공표 snapshot 과 live 결과가 달라지는 인원  ${divergePublished}명`);
  if (cardFailed > 0) console.log(`  ⚠ 카드 로드 실패(건너뜀) ${cardFailed}건`);

  if (!APPLY) {
    console.log("\n▶ DRY-RUN 종료 — DB write 0. 적용하려면 --apply.");
    console.log("  적용은 reconcileLineResultAwardForUser + recomputeWeeklyPointsForUsers 만 호출합니다");
    console.log("  (원장 직접 INSERT/UPDATE·uwp 직접 UPDATE 없음). uws·공표 snapshot 무접촉.");
    return;
  }

  // ── 적용 — 공통 reconcile 만 사용 ────────────────────────────────────────
  let done = 0, failedN = 0;
  for (const pl of plans) {
    try {
      // 강화 성공 여부는 카드 판정 그대로(재판정 금지). desired>0 이면 성공이었다는 뜻이고,
      //   revoke 는 "비성공" 이므로 false 를 넘긴다 — 운영 경로와 동일한 인자 계약.
      await reconcileLineResultAwardForUser(pl.userId, pl.lineId, pl.weekId, pl.desiredRatingA > 0, null);
      done++;
    } catch (e) {
      failedN++;
      console.error(`  ❌ ${pl.userName} ${EXP_LABEL[pl.cat]} — ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  // uwp 재합산 — 영향 사용자 전원(주차 단위). 운영 경로와 동일한 후속 단계.
  for (const uw of uwList) {
    try { await recomputeWeeklyPointsForUsers([uw.userId], uw.weekId); } catch { /* best-effort */ }
  }
  console.log(`\n적용 완료 — reconcile ${done}건 성공 / ${failedN}건 실패, uwp 재합산 ${uwList.length}(사용자×주차).`);
  console.log("  ※ 재실행하면 '변경 대상 0건' 이어야 합니다(멱등성 확인).");
}

main().catch((e) => { console.error(e); process.exit(1); });
