"use client";

import { useEffect, useMemo, useState } from "react";
import { usePathname, useParams, useSearchParams } from "next/navigation";
import { CircleHelp } from "lucide-react";
import { Button } from "@/components/ui/button";
import AdminHelpModal from "@/components/admin/AdminHelpModal";
import { Tooltip } from "@/components/ui/tooltip";
import {
  fetchHelpMeta,
  hasHelpContent,
  helpContentVersion,
  markHelpSeen,
  peekHelpMeta,
  readHelpSeen,
  subscribeHelpMeta,
} from "@/lib/adminHelpEmphasis";
import { resolveAdminOrgFocus } from "@/lib/adminOrgContext";
import { organizationAccent } from "@/lib/organizations";
import { cn } from "@/lib/utils";

// 통합(org 없음) 모드 도움말 버튼 색 — 조직 대표색이 없을 때의 중립 폴백(하늘색).
const HELP_BUTTON_NEUTRAL =
  "border-transparent bg-sky-500 text-white hover:bg-sky-600 hover:text-white dark:bg-sky-600 dark:hover:bg-sky-500";

// 각 어드민 페이지 제목 영역 우측 [도움말] 버튼 + "관련 도움말" 편집/저장 모달.
//   · 페이지(path)별로 도움말 본문을 조회/저장(공유 모달 AdminHelpModal, API: /api/admin/help).
//   · 저장/조회/권한 판단은 모두 AdminHelpModal 에 위임 — 여기선 트리거 버튼만.
//   · 요소 단위 도움말(돋보기, AdminHelpIconButton)과 같은 시스템을 공유한다(키만 다름).
//
// 강조("안내 있음") — 전역 공통 로직(lib/adminHelpEmphasis). 요구: 내용/응답 의미는 불변, "존재/열람"만으로 UI 강조.
//   · 내용 있음 → 우상단 알림 점 + aria "안내 있음". 최초 진입(미열람 버전)이면 가벼운 펄스(유한 반복).
//   · 내용 없음 → 알림 점/펄스 없음(정적). 편집 권한 없으면 비활성화(빈 모달이 열리지 않도록).
//   · 열람하면 같은 페이지에서 다시 펄스하지 않고 점 강조도 낮춘다. 열람 여부는 page키+내용버전으로 저장 →
//     내용이 바뀌면 새 버전이라 다시 신규 안내로 인식한다.
//   · reduced-motion 은 CSS(globals.css .admin-help-nudge/.admin-help-ping)에서 애니메이션을 끈다 —
//     점/배지는 그대로 남아 애니메이션 없이도 존재를 알 수 있다.
//   · org/mode/actAsTestUserId/demoUserId 로 갈라지지 않는다(키만으로 판단, 서버가 mode/org 무시).

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
  const searchParams = useSearchParams();
  const storageKey = useMemo(
    () => normalizeHelpPath(pathname, params as Record<string, string | string[]> | null),
    [pathname, params],
  );
  // 버튼 색 = 현재 화면의 조직 대표색(encre 분홍 / oranke 황금 / phalanx 초록). 통합(org 없음)이면 중립 하늘색.
  //   org 판정 = 화면 컨텍스트 SoT(resolveAdminOrgFocus: /admin/crews/{org} path 또는 ?org). 도움말 내용/응답과 무관.
  const orgButtonAccent =
    organizationAccent(resolveAdminOrgFocus(pathname, searchParams))?.button ?? HELP_BUTTON_NEUTRAL;
  const [open, setOpen] = useState(false);

  // 도움말 "존재/열람" 상태(강조 판단 전용). 본문/권한 판단은 모달이 담당 — 여기선 강조에만 쓴다.
  //   · key 를 함께 담아 페이지 전환 시 stale 여부를 렌더에서 파생한다(effect 내 동기 setState 회피).
  //   · isNew = 최초 진입 강조(펄스 + 밝은 점). 열람 후/이미 본 버전이면 false.
  type HelpState = { key: string; hasContent: boolean; canEdit: boolean; version: string; isNew: boolean };
  const [state, setState] = useState<HelpState | null>(null);

  // 페이지(storageKey) 진입/전환마다 존재 여부 재판단(캐시 hit 이면 즉시). setState 는 async 콜백에서만.
  useEffect(() => {
    let alive = true;
    const applyMeta = ({ content, canEdit }: { content: string; canEdit: boolean }) => {
      if (!alive) return;
      const version = helpContentVersion(content);
      const has = hasHelpContent(content);
      setState({
        key: storageKey,
        hasContent: has,
        canEdit,
        version,
        isNew: has && !readHelpSeen(storageKey, version),
      });
    };
    const cached = peekHelpMeta(storageKey);
    if (cached) applyMeta(cached);
    const unsubscribe = subscribeHelpMeta(storageKey, applyMeta);
    void fetchHelpMeta(storageKey).then(applyMeta);
    return () => {
      alive = false;
      unsubscribe();
    };
  }, [storageKey]);

  // 현재 페이지에 대해 판단이 끝났는가(전환 직후엔 이전 키라 stale → 기본 정적 버튼).
  const resolved = state?.key === storageKey;
  const hasContent = resolved ? state!.hasContent : false;
  const canEdit = resolved ? state!.canEdit : false;
  const version = resolved ? state!.version : "";
  const isNew = resolved ? state!.isNew : false;
  // 내용 없음 + 편집 불가 = 열어도 빈 모달뿐 → 비활성화(빈 모달이 열리지 않게).
  //   편집 가능(owner/admin)은 도움말을 "작성"해야 하므로 활성 유지(정적 버튼, 강조 없음).
  const disabled = resolved && !hasContent && !canEdit;

  const openModal = () => {
    if (disabled) return;
    if (version) markHelpSeen(storageKey, version);
    // 열면 같은 페이지에서 다시 튀지 않음(펄스/밝은 점 해제).
    setState((prev) => (prev && prev.key === storageKey ? { ...prev, isNew: false } : prev));
    setOpen(true);
  };

  const handleClose = () => {
    setOpen(false);
  };

  const ariaLabel = !hasContent
    ? disabled
      ? "이 페이지의 도움말 (등록된 안내 없음)"
      : "이 페이지의 도움말 작성"
    : isNew
      ? "이 페이지의 도움말 열기, 새로운 안내 있음"
      : "이 페이지의 도움말 열기, 안내 있음";

  return (
    <>
      {/* 알림 점을 버튼 모서리에 얹기 위한 relative 래퍼(레이아웃 영향 없음, ml-auto 등은 래퍼가 받음). */}
      <span className={cn("relative inline-flex shrink-0", className)}>
        {/* 트리거 버튼 — 조직 대표색(통합=하늘색). 최초 진입 시에만 가벼운 펄스(유한·reduced-motion 자동 정지). */}
        <Tooltip content={hasContent ? "도움말이 등록되어 있습니다" : ""}>
          <Button
          type="button"
          variant="outline"
          onClick={openModal}
          disabled={disabled}
          aria-haspopup="dialog"
          aria-label={ariaLabel}
          // 안정적 로케이터 — 접근명(aria-label)이 "안내 있음" 등으로 바뀌어도 페이지 도움말 버튼을 특정.
          //   요소 돋보기(AdminHelpIconButton)와 구분(그쪽엔 이 속성 없음).
          data-admin-help-trigger="page"
          title={hasContent ? undefined : disabled ? "이 페이지에 등록된 도움말이 없습니다" : "이 페이지의 관련 도움말"}
          className={cn(
            "h-[34px] shrink-0 gap-1.5 px-3 text-sm font-semibold shadow-sm",
            // 조직 대표색(또는 통합 중립 하늘색). 도움말 강조 로직/열람 상태와 무관하게 색만 조직화.
            orgButtonAccent,
            hasContent && "admin-help-has-content",
            isNew && "admin-help-nudge",
          )}
        >
          <CircleHelp className="size-4" />
          도움말
          </Button>
        </Tooltip>

        {/* 알림 점 — 내용이 있을 때만. 애니메이션이 없어도 존재를 알리는 신호(요구 4). aria 는 라벨이 담당.
            버튼 테두리에 묻히지 않도록 우상단 바깥쪽에 걸치게(-top-1 -right-1) 배치. */}
        {isNew &&
          (
            // 최초 진입=큼직한 amber 점 + 유한 ping(2~3회). 점 크기 확대(size-3.5)로 눈에 잘 띄게.
            <span aria-hidden className="pointer-events-none absolute -top-1 -right-1 flex size-3.5">
              <span className="admin-help-ping absolute inline-flex size-full rounded-full bg-tone-warn opacity-60" />
              <span className="relative inline-flex size-3.5 rounded-full bg-tone-warn ring-2 ring-background" />
            </span>
          )}
      </span>

      <AdminHelpModal open={open} onClose={handleClose} storageKey={storageKey} title="관련 도움말" />
    </>
  );
}
