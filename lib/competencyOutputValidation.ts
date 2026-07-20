// 실무 역량 [라인 개설] 아웃풋(링크 1 · 설명 1) 필수 입력 검증 — 프론트/서버 공용 SoT.
//   실무 경험 페이지와 달리 이 허브는 **이미지가 아니라 링크와 설명**이 필수다(별도 정책).
//   공백만 입력한 값은 미입력으로 처리한다. mode=test/operating·모든 org 에서 동일하게 적용.
//   browser-safe: 서버 전용 모듈을 import 하지 않는다(클라 폼 + 개설 API 가 같은 함수를 사용).

// 어떤 필수값이 비어 있는지. null = 둘 다 채워짐(통과).
//   "both" = 링크·설명 모두 누락, "link" = 링크만 누락, "description" = 설명만 누락.
export type CompetencyOutputMissing = "both" | "link" | "description" | null;

function isBlank(value: string | null | undefined): boolean {
  return (value ?? "").trim().length === 0;
}

// 아웃풋 링크 1 · 설명 1 필수 입력 검증. 검증 순서 = 링크 → 설명(첫 누락 항목 기준으로 안내).
export function validateCompetencyOutput(
  link: string | null | undefined,
  description: string | null | undefined,
): CompetencyOutputMissing {
  const linkBlank = isBlank(link);
  const descBlank = isBlank(description);
  if (linkBlank && descBlank) return "both";
  if (linkBlank) return "link";
  if (descBlank) return "description";
  return null;
}

// 누락 유형별 안내 문구(팝업/토스트/서버 에러 공용).
export const COMPETENCY_OUTPUT_MESSAGE: Record<
  Exclude<CompetencyOutputMissing, null>,
  string
> = {
  both: "아웃풋 링크와 설명을 모두 입력해야 개설을 진행할 수 있습니다.",
  link: "아웃풋 링크를 입력해주세요.",
  description: "아웃풋 설명을 입력해주세요.",
};
