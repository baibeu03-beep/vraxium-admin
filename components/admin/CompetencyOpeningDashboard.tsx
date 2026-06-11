"use client";

import { useCallback, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { Loader2, X, CheckCircle2, RotateCcw } from "lucide-react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { readOrgParam } from "@/lib/adminOrgContext";
import LineOpeningStatusBoard from "@/components/admin/LineOpeningStatusBoard";
import CompetencyOpeningLogPanel from "@/components/admin/CompetencyOpeningLogPanel";

// 실무 역량 [라인 개설] 탭 — 운영 대시보드.
//   상태창(허브 전체 1문장) + 로그창 + [개설 완료]/[개설 취소] 버튼.
//   개설 완료/취소 = 대상 주차 + org + part_type=competency 라인 is_active 토글(고객 반영) + snapshot markStale.
//   파트장 신청/검수 단계 없음 — 허브 전체 1회 토글. snapshot 생성/조회·기존 라인 생성 흐름 무변경.

type Banner = { kind: "success" | "error"; message: string } | null;

export default function CompetencyOpeningDashboard() {
  const searchParams = useSearchParams();
  const org = readOrgParam(searchParams);

  const [opened, setOpened] = useState<boolean | null>(null);
  const [loadingStatus, setLoadingStatus] = useState(true);
  const [acting, setActing] = useState(false);
  const [banner, setBanner] = useState<Banner>(null);
  // 상태창·로그창 재조회 신호 — 개설 완료/취소 직후 증가.
  const [refreshKey, setRefreshKey] = useState(0);

  const fetchStatus = useCallback(async () => {
    setLoadingStatus(true);
    try {
      const qs = org ? `?organization=${encodeURIComponent(org)}` : "";
      const res = await fetch(`/api/admin/cluster4/competency/opening-status${qs}`);
      const json = await res.json();
      setOpened(json?.success ? Boolean(json.data?.opened) : null);
    } catch {
      setOpened(null);
    } finally {
      setLoadingStatus(false);
    }
  }, [org]);

  useEffect(() => {
    void fetchStatus();
  }, [fetchStatus]);

  const runAction = useCallback(
    async (action: "open" | "cancel") => {
      if (!org) {
        setBanner({ kind: "error", message: "조직(?org)이 지정되지 않았습니다" });
        return;
      }
      if (action === "open" && !confirm("실무 역량 허브 전체 라인을 개설 완료(고객 반영)하시겠습니까?"))
        return;
      if (
        action === "cancel" &&
        !confirm("실무 역량 허브 전체 개설을 취소(고객 반영 원복)하시겠습니까?")
      )
        return;
      setActing(true);
      setBanner(null);
      try {
        const res = await fetch("/api/admin/cluster4/competency/opening", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action, organization: org }),
        });
        const json = await res.json();
        if (!json.success) {
          setBanner({ kind: "error", message: json.error ?? "처리에 실패했습니다" });
          return;
        }
        const d = json.data ?? {};
        setBanner({
          kind: "success",
          message:
            action === "open"
              ? `개설 완료 — 역량 라인 ${d.linesChanged ?? 0}/${d.linesTotal ?? 0}개 반영`
              : `개설 취소 — 역량 라인 ${d.linesChanged ?? 0}/${d.linesTotal ?? 0}개 원복`,
        });
        setRefreshKey((k) => k + 1);
        await fetchStatus();
      } catch {
        setBanner({ kind: "error", message: "처리 중 오류가 발생했습니다" });
      } finally {
        setActing(false);
      }
    },
    [org, fetchStatus],
  );

  return (
    <div className="space-y-4">
      {banner && (
        <div
          className={cn(
            "rounded-md border px-4 py-3 text-sm",
            banner.kind === "success"
              ? "border-green-300 bg-green-50 text-green-800"
              : "border-red-300 bg-red-50 text-red-800",
          )}
        >
          {banner.message}
          <button className="float-right" onClick={() => setBanner(null)}>
            <X className="h-4 w-4" />
          </button>
        </div>
      )}

      <div className="grid items-start gap-4 lg:grid-cols-2">
        <LineOpeningStatusBoard hub="competency" refreshKey={refreshKey} />
        <CompetencyOpeningLogPanel refreshKey={refreshKey} />
      </div>

      {/* 개설 완료 / 개설 취소 */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">개설 완료 / 개설 취소</CardTitle>
          <CardDescription>
            [실무 역량] 허브 전체(대상 주차) 라인을 고객 페이지에 반영(개설 완료)하거나
            원복(개설 취소)합니다. 파트장 신청/검수 단계가 없어 1회 동작입니다.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-wrap items-center gap-3">
          <Button
            onClick={() => runAction("open")}
            disabled={acting || loadingStatus || !org}
          >
            {acting ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <CheckCircle2 className="mr-2 h-4 w-4" />
            )}
            개설 완료
          </Button>
          <Button
            variant="outline"
            className="border-red-300 text-red-700 hover:bg-red-50"
            onClick={() => runAction("cancel")}
            // 기본적으로 개설 완료(opened) 상태일 때만 enabled.
            disabled={acting || loadingStatus || !org || opened !== true}
          >
            {acting ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <RotateCcw className="mr-2 h-4 w-4" />
            )}
            개설 취소
          </Button>
          {!org && (
            <span className="text-sm text-muted-foreground">
              조직(?org)이 지정되어야 개설/취소할 수 있습니다.
            </span>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
