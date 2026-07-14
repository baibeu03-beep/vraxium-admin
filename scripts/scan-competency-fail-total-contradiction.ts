/**
 * [실무 역량] "강화 실패 카드 + 시즌집계 총 0" 모순 실제 스캔 (HTTP 기준).
 *   npx tsx --env-file=.env.local scripts/scan-competency-fail-total-contradiction.ts
 *
 * 전 테스트 유저 HTTP weekly-cards 를 훑어, competency enhancementStatus=fail 카드가 있는데
 *   그 카드의 시즌 seasonAreaProgressBySeason[season].competency.total == 0 인 경우(모순)를 찾는다.
 * 발견 시 그 (user, org, season, week) 를 상세 출력 → 실제 재현 케이스로 후속 추적.
 */
import { config } from "dotenv";
config({ path: ".env.local" });
import { createClient } from "@supabase/supabase-js";
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
const IKEY = process.env.INTERNAL_API_KEY!;
const BASE = "http://localhost:3000";

async function main() {
  const { data: tm } = await sb.from("test_user_markers").select("user_id");
  const ids = (tm ?? []).map((x: any) => x.user_id);
  const { data: profs } = await sb.from("user_profiles").select("user_id,display_name,organization_slug").in("user_id", ids);
  const byId = new Map((profs ?? []).map((p: any) => [p.user_id, p]));

  const contradictions: any[] = [];
  let scanned = 0, failCards = 0;
  for (const uid of ids) {
    let j: any;
    try {
      const res = await fetch(`${BASE}/api/cluster4/weekly-cards?userId=${uid}`, { headers: { "x-internal-api-key": IKEY } });
      j = await res.json();
    } catch { continue; }
    scanned++;
    const cards = Array.isArray(j?.data) ? j.data : [];
    const sapBy = j?.seasonAreaProgressBySeason ?? {};
    const sapTop = Array.isArray(j?.seasonAreaProgress) ? j.seasonAreaProgress : [];
    const compTotal = (arr: any[]) => (arr ?? []).find((x: any) => x.key === "practical_competency")?.total ?? 0;
    for (const c of cards) {
      const comp = (c.lines ?? []).filter((l: any) => l.partType === "competency");
      for (const l of comp) {
        if (l.enhancementStatus === "fail") {
          failCards++;
          const seasonKey = c.seasonKey;
          const totalBySeason = compTotal(sapBy[seasonKey] ?? []);
          const totalTop = compTotal(sapTop);
          // 모순: fail 카드인데 그 시즌 집계 total==0 (분모 미포함)
          if (totalBySeason === 0) {
            contradictions.push({
              user: byId.get(uid)?.display_name, uid: uid.slice(0, 8), org: byId.get(uid)?.organization_slug,
              seasonKey, week: c.weekId?.slice(0, 8), weekNumber: c.weekNumber,
              cardEnh: l.enhancementStatus, reason: l.enhancementReason, tgt: l.lineTargetId ? "Y" : null, den: l.denominator,
              seasonTotal_bySeason: totalBySeason, seasonTotal_top: totalTop,
              currentSeasonTopKey: sapTop.length ? "(top=현재시즌)" : "",
            });
          }
        }
      }
    }
  }
  console.log(`스캔 유저=${scanned}, competency fail 카드=${failCards}, 모순(fail인데 시즌집계 총0)=${contradictions.length}`);
  if (contradictions.length > 0) {
    console.log("\n=== 모순 케이스 (fail 카드 + seasonAreaProgressBySeason[season].total==0) ===");
    for (const c of contradictions.slice(0, 20)) console.log("  " + JSON.stringify(c));
    // 대표 케이스 1건 상세 힌트
    const first = contradictions[0];
    console.log(`\n=== 후속 추적 대상: user=${first.uid} org=${first.org} season=${first.seasonKey} week=${first.week} ===`);
  } else {
    console.log("\n=> HTTP 응답 레벨에서 모순 없음. (fail 카드가 있는 시즌은 집계 total>=1)");
    console.log("   → 고객 앱에 여전히 보이면 프론트 시즌선택/렌더 문제. seasonAreaProgress(top=현재시즌) 사용 여부 확인 필요.");
    // top(현재시즌) 집계와 fail 카드 시즌이 다른 케이스 별도 리포트(프론트가 top 을 읽으면 모순)
    console.log("\n(참고) top-level seasonAreaProgress 는 현재시즌 고정 — 프론트가 이걸 읽으면 과거시즌 fail 카드와 어긋남.");
  }
}
main().catch((e) => { console.error("FATAL", e?.stack ?? e); process.exit(1); });
