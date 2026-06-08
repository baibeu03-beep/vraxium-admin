/**
 * /crews displayGrowthStatus 통일 — direct vs HTTP vs front 전수 정합 검증 (read-only).
 *   A) direct: getGrowthStatusResolutionBatch (admin SoT)
 *   B) HTTP: admin GET /api/cluster3/growth-status-batch (internal-key)
 *   C) HTTP: front GET /api/crews?org= 의 displayGrowthStatus
 *   D) A==B==C per-user 전수 비교 (3개 조직)
 *   E) 필터 그룹·카드 라벨 재현 — 필터/카드 일치 확인 + T윤도현 케이스
 *   F) demoUserId 쿼리 유무에 따른 /api/crews 응답 동일성 (viewer-독립 확인)
 * 사전조건: admin dev :3000, front dev :3001.
 * Usage: npx tsx --env-file=.env.local scripts/verify-crews-display-status.ts
 */
import { supabaseAdmin } from "../lib/supabaseAdmin";
import { getGrowthStatusResolutionBatch } from "../lib/cluster3GrowthData";

const ADMIN_BASE = process.env.SMOKE_BASE_URL ?? "http://localhost:3000";
const FRONT_BASE = process.env.FRONT_BASE_URL ?? "http://localhost:3001";
const ORGS = ["encre", "oranke", "phalanx"] as const;

// 고객앱 /crews 의 2분류(Cluving / Elite) 라벨·그룹 로직 1:1 재현
// (2026-06-08 개편 — page.tsx statusLabel / isActiveGroup).
//   카드 라벨: graduated → "활동 졸업", 그 외 전부 → "활동 중".
//   필터 그룹: graduated → "활동 졸업", 그 외 전부 → "활동 중".
//   suspended 는 로드 단계에서 목록 제외되므로 화면에 안 나타나며 라벨/그룹 둘 다 미사용.
const cardLabel = (dgs: string) => (dgs === "graduated" ? "활동 졸업" : "활동 중");
const filterGroup = (dgs: string) => (dgs === "graduated" ? "활동 졸업" : "활동 중");

let pass = 0,
  fail = 0;
const check = (label: string, ok: boolean, detail = "") => {
  console.log(`  ${ok ? "✓" : "✗"} ${label}${detail ? " — " + detail : ""}`);
  ok ? pass++ : fail++;
};

type FrontCrew = {
  id: string;
  name: string;
  status: string;
  growthStatus: string;
  displayGrowthStatus: string;
};

async function main() {
  const internalKey = process.env.INTERNAL_API_KEY;
  if (!internalKey) throw new Error("INTERNAL_API_KEY missing in env");

  for (const org of ORGS) {
    console.log(`\n=== org=${org} ===`);

    // A) direct
    const { data: roster, error } = await supabaseAdmin
      .from("user_profiles")
      .select("user_id, display_name")
      .eq("organization_slug", org);
    if (error) throw new Error(error.message);
    const userIds = (roster ?? []).map((r: { user_id: string }) => r.user_id);
    const nameById = new Map(
      (roster ?? []).map((r: { user_id: string; display_name: string | null }) => [
        r.user_id,
        r.display_name ?? r.user_id,
      ]),
    );
    const direct = await getGrowthStatusResolutionBatch(userIds);
    const directById = new Map(direct.map((r) => [r.userId, r]));

    // B) admin HTTP
    const adminRes = await fetch(
      `${ADMIN_BASE}/api/cluster3/growth-status-batch?org=${org}`,
      { headers: { "x-internal-api-key": internalKey }, cache: "no-store" },
    );
    check(`admin HTTP 200`, adminRes.ok, String(adminRes.status));
    const adminJson = (await adminRes.json()) as {
      data: Array<{ userId: string; displayGrowthStatus: string }>;
    };
    const adminById = new Map(adminJson.data.map((r) => [r.userId, r]));

    // C) front HTTP
    const frontRes = await fetch(`${FRONT_BASE}/api/crews/?org=${org}`, {
      cache: "no-store",
    });
    check(`front HTTP 200`, frontRes.ok, String(frontRes.status));
    const frontJson = (await frontRes.json()) as { data: FrontCrew[] };
    const frontById = new Map(frontJson.data.map((r) => [r.id, r]));

    // D) 전수 비교 — front 응답 기준 (roster 와 front 는 superAdmin 포함 여부 등
    //    구성이 같아야 하지만, 비교는 교집합 + 누락 카운트로 안전하게).
    let mismatches = 0;
    let missingDirect = 0;
    for (const fc of frontJson.data) {
      const d = directById.get(fc.id);
      const a = adminById.get(fc.id);
      if (!d || !a) {
        missingDirect++;
        continue;
      }
      if (
        d.displayGrowthStatus !== a.displayGrowthStatus ||
        a.displayGrowthStatus !== fc.displayGrowthStatus
      ) {
        mismatches++;
        console.log(
          `    ✗ ${fc.name}: direct=${d.displayGrowthStatus} adminHTTP=${a.displayGrowthStatus} frontHTTP=${fc.displayGrowthStatus}`,
        );
      }
    }
    check(
      `direct==adminHTTP==frontHTTP 전수 일치 (${frontJson.data.length}명)`,
      mismatches === 0,
      mismatches ? `${mismatches}건 불일치` : "",
    );
    check(`direct/admin 매핑 누락 0`, missingDirect === 0, `누락 ${missingDirect}`);

    // E) 필터 그룹 ↔ 카드 라벨 정합 — 같은 dgs 하나에서 파생되므로 정의상 일치해야 함.
    let groupLabelConflicts = 0;
    const groupCount = new Map<string, number>();
    for (const fc of frontJson.data) {
      const g = filterGroup(fc.displayGrowthStatus);
      const l = cardLabel(fc.displayGrowthStatus);
      groupCount.set(g, (groupCount.get(g) ?? 0) + 1);
      // 졸업 그룹인데 카드가 졸업 표기가 아니거나, 중단 그룹인데 중단 표기가 아니면 충돌.
      if (g === "활동 졸업" && l !== "활동 졸업") groupLabelConflicts++;
      if (g === "활동 중단" && l !== "활동 중단") groupLabelConflicts++;
      if (g === "활동 중" && (l === "활동 졸업" || l === "활동 중단")) groupLabelConflicts++;
    }
    check(`필터그룹↔카드라벨 충돌 0`, groupLabelConflicts === 0, `${groupLabelConflicts}건`);
    console.log(`    그룹 분포:`, Object.fromEntries(groupCount));
  }

  // ── T윤도현 표적 확인 ──
  console.log(`\n=== T윤도현 (encre) ===`);
  const frontRes = await fetch(`${FRONT_BASE}/api/crews/?org=encre`, { cache: "no-store" });
  const frontJson = (await frontRes.json()) as { data: FrontCrew[] };
  const t = frontJson.data.find((r) => r.id === "bf3b4305-751a-49e3-88ad-95a20e5c4dad");
  check(`T윤도현 displayGrowthStatus=graduated`, t?.displayGrowthStatus === "graduated", JSON.stringify(t));
  check(`T윤도현 필터그룹=활동 졸업`, !!t && filterGroup(t.displayGrowthStatus) === "활동 졸업");
  check(`T윤도현 카드라벨=활동 졸업`, !!t && cardLabel(t.displayGrowthStatus) === "활동 졸업");

  // F) demoUserId 경로 동일성 — 쿼리 부착 유무로 응답 diff (data 정렬 동일 가정).
  const plain = await (await fetch(`${FRONT_BASE}/api/crews/?org=encre`, { cache: "no-store" })).json();
  const demo = await (
    await fetch(
      `${FRONT_BASE}/api/crews/?org=encre&demoUserId=bf3b4305-751a-49e3-88ad-95a20e5c4dad&admin=true`,
      { cache: "no-store" },
    )
  ).json();
  const pick = (j: { data: FrontCrew[] }) =>
    j.data.map((r) => `${r.id}:${r.displayGrowthStatus}`).sort().join("|");
  check(`demoUserId 쿼리 유무 응답 동일(상태 필드)`, pick(plain) === pick(demo));

  console.log(`\n결과: pass=${pass} fail=${fail}`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
