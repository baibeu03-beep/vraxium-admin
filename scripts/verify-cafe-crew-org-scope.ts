/**
 * READ-ONLY 검증: 라인 개설 크루 매칭의 org 격리 (#6).
 *   npx tsx --env-file=.env.local scripts/verify-cafe-crew-org-scope.ts
 *
 * loadCrewRecords(org) 가 해당 org 소속만 반환하는지 + 동명이인이 org 경계로 분리되는지 확인.
 */
import { createClient } from "@supabase/supabase-js";
import { loadCrewRecords } from "@/lib/cluster4CafeLineMatch";

const sb = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

async function main() {
  const orgs = ["oranke", "encre", "phalanx"] as const;

  // 전체(통합) 대비 org별 카운트.
  const all = await loadCrewRecords();
  console.log("loadCrewRecords() 통합 전체:", all.length);

  for (const org of orgs) {
    const crews = await loadCrewRecords(org);
    const leaked = crews.filter((c) => c.organization !== org);
    console.log(
      `\norg='${org}' → ${crews.length}명 | org 외 누수:`,
      leaked.length,
      leaked.length === 0 ? "✅" : "❌ " + leaked.map((c) => `${c.name}(${c.organization})`).slice(0, 5).join(", "),
    );
  }

  // 동명이인(여러 org에 같은 이름) 탐지 → org 분리 검증.
  const byName = new Map<string, Set<string>>();
  for (const c of all) {
    if (!c.name) continue;
    const set = byName.get(c.name) ?? new Set<string>();
    if (c.organization) set.add(c.organization);
    byName.set(c.name, set);
  }
  const crossOrgNames = [...byName.entries()].filter(([, orgsSet]) => orgsSet.size >= 2);
  console.log("\n동명이인(2개 이상 org에 동일 이름):", crossOrgNames.length, "건");
  for (const [name, orgsSet] of crossOrgNames.slice(0, 3)) {
    const list = [...orgsSet];
    console.log(`  · "${name}" → orgs: ${list.join(", ")}`);
    // 각 org 조회 결과에 이 이름이 그 org에만 나타나는지 확인.
    for (const org of list) {
      const inOrg = (await loadCrewRecords(org)).filter((c) => c.name === name);
      const wrong = inOrg.filter((c) => c.organization !== org);
      console.log(
        `      org='${org}': ${inOrg.length}명, 잘못 섞임 ${wrong.length} ${wrong.length === 0 ? "✅" : "❌"}`,
      );
    }
  }

  console.log("\n완료 (read-only)");
}
main().catch((e) => { console.error("ERR", e); process.exit(1); });
