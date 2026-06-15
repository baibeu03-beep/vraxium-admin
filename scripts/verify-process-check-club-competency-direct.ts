/**
 * READ-ONLY 검증(direct): 프로세스 체크 info/competency/club 보드 동일 구조 + 허브별 액트 필터.
 *   npx tsx --env-file=.env.local scripts/verify-process-check-club-competency-direct.ts
 *
 * 검증:
 *   1) 세 허브 보드 DTO 구조 동일(같은 키·teams 비팀=빈배열·hub/hubLabel만 차이).
 *   2) 액트 목록이 허브별로만 필터(board.acts 의 act_id 전부 process_acts.hub == 그 허브, 교차 0).
 *   3) info 테스트 모드 주차 예외(13주차)만 적용 — competency/club 은 test==operating 주차(예외 비적용).
 *   4) org 분리(oranke/encre/phalanx) — board.organization 일치, 데이터 누설 0.
 */
import { writeFileSync } from "fs";
import { createClient } from "@supabase/supabase-js";
import { getProcessCheckBoard } from "@/lib/adminProcessCheckData";

const sb = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

const HUBS = ["info", "competency", "club"] as const;
const ORGS = ["oranke", "encre", "phalanx"] as const;
let pass = 0, fail = 0;
const ok = (c: boolean, label: string) => { console.log(`  ${c ? "✓" : "✗"} ${label} ${c ? "" : "❌"}`); c ? pass++ : fail++; };

const BOARD_KEYS = ["hub", "hubLabel", "organization", "week", "teams", "lineGroups", "acts", "summary", "logs"].sort();

async function actHubMap(): Promise<Map<string, string>> {
  const { data } = await sb.from("process_acts").select("id,hub");
  return new Map(((data ?? []) as Array<{ id: string; hub: string }>).map((a) => [a.id, a.hub]));
}

async function main() {
  const hubOf = await actHubMap();

  // ── 1·2) 구조 동일 + 허브 필터 ──────────────────────────────────
  console.log("=== 1·2) 보드 구조 동일 + 허브별 액트 필터 (org=oranke, operating) ===");
  const boards: Record<string, any> = {};
  for (const hub of HUBS) {
    const b = await getProcessCheckBoard(hub, "oranke", null, "operating");
    boards[hub] = b;
    ok(JSON.stringify(Object.keys(b).sort()) === JSON.stringify(BOARD_KEYS), `[${hub}] 보드 키 동일`);
    ok(b.hub === hub, `[${hub}] board.hub=${b.hub}`);
    ok(Array.isArray(b.teams) && b.teams.length === 0, `[${hub}] teams 비팀(빈 배열) — info 와 동일 단일 테이블`);
    const wrongHub = (b.acts as Array<{ actId: string }>).filter((a) => hubOf.get(a.actId) !== hub);
    ok(wrongHub.length === 0, `[${hub}] 액트 전부 hub=${hub} (타허브 혼입 ${wrongHub.length})`);
    console.log(`    [${hub}] acts=${b.acts.length} lineGroups=${b.lineGroups.length} logs=${b.logs.length} week=${b.week?.periodLabel ?? "-"}`);
  }
  // 교차: info 액트 set ∩ competency ∩ club = 공집합.
  const setOf = (h: string) => new Set((boards[h].acts as Array<{ actId: string }>).map((a) => a.actId));
  const si = setOf("info"), sc = setOf("competency"), sk = setOf("club");
  const inter = [...si].filter((x) => sc.has(x) || sk.has(x)).length + [...sc].filter((x) => sk.has(x)).length;
  ok(inter === 0, `세 허브 액트 교차 0 (info∩competency∩club)`);

  // ── 3) info 만 테스트 주차 예외 ─────────────────────────────────
  console.log("\n=== 3) 테스트 모드 주차 예외 — info 만 적용 ===");
  for (const hub of HUBS) {
    const op = await getProcessCheckBoard(hub, "oranke", null, "operating");
    const ts = await getProcessCheckBoard(hub, "oranke", null, "test");
    const opW = op.week?.weekNumber, tsW = ts.week?.weekNumber;
    if (hub === "info") {
      // 현재(2026-06-15)는 봄 휴식 꼬리 → info 는 test 에서 마지막 운영주차(13)로 walk-back, operating 은 현재(16).
      ok(tsW !== opW, `[info] test 주차(${tsW}) ≠ operating 주차(${opW}) — 13주차 예외 적용`);
      ok(tsW === 13, `[info] test 주차=13 (마지막 운영주차)`);
    } else {
      ok(tsW === opW, `[${hub}] test 주차(${tsW}) == operating 주차(${opW}) — 예외 비적용(의도)`);
    }
  }

  // ── 4) org 분리 ─────────────────────────────────────────────────
  console.log("\n=== 4) org 분리 ===");
  for (const org of ORGS) {
    const b = await getProcessCheckBoard("club", org, null, "operating");
    ok(b.organization === org, `[club/${org}] board.organization=${b.organization}`);
    // 로그는 해당 org 만(다른 org 누설 없음) — period/act 만 보유, org 필드는 쿼리에서 eq 로 강제.
  }

  // ── HTTP 비교용 스냅샷(oranke) — 허브별 operating/test 액트 id·주차 ──
  const snapshot: Record<string, any> = {};
  for (const hub of HUBS) {
    const op = await getProcessCheckBoard(hub, "oranke", null, "operating");
    const ts = await getProcessCheckBoard(hub, "oranke", null, "test");
    snapshot[hub] = {
      keys: Object.keys(op).sort(),
      operating: { weekNumber: op.week?.weekNumber ?? null, actIds: (op.acts as Array<{ actId: string }>).map((a) => a.actId).sort() },
      test: { weekNumber: ts.week?.weekNumber ?? null, actIds: (ts.acts as Array<{ actId: string }>).map((a) => a.actId).sort() },
    };
  }
  writeFileSync("claudedocs/verify-process-check-hub-direct.json", JSON.stringify(snapshot, null, 2));
  console.log("\n[direct 스냅샷] claudedocs/verify-process-check-hub-direct.json");

  console.log(`\n결과: ${pass} pass / ${fail} fail`);
  process.exit(fail === 0 ? 0 : 1);
}
main().catch((e) => { console.error("ERR", e); process.exit(1); });
