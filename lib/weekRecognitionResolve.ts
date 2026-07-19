// 오픈확인 확정 설정 → 주차별 인정 개수 N 입력 해석 + 계산/미설정 검증.  [Phase 3]
//
//   확정 정책(2026-07-11 · experience 중복 합산은 2026-07-19 폐기):
//    - 라인 SoT: info=activity_types.id · experience=(org,category) 팀공유(config_key=category 별
//      조직·주차당 최대 1회 — 팀 instance 수 무관) · competency=해당 주차 target 걸린 master 만 · career/club 없음.
//    - 액트: process_acts(가동=openConfirmed && 라인급 체크 && check_target='check'). A=required·B=basic외.
//      experience 액트는 동일 act_id 를 조직·주차당 최대 1회만 합산("팀 시작"/"파트 시작"은 별개 act_id 라
//      각각 1회). team_id/instance 수는 오픈 여부 판단 근거로만 쓰고 합산 횟수를 늘리지 않는다.
//    - Point.A=point_check · Point.B=point_advantage · C 제외.
//
//   fail-closed(§7·table-applied 일 때만): 포인트 config 테이블 + recognition 저장 컬럼이 실제 적용된
//   환경에서만, 오픈된 라인 중 config row 부재/NULL 인 항목이 있으면 오픈확인을 차단(422). 마이그 전
//   (테이블/컬럼 미적용)이면 기존 오픈확인 흐름 유지 + A/B/N 저장 생략(graceful degradation·무회귀).
//   미설정 판정은 라인 config(cluster4_line_point_configs)에만 적용 — 액트 포인트는 process_acts 고유값.
//   Point.A=0 / Point.B=0 은 정상 설정값(configured). org/mode 무분기(같은 함수·mode=팀 스코프만).

import { supabaseAdmin } from "@/lib/supabaseAdmin";
import type { OrganizationSlug } from "@/lib/organizations";
import {
  EXPERIENCE_LINE_TYPES,
  type SavedConfig,
} from "@/lib/adminTeamPartsInfoWeekDetailData";
import { loadLinePointConfigs } from "@/lib/weekRecognitionConfig";
import {
  computeWeekRecognitionCount,
  RECOGNITION_CALC_VERSION,
  type RecognitionActInput,
  type RecognitionLineInput,
  type RecognitionCountResult,
} from "@/lib/weekRecognitionCount";

type ActType = "required" | "optional" | "selection" | "basic";
type LineHub = "info" | "experience" | "competency";

// 미설정 오픈 항목(fail-closed 오류 메시지용). configKey 기준 dedupe.
export type MissingPointConfig = {
  hub: LineHub;
  configKey: string;
  hubLabel: string; // 실무 정보 / 실무 경험 / 실무 역량
  label: string; // 활동유형명 · 카테고리명 · 역량 라인명
};

const HUB_LABEL: Record<LineHub, string> = {
  info: "실무 정보",
  experience: "실무 경험",
  competency: "실무 역량",
};

// experience 카테고리 표시명(도출·분석·견문·관리·확장 — 정본 순서).
const EXP_LABEL: Record<string, string> = {
  derive: "도출",
  analysis: "분석",
  research: "견문",
  management: "관리",
  expansion: "확장",
};

// config.actCheck.<hub>[key] 기본 체크 = true(mergeActCheck 정책과 동일). 명시 false 만 미가동.
function actChecked(v: boolean | undefined): boolean {
  return v !== false;
}

export async function resolveRecognitionInputs(opts: {
  weekId: string;
  organization: OrganizationSlug;
  config: SavedConfig;
  openConfirmed: boolean;
}): Promise<{
  acts: RecognitionActInput[];
  lines: RecognitionLineInput[];
  pointConfigAvailable: boolean;
  missing: MissingPointConfig[];
}> {
  const { weekId, organization, config, openConfirmed } = opts;
  // 팀 집합 = 저장된 config 키(SoT). listTeams(mode) 불필요 → operating/test 분기 없음.
  const lineTeamIds = Object.keys(config.practicalExperience ?? {});
  const actTeamIds = Object.keys(config.actCheck?.experience ?? {});
  const pointCfg = await loadLinePointConfigs(organization);
  const lines: RecognitionLineInput[] = [];
  const acts: RecognitionActInput[] = [];
  const missingMap = new Map<string, MissingPointConfig>();

  // 오픈 라인의 미설정(config row 부재/NULL)을 기록 — 테이블 적용 시에만 의미. configKey 로 dedupe.
  const flagMissing = (hub: LineHub, configKey: string, label: string) => {
    if (!pointCfg.available) return; // 마이그 전 = 미설정 검사 안 함(graceful)
    if (pointCfg.isConfigured(hub, configKey)) return;
    missingMap.set(`${hub}:${configKey}`, { hub, configKey, hubLabel: HUB_LABEL[hub], label });
  };

  // ── 라인 ────────────────────────────────────────────────────────────────
  // info: activity_types(practical_info) 각 1라인. config_key = activity_types.id.
  const { data: atData } = await supabaseAdmin
    .from("activity_types")
    .select("id, name")
    .eq("cluster_id", "practical_info")
    .eq("is_active", true);
  for (const at of (atData ?? []) as Array<{ id: string; name: string | null }>) {
    const isOpen = openConfirmed && config.practicalInfo?.[at.id] === true;
    const p = pointCfg.get("info", at.id);
    lines.push({ id: `info:${at.id}`, hub: "info", isOpen, pointA: p.pointA, pointB: p.pointB });
    if (isOpen) flagMissing("info", at.id, at.name ?? at.id);
  }

  // experience: config_key = category enum(type). 라인 config 는 팀 공통(team/part scope 구분 없음·
  //   포인트는 pointCfg.get("experience", type) 로 team_id 무관) → 조직·주차당 config_key 별 최대 1회만
  //   합산한다. team_id/instance 수는 "해당 type 이 열렸는지" 판단 근거로만 쓰고 합산 횟수를 늘리지 않는다.
  //   isOpen = 어느 한 팀이라도 그 type 을 오픈. (2026-07-19 정책: 팀 instance 중복 합산 폐기.)
  for (const type of EXPERIENCE_LINE_TYPES) {
    const isOpen =
      openConfirmed && lineTeamIds.some((teamId) => config.practicalExperience?.[teamId]?.[type] === true);
    const p = pointCfg.get("experience", type);
    lines.push({ id: `exp:${type}`, hub: "experience", isOpen, pointA: p.pointA, pointB: p.pointB });
    if (isOpen) flagMissing("experience", type, EXP_LABEL[type] ?? type);
  }

  // competency: checked && 해당 주차 실제 target 걸린 master 만. config_key = master line_code.
  if (openConfirmed && config.practicalCompetency?.checked === true) {
    const masters = await loadCompetencyTargetMasters(weekId, organization);
    for (const m of masters) {
      const p = pointCfg.get("competency", m.lineCode);
      lines.push({ id: `comp:${m.lineCode}`, hub: "competency", isOpen: true, pointA: p.pointA, pointB: p.pointB });
      flagMissing("competency", m.lineCode, m.lineName ?? m.lineCode);
    }
  }

  // ── 액트 ────────────────────────────────────────────────────────────────
  //   액트 포인트는 process_acts 고유값(별도 config 없음) → 미설정 검사 대상 아님.
  const { data: actData } = await supabaseAdmin
    .from("process_acts")
    .select("id, hub, act_type, point_check, point_advantage, line_group_id")
    .in("hub", ["info", "experience", "competency", "club"])
    .eq("is_active", true)
    .eq("check_target", "check");
  const actRows = (actData ?? []) as Array<{
    id: string; hub: string; act_type: ActType | null; point_check: number | null; point_advantage: number | null; line_group_id: string | null;
  }>;
  const compChecked = config.practicalCompetency?.checked === true;
  for (const a of actRows) {
    const actType: ActType = a.act_type ?? "basic";
    const base = { actType, pointA: a.point_check ?? 0, pointB: a.point_advantage ?? 0 };
    if (a.hub === "experience") {
      // team/part scope 구분 없음(포인트=process_acts 고유값·team 무관) → 동일 act_id 는 조직·주차당
      //   최대 1회만 합산한다. "팀 시작"/"파트 시작"은 서로 다른 act_id 라 각각 1회씩 반영된다.
      //   isOpen = 어느 한 팀이라도 그 라인급(line_group_id)을 체크. (2026-07-19 정책: 팀 중복 폐기.)
      const open =
        openConfirmed &&
        actTeamIds.some((teamId) => actChecked(config.actCheck?.experience?.[teamId]?.[a.line_group_id ?? ""]));
      acts.push({ id: `act:${a.id}`, isOpen: open, ...base });
    } else {
      let open = openConfirmed;
      if (a.hub === "info") open = open && actChecked(config.actCheck?.info?.[a.line_group_id ?? ""]);
      else if (a.hub === "club") open = open && actChecked(config.actCheck?.club?.[a.line_group_id ?? ""]);
      else if (a.hub === "competency") open = open && compChecked;
      acts.push({ id: `act:${a.id}`, isOpen: open, ...base });
    }
  }

  return { acts, lines, pointConfigAvailable: pointCfg.available, missing: [...missingMap.values()] };
}

// 해당 주차에 실제 cluster4_line_target 이 걸린 competency master(line_code + line_name) 집합(org/common).
async function loadCompetencyTargetMasters(
  weekId: string,
  organization: OrganizationSlug,
): Promise<Array<{ lineCode: string; lineName: string | null }>> {
  const { data: tData, error: tErr } = await supabaseAdmin
    .from("cluster4_line_targets")
    .select("line_id")
    .eq("week_id", weekId);
  if (tErr || !tData || tData.length === 0) return [];
  const lineIds = [...new Set((tData as Array<{ line_id: string }>).map((r) => r.line_id))];
  const { data: lData } = await supabaseAdmin
    .from("cluster4_lines")
    .select("competency_line_master_id")
    .in("id", lineIds)
    .eq("part_type", "competency")
    .eq("is_active", true);
  const masterIds = [...new Set(((lData ?? []) as Array<{ competency_line_master_id: string | null }>).map((r) => r.competency_line_master_id).filter((v): v is string => !!v))];
  if (masterIds.length === 0) return [];
  const { data: mData } = await supabaseAdmin
    .from("cluster4_competency_line_masters")
    .select("line_code, line_name, organization_slug")
    .in("id", masterIds)
    .in("organization_slug", [organization, "common"]);
  const byCode = new Map<string, string | null>();
  for (const r of (mData ?? []) as Array<{ line_code: string | null; line_name: string | null }>) {
    if (!r.line_code || byCode.has(r.line_code)) continue;
    byCode.set(r.line_code, r.line_name ?? null);
  }
  return [...byCode.entries()].map(([lineCode, lineName]) => ({ lineCode, lineName }));
}

// recognition 저장 컬럼(cluster4_week_opening_configs.recognition_count_n 등) 적용 여부 프로브.
//   컬럼 미적용(마이그 전)이면 42703 → false. config 테이블과 별개 테이블이라 독립 확인 필요.
export async function loadRecognitionColumnsAvailable(): Promise<boolean> {
  const { error } = await supabaseAdmin
    .from("cluster4_week_opening_configs")
    .select("recognition_count_n")
    .limit(1);
  if (error) {
    console.warn("[weekRecognitionResolve] recognition columns unavailable:", error.message);
    return false;
  }
  return true;
}

// 미설정 항목 사람이 읽는 오류 메시지.
export function formatMissingPointConfigMessage(missing: MissingPointConfig[]): string {
  const lines = missing.map((m) => `- ${m.hubLabel}: ${m.label}`).join("\n");
  return `다음 오픈 항목의 포인트 설정이 없습니다.\n${lines}\n라인 등록 또는 포인트 설정을 완료한 뒤 다시 오픈 확인해주세요.`;
}

// [오픈확인 시] A/B/N 계산 + 미설정 검증(fail-closed 판정). DB write 는 하지 않는다(호출부가 원자 upsert).
//   featureAvailable = 포인트 config 테이블 && recognition 저장 컬럼 둘 다 적용. 이때만 fail-closed·persist.
//   미적용이면 featureAvailable=false → 계산값은 참고용이나 호출부가 저장/차단하지 않음(graceful).
export async function prepareWeekRecognition(opts: {
  weekId: string;
  organization: OrganizationSlug;
  config: SavedConfig;
}): Promise<{
  featureAvailable: boolean;
  result: RecognitionCountResult;
  missing: MissingPointConfig[];
}> {
  const [{ acts, lines, pointConfigAvailable, missing }, columnsAvailable] = await Promise.all([
    resolveRecognitionInputs({ ...opts, openConfirmed: true }),
    loadRecognitionColumnsAvailable(),
  ]);
  const featureAvailable = pointConfigAvailable && columnsAvailable;
  const result = computeWeekRecognitionCount({ acts, lines });
  return { featureAvailable, result, missing };
}

// A/B/N upsert payload(단일 원자 write 에 병합). featureAvailable 일 때만 컬럼 포함(미적용 시 생략=무회귀).
export function recognitionUpsertFields(result: RecognitionCountResult): Record<string, unknown> {
  return {
    min_points_a: result.minimalA,
    exec_points_b: result.diligentB,
    recognition_count_n: result.recognitionCountN,
    recognition_calc_version: RECOGNITION_CALC_VERSION,
  };
}

// [오픈확인 취소 시] 인정 컬럼 null. 컬럼 미적용이면 조용히 skip.
export async function clearWeekRecognition(opts: {
  weekId: string;
  organization: OrganizationSlug;
}): Promise<void> {
  try {
    const { error } = await supabaseAdmin
      .from("cluster4_week_opening_configs")
      .update({ min_points_a: null, exec_points_b: null, recognition_count_n: null, recognition_calc_version: null })
      .eq("week_id", opts.weekId)
      .eq("organization_slug", opts.organization);
    if (error) console.warn("[weekRecognitionResolve] clear skipped:", error.message);
  } catch (e) {
    console.warn("[weekRecognitionResolve] clear skipped:", e instanceof Error ? e.message : e);
  }
}

// 인정 개수 N 읽기(상세 DTO 용). 컬럼 미적용이면 null → 호출부가 Phase1 기본값 폴백.
export async function loadWeekRecognitionCount(
  weekId: string,
  organization: OrganizationSlug,
): Promise<number | null> {
  const { data, error } = await supabaseAdmin
    .from("cluster4_week_opening_configs")
    .select("recognition_count_n")
    .eq("week_id", weekId)
    .eq("organization_slug", organization)
    .maybeSingle();
  if (error) return null; // 컬럼 미적용 등
  return (data as { recognition_count_n: number | null } | null)?.recognition_count_n ?? null;
}
