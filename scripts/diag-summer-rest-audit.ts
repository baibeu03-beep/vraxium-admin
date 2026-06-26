/**
 * 진단 전용(read-only): 2026-summer 시즌 전체 휴식 명단 감사.
 *   npx tsx --env-file=.env.local scripts/diag-summer-rest-audit.ts
 *
 * 목적: 사용자 확정 50명(엥크레34·오랑캐8·팔랑크스8) 기준으로
 *   - user_season_statuses(season_key 별, status='rest') 분포
 *   - 2026-summer rest 실제 명단 ↔ 기대 명단 diff (누락/초과)
 *   - growth_status='seasonal_rest' (전인 플래그) 와 시즌 스코프 불일치 탐지
 */
import { supabaseAdmin } from "@/lib/supabaseAdmin";

const EXPECTED: Record<string, string[]> = {
  encre: [
    "현유빈","추가현","최인영","제서영","이혜인","이재은","송은서","손지희","손정민","류신형",
    "김혜령","강지원","김가희","김나연","김다연","김다정","김도연","김민아","황수민","박가은",
    "오재우","김성현","이예령","박기연","임지윤","윤정환","김수민","김유나","우태경","황예원",
    "김준우","김지민","김지우","김채연",
  ],
  oranke: ["이수현","박소윤","공지민","김동욱","김민결","전현성","정은지","이윤재"],
  phalanx: ["성채윤","정혜빈","김다빈","강은비","최종원","공준혁","양설아","신유이"],
};

const line = (s = "") => console.log(s);
const hr = () => line("─".repeat(72));

async function fetchAll<T>(table: string, select: string, orderCol: string, filt?: (q: any) => any): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += 1000) {
    let q: any = supabaseAdmin.from(table).select(select).order(orderCol, { ascending: true }).range(from, from + 999);
    if (filt) q = filt(q);
    const { data, error } = await q;
    if (error) throw new Error(`${table}: ${error.message}`);
    out.push(...((data ?? []) as T[]));
    if ((data ?? []).length < 1000) break;
  }
  return out;
}

async function main() {
  hr();
  line("① season_definitions / seasons (시즌키 확인)");
  hr();
  const defs = await fetchAll<{ season_key: string; season_label: string | null; season_type: string | null; start_date: string | null; end_date: string | null }>(
    "season_definitions", "season_key,season_label,season_type,start_date,end_date", "start_date");
  for (const d of defs) line(`  ${d.season_key.padEnd(16)} type=${d.season_type ?? "-"} ${d.start_date}~${d.end_date} ${d.season_label ?? ""}`);

  hr();
  line("② user_season_statuses status='rest' — season_key 별 분포");
  hr();
  const restRows = await fetchAll<{ user_id: string; season_key: string; status: string }>(
    "user_season_statuses", "user_id,season_key,status", "user_id", (q) => q.eq("status", "rest"));
  const bySeason = new Map<string, string[]>();
  for (const r of restRows) {
    const arr = bySeason.get(r.season_key) ?? [];
    arr.push(r.user_id);
    bySeason.set(r.season_key, arr);
  }
  for (const [sk, ids] of [...bySeason.entries()].sort()) line(`  ${sk.padEnd(16)} rest=${ids.length}`);

  // 모든 status 분포
  const allSeasonRows = await fetchAll<{ season_key: string; status: string }>(
    "user_season_statuses", "season_key,status", "season_key");
  const statusDist = new Map<string, Map<string, number>>();
  for (const r of allSeasonRows) {
    const m = statusDist.get(r.season_key) ?? new Map();
    m.set(r.status, (m.get(r.status) ?? 0) + 1);
    statusDist.set(r.season_key, m);
  }
  line("");
  line("  (참고) user_season_statuses 전체 status 분포:");
  for (const [sk, m] of [...statusDist.entries()].sort()) {
    line(`    ${sk.padEnd(16)} ${JSON.stringify(Object.fromEntries(m))}`);
  }

  // summer season_key 자동 탐지(2026 + type summer)
  const summerDef = defs.find((d) => d.season_type === "summer" && (d.season_key.startsWith("2026") || (d.start_date ?? "") >= "2026-01-01"));
  const SUMMER_KEY = summerDef?.season_key ?? "2026-summer";
  hr();
  line(`③ 2026-summer 명단 감사 (season_key=${SUMMER_KEY})`);
  hr();

  const summerRestIds = bySeason.get(SUMMER_KEY) ?? [];
  line(`  DB rest 인원: ${summerRestIds.length}  (기대 50 = 엥크레34·오랑캐8·팔랑크스8)`);

  // 프로필 join (이름/조직)
  const profById = new Map<string, { display_name: string | null; organization_slug: string | null; growth_status: string | null; status: string | null }>();
  for (let i = 0; i < summerRestIds.length; i += 500) {
    const chunk = summerRestIds.slice(i, i + 500);
    const { data } = await supabaseAdmin.from("user_profiles")
      .select("user_id,display_name,organization_slug,growth_status,status").in("user_id", chunk);
    for (const p of (data ?? []) as any[]) profById.set(p.user_id, p);
  }

  const dbByOrg = new Map<string, { name: string; growth: string | null; status: string | null }[]>();
  for (const id of summerRestIds) {
    const p = profById.get(id);
    const org = p?.organization_slug ?? "(null)";
    const arr = dbByOrg.get(org) ?? [];
    arr.push({ name: p?.display_name ?? `(no-profile ${id.slice(0, 8)})`, growth: p?.growth_status ?? null, status: p?.status ?? null });
    dbByOrg.set(org, arr);
  }
  line("");
  for (const [org, arr] of [...dbByOrg.entries()].sort()) {
    line(`  [${org}] DB rest ${arr.length}명`);
  }

  hr();
  line("④ 기대 명단 ↔ DB diff (org 별, 이름 기준)");
  hr();
  for (const org of ["encre", "oranke", "phalanx"]) {
    const expected = new Set(EXPECTED[org]);
    const dbArr = dbByOrg.get(org) ?? [];
    const dbNames = dbArr.map((x) => x.name);
    const dbNameSet = new Set(dbNames);
    const missing = [...expected].filter((n) => !dbNameSet.has(n)); // 기대엔 있는데 DB rest 아님
    const extra = dbNames.filter((n) => !expected.has(n));          // DB rest 인데 기대 외
    const dupes = dbNames.filter((n, i) => dbNames.indexOf(n) !== i);
    line(`  [${org}] 기대 ${expected.size} / DB ${dbArr.length}`);
    line(`     누락(기대O DB-rest X): ${missing.length ? missing.join(", ") : "없음"}`);
    line(`     초과(DB-rest O 기대X): ${extra.length ? extra.join(", ") : "없음"}`);
    if (dupes.length) line(`     ⚠ 동명 중복: ${[...new Set(dupes)].join(", ")}`);
  }

  hr();
  line("⑤ growth_status='seasonal_rest' (전인 플래그) vs 2026-summer rest 시즌 스코프 비교");
  hr();
  const seasonalRestProfiles = await fetchAll<{ user_id: string; display_name: string | null; organization_slug: string | null }>(
    "user_profiles", "user_id,display_name,organization_slug", "user_id", (q) => q.eq("growth_status", "seasonal_rest"));
  line(`  growth_status='seasonal_rest' 전체: ${seasonalRestProfiles.length}명`);
  const summerSet = new Set(summerRestIds);
  const flagButNotSummer = seasonalRestProfiles.filter((p) => !summerSet.has(p.user_id));
  const summerButNotFlag = summerRestIds.filter((id) => !seasonalRestProfiles.some((p) => p.user_id === id));
  line(`   - seasonal_rest 플래그O 이지만 2026-summer rest 아님: ${flagButNotSummer.length}명`);
  line(`     (이들이 만약 어디선가 growth_status 로 '여름 휴식'으로 표시되면 시즌 스코프 버그)`);
  line(`   - 2026-summer rest O 이지만 seasonal_rest 플래그 아님: ${summerButNotFlag.length}명`);

  hr();
  line("DONE");
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
