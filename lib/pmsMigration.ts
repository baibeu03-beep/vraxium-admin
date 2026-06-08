/**
 * PMS 이관 — source system → Vraxium 매핑 단일 SoT (2026-06-07 B안 복합키 확정).
 *
 * pms-migration 은 source system 단위로 구성되고, organization_slug 는 **오직**
 * source system 으로 결정한다 (확정 매핑: hrdb→encre · oranke→oranke · olympus→phalanx).
 *
 * 식별 체계 (B안 — 2026-06-07_users_source_system_composite_legacy_key.sql):
 *   - legacy_user_id = PMS 원본 UserId **그대로 보존** (offset 가산 폐기).
 *   - 동일인 브리지 식별 = (users.source_system, users.legacy_user_id) 복합키
 *     (uq_users_source_legacy). (oranke,248)·(hrdb,248)·(olympus,248) 은 서로 다른 사용자.
 *   - users.source_system = 불변 provenance (DB 트리거 강제). organization_slug 는
 *     가변이므로 식별자 사용 금지.
 *   - legacy_user_id 단독 조회 금지 — 반드시 source_system 동반 또는 모호성 fail-closed.
 *   - 멱등 키: users = (source_system, legacy_user_id) / ledger = (source_table, source_pk).
 *   - olympus 기존 28명(legacy 248~303, source_system NULL): olympus 이관이 3중 키 매칭으로
 *     기존 행을 식별해 source_system='olympus' 를 **최초 기록** (NULL→값, 트리거 허용) —
 *     사전 수동 백필 금지.
 *
 * usersinfo.Team 은 어떤 경우에도 team_name 으로만 사용 — organization_slug 파생 금지.
 * (Team=팀 차원 실증: teampartlist 팀→파트 위계 사전 + Vraxium cluster4_teams 사전 일치,
 *  diag-pms-usersinfo-org 2026-06-07. usersinfo 에 org 컬럼 자체가 없다.)
 */

export const PMS_SOURCE_SYSTEMS = {
  hrdb: { organizationSlug: "encre" },
  oranke: { organizationSlug: "oranke" },
  olympus: { organizationSlug: "phalanx" },
} as const;

export type PmsSourceSystem = keyof typeof PMS_SOURCE_SYSTEMS;

/** source system → organization_slug. 미등록 소스는 fail-closed. */
export function resolveOrganizationSlug(source: string): string {
  const entry = PMS_SOURCE_SYSTEMS[source as PmsSourceSystem];
  if (!entry) throw new Error(`[pmsMigration] 미등록 source system '${source}' — PMS_SOURCE_SYSTEMS 에 매핑 추가 후 진행 (fail-closed)`);
  return entry.organizationSlug;
}

/**
 * legacy_point_ledger/legacy_event_logs 의 source_table 네임스페이스.
 * UNIQUE(source_table, source_pk) 멱등 키가 소스 시스템 간 PK 충돌(각 MySQL identity 독립)에
 * 안전하도록 source_table 에 소스 프리픽스를 박는다 — DDL 변경 없이 키 공간 분리.
 * 예: ledgerSourceTable('oranke', 'pointlogs') === 'oranke.pointlogs'
 */
export function ledgerSourceTable(source: PmsSourceSystem, table: string): string {
  resolveOrganizationSlug(source); // 등록 여부 fail-closed
  return `${source}.${table}`;
}

/**
 * (B안 2026-06-07) 이관 식별 페어 — PMS 원본 UserId 를 그대로 보존한다.
 * users 기록 계약: { source_system: sourceSystem, legacy_user_id: legacyUserId }.
 * 멱등 키 = uq_users_source_legacy(source_system, legacy_user_id).
 * 가드: 미등록 소스 fail-closed · 양수 정수만 · synthetic 범위(≥1억) 침범 금지
 * (소스 UserId 가 1억을 넘는 비정상 데이터 방어 — 정상 max: oranke 1,374 ·
 *  hrdb 1,712 · olympus 303).
 */
export function legacyIdentityFor(
  source: PmsSourceSystem,
  pmsUserId: number,
): { sourceSystem: PmsSourceSystem; legacyUserId: number } {
  resolveOrganizationSlug(source); // 등록 여부 fail-closed
  if (!Number.isInteger(pmsUserId) || pmsUserId <= 0)
    throw new Error(`[pmsMigration] 비정상 pmsUserId ${pmsUserId}`);
  if (pmsUserId >= 100_000_000)
    throw new Error(
      `[pmsMigration] pmsUserId ${pmsUserId} 가 synthetic 범위(≥1억)와 겹침 — 소스 데이터 이상`,
    );
  return { sourceSystem: source, legacyUserId: pmsUserId };
}

/**
 * PMS usersinfo.State → Vraxium 계정 상태 매핑 (2026-06-07 확정).
 *   - 일반 / 운영진 → status=active · growth_status=active
 *   - 활동정지     → status=active · growth_status='suspended' (계정 존속·성장만 중단)
 *   - 졸업         → status=active · growth_status='graduated' (이관 대상 제외이나 매핑 정의)
 *   미지의 State 는 fail-closed throw (이관 시 명시 추가 강제).
 * 시즌별 progressStatus(이력) 와 분리 — 최종 상태만 결정한다 (cluster1ResumeData 의 시즌
 *   인정 주차 기반 표시를 덮지 않는다, 2026-06-07 정책).
 */
export function resolveAccountStatusFromPmsState(
  state: string | null | undefined,
): { status: string; growthStatus: string } {
  const s = String(state ?? "").trim();
  switch (s) {
    case "일반":
    case "운영진":
      return { status: "active", growthStatus: "active" };
    case "활동정지":
      return { status: "active", growthStatus: "suspended" };
    case "졸업":
      return { status: "active", growthStatus: "graduated" };
    default:
      throw new Error(`[pmsMigration] 미매핑 usersinfo.State '${s}' — resolveAccountStatusFromPmsState 에 추가 후 진행`);
  }
}

/**
 * @deprecated (2026-06-07 B안 복합키 채택) offset 네임스페이스 방식 폐기 —
 * legacy_user_id 는 단독으로 식별자가 아니다. legacyIdentityFor 를 사용해
 * (source_system, legacy_user_id) 페어로 기록/조회할 것. 호출 시 즉시 throw.
 */
export function legacyUserIdFor(source: PmsSourceSystem, pmsUserId: number): number {
  void source;
  void pmsUserId;
  throw new Error(
    "[pmsMigration] legacyUserIdFor 는 폐기됨 (B안 복합키, 2026-06-07) — legacyIdentityFor(source, pmsUserId) 로 (source_system, legacy_user_id) 페어를 기록하세요.",
  );
}

/**
 * usersinfo.Team/Part → Vraxium team_name/part_name 패스스루.
 * 반환 타입에 organizationSlug 가 없는 것이 계약 — Team 으로 org 를 파생하는 코드를 타입으로 차단.
 */
export function mapUsersinfoTeamPart(row: { Team: string | null; Part: string | null }): {
  teamName: string | null;
  partName: string | null;
} {
  return { teamName: row.Team ?? null, partName: row.Part ?? null };
}

/**
 * 동일인 매칭 계약 (2026-06-07 실증 기반):
 * users.legacy_user_id 는 **동일인 브리지로 신뢰 금지** — 2026-05-11 synthetic default(≥1억)
 * 이전 구 sequence 가 소값(248~309)을 발급해 oranke UserId 공간과 수치 충돌, 34명 전원
 * PMS 동일인 아님(0/28). 매칭은 3중 키(이름+생년월일+연락처)만. legacy_user_id 는
 * "이관이 직접 기록한 행"에 한해 멱등/추적 키로만 사용한다.
 * 충돌 검증은 source system 단위: 해당 소스의 UserId 범위 ∩ Vraxium legacy_user_id 보유 행을
 * 소스별로 스캔하고, 이관 기록이 아닌 행은 전부 false-bridge 후보로 취급 (verify-pms-source-mapping.ts).
 */
export const FALSE_BRIDGE_NOTE =
  "legacy_user_id<1억 보유 기존 행 중 이관 비기록분은 동일인 보장 없음 — 3중 키 재검증 필수";
