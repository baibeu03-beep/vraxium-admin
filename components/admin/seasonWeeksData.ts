"use client";

import { useEffect, useState } from "react";

// ── 기간 관리(통합) 공용 데이터 훅 ────────────────────────────────────────────
//   /admin/periods/register 통합 페이지의 "기간 등록 폼"과 "기간 정보 목록"이 동일한
//   /api/admin/season-weeks GET 을 각자 호출하지 않도록, 한 번만 조회해 두 곳이 공유한다.
//   · 등록 폼: 중복 검증용 rows(season_key+week_number).
//   · 정보 목록: 표/필터/정렬/페이지네이션 표시.
//   · 등록 성공 시 refetch() 한 번으로 두 곳이 동시에 최신화된다(전체 새로고침 없음).
//   응답 DTO 는 기존과 동일 — 전용 데이터 구조/파라미터를 만들지 않는다(org/mode/test 분기 없음).

export type SeasonSummary = {
  season_key: string;
  season_label: string | null;
  season_name: string | null;
  season_start_date: string | null;
  season_end_date: string | null;
};

export type OfficialRestSource = "season_rule" | "date_period" | "legacy_iso_week";

// 실무 경험 <확장> 류 라인 진행 방식. 서버 DTO(experienceExpansionLineMode)와 동일 union.
//   표 컬럼은 2026-07-16 제거됐으나 DTO 호환을 위해 응답 필드 형상만 유지한다(렌더/정렬 미사용).
export type ExperienceExpansionLineMode = "none" | "online" | "offline";

export type SeasonWeekRow = SeasonSummary & {
  week_id: string;
  week_number: number | null;
  week_label: string;
  week_start_date: string | null;
  week_end_date: string | null;
  is_official_rest: boolean;
  official_rest_sources?: OfficialRestSource[];
  is_current_week: boolean;
  // 전환 주차: 시즌 사이 gap 주차. 직전 시즌에 귀속. 구형 캐시 응답 호환 optional.
  is_transition?: boolean;
  // 사용자 노출용 비고(휴식명/설명) — weeks.holiday_name. 구형 응답 호환 optional.
  holiday_name?: string | null;
  // 실무 경험 확장 류 라인 진행 방식. 구형 응답 호환 optional(누락 시 "none" 취급).
  experienceExpansionLineMode?: ExperienceExpansionLineMode;
};

type ApiPayload = {
  seasons?: SeasonSummary[];
  rows?: SeasonWeekRow[];
  generatedAt?: string;
};

export type SeasonWeeksData = {
  rows: SeasonWeekRow[];
  seasons: SeasonSummary[];
  generatedAt: string | null;
  loading: boolean;
  error: string | null;
  /** 등록 성공/새로고침 시 재조회(전체 페이지 새로고침 대신 데이터만 갱신). */
  refetch: () => void;
};

export function useSeasonWeeksData(): SeasonWeeksData {
  const [rows, setRows] = useState<SeasonWeekRow[]>([]);
  const [seasons, setSeasons] = useState<SeasonSummary[]>([]);
  const [generatedAt, setGeneratedAt] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshTick, setRefreshTick] = useState(0);

  useEffect(() => {
    let cancelled = false;

    const load = async () => {
      setLoading(true);
      setError(null);

      try {
        const res = await fetch("/api/admin/season-weeks", {
          cache: "no-store",
        });
        const json = await res.json();
        if (!res.ok || !json.success) {
          throw new Error(json?.error ?? "Failed to load season weeks.");
        }

        const data = (json.data ?? {}) as ApiPayload;
        if (!cancelled) {
          setRows(data.rows ?? []);
          setSeasons(data.seasons ?? []);
          setGeneratedAt(data.generatedAt ?? null);
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "Failed to load.");
          setRows([]);
          setSeasons([]);
          setGeneratedAt(null);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    void load();

    return () => {
      cancelled = true;
    };
  }, [refreshTick]);

  const refetch = () => setRefreshTick((value) => value + 1);

  return { rows, seasons, generatedAt, loading, error, refetch };
}
