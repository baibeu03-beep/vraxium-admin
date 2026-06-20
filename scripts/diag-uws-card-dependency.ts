/**
 * diag-uws-card-dependency.ts  (READ-ONLY)
 * 질문: 고객 주차 카드 생성이 user_week_statuses(uws) 행 존재에 의존하는가?
 *   휴식/비휴식 무관하게 uws 0행·부분·전체 버킷을 실데이터로 비교.
 *   DB(uws) ↔ direct cards ↔ snapshot 을 2026-spring 주차별로 정합.
 * 실행: npx tsx --env-file=.env.local scripts/diag-uws-card-dependency.ts
 */
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { fetchTestUserMarkerIds } from "@/lib/testUsers";
import { getCluster4WeeklyCardsForProfileUser } from "@/lib/cluster4WeeklyCardsData";
import { readWeeklyCardsSnapshot } from "@/lib/cluster4WeeklyCardsSnapshot";

const line = (s = "") => console.log(s);
const hr = () => line("─".repeat(80));

// 2026-spring 주차 (weeks 테이블 실측)
const ACTIVITY_STARTS = [
  "2026-03-02", "2026-03-09", "2026-03-16", "2026-03-23", "2026-03-30", // W1-5
  "2026-04-27", "2026-05-04", "2026-05-11", "2026-05-18", "2026-05-25", // W9-13
]; // 전부 published, non-rest
const SPRING_STARTS = [
  ...ACTIVITY_STARTS,
  "2026-04-06", "2026-04-13", "2026-04-20", // W6-8 rest published
  "2026-06-01", "2026-06-08", "2026-06-15", // W14-16 rest unpublished(현재 W16)
];
const WEEKNUM: Record<string, number> = {};
["2026-03-02","2026-03-09","2026-03-16","2026-03-23","2026-03-30","2026-04-06","2026-04-13","2026-04-20","2026-04-27","2026-05-04","2026-05-11","2026-05-18","2026-05-25","2026-06-01","2026-06-08","2026-06-15"]
  .forEach((s, i) => (WEEKNUM[s] = i + 1));

type Prof = { user_id: string; display_name: string | null; growth_status: string | null };

async function loadUwsCoverage(userIds: string[]) {
  // 정확한 컬럼: week_start_date, status (week_id 아님!)
  const cov = new Map<string, Map<string, string>>(); // user -> start -> status
  const totalCnt = new Map<string, number>();
  for (let i = 0; i < userIds.length; i += 80) {
    const chunk = userIds.slice(i, i + 80);
    const { data } = await supabaseAdmin
      .from("user_week_statuses")
      .select("user_id, week_start_date, status, season_key")
      .in("user_id", chunk);
    for (const r of (data ?? []) as any[]) {
      totalCnt.set(r.user_id, (totalCnt.get(r.user_id) ?? 0) + 1);
      if (!cov.has(r.user_id)) cov.set(r.user_id, new Map());
      cov.get(r.user_id)!.set(r.week_start_date, r.status);
    }
  }
  return { cov, totalCnt };
}

async function reconcile(p: Prof, bucket: string) {
  hr();
  line(`▶ [${bucket}] ${p.display_name ?? "?"} ${p.user_id.slice(0, 8)} growth=${p.growth_status}`);

  // 시즌상태
  const { data: ss } = await supabaseAdmin
    .from("user_season_statuses").select("season_key,status").eq("user_id", p.user_id);
  line(`   season_statuses=[${(ss ?? []).map((r: any) => `${r.season_key}:${r.status}`).join(", ")}]`);

  // uws (정확 컬럼) — 전체 + spring
  const { data: uwsAll } = await supabaseAdmin
    .from("user_week_statuses").select("week_start_date,status,season_key").eq("user_id", p.user_id);
  const springUws = new Map<string, string>();
  for (const r of (uwsAll ?? []) as any[]) if (SPRING_STARTS.includes(r.week_start_date)) springUws.set(r.week_start_date, r.status);
  const actCov = ACTIVITY_STARTS.filter((s) => springUws.has(s)).length;
  line(`   uws 전체=${uwsAll?.length ?? 0}행, 2026-spring=${springUws.size}행, 활동주차커버=${actCov}/10`);

  // direct cards
  let directSpring = new Map<string, string>();
  let directCount = 0;
  try {
    const cards = await getCluster4WeeklyCardsForProfileUser(p.user_id);
    directCount = cards.length;
    for (const c of cards) if (c.seasonKey === "2026-spring") directSpring.set(c.startDate, String(c.userWeekStatus));
  } catch (e: any) { line(`   DIRECT 실패: ${e.message}`); }
  line(`   DIRECT 총카드=${directCount}, 2026-spring 카드=${directSpring.size}`);

  // snapshot
  const snap = await readWeeklyCardsSnapshot(p.user_id);
  let snapSpring = new Map<string, string>();
  if (snap.status === "hit" || snap.status === "stale") {
    for (const c of (snap.cards as any[])) if (c.seasonKey === "2026-spring") snapSpring.set(c.startDate, String(c.userWeekStatus));
  }
  line(`   SNAP status=${snap.status}${(snap as any).reason ? `(${(snap as any).reason})` : ""}, 2026-spring 카드=${snapSpring.size}`);

  // 주차별 정합표 (활동주차 + 휴식주차)
  line(`   주차별: W# pub rest | uws | directCard | snapCard`);
  for (const s of [...SPRING_STARTS].sort()) {
    const wn = WEEKNUM[s];
    const isRest = ["2026-04-06","2026-04-13","2026-04-20","2026-06-01","2026-06-08","2026-06-15"].includes(s);
    const pub = !["2026-06-01","2026-06-08","2026-06-15"].includes(s); // W14-16 미공표
    const u = springUws.get(s) ?? "-";
    const d = directSpring.get(s) ?? "✗없음";
    const sn = snapSpring.get(s) ?? "✗없음";
    const flag = (!isRest && pub && u === "-" && d === "✗없음") ? "  ← uws없어 카드누락" : "";
    line(`      W${String(wn).padStart(2)} ${pub ? "P" : "u"} ${isRest ? "R" : "-"} | uws=${u.padEnd(13)} | direct=${d.padEnd(13)} | snap=${sn}${flag}`);
  }
}

async function main() {
  const testIds = await fetchTestUserMarkerIds();
  // 운영(실유저)만 — growth_status 별로 후보 모집
  const { data: profs } = await supabaseAdmin
    .from("user_profiles").select("user_id, display_name, growth_status");
  const operating = (profs ?? []).filter((p: any) => !testIds.has(p.user_id)) as Prof[];

  const active = operating.filter((p) => p.growth_status === "active");
  const rest = operating.filter((p) => p.growth_status === "seasonal_rest");

  // uws 커버리지 계산(active 표본 + rest 표본)
  const sample = [...active.slice(0, 250), ...rest.slice(0, 250)];
  const { cov, totalCnt } = await loadUwsCoverage(sample.map((p) => p.user_id));
  const actCover = (uid: string) => ACTIVITY_STARTS.filter((s) => cov.get(uid)?.has(s)).length;

  // 버킷 분류
  const zeroUws = active.filter((p) => (totalCnt.get(p.user_id) ?? 0) === 0);
  const fullCover = active.filter((p) => actCover(p.user_id) === 10);
  const partialCover = active.filter((p) => { const c = actCover(p.user_id); return c >= 1 && c <= 9; });

  line(`운영 active=${active.length} seasonal_rest=${rest.length}`);
  line(`[버킷] active 중 uws 0행=${zeroUws.length}, 활동10/10=${fullCover.length}, 부분(1~9)=${partialCover.length}`);

  line("\n=== 버킷2: 활동 active + uws 전체커버(10/10) ===");
  for (const p of fullCover.slice(0, 2)) await reconcile(p, "active·full");

  line("\n=== 버킷5: 활동 active + uws 부분커버(1~9) ===");
  for (const p of partialCover.slice(0, 3)) await reconcile(p, "active·partial");

  line("\n=== 버킷4: active + uws 0행 ===");
  if (zeroUws.length === 0) line("  (active 중 uws 0행 표본 없음)");
  for (const p of zeroUws.slice(0, 2)) await reconcile(p, "active·zeroUws");

  line("\n=== 버킷1: seasonal_rest(대조군) ===");
  for (const p of rest.slice(0, 2)) await reconcile(p, "seasonal_rest");

  hr();
  line("DONE (read-only)");
}
main().then(() => process.exit(0), (e) => { console.error(e); process.exit(1); });
