export type AdminLineOpeningPart = {
  key: "practical-info" | "practical-experience" | "practical-competency" | "practical-career";
  label: string;
  href: string;
  enabled: boolean;
  model: "career_projects";
};

// "라인 개설" 하위 4개 파트의 canonical 메뉴 정의.
// 현재 라우트가 실제로 존재하는 실무 경력만 enabled=true 로 노출한다.
export const ADMIN_LINE_OPENING_PARTS: AdminLineOpeningPart[] = [
  {
    key: "practical-info",
    label: "실무 정보",
    href: "/admin/line-opening/practical-info",
    enabled: true,
    model: "career_projects",
  },
  {
    key: "practical-experience",
    label: "실무 경험",
    href: "/admin/line-opening/practical-experience",
    enabled: true,
    model: "career_projects",
  },
  {
    key: "practical-competency",
    label: "실무 역량",
    href: "/admin/line-opening/practical-competency",
    enabled: true,
    model: "career_projects",
  },
  {
    key: "practical-career",
    label: "실무 경력",
    href: "/admin/line-opening/practical-career",
    enabled: true,
    model: "career_projects",
  },
];

export const ADMIN_LINE_OPENING_VISIBLE_PARTS = ADMIN_LINE_OPENING_PARTS.filter(
  (part) => part.enabled,
);
