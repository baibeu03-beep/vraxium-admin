// 읽기 전용 — 활성 info 라인의 line_code/org 판정 상태를 전수 진단한다.
// 목적: line_code 토큰 없는(=resolveLineOrg→'common') info 라인이 몇 건인지(=org 누수 후보) 집계.
// 사용법: npx tsx --env-file=.env.local scripts/diag-info-line-org-leak-state.ts
import { createClient } from "@supabase/supabase-js";
import { resolveCluster4LineOrgScope } from "../lib/adminCluster4LinesData";

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

async function main() {
  const { data, error } = await supabase
    .from("cluster4_lines")
    .select("id,line_code,main_title,is_active,week_id,created_at")
    .eq("part_type", "info")
    .eq("is_active", true)
    .order("created_at", { ascending: false });
  if (error) throw new Error(error.message);
  const rows = (data ?? []) as Array<{
    id: string;
    line_code: string | null;
    main_title: string | null;
    week_id: string | null;
    created_at: string | null;
  }>;

  let common = 0;
  let scoped = 0;
  const commonSamples: Array<Record<string, unknown>> = [];
  for (const r of rows) {
    const org = await resolveCluster4LineOrgScope({
      part_type: "info",
      line_code: r.line_code,
    });
    if (org === "common") {
      common++;
      if (commonSamples.length < 20)
        commonSamples.push({
          id: r.id,
          line_code: r.line_code,
          title: r.main_title,
          week_id: r.week_id,
          created_at: r.created_at,
        });
    } else {
      scoped++;
    }
  }

  console.log(`활성 info 라인 총 ${rows.length}건`);
  console.log(`  org-scoped(EC/OK/PX 토큰): ${scoped}건`);
  console.log(`  common(전체 노출=누수 후보): ${common}건`);
  console.log("\ncommon 라인 표본(최신순):");
  console.dir(commonSamples, { depth: null });
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error(e);
    process.exit(1);
  },
);
