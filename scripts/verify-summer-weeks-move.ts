/**
 * 2025-summer W1~4 → W5~8 이동 검증 (2026-06-07, read-only).
 *
 *   npx tsx --env-file=.env.local scripts/verify-summer-weeks-move.ts
 *
 * 이동 특화 항목 (공통 항목은 verify-tester-summer-weeks-all.ts 와 병행 실행):
 *   1) weeks: 2025-summer = 정확히 4행, week_number {5,6,7,8}, start_date 07-28~08-18
 *   2) uws: 6명 각자 2025-summer 4행 전부 W5~8 시작일 — W1~4 시작일 행 0
 *   3) 프로필: activity_started_at=2025-07-28 · graduated · ended 원값 유지
 *   4) snapshot: stale=false · 여름 카드 4장 = weekNumber 5~8 · weekNumber 1~4 카드 0 ·
 *      4장 전부 success · weekId 가 신규 W5~8 weeks 행과 일치
 *   5) 실사용자 지문 == MOVE run fpBefore (diff=0 재확인)
 */
import { config } from "dotenv";
config({ path: ".env.local" });

import { createClient } from "@supabase/supabase-js";
import { createHash } from "crypto";
import { readFileSync } from "fs";

const sb = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);
const LOG_PATH = "claudedocs/tester-summer-weeks-20260606.json";

const OLD_STARTS = ["2025-06-30", "2025-07-07", "2025-07-14", "2025-07-21"];
const NEW_STARTS = ["2025-07-28", "2025-08-04", "2025-08-11", "2025-08-18"];

const SIX = [
  ["T윤도현", "bf3b4305-751a-49e3-88ad-95a20e5c4dad", null],
  ["T임다인", "42864260-e4ea-4150-a87f-cff545b02af1", "2026-05-19"],
  ["T장유준", "4a81b6d1-e488-4f14-8530-0cad60fe4f0d", "2026-05-12"],
  ["T윤태현", "05ff6b96-b3e7-4050-97f1-080633f183d3", null],
  ["T임건우", "e4dcb97e-a515-4ec5-a91e-32ca4e629dae", "2026-05-19"],
  ["T장시현", "cc1b58e6-b14d-45a0-b389-2df3c27a0b25", "2026-05-12"],
] as const;
const SIX_IDS = new Set(SIX.map((s) => s[1]));

let pass = 0,
  fail = 0;
const check = (label: string, ok: boolean, detail?: string) => {
  console.log(`  ${ok ? "✓" : "✗"} ${label}${detail ? " — " + detail : ""}`);
  ok ? pass++ : fail++;
};

async function pageAll<T>(table: string, select: string, filter?: (q: any) => any): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += 1000) {
    let q = sb.from(table).select(select).order("user_id", { ascending: true }).range(from, from + 999);
    if (filter) q = filter(q);
    const { data, error } = await q;
    if (error) throw new Error(`${table}: ${error.message}`);
    out.push(...((data ?? []) as T[]));
    if (!data || data.length < 1000) break;
  }
  return out;
}

async function realUserFingerprint(excludeIds: Set<string>): Promise<string> {
  const [uws, profiles, points, snaps] = await Promise.all([
    pageAll<any>("user_week_statuses", "user_id,week_start_date,status"),
    pageAll<any>("user_profiles", "user_id,growth_status,activity_started_at,activity_ended_at"),
    pageAll<any>("user_weekly_points", "user_id,year,week_number,points"),
    pageAll<any>("cluster4_weekly_card_snapshots", "user_id,is_stale"),
  ]);
  const pick = (rows: any[]) => rows.filter((r) => !excludeIds.has(r.user_id));
  const u = pick(uws).map((r) => `${r.user_id}|${r.week_start_date}|${r.status}`).sort();
  const p = pick(profiles).map((r) => `${r.user_id}|${r.growth_status}|${r.activity_started_at}|${r.activity_ended_at}`).sort();
  const w = pick(points).map((r) => `${r.user_id}|${r.year}|${r.week_number}|${r.points}`).sort();
  const s = pick(snaps).map((r) => `${r.user_id}|${r.is_stale}`).sort();
  return createHash("sha256").update([u.join("\n"), p.join("\n"), w.join("\n"), s.join("\n")].join("\n#\n")).digest("hex");
}

async function main() {
  // ── 1) weeks 구조 ─────────────────────────────────────────────────────
  console.log("===== 1) weeks: 2025-summer 구조 =====");
  const { data: summerWeeks } = await sb
    .from("weeks")
    .select("id,start_date,week_number,season_key,result_published_at,check_threshold,is_official_rest")
    .eq("season_key", "2025-summer")
    .order("start_date");
  const sw = (summerWeeks ?? []) as any[];
  check(`weeks 4행`, sw.length === 4, `실제=${sw.length}`);
  check(
    `week_number = {5,6,7,8}`,
    JSON.stringify(sw.map((w) => w.week_number)) === JSON.stringify([5, 6, 7, 8]),
    sw.map((w) => `W${w.week_number}@${w.start_date}`).join(" "),
  );
  check(
    `start_date = 07-28~08-18`,
    JSON.stringify(sw.map((w) => w.start_date)) === JSON.stringify(NEW_STARTS),
    sw.map((w) => w.start_date).join(","),
  );
  check(
    `published 선세팅 + threshold=0 + 휴식 아님`,
    sw.every((w) => w.result_published_at && w.check_threshold === 0 && !w.is_official_rest),
  );
  const newWeekIds = new Set(sw.map((w) => w.id));

  // MOVE run 의 insertedWeeks 와 id 일치
  const fileLog = JSON.parse(readFileSync(LOG_PATH, "utf8"));
  const moveRun = [...fileLog.runs].reverse().find((r: any) => String(r.mode).startsWith("MOVE"));
  const insertedIds = new Set((moveRun?.insertedWeeks ?? []).map((w: any) => w.id));
  check(
    `weeks id == MOVE run insertedWeeks`,
    sw.length === insertedIds.size && sw.every((w) => insertedIds.has(w.id)),
  );

  // ── 2~4) 사용자별 ─────────────────────────────────────────────────────
  for (const [name, uid, endedExpect] of SIX) {
    console.log(`\n===== ${name} =====`);

    // 2) uws
    const { data: uwsRows } = await sb
      .from("user_week_statuses")
      .select("week_start_date,status,season_key")
      .eq("user_id", uid)
      .eq("season_key", "2025-summer")
      .order("week_start_date");
    const ur = (uwsRows ?? []) as any[];
    check(
      `uws 여름 4행 전부 W5~8·success`,
      ur.length === 4 &&
        JSON.stringify(ur.map((r) => r.week_start_date)) === JSON.stringify(NEW_STARTS) &&
        ur.every((r) => r.status === "success"),
      ur.map((r) => `${r.week_start_date}:${r.status}`).join(" "),
    );
    const { count: oldCnt } = await sb
      .from("user_week_statuses")
      .select("id", { count: "exact", head: true })
      .eq("user_id", uid)
      .in("week_start_date", OLD_STARTS);
    check(`uws W1~4 시작일 행 0`, (oldCnt ?? 0) === 0, `실제=${oldCnt}`);

    // 3) 프로필
    const { data: p } = await sb
      .from("user_profiles")
      .select("growth_status,activity_started_at,activity_ended_at")
      .eq("user_id", uid)
      .single();
    const endedOk =
      endedExpect === null ? p?.activity_ended_at === null : Boolean(p?.activity_ended_at?.startsWith(endedExpect));
    check(
      `started=2025-07-28 · graduated · ended=${endedExpect ?? "null"}`,
      Boolean(p?.activity_started_at?.startsWith("2025-07-28")) && p?.growth_status === "graduated" && endedOk,
      `started=${p?.activity_started_at} status=${p?.growth_status} ended=${p?.activity_ended_at ?? "null"}`,
    );

    // 4) snapshot
    const { data: snap } = await sb
      .from("cluster4_weekly_card_snapshots")
      .select("is_stale,computed_at,cards")
      .eq("user_id", uid)
      .single();
    const cards: any[] = Array.isArray((snap as any)?.cards) ? (snap as any).cards : [];
    const summer = cards.filter((c) => c?.seasonKey === "2025-summer");
    const nums = summer.map((c) => c?.weekNumber).sort((a, b) => a - b);
    check(
      `snapshot stale=false · 여름 4장 = W5~8 · 전부 success`,
      snap?.is_stale === false &&
        JSON.stringify(nums) === JSON.stringify([5, 6, 7, 8]) &&
        summer.every((c) => c?.userWeekStatus === "success"),
      `stale=${snap?.is_stale} weekNums=[${nums.join(",")}] status=${[...new Set(summer.map((c) => c?.userWeekStatus))].join(",")} computed=${snap?.computed_at}`,
    );
    check(
      `W1~4 카드 없음 + weekId 전부 신규 행`,
      summer.every((c) => c?.weekNumber >= 5) && summer.every((c) => newWeekIds.has(c?.weekId)),
    );
  }

  // ── 5) 실사용자 지문 ──────────────────────────────────────────────────
  console.log(`\n===== 5) 실사용자 지문 (6명 제외) =====`);
  const fp = await realUserFingerprint(SIX_IDS);
  check(`hash == MOVE run fpBefore`, fp === moveRun?.fpBefore?.hash, `now=${fp.slice(0, 16)}…`);

  console.log(`\n결과: pass=${pass} fail=${fail}`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
