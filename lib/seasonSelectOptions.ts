// 어드민 시즌·주차 화면(기간 등록 /admin/periods/register · 기간 정보 /admin/season-weeks)
// 공용 드롭다운 옵션 SoT.
//   · 목적: "옵션 목록에 보이는 label" 과 "선택 후 닫힌 트리거에 보이는 label" 을 동일하게 통일.
//   · value(저장/전송/필터값)는 각 페이지 계약대로 유지하고, label(표시 문구)만 정규화한다.
//   · 두 페이지가 같은 의미(연도·계절)의 드롭다운을 쓰므로 label 변환을 페이지마다
//     하드코딩하지 않고 이 파일 하나를 재사용한다.

export type SelectOption = { value: string; label: string };

// 닫힌 트리거 표시값 = 옵션 목록과 동일한 items SoT 의 label.
//   현재 value 에 대응하는 option 을 찾아 그 label 을 반환한다(없으면 value 그대로).
//   공용 SelectValue 래퍼는 items 라벨을 조회하지 않고 raw value 를 그대로 노출하므로,
//   base-ui 표준 <Select.Value> children 포매터에 그대로 넘겨 items→label 을 명시 해석한다.
export function itemLabel(
  items: ReadonlyArray<SelectOption>,
  value: string,
): string {
  return items.find((it) => it.value === value)?.label ?? value;
}

// ── 연도 (기획 고정값 2022~2026, 최신 순) ─────────────────────────────────────
//   value = "{YYYY}" (API/필터 계약값 그대로) · label = "{YYYY}년".
export const YEAR_VALUES = ["2026", "2025", "2024", "2023", "2022"] as const;
export type YearValue = (typeof YEAR_VALUES)[number];

export const YEAR_OPTIONS: readonly SelectOption[] = YEAR_VALUES.map((y) => ({
  value: y,
  label: `${y}년`,
}));

// ── 계절/시즌 (value = 영문 토큰, label = 한글) ───────────────────────────────
export type SeasonToken = "spring" | "summer" | "autumn" | "winter";

export const SEASON_LABEL: Record<SeasonToken, string> = {
  spring: "봄",
  summer: "여름",
  autumn: "가을",
  winter: "겨울",
};

// 지정 순서로 시즌 옵션 생성 — 노출 순서가 페이지마다 다르므로 order 를 받는다.
//   (기간 등록: 겨울·봄·여름·가을 / 기간 정보: 봄·여름·가을·겨울)
export function seasonOptions(
  order: readonly SeasonToken[],
): SelectOption[] {
  return order.map((key) => ({ value: key, label: SEASON_LABEL[key] }));
}
