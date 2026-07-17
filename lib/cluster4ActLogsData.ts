// Detail Log 액트 내역(actLogs) 로더 — weekly-cards snapshot 에 baking 할 per-week 데이터.
// ─────────────────────────────────────────────────────────────────────
// 1차 범위 = "수행/적립된 액트 내역"만(미수행/미적립 예정 액트·미스 row 제외 — 후속 Phase).
// SoT = process_point_awards(사용자·주차 적립 원장). 원장 행 = "이 크루가 받은 액트" 이므로
//   변동>부분 대상자 필터(recipients match_type='matched' / manual_grant target_user_id)가
//   원장 생성 단계(processPointAccrual)에서 이미 적용됨 — 여기서 재판정하지 않는다.
// 포인트(A/B/C) = 원장 적립값(수동 override 포함 실제 부여값) 그대로. 마스터 재읽기 아님.
// 액트 상세 JOIN:
//   regular  : ref_id=process_check_statuses.id → act_id → process_acts(+process_line_groups)
//   irregular: ref_id=process_irregular_acts.id (허브/라인급 비귀속 → hub/lineGroupName=null)
// 주차 매핑: 원장은 (year=iso_year, week_number=iso_week) 키 → weeks(iso_year,iso_week)로 해석한다.
//   카드 배분 키 = weeks.start_date(YYYY-MM-DD). ⚠ weekId 로 묶지 않는다 — 성장 파이프라인이 일부
//   주차에 합성 weekId(00000000-…)를 쓰므로(기간정보 충돌 주차 등) 원장의 실제 weeks.id 와
//   카드의 weekId 가 같은 주라도 달라질 수 있다. startDate 는 양쪽 모두 weeks.start_date 파생이라 안전.
// 스코프: 원장은 user_id 로 필터 — 한 사용자의 원장은 단일 scope(test|operating). 카드 snapshot 도
//   user 단위라 demoUserId(테스트) 경로는 그 테스트 사용자의 원장을 그대로 본다(추가 필터 불필요).
// ⚠ process_* 미적용 환경: 모든 select 가 PGRST205 등으로 실패 → 빈 맵 반환(카드 보호, actLogs=[]).
// ─────────────────────────────────────────────────────────────────────

import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { processPointAwardsHasCancelColumns } from "@/lib/processPointAwardsCancelState";
import type {
  Cluster4ActLogDto,
  Cluster4ActLogSource,
} from "@/shared/cluster4.contracts";

type AwardRow = {
  id: string;
  source: string;
  ref_id: string;
  year: number;
  week_number: number; // = iso_week
  point_check: number;
  point_advantage: number;
  point_penalty: number;
  cancelled_at?: string | null;
  cancel_reason?: string | null;
};

// ── 액트 체크 기록 판별 (원장 source 축 — 단일 SoT) ───────────────────────────
//   process_point_awards.source = AccrualSource("regular" | "irregular" | "line") — 원장 자신의
//   생성 경로 필드다(processPointAccrual 이 적립 시 기록). 이게 액트와 라인 강화를 가르는 **유일한**
//   안정 기준이다 — 라벨/이름/포인트 0 여부 같은 표시값으로 추정하지 않는다.
//
//   · regular   = 정규 액트 체크(process_check_statuses → process_acts)   → 액트 내역 ✅
//   · irregular = 변동 액트(process_irregular_acts)                        → 액트 내역 ✅
//   · line      = **라인 개설/강화 지급**(ref_id = cluster4_lines.id, 2026-07-13 도입) → 제외 ❌
//                 이 행은 "라인 강화 내역" 탭(getCrewWeekLineSummary)이 담당한다.
//
//   ⚠ 버그 이력(2026-07-17 수정): 이 로더가 user_id 로만 필터해 line 원장까지 읽었다. line 행은
//     아래 분기에서 irregular 로 취급돼 ref_id(=line_id)로 process_irregular_acts 를 조회 →
//     매칭 실패 → actName/kind="" · occurredAt=null 인 빈 행이 되어 화면에 "-" 로 노출됐다
//     (실측: 한 사용자 24행 중 8행). DTO 의 source 타입에 "line" 이 없는데도 캐스팅이 이를 가렸다.
//   ⚠ 미래 방어: source 에 새 값이 추가되면 **액트로 자동 편입되지 않는다**(allowlist 방식).
//     새 지급 경로는 여기 명시적으로 넣어야 액트 내역에 나타난다.
const ACT_CHECK_SOURCES: readonly Cluster4ActLogSource[] = ["regular", "irregular"];

export function isActualActCheckLog(row: { source: string }): boolean {
  return (ACT_CHECK_SOURCES as readonly string[]).includes(row.source);
}

// userId 의 적립 원장 → startDate(YYYY-MM-DD) 버킷 actLogs 맵. 실패/미적용 시 빈 맵(카드 보호).
//   호출부는 card.startDate 로 조회해 카드에 배분한다(weekId 아님 — 위 주차 매핑 주석 참고).
//   opts.includeCancelled(기본 false): 소프트 취소된 원장 행을 목록에 포함할지.
//     · 고객/snapshot 경로 = false → 취소 액트는 목록에서 빠진다(포인트는 이미 합산 제외).
//     · 관리자 액트 탭    = true  → 취소 액트도 cancelled=true 로 노출("취소됨" 표시).
export async function loadActLogsByStartDate(
  profileUserId: string,
  opts?: { includeCancelled?: boolean },
): Promise<Map<string, Cluster4ActLogDto[]>> {
  const includeCancelled = opts?.includeCancelled ?? false;
  const empty = new Map<string, Cluster4ActLogDto[]>();

  // id(PK)는 항상 존재. cancelled_at/cancel_reason 은 마이그레이션 적용 시에만 조회(미적용 시 42703 회귀 방지).
  const hasCancel = await processPointAwardsHasCancelColumns();
  const selectCols = hasCancel
    ? "id,source,ref_id,year,week_number,point_check,point_advantage,point_penalty,cancelled_at,cancel_reason"
    : "id,source,ref_id,year,week_number,point_check,point_advantage,point_penalty";

  // ⚠ source 필터 필수 — user_id 만으로 필터하면 라인 강화 지급(source='line') 원장까지 딸려온다.
  //   DB 단에서 거른다(가져와서 버리지 않는다): 아래 ref JOIN·주차 매핑도 액트 행만 대상으로 돈다.
  const awardsRes = await supabaseAdmin
    .from("process_point_awards")
    .select(selectCols)
    .eq("user_id", profileUserId)
    .in("source", ACT_CHECK_SOURCES as readonly string[]);
  if (awardsRes.error) {
    // 미적용(PGRST205)·일시 오류 — 빈 맵(카드 보호). 무거운 폴백 없음.
    console.warn("[actLogs] process_point_awards 조회 실패(빈 맵 폴백)", {
      userId: profileUserId,
      code: (awardsRes.error as { code?: string }).code,
    });
    return empty;
  }
  // 동적 select 문자열은 supabase 타입 파서가 추론하지 못하므로 unknown 경유 캐스팅.
  let awards = (awardsRes.data ?? []) as unknown as AwardRow[];
  // 2차 방어 — DB 필터가 (쿼리 수정 등으로) 뚫려도 액트 아닌 원장이 DTO 에 닿지 못하게 한다.
  //   source 타입이 "regular"|"irregular" 인데 캐스팅으로 'line' 이 새던 게 원래 버그였다.
  awards = awards.filter(isActualActCheckLog);
  // 취소 행 제외(기본) — 고객 목록에서 취소 액트를 숨긴다. 관리자 탭(includeCancelled)만 유지.
  if (!includeCancelled) awards = awards.filter((a) => !a.cancelled_at);
  if (awards.length === 0) return empty;

  const regularRefIds = [
    ...new Set(awards.filter((a) => a.source === "regular").map((a) => a.ref_id)),
  ];
  const irregularRefIds = [
    ...new Set(awards.filter((a) => a.source === "irregular").map((a) => a.ref_id)),
  ];

  // ── 정규: status → act → line_group ──
  type StatusRow = {
    id: string;
    act_id: string;
    requested_at: string | null;
    completed_at: string | null;
  };
  type ActRow = {
    id: string;
    act_name: string;
    hub: string | null;
    line_group_id: string | null;
    duration_minutes: number | null;
    act_type: string | null;
  };
  const statusById = new Map<string, StatusRow>();
  const actById = new Map<string, ActRow>();
  const lineGroupNameById = new Map<string, string>();
  if (regularRefIds.length) {
    const st = await supabaseAdmin
      .from("process_check_statuses")
      .select("id,act_id,requested_at,completed_at")
      .in("id", regularRefIds);
    for (const r of (st.data ?? []) as StatusRow[]) statusById.set(r.id, r);

    const actIds = [...new Set([...statusById.values()].map((s) => s.act_id))];
    if (actIds.length) {
      const acts = await supabaseAdmin
        .from("process_acts")
        .select("id,act_name,hub,line_group_id,duration_minutes,act_type")
        .in("id", actIds);
      for (const a of (acts.data ?? []) as ActRow[]) actById.set(a.id, a);

      const lgIds = [
        ...new Set(
          [...actById.values()]
            .map((a) => a.line_group_id)
            .filter((id): id is string => Boolean(id)),
        ),
      ];
      if (lgIds.length) {
        const lgs = await supabaseAdmin
          .from("process_line_groups")
          .select("id,name")
          .in("id", lgIds);
        for (const g of (lgs.data ?? []) as { id: string; name: string }[]) {
          lineGroupNameById.set(g.id, g.name);
        }
      }
    }
  }

  // ── 변동: irregular act 마스터 ──
  type IrregularRow = {
    id: string;
    act_name: string;
    duration_minutes: number | null;
    crew_reaction: string | null;
    scheduled_check_at: string | null;
    created_at: string | null;
  };
  const irregularById = new Map<string, IrregularRow>();
  if (irregularRefIds.length) {
    const irr = await supabaseAdmin
      .from("process_irregular_acts")
      .select("id,act_name,duration_minutes,crew_reaction,scheduled_check_at,created_at")
      .in("id", irregularRefIds);
    for (const r of (irr.data ?? []) as IrregularRow[]) irregularById.set(r.id, r);
  }

  // ── 주차 매핑: (iso_year, iso_week) → { startDate, seasonWeekNumber } ──
  const years = [...new Set(awards.map((a) => a.year))];
  const isoWeeks = [...new Set(awards.map((a) => a.week_number))];
  const weekByIso = new Map<string, { startDate: string; weekNumber: number }>();
  if (years.length && isoWeeks.length) {
    const wk = await supabaseAdmin
      .from("weeks")
      .select("iso_year,iso_week,week_number,start_date")
      .in("iso_year", years)
      .in("iso_week", isoWeeks);
    for (const w of (wk.data ?? []) as {
      iso_year: number;
      iso_week: number;
      week_number: number | null;
      start_date: string;
    }[]) {
      const key = `${w.iso_year}-${w.iso_week}`;
      if (!weekByIso.has(key)) {
        weekByIso.set(key, { startDate: w.start_date, weekNumber: w.week_number ?? 0 });
      }
    }
  }

  // ── 원장 → actLog row ──
  const out = new Map<string, Cluster4ActLogDto[]>();
  for (const a of awards) {
    const week = weekByIso.get(`${a.year}-${a.week_number}`);
    if (!week) continue; // 카드에 붙일 startDate 미해석 → 스킵(소비처 없음).

    // isActualActCheckLog 통과 행만 남았으므로 여기서 source 는 실제로 regular|irregular 다
    //   (그 보장 없이 캐스팅하던 것이 'line' 행을 irregular 로 오인하게 만든 원인).
    const source: Cluster4ActLogSource = a.source === "regular" ? "regular" : "irregular";
    let actName = "";
    let hub: string | null = null;
    let lineGroupName: string | null = null;
    let durationMinutes = 0;
    let kind = "";
    let occurredAt: string | null = null;
    let requestedAt: string | null = null;

    if (source === "regular") {
      const st = statusById.get(a.ref_id);
      const act = st ? actById.get(st.act_id) : undefined;
      if (act) {
        actName = act.act_name;
        hub = act.hub;
        lineGroupName = act.line_group_id
          ? lineGroupNameById.get(act.line_group_id) ?? null
          : null;
        durationMinutes = act.duration_minutes ?? 0;
        kind = act.act_type ?? "";
      }
      requestedAt = st?.requested_at ?? null;
      occurredAt = st?.completed_at ?? st?.requested_at ?? null;
    } else {
      const irr = irregularById.get(a.ref_id);
      if (irr) {
        actName = irr.act_name;
        durationMinutes = irr.duration_minutes ?? 0;
        kind = irr.crew_reaction ?? "";
        occurredAt = irr.scheduled_check_at ?? irr.created_at ?? null;
      }
      // 변동은 허브/라인급 비귀속 — hub/lineGroupName/requestedAt = null 유지.
    }

    const row: Cluster4ActLogDto = {
      weekNumber: week.weekNumber,
      result: "checked",
      actName,
      occurredAt,
      requestedAt,
      hub,
      lineGroupName,
      durationMinutes,
      pointA: a.point_check ?? 0,
      pointB: a.point_advantage ?? 0,
      pointC: a.point_penalty ?? 0,
      source,
      kind,
      awardId: a.id,
      cancelled: Boolean(a.cancelled_at),
      cancelReason: a.cancel_reason ?? null,
    };
    const list = out.get(week.startDate);
    if (list) list.push(row);
    else out.set(week.startDate, [row]);
  }

  // 주차 내 정렬: occurredAt(없으면 맨 뒤) → actName.
  for (const list of out.values()) {
    list.sort((x, y) => {
      const xo = x.occurredAt ?? "";
      const yo = y.occurredAt ?? "";
      if (xo !== yo) return xo < yo ? -1 : 1;
      return x.actName < y.actName ? -1 : x.actName > y.actName ? 1 : 0;
    });
  }
  return out;
}
