// 실무 경험 라인명 선택 기능 검증 — 로직(무DB) + DB(옵션 원천/마이그레이션).
//
// 실행: npx tsx --env-file=.env.local scripts/verify-experience-line-name-selection.ts
//
// 검증 항목:
//   [로직] 보이드 규칙(미체크/0점 → selectedLineId=null), 1~3점 라인 유지, 유형 매칭 헬퍼.
//   [DB]  selected_line_id 컬럼 존재(마이그레이션 적용 여부), org별 라인 옵션이 유형별로만 그룹되고
//         (도출/분석/견문) 교차 유형 누수가 없는지 — 개설 신청/검수/서버 검증 공용 원천 1개.

import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { ORGANIZATIONS } from "@/lib/organizations";
import {
  EXPERIENCE_PART_LINE_KEYS,
  normalizePartInputCell,
  type ExperiencePartLineType,
} from "@/lib/experiencePartInputTypes";
import {
  buildLineIdCategoryMap,
  listExperienceLineOptions,
  listExperienceOverallLineOptions,
} from "@/lib/adminExperienceLineData";
import { EXPERIENCE_OVERALL_CATEGORY_KEYS } from "@/lib/experienceTeamOverallTypes";

let failures = 0;
function check(name: string, ok: boolean, detail?: string) {
  const mark = ok ? "✓" : "✗";
  if (!ok) failures++;
  console.log(`  ${mark} ${name}${detail ? ` — ${detail}` : ""}`);
}

async function main() {
  console.log("\n[1] 보이드 규칙 / 셀 정규화 (무DB)");
  // 체크 + 7점 + 라인 선택 → 라인 유지.
  {
    const c = normalizePartInputCell({
      crewUserId: "u1",
      lineType: "derivation" as ExperiencePartLineType,
      checked: true,
      score: 7,
      selectedLineId: "L-derivation",
    });
    check("체크·7점 → 라인 유지", c.selectedLineId === "L-derivation" && c.checked && c.score === 7);
  }
  // 0점 → 라인 null + 미체크.
  {
    const c = normalizePartInputCell({
      crewUserId: "u1",
      lineType: "analysis" as ExperiencePartLineType,
      checked: true,
      score: 0,
      selectedLineId: "L-analysis",
    });
    check("0점 → 라인 '-'(null)·미체크", c.selectedLineId === null && !c.checked && c.score === 0);
  }
  // 미체크(=0점, checked 는 score 파생 SoT) → 라인 null.
  {
    const c = normalizePartInputCell({
      crewUserId: "u1",
      lineType: "evaluation" as ExperiencePartLineType,
      checked: false,
      score: 0,
      selectedLineId: "L-eval",
    });
    check("미체크(0점) → 라인 '-'(null)·미체크", c.selectedLineId === null && !c.checked && c.score === 0);
  }
  // 방어: score 가 checked 를 파생한다(모순 입력이면 score 승). score 8 이면 checked=true·라인 유지.
  {
    const c = normalizePartInputCell({
      crewUserId: "u1",
      lineType: "evaluation" as ExperiencePartLineType,
      checked: false, // 모순 입력.
      score: 8,
      selectedLineId: "L-eval",
    });
    check("모순 입력(미체크+8점) → score 승(checked=true·라인 유지)", c.checked && c.score === 8 && c.selectedLineId === "L-eval");
  }
  // 1~3점(강화 실패지만 체크 유지) → 라인 유지.
  {
    const c = normalizePartInputCell({
      crewUserId: "u1",
      lineType: "derivation" as ExperiencePartLineType,
      checked: true,
      score: 2,
      selectedLineId: "L-keep",
    });
    check("2점(강화 실패·체크) → 라인 유지", c.selectedLineId === "L-keep" && c.checked && c.score === 2);
  }

  console.log("\n[2] 마이그레이션 컬럼 존재 (DB)");
  for (const [table, file] of [
    [
      "cluster4_experience_part_submission_cells",
      "2026-07-15_experience_part_submission_cells_selected_line.sql",
    ],
    [
      "cluster4_experience_team_overall_cells",
      "2026-07-15_experience_team_overall_cells_selected_line.sql",
    ],
  ] as const) {
    const { error } = await supabaseAdmin.from(table).select("selected_line_id").limit(1);
    const applied = !error;
    check(
      `${table}.selected_line_id 존재`,
      applied,
      applied ? undefined : `미적용 — db/migrations/${file} 수동 적용 필요 (${error?.message})`,
    );
  }

  console.log("\n[3] 라인 옵션 원천 — org별 유형 그룹/누수 (DB)");
  for (const org of ORGANIZATIONS) {
    // 5카테고리(팀 총괄: 도출/분석/견문/확장/관리).
    const overall = await listExperienceOverallLineOptions(org);
    const keys = Object.keys(overall).sort().join(",");
    check(
      `[${org}] 5카테고리 키 = 도출/분석/견문/확장/관리`,
      keys === "analysis,derivation,evaluation,extension,management",
      keys,
    );
    // 각 옵션 id → 카테고리 역매핑 일치(교차 유형 누수 0).
    const idCat = buildLineIdCategoryMap(overall);
    let leak = 0;
    for (const cat of EXPERIENCE_OVERALL_CATEGORY_KEYS) {
      for (const opt of overall[cat]) if (idCat.get(opt.id) !== cat) leak++;
    }
    check(`[${org}] 유형 교차 누수 0`, leak === 0, `누수 ${leak}건`);
    const counts = EXPERIENCE_OVERALL_CATEGORY_KEYS.map(
      (k) => `${k}:${overall[k].length}`,
    ).join(" · ");
    console.log(`      옵션 수 — ${counts}`);

    // 개설 신청(3카테고리)은 5카테고리의 도출/분석/견문 부분집합과 동일해야 한다(원천 1개).
    const part = await listExperienceLineOptions(org);
    const same = EXPERIENCE_PART_LINE_KEYS.every(
      (k) =>
        part[k].length === overall[k].length &&
        part[k].every((o, i) => o.id === overall[k][i].id),
    );
    check(`[${org}] 개설 신청 3카테고리 = 총괄 부분집합`, same);
  }

  console.log(
    failures === 0
      ? "\n✅ 전체 통과"
      : `\n❌ 실패 ${failures}건 (위 ✗ 참조)`,
  );
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("verify 실행 오류:", e);
  process.exit(1);
});
