/**
 * READ-ONLY PREVIEW: 테스터 과거 fail 주차 라인 개설 더미 데이터 보강 — INSERT 예정분 산출.
 *
 *   npx tsx --env-file=.env.local scripts/preview-tester-line-open-backfill.ts
 *
 * 후보 정의 (2026-06-04 합의):
 *   - 대상 사용자: test_user_markers 등재 90명만 (ILIKE %T% 아님 — vanuatu.golden 오포함 방지)
 *   - 대상 주차: user_week_statuses status='fail' AND
 *               updated_at ∈ [2026-06-04T01:00Z, 01:10Z)  (오늘 v11 sync flip 분)
 *               AND week_start_date < 2026-05-25            (tallying 05-25 / running 06-01 제외)
 *   - 중복 방지: (user, week) 에 이미 user-mode 라인 타깃이 있으면 제외
 *   - 라인 선택: 그 주차 info 라인(week_id 매칭, is_active) 중 submission_opens_at·id 최소 1개 재사용.
 *               없으면 "신규 더미 info 라인 필요" 로 집계.
 * 실유저 보호 근거: info 라인은 line_code NULL → org 판정 불가 → 미배정 사용자에게 fail-closed(숨김),
 *   experience 필수 슬롯 verdict 와 무관 → 실유저 카드/판정/분모에 영향 없음.
 */
import { config } from "dotenv";
config({ path: ".env.local" });

import { createClient } from "@supabase/supabase-js";

const sb = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

export const FLIP_WINDOW_START = "2026-06-04T01:00:00Z";
export const FLIP_WINDOW_END = "2026-06-04T01:10:00Z";
// 컷오프 = min(tallying 주차 2026-05-25, 실유저 최초 활동주차 2026-05-04).
// info 라인은 org='common'(resolveMasterOrg)이라 실유저 카드가 커버하는 주차(2026-05-04~)에
// 개설 신호를 넣으면 실유저 분모A(+표시 synthetic fail)까지 오염된다 → 그 이전 주차만 보강.
export const TALLYING_WEEK_START = "2026-05-04";

export type BackfillPlan = {
  testers: Map<string, string>; // user_id → display_name
  // week_start → { weekId, lineId(재사용) | null(신규 필요), testers: user_id[] }
  byWeek: Map<
    string,
    { weekId: string; reuseLineId: string | null; reuseLineTitle: string | null; testers: string[] }
  >;
  dedupSkipped: { userId: string; weekStart: string }[];
  totalTargetInserts: number;
  newLinesNeeded: string[]; // week_start[]
};

export async function buildBackfillPlan(opts: { onlyUserId?: string } = {}): Promise<BackfillPlan> {
  // 1. 테스터 (test_user_markers 기준 — 정확 90명)
  const { data: mk, error: mkErr } = await sb.from("test_user_markers").select("user_id");
  if (mkErr) throw new Error("test_user_markers: " + mkErr.message);
  const testerIds = (mk ?? []).map((m: any) => m.user_id as string);
  const { data: profs } = await sb
    .from("user_profiles")
    .select("user_id, display_name")
    .in("user_id", testerIds);
  const testers = new Map<string, string>(
    ((profs ?? []) as any[]).map((p) => [p.user_id, p.display_name]),
  );

  // 2. 후보 fail 행 (오늘 flip, tallying 이전 주차만)
  let flips: { user_id: string; week_start_date: string }[] = [];
  for (let i = 0; i < testerIds.length; i += 30) {
    const { data, error } = await sb
      .from("user_week_statuses")
      .select("user_id, week_start_date")
      .in("user_id", testerIds.slice(i, i + 30))
      .eq("status", "fail")
      .gte("updated_at", FLIP_WINDOW_START)
      .lt("updated_at", FLIP_WINDOW_END)
      .lt("week_start_date", TALLYING_WEEK_START);
    if (error) throw new Error("user_week_statuses: " + error.message);
    flips = flips.concat((data ?? []) as any[]);
  }
  if (opts.onlyUserId) flips = flips.filter((f) => f.user_id === opts.onlyUserId);

  // 3. week_start → weeks.id
  const weekStarts = [...new Set(flips.map((f) => f.week_start_date))];
  const { data: weeks, error: wErr } = await sb
    .from("weeks")
    .select("id, start_date")
    .in("start_date", weekStarts.length ? weekStarts : ["1900-01-01"]);
  if (wErr) throw new Error("weeks: " + wErr.message);
  const weekIdByStart = new Map<string, string>(
    ((weeks ?? []) as any[]).map((w) => [w.start_date, w.id]),
  );

  // 4. 중복 방지: (user, week) 에 이미 user-mode 타깃이 있으면 제외
  const weekIds = [...weekIdByStart.values()];
  let existing: { week_id: string; target_user_id: string | null }[] = [];
  for (let i = 0; i < weekIds.length; i += 50) {
    const { data, error } = await sb
      .from("cluster4_line_targets")
      .select("week_id, target_user_id")
      .eq("target_mode", "user")
      .in("week_id", weekIds.slice(i, i + 50));
    if (error) throw new Error("cluster4_line_targets: " + error.message);
    existing = existing.concat((data ?? []) as any[]);
  }
  const existingPairs = new Set(existing.map((e) => `${e.target_user_id}|${e.week_id}`));

  // 5. 주차별 재사용 가능한 info 라인 (week_id 매칭, is_active) — opens_at, id 순 1개
  const { data: infoLines, error: ilErr } = await sb
    .from("cluster4_lines")
    .select("id, week_id, main_title, submission_opens_at")
    .eq("part_type", "info")
    .eq("is_active", true)
    .in("week_id", weekIds.length ? weekIds : ["00000000-0000-0000-0000-000000000000"]);
  if (ilErr) throw new Error("cluster4_lines(info): " + ilErr.message);
  const reuseByWeekId = new Map<string, { id: string; main_title: string }>();
  for (const l of ((infoLines ?? []) as any[]).sort((a, b) =>
    String(a.submission_opens_at ?? "").localeCompare(String(b.submission_opens_at ?? "")) ||
    String(a.id).localeCompare(String(b.id)),
  )) {
    if (!reuseByWeekId.has(l.week_id)) reuseByWeekId.set(l.week_id, { id: l.id, main_title: l.main_title });
  }

  // 6. 플랜 조립
  const byWeek: BackfillPlan["byWeek"] = new Map();
  const dedupSkipped: BackfillPlan["dedupSkipped"] = [];
  let totalTargetInserts = 0;
  for (const f of flips) {
    const weekId = weekIdByStart.get(f.week_start_date);
    if (!weekId) {
      console.warn("weeks row 없음 — 제외:", f.week_start_date);
      continue;
    }
    if (existingPairs.has(`${f.user_id}|${weekId}`)) {
      dedupSkipped.push({ userId: f.user_id, weekStart: f.week_start_date });
      continue;
    }
    let entry = byWeek.get(f.week_start_date);
    if (!entry) {
      const reuse = reuseByWeekId.get(weekId) ?? null;
      entry = {
        weekId,
        reuseLineId: reuse?.id ?? null,
        reuseLineTitle: reuse?.main_title ?? null,
        testers: [],
      };
      byWeek.set(f.week_start_date, entry);
    }
    entry.testers.push(f.user_id);
    totalTargetInserts++;
  }

  const newLinesNeeded = [...byWeek.entries()]
    .filter(([, v]) => !v.reuseLineId)
    .map(([k]) => k)
    .sort();

  return { testers, byWeek, dedupSkipped, totalTargetInserts, newLinesNeeded };
}

async function main() {
  const plan = await buildBackfillPlan();
  console.log("══════ PREVIEW: 테스터 과거 fail 주차 라인 개설 보강 ══════");
  console.log("대상 테스터 풀:", plan.testers.size, "명 (test_user_markers)");
  const sortedWeeks = [...plan.byWeek.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  console.log("대상 주차 수:", sortedWeeks.length);
  console.log("INSERT 예정 타깃 row 수:", plan.totalTargetInserts);
  console.log("신규 더미 info 라인 필요 주차 수:", plan.newLinesNeeded.length, "→ 라인 INSERT", plan.newLinesNeeded.length, "row");
  console.log("중복 제외 (이미 user-mode 타깃 보유):", plan.dedupSkipped.length, "row");
  for (const d of plan.dedupSkipped) {
    console.log("  skip:", plan.testers.get(d.userId) ?? d.userId, d.weekStart);
  }
  console.log("\n주차별:");
  for (const [ws, v] of sortedWeeks) {
    console.log(
      `  ${ws} | 테스터 ${v.testers.length}명 | ${v.reuseLineId ? `재사용 line=${v.reuseLineId.slice(0, 8)} "${String(v.reuseLineTitle).slice(0, 24)}"` : "신규 더미 라인 필요"}`,
    );
  }
}

if (process.argv[1] && process.argv[1].includes("preview-tester-line-open-backfill")) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
