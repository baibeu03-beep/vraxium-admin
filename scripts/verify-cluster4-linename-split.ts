/**
 * 검증: lineName/mainTitle 분리. 실제 빌더로 snapshot 을 재계산해(=고객 수신 payload)
 * 각 line 의 lineName 이 DB master.line_name 과, mainTitle 이 cluster4_lines.main_title 과
 * 정확히 일치하며 서로 섞이지 않는지 대조한다.
 *   npx tsx --env-file=.env.local scripts/verify-cluster4-linename-split.ts [profileUserId]
 */
import { config } from "dotenv";
config({ path: ".env.local" });
import { createClient } from "@supabase/supabase-js";
import { recomputeAndStoreWeeklyCardsSnapshot } from "@/lib/cluster4WeeklyCardsSnapshot";

const sb = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);
const j = (v: unknown) => (v == null ? "∅" : JSON.stringify(v));

async function main() {
  let userId = process.argv[2];
  if (!userId) {
    // 가장 카드가 많은(=라인 보유) 유저 1명 자동 선택.
    const { data } = await sb
      .from("cluster4_weekly_card_snapshots")
      .select("user_id,card_count")
      .order("card_count", { ascending: false })
      .limit(1);
    userId = (data ?? [])[0]?.user_id;
  }
  if (!userId) throw new Error("검증할 user_id 를 찾지 못했습니다.");
  console.log(`profileUserId = ${userId}\n`);

  // 1) 실제 빌더 → snapshot 재계산 (고객이 받는 payload 와 동일)
  const cards = await recomputeAndStoreWeeklyCardsSnapshot(userId);

  // 2) DB 원본 대조용: 빌더 결과에 등장한 lineId 들의 main_title + master line_name 수집
  type L = {
    partType: string;
    lineId: string | null;
    lineName: unknown;
    mainTitle: unknown;
  };
  const lines: L[] = [];
  for (const c of cards) for (const l of (c as any).lines ?? []) lines.push(l);
  const real = lines.filter(
    (l) => l.lineId && ["experience", "competency", "career"].includes(l.partType),
  );

  const lineIds = Array.from(new Set(real.map((l) => l.lineId as string)));
  const { data: lineRows } = await sb
    .from("cluster4_lines")
    .select(
      "id,part_type,main_title,competency_line_master_id,experience_line_master_id,career_project_id",
    )
    .in("id", lineIds.length ? lineIds : ["00000000-0000-0000-0000-000000000000"]);
  const lineById = new Map((lineRows ?? []).map((r: any) => [r.id, r]));

  const expIds = (lineRows ?? []).map((r: any) => r.experience_line_master_id).filter(Boolean);
  const compIds = (lineRows ?? []).map((r: any) => r.competency_line_master_id).filter(Boolean);
  const carIds = (lineRows ?? []).map((r: any) => r.career_project_id).filter(Boolean);
  const [exp, comp, car] = await Promise.all([
    expIds.length ? sb.from("cluster4_experience_line_masters").select("id,line_name").in("id", expIds) : Promise.resolve({ data: [] }),
    compIds.length ? sb.from("cluster4_competency_line_masters").select("id,line_name").in("id", compIds) : Promise.resolve({ data: [] }),
    carIds.length ? sb.from("career_projects").select("id,line_name").in("id", carIds) : Promise.resolve({ data: [] }),
  ]);
  const nameByMaster = new Map<string, string | null>();
  for (const r of (exp.data ?? []) as any[]) nameByMaster.set("e:" + r.id, r.line_name ?? null);
  for (const r of (comp.data ?? []) as any[]) nameByMaster.set("c:" + r.id, r.line_name ?? null);
  for (const r of (car.data ?? []) as any[]) nameByMaster.set("k:" + r.id, r.line_name ?? null);

  let ok = 0, fail = 0, distinct = 0, hasKey = 0;
  console.log("=== DTO.lineName / DTO.mainTitle  vs  DB 원본 ===\n");
  for (const l of real) {
    const row = lineById.get(l.lineId as string);
    if (!row) continue;
    if ("lineName" in l) hasKey++;
    let dbLineName: string | null = null;
    if (row.part_type === "experience") dbLineName = nameByMaster.get("e:" + row.experience_line_master_id) ?? null;
    else if (row.part_type === "competency") dbLineName = nameByMaster.get("c:" + row.competency_line_master_id) ?? null;
    else if (row.part_type === "career") dbLineName = nameByMaster.get("k:" + row.career_project_id) ?? null;
    const dbMain = row.main_title ?? null;

    const lineNameMatch = (l.lineName ?? null) === dbLineName;
    const mainMatch = (l.mainTitle ?? null) === dbMain;
    const noCrossContam = !(l.lineName != null && l.lineName === dbMain && dbLineName !== dbMain);
    const pass = lineNameMatch && mainMatch && noCrossContam;
    if (pass) ok++; else fail++;
    if (l.lineName != null && l.mainTitle != null && l.lineName !== l.mainTitle) distinct++;

    if (fail <= 6 || distinct <= 6) {
      console.log(
        `[${l.partType}] line=${l.lineId}\n` +
          `   DTO.lineName  = ${j(l.lineName)}   (DB master.line_name = ${j(dbLineName)})  ${lineNameMatch ? "✓" : "✗ MISMATCH"}\n` +
          `   DTO.mainTitle = ${j(l.mainTitle)}   (DB main_title = ${j(dbMain)})  ${mainMatch ? "✓" : "✗ MISMATCH"}` +
          `${l.lineName != null && l.mainTitle != null && l.lineName !== l.mainTitle ? "   ← 서로 다른 값 ✓" : ""}\n`,
      );
    }
  }

  console.log(
    `\n요약: real 라인 ${real.length}건 / lineName 키 존재 ${hasKey} / 일치(OK) ${ok} / 불일치 ${fail} / lineName≠mainTitle ${distinct}`,
  );
  console.log(fail === 0 ? "\n✅ 전부 일치 — lineName=master.line_name, mainTitle=main_title, 교차오염 없음" : "\n❌ 불일치 발생 — 위 로그 확인");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
