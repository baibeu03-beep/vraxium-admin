"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import { ArrowDown, ArrowUp, Plus, Trash2 } from "lucide-react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { LoadingState } from "@/components/ui/loading-state";
import { readOrgParam } from "@/lib/adminOrgContext";
import {
  ORGANIZATIONS,
  ORGANIZATION_LABEL,
  isOrganizationSlug,
} from "@/lib/organizations";

type TeamDto = {
  teamName: string;
  teamId: string | null;
  displayOrder: number;
  isActive: boolean;
};

type HalfOption = {
  halfKey: string;
  label: string;
  lastSeasonKey: string | null;
  isCurrent: boolean;
  editable: boolean;
};

type InfoDto = {
  organization: string;
  currentHalfKey: string | null;
  selectedHalfKey: string | null;
  editable: boolean;
  halves: HalfOption[];
  teams: TeamDto[];
};

type Banner = { kind: "success" | "error"; message: string } | null;

const SELECT_CLS =
  "rounded-md border border-input bg-background px-3 py-2 text-sm";

export default function TeamPartsInfoManager() {
  const searchParams = useSearchParams();
  const orgFromUrl = readOrgParam(searchParams);

  const [org, setOrg] = useState<string>(orgFromUrl ?? ORGANIZATIONS[0]);
  const [half, setHalf] = useState<string | null>(null);
  const [data, setData] = useState<InfoDto | null>(null);
  const [loading, setLoading] = useState(true);
  const [banner, setBanner] = useState<Banner>(null);

  // 현재 반기 편집 드래프트(팀명 배열).
  const [draft, setDraft] = useState<string[]>([]);
  const [newTeam, setNewTeam] = useState("");
  const [saving, setSaving] = useState(false);

  const load = useCallback(
    async (organization: string, halfKey: string | null) => {
      setLoading(true);
      setBanner(null);
      try {
        const params = new URLSearchParams({ organization });
        if (halfKey) params.set("half", halfKey);
        const res = await fetch(`/api/admin/team-parts/info?${params.toString()}`, {
          cache: "no-store",
        });
        const json = await res.json();
        if (!res.ok || !json.success) {
          throw new Error(json?.error ?? `조회 실패 (${res.status})`);
        }
        const dto = json.data as InfoDto;
        setData(dto);
        setHalf(dto.selectedHalfKey);
        setDraft(dto.teams.map((t) => t.teamName));
      } catch (e) {
        setData(null);
        setBanner({
          kind: "error",
          message: e instanceof Error ? e.message : "조회 실패",
        });
      } finally {
        setLoading(false);
      }
    },
    [],
  );

  // org 변경 → 현재 반기로 리셋(half=null).
  useEffect(() => {
    void load(org, null);
  }, [org, load]);

  const onOrgChange = (value: string) => {
    if (isOrganizationSlug(value)) {
      setHalf(null);
      setOrg(value);
    }
  };

  const onHalfChange = (value: string) => {
    setHalf(value);
    void load(org, value);
  };

  const editable = data?.editable ?? false;
  const dirty = useMemo(() => {
    if (!data) return false;
    const original = data.teams.map((t) => t.teamName);
    if (original.length !== draft.length) return true;
    return original.some((name, i) => name !== draft[i]);
  }, [data, draft]);

  const addTeam = () => {
    const name = newTeam.trim();
    if (!name) return;
    if (draft.includes(name)) {
      setBanner({ kind: "error", message: "이미 목록에 있는 팀입니다." });
      return;
    }
    setDraft((d) => [...d, name]);
    setNewTeam("");
  };

  const removeTeam = (name: string) =>
    setDraft((d) => d.filter((t) => t !== name));

  const move = (index: number, dir: -1 | 1) => {
    setDraft((d) => {
      const next = [...d];
      const target = index + dir;
      if (target < 0 || target >= next.length) return d;
      [next[index], next[target]] = [next[target], next[index]];
      return next;
    });
  };

  const resetDraft = () => {
    if (data) setDraft(data.teams.map((t) => t.teamName));
  };

  const save = async () => {
    if (!data || !half) return;
    setSaving(true);
    setBanner(null);
    try {
      const res = await fetch(`/api/admin/team-parts/info`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          organization: org,
          halfKey: half,
          teamNames: draft,
        }),
      });
      const json = await res.json();
      if (!res.ok || !json.success) {
        throw new Error(json?.error ?? `저장 실패 (${res.status})`);
      }
      setBanner({ kind: "success", message: "저장되었습니다." });
      await load(org, half);
    } catch (e) {
      setBanner({
        kind: "error",
        message: e instanceof Error ? e.message : "저장 실패",
      });
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>팀 &amp; 파트 정보 — 반기별 팀</CardTitle>
        <CardDescription>
          반기를 선택하면 그 반기가 끝난 시점(마지막 시즌)에 존재한 팀 목록을
          보여줍니다. 현재 반기만 수정할 수 있고, 과거 반기는 조회 전용입니다.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex flex-wrap items-end gap-3">
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-muted-foreground">조직</span>
            <select
              id="team-parts-org-select"
              className={SELECT_CLS}
              value={org}
              onChange={(e) => onOrgChange(e.target.value)}
            >
              {ORGANIZATIONS.map((slug) => (
                <option key={slug} value={slug}>
                  {ORGANIZATION_LABEL[slug]}
                </option>
              ))}
            </select>
          </label>

          <label className="flex flex-col gap-1 text-sm">
            <span className="text-muted-foreground">반기</span>
            <select
              id="team-parts-half-select"
              className={SELECT_CLS}
              value={half ?? ""}
              onChange={(e) => onHalfChange(e.target.value)}
              disabled={loading || !data || data.halves.length === 0}
            >
              {data?.halves.map((h) => (
                <option key={h.halfKey} value={h.halfKey}>
                  {h.label}
                  {h.isCurrent ? " (현재)" : ""}
                </option>
              ))}
            </select>
          </label>

          {data && half ? (
            <span
              className={
                "rounded-md px-2 py-1 text-xs " +
                (editable
                  ? "bg-emerald-50 text-emerald-700"
                  : "bg-muted text-muted-foreground")
              }
            >
              {editable ? "현재 반기 · 수정 가능" : "과거 반기 · 조회 전용"}
            </span>
          ) : null}
        </div>

        {banner ? (
          <div
            className={
              "rounded-md px-3 py-2 text-sm " +
              (banner.kind === "success"
                ? "bg-emerald-50 text-emerald-700"
                : "bg-red-50 text-red-700")
            }
          >
            {banner.message}
          </div>
        ) : null}

        {loading ? (
          <LoadingState active />
        ) : !data || data.halves.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            이 조직에 등록된 반기 팀 데이터가 없습니다.
          </p>
        ) : editable ? (
          <div className="space-y-3">
            <ol className="space-y-2">
              {draft.map((name, i) => (
                <li
                  key={name}
                  className="flex items-center gap-2 rounded-md border border-input px-3 py-2 text-sm"
                >
                  <span className="w-6 text-muted-foreground">{i + 1}</span>
                  <span className="flex-1 font-medium">{name}</span>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    onClick={() => move(i, -1)}
                    disabled={i === 0}
                    aria-label="위로"
                  >
                    <ArrowUp className="h-4 w-4" />
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    onClick={() => move(i, 1)}
                    disabled={i === draft.length - 1}
                    aria-label="아래로"
                  >
                    <ArrowDown className="h-4 w-4" />
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    onClick={() => removeTeam(name)}
                    aria-label="삭제"
                  >
                    <Trash2 className="h-4 w-4 text-red-600" />
                  </Button>
                </li>
              ))}
              {draft.length === 0 ? (
                <li className="text-sm text-muted-foreground">
                  등록된 팀이 없습니다. 아래에서 추가하세요.
                </li>
              ) : null}
            </ol>

            <div className="flex items-center gap-2">
              <Input
                value={newTeam}
                onChange={(e) => setNewTeam(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    addTeam();
                  }
                }}
                placeholder="팀 이름 추가"
                className="max-w-xs"
              />
              <Button type="button" variant="outline" onClick={addTeam}>
                <Plus className="mr-1 h-4 w-4" />
                추가
              </Button>
            </div>

            <div className="flex items-center gap-2 pt-1">
              <Button type="button" onClick={save} disabled={saving || !dirty}>
                {saving ? "저장 중…" : "저장"}
              </Button>
              <Button
                type="button"
                variant="outline"
                onClick={resetDraft}
                disabled={saving || !dirty}
              >
                초기화
              </Button>
            </div>
          </div>
        ) : (
          <ol className="space-y-2">
            {data.teams.map((t, i) => (
              <li
                key={t.teamName}
                className="flex items-center gap-3 rounded-md border border-input px-3 py-2 text-sm"
              >
                <span className="w-6 text-muted-foreground">{i + 1}</span>
                <span className="font-medium">{t.teamName}</span>
              </li>
            ))}
            {data.teams.length === 0 ? (
              <li className="text-sm text-muted-foreground">
                이 반기에 등록된 팀이 없습니다.
              </li>
            ) : null}
          </ol>
        )}
      </CardContent>
    </Card>
  );
}
