import Link from "next/link";
import { cn } from "@/lib/utils";

// 어드민 페이지 공통 상단 헤더 — 모든 어드민 페이지의 상단 구조(제목·설명·탭)를 통일한다.
//   - title       : 페이지/섹션 제목 (필수)
//   - description : 선택적 설명 문구
//   - tabs        : 선택적 탭 배열. 없으면 제목(+설명)만 렌더.
//
// 탭 스타일은 기존 글로벌 Header.tsx 의 라인 개설/멤버 탭과 동일한 디자인 토큰을 쓴다
// (active = bg-foreground/text-background, inactive = muted + hover). href 는 호출부가
// org/tab 등 쿼리스트링을 보존해 만들어 넘긴다 — 이 컴포넌트는 표시 전용(라우팅/스코프 무관).
export type AdminPageHeaderTab = {
  label: string;
  href: string;
  active?: boolean;
};

type AdminPageHeaderProps = {
  title: string;
  description?: string;
  tabs?: AdminPageHeaderTab[];
};

export default function AdminPageHeader({
  title,
  description,
  tabs,
}: AdminPageHeaderProps) {
  const hasTabs = Array.isArray(tabs) && tabs.length > 0;

  return (
    <div className="flex flex-col gap-3">
      <div className="space-y-1">
        <h1 className="text-lg font-semibold tracking-tight text-foreground">
          {title}
        </h1>
        {description ? (
          <p className="text-sm text-muted-foreground">{description}</p>
        ) : null}
      </div>

      {hasTabs ? (
        <nav
          aria-label="페이지 탭"
          className="flex flex-wrap items-center gap-1"
        >
          {tabs!.map((t) => (
            <Link
              key={t.href}
              href={t.href}
              aria-current={t.active ? "page" : undefined}
              className={cn(
                "rounded-md px-3.5 py-1.5 text-sm font-semibold transition-colors",
                t.active
                  ? "bg-foreground text-background"
                  : "text-muted-foreground hover:bg-muted hover:text-foreground",
              )}
            >
              {t.label}
            </Link>
          ))}
        </nav>
      ) : null}
    </div>
  );
}
