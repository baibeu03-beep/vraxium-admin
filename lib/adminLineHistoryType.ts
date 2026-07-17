import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { EXPERIENCE_OVERALL_CATEGORIES } from "@/lib/experienceTeamOverallTypes";
import type {
  Cluster4ExperienceCategory,
  Cluster4LineDetailDto,
} from "@/shared/cluster4.contracts";

// ─────────────────────────────────────────────────────────────────────
// "라인 강화 내역" 표/팝업의 "유형" 열 단일 SoT.
//
//   유형과 라인명은 예시·문자열 패턴으로 추론하지 않는다(요구 §2). 실제 lineId/lineCode 를
//   /admin/lines/register 원장(line_registrations)과 동일한 값으로 해석한다.
//
//   · 실무 정보(information) → 상수 "일반" (line_registrations.line_type = 일반, 고정).
//   · 실무 경력(career)      → 상수 "일반" (line_registrations.line_type = 일반, 고정).
//   · 실무 경험(experience)  → DTO.experienceCategory 를 KO 라벨로. 개설 시 register.line_type(한글)
//                              에서 파생된 값이라 원장과 동치. evaluation 표시 라벨 = "견문".
//   · 실무 역량(competency)  → cluster4_lines.competency_line_master_id →
//                              line_registrations(hub=competency, bridged_master_id=master.id).line_type
//                              (원리/기술/관점/자원). 마스터 테이블엔 유형 컬럼이 없어 브리지가 유일 SoT.
//                              (실데이터 검증: scripts/diag-line-history-type-sot.ts)
//
//   표와 팝업은 절대 각자 계산하지 않고 이 모듈의 결과(row.type)만 쓴다(요구 §5).
// ─────────────────────────────────────────────────────────────────────

export const INFO_LINE_TYPE_LABEL = "일반";
export const CAREER_LINE_TYPE_LABEL = "일반";

// experienceCategory(코드) → KO 라벨. 팀 총괄 화면과 동일 원천(EXPERIENCE_OVERALL_CATEGORIES).
//   evaluation → "견문". 슬롯 placeholder 행도 experienceCategory 를 가지므로 동일하게 해석된다.
const EXPERIENCE_CATEGORY_LABEL: Record<Cluster4ExperienceCategory, string> =
  Object.fromEntries(
    EXPERIENCE_OVERALL_CATEGORIES.map((c) => [c.key, c.label]),
  ) as Record<Cluster4ExperienceCategory, string>;

export function resolveExperienceTypeLabel(
  category: Cluster4ExperienceCategory | null,
): string | null {
  if (!category) return null;
  return EXPERIENCE_CATEGORY_LABEL[category] ?? null;
}

// 경험 유형 표시 순서(도출·분석·견문·관리·확장) — 슬롯 폴딩 후 행 정렬용. 미해석 유형은 뒤로.
const EXPERIENCE_LABEL_ORDER: readonly string[] = EXPERIENCE_OVERALL_CATEGORIES.map(
  (c) => c.label,
);
export function experienceTypeDisplayOrder(typeLabel: string | null): number {
  if (!typeLabel) return 99;
  const i = EXPERIENCE_LABEL_ORDER.indexOf(typeLabel);
  return i < 0 ? 98 : i;
}

// competencyLineMasterId 집합 → line_type(원리/기술/관점/자원) 맵. 브리지 미존재(레거시/테스트 라인)는
//   맵에 없음 → 호출부에서 null("-") 처리. hub=competency 로 스코프(다른 허브 오염 방지).
export async function loadCompetencyLineTypeByMasterIds(
  masterIds: string[],
): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  const ids = Array.from(new Set(masterIds.filter(Boolean)));
  if (ids.length === 0) return map;
  const { data, error } = await supabaseAdmin
    .from("line_registrations")
    .select("bridged_master_id,line_type")
    .eq("hub", "competency")
    .in("bridged_master_id", ids);
  if (error) {
    console.warn("[lineHistoryType] competency line_type lookup failed", {
      message: error.message,
    });
    return map;
  }
  for (const r of (data ?? []) as Array<{
    bridged_master_id: string | null;
    line_type: string | null;
  }>) {
    if (r.bridged_master_id && r.line_type) {
      map.set(r.bridged_master_id, r.line_type);
    }
  }
  return map;
}

// 실무 정보 "정식 라인" 8개 카탈로그(요구 §3-1) — 기타A(etc_a) 제외.
//   원천 = line_registrations(hub=info). 라인명 = 원장 line_name(= /admin/lines/register 정식 라인명,
//   Main Title/공표글 제목 아님). displayLineCode = 원장 line_code(IFBS-NN000X). line_code 순 정렬.
//   org 우선(없으면 공통) 1행/활동유형. 현재 원장은 전부 공통이나 org-특화 대비 우선순위를 둔다.
export type InfoLineCatalogEntry = {
  activityTypeId: string;
  lineName: string;
  displayLineCode: string | null;
};

const INFO_EXCLUDED_ACTIVITY_TYPE_IDS = new Set(["etc_a"]);

export async function loadInfoLineCatalog(
  organizationSlug: string | null,
): Promise<InfoLineCatalogEntry[]> {
  const { data, error } = await supabaseAdmin
    .from("line_registrations")
    .select("line_name,line_code,point_activity_type_id,organization_slug")
    .eq("hub", "info")
    .order("line_code", { ascending: true });
  if (error) {
    console.warn("[lineHistoryType] info catalog lookup failed", {
      message: error.message,
    });
    return [];
  }
  type Row = {
    line_name: string | null;
    line_code: string | null;
    point_activity_type_id: string | null;
    organization_slug: string | null;
  };
  // 활동유형별 1행 — org 특화 > 공통 우선. line_code 오름차순(질의 정렬) 유지.
  const byActivity = new Map<string, Row>();
  for (const r of (data ?? []) as Row[]) {
    const act = r.point_activity_type_id;
    if (!act || INFO_EXCLUDED_ACTIVITY_TYPE_IDS.has(act)) continue;
    const existing = byActivity.get(act);
    const isOrgSpecific =
      organizationSlug != null && r.organization_slug === organizationSlug;
    if (!existing) {
      byActivity.set(act, r);
    } else {
      const existingOrgSpecific =
        organizationSlug != null && existing.organization_slug === organizationSlug;
      if (isOrgSpecific && !existingOrgSpecific) byActivity.set(act, r);
    }
  }
  return Array.from(byActivity.values())
    .sort((a, b) => (a.line_code ?? "").localeCompare(b.line_code ?? ""))
    .map((r) => ({
      activityTypeId: r.point_activity_type_id as string,
      lineName: r.line_name?.trim() || "(이름 없음)",
      displayLineCode: r.line_code ?? null,
    }));
}

// 카드 라인 1건 → "유형" 라벨. 경험/역량은 위 파생값을, 정보/경력은 상수를 쓴다.
//   competencyTypeByMaster 는 loadCompetencyLineTypeByMasterIds 결과. 미해석 → null("-").
export function resolveLineTypeLabel(
  line: Pick<
    Cluster4LineDetailDto,
    "partType" | "experienceCategory" | "competencyLineMasterId"
  >,
  competencyTypeByMaster: Map<string, string>,
): string | null {
  switch (line.partType) {
    case "information":
      return INFO_LINE_TYPE_LABEL;
    case "career":
      return CAREER_LINE_TYPE_LABEL;
    case "experience":
      return resolveExperienceTypeLabel(line.experienceCategory);
    case "competency":
      return line.competencyLineMasterId
        ? competencyTypeByMaster.get(line.competencyLineMasterId) ?? null
        : null;
  }
}
