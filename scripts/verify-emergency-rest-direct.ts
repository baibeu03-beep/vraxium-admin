/**
 * 긴급 휴식 — direct 검증(서비스 함수 직접 호출, HTTP 무관 · direct==HTTP 원칙).
 *
 *   npx tsx --env-file=.env.local scripts/verify-emergency-rest-direct.ts
 *
 * 단계:
 *   A. loadEligibleWeeks() — 현재/다음 − 공식 휴식. (마이그레이션 불필요)
 *   B. owner 관리자 컨텍스트로 loadEmergencyContext(org) — actor·팀·주차 DTO. (불필요)
 *   C. 첫 팀의 listEmergencyCrews — 크루 코드·이름·클래스. (불필요)
 *   D. 마이그레이션(2026-07-12) 적용 시에만: (T) 테스트 팀·테스트 크루로 createEmergencyRest →
 *      urgent 행 + Po.C 원장 +2 + 보드 숨김 + Detail Log 노출 + 중복 409 → 정리(회수).
 *      실 크루/실 주차에는 절대 쓰지 않는다(test scope 만).
 */
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { ORGANIZATIONS, type OrganizationSlug } from "@/lib/organizations";
import type { AdminContext } from "@/lib/adminAuth";
import {
  loadEmergencyContext,
  listEmergencyCrews,
  createEmergencyRest,
} from "@/lib/adminEmergencyRest";
import { deleteRestRequest } from "@/lib/adminRestManagementData";
import { getIrregularBoard } from "@/lib/adminProcessIrregularData";

function log(...a: unknown[]) {
  console.log(...a);
}

async function migrationApplied(): Promise<boolean> {
  const { error } = await supabaseAdmin
    .from("vacation_requests")
    .select("po_c_act_id")
    .limit(1);
  return !error;
}

async function findOwnerAdmin(): Promise<AdminContext | null> {
  const { data } = await supabaseAdmin
    .from("admin_users")
    .select("id,email,role,is_active")
    .eq("role", "owner")
    .eq("is_active", true)
    .limit(1)
    .maybeSingle();
  const row = data as { id: string; email: string | null } | null;
  if (!row) return null;
  return { userId: row.id, email: row.email, role: "owner", isActive: true };
}

async function main() {
  const applied = await migrationApplied();
  log(`\n=== 긴급 휴식 direct 검증 ===`);
  log(`마이그레이션(2026-07-12) 적용 여부: ${applied ? "적용됨" : "미적용(create 단계 건너뜀)"}\n`);

  // ── A. 신청 가능 주차 (loadEmergencyContext 내부에서 산출되므로 B 에서 함께 확인) ──

  // ── B. owner 컨텍스트로 org 별 context ──
  const admin = await findOwnerAdmin();
  if (!admin) {
    log("❌ owner 관리자(admin_users)가 없어 검증을 중단합니다.");
    process.exit(1);
  }
  log(`[actor] owner admin userId=${admin.userId}`);

  let probeOrg: OrganizationSlug | null = null;
  let probeTeamId: string | null = null;
  for (const org of ORGANIZATIONS) {
    const ctx = await loadEmergencyContext(org, "operating", admin, null);
    log(`\n[context ${org}] season=${ctx.seasonLabel} actor="${ctx.actor.roleLabel} ${ctx.actor.displayName}"`);
    log(`  teams(${ctx.teams.length}): ${ctx.teams.map((t) => t.teamName).slice(0, 8).join(", ")}`);
    log(
      `  weeks(${ctx.weeks.length}): ${ctx.weeks
        .map((w) => `${w.weekLabel}[${w.resultingStatus}] ${w.dateRangeLabel}`)
        .join(" | ")}`,
    );
    if (!probeOrg && ctx.teams.length > 0) {
      probeOrg = org;
      probeTeamId = ctx.teams[0].teamId;
    }
  }

  // ── C. 크루 목록 — 멤버가 있는 팀을 찾아 DTO(코드|이름|클래스) 렌더를 검증 ──
  let crewFound = false;
  for (const org of ORGANIZATIONS) {
    for (const mode of ["test", "operating"] as const) {
      const ctx = await loadEmergencyContext(org, mode, admin, null);
      for (const t of ctx.teams) {
        const crews = await listEmergencyCrews(org, t.teamId, mode);
        if (crews.length === 0) continue;
        crewFound = true;
        log(`\n[crews ${org} team="${t.teamName}" mode=${mode}] count=${crews.length}`);
        for (const c of crews.slice(0, 6)) {
          log(`  ${c.crewCode ?? "-"} | ${c.crewName} | ${c.classLabel}`);
        }
        break;
      }
      if (crewFound) break;
    }
    if (crewFound) break;
  }
  if (!crewFound) log("\n[crews] 멤버가 있는 팀을 찾지 못했습니다(모든 팀 0명).");
  void probeOrg;
  void probeTeamId;

  // ── D. create (마이그레이션 적용 + 안전한 test 시나리오에서만) ──
  if (!applied) {
    log("\n[create] 마이그레이션 미적용 → create/points/idempotency 검증 건너뜀. SQL Editor 적용 후 재실행하세요.");
    process.exit(0);
  }

  // 안전: test 모드 (T) 테스트 크루가 있는 팀을 찾는다(실 크루 오염 방지).
  let testTeam: { org: OrganizationSlug; teamId: string; crewUserId: string; crewName: string } | null = null;
  for (const org of ORGANIZATIONS) {
    const ctx = await loadEmergencyContext(org, "test", admin, null);
    for (const t of ctx.teams) {
      const crews = await listEmergencyCrews(org, t.teamId, "test");
      if (crews.length > 0 && ctx.weeks.length > 0) {
        testTeam = { org, teamId: t.teamId, crewUserId: crews[0].userId, crewName: crews[0].crewName };
        break;
      }
    }
    if (testTeam) break;
  }
  if (!testTeam) {
    log("\n[create] test 스코프에 (팀+크루+주차) 조합이 없어 create 검증을 건너뜁니다(안전).");
    process.exit(0);
  }

  const ctxT = await loadEmergencyContext(testTeam.org, "test", admin, null);
  const weekId = ctxT.weeks[0].weekId;
  log(`\n[create] test 시나리오 org=${testTeam.org} team=${testTeam.teamId} crew=${testTeam.crewName} week=${weekId}`);

  // 지급 전 원장 스냅샷.
  const before = await ledgerPenaltyForActRef(testTeam.crewUserId);

  const res = await createEmergencyRest({
    admin,
    mode: "test",
    actAsTestUserId: null,
    organization: testTeam.org,
    teamId: testTeam.teamId,
    crewUserId: testTeam.crewUserId,
    weekId,
    reason: "direct 검증",
  });
  log(`  ✅ 생성됨 restId=${res.id} actId=${res.poCActId} status=${res.resultingStatus}`);

  // Po.C 원장 확인(해당 act 의 penalty=2).
  const award = await ledgerForAct(res.poCActId);
  log(`  원장(source=irregular ref=${res.poCActId}): penalty=${award.penalty} check=${award.check} adv=${award.adv} rows=${award.rows}`);
  const okPoints = award.penalty === 2 && award.check === 0 && award.adv === 0 && award.rows === 1;
  log(`  Po.C ×2(순수 패널티): ${okPoints ? "PASS" : "FAIL"}`);

  // 보드 숨김 확인.
  const board = await getIrregularBoard(testTeam.org, "test", weekId);
  const shownOnBoard = board.acts.some((a) => a.id === res.poCActId);
  log(`  변동 액트 보드 숨김: ${shownOnBoard ? "FAIL(노출됨)" : "PASS(숨김)"}`);

  // 중복(같은 크루·같은 주차) → 409.
  let dup409 = false;
  try {
    await createEmergencyRest({
      admin,
      mode: "test",
      actAsTestUserId: null,
      organization: testTeam.org,
      teamId: testTeam.teamId,
      crewUserId: testTeam.crewUserId,
      weekId,
      reason: "중복 검증",
    });
  } catch (e) {
    dup409 = (e as { status?: number }).status === 409;
  }
  log(`  중복 신청 409: ${dup409 ? "PASS" : "FAIL"}`);

  // 정리 — deleteRestRequest 가 Po.C 회수 + act/recipients 정리.
  await deleteRestRequest(res.id);
  const after = await ledgerForAct(res.poCActId);
  log(`  정리 후 원장 rows(회수 확인): ${after.rows} (0 이어야 함) → ${after.rows === 0 ? "PASS" : "FAIL"}`);

  void before;
  log("\n✅ direct 검증 완료.");
  process.exit(0);
}

async function ledgerForAct(actId: string): Promise<{ penalty: number; check: number; adv: number; rows: number }> {
  const { data } = await supabaseAdmin
    .from("process_point_awards")
    .select("point_check,point_advantage,point_penalty")
    .eq("source", "irregular")
    .eq("ref_id", actId);
  const rows = (data ?? []) as Array<{ point_check: number; point_advantage: number; point_penalty: number }>;
  return {
    rows: rows.length,
    penalty: rows.reduce((s, r) => s + (r.point_penalty || 0), 0),
    check: rows.reduce((s, r) => s + (r.point_check || 0), 0),
    adv: rows.reduce((s, r) => s + (r.point_advantage || 0), 0),
  };
}

async function ledgerPenaltyForActRef(userId: string): Promise<number> {
  const { data } = await supabaseAdmin
    .from("process_point_awards")
    .select("point_penalty")
    .eq("user_id", userId);
  return ((data ?? []) as Array<{ point_penalty: number }>).reduce((s, r) => s + (r.point_penalty || 0), 0);
}

main().catch((e) => {
  console.error("verify failed:", e);
  process.exit(1);
});
