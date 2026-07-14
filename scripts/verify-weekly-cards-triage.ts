// verify-weekly-cards-triage.ts
// weekly-cards 3종 요구사항 통합 재검증(dev server 필요, HTTP):
//   1) demo 인증 매트릭스 — 정식 조건(demoUserId=테스트유저)=200 / 비허용 조합(demoUserId=일반유저)=403.
//   2) 3경로(일반 / mode=test / demoUserId) HTTP 200 + 동일 DTO(direct snapshot 과도 canonical 동등).
//   3) v39 수렴 — version_mismatch(bg) 이후 두 번째 조회부터 HIT(v39, no mismatch) + direct==HTTP.
//   4) 승인 휴식 주차가 recompute 를 거쳐도 personal_rest / "휴식(개인)" 로 유지.
//
// 실행:
//   SMOKE_BASE_URL=http://127.0.0.1:3000 npx tsx --env-file=.env.local scripts/verify-weekly-cards-triage.ts
import { createClient } from "@supabase/supabase-js";
import {
  WEEKLY_CARDS_DTO_VERSION,
  readWeeklyCardsSnapshot,
  recomputeAndStoreWeeklyCardsSnapshot,
} from "@/lib/cluster4WeeklyCardsSnapshot";
import { getCluster4WeeklyCardsForProfileUser } from "@/lib/cluster4WeeklyCardsData";

const sb = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);
const BASE = process.env.SMOKE_BASE_URL ?? "http://127.0.0.1:3000";
const KEY = process.env.INTERNAL_API_KEY ?? "";
const TABLE = "cluster4_weekly_card_snapshots";
const LATEST = WEEKLY_CARDS_DTO_VERSION;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type Card = {
  weekId?: string;
  startDate?: string;
  weekNumber?: number;
  userWeekStatus?: string;
  isRestWeek?: boolean;
};

let pass = 0;
let fail = 0;
const check = (n: string, ok: boolean, d = "") => {
  console.log(`  ${ok ? "✓" : "✗"} ${n}${d ? ` — ${d}` : ""}`);
  ok ? pass++ : fail++;
};

function canonical(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(canonical);
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(o).sort()) out[k] = canonical(o[k]);
    return out;
  }
  return v;
}
const canonEq = (a: unknown, b: unknown) =>
  JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));

async function http(
  qs: string,
  internal: boolean,
): Promise<{ status: number; cards: Card[]; message: string | null }> {
  const res = await fetch(`${BASE}/api/cluster4/weekly-cards?${qs}`, {
    headers: internal ? { "x-internal-api-key": KEY } : {},
  });
  const j: any = await res.json().catch(() => ({}));
  return {
    status: res.status,
    cards: Array.isArray(j?.data) ? j.data : [],
    message: j?.error?.message ?? null,
  };
}

async function readRow(userId: string) {
  const { data } = await sb
    .from(TABLE)
    .select("dto_version,is_stale,card_count,computed_at")
    .eq("user_id", userId)
    .maybeSingle();
  return data as
    | { dto_version: number; is_stale: boolean; card_count: number; computed_at: string }
    | null;
}

async function main() {
  console.log("═══════════ weekly-cards 통합 재검증 ═══════════");
  console.log(`BASE=${BASE} | LATEST(dto_version)=${LATEST}`);
  if (!KEY) throw new Error("INTERNAL_API_KEY 미설정");

  // 테스트 유저 id 집합
  const { data: markers } = await sb.from("test_user_markers").select("user_id");
  const testIds = new Set(
    ((markers ?? []) as { user_id: string }[]).map((m) => m.user_id).filter(Boolean),
  );
  if (testIds.size === 0) throw new Error("test_user_markers 비어 있음");

  // 스냅샷 보유 테스트 유저(카드>=2). 휴식(personal_rest) 카드 보유자를 우선 선택.
  const { data: snaps } = await sb
    .from(TABLE)
    .select("user_id,cards,card_count,dto_version,is_stale")
    .in("user_id", Array.from(testIds))
    .gte("card_count", 2)
    .limit(500);
  const testSnaps = (snaps ?? []) as Array<{
    user_id: string;
    cards: Card[];
    card_count: number;
    dto_version: number;
    is_stale: boolean;
  }>;
  if (testSnaps.length === 0) throw new Error("테스트 유저 snapshot 없음");

  const restSnap =
    testSnaps.find((s) =>
      (s.cards ?? []).some((c) => c.userWeekStatus === "personal_rest"),
    ) ?? null;
  const primary = restSnap ?? testSnaps[0];
  const userId = primary.user_id;

  const { data: prof } = await sb
    .from("user_profiles")
    .select("display_name,organization_slug")
    .eq("user_id", userId)
    .maybeSingle();
  console.log(
    `\n대상 테스트 유저: ${prof?.display_name} (${userId}) org=${prof?.organization_slug}`,
  );
  console.log(
    `  personal_rest 카드 보유 유저 선택=${restSnap ? "예" : "아니오(폴백: 임의 테스트유저)"}`,
  );

  // 비-테스트(일반) 유저 1명 — 403 재현용.
  let nonTestUserId: string | null = null;
  const { data: cand } = await sb
    .from("user_profiles")
    .select("user_id,display_name")
    .limit(2000);
  for (const r of (cand ?? []) as { user_id: string; display_name: string }[]) {
    if (r.user_id && !testIds.has(r.user_id)) {
      nonTestUserId = r.user_id;
      break;
    }
  }

  // ───────── 1) demo 인증 매트릭스 ─────────
  console.log("\n[1] demo 인증 매트릭스 (세션/internal-key 없이 demoUserId 만)");
  const demoValid = await http(`demoUserId=${userId}`, false);
  console.log(
    `    demoUserId=<테스트유저>        → status=${demoValid.status} cards=${demoValid.cards.length}`,
  );
  check(
    "정식 demo 조건(demoUserId=테스트유저) → 200 + cards>0",
    demoValid.status === 200 && demoValid.cards.length > 0,
  );
  if (nonTestUserId) {
    const demoBad = await http(`demoUserId=${nonTestUserId}`, false);
    console.log(
      `    demoUserId=<일반(비테스트)유저> → status=${demoBad.status} message="${demoBad.message}"`,
    );
    check(
      "비허용 조합(demoUserId=일반유저) → 403 (DemoModeError)",
      demoBad.status === 403,
      demoBad.message ?? "",
    );
  } else {
    console.log("    (비-테스트 유저를 찾지 못해 403 재현 생략)");
  }

  // ───────── 2) 3경로 200 + 동일 DTO ─────────
  console.log("\n[2] 3경로 HTTP 200 + 동일 DTO");
  const pPlain = await http(`userId=${userId}`, true); // 일반(세션 동일 코드경로) via internal-key
  const pTest = await http(`userId=${userId}&mode=test`, true); // 테스트 모드
  const pDemo = await http(`demoUserId=${userId}`, false); // demoUserId 경로
  const direct = (await getCluster4WeeklyCardsForProfileUser(userId)) as unknown[];
  console.log(
    `    일반(userId)       status=${pPlain.status} cards=${pPlain.cards.length}`,
  );
  console.log(
    `    테스트(mode=test)  status=${pTest.status} cards=${pTest.cards.length}`,
  );
  console.log(
    `    demoUserId         status=${pDemo.status} cards=${pDemo.cards.length}`,
  );
  console.log(`    direct snapshot    cards=${direct.length}`);
  check("일반 모드 HTTP 200", pPlain.status === 200);
  check("테스트 모드 HTTP 200", pTest.status === 200);
  check("demoUserId 경로 HTTP 200", pDemo.status === 200);
  check("일반 == 테스트 (mode 가 DTO 불변)", canonEq(pPlain.cards, pTest.cards));
  check("일반 == demoUserId", canonEq(pPlain.cards, pDemo.cards));
  check("일반 == direct snapshot", canonEq(pPlain.cards, direct));

  // ───────── 3) v39 수렴 ─────────
  console.log("\n[3] v39 스냅샷 수렴 (version_mismatch → HIT)");
  const before = await readRow(userId);
  console.log(
    `    현재 저장본: v${before?.dto_version} is_stale=${before?.is_stale} cards=${before?.card_count}`,
  );
  // 첫 조회로 (필요시) bg 수렴을 트리거하고, DB 가 최신 v39·fresh 로 안정될 때까지 폴링.
  await http(`userId=${userId}`, true);
  let converged = before;
  for (let i = 0; i < 60; i++) {
    const r = await readRow(userId);
    if (r && r.dto_version === LATEST && !r.is_stale) {
      converged = r;
      break;
    }
    await sleep(500);
  }
  console.log(
    `    수렴 후 저장본: v${converged?.dto_version} is_stale=${converged?.is_stale} cards=${converged?.card_count}`,
  );
  const snapAfter = await readWeeklyCardsSnapshot(userId);
  console.log(`    readWeeklyCardsSnapshot outcome=${snapAfter.status} (기대=hit)`);
  check(
    "수렴 후 저장본 dto_version == 39",
    converged?.dto_version === LATEST,
    `v${converged?.dto_version}`,
  );
  check(
    "두 번째 조회 = HIT (더 이상 version_mismatch 아님)",
    snapAfter.status === "hit",
    `status=${snapAfter.status}`,
  );
  const second = await http(`userId=${userId}`, true);
  const directAfter = (await getCluster4WeeklyCardsForProfileUser(userId)) as unknown[];
  check("두 번째 HTTP 200", second.status === 200);
  check("두 번째 HTTP == direct (canonical)", canonEq(second.cards, directAfter));

  // ───────── 4) 승인 휴식 personal_rest 유지 ─────────
  console.log("\n[4] 승인 휴식 주차 personal_rest 유지");
  if (restSnap) {
    const restWeeksBefore = (restSnap.cards ?? [])
      .filter((c) => c.userWeekStatus === "personal_rest")
      .map((c) => c.startDate ?? c.weekId);
    console.log(
      `    저장본 personal_rest 주차(${restWeeksBefore.length}): ${restWeeksBefore.join(", ")}`,
    );
    // recompute 를 실제로 돌려(승인 휴식 SoT 재판정) 여전히 personal_rest 인지 확인.
    const recomputed = (await recomputeAndStoreWeeklyCardsSnapshot(userId)) as Card[];
    const restWeeksAfter = recomputed
      .filter((c) => c.userWeekStatus === "personal_rest")
      .map((c) => c.startDate ?? c.weekId);
    console.log(
      `    recompute 후 personal_rest 주차(${restWeeksAfter.length}): ${restWeeksAfter.join(", ")}`,
    );
    // HTTP 응답에서도 동일 주차가 personal_rest 인지.
    const httpRest = await http(`userId=${userId}`, true);
    const httpRestWeeks = httpRest.cards
      .filter((c) => c.userWeekStatus === "personal_rest")
      .map((c) => c.startDate ?? c.weekId);
    check(
      "recompute 후에도 동일 주차 personal_rest 유지",
      restWeeksBefore.length > 0 &&
        JSON.stringify(restWeeksBefore.sort()) ===
          JSON.stringify(restWeeksAfter.sort()),
      `before=${restWeeksBefore.length} after=${restWeeksAfter.length}`,
    );
    check(
      "HTTP 응답에서도 personal_rest 유지",
      JSON.stringify(restWeeksAfter.sort()) ===
        JSON.stringify(httpRestWeeks.sort()),
    );
  } else {
    console.log(
      "    (personal_rest 카드 보유 테스트 유저를 찾지 못해 이 항목은 데이터 부재로 생략)",
    );
    console.log(
      "    → 별도 approvedRestWeeks 직접 검증 필요 시 승인 휴식 유저 지정 재실행 권장.",
    );
  }

  console.log(`\n결과: pass=${pass} fail=${fail}`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("fatal", e);
  process.exit(1);
});
