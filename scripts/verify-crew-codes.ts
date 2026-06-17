// ===================================================================
// 크루 코드 검증(DB). generate-crew-codes --apply --force 이후 실행.
//   1) 재파생 == 저장값 (deterministic)
//   2) 중복 코드 0
//   3) 파티션(org+시작주차) 이름순 gapless 001..N
//   4) 2026 여름 이전 시작자 지원성적 = 3
//   5) crew_code_log 적재 확인
//
// 실행: npx tsx --env-file=.env.local scripts/verify-crew-codes.ts [--org=encre] [--mode=test]
// ===================================================================
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { generateCrewCodes, type CrewCodePlan } from "@/lib/adminCrewCodeData";
import { isOrganizationSlug, type OrganizationSlug } from "@/lib/organizations";
import { parseScopeMode } from "@/lib/userScopeShared";
import { isSeasonType, seasonOrdinal, SUMMER_2026_ORDINAL } from "@/lib/crewCode";

function argValue(flag: string): string | null {
  const hit = process.argv.find((a) => a.startsWith(`${flag}=`));
  return hit ? hit.slice(flag.length + 1) : null;
}

function partitionOrdinal(startWeekKey: string): number | null {
  const m = startWeekKey.match(/^(\d{4})-(winter|spring|summer|autumn)-(\d+)$/);
  if (!m) return null;
  const year = Number(m[1]);
  const season = m[2];
  if (!isSeasonType(season)) return null;
  return seasonOrdinal(year, season);
}

let failures = 0;
function check(ok: boolean, label: string, detail = "") {
  console.log(`${ok ? "✅" : "❌"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures += 1;
}

async function main() {
  const orgRaw = argValue("--org");
  const mode = parseScopeMode(argValue("--mode"));
  let organization: OrganizationSlug | null = null;
  if (orgRaw) {
    if (!isOrganizationSlug(orgRaw)) {
      console.error(`Unknown --org: ${orgRaw}`);
      process.exit(1);
    }
    organization = orgRaw;
  }

  // 1) 재파생(force dry-run) 계획.
  const plan = (
    await generateCrewCodes({ organization, mode, force: true, dryRun: true })
  ).planned;

  // 저장값 로드.
  const storedById = new Map<string, string | null>();
  for (let from = 0; ; from += 1000) {
    let q = supabaseAdmin
      .from("user_profiles")
      .select("user_id,crew_code")
      .order("user_id", { ascending: true })
      .range(from, from + 999);
    if (organization) q = q.eq("organization_slug", organization);
    const { data, error } = await q;
    if (error) throw new Error(error.message);
    const rows = (data ?? []) as Array<{ user_id: string; crew_code: string | null }>;
    for (const r of rows) storedById.set(r.user_id, r.crew_code);
    if (rows.length < 1000) break;
  }

  // (1) 재파생 == 저장값 (계획에 있는 사용자 한정).
  let mismatch = 0;
  const mismatchSamples: string[] = [];
  for (const p of plan) {
    if (p.newCode == null) continue; // 미생성은 비교 제외
    const stored = storedById.get(p.userId);
    if (stored !== p.newCode) {
      mismatch += 1;
      if (mismatchSamples.length < 10) {
        mismatchSamples.push(`${p.displayName}: stored=${stored ?? "∅"} expected=${p.newCode}`);
      }
    }
  }
  check(mismatch === 0, "재파생 == 저장값", mismatch ? `${mismatch}건 불일치: ${mismatchSamples.join(" | ")}` : "");

  // (2) 중복 코드 0 (저장값 기준).
  const seen = new Map<string, number>();
  for (const code of storedById.values()) {
    if (!code) continue;
    seen.set(code, (seen.get(code) ?? 0) + 1);
  }
  const dups = [...seen.entries()].filter(([, n]) => n > 1);
  check(dups.length === 0, "중복 코드 0", dups.length ? dups.slice(0, 5).map(([c, n]) => `${c}×${n}`).join(", ") : "");

  // (3) 파티션(org+시작주차) 이름순 gapless 001..N (생성된 코드 한정).
  const byPartition = new Map<string, CrewCodePlan[]>();
  for (const p of plan) {
    if (!p.startWeekKey || p.newCode == null) continue;
    const pkey = `${p.orgSlug ?? "_"}|${p.startWeekKey}`;
    const list = byPartition.get(pkey) ?? [];
    list.push(p);
    byPartition.set(pkey, list);
  }
  let gapBad = 0;
  const gapSamples: string[] = [];
  for (const [pkey, list] of byPartition) {
    const orders = list.map((p) => p.nameOrder!).sort((a, b) => a - b);
    for (let i = 0; i < orders.length; i += 1) {
      if (orders[i] !== i + 1) {
        gapBad += 1;
        if (gapSamples.length < 8) gapSamples.push(`${pkey}: ${orders.join(",")}`);
        break;
      }
    }
  }
  check(gapBad === 0, "이름순 gapless 001..N (시작주차 파티션)", gapBad ? gapSamples.join(" | ") : `${byPartition.size} 파티션`);

  // (4) 2026 여름 이전 시작자 grade = 3.
  let gradeBad = 0;
  const gradeSamples: string[] = [];
  for (const p of plan) {
    if (p.newCode == null || !p.startWeekKey || p.grade == null) continue;
    const ord = partitionOrdinal(p.startWeekKey);
    if (ord != null && ord < SUMMER_2026_ORDINAL && p.grade !== 3) {
      gradeBad += 1;
      if (gradeSamples.length < 8) gradeSamples.push(`${p.displayName}(${p.startWeekKey})=g${p.grade}`);
    }
  }
  check(gradeBad === 0, "2026 여름 이전 시작자 지원성적=3", gradeBad ? gradeSamples.join(", ") : "");

  // (5) crew_code_log 적재 확인.
  const { count, error: logErr } = await supabaseAdmin
    .from("crew_code_log")
    .select("id", { count: "exact", head: true });
  if (logErr) throw new Error(logErr.message);
  check((count ?? 0) > 0, "crew_code_log 적재", `${count ?? 0} rows`);

  console.log("─".repeat(50));
  console.log(failures === 0 ? "✅ ALL PASS" : `❌ ${failures} CHECK(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
