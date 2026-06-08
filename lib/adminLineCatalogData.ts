// Server-only data layer for the unified line catalog (Phase 2B — read-only merge).
//
// 4개 원천을 SELECT 만 수행해 메모리에서 합친다. 어떤 원천에도 쓰기 없음.
// 기존 SoT(cluster4_lines·마스터·career_projects)·snapshot·개설 플로우 무접촉.

import { supabaseAdmin } from "@/lib/supabaseAdmin";
import {
  LINE_REGISTRATION_HUB_LABEL,
  type LineRegistrationHub,
} from "@/lib/adminLineRegistrationsTypes";
import {
  LINE_CATALOG_SOURCE_LABEL,
  type LineCatalogItemDto,
  type LineCatalogSort,
  type LineCatalogSource,
  type ListLineCatalogResult,
} from "@/lib/adminLineCatalogTypes";

export class LineCatalogError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

// experience_category(영문) → 라인 종류 한글 라벨 (Phase 2A 매핑표와 동일).
const EXPERIENCE_CATEGORY_LABEL: Record<string, string> = {
  derivation: "도출",
  analysis: "분석",
  evaluation: "평가",
  management: "관리",
  extension: "확장",
};

function item(
  source: LineCatalogSource,
  sourceId: string,
  hub: LineRegistrationHub,
  fields: Omit<
    LineCatalogItemDto,
    "key" | "sourceId" | "source" | "sourceLabel" | "hub" | "hubLabel"
  >,
): LineCatalogItemDto {
  return {
    key: `${source}:${sourceId}`,
    sourceId,
    source,
    sourceLabel: LINE_CATALOG_SOURCE_LABEL[source],
    hub,
    hubLabel: LINE_REGISTRATION_HUB_LABEL[hub],
    ...fields,
  };
}

export type ListLineCatalogOptions = {
  hub?: LineRegistrationHub | null;
  source?: LineCatalogSource | null;
  // 라인명/라인코드 부분 일치 검색 (대소문자 무시).
  query?: string | null;
  sort?: LineCatalogSort;
};

export async function listLineCatalog(
  options: ListLineCatalogOptions = {},
): Promise<ListLineCatalogResult> {
  // 원천 4개 병렬 SELECT — 전부 소규모(수십 건) 정의/레지스트리 테이블이라 전량 조회.
  const [expRes, compRes, careerRes, regRes] = await Promise.all([
    supabaseAdmin
      .from("cluster4_experience_line_masters")
      .select(
        "id,line_code,line_name,default_main_title,experience_category,organization_slug,is_active,created_at",
      )
      .order("created_at", { ascending: false }),
    supabaseAdmin
      .from("cluster4_competency_line_masters")
      .select("id,line_code,line_name,main_title,organization_slug,is_active,created_at")
      .order("created_at", { ascending: false }),
    supabaseAdmin
      .from("career_projects")
      .select("id,line_code,line_name,default_main_title,organization_slug,created_at")
      .order("created_at", { ascending: false }),
    supabaseAdmin
      .from("line_registrations")
      .select(
        "id,line_name,hub,line_type,line_code,main_title,main_title_mode,organization_slug,bridged_master_id,is_active,created_at",
      )
      .order("created_at", { ascending: false }),
  ]);
  for (const [label, res] of [
    ["cluster4_experience_line_masters", expRes],
    ["cluster4_competency_line_masters", compRes],
    ["career_projects", careerRes],
    ["line_registrations", regRes],
  ] as const) {
    if (res.error) throw new LineCatalogError(500, `${label}: ${res.error.message}`);
  }

  // (2E-6) registration 에 mirror 된 마스터 id 집합 — 마스터 원천 행 중복(read-mirror) 판정.
  const bridgedMasterIds = new Set(
    ((regRes.data ?? []) as Array<{ bridged_master_id: string | null }>)
      .map((r) => r.bridged_master_id)
      .filter((v): v is string => Boolean(v)),
  );

  const rows: LineCatalogItemDto[] = [];

  for (const r of (expRes.data ?? []) as Array<{
    id: string;
    line_code: string;
    line_name: string;
    default_main_title: string | null;
    experience_category: string | null;
    organization_slug: string;
    is_active: boolean;
    created_at: string;
  }>) {
    rows.push(
      item("experience_master", r.id, "experience", {
        mirrored: bridgedMasterIds.has(r.id),
        lineName: r.line_name,
        lineType: r.experience_category
          ? EXPERIENCE_CATEGORY_LABEL[r.experience_category] ?? r.experience_category
          : "-",
        lineCode: r.line_code,
        mainTitle: r.default_main_title,
        mainTitleMode: null,
        registrationStatus: r.is_active ? "활성" : "비활성",
        organizationSlug: r.organization_slug,
        bridgedMasterId: null,
        createdAt: r.created_at,
      }),
    );
  }

  for (const r of (compRes.data ?? []) as Array<{
    id: string;
    line_code: string;
    line_name: string;
    main_title: string | null;
    organization_slug: string;
    is_active: boolean;
    created_at: string;
  }>) {
    rows.push(
      item("competency_master", r.id, "competency", {
        mirrored: bridgedMasterIds.has(r.id),
        lineName: r.line_name,
        // 역량 라인 종류(원리/기술/관점/자원)는 원천 컬럼 부재 (Phase 2A 조사) — "-" 표시.
        lineType: "-",
        lineCode: r.line_code,
        mainTitle: r.main_title,
        mainTitleMode: null,
        registrationStatus: r.is_active ? "활성" : "비활성",
        organizationSlug: r.organization_slug,
        bridgedMasterId: null,
        createdAt: r.created_at,
      }),
    );
  }

  for (const r of (careerRes.data ?? []) as Array<{
    id: string;
    line_code: string | null;
    line_name: string | null;
    default_main_title: string | null;
    organization_slug: string;
    created_at: string;
  }>) {
    rows.push(
      item("career_master", r.id, "career", {
        mirrored: bridgedMasterIds.has(r.id),
        lineName: r.line_name ?? "-",
        lineType: "일반",
        lineCode: r.line_code,
        mainTitle: r.default_main_title,
        mainTitleMode: null,
        // career_projects 는 is_active 컬럼 부재 — 상시 활성으로 표시.
        registrationStatus: "활성",
        organizationSlug: r.organization_slug,
        bridgedMasterId: null,
        createdAt: r.created_at,
      }),
    );
  }

  for (const r of (regRes.data ?? []) as Array<{
    id: string;
    line_name: string;
    hub: string;
    line_type: string;
    line_code: string;
    main_title: string;
    main_title_mode: string;
    organization_slug: string | null;
    bridged_master_id: string | null;
    is_active: boolean;
    created_at: string;
  }>) {
    const hub = (["info", "experience", "competency", "career"].includes(r.hub)
      ? r.hub
      : "info") as LineRegistrationHub;
    rows.push(
      item("registration", r.id, hub, {
        mirrored: false,
        lineName: r.line_name,
        lineType: r.line_type,
        lineCode: r.line_code,
        mainTitle: r.main_title,
        mainTitleMode: r.main_title_mode === "variable" ? "variable" : "fixed",
        registrationStatus: r.is_active ? "활성" : "비활성",
        organizationSlug: r.organization_slug,
        bridgedMasterId: r.bridged_master_id,
        createdAt: r.created_at,
      }),
    );
  }

  // 원천별 건수 — 필터 적용 "전" 전체 기준 (기존 마스터 건수 정합 검증용).
  const countsBySource: Record<LineCatalogSource, number> = {
    experience_master: rows.filter((r) => r.source === "experience_master").length,
    competency_master: rows.filter((r) => r.source === "competency_master").length,
    career_master: rows.filter((r) => r.source === "career_master").length,
    registration: rows.filter((r) => r.source === "registration").length,
  };

  // 필터 (read-only — 메모리 내)
  let filtered = rows;
  if (options.hub) filtered = filtered.filter((r) => r.hub === options.hub);
  if (options.source) filtered = filtered.filter((r) => r.source === options.source);
  const q = options.query?.trim().toLowerCase() ?? "";
  if (q.length > 0) {
    filtered = filtered.filter(
      (r) =>
        r.lineName.toLowerCase().includes(q) ||
        (r.lineCode ?? "").toLowerCase().includes(q),
    );
  }

  // 정렬 — created_at 기준 (null 은 항상 뒤, 동률은 key 안정 정렬).
  const sort: LineCatalogSort = options.sort ?? "latest";
  filtered = [...filtered].sort((a, b) => {
    const at = a.createdAt ?? "";
    const bt = b.createdAt ?? "";
    if (at === "" && bt === "") return a.key.localeCompare(b.key);
    if (at === "") return 1;
    if (bt === "") return -1;
    const cmp = sort === "latest" ? bt.localeCompare(at) : at.localeCompare(bt);
    return cmp !== 0 ? cmp : a.key.localeCompare(b.key);
  });

  return { rows: filtered, total: filtered.length, countsBySource };
}
