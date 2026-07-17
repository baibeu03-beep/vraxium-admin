import { supabaseAdmin } from "@/lib/supabaseAdmin";
import {
  isLineDurationMinutes,
  type LineDurationMinutes,
} from "@/lib/adminLineRegistrationsTypes";
import type { Cluster4LineDetailDto } from "@/shared/cluster4.contracts";

// ─────────────────────────────────────────────────────────────────────
// cluster4_lines(개설 인스턴스) → line_registrations(마스터 원장) 소요 시간 브리지 — 조회 전용.
//
//   SoT = line_registrations.estimated_duration_minutes (30|60|90|120, NULL=미설정).
//   commit 2ac9bbf 가 "cluster4_lines 인스턴스 화면은 신규 조인 설계 필요 — 별도 작업"으로 남긴
//   그 조인이 이 모듈이다. **인스턴스/snapshot 에 복제 저장하지 않는다**(원장 직조회).
//
//   허브별 브리지 키:
//     · info       → line_registrations(hub='info').point_activity_type_id = line.activityTypeId
//                    (info 는 bridged_master_id 가 없다 — 실측 9행 전부 null)
//                    ⚠ **org 스코프 필수** — 아래 "info 는 왜 org 를 받아야 하는가" 참조.
//     · experience → line_registrations(hub='experience').bridged_master_id = experienceLineMasterId
//     · competency → line_registrations(hub='competency').bridged_master_id = competencyLineMasterId
//     · career     → **브리지 없음** → 항상 null("-"). career 는 career_projects 직독이고
//                    line_registrations 에 career 행 자체가 없다(실측 0행). 추정 금지 — 원천 부재.
//
//   ── info 는 왜 org 를 받아야 하는가 (2026-07-17 감사) ─────────────────────────
//   point_activity_type_id 에는 유니크 제약이 없다(원장의 유니크는 (hub, organization_slug,
//   line_code) 뿐). 따라서 아래 두 행은 동시에 합법이다:
//       ('info','encre', IFBS-NN0010, act='wisdom',  30)
//       ('info','common',IFBS-NN0001, act='wisdom', 120)
//   활동유형 키만으로 map 을 만들면 last-write-wins 라 **다른 org 의 값이 조용히 선택된다**
//   (null 이 아니라 "틀린 값" — 빈 값보다 위험하다). 그래서 resolver 는 생성 시점에 org 로
//   스코프한다. cluster4_lines 에는 organization_slug 컬럼이 없어 라인 자체로는 스코프할 수
//   없고, 호출부가 crew.organizationSlug 를 넘겨야 한다(loadInfoLineCatalog 와 동일 구조).
//
//   info 선택 규칙(엄격): org 전용 행 > common > 없음(null). **다른 org 행은 제외한다.**
//     (loadInfoLineCatalog 는 "org 전용 > 먼저 온 행"이라 타 org 가 이길 수 있는 더 느슨한
//      규칙이다 — 표시명 정책이라 그대로 두고, 값 정확성이 걸린 duration 만 엄격히 간다.)
//   experience/competency 는 bridged_master_id 가 UUID 1:1 이라 org 충돌이 불가능하다
//   (실측 56 distinct / 중복 0) → 기존 배치 map 구조를 그대로 유지한다.
//
//   컬럼 부재(마이그레이션 전) 대응 = 조회 degrade: estimated_duration_minutes 를 빼고 재시도해
//   전부 null 로 내린다(500 금지). commit 2ac9bbf 의 "조회는 degrade, 저장은 실패" 원칙과 동일.
//
//   ⚠ 표시 포맷(0.5 h 등)은 여기서 만들지 않는다 — DTO 는 분(minutes) 정수만 싣고 표시는
//     formatLineDuration 단일 formatter 가 담당한다(화면별 포맷·별칭 금지).
// ─────────────────────────────────────────────────────────────────────

export type LineDurationResolver = (line: {
  partType: Cluster4LineDetailDto["partType"];
  activityTypeId?: string | null;
  activityTypeKey?: string | null;
  experienceLineMasterId?: string | null;
  competencyLineMasterId?: string | null;
}) => LineDurationMinutes | null;

type RegRow = {
  hub: string | null;
  bridged_master_id: string | null;
  point_activity_type_id: string | null;
  organization_slug: string | null;
  estimated_duration_minutes?: number | null;
};

const BASE_SELECT = "hub,bridged_master_id,point_activity_type_id,organization_slug";

// 원장 전량 조회(현 규모 65행 — 허브 3종). 컬럼 부재 시 컬럼만 빼고 재시도해 degrade.
async function loadRegistrationRows(): Promise<{ rows: RegRow[]; durationColumnPresent: boolean }> {
  const withDuration = await supabaseAdmin
    .from("line_registrations")
    .select(`${BASE_SELECT},estimated_duration_minutes`);
  if (!withDuration.error) {
    return { rows: (withDuration.data ?? []) as unknown as RegRow[], durationColumnPresent: true };
  }
  const code = (withDuration.error as { code?: string }).code;
  if (code !== "42703") {
    console.warn("[lineDurationBridge] 원장 조회 실패 → 전부 미설정 처리", {
      code,
      message: withDuration.error.message,
    });
    return { rows: [], durationColumnPresent: true };
  }
  // 컬럼 부재(마이그 전) — 조회는 절대 깨뜨리지 않는다. 값은 전부 null("-").
  console.warn("[lineDurationBridge] estimated_duration_minutes 컬럼 부재 → '-' degrade");
  const fallback = await supabaseAdmin.from("line_registrations").select(BASE_SELECT);
  if (fallback.error) {
    console.warn("[lineDurationBridge] degrade 재조회도 실패", { message: fallback.error.message });
    return { rows: [], durationColumnPresent: false };
  }
  return { rows: (fallback.data ?? []) as unknown as RegRow[], durationColumnPresent: false };
}

// 주차 1건 조회당 1회 로드 → 라인 수만큼 반복 질의하지 않는다(N+1 회피).
//   organizationSlug = 이 조회의 크루가 속한 조직. info 매핑을 이 org 로 스코프한다(위 주석 참조).
//   null 이면 org 전용 행을 고를 근거가 없으므로 common 행만 사용한다.
export async function loadLineDurationResolver(
  organizationSlug: string | null,
): Promise<LineDurationResolver> {
  const { rows } = await loadRegistrationRows();

  const norm = (raw: number | null | undefined): LineDurationMinutes | null =>
    isLineDurationMinutes(raw) ? raw : null; // 허용목록 밖/NULL = 미설정

  // info = 활동유형 키(org 스코프 필요) · experience/competency = master UUID(1:1, 충돌 불가).
  //   두 축을 별도 map 으로 두어 서로 오염되지 않게 한다(experience 와 competency 는 UUID 공간이
  //   달라 한 map 을 공유해도 충돌하지 않는다 — 실측 56 distinct / 중복 0).
  const byActivityType = new Map<string, LineDurationMinutes | null>();
  const byMasterId = new Map<string, LineDurationMinutes | null>();
  // 활동유형별로 "지금 채택된 행의 org" — org 전용이 common 을 덮어쓰게 하는 판정에만 쓴다.
  const infoPickedOrg = new Map<string, string | null>();

  for (const r of rows) {
    const d = norm(r.estimated_duration_minutes);
    if (r.hub === "info") {
      const key = r.point_activity_type_id?.trim();
      if (!key) continue;
      const org = r.organization_slug;
      const isOrgSpecific = organizationSlug != null && org === organizationSlug;
      const isCommon = org === "common";
      // 다른 org 의 행은 애초에 후보에서 제외한다 — 이게 오표시를 막는 핵심 게이트.
      if (!isOrgSpecific && !isCommon) continue;

      const picked = infoPickedOrg.get(key);
      if (picked === undefined) {
        byActivityType.set(key, d);
        infoPickedOrg.set(key, org);
        continue;
      }
      // 이미 채택된 행이 common 이고 이번이 org 전용이면 교체(org 전용 > common).
      const pickedIsOrgSpecific = organizationSlug != null && picked === organizationSlug;
      if (isOrgSpecific && !pickedIsOrgSpecific) {
        byActivityType.set(key, d);
        infoPickedOrg.set(key, org);
      }
    } else if (r.hub === "experience" || r.hub === "competency") {
      const key = r.bridged_master_id?.trim();
      if (key) byMasterId.set(key, d);
    }
    // career = 원장에 행이 없다(브리지 미연결) — 매핑 대상 아님.
  }

  return (line) => {
    switch (line.partType) {
      case "information": {
        // 카드 라인의 활동유형 식별자는 id/key 두 축이 있다(loadInfoLineCatalog 매칭과 동일 규칙).
        const a = line.activityTypeId?.trim();
        const b = line.activityTypeKey?.trim();
        return (a ? byActivityType.get(a) : undefined) ?? (b ? byActivityType.get(b) : undefined) ?? null;
      }
      case "experience":
        return line.experienceLineMasterId
          ? byMasterId.get(line.experienceLineMasterId) ?? null
          : null;
      case "competency":
        return line.competencyLineMasterId
          ? byMasterId.get(line.competencyLineMasterId) ?? null
          : null;
      case "career":
        return null; // 원천 부재(브리지 미연결) — 추정하지 않는다
    }
  };
}
