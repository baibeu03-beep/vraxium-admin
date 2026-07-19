// 기존 (week_id, org) 검수 상태를 (week_id, org, scope) 로 이관한다.
//   판정 규칙(정상 finalize run 근거 우선):
//     · 그 주차에 non-reverted finalize run 이 있고 provenance(run 이 만든 uws)가 특정 (org,scope) 를
//       덮으면 → 그 (org,scope) 만 published. (다른 org/scope 의 stray uws 는 인정하지 않음.)
//     · run provenance 가 비었으면(run 없음 또는 run uws 가 삭제돼 해석 불가 = 레거시 검수) →
//       그 (org,scope) 코호트에 결과 uws(success/fail/personal_rest)가 있으면 published.
//     · operating 코호트는 여름 내내 결과 uws 0 → 항상 aggregating.
//   運營/test 는 독립 행. 카드 표시는 대상 사용자 scope 로 읽는다.
//
//   Usage: tsx --env-file=.env.local scripts/migrate-week-org-result-states-scope.ts [--apply]
//     기본 = dry-run(계산만 출력, 무변경). --apply 시 upsert. (--apply 는 scope 컬럼 마이그레이션 선행 필요.)
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { fetchTestUserMarkerIds } from "@/lib/testUsers";

const APPLY = process.argv.includes("--apply");
const ORGS = ["phalanx", "oranke", "encre"] as const;
const SCOPES = ["operating", "test"] as const;
const SEASON = "2026-summer";
const EFFECTIVE_FROM = "2026-06-29";
const RESULT_STATUSES = new Set(["success", "fail", "personal_rest"]);

type Row = { week_id: string; organization_slug: string; scope: string; status: "aggregating" | "published"; publishedAt: string | null };

async function main() {
  const testIds = await fetchTestUserMarkerIds();
  const { data: weeksRaw } = await supabaseAdmin
    .from("weeks").select("id,week_number,start_date,result_published_at")
    .eq("season_key", SEASON).gte("start_date", EFFECTIVE_FROM).order("week_number", { ascending: true });
  const weeks = (weeksRaw ?? []) as Array<{ id: string; week_number: number | null; start_date: string; result_published_at: string | null }>;

  const targets: Row[] = [];
  for (const w of weeks) {
    // 1) run provenance
    const { data: runs } = await supabaseAdmin
      .from("cluster4_week_finalize_runs")
      .select("created_uws_ids,updated_uws")
      .eq("week_id", w.id).is("reverted_at", null);
    const runUwsIds = new Set<string>();
    for (const r of (runs ?? []) as Array<{ created_uws_ids: string[] | null; updated_uws: Array<{ id: string }> | null }>) {
      for (const id of r.created_uws_ids ?? []) runUwsIds.add(id);
      for (const u of r.updated_uws ?? []) if (u?.id) runUwsIds.add(u.id);
    }
    const runProv = new Set<string>(); // `${org}:${scope}`
    if (runUwsIds.size) {
      const ids = [...runUwsIds];
      for (let i = 0; i < ids.length; i += 300) {
        const { data } = await supabaseAdmin
          .from("user_week_statuses")
          .select("id,user_id,status,user_profiles!inner(organization_slug)")
          .in("id", ids.slice(i, i + 300));
        for (const r of (data ?? []) as Array<{ user_id: string; status: string; user_profiles: { organization_slug: string } }>) {
          const org = r.user_profiles?.organization_slug;
          if (!org || !RESULT_STATUSES.has(r.status)) continue;
          runProv.add(`${org}:${testIds.has(r.user_id) ? "test" : "operating"}`);
        }
      }
    }
    const hasRun = runProv.size > 0;

    // 2) 폴백용: org+scope 결과 uws 존재
    const uwsByOrgScope = new Set<string>();
    for (const org of ORGS) {
      const { data: uws } = await supabaseAdmin
        .from("user_week_statuses")
        .select("user_id,status,user_profiles!inner(organization_slug)")
        .eq("week_start_date", w.start_date).eq("user_profiles.organization_slug", org);
      for (const r of (uws ?? []) as Array<{ user_id: string; status: string }>) {
        if (!RESULT_STATUSES.has(r.status)) continue;
        uwsByOrgScope.add(`${org}:${testIds.has(r.user_id) ? "test" : "operating"}`);
      }
    }

    for (const org of ORGS) {
      for (const scope of SCOPES) {
        const key = `${org}:${scope}`;
        const published = hasRun ? runProv.has(key) : uwsByOrgScope.has(key);
        targets.push({
          week_id: w.id, organization_slug: org, scope,
          status: published ? "published" : "aggregating",
          publishedAt: published ? (w.result_published_at ?? null) : null,
        });
      }
    }
    const line = (org: string) => SCOPES.map((s) => `${s}=${targets.find((t) => t.week_id === w.id && t.organization_slug === org && t.scope === s)!.status}`).join(" ");
    console.log(`W${w.week_number} (${w.start_date}) hasRun=${hasRun} runProv={${[...runProv].join(",")}}`);
    for (const org of ORGS) console.log(`   ${org.padEnd(8)} ${line(org)}`);
  }

  const publishedRows = targets.filter((t) => t.status === "published");
  console.log(`\n대상 ${targets.length}행 (published ${publishedRows.length}, aggregating ${targets.length - publishedRows.length})`);
  console.log("published 행:", publishedRows.map((t) => `W?/${t.organization_slug}/${t.scope}`).join(", ") || "(none)");

  if (!APPLY) {
    console.log("\n[DRY-RUN] --apply 없이 실행 — 아무것도 쓰지 않았습니다. (scope 컬럼 마이그레이션 후 --apply)");
    return;
  }

  const now = new Date().toISOString();
  let ok = 0;
  for (const t of targets) {
    const { error } = await supabaseAdmin.from("cluster4_week_org_result_states").upsert({
      week_id: t.week_id, organization_slug: t.organization_slug, scope: t.scope, status: t.status,
      review_started_at: t.status === "published" ? (t.publishedAt ?? now) : null,
      published_at: t.status === "published" ? (t.publishedAt ?? now) : null,
      reviewed_by: null, updated_at: now,
    }, { onConflict: "week_id,organization_slug,scope" });
    if (error) { console.error(`✗ upsert 실패 ${t.organization_slug}/${t.scope}:`, error.message); process.exit(1); }
    ok++;
  }
  console.log(`\n✓ APPLIED — ${ok}행 upsert 완료.`);
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
