"use client";

import { useCallback, useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
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
import { CAREER_GRADES, CAREER_GRADE_POINTS } from "@/lib/careerGrade";
import type {
  CareerEvaluationTargetDto,
  CareerGrade,
} from "@/lib/adminCareerEvaluationsTypes";

type CareerLineOption = {
  id: string;
  lineCode: string | null;
  mainTitle: string;
};

type Banner = { kind: "success" | "error"; message: string } | null;

const RATING_STATUS_LABEL: Record<
  CareerEvaluationTargetDto["ratingStatus"],
  string
> = {
  unevaluated: "미평가",
  success: "강화 성공",
  fail: "강화 실패",
};

// 운영자 평가는 작성기간과 무관(지난 주차도 입력/수정 가능). D(2점)=강화 실패.
export default function CareerEvaluationTab({
  lines,
}: {
  lines: CareerLineOption[];
}) {
  const [selectedLineId, setSelectedLineId] = useState<string>("");
  const [targets, setTargets] = useState<CareerEvaluationTargetDto[]>([]);
  const [loading, setLoading] = useState(false);
  const [savingTargetId, setSavingTargetId] = useState<string | null>(null);
  const [banner, setBanner] = useState<Banner>(null);
  // 행별 grade 선택 임시값 (저장 전).
  const [draftGrade, setDraftGrade] = useState<Record<string, CareerGrade | "">>({});

  const loadTargets = useCallback(async (lineId: string) => {
    if (!lineId) {
      setTargets([]);
      setDraftGrade({});
      return;
    }
    setLoading(true);
    setBanner(null);
    try {
      const res = await fetch(
        `/api/admin/cluster4/career-evaluations?line_id=${encodeURIComponent(lineId)}`,
      );
      const json = await res.json();
      if (!res.ok || !json.success) {
        throw new Error(json.error ?? "대상자 평가를 불러오지 못했습니다.");
      }
      const rows = (json.data?.targets ?? []) as CareerEvaluationTargetDto[];
      setTargets(rows);
      setDraftGrade(
        Object.fromEntries(rows.map((r) => [r.lineTargetId, r.grade ?? ""])),
      );
    } catch (e) {
      setBanner({ kind: "error", message: e instanceof Error ? e.message : String(e) });
      setTargets([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadTargets(selectedLineId);
  }, [selectedLineId, loadTargets]);

  async function handleSave(target: CareerEvaluationTargetDto) {
    const grade = draftGrade[target.lineTargetId];
    if (!grade) {
      setBanner({ kind: "error", message: "등급(S/A/B/C/D)을 선택해주세요." });
      return;
    }
    setSavingTargetId(target.lineTargetId);
    setBanner(null);
    try {
      const res = await fetch("/api/admin/cluster4/career-evaluations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          line_target_id: target.lineTargetId,
          user_id: target.userId,
          grade,
        }),
      });
      const json = await res.json();
      if (!res.ok || !json.success) {
        throw new Error(json.error ?? "평가 저장에 실패했습니다.");
      }
      // 로컬 상태 갱신 (재조회 없이 즉시 반영).
      setTargets((prev) =>
        prev.map((t) =>
          t.lineTargetId === target.lineTargetId
            ? {
                ...t,
                grade,
                gradePoints: CAREER_GRADE_POINTS[grade],
                ratingStatus: CAREER_GRADE_POINTS[grade] <= 3 ? "fail" : "success",
              }
            : t,
        ),
      );
      setBanner({
        kind: "success",
        message: `${target.displayName ?? target.userId} 평가 저장 완료 (${grade} = ${CAREER_GRADE_POINTS[grade]}점)`,
      });
    } catch (e) {
      setBanner({ kind: "error", message: e instanceof Error ? e.message : String(e) });
    } finally {
      setSavingTargetId(null);
    }
  }

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">경력 라인 평가</CardTitle>
          <CardDescription>
            개설된 실무 경력 라인의 대상자별 평점(S/A/B/C/D)을 입력합니다. 점수 환산 S=10·A=8·B=6·C=4·D=2,
            D(2점)는 강화 실패로 처리됩니다. 운영자 평가는 작성기간과 무관하게 입력·수정할 수 있습니다.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="space-y-1">
            <Label className="text-xs text-muted-foreground">평가 대상 라인</Label>
            <select
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
              value={selectedLineId}
              onChange={(e) => setSelectedLineId(e.target.value)}
            >
              <option value="">실무 경력 라인을 선택해주세요</option>
              {lines.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.lineCode ? `[${l.lineCode}] ` : ""}
                  {l.mainTitle}
                </option>
              ))}
            </select>
          </div>

          {banner && (
            <p
              className={
                banner.kind === "success"
                  ? "text-sm font-medium text-green-600"
                  : "text-sm font-medium text-red-600"
              }
            >
              {banner.message}
            </p>
          )}
        </CardContent>
      </Card>

      {selectedLineId && (
        <Card>
          <CardContent className="pt-6">
            {loading ? (
              <div className="flex items-center justify-center py-10 text-muted-foreground">
                <Loader2 className="mr-2 h-4 w-4 animate-spin" /> 불러오는 중…
              </div>
            ) : targets.length === 0 ? (
              <p className="py-10 text-center text-sm text-muted-foreground">
                이 라인에 배정된 대상자가 없습니다.
              </p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>대상자</TableHead>
                    <TableHead>등급</TableHead>
                    <TableHead>점수</TableHead>
                    <TableHead>강화 상태</TableHead>
                    <TableHead className="text-right">저장</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {targets.map((t) => {
                    const draft = draftGrade[t.lineTargetId] ?? "";
                    return (
                      <TableRow key={t.lineTargetId}>
                        <TableCell className="font-medium">
                          {t.displayName ?? t.userId}
                        </TableCell>
                        <TableCell>
                          <select
                            className="rounded-md border border-input bg-background px-2 py-1 text-sm"
                            value={draft}
                            onChange={(e) =>
                              setDraftGrade((prev) => ({
                                ...prev,
                                [t.lineTargetId]: e.target.value as CareerGrade | "",
                              }))
                            }
                          >
                            <option value="">미입력</option>
                            {CAREER_GRADES.map((g) => (
                              <option key={g} value={g}>
                                {g} ({CAREER_GRADE_POINTS[g]}점)
                              </option>
                            ))}
                          </select>
                        </TableCell>
                        <TableCell>
                          {draft ? `${CAREER_GRADE_POINTS[draft]}점` : "-"}
                        </TableCell>
                        <TableCell>
                          <span
                            className={
                              t.ratingStatus === "fail"
                                ? "text-red-600"
                                : t.ratingStatus === "success"
                                  ? "text-green-600"
                                  : "text-muted-foreground"
                            }
                          >
                            {RATING_STATUS_LABEL[t.ratingStatus]}
                          </span>
                        </TableCell>
                        <TableCell className="text-right">
                          <Button
                            size="sm"
                            onClick={() => handleSave(t)}
                            disabled={savingTargetId === t.lineTargetId || !draft}
                          >
                            {savingTargetId === t.lineTargetId && (
                              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                            )}
                            저장
                          </Button>
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
