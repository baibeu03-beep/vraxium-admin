/**
 * READ-ONLY 진단: 윤서진 week13 전 part(info/experience/career/competency) 최종 DTO 전수 덤프.
 *   - [A] 저장된 snapshot.cards (= 조회 API 가 stale 로 실제 서빙하는 payload)
 *   - [B] 라이브 빌더 (현재 v5 코드, 미저장)
 *   각 라인의 partType/status/lineTargetId/lineCode/lineName/mainTitle/outputLinks/outputImages/canEdit
 *   npx tsx --env-file=.env.local scripts/diag-cluster4-yunseojin-week13-fulldto.ts
 */
import { config } from "dotenv";
config({ path: ".env.local" });
import { createClient } from "@supabase/supabase-js";
import { getCluster4WeeklyCardsForProfileUser } from "@/lib/cluster4WeeklyCardsData";
import { readWeeklyCardsSnapshot, WEEKLY_CARDS_DTO_VERSION } from "@/lib/cluster4WeeklyCardsSnapshot";

const sb = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);
const NAME = "윤서진";
const WEEK_START = "2026-05-25";

const pickWeek = (cards: any[]) =>
  (cards ?? []).find((c) => (c.startDate ?? "").startsWith(WEEK_START) || c.weekNumber === 13);

function dumpLines(label: string, card: any) {
  console.log(`\n========== ${label} ==========`);
  if (!card) {
    console.log("  (해당 주차 카드 없음)");
    return;
  }
  console.log(
    `  weekId=${card.weekId} weekNumber=${card.weekNumber} isRestWeek=${card.isRestWeek} userWeekStatus=${card.userWeekStatus} lines=${(card.lines ?? []).length}`,
  );
  const order = ["information", "experience", "career", "competency"];
  const lines = [...(card.lines ?? [])].sort(
    (a, b) => order.indexOf(a.partType) - order.indexOf(b.partType),
  );
  for (const l of lines) {
    console.log(
      `  · part=${l.partType.padEnd(12)} status=${String(l.status).padEnd(8)} ` +
        `tgtId=${l.lineTargetId ? "Y" : "—"} lineId=${l.lineId ? l.lineId.slice(0, 8) : "—"} ` +
        `code=${l.lineCode ?? "—"}`,
    );
    console.log(
      `        lineName=${JSON.stringify(l.lineName)}  mainTitle=${JSON.stringify((l.mainTitle ?? "")?.slice?.(0, 40))}`,
    );
    console.log(
      `        outLinks=${(l.outputLinks ?? []).length} outImgs=${(l.outputImages ?? []).length} ` +
        `adminLinkCnt=${l.adminOutputLinkCount} adminImgCnt=${l.adminOutputImageCount} ` +
        `enhStatus=${l.enhancementStatus} canEdit=${l.canEdit} editReason=${l.editReason}`,
    );
  }
}

async function main() {
  const { data: profs } = await sb
    .from("user_profiles")
    .select("user_id,display_name")
    .ilike("display_name", `%${NAME}%`);
  const userId = profs![0].user_id as string;
  console.log(`userId=${userId}  현재 코드 DTO_VERSION=${WEEKLY_CARDS_DTO_VERSION}`);

  // [A] 조회 API 가 실제 서빙하는 outcome (snapshot-only)
  const snap = await readWeeklyCardsSnapshot(userId);
  console.log(`\n[조회 API outcome] status=${snap.status}${(snap as any).reason ? `(${(snap as any).reason})` : ""}`);
  if (snap.status === "hit" || snap.status === "stale") {
    dumpLines(`[A] 서빙 payload (snapshot ${snap.status})`, pickWeek(snap.cards));
  }

  // [B] 라이브 빌더
  const fresh = await getCluster4WeeklyCardsForProfileUser(userId);
  dumpLines("[B] 라이브 빌더 (v5 현재 코드)", pickWeek(fresh));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
