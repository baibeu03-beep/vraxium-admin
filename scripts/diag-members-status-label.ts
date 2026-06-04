/**
 * READ-ONLY 진단: /admin/members 상태(role 칩) 표기 점검.
 * 대상 멤버(기본 T최수빈)의 user_profiles 원본 + user_memberships(level/state) 비교,
 * 그리고 role='part_leader' 인데 membership_level 이 심화가 아닌 멤버 전수 스캔.
 *   npx tsx --env-file=.env.local scripts/diag-members-status-label.ts [이름검색어]
 */
import { config } from "dotenv";
config({ path: ".env.local" });
import { supabaseAdmin } from "@/lib/supabaseAdmin";

const NAME = process.argv[2] ?? "최수빈";

async function main() {
  // 1) 대상 멤버 user_profiles 원본
  const { data: profs, error: profErr } = await supabaseAdmin
    .from("user_profiles")
    .select(
      "user_id,display_name,organization_slug,status,growth_status,role,current_team_name,current_part_name",
    )
    .ilike("display_name", `%${NAME}%`);
  if (profErr) throw profErr;
  console.log(`\n=== user_profiles: display_name ilike %${NAME}% → ${profs?.length ?? 0}건 ===`);
  for (const p of profs ?? []) {
    console.log(JSON.stringify(p, null, 2));
  }

  const ids = (profs ?? []).map((p: any) => p.user_id);
  if (ids.length > 0) {
    const { data: mems, error: memErr } = await supabaseAdmin
      .from("user_memberships")
      .select("user_id,membership_level,membership_state,is_current,role")
      .in("user_id", ids);
    if (memErr) {
      console.log("user_memberships 조회 실패:", memErr.message);
    } else {
      console.log(`\n=== user_memberships (대상 ${ids.length}명) → ${mems?.length ?? 0}건 ===`);
      for (const m of mems ?? []) console.log(JSON.stringify(m));
    }
  }

  // 2) 전수 스캔: user_profiles.role=part_leader 인데 membership_level 이 심화 계열이 아닌 멤버
  const { data: pls, error: plErr } = await supabaseAdmin
    .from("user_profiles")
    .select("user_id,display_name,role")
    .eq("role", "part_leader");
  if (plErr) throw plErr;
  const plIds = (pls ?? []).map((p: any) => p.user_id);
  console.log(`\n=== role='part_leader' 멤버: ${plIds.length}명 ===`);
  if (plIds.length > 0) {
    const { data: plMems, error: plMemErr } = await supabaseAdmin
      .from("user_memberships")
      .select("user_id,membership_level,membership_state,is_current")
      .in("user_id", plIds);
    if (plMemErr) {
      console.log("user_memberships 조회 실패:", plMemErr.message);
    } else {
      const byUser = new Map<string, any>();
      for (const m of plMems ?? []) {
        if (!byUser.has(m.user_id) || m.is_current) byUser.set(m.user_id, m);
      }
      for (const p of pls ?? []) {
        const m = byUser.get(p.user_id);
        const level = m?.membership_level ?? "<membership 없음>";
        const flag = String(level).includes("심화") ? "OK " : "★불일치";
        console.log(
          `  ${flag} ${p.display_name} (${p.user_id.slice(0, 8)}) role=part_leader level=${JSON.stringify(level)} state=${JSON.stringify(m?.membership_state)}`,
        );
      }
    }
  }
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error(e);
    process.exit(1);
  },
);
