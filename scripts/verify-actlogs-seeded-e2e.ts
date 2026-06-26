// actLogs(v30) E2E — 사용자 카드가 있는 주차에 regular+irregular 적립을 seed 하고
//   direct/snapshot/HTTP 에서 actLogs 가 정확히 내려오는지 검증 후 정리(cleanup).
//   run: npx tsx --env-file=.env.local scripts/verify-actlogs-seeded-e2e.ts
//   ⚠ 테스트 사용자 대상 prod write — TAG 행만 생성/삭제(finally cleanup). 실유저 무접촉.
import { createClient } from "@supabase/supabase-js";
import { getCluster4WeeklyCardsForProfileUser } from "@/lib/cluster4WeeklyCardsData";
import { loadActLogsByStartDate } from "@/lib/cluster4ActLogsData";
import {
  recomputeAndStoreWeeklyCardsSnapshot,
  readWeeklyCardsSnapshot,
} from "@/lib/cluster4WeeklyCardsSnapshot";
import type { Cluster4WeeklyCardDto, Cluster4ActLogDto } from "@/shared/cluster4.contracts";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
const BASE = process.env.ADMIN_BASE_URL ?? "http://localhost:3000";
const USER = "37b7ddce-6146-4941-8c5f-c1dfa4e09f7e"; // encre 테스트 유저(원장 보유)
const TAG = "ZZ-actlog-e2e";
let pass = 0, fail = 0;
const ck = (l: string, ok: boolean, d = "") => { console.log(`  ${ok ? "✓" : "✗"} ${l}${d ? ` — ${d}` : ""}`); ok ? pass++ : fail++; };
const flat = (cards: Cluster4WeeklyCardDto[]): Cluster4ActLogDto[] => cards.flatMap((c) => c.actLogs ?? []);
// 키 순서 무관 정규화 비교 — snapshot 은 jsonb 저장 시 키 순서를 보존하지 않으므로(값은 동일)
//   JSON.stringify 직접 비교 대신 키 정렬 후 비교한다.
const canon = (v: unknown): string =>
  JSON.stringify(v, (_k, val) =>
    val && typeof val === "object" && !Array.isArray(val)
      ? Object.fromEntries(Object.entries(val).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : val,
  );

async function main() {
  let irregularId: string | null = null;
  let statusId: string | null = null;
  let awardRefs: Array<{ source: string; ref_id: string }> = [];
  let SEED_START = "";
  try {
    // 대상 주차 자동 선택 — 사용자 카드 startDate ∩ 실제 weeks 행(합성 weekId 주차 회피).
    const cardsForPick = await getCluster4WeeklyCardsForProfileUser(USER);
    const cardStarts = [...new Set(cardsForPick.map((c) => c.startDate).filter(Boolean))];
    const realWeeks = (await sb
      .from("weeks")
      .select("id,iso_year,iso_week,week_number,season_key,start_date")
      .in("start_date", cardStarts)).data as any[] | null;
    const week = (realWeeks ?? []).find((w) => w.iso_year != null && w.iso_week != null);
    if (!week) { console.log("⚠ 카드 startDate 와 일치하는 실제 weeks 행 없음 — 중단"); process.exit(2); }
    SEED_START = week.start_date as string;
    console.log(`대상 주차: ${week.season_key} W${week.week_number} iso=${week.iso_year}-W${week.iso_week} start=${SEED_START} id=${week.id}`);
    const org = "encre";

    // 마스터 액트 1개(regular JOIN 용).
    const act = (await sb.from("process_acts").select("id,act_name,hub,line_group_id,duration_minutes,act_type").limit(1).maybeSingle()).data as any;
    if (!act) { console.log("⚠ process_acts 비어있음 — regular seed 스킵"); }
    const lgName = act?.line_group_id
      ? ((await sb.from("process_line_groups").select("name").eq("id", act.line_group_id).maybeSingle()).data as any)?.name ?? null
      : null;

    // ── seed: irregular act + award ──
    const irrIns = await sb.from("process_irregular_acts").insert({
      organization_slug: org, week_id: week.id, kind: "manual_grant",
      act_name: `${TAG} 부분검수액트`, applicant_admin_id: null, applicant_admin_name: TAG,
      target_user_id: USER, target_user_name: TAG, duration_minutes: 25,
      point_a: 7, point_b: 3, point_c: 0, crew_reaction: "partial",
      scheduled_check_at: `${SEED_START}T05:00:00.000Z`, status: "completed", completed_at: `${SEED_START}T06:00:00.000Z`,
    }).select("id").single();
    if (irrIns.error) throw new Error(`irregular insert: ${irrIns.error.message}`);
    irregularId = irrIns.data.id;
    const aw1 = await sb.from("process_point_awards").upsert({
      source: "irregular", ref_id: irregularId, user_id: USER, year: week.iso_year, week_number: week.iso_week,
      point_check: 7, point_advantage: 3, point_penalty: 0, organization_slug: org, scope_mode: "test", updated_at: new Date().toISOString(),
    }, { onConflict: "source,ref_id,user_id" });
    if (aw1.error) throw new Error(`irregular award: ${aw1.error.message}`);
    awardRefs.push({ source: "irregular", ref_id: irregularId });

    // ── seed: regular status + award (act 있으면) ──
    if (act) {
      const stIns = await sb.from("process_check_statuses").insert({
        organization_slug: org, hub: act.hub, week_id: week.id, line_group_id: act.line_group_id, act_id: act.id,
        status: "completed", requested_at: `${SEED_START}T01:00:00.000Z`, completed_at: `${SEED_START}T02:00:00.000Z`, scope_mode: "test",
      }).select("id").single();
      if (stIns.error) throw new Error(`status insert: ${stIns.error.message}`);
      statusId = stIns.data.id;
      const aw2 = await sb.from("process_point_awards").upsert({
        source: "regular", ref_id: statusId, user_id: USER, year: week.iso_year, week_number: week.iso_week,
        point_check: act.point_check ?? 5, point_advantage: 0, point_penalty: 0, organization_slug: org, scope_mode: "test", updated_at: new Date().toISOString(),
      }, { onConflict: "source,ref_id,user_id" });
      if (aw2.error) throw new Error(`regular award: ${aw2.error.message}`);
      awardRefs.push({ source: "regular", ref_id: statusId });
    }

    // ── PART 1: loadActLogsByStartDate (startDate 버킷) ──
    console.log("\n── PART 1: loader ──");
    const map = await loadActLogsByStartDate(USER);
    const seeded = map.get(SEED_START) ?? [];
    console.log("    seeded actLogs:", JSON.stringify(seeded));
    const irr = seeded.find((l) => l.source === "irregular" && l.actName.includes(TAG));
    ck("irregular actLog 부착됨", !!irr);
    if (irr) {
      ck("irregular actName 채움", irr.actName === `${TAG} 부분검수액트`);
      ck("irregular kind='partial'(crew_reaction)", irr.kind === "partial");
      ck("irregular 포인트 A/B/C = 원장값", irr.pointA === 7 && irr.pointB === 3 && irr.pointC === 0, `${irr.pointA}/${irr.pointB}/${irr.pointC}`);
      ck("irregular durationMinutes=25", irr.durationMinutes === 25);
      ck("irregular hub/lineGroupName=null(비귀속)", irr.hub === null && irr.lineGroupName === null);
      ck("irregular occurredAt 채움", !!irr.occurredAt);
      ck("irregular weekNumber=카드 시즌주차", irr.weekNumber === week.week_number, `${irr.weekNumber} vs ${week.week_number}`);
    }
    if (act) {
      const reg = seeded.find((l) => l.source === "regular");
      ck("regular actLog 부착됨", !!reg);
      if (reg) {
        ck("regular actName=마스터 액트명", reg.actName === act.act_name, reg.actName);
        ck("regular hub=마스터 hub", reg.hub === act.hub, `${reg.hub}`);
        ck("regular lineGroupName=라인급명", reg.lineGroupName === lgName, `${reg.lineGroupName}`);
        ck("regular kind=act_type", reg.kind === act.act_type, reg.kind);
        ck("regular requestedAt 채움", !!reg.requestedAt);
      }
    }

    // ── PART 2: direct + snapshot 에 반영 ──
    console.log("\n── PART 2: direct + snapshot ──");
    const direct = await getCluster4WeeklyCardsForProfileUser(USER);
    const directCard = direct.find((c) => c.startDate === SEED_START);
    ck("direct 카드(W11)에 actLogs 부착", (directCard?.actLogs?.length ?? 0) >= (act ? 2 : 1), `${directCard?.actLogs?.length}건`);

    await recomputeAndStoreWeeklyCardsSnapshot(USER);
    const snap = await readWeeklyCardsSnapshot(USER);
    const snapCards = snap.status === "hit" || snap.status === "stale" ? snap.cards : [];
    const snapCard = snapCards.find((c) => c.startDate === SEED_START);
    ck("snapshot 카드(W11)에 actLogs 부착", (snapCard?.actLogs?.length ?? 0) >= (act ? 2 : 1), `${snapCard?.actLogs?.length}건`);
    const dEq = canon(directCard?.actLogs) === canon(snapCard?.actLogs);
    ck("direct == snapshot (해당 주차 actLogs, 키순서 무관)", dEq);
    if (!dEq) {
      console.log("    DIRECT:", canon(directCard?.actLogs));
      console.log("    SNAP  :", canon(snapCard?.actLogs));
    }

    // ── PART 3: HTTP demo ==  direct ──
    console.log("\n── PART 3: HTTP demo ──");
    try {
      const r = await fetch(`${BASE}/api/cluster4/weekly-cards?demoUserId=${USER}`);
      const body = await r.json().catch(() => null);
      if (r.status !== 200 || !body) { console.log(`    ⚠ HTTP ${r.status} — SKIP`); }
      else if (/demo/i.test(JSON.stringify(body?.error ?? ""))) { console.log("    ⚠ ENABLE_DEMO_MODE 필요 — SKIP"); }
      else {
        // 카드 배열은 응답 body.data(=cards) 에 있다.
        const httpCards = (body.data ?? body.cards ?? []) as Cluster4WeeklyCardDto[];
        const httpCard = httpCards.find((c) => c.startDate === SEED_START);
        ck("HTTP demo 카드에 actLogs 부착", (httpCard?.actLogs?.length ?? 0) >= (act ? 2 : 1), `${httpCard?.actLogs?.length}건`);
        ck("HTTP demo == direct (해당 주차 actLogs, 키순서 무관)", canon(httpCard?.actLogs) === canon(directCard?.actLogs));
        ck("HTTP 전체 actLogs == direct 전체(키순서 무관)", canon(flat(httpCards)) === canon(flat(direct)));
      }
    } catch (e) {
      console.log(`    ⚠ HTTP 호출 실패 — SKIP: ${e instanceof Error ? e.message : String(e)}`);
    }
  } finally {
    // ── cleanup: 원장 + seed 행 삭제 후 snapshot 재계산 ──
    console.log("\n── cleanup ──");
    for (const ref of awardRefs) await sb.from("process_point_awards").delete().eq("source", ref.source).eq("ref_id", ref.ref_id).eq("user_id", USER);
    if (statusId) await sb.from("process_check_statuses").delete().eq("id", statusId);
    if (irregularId) await sb.from("process_irregular_acts").delete().eq("id", irregularId);
    await recomputeAndStoreWeeklyCardsSnapshot(USER);
    const after = await loadActLogsByStartDate(USER);
    const left = (after.get(SEED_START) ?? []).filter((l) => l.actName.includes(TAG) || l.source === "regular");
    ck("cleanup 후 seed actLogs 제거됨", left.length === 0, `잔여 ${left.length}`);
    console.log("    (cleanup 완료 — seed 행/원장 삭제, snapshot 재계산)");
  }

  console.log(`\n결과: ${pass} pass / ${fail} fail`);
  process.exit(fail ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
