"use client";

import { useEffect, useMemo, useState } from "react";
import { Search } from "lucide-react";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

type Crew = {
  legacy_user_id: string | number;
  display_name: string;
  team_name: string;
  part_name: string;
  cumulative_weeks: number;
};

const ALL = "__all__";

export default function CrewsPage() {
  const [data, setData] = useState<Crew[]>([]);
  const [search, setSearch] = useState("");
  const [team, setTeam] = useState<string>(ALL);
  const [part, setPart] = useState<string>(ALL);

  useEffect(() => {
    fetch("/api/admin/crews")
      .then((res) => res.json())
      .then((result) => {
        setData((result.data ?? []) as Crew[]);
      });
  }, []);

  const teams = useMemo(
    () =>
      Array.from(new Set(data.map((c) => c.team_name).filter(Boolean))).sort(),
    [data]
  );
  const parts = useMemo(
    () =>
      Array.from(new Set(data.map((c) => c.part_name).filter(Boolean))).sort(),
    [data]
  );

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return data.filter((c) => {
      if (team !== ALL && c.team_name !== team) return false;
      if (part !== ALL && c.part_name !== part) return false;
      if (q && !c.display_name?.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [data, search, team, part]);

  return (
    <div className="flex flex-col gap-6">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <StatCard label="총 인원" value={data.length} />
        <StatCard label="필터 결과" value={filtered.length} />
        <StatCard label="팀 수" value={teams.length} />
      </div>

      <Card>
        <CardHeader>
          <CardTitle>크루 목록</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <div className="flex flex-wrap items-center gap-2">
            <div className="relative w-full sm:w-64">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="이름 검색"
                className="pl-8"
              />
            </div>
            <Select value={team} onValueChange={(v) => setTeam(v ?? ALL)}>
              <SelectTrigger className="w-40">
                <SelectValue placeholder="전체 팀" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL}>전체 팀</SelectItem>
                {teams.map((t) => (
                  <SelectItem key={t} value={t}>
                    {t}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select value={part} onValueChange={(v) => setPart(v ?? ALL)}>
              <SelectTrigger className="w-40">
                <SelectValue placeholder="전체 파트" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL}>전체 파트</SelectItem>
                {parts.map((p) => (
                  <SelectItem key={p} value={p}>
                    {p}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="rounded-md border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>이름</TableHead>
                  <TableHead>팀</TableHead>
                  <TableHead>파트</TableHead>
                  <TableHead className="text-right">주차</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filtered.map((u) => (
                  <TableRow key={u.legacy_user_id}>
                    <TableCell className="font-medium">
                      {u.display_name}
                    </TableCell>
                    <TableCell>{u.team_name}</TableCell>
                    <TableCell>{u.part_name}</TableCell>
                    <TableCell className="text-right">
                      {u.cumulative_weeks}
                    </TableCell>
                  </TableRow>
                ))}
                {filtered.length === 0 && (
                  <TableRow>
                    <TableCell
                      colSpan={4}
                      className="h-24 text-center text-muted-foreground"
                    >
                      결과 없음
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

function StatCard({ label, value }: { label: string; value: number }) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-medium text-muted-foreground">
          {label}
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div className="text-2xl font-semibold">{value}</div>
      </CardContent>
    </Card>
  );
}
