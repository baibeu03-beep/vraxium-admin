// 기존 common(line_code=null) info 라인 7건의 타깃 org 분포 분석 → 백필 가능성 판단.
import { createClient } from "@supabase/supabase-js";
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

async function main() {
  const { data: lines } = await sb
    .from("cluster4_lines")
    .select("id,main_title,week_id,created_at")
    .eq("part_type", "info").eq("is_active", true).is("line_code", null)
    .order("created_at", { ascending: false });

  for (const l of (lines ?? []) as Array<{ id: string; main_title: string; week_id: string | null; created_at: string }>) {
    const { data: targets } = await sb
      .from("cluster4_line_targets")
      .select("target_user_id,target_mode,target_rule")
      .eq("line_id", l.id);
    const userIds = (targets ?? []).filter((t: any) => t.target_mode === "user" && t.target_user_id).map((t: any) => t.target_user_id);
    const ruleRows = (targets ?? []).filter((t: any) => t.target_mode === "rule");
    let orgDist: Record<string, number> = {};
    if (userIds.length) {
      const { data: profs } = await sb.from("user_profiles").select("user_id,organization_slug").in("user_id", userIds);
      for (const p of (profs ?? []) as any[]) {
        const o = p.organization_slug ?? "(null)";
        orgDist[o] = (orgDist[o] ?? 0) + 1;
      }
    }
    const orgs = Object.keys(orgDist);
    const inferable = orgs.length === 1 && orgs[0] !== "(null)" ? orgs[0] : userIds.length === 0 ? "(zero-target)" : "(mixed/unknown)";
    console.log(JSON.stringify({
      id: l.id, created: l.created_at.slice(0, 10), title: l.main_title.slice(0, 30),
      userTargets: userIds.length, ruleRows: ruleRows.length, orgDist, 추론org: inferable,
    }));
  }
}
main().then(() => process.exit(0), (e) => { console.error(e); process.exit(1); });
