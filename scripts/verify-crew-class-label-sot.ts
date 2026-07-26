/**
 * 클래스(직책) 라벨 SoT 검증 — 크루 페이지 / Cluster4-CARD / 어드민이 같은 값을 내는지.
 * ─────────────────────────────────────────────────────────────────────────
 * 배경(2026-07-26): 같은 사람의 같은 역할이 화면에 따라 심화(에이전트) / 심화(파트장) 으로 갈렸다.
 *   원인 = 카드 스냅샷의 **라벨(roleLabel)** 과 **코드(crewClassPositionCode)** 가 tier③(현재값 freeze)
 *   에서 서로 다른 원천을 읽었다.
 *     · 코드 = roleLevelToPositionCode(user_profiles.role, 등급)      → advanced_part_leader
 *     · 라벨 = user_memberships.membership_level                      → "심화"(직책 미특정)
 *   표시 변환기는 직책 미특정 "심화" 를 기본값 "심화(에이전트)" 로 떨어뜨린다.
 *
 * 이 스크립트는 HTTP 없이 **실제 카드 생성 함수**(getWeeklyGrowthByUserId)를 직접 호출해
 *   ① 생성 시점 라벨/코드 정합 ② 화면별 resolver 결과 동일성 ③ 다른 역할 회귀를 확인한다.
 *
 * 실행: npm run verify:crew-class-label
 */
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { getCluster4WeeklyCardsForProfileUser } from "@/lib/cluster4WeeklyCardsData";
import { weekClassLabel, classLabel } from "@/lib/adminMembersTypes";
import {
  positionCodeToClassLabel,
  roleLevelToPositionCode,
  POSITION_CODE_TO_CLASS_LABEL,
  type PositionCode,
} from "@/shared/crewClassPosition";

// ── front lib/crewClassDisplayLabel.resolveCrewClassLabel 미러(동일 규칙) ──────────────
//   front 는 별도 repo 라 import 할 수 없다. 규칙이 같은지 이 파일에서 재현해 대조한다.
//   (front 원본: positionCodeToClassLabel(positionCode) → roleLabel → membershipStatusLabel → fallback)
const CLASS_LABELS = new Set<string>(Object.values(POSITION_CODE_TO_CLASS_LABEL));
function frontDisplayLabel(raw: string | null | undefined): string | null {
  if (raw === null || raw === undefined) return null;
  const v = String(raw).trim();
  if (!v || v === "-" || v === "—") return null;
  const byCode = positionCodeToClassLabel(v);
  if (byCode) return byCode;
  if (CLASS_LABELS.has(v)) return v;
  if (v === "일반" || v === "active" || v === "regular" || v === "normal") return "정규";
  if (v === "심화" || v === "advanced") return "심화(에이전트)"; // ← 직책 미특정 기본값(문제의 지점)
  if (v.startsWith("운영진") || v.startsWith("심화(")) return v;
  return v;
}
function frontResolveCrewClassLabel(
  src: { positionCode?: string | null; roleLabel?: string | null; membershipStatusLabel?: string | null },
  fallback = "-",
): string {
  const byCode = positionCodeToClassLabel(src.positionCode ?? null);
  if (byCode) return byCode;
  return frontDisplayLabel(src.roleLabel) ?? frontDisplayLabel(src.membershipStatusLabel) ?? fallback;
}

let pass = 0;
let fail = 0;
let skip = 0;
const failures: string[] = [];

function check(name: string, ok: boolean, detail?: unknown) {
  if (ok) {
    pass += 1;
    console.log(`  PASS  ${name}`);
  } else {
    fail += 1;
    failures.push(name);
    console.log(`  FAIL  ${name}`, detail !== undefined ? JSON.stringify(detail) : "");
  }
}

// ─────────────────────────────────────────────────────────────────────────
// [1] 순수 규칙 회귀 — 역할별 매트릭스. 에이전트가 파트장으로 일괄 변환되면 안 된다.
// ─────────────────────────────────────────────────────────────────────────
function suitePureRules() {
  console.log("\n[1] 역할별 순수 규칙 (role × level → position_code → 라벨)");
  const cases: Array<{
    role: string | null;
    level: string | null;
    expectCode: PositionCode | null;
    expectLabel: string;
  }> = [
    { role: "crew_regular", level: "일반", expectCode: "regular", expectLabel: "정규" },
    { role: null, level: "일반", expectCode: "regular", expectLabel: "정규" },
    { role: "agent", level: "심화", expectCode: "advanced_agent", expectLabel: "심화(에이전트)" },
    { role: "crew_regular", level: "심화", expectCode: "advanced_agent", expectLabel: "심화(에이전트)" },
    { role: null, level: "심화", expectCode: "advanced_agent", expectLabel: "심화(에이전트)" },
    { role: "part_leader", level: "심화", expectCode: "advanced_part_leader", expectLabel: "심화(파트장)" },
    { role: "team_leader", level: "일반", expectCode: "operating_team_leader", expectLabel: "운영진(팀장)" },
    { role: "ambassador", level: "일반", expectCode: "operating_ambassador", expectLabel: "운영진(앰배서더)" },
    { role: "club_leader", level: "일반", expectCode: "operating_club_leader", expectLabel: "운영진(클럽장)" },
    // 신호 전무 — 조용히 정규로 바꾸지 않는다(코드 null → 라벨은 등급 폴백).
    { role: null, level: null, expectCode: null, expectLabel: "-" },
  ];
  for (const c of cases) {
    const code = roleLevelToPositionCode(c.role, c.level);
    check(
      `role=${c.role ?? "null"} level=${c.level ?? "null"} → ${c.expectCode ?? "null"}`,
      code === c.expectCode,
      { got: code },
    );
    const label = frontResolveCrewClassLabel({ positionCode: code, roleLabel: c.level }, "-");
    check(`  → 표시 라벨 "${c.expectLabel}"`, label === c.expectLabel, { got: label });
  }

  // 에이전트가 파트장으로 뒤집히지 않는지 명시 확인(요청된 회귀 조건).
  check(
    "에이전트 유저는 파트장으로 변환되지 않는다",
    frontResolveCrewClassLabel({ positionCode: "advanced_agent", roleLabel: "심화" }) === "심화(에이전트)",
  );
  // 코드가 없으면 종전 동작(등급 폴백) 유지 — 무회귀.
  check(
    "position_code 없는 레거시 스냅샷은 종전 등급 폴백",
    frontResolveCrewClassLabel({ positionCode: null, roleLabel: "심화" }) === "심화(에이전트)",
  );
  check(
    "값이 전부 비면 호출부 placeholder",
    frontResolveCrewClassLabel({ positionCode: null, roleLabel: null, membershipStatusLabel: null }, "-") === "-",
  );
}

// ─────────────────────────────────────────────────────────────────────────
// [2] 화면별 resolver 동일성 — 같은 카드 DTO 를 4개 표시 지점 규칙에 넣어 비교.
// ─────────────────────────────────────────────────────────────────────────
type CardLike = {
  weekLabel?: string | null;
  startDate?: string | null;
  roleLabel?: string | null;
  crewClassPositionCode?: string | null;
  membershipStatusLabel?: string | null;
};

function surfaceLabels(card: CardLike) {
  return {
    // 크루앱 주차 카드 목록(info-badge role) — Cluster41Content
    cardListBadge: frontResolveCrewClassLabel(
      {
        positionCode: card.crewClassPositionCode,
        roleLabel: card.roleLabel,
        membershipStatusLabel: card.membershipStatusLabel,
      },
      "-",
    ),
    // Cluster4-CARD 헤더 배지 — Cluster4CardContent.headerRoleLabel
    cardHeaderBadge: frontResolveCrewClassLabel(
      {
        positionCode: card.crewClassPositionCode,
        roleLabel: card.roleLabel,
        membershipStatusLabel: card.membershipStatusLabel,
      },
      "-",
    ),
    // 디테일 로그(dl-crew-seg) — Cluster4CardContent.detailLogData.crew.level
    detailLogSeg: frontResolveCrewClassLabel(
      { positionCode: card.crewClassPositionCode, roleLabel: card.roleLabel },
      "-",
    ),
    // 어드민 주차 상세(assignment.classLabel) — adminCrewWeekDetail
    adminWeekDetail: weekClassLabel(card.crewClassPositionCode, card.roleLabel),
  };
}

async function suiteRealCards(userIds: string[]) {
  console.log("\n[2] 실제 카드 생성 결과 — 라벨/코드 정합 + 화면별 동일성");
  for (const userId of userIds) {
    // 고객앱이 실제로 받는 DTO 그대로(스냅샷 저장 형태와 동일 shape).
    const cards = (await getCluster4WeeklyCardsForProfileUser(userId)) as unknown as CardLike[];
    if (cards.length === 0) {
      skip += 1;
      console.log(`  SKIP  ${userId} — 카드 0건`);
      continue;
    }
    let divergent = 0;
    let codeMissing = 0;
    const surfaceMismatch: unknown[] = [];
    for (const c of cards) {
      const byCode = positionCodeToClassLabel(c.crewClassPositionCode ?? null);
      if (!byCode) {
        codeMissing += 1;
        continue;
      }
      // 생성 시점 정합: 스냅샷에 담기는 라벨 자체가 코드에서 파생돼야 한다.
      if (frontDisplayLabel(c.roleLabel) !== byCode) {
        divergent += 1;
        if (divergent <= 3) {
          surfaceMismatch.push({
            week: c.weekLabel,
            roleLabel: c.roleLabel,
            code: c.crewClassPositionCode,
          });
        }
      }
      const s = surfaceLabels(c);
      const values = new Set(Object.values(s));
      if (values.size !== 1) surfaceMismatch.push({ week: c.weekLabel, ...s });
    }
    check(
      `${userId} — 생성 라벨 == 코드 파생 라벨 (카드 ${cards.length}건)`,
      divergent === 0,
      surfaceMismatch.slice(0, 3),
    );
    check(
      `${userId} — 4개 표시 지점 결과 동일`,
      surfaceMismatch.filter((m) => (m as Record<string, unknown>).cardListBadge).length === 0,
      surfaceMismatch.slice(0, 3),
    );
    if (codeMissing > 0) {
      console.log(`        (position_code 없는 카드 ${codeMissing}건 — 종전 등급 폴백 경로)`);
    }
    // 수정 전(요약 카드 = roleLabel 우선) vs 수정 후(공통 resolver) 실제 표시값 대조.
    const changed = cards
      .map((c) => ({
        week: c.weekLabel ?? c.startDate,
        before: frontDisplayLabel(c.roleLabel) ?? frontDisplayLabel(c.membershipStatusLabel) ?? "-",
        after: surfaceLabels(c).cardListBadge,
        code: c.crewClassPositionCode,
      }))
      .filter((r) => r.before !== r.after);
    console.log(
      `        표시 변화 ${changed.length}/${cards.length}건` +
        (changed.length > 0 ? ` 예: ${JSON.stringify(changed.slice(0, 3))}` : ""),
    );
  }
}

// ─────────────────────────────────────────────────────────────────────────
// [3] 현재 시점(크루 이력서 카드 상단 / 어드민 회원 목록) 동일성 — 모집단 전수.
// ─────────────────────────────────────────────────────────────────────────
async function suiteCurrentScope() {
  console.log("\n[3] 현재 시점 클래스 — /api/profile 정규화 vs 어드민 classLabel (전수)");
  const { data: profiles, error } = await supabaseAdmin
    .from("user_profiles")
    .select("user_id, display_name, role")
    .limit(5000);
  if (error) throw error;
  const { data: memberships } = await supabaseAdmin
    .from("user_memberships")
    .select("user_id, membership_level, is_current, team_name");
  const levelByUser = new Map<string, string | null>();
  for (const m of memberships ?? []) {
    const prev = levelByUser.get(m.user_id);
    if (prev === undefined || m.is_current) levelByUser.set(m.user_id, m.membership_level);
  }

  let mismatch = 0;
  let changedByFix = 0;
  let noSignal = 0;
  let regressed = 0;
  const samples: unknown[] = [];
  const changedSamples: unknown[] = [];
  const regressedSamples: unknown[] = [];
  for (const p of profiles ?? []) {
    const level = levelByUser.get(p.user_id) ?? null;
    // 수정 후 /api/profile 이 내리는 값
    const code = roleLevelToPositionCode(p.role, level);
    const front = frontResolveCrewClassLabel({ positionCode: code, roleLabel: level }, "-");
    // 어드민 회원 목록/크루 상세 클래스 컬럼(기존에 정상이던 값)
    const admin = classLabel(p.role, level);
    // 수정 전 크루 이력서 카드 상단이 그리던 값(등급만 보던 종전 경로)
    const before = frontDisplayLabel(
      p.role === "team_leader" ? "운영진(팀장)" : p.role === "ambassador" ? "운영진(앰배서더)" : level,
    ) ?? "-";

    // 멤버십 행이 아예 없는 유저(등급 미상) — 종전에도 크루앱은 "-" 였다. 어드민은 자체 기본값
    //   "정규" 를 쓴다. 이 차이는 이번 변경과 무관한 기존 정책 차이라 별도로 센다(회귀 아님).
    if (code === null) {
      noSignal += 1;
      if (front !== before) {
        regressed += 1;
        if (regressedSamples.length < 5) {
          regressedSamples.push({ user: p.display_name, role: p.role, level, before, after: front });
        }
      }
      continue;
    }

    if (front !== admin) {
      mismatch += 1;
      if (samples.length < 5) samples.push({ user: p.display_name, role: p.role, level, front, admin });
    }
    if (front !== before) {
      changedByFix += 1;
      if (changedSamples.length < 8) {
        changedSamples.push({ user: p.display_name, role: p.role, level, before, after: front });
      }
    }
  }
  check(
    `현재 시점 클래스 = 어드민 클래스 (등급 보유 ${(profiles?.length ?? 0) - noSignal}명)`,
    mismatch === 0,
    samples,
  );
  check(
    `등급 미상(${noSignal}명)은 종전 표시 유지 — 새 폴백 추가 없음`,
    regressed === 0,
    regressedSamples,
  );
  console.log(`        이번 수정으로 표시가 바뀌는 인원: ${changedByFix}명`);
  console.log(`        예시: ${JSON.stringify(changedSamples)}`);
}

/**
 * 회귀 매트릭스 대상 선정 — 역할 종류별로 실제 유저를 고른다.
 *   일반 파트원(정규) / 에이전트(심화, 직책 없음) / 파트장(심화+part_leader) / 팀장 / 앰배서더.
 * ⚠ 조용한 스킵 금지 — 각 버킷에서 못 고르면 그 사실을 출력한다.
 */
async function pickRoleMatrixTargets(): Promise<string[]> {
  const { data: profiles, error } = await supabaseAdmin
    .from("user_profiles")
    .select("user_id, display_name, role")
    .limit(5000);
  if (error) throw error;
  const { data: memberships, error: mErr } = await supabaseAdmin
    .from("user_memberships")
    .select("user_id, membership_level, is_current");
  if (mErr) throw mErr;

  const levelByUser = new Map<string, string | null>();
  for (const m of memberships ?? []) {
    const prev = levelByUser.get(m.user_id);
    if (prev === undefined || m.is_current) levelByUser.set(m.user_id, m.membership_level);
  }

  const buckets = new Map<string, Array<{ id: string; name: string }>>();
  for (const p of profiles ?? []) {
    const code = roleLevelToPositionCode(p.role, levelByUser.get(p.user_id) ?? null);
    const key = code ?? "no_signal";
    const arr = buckets.get(key) ?? [];
    arr.push({ id: p.user_id, name: p.display_name });
    buckets.set(key, arr);
  }

  const want: string[] = [
    "advanced_part_leader",
    "advanced_agent",
    "regular",
    "operating_team_leader",
    "operating_ambassador",
    "operating_club_leader",
    "no_signal",
  ];
  const picked: string[] = [];
  console.log("\n회귀 대상 선정(역할 버킷별 1명):");
  for (const key of want) {
    const arr = buckets.get(key) ?? [];
    if (arr.length === 0) {
      skip += 1;
      console.log(`  SKIP  ${key} — 모집단에 해당 역할 없음`);
      continue;
    }
    console.log(`  ${key.padEnd(24)} ${arr[0].name} (${arr.length}명 중)`);
    picked.push(arr[0].id);
  }
  return picked;
}

/**
 * [4] **저장된(기존) 스냅샷** 조회 경로 — 재생성 없이도 화면이 고쳐지는지.
 * 기존 스냅샷은 이미 crewClassPositionCode 를 들고 있으므로, 소비 측 resolver 만 바꿔도
 * 표시가 교정된다(= 스냅샷 재생성/DB 수정 불필요). 그 사실을 실제 저장값으로 확인한다.
 */
async function suiteStoredSnapshots(userIds: string[]) {
  console.log("\n[4] 저장된 스냅샷(조회 경로) — 재생성 없이 교정되는지");
  const { data, error } = await supabaseAdmin
    .from("cluster4_weekly_card_snapshots")
    .select("user_id, dto_version, computed_at, cards")
    .in("user_id", userIds);
  if (error) throw error; // 조용한 스킵 금지
  if (!data || data.length === 0) {
    skip += 1;
    console.log("  SKIP  저장된 스냅샷 행 없음");
    return;
  }
  for (const row of data as Array<{ user_id: string; dto_version: number; computed_at: string; cards: unknown }>) {
    const cards = (Array.isArray(row.cards) ? row.cards : []) as CardLike[];
    const rows = cards.map((c) => ({
      week: c.weekLabel ?? c.startDate,
      storedRoleLabel: c.roleLabel,
      storedCode: c.crewClassPositionCode,
      // 수정 전 요약 카드 규칙(roleLabel 우선)
      before: frontDisplayLabel(c.roleLabel) ?? frontDisplayLabel(c.membershipStatusLabel) ?? "-",
      // 수정 후 공통 resolver(position_code 우선)
      after: surfaceLabels(c).cardListBadge,
    }));
    const changed = rows.filter((r) => r.before !== r.after);
    const stillDivergent = rows.filter((r) => r.after !== surfaceLabels({
      crewClassPositionCode: r.storedCode,
      roleLabel: r.storedRoleLabel,
    }).detailLogSeg);
    check(
      `${row.user_id} (v${row.dto_version}, ${row.computed_at.slice(0, 10)}) — 저장 스냅샷에서도 요약==디테일로그`,
      stillDivergent.length === 0,
      stillDivergent.slice(0, 3),
    );
    console.log(
      `        교정된 카드 ${changed.length}/${rows.length}건` +
        (changed.length > 0 ? ` 예: ${JSON.stringify(changed.slice(0, 3))}` : ""),
    );
  }
}

async function main() {
  const argUsers = process.argv.slice(2).filter((a) => !a.startsWith("--"));
  suitePureRules();
  await suiteCurrentScope();

  let targets = argUsers;
  if (targets.length === 0) {
    targets = await pickRoleMatrixTargets();
  }
  if (targets.length === 0) {
    throw new Error("검증 대상 유저를 못 골랐다 — 조용한 스킵 방지를 위해 실패 처리한다.");
  }
  await suiteStoredSnapshots(targets);
  await suiteRealCards(targets);

  console.log(`\n=== 결과: PASS ${pass} / FAIL ${fail} / SKIP ${skip} ===`);
  if (fail > 0) {
    console.log("실패 항목:", failures);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
