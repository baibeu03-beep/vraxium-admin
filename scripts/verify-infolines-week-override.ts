/**
 * admin info-lines 화면(listCluster4LinesDetailed)의 주차별 override 인식 검증.
 *   - weekW 에 work_exp override 삽입 → weekW 라인의 해당 유저 target canEdit=true,
 *     다른 주차(isoWeek) 라인의 같은 유저 target canEdit=false (격리).
 */
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { listCluster4LinesDetailed } from "@/lib/adminCluster4LinesData";

const USER = "247021bc-374b-48f4-8d49-b181d149ee33";
const WEEK_W = "a2112b50-64d2-42d6-a243-faf9fcdc6ffc";
const WORK_EXP = "cluster4.work_exp";
const NOTE = "verify-infolines";

async function userTargetCanEdit(weekId: string): Promise<boolean | null> {
  const res = await listCluster4LinesDetailed({ partType: "experience", weekId, limit: 500 });
  for (const line of res.rows) {
    const t = line.targets.find(
      (x) => x.targetUserId === USER && x.weekId === weekId,
    );
    if (t) return t.canEdit;
  }
  return null;
}

async function main() {
  const out: string[] = [];
  // cleanup any leftover
  await supabaseAdmin.from("user_edit_windows").delete()
    .eq("user_id", USER).eq("resource_key", WORK_EXP).eq("note", NOTE);

  const beforeW = await userTargetCanEdit(WEEK_W);

  const { data: wk } = await supabaseAdmin.from("weeks").select("season_key").eq("id", WEEK_W).maybeSingle();
  await supabaseAdmin.from("user_edit_windows").insert({
    user_id: USER, resource_key: WORK_EXP, week_id: WEEK_W,
    season_key: (wk as { season_key: string | null } | null)?.season_key ?? null,
    opened_at: new Date(Date.now() - 60_000).toISOString(),
    expires_at: new Date(Date.now() + 24 * 3600_000).toISOString(),
    note: NOTE,
  });

  const afterW = await userTargetCanEdit(WEEK_W);

  // isoWeek: 같은 유저의 다른 experience 주차 1건 (작은 쿼리로 직접 추출)
  const { data: isoRows } = await supabaseAdmin
    .from("cluster4_line_targets")
    .select("week_id, cluster4_lines!inner(part_type)")
    .eq("target_mode", "user")
    .eq("target_user_id", USER)
    .eq("cluster4_lines.part_type", "experience")
    .neq("week_id", WEEK_W)
    .limit(1);
  const isoWeek =
    (isoRows as Array<{ week_id: string | null }> | null)?.[0]?.week_id ?? null;
  const isoCanEdit = isoWeek ? await userTargetCanEdit(isoWeek) : null;

  await supabaseAdmin.from("user_edit_windows").delete()
    .eq("user_id", USER).eq("resource_key", WORK_EXP).eq("note", NOTE);

  const pA = beforeW === false;
  const pB = afterW === true;
  const pC = isoWeek == null || isoCanEdit === false;
  out.push(`${pA ? "PASS" : "FAIL"}  IL-A. BEFORE weekW canEdit=false  | ${beforeW}`);
  out.push(`${pB ? "PASS" : "FAIL"}  IL-B. AFTER weekW canEdit=true     | ${afterW}`);
  out.push(`${pC ? "PASS" : "FAIL"}  IL-C. 다른 주차 canEdit=false(격리) | isoWeek=${isoWeek} canEdit=${isoCanEdit}`);
  console.log("\n==== INFO-LINES RESULT ====");
  out.forEach((l) => console.log(l));
  const all3 = pA && pB && pC;
  console.log("\nALL:", all3 ? "PASS ✅" : "FAIL ❌");
  process.exit(all3 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
