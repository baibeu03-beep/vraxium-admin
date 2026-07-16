"use client";

import { useCallback, useEffect, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { ArrowLeft, ExternalLink, Lock, NotebookPen } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import AdminHelp from "@/components/admin/AdminHelp";
import { AdminDetailTitle } from "@/components/admin/AdminRouteTitleProvider";
import { LoadingState } from "@/components/ui/loading-state";
import { StatusBadge } from "@/components/ui/status-badge";
import { useReportLoading } from "@/components/admin/loadingBannerContext";
import { cn } from "@/lib/utils";
import { pointColorClass } from "@/components/ui/point-value";
import { type ScopeMode } from "@/lib/userScopeShared";
import { buildAdminContextHref } from "@/lib/adminOrgContext";
import { buildCustomerClusterUrl } from "@/lib/customerAppUrl";
import { getProcessPointLabels } from "@/lib/pointLabels";
import {
  CrewIdentityCards,
  type CrewIdentity,
} from "@/components/admin/crew/CrewIdentityCards";
import { CrewNoteDialog, type CrewNote } from "@/components/admin/crew/CrewNoteDialog";
import CrewWeekActHistory from "@/components/admin/CrewWeekActHistory";
import CrewWeekLineHistory from "@/components/admin/CrewWeekLineHistory";
import type { CrewWeekDetailDto } from "@/lib/adminCrewWeekDetail";

// ─────────────────────────────────────────────────────────────────────
// 회원별 · 주차별 상세(관리) 페이지 본문.
//   · 상단 공통(도움말 · 바로가기 3버튼 · 인적사항/클럽 소속)은 회원 상세와 "동일 컴포넌트" 재사용.
//   · 주차 요약 + 4허브 요약 = 크루 페이지(/cluster-4-card)와 동일 SoT DTO(서버 loader) 조회만.
//   · 성장 결과가 진행 중/집계 중이면 수정 잠금 안내(이번 단계는 조회 전용 — 편집 UI 없음).
//   · 탭 = 액트 체크 내역 / 라인 강화 내역(상단 요약 — 하단 라인 상세 표/편집은 후속 단계).
//
// 회원 기본 정보는 회원 상세 API(/api/admin/members/[userId])를 그대로 재사용 → 두 페이지 헤더가
//   바이트 단위로 동일. 주차 데이터는 /api/admin/members/[userId]/weeks/[weekId] 단건 조회.
// ─────────────────────────────────────────────────────────────────────

// 회원 상세 API 응답 중 이 페이지가 소비하는 부분(CrewIdentity 상위집합).
type MemberHeaderDto = CrewIdentity & {
  userId: string; // 실제 user_profiles.user_id (커리어레쥬메 링크용)
  isTestUser: boolean;
  note: CrewNote;
};

const TABS = [
  { key: "acts", label: "액트 체크 내역" },
  { key: "lines", label: "라인 강화 내역" },
] as const;
type TabKey = (typeof TABS)[number]["key"];

function normalizeTab(raw: string | null): TabKey {
  return raw === "lines" ? "lines" : "acts"; // 잘못된 값은 기본 탭(acts)로 보정
}

export default function CrewWeekDetail({
  userId,
  weekId,
  mode,
}: {
  userId: string;
  weekId: string;
  mode: ScopeMode;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const [member, setMember] = useState<MemberHeaderDto | null>(null);
  const [week, setWeek] = useState<CrewWeekDetailDto | null>(null);
  const [loading, setLoading] = useState(true);
  useReportLoading(loading);
  const [error, setError] = useState<string | null>(null);
  const [noteOpen, setNoteOpen] = useState(false);

  // 진입 컨텍스트(mode=test)만 fetch 에 전달 — loader 는 mode 무관(동일 DTO)이나 스코프 게이트가
  //   test 모집단을 요구할 수 있어 컨텍스트를 보존한다.
  const ctxQuery = mode === "test" ? "?mode=test" : "";

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [memberRes, weekRes] = await Promise.all([
        fetch(`/api/admin/members/${userId}${ctxQuery}`, { cache: "no-store" }),
        fetch(`/api/admin/members/${userId}/weeks/${weekId}${ctxQuery}`, { cache: "no-store" }),
      ]);
      const memberJson = await memberRes.json();
      const weekJson = await weekRes.json();
      if (!memberRes.ok || !memberJson.success) {
        throw new Error(memberJson?.error ?? "회원 정보를 불러오지 못했습니다.");
      }
      if (!weekRes.ok || !weekJson.success) {
        throw new Error(weekJson?.error ?? "주차 상세를 불러오지 못했습니다.");
      }
      setMember(memberJson.data as MemberHeaderDto);
      setWeek(weekJson.data as CrewWeekDetailDto);
    } catch (err) {
      setError(err instanceof Error ? err.message : "상세를 불러오지 못했습니다.");
    } finally {
      setLoading(false);
    }
  }, [userId, weekId, ctxQuery]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  // 목록으로 돌아가기 → 이 회원의 회원 상세 페이지(브라우저 history 아닌 명시적 URL). 컨텍스트 보존.
  const goToMemberDetail = useCallback(() => {
    router.push(
      buildAdminContextHref({
        targetPath: `/admin/members/${userId}`,
        pathname,
        searchParams,
      }),
    );
  }, [router, userId, pathname, searchParams]);

  // 커리어레쥬메(크루 페이지 SoT 경로) 새 탭 — 회원 상세와 동일 로직(테스트 유저=데모 배너).
  const openCareerResume = useCallback(() => {
    if (!member) return;
    const url = buildCustomerClusterUrl(member.organizationSlug, member.userId, {
      test: member.isTestUser,
      name: member.displayName,
    });
    if (!url) {
      setError(
        "크루 페이지 URL이 설정되지 않았습니다. 환경변수 NEXT_PUBLIC_CUSTOMER_APP_URL 을 확인해 주세요.",
      );
      return;
    }
    window.open(url, "_blank", "noopener,noreferrer");
  }, [member]);

  // 탭 상태 — URL ?tab 동기화(새로고침 유지). 잘못된 값은 acts 로 보정.
  const tab = normalizeTab(searchParams.get("tab"));
  const setTab = useCallback(
    (next: TabKey) => {
      const params = new URLSearchParams(searchParams.toString());
      params.set("tab", next);
      router.replace(`${pathname}?${params.toString()}`, { scroll: false });
    },
    [router, pathname, searchParams],
  );

  const poLabels = getProcessPointLabels(week?.member.organizationSlug ?? null);

  const memberName = member?.displayName?.trim() || member?.crewCode || null;
  const weekLabel = week?.week.label ?? null;

  const editable = week?.week.editable ?? true;

  return (
    <div className="flex w-full min-w-0 flex-col gap-6 px-4 py-6 sm:px-6">
      {/* 전역 헤더 브레드크럼 끝 2칸 공급: [회원명(→회원 상세 링크), 주차명(현재)]. */}
      <AdminDetailTitle
        items={[
          {
            label: loading ? "불러오는 중" : memberName ?? "회원 상세",
            href: `/admin/members/${userId}`,
          },
          { label: loading ? "불러오는 중" : weekLabel ?? "주차 상세" },
        ]}
      />

      <div className="flex justify-end">
        <AdminHelp />
      </div>

      {/* 상단 3버튼 — 목록(회원 상세)로 / 커리어레쥬메 / 클럽 관리 기록. */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <Button variant="outline" onClick={goToMemberDetail} className="justify-center">
          <ArrowLeft className="h-4 w-4" />
          목록으로 돌아가기
        </Button>
        <Button
          variant="outline"
          onClick={openCareerResume}
          disabled={loading || !member}
          className="justify-center"
        >
          <ExternalLink className="h-4 w-4" />
          크루 : 커리어레쥬메
        </Button>
        <Button
          variant="outline"
          onClick={() => setNoteOpen(true)}
          disabled={loading || !member}
          className="justify-center"
        >
          <NotebookPen className="h-4 w-4" />
          클럽 관리 기록
        </Button>
      </div>

      {error && (
        <div className="rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {error}
        </div>
      )}

      {loading ? (
        <Card>
          <CardContent>
            <LoadingState active />
          </CardContent>
        </Card>
      ) : member && week ? (
        <>
          {/* 상단 공통 카드(인적사항 · 클럽 소속) — 회원 상세와 동일 컴포넌트. */}
          <CrewIdentityCards member={member} />

          {/* 수정 잠금 안내 — 진행 중/집계 중 주차. 조회/탭 이동은 계속 가능. */}
          {!editable && (
            <div className="flex items-start gap-2 rounded-md border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-800 dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-200">
              <Lock className="mt-0.5 h-4 w-4 shrink-0" />
              <span>
                현재 주차는 성장 결과가 <b>{week.week.statusLabel}</b> 상태이므로 데이터를 수정할 수
                없습니다. 성장 결과가 확정된 이후 수정할 수 있으며, 지금은 조회만 가능합니다.
              </span>
            </div>
          )}

          {/* 주차 요약 — 헤더줄(주차명·기간·성장결과·활동주차) + 소속/포인트줄 + 전체 강화율 + 4허브.
              카드 자체의 max-width 를 제한해(넓은 화면 중앙 정렬) 정보 밀도를 높인다 — 관리자 전체
              컨테이너 폭·인적사항 카드·탭 폭에는 영향 없음. 좁은 화면은 w-full. */}
          <div className="mx-auto w-full max-w-5xl">
          <Card>
            <CardContent className="flex flex-col gap-4 pt-6">
              {/* 헤더줄 */}
              <div className="flex flex-col gap-2 border-b pb-4 sm:flex-row sm:items-center sm:justify-between">
                <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                  <span className="text-lg font-bold text-foreground">{week.week.label}</span>
                  <span className="text-sm text-muted-foreground">
                    {fmtDate(week.week.startDate)} ~ {fmtDate(week.week.endDate)}
                  </span>
                </div>
                <div className="flex flex-wrap items-center gap-3">
                  <StatusBadge label={week.week.statusLabel} size="sm" />
                  <span className="text-sm font-medium text-foreground">
                    {week.week.progressLabel}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    · 주차 확인 {week.week.confirmationLabel}
                  </span>
                </div>
              </div>

              {/* 소속 + 포인트줄 — justify-between 금지, 콘텐츠 폭만큼 배치되는 flex + 일정한 gap-x.
                  회원명 뒤만 약간 더 벌린다(mr). 넓으면 한 줄, 좁으면 자연 줄바꿈. */}
              <div className="flex flex-wrap items-center gap-x-8 gap-y-2 text-sm">
                <span className="mr-2 font-semibold text-foreground">
                  {(memberName ?? "-") + " 님"}
                </span>
                <Meta label="클래스" value={week.assignment.classLabel || "-"} />
                <Meta label="팀" value={week.assignment.teamName ?? "-"} />
                <Meta label="파트" value={week.assignment.partName ?? "-"} />
                <Meta
                  label={poLabels.a}
                  value={numOrDash(week.points.star)}
                  valueClassName={pointColorClass("a")}
                />
                <Meta
                  label={poLabels.b}
                  value={numOrDash(week.points.shield)}
                  valueClassName={pointColorClass("b")}
                />
                <Meta
                  label={poLabels.c}
                  value={numOrDash(week.points.pointC)}
                  valueClassName={pointColorClass("c")}
                />
              </div>

              {/* 전체 허브 & 라인(주차 성장률) */}
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md border bg-muted/50 px-4 py-3">
                <span className="text-sm font-semibold text-foreground">전체 허브 &amp; 라인</span>
                <span className="text-sm text-muted-foreground">
                  오픈 {week.growth.totalCount} 개 중 {week.growth.successCount} 개 강화 성공
                </span>
                <span className="ml-auto text-lg font-bold tabular-nums text-foreground">
                  {week.growth.rate}%
                </span>
              </div>

              {/* 4허브 — 2열 그리드(실무 정보/경험/역량/경력). */}
              <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
                {week.hubs.map((h) => (
                  <div
                    key={h.hub}
                    className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md border bg-muted/20 px-4 py-3"
                  >
                    <span className="w-20 shrink-0 whitespace-nowrap text-sm font-medium text-foreground">
                      {h.label}
                    </span>
                    <span className="text-sm text-muted-foreground">
                      오픈 {h.totalCount} 개 중 {h.successCount} 개 강화 성공
                    </span>
                    <span className="ml-auto text-base font-semibold tabular-nums text-foreground">
                      {h.rate}%
                    </span>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
          </div>

          {/* 탭 — 액트 체크 내역 / 라인 강화 내역(2열 풀폭 헤더 + placeholder). */}
          <Card className="overflow-hidden">
            <div className="grid grid-cols-2">
              {TABS.map((t) => {
                const active = tab === t.key;
                return (
                  <button
                    key={t.key}
                    type="button"
                    aria-pressed={active}
                    onClick={() => setTab(t.key)}
                    className={cn(
                      "border-b py-3 text-center text-sm font-semibold outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
                      active
                        ? "border-b-transparent bg-primary text-primary-foreground"
                        : "bg-muted/40 text-muted-foreground hover:bg-muted hover:text-foreground",
                    )}
                  >
                    {t.label}
                  </button>
                );
              })}
            </div>
            <CardContent className="pt-6">
              {tab === "acts" ? (
                <CrewWeekActHistory
                  userId={userId}
                  weekId={weekId}
                  mode={mode}
                  orgSlug={week.member.organizationSlug}
                  onChanged={() => {
                    // 취소 반영 — 주차 요약(별/방패/번개/성장률) 재조회 + 타 표면 revalidate.
                    void load();
                    router.refresh();
                  }}
                />
              ) : (
                <CrewWeekLineHistory
                  userId={userId}
                  weekId={weekId}
                  mode={mode}
                  orgSlug={week.member.organizationSlug}
                />
              )}
            </CardContent>
          </Card>
        </>
      ) : (
        !error && (
          <Card>
            <CardContent>
              <p className="py-8 text-sm text-muted-foreground">
                해당 회원의 주차 정보를 찾을 수 없습니다.
              </p>
            </CardContent>
          </Card>
        )
      )}

      {noteOpen && member && (
        <CrewNoteDialog
          userId={userId}
          displayName={member.displayName}
          crewCode={member.crewCode}
          initialNote={member.note}
          onClose={() => setNoteOpen(false)}
          onSaved={(saved) =>
            setMember((prev) => (prev ? { ...prev, note: saved } : prev))
          }
        />
      )}
    </div>
  );
}

function numOrDash(v: number | null | undefined): string {
  return v == null ? "-" : String(v);
}

// ISO(YYYY-MM-DD) → "2026-05-11(월)". 파싱 불가 시 원문 그대로.
const WEEKDAY_KO = ["일", "월", "화", "수", "목", "금", "토"] as const;
function fmtDate(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso ?? "");
  if (!m) return iso ?? "-";
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  const wd = Number.isNaN(d.getTime()) ? "" : `(${WEEKDAY_KO[d.getDay()]})`;
  return `${m[1]}-${m[2]}-${m[3]}${wd}`;
}

// 인라인 "라벨 값" 한 쌍(소속/포인트 줄).
function Meta({
  label,
  value,
  valueClassName,
}: {
  label: string;
  value: string;
  valueClassName?: string;
}) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className={cn("font-medium text-foreground", valueClassName)}>{value}</span>
    </span>
  );
}
