import { createClient } from "@supabase/supabase-js";
import { getCluster4WeeklyCardsForProfileUser } from "../lib/cluster4WeeklyCardsData";
import { recomputeWeeklyCardsSnapshotsForUsers } from "../lib/cluster4WeeklyCardsSnapshot";

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

const userId = "b83ae2d2-c8f2-4d90-ba20-f908182bf7c3";
const weekId = "496656d0-8d92-4738-b69b-e5e28aa1d57a";
const expMasterId = "6b27f21b-f679-4144-be20-db32357b7073";
const compMasterId = "a0797ea0-61e5-46f4-8a5f-ab88b0340f04";
const key = process.env.INTERNAL_API_KEY!;
const tag = `QA-OPERATING-VERIFY-20260701-${Date.now()}`;
const httpUrl = `http://localhost:3000/api/cluster4/weekly-cards?userId=${userId}&page=encre`;

function findLines(cards: any[], ids: string[]) {
  const out: any[] = [];
  for (const card of cards ?? []) {
    for (const line of card.lines ?? []) {
      if (ids.includes(line.lineId)) {
        out.push({
          weekId: card.weekId,
          partType: line.partType,
          lineId: line.lineId,
          lineCode: line.lineCode,
          mainTitle: line.mainTitle,
          status: line.status,
          lineTargetId: line.lineTargetId,
        });
      }
    }
  }
  return out;
}

async function httpCards() {
  const res = await fetch(httpUrl, { headers: { "x-internal-api-key": key } });
  const json = await res.json();
  if (!res.ok || !json.success) {
    throw new Error(`HTTP weekly-cards failed ${res.status}: ${JSON.stringify(json.error)}`);
  }
  return json.data;
}

async function insertLine(part: "experience" | "competency") {
  const now = new Date();
  const opens = new Date(now.getTime() - 3600_000).toISOString();
  const closes = new Date(now.getTime() + 7 * 86400_000).toISOString();
  const payload: Record<string, unknown> = {
    part_type: part,
    line_code: part === "experience" ? `EX-QAOP-${tag.slice(-8)}` : `CP-QAOP-${tag.slice(-8)}`,
    main_title: `${tag} ${part === "experience" ? "Practical Experience" : "Competency"}`,
    output_link_1: "https://example.com/qa-operating-verify",
    output_links: [{ url: "https://example.com/qa-operating-verify", label: "QA operating verify" }],
    submission_opens_at: opens,
    submission_closes_at: closes,
    is_active: true,
  };
  if (part === "experience") payload.experience_line_master_id = expMasterId;
  else payload.competency_line_master_id = compMasterId;

  const { data: line, error: lineError } = await supabase
    .from("cluster4_lines")
    .insert(payload)
    .select("id,line_code,main_title,part_type")
    .single();
  if (lineError) throw lineError;

  const { data: target, error: targetError } = await supabase
    .from("cluster4_line_targets")
    .insert({
      line_id: line.id,
      week_id: weekId,
      target_mode: "user",
      target_user_id: userId,
      target_rule: {},
    })
    .select("id,target_user_id")
    .single();
  if (targetError) throw targetError;
  return { line, target };
}

async function main() {
  const beforeHttp = await httpCards();
  const beforeSnapshot = await supabase
    .from("cluster4_weekly_card_snapshots")
    .select("computed_at,is_stale")
    .eq("user_id", userId)
    .single();
  const exp = await insertLine("experience");
  const comp = await insertLine("competency");
  const ids = [exp.line.id, comp.line.id];
  const directFresh = await getCluster4WeeklyCardsForProfileUser(userId);
  const httpBeforeRecompute = await httpCards();
  const recompute = await recomputeWeeklyCardsSnapshotsForUsers([userId]);
  const afterSnapshot = await supabase
    .from("cluster4_weekly_card_snapshots")
    .select("computed_at,is_stale")
    .eq("user_id", userId)
    .single();
  const httpAfter = await httpCards();
  const directLines = findLines(directFresh, ids);
  const httpAfterLines = findLines(httpAfter, ids);
  const { data: markerRows } = await supabase
    .from("test_user_markers")
    .select("user_id")
    .eq("user_id", userId);

  console.log(JSON.stringify({
    tag,
    userId,
    weekId,
    created: { experience: exp, competency: comp },
    targetIsTestUser: (markerRows ?? []).length > 0,
    beforeSnapshot: beforeSnapshot.data,
    afterSnapshot: afterSnapshot.data,
    snapshotRecompute: recompute,
    beforeHttpHadCreatedLines: findLines(beforeHttp, ids),
    directLines,
    httpBeforeRecomputeLines: findLines(httpBeforeRecompute, ids),
    httpAfterLines,
    directEqHttp: JSON.stringify(directLines) === JSON.stringify(httpAfterLines),
  }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
