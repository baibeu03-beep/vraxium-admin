/**
 * 진단 전용(read-only): 동명이인/누락 식별 보조 정보.
 *   npx tsx --env-file=.env.local scripts/diag-summer-rest-dupes.ts
 */
import { supabaseAdmin } from "@/lib/supabaseAdmin";

const DUPES: { org: string; name: string }[] = [
  { org: "encre", name: "이혜인" },
  { org: "encre", name: "김도연" },
  { org: "encre", name: "김민아" },
  { org: "encre", name: "박가은" },
  { org: "oranke", name: "정은지" },
];
const MISSING = [{ org: "oranke", name: "전현성" }];

const line = (s = "") => console.log(s);
const hr = () => line("─".repeat(78));

async function enrich(user_id: string) {
  const { data: edu } = await supabaseAdmin.from("user_educations")
    .select("school_name,major_name_1").eq("user_id", user_id).limit(1).maybeSingle();
  const { data: mem } = await supabaseAdmin.from("user_memberships")
    .select("team_name,part_name,membership_level,is_current").eq("user_id", user_id).eq("is_current", true).limit(1).maybeSingle();
  const { data: prof } = await supabaseAdmin.from("user_profiles")
    .select("contact_phone,contact_email,current_team_name,current_part_name,activity_started_at,growth_status").eq("user_id", user_id).maybeSingle();
  const { count: summerWeeks } = await supabaseAdmin.from("user_week_statuses")
    .select("user_id", { count: "exact", head: true }).eq("user_id", user_id).eq("season_key", "2026-summer");
  const phone = (prof as any)?.contact_phone ? String((prof as any).contact_phone).replace(/\D/g, "").slice(-4) : "----";
  return { edu, mem, prof, phone, summerWeeks: summerWeeks ?? 0 };
}

async function main() {
  hr(); line("동명이인 후보 식별 정보"); hr();
  for (const { org, name } of DUPES) {
    const { data } = await supabaseAdmin.from("user_profiles")
      .select("user_id,growth_status,status").eq("organization_slug", org).eq("display_name", name);
    line(`\n[${org}] ${name} — 후보 ${(data ?? []).length}`);
    for (const p of (data ?? []) as any[]) {
      const e = await enrich(p.user_id);
      line(`  user_id=${p.user_id}`);
      line(`    growth=${p.growth_status} status=${p.status} 폰끝4=${e.phone} 활동시작=${(e.prof as any)?.activity_started_at ?? "-"}`);
      line(`    소속=${(e.mem as any)?.team_name ?? (e.prof as any)?.current_team_name ?? "-"} / ${(e.mem as any)?.part_name ?? (e.prof as any)?.current_part_name ?? "-"} level=${(e.mem as any)?.membership_level ?? "-"}`);
      line(`    학교=${(e.edu as any)?.school_name ?? "-"} 전공=${(e.edu as any)?.major_name_1 ?? "-"} 여름주차수=${e.summerWeeks}`);
    }
  }

  hr(); line("누락 이름 — 전 org / 유사 탐색"); hr();
  for (const { org, name } of MISSING) {
    line(`\n[기대 org=${org}] ${name}`);
    // 전 org 동명
    const { data: anyOrg } = await supabaseAdmin.from("user_profiles")
      .select("user_id,organization_slug,growth_status,status").eq("display_name", name);
    line(`  display_name='${name}' 전체 org: ${(anyOrg ?? []).length}건`);
    for (const p of (anyOrg ?? []) as any[]) line(`    - ${p.organization_slug} ${p.user_id.slice(0,8)} growth=${p.growth_status} status=${p.status}`);
    // 부분 일치(성+이름 유사)
    const { data: like } = await supabaseAdmin.from("user_profiles")
      .select("user_id,display_name,organization_slug,status").eq("organization_slug", org).ilike("display_name", `%${name.slice(1)}%`).limit(15);
    line(`  org=${org} 이름에 '${name.slice(1)}' 포함: ${(like ?? []).length}건`);
    for (const p of (like ?? []) as any[]) line(`    - ${p.display_name} ${p.user_id.slice(0,8)} status=${p.status}`);
  }
  hr(); line("DONE");
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
