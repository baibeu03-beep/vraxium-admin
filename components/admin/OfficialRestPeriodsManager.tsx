"use client";

import { useMemo, useState } from "react";
import { CalendarPlus, Pencil, Power } from "lucide-react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { cn } from "@/lib/utils";

type RestPeriodType = "lunar_new_year" | "chuseok" | "temporary" | "other";

type OfficialRestPeriod = {
  id: string;
  name: string;
  type: RestPeriodType;
  startDate: string;
  endDate: string;
  description: string;
  isActive: boolean;
};

type Draft = {
  name: string;
  type: RestPeriodType;
  startDate: string;
  endDate: string;
  description: string;
};

const TYPE_LABELS: Record<RestPeriodType, string> = {
  lunar_new_year: "설 연휴",
  chuseok: "추석 연휴",
  temporary: "임시 휴식",
  other: "기타",
};

const EMPTY_DRAFT: Draft = {
  name: "",
  type: "temporary",
  startDate: "",
  endDate: "",
  description: "",
};

const INITIAL_PERIODS: OfficialRestPeriod[] = [
  {
    id: "mock-2026-lunar-new-year",
    name: "2026 설 연휴",
    type: "lunar_new_year",
    startDate: "2026-02-16",
    endDate: "2026-02-18",
    description: "2026년 설 명절 공식 휴식",
    isActive: true,
  },
  {
    id: "mock-2026-chuseok",
    name: "2026 추석 연휴",
    type: "chuseok",
    startDate: "2026-09-24",
    endDate: "2026-09-27",
    description: "2026년 추석 명절 공식 휴식",
    isActive: true,
  },
];

function OfficialRestPolicyInfo() {
  return (
    <Card className="border-primary/15 bg-primary/5">
      <CardHeader>
        <CardTitle>공식 휴식 운영 정책</CardTitle>
        <CardDescription>
          시험기간 휴식과 날짜 기반 공식 휴식의 관리 기준입니다.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="space-y-3 text-sm text-foreground/85">
          <ul className="list-disc space-y-1 pl-5">
            <li>시험기간 휴식은 별도 등록하지 않습니다.</li>
            <li>시험기간 휴식은 시스템 정책으로 자동 계산됩니다.</li>
          </ul>
          <div>
            <div className="font-medium text-foreground">적용 규칙</div>
            <ul className="mt-1 list-disc space-y-1 pl-5">
              <li>봄 시즌 6~8주차</li>
              <li>봄 시즌 14~16주차</li>
              <li>가을 시즌 6~8주차</li>
              <li>가을 시즌 14~16주차</li>
            </ul>
          </div>
          <ul className="list-disc space-y-1 pl-5">
            <li>
              위 기간은 seasonCalendar 정책에 의해 자동으로 공식 휴식
              처리됩니다.
            </li>
            <li>
              이 화면에서는 설 연휴, 추석 연휴, 임시 휴식 등 날짜 기반
              공식 휴식만 관리합니다.
            </li>
          </ul>
        </div>
      </CardContent>
    </Card>
  );
}

function StatusBadge({ active }: { active: boolean }) {
  return (
    <span
      className={cn(
        "inline-flex h-6 items-center rounded-md px-2 text-xs font-medium",
        active
          ? "bg-emerald-100 text-emerald-800 ring-1 ring-emerald-200"
          : "bg-muted text-muted-foreground",
      )}
    >
      {active ? "활성" : "비활성"}
    </span>
  );
}

export default function OfficialRestPeriodsManager() {
  const [periods, setPeriods] = useState<OfficialRestPeriod[]>(INITIAL_PERIODS);
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);
  const [editingId, setEditingId] = useState<string | null>(null);

  const activeCount = useMemo(
    () => periods.filter((period) => period.isActive).length,
    [periods],
  );

  const editing = editingId
    ? periods.find((period) => period.id === editingId) ?? null
    : null;

  const canSubmit =
    draft.name.trim().length > 0 &&
    draft.startDate.trim().length > 0 &&
    draft.endDate.trim().length > 0 &&
    draft.startDate <= draft.endDate;

  function resetForm() {
    setDraft(EMPTY_DRAFT);
    setEditingId(null);
  }

  function startEdit(period: OfficialRestPeriod) {
    setEditingId(period.id);
    setDraft({
      name: period.name,
      type: period.type,
      startDate: period.startDate,
      endDate: period.endDate,
      description: period.description,
    });
  }

  function saveDraft() {
    if (!canSubmit) return;

    if (editing) {
      setPeriods((current) =>
        current.map((period) =>
          period.id === editing.id
            ? {
                ...period,
                name: draft.name.trim(),
                type: draft.type,
                startDate: draft.startDate,
                endDate: draft.endDate,
                description: draft.description.trim(),
              }
            : period,
        ),
      );
    } else {
      setPeriods((current) => [
        ...current,
        {
          id: `mock-${Date.now()}`,
          name: draft.name.trim(),
          type: draft.type,
          startDate: draft.startDate,
          endDate: draft.endDate,
          description: draft.description.trim(),
          isActive: true,
        },
      ]);
    }

    resetForm();
  }

  function deactivatePeriod(id: string) {
    setPeriods((current) =>
      current.map((period) =>
        period.id === id ? { ...period, isActive: false } : period,
      ),
    );
    if (editingId === id) resetForm();
  }

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="text-xl font-semibold tracking-normal text-foreground">
          공식 휴식 관리
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          명절 및 임시 공식 휴식 기간을 관리합니다.
        </p>
      </div>

      <OfficialRestPolicyInfo />

      <div className="grid gap-3 sm:grid-cols-3">
        <Card size="sm">
          <CardHeader>
            <CardDescription>전체 기간</CardDescription>
            <CardTitle>{periods.length}개</CardTitle>
          </CardHeader>
        </Card>
        <Card size="sm">
          <CardHeader>
            <CardDescription>활성 기간</CardDescription>
            <CardTitle>{activeCount}개</CardTitle>
          </CardHeader>
        </Card>
        <Card size="sm">
          <CardHeader>
            <CardDescription>데이터 소스</CardDescription>
            <CardTitle>Mock</CardTitle>
          </CardHeader>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>{editing ? "공식 휴식 수정" : "공식 휴식 추가"}</CardTitle>
          <CardDescription>
            현재 화면은 mock 데이터만 사용하며 DB에는 저장하지 않습니다.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="grid gap-3 lg:grid-cols-[1.2fr_0.8fr_0.8fr_0.8fr_1.5fr_auto]">
            <div className="grid gap-1.5">
              <Label htmlFor="rest-name">이름</Label>
              <Input
                id="rest-name"
                value={draft.name}
                onChange={(event) =>
                  setDraft((current) => ({
                    ...current,
                    name: event.target.value,
                  }))
                }
                placeholder="2026 설 연휴"
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="rest-type">유형</Label>
              <select
                id="rest-type"
                value={draft.type}
                onChange={(event) =>
                  setDraft((current) => ({
                    ...current,
                    type: event.target.value as RestPeriodType,
                  }))
                }
                className="h-8 rounded-lg border border-input bg-background px-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
              >
                {Object.entries(TYPE_LABELS).map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="rest-start">시작일</Label>
              <Input
                id="rest-start"
                type="date"
                value={draft.startDate}
                onChange={(event) =>
                  setDraft((current) => ({
                    ...current,
                    startDate: event.target.value,
                  }))
                }
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="rest-end">종료일</Label>
              <Input
                id="rest-end"
                type="date"
                value={draft.endDate}
                onChange={(event) =>
                  setDraft((current) => ({
                    ...current,
                    endDate: event.target.value,
                  }))
                }
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="rest-description">설명</Label>
              <Input
                id="rest-description"
                value={draft.description}
                onChange={(event) =>
                  setDraft((current) => ({
                    ...current,
                    description: event.target.value,
                  }))
                }
                placeholder="운영 기준 메모"
              />
            </div>
            <div className="flex items-end gap-2">
              <Button type="button" onClick={saveDraft} disabled={!canSubmit}>
                <CalendarPlus className="h-4 w-4" />
                {editing ? "수정" : "추가"}
              </Button>
              {editing && (
                <Button type="button" variant="outline" onClick={resetForm}>
                  취소
                </Button>
              )}
            </div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>공식 휴식 기간</CardTitle>
          <CardDescription>날짜 범위 기반 공식 휴식 mock 목록입니다.</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="rounded-md border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>이름</TableHead>
                  <TableHead>유형</TableHead>
                  <TableHead>시작일</TableHead>
                  <TableHead>종료일</TableHead>
                  <TableHead>설명</TableHead>
                  <TableHead>활성 여부</TableHead>
                  <TableHead className="text-right">작업</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {periods.map((period) => (
                  <TableRow
                    key={period.id}
                    className={cn(!period.isActive && "opacity-60")}
                  >
                    <TableCell className="font-medium">{period.name}</TableCell>
                    <TableCell>{TYPE_LABELS[period.type]}</TableCell>
                    <TableCell>{period.startDate}</TableCell>
                    <TableCell>{period.endDate}</TableCell>
                    <TableCell className="max-w-[320px] truncate">
                      {period.description || "-"}
                    </TableCell>
                    <TableCell>
                      <StatusBadge active={period.isActive} />
                    </TableCell>
                    <TableCell>
                      <div className="flex justify-end gap-2">
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          onClick={() => startEdit(period)}
                        >
                          <Pencil className="h-3.5 w-3.5" />
                          수정
                        </Button>
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          onClick={() => deactivatePeriod(period.id)}
                          disabled={!period.isActive}
                        >
                          <Power className="h-3.5 w-3.5" />
                          비활성화
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
