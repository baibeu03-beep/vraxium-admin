// Point C 비대상자 지급 — dry-run(원장 쓰기 없음). 체크별 로스터/이행자/비대상자(C) 규모 출력.
//   run: npx tsx --env-file=.env.local scripts/dry-run-point-c-unselected.ts [--org=oranke] [--mode=operating|test] [--ids=uuid,uuid] [--limit=200] [--only-c]
//
//   실제 적립과 동일한 previewRegularAccrual(=computeDesiredAwards) 을 쓰므로 "미리보기 == 실제 결과" 다.
//   운영 원장 반영 전 검증용. 어떤 원장/포인트도 쓰지 않는다(순수 조회).
import { createClient } from "@supabase/supabase-js";
import { previewRegularAccrual, type RegularAccrualPreview } from "@/lib/processPointAccrual";

const URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const sb = createClient(URL, SERVICE, { auth: { persistSession: false } });

function arg(name: string): string | null {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : null;
}
const hasFlag = (name: string) => process.argv.includes(`--${name}`);

async function main() {
  const org = arg("org");
  const mode = arg("mode"); // operating | test
  const idsArg = arg("ids");
  const limit = Number(arg("limit") ?? "200");
  const onlyC = hasFlag("only-c");

  let statusIds: string[];
  if (idsArg) {
    statusIds = idsArg.split(",").map((s) => s.trim()).filter(Boolean);
  } else {
    let q = sb
      .from("process_check_statuses")
      .select("id,organization_slug,scope_mode,hub,status")
      .in("status", ["pending", "completed"])
      .order("id", { ascending: true })
      .limit(Math.min(Math.max(limit, 1), 2000));
    if (org) q = q.eq("organization_slug", org);
    if (mode) q = q.eq("scope_mode", mode);
    const { data, error } = await q;
    if (error) {
      console.error("status 조회 실패:", error.message);
      process.exit(1);
    }
    statusIds = ((data ?? []) as { id: string }[]).map((r) => r.id);
  }

  console.log(`\nPoint C dry-run — ${statusIds.length} regular check(s)${org ? ` · org=${org}` : ""}${mode ? ` · mode=${mode}` : ""}${onlyC ? " · (C>0만)" : ""}\n`);
  console.log(
    ["statusId".padEnd(38), "org".padEnd(10), "mode".padEnd(10), "hub".padEnd(11), "part".padEnd(12), "A/B/C".padEnd(10), "roster", "perf", "Ctgt", "era"].join(" | "),
  );
  console.log("-".repeat(140));

  let totalC = 0;
  let printed = 0;
  let eraBlocked = 0;
  for (const id of statusIds) {
    let p: RegularAccrualPreview;
    try {
      p = await previewRegularAccrual(id);
    } catch (e) {
      console.log(`${id}  ✗ error: ${(e as Error).message}`);
      continue;
    }
    if ("skipped" in p && p.skipped) {
      if (!onlyC) console.log(`${id}  · skip(${p.reason})`);
      continue;
    }
    const pv = p as Extract<RegularAccrualPreview, { skipped?: false }>;
    if (onlyC && pv.unselectedCount === 0) continue;
    totalC += pv.unselectedCount;
    if (!pv.eraAllowed) eraBlocked++;
    printed++;
    console.log(
      [
        pv.statusId.padEnd(38),
        String(pv.org ?? "-").padEnd(10),
        pv.mode.padEnd(10),
        String(pv.hub ?? "-").padEnd(11),
        String(pv.partName ?? "-").slice(0, 12).padEnd(12),
        `${pv.pointCheck}/${pv.pointAdvantage}/${pv.pointPenalty}`.padEnd(10),
        String(pv.rosterCount).padStart(6),
        String(pv.performerCount).padStart(4),
        String(pv.unselectedCount).padStart(4),
        pv.eraAllowed ? "OK" : "BLK",
      ].join(" | "),
    );
  }

  console.log("-".repeat(140));
  console.log(
    `요약: 출력 ${printed}건 · Point C 지급 예정 대상(비대상자) 합계 ${totalC}명 · era 차단(적립 스킵) ${eraBlocked}건`,
  );
  console.log("(dry-run — 원장/포인트 무변경)\n");
  process.exit(0);
}

main().catch((e) => {
  console.error("ERROR:", e?.stack ?? e?.message ?? e);
  process.exit(1);
});
