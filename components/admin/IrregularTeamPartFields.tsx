"use client";

// 변동 액트 "소속 팀 / 소속 파트" 필드 — hubGrade='experience' 일 때만 표시(§2).
//   소속 팀 = listTeams 공용 SoT(/api/admin/cluster4/teams, org+mode 스코프) 드롭다운, 필수.
//   소속 파트 = "팀 총괄" 고정(비활성) — 사용자가 바꿀 수 없다. 두 다이얼로그(검수 링크/수동 부여) 공용.

import { useEffect, useState } from "react";
import { cn } from "@/lib/utils";
import { IRREGULAR_PART_SCOPE_LABEL, type IrregularHubGrade } from "@/lib/adminProcessIrregularTypes";
import { appendModeQuery, type ScopeMode } from "@/lib/userScopeShared";

type TeamOption = { id: string; teamName: string };

export function IrregularTeamPartFields({
  hubGrade,
  organization,
  mode,
  teamId,
  setTeamId,
  disabled,
  invalid,
}: {
  hubGrade: IrregularHubGrade | "";
  organization: string;
  mode: ScopeMode;
  teamId: string;
  setTeamId: (v: string) => void;
  disabled?: boolean;
  invalid?: boolean;
}) {
  const [teams, setTeams] = useState<TeamOption[]>([]);
  const [loading, setLoading] = useState(false);

  // 실무 경험 급 선택 시에만 팀 목록 조회(org+mode 스코프 — 공용 팀 원장 SoT).
  useEffect(() => {
    if (hubGrade !== "experience") return;
    let cancelled = false;
    setLoading(true);
    fetch(appendModeQuery(`/api/admin/cluster4/teams?organization=${encodeURIComponent(organization)}`, mode))
      .then((res) => res.json())
      .then((json) => {
        if (cancelled) return;
        const list = (json.success ? (json.data ?? []) : []) as Array<{ id: string; teamName: string }>;
        setTeams(list.map((t) => ({ id: t.id, teamName: t.teamName })));
      })
      .catch(() => {
        if (!cancelled) setTeams([]);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [hubGrade, organization, mode]);

  if (hubGrade !== "experience") return null;

  return (
    <div className="grid grid-cols-2 gap-3">
      <div className="space-y-1">
        <label className="text-xs text-muted-foreground">
          소속 팀 <span className="text-red-500">*</span>
        </label>
        <select
          aria-label="소속 팀"
          value={teamId}
          onChange={(e) => setTeamId(e.target.value)}
          disabled={disabled || loading}
          className={cn(
            "h-9 w-full rounded-md border bg-background px-2 text-sm",
            invalid ? "border-red-500 focus-visible:ring-red-500" : "border-input",
          )}
        >
          <option value="">{loading ? "불러오는 중…" : "선택"}</option>
          {teams.map((t) => (
            <option key={t.id} value={t.id}>
              {t.teamName}
            </option>
          ))}
        </select>
      </div>
      <div className="space-y-1">
        <label className="text-xs text-muted-foreground">소속 파트</label>
        <div
          aria-label="소속 파트"
          className="flex h-9 cursor-not-allowed items-center rounded-md border border-input bg-muted/50 px-2 text-sm text-muted-foreground"
          title="실무 경험 급 변동 액트의 소속 파트는 항상 '팀 총괄'로 고정됩니다"
        >
          {IRREGULAR_PART_SCOPE_LABEL} (고정)
        </div>
      </div>
    </div>
  );
}
