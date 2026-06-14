// 실무경험 견문/관리 라인 후보 진단 (read-only).
// 실행: npx tsx --env-file=.env.local scripts/diag-experience-line-candidates.ts
//
// 목적: 조건부 라우팅 매칭 키 확정을 위해 line_registrations 의 experience 라인
//       후보(line_name/line_type/line_code/org/is_active/bridged_master_id)를 덤프한다.
//       loadRegLinesByCategory 와 동일 필터(hub=experience, is_active, bridged_master_id not null).
import { createClient } from "@supabase/supabase-js";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;

async function main() {
  const sb = createClient(url, serviceKey, { auth: { persistSession: false } });
  console.log("DB:", url);

  // 1) loadRegLinesByCategory 와 동일 필터 — 개설에 실제 사용되는 후보만.
  const { data: active, error: e1 } = await sb
    .from("line_registrations")
    .select(
      "line_code,line_name,line_type,organization_slug,is_active,bridged_master_id,main_title,main_title_mode",
    )
    .eq("hub", "experience")
    .eq("is_active", true)
    .not("bridged_master_id", "is", null)
    .order("line_type", { ascending: true })
    .order("organization_slug", { ascending: true })
    .order("line_code", { ascending: true });
  if (e1) {
    console.log("ERROR(active):", e1.message);
    return;
  }
  const rows = active ?? [];
  console.log(`\n== experience active+bridged 후보: ${rows.length}건 ==`);
  for (const r of rows as Array<Record<string, unknown>>) {
    console.log(
      `[${r.line_type}] org=${r.organization_slug ?? "(null=공통)"} | ${r.line_code} | ${r.line_name}`,
    );
  }

  // 2) line_type='평가'(견문) / '관리' 만 org별 개수 집계.
  for (const lt of ["평가", "관리"]) {
    const subset = (rows as Array<Record<string, unknown>>).filter(
      (r) => r.line_type === lt,
    );
    const byOrg = new Map<string, string[]>();
    for (const r of subset) {
      const org = (r.organization_slug as string | null) ?? "(공통)";
      const list = byOrg.get(org) ?? [];
      list.push(`${r.line_code}:${r.line_name}`);
      byOrg.set(org, list);
    }
    console.log(`\n== line_type='${lt}' org별 후보 개수 ==`);
    for (const [org, list] of byOrg) {
      console.log(`  ${org} (${list.length}):`);
      for (const x of list) console.log(`     - ${x}`);
    }
  }

  // 3) 매칭 키 후보 — 정확한 line_name 으로 4개 라인 식별 가능한지 확인.
  console.log("\n== 4개 정책 라인 식별 점검 ==");
  const all = rows as Array<Record<string, unknown>>;
  const probes: Array<{ label: string; test: (n: string) => boolean }> = [
    { label: "마케터 Launch", test: (n) => n.includes("마케터") && /launch/i.test(n) },
    { label: "상호(다면) 피드백", test: (n) => n.includes("상호") && n.includes("피드백") },
    { label: "_파트장", test: (n) => n.includes("세부 팀/조직 관리") && n.includes("파트장") },
    { label: "_에이전트", test: (n) => n.includes("세부 팀/조직 관리") && n.includes("에이전트") },
  ];
  for (const p of probes) {
    const hits = all.filter((r) => p.test(String(r.line_name)));
    console.log(
      `  "${p.label}" → ${hits.length}건: ` +
        hits.map((h) => `${h.organization_slug ?? "(공통)"}/${h.line_code}/${h.line_name}`).join(" | "),
    );
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
