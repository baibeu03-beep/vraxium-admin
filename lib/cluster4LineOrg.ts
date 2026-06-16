import { isOrganizationSlug, type OrganizationSlug } from "@/lib/organizations";

// ─────────────────────────────────────────────────────────────────────
// 4허브 라인 ↔ 조직(org) 노출 정책 유틸.
//
// org 판정 우선순위(최종 정책 2026-06-02):
//   1) line_code 에 'BS' 포함 → common (전체 공통). master org 가 무엇이든 BS 가 절대 우선.
//   2) line_code 에 'EC' 포함 → encre
//   3) line_code 에 'OK' 포함 → oranke
//   4) line_code 에 'PX' 포함 → phalanx
//   5) line_code 로 판정 불가 → 허브 마스터 organization_slug 로 폴백
//        experience → cluster4_experience_line_masters.organization_slug
//        competency → cluster4_competency_line_masters.organization_slug
//        career     → career_projects.organization_slug
//        info       → org 컬럼 없음 → 'common'
//   6) 그래도 판정 불가(null) → Step 2 숨김 / Step 1(본인 배정)만 노출 (isLineVisibleForUserOrg).
//
// 값 의미: 'encre'|'oranke'|'phalanx' = 해당 조직 전용, 'common' = 전체 조직 공통.
//
// line_code 가 master organization_slug 보다 우선이므로, WCBS-NL0000(master=oranke)·EXBS-EL*
// (master=조직별)처럼 코드에 BS 가 든 라인은 DB 수정 없이 코드에서 common 으로 판정된다.
// (resolveLineOrg 가 이 우선순위를 적용한다 — cluster4WeeklyCardsData.ts.)
// ─────────────────────────────────────────────────────────────────────

// 노출 정책상 라인이 가질 수 있는 org 범위. null = 판정 불가.
export type LineOrgScope = OrganizationSlug | "common";

// line_code 에 포함된 org 토큰(우선순위 순). 'BS' 가 최우선 → 코드에 BS 가 있으면 무조건 common.
//   토큰은 정규 코드에서 항상 대문자(EXEC/EXOK/EXBS/CPBS/WCBS…)이므로 대소문자 구분 contains 로
//   검사한다 — 소문자 info 코드(wisdom/essay 등)가 우연히 'ok'/'ec' 를 포함해도 오탐하지 않는다.
const LINE_CODE_ORG_TOKENS: ReadonlyArray<[string, LineOrgScope]> = [
  ["BS", "common"],
  ["EC", "encre"],
  ["OK", "oranke"],
  ["PX", "phalanx"],
];

// line_code 에 org 토큰이 포함돼 있으면 우선순위에 따라 org 를 돌려준다(BS>EC>OK>PX).
// 토큰이 전혀 없으면(구버전 EX02A-…·info wisdom 등) null.
export function parseLineCodeOrg(
  lineCode: string | null | undefined,
): LineOrgScope | null {
  if (!lineCode) return null;
  for (const [token, org] of LINE_CODE_ORG_TOKENS) {
    if (lineCode.includes(token)) return org;
  }
  return null;
}

// org → line_code 의 org 토큰(parseLineCodeOrg 의 역). 'common' → 'BS'.
//   info 라인 개설 시 line_code 에 이 토큰을 심어 org 노출 범위를 고정한다(토큰 없으면 'common' 폴백 → 전체 누수).
//   parseLineCodeOrg 가 case-sensitive contains 이므로 토큰은 항상 대문자다.
const LINE_ORG_TO_TOKEN: Record<LineOrgScope, string> = {
  common: "BS",
  encre: "EC",
  oranke: "OK",
  phalanx: "PX",
};
export function lineCodeTokenForOrg(org: LineOrgScope): string {
  return LINE_ORG_TO_TOKEN[org];
}

// 마스터 organization_slug 문자열을 LineOrgScope 로 정규화한다.
//   'common' → 'common', 유효 org slug → 그대로, 그 외/빈값 → null(판정 불가 = fail-open).
export function normalizeLineOrg(
  slug: string | null | undefined,
): LineOrgScope | null {
  if (!slug) return null;
  if (slug === "common") return "common";
  return isOrganizationSlug(slug) ? slug : null;
}

// 사용자 org 에 라인을 노출할지 판정한다.
//   - 사용자 org 미상(null)         → 필터 미적용(전부 노출). 사용자 org 를 모르면 거를 기준이 없다.
//   - 라인 org === 'common'          → 노출(전체 공통). info 는 resolveLineOrg 에서 'common' 으로 명시.
//   - 라인 org 판정 불가(null)        → 기본 숨김(fail-closed). 단 opts.allowUnknown=true 면 노출.
//                                       (Step 1 본인 배정 라인만 예외로 허용 — Step 2 openedByWeek 은 숨김.)
//   - 라인 org 가 특정 조직           → 사용자 org 와 같을 때만 노출.
export function isLineVisibleForUserOrg(
  lineOrg: LineOrgScope | null,
  userOrg: OrganizationSlug | null,
  opts: { allowUnknown?: boolean } = {},
): boolean {
  if (!userOrg) return true;
  if (lineOrg === "common") return true;
  if (lineOrg == null) return opts.allowUnknown === true;
  return lineOrg === userOrg;
}
