/**
 * READ-ONLY 진단: 특정 사용자(윤서진) / 봄 시즌 13주차 experience 카드의 lineName 추적.
 *   DB 원본(master.line_name) → 빌더 결과(live build) → snapshot payload 3단 비교.
 *   npx tsx --env-file=.env.local scripts/diag-cluster4-yunseojin-linename.ts
 */
import { config } from "dotenv";
config({ path: ".env.local" });
import { createClient } from "@supabase/supabase-js";
import { getCluster4WeeklyCardsForProfileUser } from "@/lib/cluster4WeeklyCardsData";
import { WEEKLY_CARDS_DTO_VERSION } from "@/lib/cluster4WeeklyCardsSnapshot";

const sb = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);
const j = (v: unknown) => (v === undefined ? "«undefined»" : v === null ? "null" : JSON.stringify(v));
const NAME = "윤서진";
const WEEK_START = "2026-05-25"; // 13주차 시작일

async function main() {
  // 0) user_id 조회
  const { data: profs } = await sb
    .from("user_profiles")
    .select("user_id,display_name")
    .ilike("display_name", `%${NAME}%`);
  if (!profs?.length) throw new Error(`'${NAME}' user_profiles 미발견`);
  console.log(`후보 ${profs.length}명:`, profs.map((p: any) => `${p.display_name}(${p.user_id})`).join(", "));
  const userId = profs[0].user_id as string;
  console.log(`\n선택 userId = ${userId}\n`);

  // 1) snapshot 행 메타
  const { data: snapRows } = await sb
    .from("cluster4_weekly_card_snapshots")
    .select("user_id,dto_version,is_stale,card_count,computed_at,cards")
    .eq("user_id", userId)
    .maybeSingle();
  const snap = snapRows as any;
  console.log("=== [1] snapshot 행 ===");
  if (!snap) {
    console.log("  snapshot 행 없음 (miss)\n");
  } else {
    console.log(
      `  dto_version=${snap.dto_version} (현재 코드 = ${WEEKLY_CARDS_DTO_VERSION})  is_stale=${snap.is_stale}  card_count=${snap.card_count}  computed_at=${snap.computed_at}`,
    );
    console.log(`  → ${snap.dto_version === WEEKLY_CARDS_DTO_VERSION ? "v" + snap.dto_version + " (최신)" : "구버전 — 재생성 필요"}\n`);
  }

  const pickWeekCard = (cards: any[]) =>
    (cards ?? []).find(
      (c) => (c.startDate ?? "").startsWith(WEEK_START) || c.weekNumber === 13,
    );

  // 2) snapshot.cards 의 해당 주차 experience 라인
  console.log("=== [2] snapshot payload — 해당 주차 experience 라인 ===");
  let snapWeekId: string | null = null;
  if (snap?.cards) {
    const card = pickWeekCard(snap.cards);
    if (!card) {
      console.log("  해당 주차 카드 미발견 (cards 내 startDate/weekNumber 불일치)\n");
    } else {
      snapWeekId = card.weekId ?? null;
      console.log(`  weekId=${card.weekId} weekNumber=${card.weekNumber} label=${j(card.weekLabel)} startDate=${j(card.startDate)}`);
      const exps = (card.lines ?? []).filter((l: any) => l.partType === "experience");
      console.log(`  experience 라인 ${exps.length}건:`);
      for (const l of exps) {
        console.log(
          `   · lineId=${l.lineId ?? "null"}  status=${l.status}  hasKey(lineName)=${"lineName" in l}  lineName=${j(l.lineName)}  mainTitle=${j(l.mainTitle)?.slice(0, 30)}…  expMasterId=${j(l.experienceLineMasterId)}`,
        );
      }
      console.log("");
    }
  }

  // 3) 라이브 빌더 재계산 (저장 안 함) — 현재 코드가 만들어내는 결과
  console.log("=== [3] 라이브 빌더 결과 (현재 코드, 미저장) — 해당 주차 experience 라인 ===");
  const freshCards = await getCluster4WeeklyCardsForProfileUser(userId);
  const freshCard = pickWeekCard(freshCards);
  const freshExpLines: any[] = [];
  if (!freshCard) {
    console.log("  해당 주차 카드 미발견\n");
  } else {
    snapWeekId = snapWeekId ?? freshCard.weekId ?? null;
    const exps = (freshCard.lines ?? []).filter((l: any) => l.partType === "experience");
    for (const l of exps) freshExpLines.push(l);
    console.log(`  weekId=${freshCard.weekId} experience ${exps.length}건:`);
    for (const l of exps) {
      console.log(
        `   · lineId=${l.lineId ?? "null"}  status=${l.status}  lineName=${j(l.lineName)}  expMasterId=${j(l.experienceLineMasterId)}`,
      );
    }
    console.log("");
  }

  // 4) DB 원본: 빌더에 등장한 experience lineId → cluster4_lines → master.line_name
  console.log("=== [4] DB 원본 (cluster4_lines → experience master.line_name) ===");
  const lineIds = Array.from(new Set(freshExpLines.map((l) => l.lineId).filter(Boolean)));
  if (!lineIds.length) {
    console.log("  experience lineId 없음 (개설/배정된 라인 없음 — lineName=null 정상)\n");
  } else {
    const { data: lineRows } = await sb
      .from("cluster4_lines")
      .select("id,part_type,main_title,experience_line_master_id,is_active")
      .in("id", lineIds);
    const expMasterIds = (lineRows ?? []).map((r: any) => r.experience_line_master_id).filter(Boolean);
    const { data: masters } = expMasterIds.length
      ? await sb.from("cluster4_experience_line_masters").select("id,line_code,line_name,is_active").in("id", expMasterIds)
      : { data: [] as any[] };
    const masterById = new Map((masters ?? []).map((m: any) => [m.id, m]));
    for (const r of (lineRows ?? []) as any[]) {
      const m = r.experience_line_master_id ? masterById.get(r.experience_line_master_id) : null;
      console.log(
        `  lineId=${r.id}  is_active=${r.is_active}\n` +
          `     experience_line_master_id = ${j(r.experience_line_master_id)}` +
          `${r.experience_line_master_id && !m ? "  ⚠ master 행 미발견(조인 실패!)" : ""}\n` +
          `     master.line_code = ${j(m?.line_code)}  master.is_active = ${j(m?.is_active)}\n` +
          `     master.line_name = ${j(m?.line_name)}   ← 이 값이 lineName 으로 내려가야 함`,
      );
    }
    console.log("");
  }

  console.log("=== 결론 힌트 ===");
  console.log(`  snapshot dto_version = ${snap?.dto_version ?? "없음"} / 현재 = ${WEEKLY_CARDS_DTO_VERSION}`);
  console.log(`  → [2]snapshot lineName vs [3]빌더 lineName vs [4]DB master.line_name 비교로 단계 특정`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
