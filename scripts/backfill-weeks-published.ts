/**
 * weeks.result_published_at 과거 주차 백필.
 *   기본 = DRY RUN(읽기). 실제 적용 = APPLY=1.
 *   대상: end_date + 14일(검수창) 이 오늘(KST) 이전 + result_published_at IS NULL.
 *   값  : result_published_at = end_date + 14일 00:00:00Z (검수창 종료 시점 = 승인완료 시점).
 *   제외: 검수창 미경과(진행중/검수중) 또는 이미 공표된 행.
 *
 *   npx tsx --env-file=.env.local scripts/backfill-weeks-published.ts          # dry-run
 *   APPLY=1 npx tsx --env-file=.env.local scripts/backfill-weeks-published.ts  # 적용
 */
import { config } from "dotenv";
config({ path: ".env.local" });
import { createClient } from "@supabase/supabase-js";

const sb = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

const APPLY = process.env.APPLY === "1";

function kstToday(): string {
  return new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10);
}
function addDays(dateStr: string, days: number): string {
  const ms = Date.UTC(+dateStr.slice(0, 4), +dateStr.slice(5, 7) - 1, +dateStr.slice(8, 10));
  return new Date(ms + days * 86_400_000).toISOString().slice(0, 10);
}

async function main() {
  const today = kstToday();
  const { data, error } = await sb
    .from("weeks")
    .select("id,start_date,end_date,season_key,result_published_at,is_official_rest")
    .order("start_date", { ascending: true });
  if (error) throw new Error(error.message);
  const weeks = (data ?? []) as Array<{
    id: string; start_date: string | null; end_date: string | null;
    season_key: string | null; result_published_at: string | null; is_official_rest: boolean | null;
  }>;

  // 현재 시즌(2026)은 finalization(publishWeekResult) 단일경로 소관 — side-path 백필 금지.
  //   "현재 시즌 절대 건드리지 말 것" 요구 반영. 과거 시즌(2023~2025)만 대상.
  const CURRENT_SEASON_PREFIX = "2026";

  const target: typeof weeks = [];
  const excludeAlreadyPub: typeof weeks = [];
  const excludeWindowOpen: typeof weeks = [];
  const excludeNoEnd: typeof weeks = [];
  const excludeCurrentSeason: typeof weeks = [];

  for (const w of weeks) {
    if (w.result_published_at) { excludeAlreadyPub.push(w); continue; }
    if ((w.season_key ?? "").startsWith(CURRENT_SEASON_PREFIX)) { excludeCurrentSeason.push(w); continue; }
    if (!w.end_date) { excludeNoEnd.push(w); continue; }
    const cutoff = addDays(w.end_date.slice(0, 10), 14);
    if (cutoff < today) target.push(w); // 검수창 종료일이 오늘 이전 = 경과
    else excludeWindowOpen.push(w);
  }

  const fmt = (w: (typeof weeks)[number]) =>
    `${w.start_date}~${w.end_date} ${w.season_key ?? "-"}${w.is_official_rest ? " [휴식]" : ""}`;

  console.log(`오늘(KST)=${today}`);
  console.log(`\n=== 백필 대상 (검수창 경과 + NULL) : ${target.length}행 ===`);
  for (const w of target) console.log(`  ✓ ${fmt(w)} → published=${addDays(w.end_date!.slice(0,10),14)}T00:00:00Z`);

  console.log(`\n=== 제외: 이미 공표됨 : ${excludeAlreadyPub.length}행 ===`);
  console.log(`\n=== 제외: 현재 시즌(2026·finalization 소관) : ${excludeCurrentSeason.length}행 ===`);
  for (const w of excludeCurrentSeason) console.log(`  · ${fmt(w)}`);

  console.log(`\n=== 제외: 검수창 미경과(진행중/검수중) : ${excludeWindowOpen.length}행 ===`);
  for (const w of excludeWindowOpen) console.log(`  · ${fmt(w)} (검수창 종료 ${addDays(w.end_date!.slice(0,10),14)} ≥ 오늘)`);
  if (excludeNoEnd.length) {
    console.log(`\n=== 제외: end_date 없음 : ${excludeNoEnd.length}행 ===`);
    for (const w of excludeNoEnd) console.log(`  · id=${w.id} ${w.start_date}`);
  }

  // 시즌별 대상 집계
  const bySeason = new Map<string, number>();
  for (const w of target) bySeason.set(w.season_key ?? "-", (bySeason.get(w.season_key ?? "-") ?? 0) + 1);
  console.log(`\n대상 시즌별: ${JSON.stringify([...bySeason.entries()].sort())}`);

  if (!APPLY) {
    console.log(`\n[DRY RUN] 적용하려면 APPLY=1. (대상 ${target.length}행)`);
    return;
  }

  // ── 적용 ──
  console.log(`\n[APPLY] ${target.length}행 업데이트 시작...`);
  let updated = 0;
  for (const w of target) {
    const ts = `${addDays(w.end_date!.slice(0, 10), 14)}T00:00:00+00:00`;
    const { error: upErr } = await sb
      .from("weeks")
      .update({ result_published_at: ts })
      .eq("id", w.id)
      .is("result_published_at", null); // 동시성 가드 — NULL 인 행만
    if (upErr) { console.error(`  ✗ ${fmt(w)}: ${upErr.message}`); continue; }
    updated++;
  }
  console.log(`[APPLY] 완료: ${updated}/${target.length}행 result_published_at 기록.`);
}

main().catch((e) => { console.error(e); process.exit(1); });
