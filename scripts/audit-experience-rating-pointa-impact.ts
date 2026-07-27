/**
 * [read-only · DB write 0] 실무 경험 평점 Point A 정책 영향 분석 (2026-07-27).
 *
 *   npx tsx --env-file=.env.local scripts/audit-experience-rating-pointa-impact.ts
 *
 * 과거 데이터를 **수정하지 않는다**. 새 산식/새 적립 정책을 적용했을 때의 차이만 계산해 보고한다.
 * (backfill·오픈확인 재실행은 별도 승인 후 별도 스크립트로 수행.)
 *
 * 출력:
 *   [A] 주차 기준 검증표 — org·주차·팀수·오픈 셀 수(도출/분석/견문/관리/확장)·
 *       기존 저장 minimalA/diligentB/N(v1) vs 새 산식 minimalA/diligentB/N(v2)
 *   [B] 개인별 검증표 — org·주차·팀·사용자·라인·실제 평점·강화 상태·기존 강화 A/B·
 *       평점 추가 A·원장 지급값·현재 uwp.points·예상 uwp.points·차이
 *   [C] 주차 성공/실패 플립 — 기존 기준값 vs 새 기준값, 기존 points vs 예상 points
 */
/* eslint-disable @typescript-eslint/no-explicit-any -- 조사 스크립트: 여러 테이블 raw row 를 그대로 훑는다. */
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { ORGANIZATIONS, type OrganizationSlug } from "@/lib/organizations";
import { resolveRecognitionInputs } from "@/lib/weekRecognitionResolve";
import { computeWeekRecognitionCount } from "@/lib/weekRecognitionCount";
import { loadWeekOpeningConfig, type SavedConfig } from "@/lib/adminTeamPartsInfoWeekDetailData";
import { loadWeekOpeningTimeline } from "@/lib/weekOpeningTimeline";
import { resolveCrewWeekCard } from "@/lib/adminCrewWeekDetail";
import { loadLinePointForConfig, resolveLineConfigKey } from "@/lib/processPointAccrual";
import {
  EXPERIENCE_RATING_AWARD_MIN_RATING,
  isRatingAwardExperienceType,
} from "@/lib/experienceRatingPolicy";
import { mapWithConcurrency } from "@/lib/concurrency";

type Row = Record<string, unknown>;

const EXP_LABEL: Record<string, string> = {
  derive: "도출", analysis: "분석", research: "견문", management: "관리", expansion: "확장",
};
const CAT_TO_KEY: Record<string, string> = {
  derivation: "derive", analysis: "analysis", evaluation: "research", extension: "expansion", management: "management",
};

const pad = (v: unknown, n: number) => String(v ?? "").padEnd(n);
const padS = (v: unknown, n: number) => String(v ?? "").padStart(n);

async function main() {
  // ── 대상: 오픈확인된 (주차 × 조직) 전부 ─────────────────────────────────────
  const { data: cfgRows, error: cfgErr } = await supabaseAdmin
    .from("cluster4_week_opening_configs")
    .select("week_id,organization_slug,open_confirmed,min_points_a,exec_points_b,recognition_count_n,recognition_calc_version")
    .eq("open_confirmed", true);
  if (cfgErr) throw cfgErr;
  const confirmed = (cfgRows ?? []) as Array<Row & {
    week_id: string; organization_slug: string;
    min_points_a: number | null; exec_points_b: number | null;
    recognition_count_n: number | null; recognition_calc_version: number | null;
  }>;

  const weekIds = Array.from(new Set(confirmed.map((r) => r.week_id)));
  const { data: wkRows } = await supabaseAdmin
    .from("weeks")
    .select("id,start_date,season_key,week_number,iso_year,iso_week")
    .in("id", weekIds);
  const wkById = new Map(((wkRows ?? []) as any[]).map((w) => [w.id, w]));

  const scoped = confirmed
    .filter((r) => (ORGANIZATIONS as readonly string[]).includes(r.organization_slug))
    .sort((a, b) => {
      const sa = String(wkById.get(a.week_id)?.start_date ?? "");
      const sb = String(wkById.get(b.week_id)?.start_date ?? "");
      return sa === sb ? a.organization_slug.localeCompare(b.organization_slug) : sa.localeCompare(sb);
    });

  console.log("═".repeat(170));
  console.log("[A] 주차 기준 검증표");
  console.log("    저장(v1) = 오픈확인 당시 latch 된 값 · 구산식(live) = 오늘 데이터 + 구산식 · 신산식(v2) = 오늘 데이터 + 신산식");
  console.log("    ⇒ 산식 변경만의 순효과는 [구산식(live) → 신산식(v2)] 차이다. 저장값과의 차이에는 그동안의 액트/설정 변동이 섞여 있다.");
  console.log("═".repeat(170));
  console.log(
    pad("조직", 8) + pad("주차", 18) + padS("팀", 3) +
      padS("도출", 5) + padS("분석", 5) + padS("견문", 5) + padS("관리", 5) + padS("확장", 5) +
      " |" + padS("A저장", 6) + padS("A구", 6) + padS("A신", 6) + padS("Δ산식", 7) +
      " |" + padS("B저장", 6) + padS("B구", 6) + padS("B신", 6) + padS("Δ산식", 7) +
      " |" + padS("N저장", 6) + padS("N구", 5) + padS("N신", 5) + padS("Δ산식", 7),
  );
  console.log("─".repeat(170));

  const weekCriterion = new Map<string, { stored: number | null; oldLive: number; after: number }>();

  for (const r of scoped) {
    const org = r.organization_slug as OrganizationSlug;
    const w = wkById.get(r.week_id);
    const { config } = await loadWeekOpeningConfig(r.week_id, org);
    const saved = (config ?? {}) as SavedConfig;
    const exp = saved.practicalExperience ?? {};
    const teamIds = Object.keys(exp);
    const cells = (t: string) => teamIds.filter((tid) => exp[tid]?.[t as never] === true).length;

    // 새 산식 — 오픈확인 저장 경로(prepareWeekRecognition)와 동일한 resolve + compute 를 그대로 사용.
    const timeline = await loadWeekOpeningTimeline(r.week_id, org);
    const { acts, lines } = await resolveRecognitionInputs({
      weekId: r.week_id,
      organization: org,
      config: saved,
      openConfirmed: true,
      timeline: timeline.timelineAvailable
        ? { openConfirmed: true, latestConfig: saved, versions: timeline.versions, timelineAvailable: true }
        : undefined,
      weekStart: w?.start_date ?? null,
    });
    const after = computeWeekRecognitionCount({ acts, lines });

    // 구산식 재현(동일 입력·동일 액트) — 실무 경험을 카테고리별 1회로 접고, 기준 평점 가산 없이
    //   관리·확장까지 A·B 양쪽에 넣는다(2026-07-19~2026-07-26 동작).
    const seenExpKey = new Set<string>();
    const oldLines = lines.flatMap((l) => {
      if (l.hub !== "experience") return [{ ...l, role: undefined, ratingMinimal: 0, ratingDiligent: 0 }];
      const type = l.id.split(":")[2] ?? "";
      if (!l.isOpen) return []; // 미오픈은 어차피 무기여 — 중복 제거 대상에서도 제외
      if (seenExpKey.has(type)) return [];
      seenExpKey.add(type);
      return [{ ...l, role: undefined, ratingMinimal: 0, ratingDiligent: 0 }];
    });
    const oldLive = computeWeekRecognitionCount({ acts, lines: oldLines });

    weekCriterion.set(`${r.week_id}:${org}`, {
      stored: r.recognition_count_n,
      oldLive: oldLive.recognitionCountN,
      after: after.recognitionCountN,
    });

    const d = (b: number, a: number) => (a - b >= 0 ? "+" : "") + String(a - b);
    console.log(
      pad(org, 8) + pad(`${w?.season_key ?? "?"} W${w?.week_number ?? "?"} ${String(w?.start_date).slice(5, 10)}`, 18) +
        padS(teamIds.length, 3) +
        padS(cells("derive"), 5) + padS(cells("analysis"), 5) + padS(cells("research"), 5) +
        padS(cells("management"), 5) + padS(cells("expansion"), 5) +
        " |" + padS(r.min_points_a, 6) + padS(oldLive.minimalA, 6) + padS(after.minimalA, 6) + padS(d(oldLive.minimalA, after.minimalA), 7) +
        " |" + padS(r.exec_points_b, 6) + padS(oldLive.diligentB, 6) + padS(after.diligentB, 6) + padS(d(oldLive.diligentB, after.diligentB), 7) +
        " |" + padS(r.recognition_count_n, 6) + padS(oldLive.recognitionCountN, 5) + padS(after.recognitionCountN, 5) + padS(d(oldLive.recognitionCountN, after.recognitionCountN), 7),
    );
  }
  console.log("  ※ 관리·확장 오픈 셀은 새 산식의 A·B·N 어디에도 기여하지 않는다(개인 적립은 별도 경로로 유지).");

  // ── [B] 개인별 검증표 ────────────────────────────────────────────────────
  console.log("\n" + "═".repeat(170));
  console.log("[B] 개인별 검증표 — 평점 Point A 적립 예상 (원장 미기록 · dry-run)");
  console.log("═".repeat(170));

  type Detail = {
    org: string; week: string; team: string; user: string; userId: string;
    lineLabel: string; cat: string; rating: number | null; evaluated: boolean;
    enh: string; cfgA: number | null; cfgB: number | null;
    ledgerA: number; ledgerB: number; ratingA: number;
  };
  const details: Detail[] = [];
  const projectedByUserWeek = new Map<string, number>(); // `${userId}:${weekId}` → 평점 A 합

  for (const r of scoped) {
    const org = r.organization_slug as OrganizationSlug;
    const w = wkById.get(r.week_id);
    if (!w) continue;
    const weekLabel = `${w.season_key} W${w.week_number}`;

    // 그 주차 배정 대상자(target_mode='user') 중 이 조직 소속만.
    const { data: tgtRows } = await supabaseAdmin
      .from("cluster4_line_targets")
      .select("target_user_id")
      .eq("week_id", r.week_id)
      .eq("target_mode", "user")
      .not("target_user_id", "is", null);
    const allUserIds = Array.from(new Set(((tgtRows ?? []) as any[]).map((t) => t.target_user_id)));
    if (allUserIds.length === 0) continue;
    const profs: any[] = [];
    for (let i = 0; i < allUserIds.length; i += 200) {
      const { data } = await supabaseAdmin
        .from("user_profiles")
        .select("user_id,display_name,organization_slug")
        .in("user_id", allUserIds.slice(i, i + 200));
      profs.push(...((data ?? []) as any[]));
    }
    const profById = new Map(profs.map((p) => [p.user_id, p]));
    const userIds = allUserIds.filter((u) => profById.get(u)?.organization_slug === org);

    await mapWithConcurrency(userIds, 6, async (userId) => {
      let resolved;
      try {
        resolved = await resolveCrewWeekCard(userId, r.week_id);
      } catch {
        return;
      }
      if (!resolved.ok) return;
      for (const line of resolved.card.lines) {
        if (line.partType !== "experience") continue;
        if (line.lineId == null || line.lineTargetId == null) continue; // 배정 라인만
        const cat = line.experienceCategory ? CAT_TO_KEY[line.experienceCategory] ?? null : null;
        if (!cat) continue;

        // 기존 강화 지급 config(크루 소속 org 기준 — reconcileLineResultAwardForUser 와 동일 규칙).
        const { data: lineRow } = await supabaseAdmin
          .from("cluster4_lines")
          .select("id,part_type,line_code,activity_type_id,experience_line_master_id,competency_line_master_id,career_project_id,is_qa_test")
          .eq("id", line.lineId)
          .maybeSingle();
        const configKey = lineRow ? await resolveLineConfigKey(lineRow as any) : null;
        const cfg = configKey ? await loadLinePointForConfig(org, "experience", configKey) : { pointA: null, pointB: null, pointC: null };

        // 현재 원장 실측(source='line' 강화 지급 / 'line_rating' 평점 지급).
        const { data: awRows } = await supabaseAdmin
          .from("process_point_awards")
          .select("source,point_check,point_advantage,cancelled_at")
          .eq("user_id", userId)
          .eq("ref_id", line.lineId)
          .in("source", ["line", "line_rating"]);
        let ledgerA = 0, ledgerB = 0;
        for (const a of (awRows ?? []) as any[]) {
          if (a.cancelled_at) continue;
          if (a.source === "line") { ledgerA += a.point_check ?? 0; ledgerB += a.point_advantage ?? 0; }
        }

        // 평가행(미평가 placeholder 구분).
        const { data: evRows } = await supabaseAdmin
          .from("cluster4_experience_line_evaluations")
          .select("rating,evaluated_by")
          .eq("user_id", userId)
          .eq("line_target_id", line.lineTargetId);
        const ev = ((evRows ?? []) as any[])[0] ?? null;
        const evaluated = ev != null && ev.evaluated_by != null;
        const rating: number | null = ev ? ev.rating ?? 0 : null;

        // 새 정책 예상 평점 Point A.
        const success = line.enhancementStatus === "success";
        const ratingA =
          success && isRatingAwardExperienceType(cat) && evaluated && (rating ?? 0) >= EXPERIENCE_RATING_AWARD_MIN_RATING
            ? (rating as number)
            : 0;
        if (ratingA > 0) {
          const k = `${userId}:${r.week_id}`;
          projectedByUserWeek.set(k, (projectedByUserWeek.get(k) ?? 0) + ratingA);
        }

        details.push({
          org, week: weekLabel, team: (resolved.card as any).teamName ?? "-",
          user: profById.get(userId)?.display_name ?? userId.slice(0, 8),
          userId, lineLabel: EXP_LABEL[cat] ?? cat, cat,
          rating, evaluated, enh: line.enhancementStatus,
          cfgA: cfg.pointA, cfgB: cfg.pointB, ledgerA, ledgerB, ratingA,
        });
      }
    });
  }

  // 대표 사례 우선 출력(§7 필수 케이스) + 나머지 요약.
  const pick = (f: (d: Detail) => boolean, label: string, n = 3) => {
    const hits = details.filter(f);
    return { label, hits: hits.slice(0, n), total: hits.length };
  };
  const buckets = [
    pick((d) => d.enh === "success" && d.rating === 4, "평점 4점 (성공·지급)"),
    pick((d) => d.enh === "success" && d.rating === 7, "평점 7점 (성공·지급)"),
    pick((d) => d.enh === "success" && d.rating === 10, "평점 10점 (성공·지급)"),
    pick((d) => (d.rating ?? 99) <= 3 && d.evaluated, "평점 0~3 (강화 실패·미지급)"),
    pick((d) => !d.evaluated, "미평가 placeholder / 평가행 부재 (미지급)"),
    pick((d) => d.cat === "management" && d.ratingA > 0, "관리 라인 수행자 (개인 지급 O · 주차 기준 제외)"),
    pick((d) => d.cat === "expansion", "확장 라인 (이번 정책 제외)"),
  ];

  console.log(
    pad("조직", 8) + pad("주차", 14) + pad("사용자", 14) + pad("라인", 6) +
      padS("평점", 5) + padS("평가", 5) + pad("  강화", 12) +
      padS("설정A", 6) + padS("설정B", 6) + padS("원장A", 6) + padS("원장B", 6) +
      padS("평점A", 6) + padS("최종A", 6),
  );
  console.log("─".repeat(170));
  for (const b of buckets) {
    console.log(`\n▸ ${b.label} — 총 ${b.total}건${b.total > b.hits.length ? ` (상위 ${b.hits.length}건 표시)` : ""}`);
    if (b.hits.length === 0) console.log("   (해당 사례 없음)");
    for (const d of b.hits) {
      console.log(
        "   " + pad(d.org, 8) + pad(d.week, 14) + pad(d.user, 14) + pad(d.lineLabel, 6) +
          padS(d.rating ?? "-", 5) + padS(d.evaluated ? "O" : "X", 5) + pad("  " + d.enh, 12) +
          padS(d.cfgA ?? "null", 6) + padS(d.cfgB ?? "null", 6) + padS(d.ledgerA, 6) + padS(d.ledgerB, 6) +
          padS(d.ratingA, 6) + padS(d.ledgerA + d.ratingA, 6),
      );
    }
  }

  // ── [C] uwp / 주차 성공 영향 ─────────────────────────────────────────────
  console.log("\n" + "═".repeat(150));
  console.log("[C] user_weekly_points 및 주차 성공/실패 영향");
  console.log("═".repeat(150));

  const catAgg = new Map<string, { n: number; sum: number }>();
  for (const d of details) {
    if (d.ratingA <= 0) continue;
    const s = catAgg.get(d.cat) ?? { n: 0, sum: 0 };
    s.n += 1; s.sum += d.ratingA;
    catAgg.set(d.cat, s);
  }
  console.log("\n  카테고리별 신규 평점 Point A:");
  let grandN = 0, grandSum = 0;
  for (const [k, s] of [...catAgg.entries()].sort()) {
    console.log(`    ${pad(EXP_LABEL[k] ?? k, 6)} 건수 ${padS(s.n, 5)}   ΣPoint A ${padS(s.sum, 6)}`);
    grandN += s.n; grandSum += s.sum;
  }
  console.log(`    ${pad("합계", 6)} 건수 ${padS(grandN, 5)}   ΣPoint A ${padS(grandSum, 6)}`);

  // 주차 성공/실패 플립 — 평점 A 수령자뿐 아니라 **그 주차 조직 코호트 전원**을 본다.
  //   기준값(N)이 오르면 평점 A 를 못 받는 크루는 그대로 실패로 밀릴 수 있으므로 전원 검사가 필수다.
  console.log("\n  주차 성공/실패 플립 (조직 코호트 전원 · 기준 = recognition_count_n):");
  console.log(
    "    " + pad("조직", 8) + pad("주차", 14) + padS("코호트", 7) +
      padS("성공(전)", 9) + padS("성공(후)", 9) + padS("→실패", 7) + padS("→성공", 7) + padS("평점A수령", 10),
  );
  const flipDetail: string[] = [];
  let totalToFail = 0, totalToSuccess = 0;

  for (const r of scoped) {
    const org = r.organization_slug as OrganizationSlug;
    const w = wkById.get(r.week_id);
    if (!w || w.iso_year == null || w.iso_week == null) continue;
    const crit = weekCriterion.get(`${r.week_id}:${org}`);
    if (!crit || crit.stored == null) continue;

    // 코호트 = 그 주차 uwp 행 보유자 중 이 조직 소속.
    const { data: orgProfs } = await supabaseAdmin
      .from("user_profiles")
      .select("user_id,display_name")
      .eq("organization_slug", org);
    const nameById = new Map(((orgProfs ?? []) as any[]).map((p) => [p.user_id, p.display_name]));
    const orgUserIds = [...nameById.keys()];

    // ⚠ .in() URL 길이 절벽 — uuid 60개 단위로 끊는다.
    const uwpRows: any[] = [];
    for (let i = 0; i < orgUserIds.length; i += 60) {
      const { data, error } = await supabaseAdmin
        .from("user_weekly_points")
        .select("user_id,points")
        .eq("year", w.iso_year)
        .eq("week_number", w.iso_week)
        .in("user_id", orgUserIds.slice(i, i + 60));
      if (error) console.log(`      [uwp 조회 실패] ${org} ${error.message}`);
      uwpRows.push(...((data ?? []) as any[]));
    }
    if (uwpRows.length === 0) {
      console.log(`    ${pad(org, 8)}${pad(`${w.season_key} W${w.week_number}`, 14)}${padS(0, 7)}   (uwp 행 없음 — iso ${w.iso_year}/${w.iso_week}, org 회원 ${orgUserIds.length}명)`);
      continue;
    }

    let okBeforeN = 0, okAfterN = 0, toFail = 0, toSuccess = 0, recipients = 0;
    for (const u of uwpRows) {
      const before = u.points ?? 0;
      const add = projectedByUserWeek.get(`${u.user_id}:${r.week_id}`) ?? 0;
      if (add > 0) recipients += 1;
      const after = before + add;
      const ok1 = before >= (crit.stored as number);
      const ok2 = after >= crit.after;
      if (ok1) okBeforeN += 1;
      if (ok2) okAfterN += 1;
      if (ok1 && !ok2) {
        toFail += 1;
        flipDetail.push(
          `      ${pad(org, 8)} ${pad(`${w.season_key} W${w.week_number}`, 14)} ${pad(nameById.get(u.user_id) ?? u.user_id.slice(0, 8), 14)}` +
            ` points ${padS(before, 5)}→${padS(after, 5)} (평점A +${add})   기준 ${padS(crit.stored, 4)}→${padS(crit.after, 4)}   성공 → 실패`,
        );
      }
      if (!ok1 && ok2) {
        toSuccess += 1;
        flipDetail.push(
          `      ${pad(org, 8)} ${pad(`${w.season_key} W${w.week_number}`, 14)} ${pad(nameById.get(u.user_id) ?? u.user_id.slice(0, 8), 14)}` +
            ` points ${padS(before, 5)}→${padS(after, 5)} (평점A +${add})   기준 ${padS(crit.stored, 4)}→${padS(crit.after, 4)}   실패 → 성공`,
        );
      }
    }
    totalToFail += toFail;
    totalToSuccess += toSuccess;
    console.log(
      "    " + pad(org, 8) + pad(`${w.season_key} W${w.week_number}`, 14) + padS(uwpRows.length, 7) +
        padS(okBeforeN, 9) + padS(okAfterN, 9) + padS(toFail, 7) + padS(toSuccess, 7) + padS(recipients, 10),
    );
  }
  console.log(`\n  합계 — 성공→실패 ${totalToFail}명 · 실패→성공 ${totalToSuccess}명`);
  for (const l of flipDetail.slice(0, 40)) console.log(l);
  if (flipDetail.length > 40) console.log(`      … 외 ${flipDetail.length - 40}건`);

  console.log("\n  ⚠ 이 스크립트는 DB 를 쓰지 않는다. 실제 반영은 (1) 마이그레이션 적용 후");
  console.log("    (2) 해당 라인의 저장/공표/48h 스윕이 reconcileLineResultAwardForUser 를 다시 태울 때 일어난다.");
  console.log("    과거 주차 backfill·오픈확인 재실행은 별도 승인 사항이다.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
