// 라인 강화 Point.A/B 설정 로더 — SoT = cluster4_line_point_configs.  [Phase 3]
//   key = (organization_slug, hub, config_key) UNIQUE.
//     info=activity_types.id · experience=카테고리enum(derive/analysis/research/management/expansion)
//     · competency=cluster4_competency_line_masters.line_code
//   org 조회는 (org, 'common') 둘 다 fetch 후 org-특정 우선(common 은 폴백).
//   테이블 미적용(마이그 전) 시 빈 맵 + available:false (graceful degradation — 호출부 무회귀).

import { supabaseAdmin } from "@/lib/supabaseAdmin";
import type { OrganizationSlug } from "@/lib/organizations";

export type LinePointHub = "info" | "experience" | "competency";
export type LinePoint = { pointA: number; pointB: number };

export type LinePointConfigMap = {
  available: boolean; // 테이블 적용 여부(false = 마이그 전 · 전부 0 취급)
  get(hub: LinePointHub, configKey: string): LinePoint; // 없으면 {0,0}
  // 실제 설정 여부(fail-closed 판정용) — row 존재 && point_a·point_b 둘 다 non-null.
  //   Point.A=0 / Point.B=0 은 정상 설정값(configured). row 없음 또는 NULL 만 미설정(false).
  //   get() 과 동일 우선순위(org row 존재 시 org 기준·common 폴백은 org row 없을 때만).
  isConfigured(hub: LinePointHub, configKey: string): boolean;
};

const ZERO: LinePoint = { pointA: 0, pointB: 0 };
function keyOf(hub: string, configKey: string): string {
  return `${hub}:${configKey}`;
}

export async function loadLinePointConfigs(
  organization: OrganizationSlug,
): Promise<LinePointConfigMap> {
  const { data, error } = await supabaseAdmin
    .from("cluster4_line_point_configs")
    .select("hub, config_key, point_a, point_b, organization_slug")
    .in("organization_slug", [organization, "common"]);
  if (error) {
    // 42703/PGRST205 = 테이블/컬럼 미적용. 그 외 오류도 fail-open(0 취급)해 오픈확인 저장을 막지 않는다.
    console.warn("[weekRecognitionConfig] cluster4_line_point_configs unavailable:", error.message);
    return { available: false, get: () => ZERO, isConfigured: () => false };
  }
  // org-특정 우선 병합(common 은 org 값이 없을 때만). configured = row 존재 && A·B non-null.
  const orgMap = new Map<string, LinePoint>();
  const commonMap = new Map<string, LinePoint>();
  const orgConfigured = new Set<string>();
  const commonConfigured = new Set<string>();
  for (const r of (data ?? []) as Array<{ hub: string; config_key: string; point_a: number | null; point_b: number | null; organization_slug: string }>) {
    const k = keyOf(r.hub, r.config_key);
    const configured = r.point_a !== null && r.point_b !== null;
    if (r.organization_slug === "common") {
      commonMap.set(k, { pointA: r.point_a ?? 0, pointB: r.point_b ?? 0 });
      if (configured) commonConfigured.add(k);
    } else {
      orgMap.set(k, { pointA: r.point_a ?? 0, pointB: r.point_b ?? 0 });
      if (configured) orgConfigured.add(k);
    }
  }
  return {
    available: true,
    get(hub, configKey) {
      const k = keyOf(hub, configKey);
      return orgMap.get(k) ?? commonMap.get(k) ?? ZERO;
    },
    isConfigured(hub, configKey) {
      const k = keyOf(hub, configKey);
      // org row 가 있으면 그 값이 유효 SoT(get 과 동일) → org 의 configured 여부만 본다.
      if (orgMap.has(k)) return orgConfigured.has(k);
      if (commonMap.has(k)) return commonConfigured.has(k);
      return false; // row 자체 없음 = 미설정
    },
  };
}
