/**
 * 이력서 카드 "시즌 N주 / 16주" SoT 검증 — 미공표(집계 중) 주차 포함 여부.
 *   npx tsx --env-file=.env.local scripts/verify-resume-season-weeks-sot.ts [userId...]
 *
 *   1) uws 원본에서 2026-spring success 카운트 (전환 제외) — 전체 vs 공표완료만
 *   2) direct getCluster1Resume().seasonRecords 의 봄 시즌 approvedWeeks
 *   3) HTTP GET /api/cluster1/resume?userId= (x-internal-api-key)
 */
import { config } from "dotenv";
config({ path: ".env.local" });
import { createClient } from "@supabase/supabase-js";
import { getCluster1Resume } from "@/lib/cluster1ResumeData";
import { isTransitionWeekStart } from "@/lib/seasonCalendar";

const sb = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);
const BASE = process.env.VERIFY_BASE_URL ?? "http://localhost:3000";

async function main() {
  let ids = process.argv.slice(2).filter((a) => !a.startsWith("--"));

  // 공표 여부 맵 (2026-spring)
  const { data: weeks } = await sb
    .from("weeks")
    .select("start_date,result_published_at")
    .eq("season_key", "2026-spring");
  const publishedByStart = new Map(
    (weeks ?? []).map((w: any) => [w.start_date, Boolean(w.result_published_at)]),
  );
  console.log(
    "2026-spring 공표 상태:",
    [...publishedByStart.entries()].sort().map(([s, p]) => `${s.slice(5)}=${p ? "공표" : "미공표"}`).join(" "),
  );

  if (ids.length === 0) {
    // 봄 success=9 인 사용자 자동 탐색 (예시 "9주 / 16주" 재현 대상)
    const rows: any[] = [];
    for (let from = 0; ; from += 1000) {
      const { data, error } = await sb
        .from("user_week_statuses")
        .select("user_id,week_start_date,status")
        .eq("season_key", "2026-spring")
        .order("id", { ascending: true })
        .range(from, from + 999);
      if (error) throw new Error(error.message);
      rows.push(...(data ?? []));
      if (!data || data.length < 1000) break;
    }
    const cnt = new Map<string, number>();
    for (const r of rows) {
      if (r.status !== "success") continue;
      if (isTransitionWeekStart(r.week_start_date)) continue;
      cnt.set(r.user_id, (cnt.get(r.user_id) ?? 0) + 1);
    }
    ids = [...cnt.entries()].filter(([, n]) => n === 9).slice(0, 2).map(([u]) => u);
    console.log(`봄 success=9 사용자 자동 선택: ${ids.join(", ") || "(없음)"}`);
    if (!ids.length) ids = [...cnt.entries()].slice(0, 1).map(([u]) => u);
  }

  for (const userId of ids) {
    console.log(`\n===== ${userId} =====`);
    // 1) uws 원본
    const { data: uws } = await sb
      .from("user_week_statuses")
      .select("week_start_date,status")
      .eq("user_id", userId)
      .eq("season_key", "2026-spring");
    const success = (uws ?? []).filter(
      (r: any) => r.status === "success" && !isTransitionWeekStart(r.week_start_date),
    );
    const successPublishedOnly = success.filter(
      (r: any) => publishedByStart.get(r.week_start_date) === true,
    );
    const unpub = success.filter((r: any) => publishedByStart.get(r.week_start_date) !== true);
    console.log(
      `uws 원본: 봄 success(전환제외)=${success.length} | 그중 공표완료=${successPublishedOnly.length} | 미공표=${unpub.length}${unpub.length ? ` (${unpub.map((r: any) => r.week_start_date).join(",")})` : ""}`,
    );

    // 2) direct
    const dto = await getCluster1Resume(userId);
    const spring = (dto?.seasonRecords ?? []).find(
      (r: any) => r.year === "26" && r.seasonName.includes("봄"),
    );
    console.log(
      `direct seasonRecords(26 봄): approvedWeeks=${spring?.approvedWeeks} / totalWeeks=${spring?.totalWeeks} | progress=${spring?.progressStatus} review=${spring?.reviewStatus}`,
    );

    // 3) HTTP (internal)
    const res = await fetch(`${BASE}/api/cluster1/resume?userId=${userId}`, {
      headers: { "x-internal-api-key": process.env.INTERNAL_API_KEY ?? "" },
    });
    const body: any = await res.json().catch(() => null);
    const httpSpring = (body?.data?.seasonRecords ?? body?.seasonRecords ?? []).find(
      (r: any) => r.year === "26" && String(r.seasonName).includes("봄"),
    );
    console.log(
      `HTTP(${res.status}) seasonRecords(26 봄): approvedWeeks=${httpSpring?.approvedWeeks} / totalWeeks=${httpSpring?.totalWeeks}`,
    );

    const directN = spring?.approvedWeeks;
    console.log(
      `판정: direct==HTTP ${directN === httpSpring?.approvedWeeks ? "✓" : "✗"} | ` +
        (directN === success.length && success.length !== successPublishedOnly.length
          ? `미공표 포함 (raw=${success.length} > 공표만=${successPublishedOnly.length}) — uws 직독`
          : directN === success.length
            ? `raw uws 와 일치 (이 사용자는 미공표 success 없음 — 포함 여부 비식별)`
            : `raw(${success.length})·공표만(${successPublishedOnly.length}) 어느 쪽과도 다름?`),
    );
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
