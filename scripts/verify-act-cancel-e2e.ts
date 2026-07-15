/**
 * 액트 소프트 취소 실데이터 E2E 검증 — 서비스 롤 직접(레포 verify 스크립트 관례).
 * 반드시 테스트 유저(test_user_markers)만 대상으로 하며, 종료 시 원복한다(무손실).
 *
 *   tsx --env-file=.env.local scripts/verify-act-cancel-e2e.ts [USER_ID WEEK_ID AWARD_ID]
 *   인자 없으면 테스트 유저 중 취소 가능한 award 를 자동 탐색한다.
 *
 * 검증(고객=취소 숨김 / 관리자=취소됨 유지 / 포인트·snapshot 수렴 / 부활 방지):
 *   [1] 취소 후 고객 actLogs(default)에서 해당 award 사라짐.
 *   [2] 관리자 actLogs(includeCancelled)에는 cancelled=true 로 유지.
 *   [3] user_weekly_points: A·C 감소, 최종 B(adv−pen) 원복(Point C 취소 시 B 복원).
 *   [4] snapshot 재생성 카드 actLogs 에도 해당 award 없음(고객 수렴).
 *   [5] 부활 방지: 동일 (source,ref_id,user_id) upsert 재실행 후에도 cancelled_at 보존.
 *   [6] 원복(un-cancel)+재집계 후 원래 합계·목록 복귀.
 */
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { processPointAwardsHasCancelColumns } from "@/lib/processPointAwardsCancelState";
import {
  softCancelActAwards,
  recomputeWeeklyPointsForUsers,
} from "@/lib/processPointAccrual";
import {
  readWeeklyCardsSnapshot,
  recomputeAndStoreWeeklyCardsSnapshot,
} from "@/lib/cluster4WeeklyCardsSnapshot";
import { loadActLogsByStartDate } from "@/lib/cluster4ActLogsData";

type Award = {
  id: string; source: string; ref_id: string; user_id: string;
  year: number; week_number: number;
  point_check: number; point_advantage: number; point_penalty: number;
  cancelled_at: string | null;
};

const results: Array<{ id: string; pass: boolean; detail: string }> = [];
const check = (id: string, pass: boolean, detail: string) => {
  results.push({ id, pass, detail });
  console.log(`  [${id}] ${pass ? "PASS" : "FAIL"} — ${detail}`);
};

async function uwp(userId: string, year: number, wk: number) {
  const { data } = await supabaseAdmin
    .from("user_weekly_points").select("points,advantages,penalty")
    .eq("user_id", userId).eq("year", year).eq("week_number", wk).maybeSingle();
  const r = (data ?? { points: 0, advantages: 0, penalty: 0 }) as { points: number; advantages: number; penalty: number };
  return { a: r.points, b: r.advantages, c: r.penalty, finalB: (r.advantages ?? 0) - (r.penalty ?? 0) };
}

async function weekStartFor(year: number, wk: number): Promise<string | null> {
  const { data } = await supabaseAdmin
    .from("weeks").select("id,start_date").eq("iso_year", year).eq("iso_week", wk).limit(1).maybeSingle();
  return (data as { id: string; start_date: string } | null)?.start_date ?? null;
}
async function weekIdFor(year: number, wk: number): Promise<string | null> {
  const { data } = await supabaseAdmin
    .from("weeks").select("id").eq("iso_year", year).eq("iso_week", wk).limit(1).maybeSingle();
  return (data as { id: string } | null)?.id ?? null;
}

async function customerHasAward(userId: string, startDate: string, awardId: string): Promise<boolean> {
  // 고객 경로 = includeCancelled 기본 false. 취소 액트는 목록에서 빠져야 한다.
  const map = await loadActLogsByStartDate(userId);
  return (map.get(startDate) ?? []).some((l) => l.awardId === awardId);
}
async function adminRow(userId: string, startDate: string, awardId: string) {
  const map = await loadActLogsByStartDate(userId, { includeCancelled: true });
  return (map.get(startDate) ?? []).find((l) => l.awardId === awardId) ?? null;
}
async function snapshotHasAward(userId: string, startDate: string, awardId: string): Promise<boolean> {
  const snap = await readWeeklyCardsSnapshot(userId);
  const cards = snap.status === "hit" || snap.status === "stale" ? snap.cards : [];
  const card = cards.find((c) => c.startDate === startDate);
  return (card?.actLogs ?? []).some((l) => l.awardId === awardId);
}

async function discover(): Promise<Award | null> {
  const tm = await supabaseAdmin.from("test_user_markers").select("user_id").limit(500);
  const testIds = ((tm.data ?? []) as { user_id: string }[]).map((r) => r.user_id);
  if (testIds.length === 0) return null;
  // 취소 가능(미취소) award — penalty>0 우선(최종 B 복원 검증), 없으면 아무 award.
  for (const preferPenalty of [true, false]) {
    let q = supabaseAdmin
      .from("process_point_awards")
      .select("id,source,ref_id,user_id,year,week_number,point_check,point_advantage,point_penalty,cancelled_at")
      .in("user_id", testIds).is("cancelled_at", null)
      .in("source", ["regular", "irregular"]).limit(50);
    if (preferPenalty) q = q.gt("point_penalty", 0);
    const { data } = await q;
    const rows = (data ?? []) as Award[];
    if (rows.length) return rows[0];
  }
  return null;
}

async function main() {
  const has = await processPointAwardsHasCancelColumns();
  console.log(`cancel columns applied: ${has ? "YES" : "NO"}`);
  if (!has) { console.error("마이그레이션 미적용 — 중단."); process.exit(2); }

  const [aUser, , aAward] = process.argv.slice(2);
  let award: Award | null = null;
  if (aUser && aAward) {
    const { data } = await supabaseAdmin.from("process_point_awards")
      .select("id,source,ref_id,user_id,year,week_number,point_check,point_advantage,point_penalty,cancelled_at")
      .eq("id", aAward).maybeSingle();
    award = data as Award | null;
  } else {
    award = await discover();
  }
  if (!award) { console.error("적합한 테스트 award 를 찾지 못했습니다."); process.exit(2); }

  const { user_id: userId, year, week_number: wk } = award;
  const startDate = await weekStartFor(year, wk);
  const weekId = await weekIdFor(year, wk);
  if (!startDate || !weekId) { console.error("week 매핑 실패", { year, wk }); process.exit(2); }

  console.log(`\n대상 test user=${userId} week=(${year},W${wk}) start=${startDate}`);
  console.log(`award id=${award.id} source=${award.source} A/B/C=${award.point_check}/${award.point_advantage}/${award.point_penalty}\n`);

  // 사전 상태.
  const before = await uwp(userId, year, wk);
  const custBefore = await customerHasAward(userId, startDate, award.id);
  console.log(`before uwp A/B/C=${before.a}/${before.b}/${before.c} finalB=${before.finalB}, customer shows award=${custBefore}`);

  // ── 취소 ──
  const { cancelledCount } = await softCancelActAwards({
    awardIds: [award.id], userId, weekId, cancelledBy: userId, reason: "e2e-verify",
  });
  console.log(`softCancelActAwards → cancelledCount=${cancelledCount}`);

  const custAfter = await customerHasAward(userId, startDate, award.id);
  check("1", !custAfter, `고객 actLogs 에서 취소 액트 제거 (before=${custBefore}, after=${custAfter})`);

  const adm = await adminRow(userId, startDate, award.id);
  check("2", Boolean(adm?.cancelled), `관리자 actLogs 에 cancelled=true 유지 (found=${Boolean(adm)}, cancelled=${adm?.cancelled})`);

  const afterCancel = await uwp(userId, year, wk);
  const point3 =
    afterCancel.a === before.a - award.point_check &&
    afterCancel.c === before.c - award.point_penalty &&
    afterCancel.finalB === before.finalB - award.point_advantage + award.point_penalty;
  check("3", point3, `uwp A ${before.a}→${afterCancel.a}, C ${before.c}→${afterCancel.c}, finalB ${before.finalB}→${afterCancel.finalB}`);

  await recomputeAndStoreWeeklyCardsSnapshot(userId);
  const snapHas = await snapshotHasAward(userId, startDate, award.id);
  check("4", !snapHas, `snapshot 재생성 후 카드 actLogs 에 취소 액트 없음 (present=${snapHas})`);

  // ── 부활 방지: 재적립(upsert) 재실행 후 cancelled_at 보존 ──
  await supabaseAdmin.from("process_point_awards").upsert(
    {
      source: award.source, ref_id: award.ref_id, user_id: award.user_id, year: award.year, week_number: award.week_number,
      point_check: award.point_check, point_advantage: award.point_advantage, point_penalty: award.point_penalty,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "source,ref_id,user_id" },
  );
  const { data: re } = await supabaseAdmin.from("process_point_awards").select("cancelled_at").eq("id", award.id).maybeSingle();
  const stillCancelled = Boolean((re as { cancelled_at: string | null } | null)?.cancelled_at);
  await recomputeAndStoreWeeklyCardsSnapshot(userId);
  const snapHas2 = await snapshotHasAward(userId, startDate, award.id);
  check("5", stillCancelled && !snapHas2, `재적립 후에도 cancelled 보존=${stillCancelled}, snapshot 부활 없음(present=${snapHas2})`);

  // ── 원복 ──
  await supabaseAdmin.from("process_point_awards")
    .update({ cancelled_at: null, cancelled_by: null, cancel_reason: null, updated_at: new Date().toISOString() })
    .eq("id", award.id);
  await recomputeWeeklyPointsForUsers([userId], weekId);
  await recomputeAndStoreWeeklyCardsSnapshot(userId);
  const restored = await uwp(userId, year, wk);
  const custRestored = await customerHasAward(userId, startDate, award.id);
  check("6", restored.a === before.a && restored.b === before.b && restored.c === before.c && custRestored === custBefore,
    `원복 uwp=${restored.a}/${restored.b}/${restored.c} (기대 ${before.a}/${before.b}/${before.c}), customer=${custRestored}`);

  const allPass = results.every((r) => r.pass);
  console.log(`\n=== ${allPass ? "ALL PASS" : "FAILURE 있음"} ===`);
  process.exit(allPass ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
