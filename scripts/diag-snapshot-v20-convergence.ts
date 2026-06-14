/**
 * diag-snapshot-v20-convergence.ts  (READ-ONLY — write 0, 재계산 0)
 * snapshot v20 수렴 상태 점검.
 * 실행: npx tsx --env-file=.env.local scripts/diag-snapshot-v20-convergence.ts
 */
import { config } from "dotenv";
config({ path: ".env.local" });
import { createClient } from "@supabase/supabase-js";
import { getCluster4WeeklyCardsForProfileUser } from "@/lib/cluster4WeeklyCardsData";
import { WEEKLY_CARDS_DTO_VERSION, readWeeklyCardsSnapshot } from "@/lib/cluster4WeeklyCardsSnapshot";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
const BASE = process.env.SMOKE_BASE_URL ?? "http://localhost:3000";
const INTERNAL_KEY = process.env.INTERNAL_API_KEY ?? "";

async function main() {
  console.log(`[1] WEEKLY_CARDS_DTO_VERSION = ${WEEKLY_CARDS_DTO_VERSION}\n`);

  // 전체 snapshot user_id + dto_version + is_stale + computed_at (363행 규모 — cap 내).
  const { data: rows } = await sb
    .from("cluster4_weekly_card_snapshots")
    .select("user_id,dto_version,is_stale,computed_at")
    .order("user_id", { ascending: true })
    .range(0, 4999);
  const all = (rows ?? []) as Array<{ user_id: string; dto_version: number; is_stale: boolean; computed_at: string }>;

  // 테스트 유저 집합.
  const { data: markers } = await sb.from("test_user_markers").select("user_id");
  const testSet = new Set((markers ?? []).map((m: any) => m.user_id));

  // dto_version 분포 (test/real 분리).
  const byVer = new Map<number, { test: number; real: number }>();
  for (const r of all) {
    const b = byVer.get(r.dto_version) ?? { test: 0, real: 0 };
    if (testSet.has(r.user_id)) b.test++; else b.real++;
    byVer.set(r.dto_version, b);
  }
  console.log(`전체 snapshot 행: ${all.length}`);
  console.log(`dto_version 분포 (test / real):`);
  for (const v of Array.from(byVer.keys()).sort((a, b) => b - a)) {
    const b = byVer.get(v)!;
    console.log(`  v${v}: ${b.test + b.real}  (test ${b.test} / real ${b.real})${v === WEEKLY_CARDS_DTO_VERSION ? "  ← 현재" : ""}`);
  }

  const v19 = all.filter((r) => r.dto_version === 19);
  const v20 = all.filter((r) => r.dto_version === WEEKLY_CARDS_DTO_VERSION);
  const v19real = v19.filter((r) => !testSet.has(r.user_id));
  const staleCount = all.filter((r) => r.is_stale).length;
  console.log(`\n[2] v19 snapshot: ${v19.length} (real ${v19real.length})`);
  console.log(`[3] v20 snapshot: ${v20.length}`);
  console.log(`[4] 실사용자 영향: dto_version≠20 인 실사용자 = ${all.filter((r) => r.dto_version !== WEEKLY_CARDS_DTO_VERSION && !testSet.has(r.user_id)).length}명`);
  console.log(`    (이들은 version_mismatch 로 read 경로 lazy 재계산 미적용 → 구 카드 서빙)`);

  // [5] recompute-snapshots 후보 = is_stale OR due(1h) OR dto_version≠20.
  const candidates = all.filter((r) => r.is_stale || r.dto_version !== WEEKLY_CARDS_DTO_VERSION);
  console.log(`\n[5] recompute-snapshots 영향: 후보 ${candidates.length}행 (is_stale ${staleCount} ∪ dto≠20 ${all.length - v20.length})`);
  console.log(`    ops 엔드포인트는 maxUsers(기본200) 만큼 오래된 순으로 재계산(write) → v20 수렴. 1회당 최대 200명.`);

  // [6] direct vs HTTP 차이 — v19 표본.
  console.log(`\n[6] direct vs HTTP (v19 표본):`);
  const sample = v19.find((r) => testSet.has(r.user_id)) ?? v19[0];
  if (!sample) {
    console.log(`    v19 행 없음 — 이미 전량 수렴.`);
  } else {
    const isTest = testSet.has(sample.user_id);
    const snap = await readWeeklyCardsSnapshot(sample.user_id);
    const storedCards = snap.status === "hit" || snap.status === "stale" ? snap.cards : [];
    const reason = (snap as any).reason ?? snap.status;
    let httpCards: any[] = [];
    let httpStatus = 0;
    try {
      const url = isTest
        ? `${BASE}/api/cluster4/weekly-cards?demoUserId=${sample.user_id}`
        : `${BASE}/api/cluster4/weekly-cards?userId=${sample.user_id}`;
      const res = await fetch(url, isTest ? {} : { headers: { "x-internal-api-key": INTERNAL_KEY } });
      httpStatus = res.status;
      httpCards = (await res.json()).data ?? [];
    } catch (e) { console.log("    HTTP 실패:", e instanceof Error ? e.message : e); }
    const direct = await getCluster4WeeklyCardsForProfileUser(sample.user_id);
    console.log(`    표본 ${sample.user_id} (${isTest ? "test" : "real"}) snap=${snap.status}/${reason}`);
    console.log(`    저장(HTTP가 서빙) cards=${storedCards.length} | HTTP status=${httpStatus} cards=${httpCards.length} | direct(v20) cards=${direct.length}`);
    const httpEqStored = JSON.stringify(httpCards) === JSON.stringify(storedCards);
    const directEqHttp = JSON.stringify(direct) === JSON.stringify(httpCards);
    console.log(`    HTTP == 저장본(v19): ${httpEqStored} (version_mismatch → lazy 재계산 안 함, 구 카드 서빙)`);
    console.log(`    direct(v20) == HTTP(v19): ${directEqHttp} ${directEqHttp ? "" : "← 차이 존재(수렴 전)"}`);
  }

  // 재확인 후 결론.
  const needConverge = all.filter((r) => r.dto_version !== WEEKLY_CARDS_DTO_VERSION).length;
  console.log(`\n=== 결론 ===`);
  console.log(`  v20 미수렴 행: ${needConverge} (실사용자 ${all.filter((r) => r.dto_version !== WEEKLY_CARDS_DTO_VERSION && !testSet.has(r.user_id)).length})`);
  console.log(`  수렴 필요: ${needConverge > 0 ? "예 — recompute-snapshots ops 실행 권장" : "아니오 — 전량 v20"}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
