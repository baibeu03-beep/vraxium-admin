/**
 * 2025-summer pms 정본 복원 사후 검증 (read-only).
 *
 *   npx tsx --env-file=.env.local scripts/verify-summer-pms-restore.ts
 *
 *   1) weeks 정합: summer W1~8 pms 정본 (thr 24/24/34/34/37/37/35/37 · 전부 미공표 · rest=false)
 *      + 총계 153 · seasons 13 · winter W8 휴식 유지 · publish 38(42−4)
 *   2) 금지 항목 불변: uws 총계/summer 24행 success · uwp 총계 (수정 0 계약)
 *   3) 테스터 6명: graduated · approved=31 · cumulative=44 불변
 *   4) direct: 테스터 summer 카드 4장(W5~8) — W1~4 카드 미생성(uws 없음)
 *   5) HTTP(운영 admin internal) == direct deep equal
 *   6) snapshot: 122개 · is_stale=false · v18 · snapshot == direct
 */
import { readFileSync } from "fs";
import { createClient } from "@supabase/supabase-js";
import { getCluster4WeeklyCardsForProfileUser } from "@/lib/cluster4WeeklyCardsData";
import { WEEKLY_CARDS_DTO_VERSION } from "@/lib/cluster4WeeklyCardsSnapshot";
import type { Cluster4WeeklyCardDto } from "@/shared/cluster4.contracts";

const ADMIN = "https://vraxium-admin.vercel.app";
const RUN_LOG = "claudedocs/summer-pms-restore-2026-06-07T01-03-07.json";
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
const rawEnv = readFileSync(".env.local", "utf8");
const INTERNAL_KEY = rawEnv.match(/^INTERNAL_API_KEY=(.+)$/m)?.[1]?.trim();

const PMS = [
  { week: 1, start: "2025-06-30", thr: 24 },
  { week: 2, start: "2025-07-07", thr: 24 },
  { week: 3, start: "2025-07-14", thr: 34 },
  { week: 4, start: "2025-07-21", thr: 34 },
  { week: 5, start: "2025-07-28", thr: 37 },
  { week: 6, start: "2025-08-04", thr: 37 },
  { week: 7, start: "2025-08-11", thr: 35 },
  { week: 8, start: "2025-08-18", thr: 37 },
];
const SUMMER_STARTS = PMS.map((p) => p.start);

let pass = 0,
  fail = 0;
const check = (name: string, ok: boolean, detail?: string) => {
  console.log(`  ${ok ? "✅" : "❌"} ${name}${detail ? ` — ${detail}` : ""}`);
  ok ? pass++ : fail++;
};

// 키 재귀 정렬 정규화 — HTTP 는 snapshot jsonb 왕복이라 키 순서가 PG 정규화됨
// (diag-summer-direct-vs-http.ts 실증: 정규화 후 deep equal, 실질 diff 0)
function canon(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(canon);
  if (v && typeof v === "object") {
    const o: Record<string, unknown> = {};
    for (const k of Object.keys(v as object).sort()) o[k] = canon((v as Record<string, unknown>)[k]);
    return o;
  }
  return v;
}

async function main() {
  const runLog = JSON.parse(readFileSync(RUN_LOG, "utf8"));
  const testers: string[] = runLog.testers;

  // ── 1) weeks 정합 ──
  console.log("══ 1) weeks 정합 ══");
  const { data: summer } = await sb
    .from("weeks")
    .select("week_number,start_date,check_threshold,result_published_at,is_official_rest")
    .eq("season_key", "2025-summer")
    .order("week_number");
  const sOk =
    (summer ?? []).length === 8 &&
    PMS.every((p) => {
      const w = (summer ?? []).find((x: any) => x.week_number === p.week) as any;
      return w && w.start_date === p.start && w.check_threshold === p.thr && w.result_published_at === null && !w.is_official_rest;
    });
  check("summer W1~8 = pms 정본 (날짜·thr·미공표·비휴식)", sOk,
    JSON.stringify((summer ?? []).map((w: any) => `W${w.week_number}:${w.start_date}/thr${w.check_threshold}/${w.result_published_at ? "pub" : "unpub"}`)));
  const { count: weekTotal } = await sb.from("weeks").select("id", { count: "exact", head: true });
  check("weeks 총계 153 (149+4)", weekTotal === 153, `실제 ${weekTotal}`);
  const { count: seasonTotal } = await sb.from("seasons").select("id", { count: "exact", head: true });
  check("seasons 13 불변", seasonTotal === 13, `실제 ${seasonTotal}`);
  const { data: winterRest } = await sb
    .from("weeks").select("week_number").eq("season_key", "2026-winter").eq("is_official_rest", true);
  check("2026-winter 휴식 = W8 단 1건 유지", (winterRest ?? []).length === 1 && (winterRest ?? [])[0].week_number === 8);
  const { count: pubCount } = await sb
    .from("weeks").select("id", { count: "exact", head: true }).not("result_published_at", "is", null);
  check("publish 보유 38 (42 − summer 4)", pubCount === 38, `실제 ${pubCount}`);

  // ── 2) 금지 항목 불변 ──
  console.log("══ 2) uws/uwp 불변 (수정 금지 계약) ══");
  const { count: uwsTotal } = await sb.from("user_week_statuses").select("user_id", { count: "exact", head: true });
  check("uws 총계 1750 불변", uwsTotal === 1750, `실제 ${uwsTotal}`);
  const { count: uwpTotal } = await sb.from("user_weekly_points").select("user_id", { count: "exact", head: true });
  check("uwp 총계 1689 불변", uwpTotal === 1689, `실제 ${uwpTotal}`);
  const { data: summerUws } = await sb
    .from("user_week_statuses").select("user_id,week_start_date,status").in("week_start_date", SUMMER_STARTS).limit(1000);
  check("summer uws = 24행 전부 success (테스터 top-up 보존)",
    (summerUws ?? []).length === 24 && (summerUws ?? []).every((r: any) => r.status === "success"));

  // ── 3) 테스터 졸업/카운트 불변 ──
  console.log("══ 3) 테스터 6명 졸업 불변 ══");
  const { data: gs } = await sb
    .from("user_growth_stats").select("user_id,approved_weeks,cumulative_weeks").in("user_id", testers);
  const { data: profs } = await sb
    .from("user_profiles").select("user_id,display_name,growth_status").in("user_id", testers);
  const profBy = new Map((profs ?? []).map((p: any) => [p.user_id, p]));
  let gOk = 0;
  for (const g of gs ?? []) {
    const p = profBy.get(g.user_id) as any;
    const ok = p?.growth_status === "graduated" && g.approved_weeks === 31 && g.cumulative_weeks === 44;
    if (ok) gOk++;
    else console.log(`    ❗ ${p?.display_name}: status=${p?.growth_status} approved=${g.approved_weeks} cumulative=${g.cumulative_weeks}`);
  }
  check("6명 전원 graduated · approved=31 · cumulative=44", gOk === 6 && (gs ?? []).length === 6, `${gOk}/6`);

  // ── 4)(5)(6) direct / HTTP / snapshot — 테스터별 ──
  console.log("══ 4~6) direct / HTTP / snapshot ══");
  let summerLabelSample: unknown = null;
  for (const uid of testers) {
    const direct = (await getCluster4WeeklyCardsForProfileUser(uid)) as Cluster4WeeklyCardDto[];
    const dSummer = direct.filter((c) => SUMMER_STARTS.includes(c.startDate));
    const w14 = dSummer.filter((c) => PMS.slice(0, 4).some((p) => p.start === c.startDate));
    check(`direct ${uid.slice(0, 8)}: summer 카드 4장(W5~8)·W1~4 카드 0`, dSummer.length === 4 && w14.length === 0,
      `summer=${dSummer.length} w1~4=${w14.length}`);
    if (!summerLabelSample && dSummer[0]) {
      const c: any = dSummer[0];
      summerLabelSample = {
        startDate: c.startDate,
        userWeekStatus: c.userWeekStatus,
        checkGate: c.experienceGrowth?.checkGate ?? null,
      };
    }

    const res = await fetch(`${ADMIN}/api/cluster4/weekly-cards?userId=${uid}`, {
      headers: { "x-internal-api-key": INTERNAL_KEY! },
    });
    if (!res.ok) {
      check(`HTTP ${uid.slice(0, 8)} 200`, false, `status=${res.status}`);
      continue;
    }
    const http = ((await res.json()).data ?? []) as Cluster4WeeklyCardDto[];
    let diffs = 0;
    const len = direct.length === http.length;
    for (let i = 0; i < Math.min(direct.length, http.length); i++) {
      if (JSON.stringify(canon(direct[i])) !== JSON.stringify(canon(http[i]))) diffs++;
    }
    check(`direct == HTTP ${uid.slice(0, 8)} (카드 ${direct.length}장 정규화 deep equal)`, len && diffs === 0,
      `len ${direct.length}/${http.length} diffs=${diffs}`);
  }
  console.log("  summer 카드 상태 표본:", JSON.stringify(summerLabelSample));

  const { data: snaps } = await sb
    .from("cluster4_weekly_card_snapshots").select("user_id,dto_version,is_stale").limit(1000);
  const stale = (snaps ?? []).filter((s: any) => s.is_stale).length;
  const wrongVer = (snaps ?? []).filter((s: any) => s.dto_version !== WEEKLY_CARDS_DTO_VERSION).length;
  check(`snapshot ${(snaps ?? []).length}개 — stale 0 · 전부 v${WEEKLY_CARDS_DTO_VERSION}`,
    stale === 0 && wrongVer === 0, `stale=${stale} wrongVer=${wrongVer}`);

  console.log(`\n결과: ✅ ${pass} / ❌ ${fail}`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
