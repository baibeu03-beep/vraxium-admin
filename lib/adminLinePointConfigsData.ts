// 라인 강화 Point.A/B 설정 CRUD — SoT = cluster4_line_point_configs.  [Phase 3]
//   config_key: info=activity_types.id · experience=카테고리enum · competency=master line_code.
//   available config key 는 각 허브 SoT 에서 열거(라벨 표시용) 후 저장값과 병합한다.
//   테이블 미적용(마이그 전) 시 available:false + 값 0/미저장(무회귀). org 스코프 = registrations 미러.

import { supabaseAdmin } from "@/lib/supabaseAdmin";
import type { OrganizationSlug } from "@/lib/organizations";
import { EXPERIENCE_LINE_TYPES } from "@/lib/adminTeamPartsInfoWeekDetailData";

export type LinePointHub = "info" | "experience" | "competency";
export const LINE_POINT_HUBS: LinePointHub[] = ["info", "experience", "competency"];
export function isLinePointHub(v: unknown): v is LinePointHub {
  return typeof v === "string" && (LINE_POINT_HUBS as string[]).includes(v);
}

const EXP_LABEL: Record<string, string> = {
  derive: "도출", analysis: "분석", research: "견문", management: "관리", expansion: "확장",
};

// 라인 등록 line_type(한글) → experience config_key(카테고리 enum). 평가=evaluation=research(견문) 매핑.
export const EXPERIENCE_LINETYPE_TO_CONFIG_KEY: Record<string, string> = {
  도출: "derive",
  분석: "analysis",
  평가: "research",
  관리: "management",
  확장: "expansion",
};

// 라인 등록 1건 → point config_key 도출(확정 정책).
//   info=activity_types.id(등록 폼에서 전달) · experience=line_type→카테고리 enum · competency=line_code.
//   career=제외(null). 도출 불가(정책상 키 없음)면 null.
export function deriveLineConfigKey(opts: {
  hub: "info" | "experience" | "competency" | "career";
  lineType: string;
  lineCode: string;
  infoActivityTypeId?: string | null;
}): { hub: LinePointHub; configKey: string } | null {
  const { hub, lineType, lineCode, infoActivityTypeId } = opts;
  if (hub === "competency") return { hub, configKey: lineCode };
  if (hub === "experience") {
    const key = EXPERIENCE_LINETYPE_TO_CONFIG_KEY[lineType];
    return key ? { hub, configKey: key } : null;
  }
  if (hub === "info") {
    return infoActivityTypeId && infoActivityTypeId.trim() ? { hub, configKey: infoActivityTypeId.trim() } : null;
  }
  return null; // career
}

export class LinePointConfigError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
    this.name = "LinePointConfigError";
  }
}

export type LinePointConfigRow = {
  hub: LinePointHub;
  configKey: string;
  label: string;
  pointA: number | null;
  pointB: number | null;
};

export type LinePointConfigList = {
  organization: OrganizationSlug | "common";
  available: boolean; // 테이블 적용 여부
  rows: LinePointConfigRow[];
};

// 허브별 available config key(라벨 포함) — 저장 여부와 무관하게 편집 UI 가 렌더할 목록.
async function listAvailableKeys(
  organization: OrganizationSlug | "common",
): Promise<LinePointConfigRow[]> {
  const rows: LinePointConfigRow[] = [];

  // info = activity_types(practical_info).
  const { data: at } = await supabaseAdmin
    .from("activity_types")
    .select("id, name")
    .eq("cluster_id", "practical_info")
    .eq("is_active", true);
  for (const r of (at ?? []) as Array<{ id: string; name: string | null }>) {
    rows.push({ hub: "info", configKey: r.id, label: r.name ?? r.id, pointA: null, pointB: null });
  }

  // experience = 카테고리 enum(고정 5종).
  for (const type of EXPERIENCE_LINE_TYPES) {
    rows.push({ hub: "experience", configKey: type, label: EXP_LABEL[type] ?? type, pointA: null, pointB: null });
  }

  // competency = master line_code(org/common).
  const orgFilter = organization === "common" ? ["common"] : [organization, "common"];
  const { data: cm } = await supabaseAdmin
    .from("cluster4_competency_line_masters")
    .select("line_code, line_name")
    .eq("is_active", true)
    .in("organization_slug", orgFilter);
  const seen = new Set<string>();
  for (const r of (cm ?? []) as Array<{ line_code: string | null; line_name: string | null }>) {
    if (!r.line_code || seen.has(r.line_code)) continue;
    seen.add(r.line_code);
    rows.push({ hub: "competency", configKey: r.line_code, label: r.line_name ?? r.line_code, pointA: null, pointB: null });
  }
  return rows;
}

// ── 목록 표시용 전-조직 조회 ──────────────────────────────────────────────
//   라인 정보 목록은 통합(여러 org)일 수 있어, 행마다 org 를 달리 해석해야 한다.
//   loadLinePointConfigs(org)(오픈확인 경로)와 동일한 우선순위 규칙을 org 무관 룩업으로 확장:
//     · get(rowOrg, hub, key) = (rowOrg ?? 'common') 우선 → 없으면 'common' 폴백.
//   이는 오픈확인 resolveRecognitionInputs 가 loadLinePointConfigs(org).get(hub,key) 로 얻는 값과
//   동일 SoT·동일 규칙이다(목록 표시값 == 오픈확인 A/B/N 입력값 보장).
export type LinePointLookup = {
  available: boolean; // 테이블 적용 여부(false = 마이그 전 · 전부 null 취급)
  // 숫자 = 설정값(0 포함) · null = 미설정/미연결. configKey null 이면 미연결 → {null,null}.
  get(
    rowOrg: string | null,
    hub: LinePointHub,
    configKey: string | null,
  ): { pointA: number | null; pointB: number | null };
};

const NULL_POINT = { pointA: null, pointB: null } as const;

export async function loadLinePointLookupAllOrgs(): Promise<LinePointLookup> {
  const { data, error } = await supabaseAdmin
    .from("cluster4_line_point_configs")
    .select("organization_slug, hub, config_key, point_a, point_b");
  if (error) {
    // 42703/PGRST205 = 테이블 미적용. 그 외 오류도 fail-open(전부 null) — 목록 조회를 막지 않는다.
    console.warn("[adminLinePointConfigsData] lookup unavailable:", error.message);
    return { available: false, get: () => ({ ...NULL_POINT }) };
  }
  const map = new Map<string, { pointA: number | null; pointB: number | null }>();
  for (const r of (data ?? []) as Array<{
    organization_slug: string;
    hub: string;
    config_key: string;
    point_a: number | null;
    point_b: number | null;
  }>) {
    map.set(`${r.organization_slug}:${r.hub}:${r.config_key}`, {
      pointA: r.point_a,
      pointB: r.point_b,
    });
  }
  return {
    available: true,
    get(rowOrg, hub, configKey) {
      if (!configKey) return { ...NULL_POINT }; // 미연결(info 링크 없음 등)
      const org = rowOrg ?? "common";
      return (
        map.get(`${org}:${hub}:${configKey}`) ??
        map.get(`common:${hub}:${configKey}`) ?? // org row 없을 때만 common 폴백
        { ...NULL_POINT }
      );
    },
  };
}

export async function listLinePointConfigs(
  organization: OrganizationSlug | "common",
): Promise<LinePointConfigList> {
  const keys = await listAvailableKeys(organization);
  const { data, error } = await supabaseAdmin
    .from("cluster4_line_point_configs")
    .select("hub, config_key, point_a, point_b")
    .in("organization_slug", organization === "common" ? ["common"] : [organization]);
  if (error) {
    return { organization, available: false, rows: keys }; // 테이블 미적용 → 값 미저장
  }
  const saved = new Map<string, { pointA: number | null; pointB: number | null }>();
  for (const r of (data ?? []) as Array<{ hub: string; config_key: string; point_a: number | null; point_b: number | null }>) {
    saved.set(`${r.hub}:${r.config_key}`, { pointA: r.point_a, pointB: r.point_b });
  }
  return {
    organization,
    available: true,
    rows: keys.map((k) => {
      const s = saved.get(`${k.hub}:${k.configKey}`);
      return s ? { ...k, pointA: s.pointA, pointB: s.pointB } : k;
    }),
  };
}

function validPoint(v: unknown): v is number | null {
  if (v === null) return true;
  return typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= 20;
}

export async function upsertLinePointConfig(opts: {
  organization: OrganizationSlug | "common";
  hub: LinePointHub;
  configKey: string;
  pointA: number | null;
  pointB: number | null;
  actorId?: string | null;
}): Promise<LinePointConfigRow> {
  const { organization, hub, configKey, pointA, pointB, actorId } = opts;
  if (!isLinePointHub(hub)) throw new LinePointConfigError(400, "hub must be info|experience|competency");
  if (typeof configKey !== "string" || configKey.trim() === "") throw new LinePointConfigError(400, "config_key is required");
  if (!validPoint(pointA) || !validPoint(pointB)) throw new LinePointConfigError(400, "point_a/point_b must be integer 0~20 or null");

  const { error } = await supabaseAdmin.from("cluster4_line_point_configs").upsert(
    {
      organization_slug: organization,
      hub,
      config_key: configKey,
      point_a: pointA,
      point_b: pointB,
      created_by: actorId ?? null,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "organization_slug,hub,config_key" },
  );
  if (error) {
    // 42703/PGRST205 = 테이블 미적용.
    throw new LinePointConfigError(503, `포인트 설정 테이블 미적용(마이그레이션 필요): ${error.message}`);
  }
  return { hub, configKey, label: configKey, pointA, pointB };
}
