"use client";

import { useMemo, useState } from "react";
import { usePathname, useParams } from "next/navigation";
import { CircleHelp } from "lucide-react";
import { Button } from "@/components/ui/button";
import AdminHelpModal from "@/components/admin/AdminHelpModal";
import { cn } from "@/lib/utils";

// 각 어드민 페이지 제목 영역 우측 [도움말] 버튼 + "관련 도움말" 편집/저장 모달.
//   · 페이지(path)별로 도움말 본문을 조회/저장(공유 모달 AdminHelpModal, API: /api/admin/help).
//   · 저장/조회/권한 판단은 모두 AdminHelpModal 에 위임 — 여기선 트리거 버튼만.
//   · 요소 단위 도움말(돋보기, AdminHelpIconButton)과 같은 시스템을 공유한다(키만 다름).

// 동적 경로는 "레코드별"이 아니라 "라우트 템플릿별" 단일 키를 쓴다 —
//   /admin/members/abc123 → /admin/members/:userId 처럼 param 값을 param 이름으로 치환.
//   (member 상세·주차 상세·조직 크루 등에서 레코드마다 도움말을 다시 작성하지 않도록.)
//   정적 경로는 params 가 비어 pathname 그대로. org/mode 무관 공통 키.
function normalizeHelpPath(
  pathname: string,
  params: Record<string, string | string[]> | null,
): string {
  if (!params) return pathname;
  const replacements: Array<[string, string]> = [];
  for (const [name, val] of Object.entries(params)) {
    const vals = Array.isArray(val) ? val : [val];
    for (const v of vals) {
      if (v) {
        try {
          replacements.push([decodeURIComponent(v), name]);
        } catch {
          replacements.push([v, name]);
        }
      }
    }
  }
  if (replacements.length === 0) return pathname;
  return pathname
    .split("/")
    .map((seg) => {
      if (!seg) return seg;
      let decoded = seg;
      try {
        decoded = decodeURIComponent(seg);
      } catch {
        /* keep raw */
      }
      const hit = replacements.find(([v]) => v === decoded);
      return hit ? `:${hit[1]}` : seg;
    })
    .join("/");
}

type Props = { className?: string };

export default function AdminHelp({ className }: Props) {
  const pathname = usePathname();
  const params = useParams();
  const storageKey = useMemo(
    () => normalizeHelpPath(pathname, params as Record<string, string | string[]> | null),
    [pathname, params],
  );
  const [open, setOpen] = useState(false);

  return (
    <>
      {/* 트리거 버튼 — 눈에 띄는 색(sky)으로 강조. */}
      <Button
        type="button"
        variant="outline"
        onClick={() => setOpen(true)}
        aria-haspopup="dialog"
        title="이 페이지의 관련 도움말"
        className={cn(
          "h-[34px] shrink-0 gap-1.5 border-transparent bg-sky-500 px-3 text-sm font-semibold text-white shadow-sm hover:bg-sky-600 hover:text-white dark:bg-sky-600 dark:hover:bg-sky-500",
          className,
        )}
      >
        <CircleHelp className="size-4" />
        도움말
      </Button>

      <AdminHelpModal open={open} onClose={() => setOpen(false)} storageKey={storageKey} title="관련 도움말" />
    </>
  );
}
