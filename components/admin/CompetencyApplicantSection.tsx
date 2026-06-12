"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { Loader2, Search, Plus, X, ExternalLink, Trash2 } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { cn } from "@/lib/utils";
import { readOrgParam } from "@/lib/adminOrgContext";

// 실무 역량 [라인 개설] — [해당 크루] 영역.
//   상단: 요약(활동/신청/개설/반려/신청 라인/개설 라인) + 수동 추가(자동완성 + 추가).
//   본문: 승인 명단 테이블(크루명/라인명/제출 링크/카페/승인/반려 사유) + 반려 사유 팝업.
//   고객 신청 데이터가 존재한다고 가정한 어드민 승인/개설 준비 UI. snapshot 무관.

type ApplicationDto = {
  id: string;
  targetUserId: string;
  crewNo: number | null;
  displayName: string;
  teamName: string | null;
  schoolName: string | null;
  crewLabel: string;
  competencyLineMasterId: string | null;
  lineCode: string | null;
  lineName: string;
  submissionLink: string | null;
  cafeChecked: boolean;
  approvalChecked: boolean;
  rejectionReason: string | null;
  source: "customer" | "manual";
  resolution: "pending" | "opened" | "rejected";
  createdAt: string;
};

type Summary = {
  activeCrews: number;
  appliedCrews: number;
  openedCrews: number;
  rejectedCrews: number;
  appliedLines: number;
  openedLines: number;
};

type CrewSearchItem = {
  userId: string;
  crewNo: number | null;
  name: string;
  teamName: string | null;
  schoolName: string | null;
  majorName: string | null;
};

// 수동 추가 라인명 드롭다운 = 개설 가능한 competency master line(현재 org + 실무 역량 허브).
type MasterItem = {
  id: string; // competency_line_master_id (bridged)
  organizationSlug: string | null;
  lineCode: string;
  lineName: string;
  mainTitle: string | null;
  isActive: boolean;
};

const EMPTY_SUMMARY: Summary = {
  activeCrews: 0,
  appliedCrews: 0,
  openedCrews: 0,
  rejectedCrews: 0,
  appliedLines: 0,
  openedLines: 0,
};

function SummaryChip({ label, value, tone }: { label: string; value: number; tone?: "default" | "success" | "error" | "info" }) {
  return (
    <div
      className={cn(
        "min-w-[68px] rounded-md border px-3 py-1.5 text-center",
        tone === "success" && "border-green-200 bg-green-50",
        tone === "error" && "border-red-200 bg-red-50",
        tone === "info" && "border-blue-200 bg-blue-50",
        (!tone || tone === "default") && "border-gray-200 bg-gray-50",
      )}
    >
      <p className="text-lg font-bold leading-none">{value}</p>
      <p className="mt-1 text-[11px] text-muted-foreground">{label}</p>
    </div>
  );
}

export default function CompetencyApplicantSection({ refreshKey }: { refreshKey?: number }) {
  const searchParams = useSearchParams();
  const org = readOrgParam(searchParams);

  const [apps, setApps] = useState<ApplicationDto[]>([]);
  const [summary, setSummary] = useState<Summary>(EMPTY_SUMMARY);
  const [loading, setLoading] = useState(true);
  const [banner, setBanner] = useState<{ kind: "success" | "error"; message: string } | null>(null);

  // 수동 추가 자동완성.
  const [q, setQ] = useState("");
  const [results, setResults] = useState<CrewSearchItem[]>([]);
  const [searching, setSearching] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [selectedCrew, setSelectedCrew] = useState<CrewSearchItem | null>(null);
  const searchRef = useRef<HTMLDivElement>(null);

  // 수동 추가 팝업.
  const [addOpen, setAddOpen] = useState(false);
  // 라인명은 자유 입력이 아니라 master 드롭다운 선택(오타/미존재 라인 방지).
  const [addMasterId, setAddMasterId] = useState("");
  const [addLink, setAddLink] = useState("");
  const [saving, setSaving] = useState(false);
  // 개설 가능한 competency master line 목록(현재 org 관련 + 활성).
  const [masters, setMasters] = useState<MasterItem[]>([]);

  // 반려 사유 팝업.
  const [rejectApp, setRejectApp] = useState<ApplicationDto | null>(null);
  const [rejectDraft, setRejectDraft] = useState("");

  // 수동 추가 항목 삭제 확인 팝업(source='manual' 만).
  const [deleteApp, setDeleteApp] = useState<ApplicationDto | null>(null);

  const fetchData = useCallback(async () => {
    setLoading(true);
    try {
      const qs = org ? `?organization=${encodeURIComponent(org)}` : "";
      const res = await fetch(`/api/admin/cluster4/competency/applications${qs}`);
      const json = await res.json();
      if (json?.success) {
        setApps(json.data?.applications ?? []);
        setSummary(json.data?.summary ?? EMPTY_SUMMARY);
      } else {
        setApps([]);
        setSummary(EMPTY_SUMMARY);
      }
    } catch {
      setApps([]);
      setSummary(EMPTY_SUMMARY);
    } finally {
      setLoading(false);
    }
  }, [org]);

  useEffect(() => {
    void fetchData();
  }, [fetchData, refreshKey]);

  // 개설 가능한 competency master line 목록(실무 역량 허브). 활성 + (org 일치 OR 공통)만.
  // ⚠ 엔드포인트에 organization 을 넘기면 org 일치만 반환(공통 제외)되므로, 전체를 받아 클라이언트에서
  //    (org 일치 OR 공통) 으로 필터한다 — 고객 가시성(common=전 org 노출)과 정합.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/admin/cluster4/competency-line-masters`);
        const json = await res.json();
        if (cancelled) return;
        const rows: MasterItem[] = (json?.success ? json.data ?? [] : []).filter(
          (m: MasterItem) =>
            m.isActive && (!m.organizationSlug || m.organizationSlug === "common" || m.organizationSlug === org),
        );
        setMasters(rows);
      } catch {
        if (!cancelled) setMasters([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [org]);

  // 자동완성 검색(디바운스). cafe-line-crew GET 재사용 — 크루 번호+이름+학교 반환.
  useEffect(() => {
    const term = q.trim();
    if (!term || selectedCrew?.name === term) {
      setResults([]);
      return;
    }
    let cancelled = false;
    const t = setTimeout(async () => {
      setSearching(true);
      try {
        const res = await fetch(`/api/admin/cluster4/cafe-line-crew?q=${encodeURIComponent(term)}`);
        const json = await res.json();
        if (cancelled) return;
        setResults(json?.success ? (json.data?.crews ?? []) : []);
        setMenuOpen(true);
      } catch {
        if (!cancelled) setResults([]);
      } finally {
        if (!cancelled) setSearching(false);
      }
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [q, selectedCrew]);

  // 검색 드롭다운 바깥 클릭 닫기.
  useEffect(() => {
    if (!menuOpen) return;
    const onDown = (e: MouseEvent) => {
      if (searchRef.current && !searchRef.current.contains(e.target as Node)) setMenuOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [menuOpen]);

  const pickCrew = useCallback((c: CrewSearchItem) => {
    setSelectedCrew(c);
    const no = c.crewNo != null ? String(c.crewNo).padStart(4, "0") : "----";
    setQ(`${no} - ${c.name}`);
    setMenuOpen(false);
  }, []);

  const openAddPopup = useCallback(() => {
    if (!selectedCrew) {
      setBanner({ kind: "error", message: "추가할 크루를 검색해 선택해주세요" });
      return;
    }
    setAddMasterId("");
    setAddLink("");
    setAddOpen(true);
  }, [selectedCrew]);

  const submitAdd = useCallback(async () => {
    if (!org || !selectedCrew) return;
    const master = masters.find((m) => m.id === addMasterId);
    if (!master) {
      setBanner({ kind: "error", message: "라인을 드롭다운에서 선택해주세요" });
      return;
    }
    setSaving(true);
    setBanner(null);
    try {
      const res = await fetch("/api/admin/cluster4/competency/applications", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          organization: org,
          target_user_id: selectedCrew.userId,
          // line_master_id + line_code + line_name 함께 저장(자유 입력 아님).
          competency_line_master_id: master.id,
          line_code: master.lineCode,
          line_name: master.lineName,
          submission_link: addLink.trim() || null,
        }),
      });
      const json = await res.json();
      if (!json.success) {
        setBanner({ kind: "error", message: json.error ?? "수동 추가 실패" });
        return;
      }
      setBanner({ kind: "success", message: "승인 명단에 추가되었습니다" });
      setAddOpen(false);
      setSelectedCrew(null);
      setQ("");
      await fetchData();
    } catch {
      setBanner({ kind: "error", message: "수동 추가 중 오류" });
    } finally {
      setSaving(false);
    }
  }, [org, selectedCrew, masters, addMasterId, addLink, fetchData]);

  const patchApp = useCallback(
    async (id: string, patch: Record<string, unknown>) => {
      try {
        const res = await fetch(`/api/admin/cluster4/competency/applications/${id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(patch),
        });
        const json = await res.json();
        if (!json.success) {
          setBanner({ kind: "error", message: json.error ?? "변경 실패" });
          return false;
        }
        await fetchData();
        return true;
      } catch {
        setBanner({ kind: "error", message: "변경 중 오류" });
        return false;
      }
    },
    [fetchData],
  );

  // 수동 추가 항목 삭제(고객 신청은 X 버튼 자체가 없음 + 서버 source 게이트로 이중 차단).
  const submitDelete = useCallback(async () => {
    if (!deleteApp) return;
    setSaving(true);
    setBanner(null);
    try {
      const res = await fetch(`/api/admin/cluster4/competency/applications/${deleteApp.id}`, {
        method: "DELETE",
      });
      const json = await res.json();
      if (!json.success) {
        setBanner({ kind: "error", message: json.error ?? "삭제 실패" });
        return;
      }
      setBanner({ kind: "success", message: "수동 추가 항목이 삭제되었습니다" });
      setDeleteApp(null);
      await fetchData();
    } catch {
      setBanner({ kind: "error", message: "삭제 중 오류" });
    } finally {
      setSaving(false);
    }
  }, [deleteApp, fetchData]);

  const submitReject = useCallback(async () => {
    if (!rejectApp) return;
    setSaving(true);
    const ok = await patchApp(rejectApp.id, { rejection_reason: rejectDraft.trim() || null });
    setSaving(false);
    if (ok) {
      setBanner({ kind: "success", message: "반려 사유가 저장되었습니다" });
      setRejectApp(null);
      setRejectDraft("");
    }
  }, [rejectApp, rejectDraft, patchApp]);

  return (
    <Card>
      <CardHeader className="pb-3">
        {/* 헤더: 제목 + 요약 + 수동 추가 (우측 같은 행, 좁으면 wrap) */}
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <CardTitle className="text-base">해당 크루</CardTitle>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <SummaryChip label="활동 크루" value={summary.activeCrews} />
            <SummaryChip label="신청 크루" value={summary.appliedCrews} tone="info" />
            <SummaryChip label="개설 크루" value={summary.openedCrews} tone="success" />
            <SummaryChip label="반려 크루" value={summary.rejectedCrews} tone="error" />
            <SummaryChip label="신청 라인" value={summary.appliedLines} tone="info" />
            <SummaryChip label="개설 라인" value={summary.openedLines} tone="success" />
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {banner && (
          <div
            className={cn(
              "flex items-start justify-between gap-2 rounded-md border px-3 py-2 text-sm",
              banner.kind === "success"
                ? "border-green-300 bg-green-50 text-green-800"
                : "border-red-300 bg-red-50 text-red-800",
            )}
          >
            <span>{banner.message}</span>
            <button onClick={() => setBanner(null)}>
              <X className="h-4 w-4" />
            </button>
          </div>
        )}

        {/* 수동 추가 — 자동완성 검색 + [추가] */}
        <div className="flex flex-wrap items-end gap-2">
          <div className="min-w-[260px] flex-1 space-y-1">
            <Label className="text-xs text-muted-foreground">수동 추가 (크루 번호 + 이름 검색)</Label>
            <div className="relative" ref={searchRef}>
              <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                className="pl-9"
                placeholder="크루 이름 검색..."
                value={q}
                onChange={(e) => {
                  setQ(e.target.value);
                  setSelectedCrew(null);
                }}
                onFocus={() => results.length > 0 && setMenuOpen(true)}
                aria-label="수동 추가 크루 검색"
              />
              {menuOpen && (
                <div className="absolute z-20 mt-1 max-h-60 w-full overflow-y-auto rounded-md border bg-background py-1 shadow-md">
                  {searching ? (
                    <p className="flex items-center gap-1.5 px-3 py-2 text-sm text-muted-foreground">
                      <Loader2 className="h-3.5 w-3.5 animate-spin" /> 검색 중…
                    </p>
                  ) : results.length === 0 ? (
                    <p className="px-3 py-2 text-sm text-muted-foreground">검색 결과가 없습니다</p>
                  ) : (
                    results.map((c) => (
                      <button
                        key={c.userId}
                        type="button"
                        onClick={() => pickCrew(c)}
                        className="block w-full px-3 py-1.5 text-left text-sm hover:bg-muted"
                      >
                        <span className="font-mono text-xs text-muted-foreground">
                          {c.crewNo != null ? String(c.crewNo).padStart(4, "0") : "----"}
                        </span>{" "}
                        <span className="font-medium">{c.name}</span>{" "}
                        <span className="text-xs text-muted-foreground">
                          {[c.teamName, c.schoolName].filter(Boolean).join(" · ")}
                        </span>
                      </button>
                    ))
                  )}
                </div>
              )}
            </div>
          </div>
          <Button type="button" onClick={openAddPopup} disabled={!selectedCrew || !org}>
            <Plus className="mr-1 h-4 w-4" /> 추가
          </Button>
        </div>

        {/* 승인 명단 테이블 */}
        {loading ? (
          <div className="flex items-center justify-center py-10">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          </div>
        ) : apps.length === 0 ? (
          <p className="py-8 text-center text-sm text-muted-foreground">
            신청 데이터가 없습니다. (크루 신청 또는 수동 추가 시 표시됩니다)
          </p>
        ) : (
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>크루명</TableHead>
                  <TableHead>라인명</TableHead>
                  <TableHead>제출 링크</TableHead>
                  <TableHead className="text-center">카페</TableHead>
                  <TableHead className="text-center">승인</TableHead>
                  <TableHead>반려 사유</TableHead>
                  <TableHead className="w-10" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {apps.map((a) => (
                  <TableRow key={a.id}>
                    <TableCell className="whitespace-nowrap font-medium">
                      {a.crewLabel}
                      {a.source === "manual" && (
                        <span className="ml-1.5 rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-medium text-amber-800">
                          수동
                        </span>
                      )}
                    </TableCell>
                    <TableCell>
                      <div className="font-medium">{a.lineName}</div>
                      {a.lineCode && (
                        <div className="font-mono text-[10px] text-muted-foreground">{a.lineCode}</div>
                      )}
                    </TableCell>
                    <TableCell className="max-w-[220px]">
                      {a.submissionLink ? (
                        <a
                          href={a.submissionLink}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="inline-flex items-center gap-1 truncate text-sky-700 underline underline-offset-2 hover:text-sky-900"
                        >
                          <ExternalLink className="h-3.5 w-3.5 shrink-0" />
                          <span className="truncate">{a.submissionLink}</span>
                        </a>
                      ) : (
                        <span className="text-muted-foreground">-</span>
                      )}
                    </TableCell>
                    <TableCell className="text-center">
                      <input
                        type="checkbox"
                        className="rounded border-gray-300"
                        checked={a.cafeChecked}
                        onChange={(e) => patchApp(a.id, { cafe_checked: e.target.checked })}
                        aria-label={`${a.displayName} 카페 체크`}
                      />
                    </TableCell>
                    <TableCell className="text-center">
                      <input
                        type="checkbox"
                        className="rounded border-gray-300"
                        checked={a.approvalChecked}
                        onChange={(e) => patchApp(a.id, { approval_checked: e.target.checked })}
                        aria-label={`${a.displayName} 승인 체크`}
                      />
                    </TableCell>
                    <TableCell>
                      {a.approvalChecked ? (
                        <span className="text-xs text-muted-foreground">-</span>
                      ) : (
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          className="border-red-300 text-red-700 hover:bg-red-50"
                          onClick={() => {
                            setRejectApp(a);
                            setRejectDraft(a.rejectionReason ?? "");
                          }}
                        >
                          반려 사유
                          {a.rejectionReason ? " ✓" : ""}
                        </Button>
                      )}
                    </TableCell>
                    <TableCell className="text-right">
                      {/* X 삭제는 수동 추가(source='manual') 항목에만. 고객 신청(customer)은 버튼 미표시. */}
                      {a.source === "manual" ? (
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          className="h-7 w-7"
                          onClick={() => setDeleteApp(a)}
                          aria-label={`${a.displayName} 수동 추가 삭제`}
                          title="수동 추가 항목 삭제"
                        >
                          <X className="h-4 w-4 text-red-500" />
                        </Button>
                      ) : null}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </CardContent>

      {/* 수동 추가 팝업 */}
      {addOpen && selectedCrew && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
          onClick={() => !saving && setAddOpen(false)}
        >
          <div
            className="w-full max-w-md space-y-4 rounded-lg bg-background p-5 shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="text-base font-bold">수동 추가</h3>
            <p className="text-sm text-muted-foreground">
              {selectedCrew.crewNo != null ? String(selectedCrew.crewNo).padStart(4, "0") : "----"} -{" "}
              {selectedCrew.name}
              {selectedCrew.teamName ? ` - ${selectedCrew.teamName}` : ""}
            </p>
            <div className="space-y-1">
              <Label className="text-xs text-muted-foreground">
                라인명 <span className="text-red-500">*</span>
              </Label>
              {/* 자유 입력 금지 — 개설 가능한 competency master line 드롭다운에서만 선택(오타/미존재 방지). */}
              <select
                className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                value={addMasterId}
                onChange={(e) => setAddMasterId(e.target.value)}
                aria-label="수동 추가 라인명"
              >
                <option value="">라인을 선택하세요</option>
                {masters.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.lineName} ({m.lineCode})
                  </option>
                ))}
              </select>
              {masters.length === 0 && (
                <p className="text-[11px] text-amber-600">
                  선택 가능한 실무 역량 라인이 없습니다. (라인 등록 확인 필요)
                </p>
              )}
            </div>
            <div className="space-y-1">
              <Label className="text-xs text-muted-foreground">제출 링크</Label>
              <Input
                value={addLink}
                onChange={(e) => setAddLink(e.target.value)}
                placeholder="https://... (output link 2)"
                aria-label="수동 추가 제출 링크"
              />
            </div>
            <div className="flex justify-end gap-2 pt-1">
              <Button variant="outline" onClick={() => setAddOpen(false)} disabled={saving}>
                취소
              </Button>
              <Button onClick={submitAdd} disabled={saving}>
                {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}확인
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* 반려 사유 팝업 */}
      {rejectApp && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
          onClick={() => !saving && setRejectApp(null)}
        >
          <div
            className="w-full max-w-md space-y-4 rounded-lg bg-background p-5 shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="text-base font-bold">반려 사유</h3>
            <dl className="space-y-1.5 rounded-md border bg-muted/30 px-3 py-2 text-sm">
              <div className="flex gap-2">
                <dt className="w-16 shrink-0 text-muted-foreground">크루명</dt>
                <dd className="min-w-0 break-words font-medium">{rejectApp.crewLabel}</dd>
              </div>
              <div className="flex gap-2">
                <dt className="w-16 shrink-0 text-muted-foreground">라인명</dt>
                <dd className="font-medium">{rejectApp.lineName}</dd>
              </div>
              <div className="flex gap-2">
                <dt className="w-16 shrink-0 text-muted-foreground">제출 링크</dt>
                <dd className="min-w-0 break-all">
                  {rejectApp.submissionLink ? (
                    <a
                      href={rejectApp.submissionLink}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-sky-700 underline underline-offset-2"
                    >
                      {rejectApp.submissionLink}
                    </a>
                  ) : (
                    "-"
                  )}
                </dd>
              </div>
            </dl>
            <div className="space-y-1">
              <Label className="text-xs text-muted-foreground">반려 사유</Label>
              <textarea
                className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                rows={4}
                value={rejectDraft}
                onChange={(e) => setRejectDraft(e.target.value)}
                placeholder="반려 사유를 입력하세요"
              />
            </div>
            <div className="flex justify-end gap-2 pt-1">
              <Button variant="outline" onClick={() => setRejectApp(null)} disabled={saving}>
                취소
              </Button>
              <Button onClick={submitReject} disabled={saving}>
                {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}확인
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* 수동 추가 삭제 확인 팝업 */}
      {deleteApp && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
          onClick={() => !saving && setDeleteApp(null)}
        >
          <div
            className="w-full max-w-sm space-y-4 rounded-lg bg-background p-5 shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="flex items-center gap-2 text-base font-bold">
              <Trash2 className="h-4 w-4 text-red-500" /> 수동 추가 삭제
            </h3>
            <p className="text-sm text-muted-foreground">
              아래 수동 추가 항목을 승인 명단에서 삭제하시겠습니까? (되돌릴 수 없음)
            </p>
            <dl className="space-y-1.5 rounded-md border bg-muted/30 px-3 py-2 text-sm">
              <div className="flex gap-2">
                <dt className="w-16 shrink-0 text-muted-foreground">크루명</dt>
                <dd className="min-w-0 break-words font-medium">{deleteApp.crewLabel}</dd>
              </div>
              <div className="flex gap-2">
                <dt className="w-16 shrink-0 text-muted-foreground">라인명</dt>
                <dd className="font-medium">{deleteApp.lineName}</dd>
              </div>
            </dl>
            <div className="flex justify-end gap-2 pt-1">
              <Button variant="outline" onClick={() => setDeleteApp(null)} disabled={saving}>
                취소
              </Button>
              <Button
                onClick={submitDelete}
                disabled={saving}
                className="bg-red-600 text-white hover:bg-red-700"
              >
                {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}삭제
              </Button>
            </div>
          </div>
        </div>
      )}
    </Card>
  );
}
