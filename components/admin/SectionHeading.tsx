import { cn } from "@/lib/utils";

// 어드민 제목 위계 SoT 중 "섹션/하위섹션" 제목 프리미티브.
//   페이지 제목(AdminPageHeader h1)과 카드/모달 제목(CardTitle)을 제외한, 본문 내부의
//   섹션 경계 제목을 하나의 규격으로 통일한다(제각각 h2/h3/div/p/span 위조를 대체).
//
//   level="section"    (기본, h2 기대) — text-base font-semibold + 좌측 액센트 바.
//                       ProcessCheckManager 의 기존 SectionTitle 규격을 승격한 것.
//                       카드 제목(CardTitle, font-medium)과는 굵기+액센트 바로 구별된다.
//   level="subsection" (기본, h3/h4 기대) — text-sm font-semibold, 액센트 바 없음.
//
//   ⚠ 이 컴포넌트는 "제목 스타일"만 담당한다. 제목↔본문 간격/섹션 간 세로 리듬은
//     PageSection(또는 admin-section-stack)이 담당 — 여기에 mt-/mb- 를 넣지 않는다.
//   태그(as)와 시각 위계(level)를 분리 가능: 시맨틱은 as, 크기는 level 로 각각 지정.
//   mode/org 분기 없음(순수 프레젠테이션).
type Level = "section" | "subsection";
type HeadingTag = "h2" | "h3" | "h4";

const LEVEL_CLASS: Record<Level, string> = {
  section: "text-base font-semibold tracking-tight text-foreground",
  subsection: "text-sm font-semibold text-foreground",
};

export default function SectionHeading({
  as = "h2",
  level,
  className,
  children,
}: {
  as?: HeadingTag;
  level?: Level;
  className?: string;
  children: React.ReactNode;
}) {
  const Tag = as;
  // level 미지정 시 태그로 추론: h2=섹션, h3/h4=하위섹션. (명시하면 태그와 무관하게 우선.)
  const effectiveLevel: Level = level ?? (as === "h2" ? "section" : "subsection");

  return (
    <Tag className={cn("flex items-center gap-2", LEVEL_CLASS[effectiveLevel], className)}>
      {effectiveLevel === "section" ? (
        <span aria-hidden className="h-4 w-1 rounded-full bg-primary" />
      ) : null}
      {children}
    </Tag>
  );
}
