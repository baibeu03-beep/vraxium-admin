"use client";

// 체크 완료 크루 명단 — 검수 링크 팝업 / 수동 입력 팝업 공용(중복 구현 금지).
//   컬럼: 이름 · 소속 팀 · 소속 파트 · 클래스. status==="completed" 일 때만 노출(호출부 판단).
//   read-only — DTO(completedCrewList)를 그대로 표시. 인원 수 헤더 + 표.

import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { type ProcessCheckCrewDto } from "@/lib/adminProcessCheckTypes";

export default function ProcessCheckCompletedCrewList({
  crews,
}: {
  crews: ProcessCheckCrewDto[];
}) {
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium text-muted-foreground">체크 크루</span>
        <span className="text-xs font-semibold tabular-nums text-foreground">{crews.length}명</span>
      </div>
      <div className="overflow-x-auto rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>이름</TableHead>
              <TableHead>소속 팀</TableHead>
              <TableHead>소속 파트</TableHead>
              <TableHead>클래스</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {crews.length === 0 ? (
              <TableRow>
                <TableCell colSpan={4} className="py-4 text-center text-xs text-muted-foreground">
                  아직 체크된 크루가 없습니다.
                </TableCell>
              </TableRow>
            ) : (
              crews.map((c, i) => (
                <TableRow key={c.userId ?? `nick-${i}`}>
                  <TableCell className="font-medium">{c.name}</TableCell>
                  <TableCell>{c.teamName ?? "-"}</TableCell>
                  <TableCell>{c.partName ?? "-"}</TableCell>
                  <TableCell>{c.className}</TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
