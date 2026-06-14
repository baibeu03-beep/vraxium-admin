/**
 * verify-mutual-feedback-rename.ts (READ + snapshot recompute only)
 * EXOK-EN0004 라인명 정정 검증: direct == HTTP, lineName === 새 명칭.
 * mode=test 경로(라우트)는 effectiveFromOverride=TEST_SUMMER_SIM live compute 이므로 direct 도 동일 옵션 사용.
 * 실행: npx tsx --env-file=.env.local scripts/verify-mutual-feedback-rename.ts
 */
import { config } from "dotenv";
config({ path: ".env.local" });
import { createClient } from "@supabase/supabase-js";
import { getCluster4WeeklyCardsForProfileUser } from "@/lib/cluster4WeeklyCardsData";
import { recomputeAndStoreWeeklyCardsSnapshot, readWeeklyCardsSnapshot } from "@/lib/cluster4WeeklyCardsSnapshot";
import { TEST_SUMMER_SIM_EFFECTIVE_FROM } from "@/lib/lineAvailability";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
const BASE = process.env.SMOKE_BASE_URL ?? "http://localhost:3000";
const NEW = "[생산성] 상호 다면 피드백";
const OLD = "[생산성] 상호 피드백";
let pass = 0, fail = 0;
const check = (l: string, ok: boolean, d = "") => { console.log(`  ${ok ? "✓" : "✗"} ${l}${d ? ` — ${d}` : ""}`); ok ? pass++ : fail++; };
const en0004 = (cards: any[]) => (cards ?? []).flatMap((c: any) => c.lines ?? []).find((l: any) => l.partType === "experience" && l.lineCode === "EXOK-EN0004");

async function main() {
  const { data: lines } = await sb.from("cluster4_lines").select("id").eq("part_type", "experience").eq("line_code", "EXOK-EN0004");
  const lineIds = (lines ?? []).map((l: any) => l.id);
  const { data: tgts } = await sb.from("cluster4_line_targets").select("target_user_id").in("line_id", lineIds);
  const userIds = Array.from(new Set(((tgts ?? []) as any[]).map((t) => t.target_user_id)));
  check("EXOK-EN0004 타깃 유저 존재", userIds.length > 0, `n=${userIds.length}`);
  const uid = userIds[0];
  console.log(`  대상 user=${uid}`);

  // snapshot stale 처리 확인(운영 경로 대비) + 재계산 후 stale 해제 확인.
  const before = await readWeeklyCardsSnapshot(uid);
  console.log(`  snapshot(before recompute) status=${before.status}${(before as any).reason ? `(${(before as any).reason})` : ""}`);
  await recomputeAndStoreWeeklyCardsSnapshot(uid);
  const after = await readWeeklyCardsSnapshot(uid);
  check("snapshot 재계산 후 hit(stale 해제)", after.status === "hit", `status=${after.status}`);

  // direct (mode=test 라우트와 동일 옵션)
  const direct = await getCluster4WeeklyCardsForProfileUser(uid, { effectiveFromOverride: TEST_SUMMER_SIM_EFFECTIVE_FROM });
  const dLine = en0004(direct);
  check("[direct] EXOK-EN0004 라인 존재", !!dLine);
  check("[direct] lineName === 새 명칭", dLine?.lineName === NEW, `"${dLine?.lineName}"`);
  check("[direct] 구 명칭 미잔존", dLine?.lineName !== OLD);
  check("[direct] mainTitle 무변경(긴 인용문 유지)", typeof dLine?.mainTitle === "string" && dLine.mainTitle.includes("100명의 사람"), `"${(dLine?.mainTitle ?? "").slice(0, 24)}…"`);

  // HTTP (demoUserId override, mode=test)
  let httpLine: any = null, httpStatus = 0;
  try {
    const r = await fetch(`${BASE}/api/cluster4/weekly-cards?demoUserId=${uid}&mode=test`);
    httpStatus = r.status;
    httpLine = en0004((await r.json()).data ?? []);
  } catch (e) { console.log("  HTTP fetch 실패:", (e as Error).message); }
  check("[HTTP] 200", httpStatus === 200, `status=${httpStatus}`);
  check("[HTTP] lineName === 새 명칭", httpLine?.lineName === NEW, `"${httpLine?.lineName}"`);

  // direct == HTTP (해당 라인 deep-equal)
  check("[direct == HTTP] EXOK-EN0004 라인 deep-equal", JSON.stringify(dLine) === JSON.stringify(httpLine));

  console.log(`\n결과: ${pass} pass / ${fail} fail`);
  process.exit(fail > 0 ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
