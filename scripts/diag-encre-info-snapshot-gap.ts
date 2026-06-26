/**
 * diag-encre-info-snapshot-gap.ts  (READ-ONLY)
 * encre 과거 info 라인이 어드민(live)에는 보이나 고객(snapshot)에는 누락되는지 전수 진단.
 *
 *   1) 활성 EC(encre) info 라인 cluster4_lines 존재 여부/표본
 *   2) (admin live == getCluster4WeeklyCardsForProfileUser 의 라인원천과 동일) — 노트
 *   3) encre 고객 snapshot.cards 에 해당 info 라인(displayLineCode/mainTitle)이 들어갔는지
 *   4) snapshot computed_at 이 EC info 라인 created_at 이후인지(=재계산 반영)
 *   5) is_stale 분포
 *   6) dto_version 분포(최신=26)
 *   7) encre audience 전원 중 snapshot 보유/누락
 *   8) 표본 encre 고객 N명: direct LIVE 계산 vs 저장 snapshot 의 info 라인 diff
 *
 * 쓰기 없음. npx tsx --env-file=.env.local scripts/diag-encre-info-snapshot-gap.ts
 */
import { config } from "dotenv";
config({ path: ".env.local" });
import { createClient } from "@supabase/supabase-js";
import { getCluster4WeeklyCardsForProfileUser } from "@/lib/cluster4WeeklyCardsData";
import { readWeeklyCardsSnapshot, WEEKLY_CARDS_DTO_VERSION } from "@/lib/cluster4WeeklyCardsSnapshot";
import type { Cluster4WeeklyCardDto } from "@/shared/cluster4.contracts";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
  auth: { persistSession: false },
});

const SAMPLE_USERS = Number(process.env.SAMPLE_USERS ?? 8);

type Line = { id: string; line_code: string | null; main_title: string | null; week_id: string | null; created_at: string | null; activity_type_id: string | null };

// card 에서 info 라인 식별 키 추출
function infoLinesOf(cards: Cluster4WeeklyCardDto[]) {
  const out: Array<{ weekId: string | null; lineId: string | null; displayLineCode: string | null; mainTitle: string | null; status: string }> = [];
  for (const c of cards) {
    for (const l of c.lines ?? []) {
      if ((l as any).partType === "information") {
        out.push({
          weekId: c.weekId,
          lineId: (l as any).lineId ?? null,
          displayLineCode: (l as any).displayLineCode ?? null,
          mainTitle: (l as any).mainTitle ?? null,
          status: (l as any).status ?? "",
        });
      }
    }
  }
  return out;
}

async function pageAll<T>(build: (from: number) => any): Promise<T[]> {
  const acc: T[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await build(from);
    if (error) throw new Error(error.message);
    acc.push(...((data ?? []) as T[]));
    if (!data || data.length < 1000) break;
  }
  return acc;
}

async function main() {
  console.log(`=== diag-encre-info-snapshot-gap (DTO v${WEEKLY_CARDS_DTO_VERSION}) ===\n`);

  // ── (1) 활성 EC info 라인 ──────────────────────────────────────────────
  const allInfo = await pageAll<Line>((from) =>
    sb.from("cluster4_lines")
      .select("id,line_code,main_title,week_id,created_at,activity_type_id")
      .eq("part_type", "info").eq("is_active", true)
      .order("id").range(from, from + 999),
  );
  const ecInfo = allInfo.filter((l) => typeof l.line_code === "string" && /EC/.test(l.line_code!));
  console.log(`[1] 활성 info 라인 총 ${allInfo.length}건 · 그중 EC(encre) 토큰: ${ecInfo.length}건`);
  // EC 라인의 target user 수
  const ecLineIds = ecInfo.map((l) => l.id);
  const targetCountByLine = new Map<string, number>();
  for (let i = 0; i < ecLineIds.length; i += 100) {
    const slice = ecLineIds.slice(i, i + 100);
    const { data } = await sb.from("cluster4_line_targets").select("line_id").in("line_id", slice);
    for (const r of (data ?? []) as Array<{ line_id: string }>) {
      targetCountByLine.set(r.line_id, (targetCountByLine.get(r.line_id) ?? 0) + 1);
    }
  }
  console.log("    EC info 라인 표본(최신순 최대 15):");
  for (const l of [...ecInfo].sort((a, b) => (b.created_at ?? "").localeCompare(a.created_at ?? "")).slice(0, 15)) {
    console.log(`      ${l.line_code}  wk=${l.week_id?.slice(0, 8)}  tgt=${targetCountByLine.get(l.id) ?? 0}  "${(l.main_title ?? "").slice(0, 30)}"  created=${l.created_at?.slice(0, 10)}`);
  }
  // EC info 라인이 속한 주차 집합
  const ecWeekIds = new Set(ecInfo.map((l) => l.week_id).filter(Boolean) as string[]);
  const ecLatestCreated = ecInfo.reduce((m, l) => (l.created_at && l.created_at > m ? l.created_at : m), "");
  console.log(`    EC info 라인 분포 주차 수=${ecWeekIds.size} · 최신 created_at=${ecLatestCreated}`);

  // ── (7/B) encre audience ───────────────────────────────────────────────
  const encreUsers = await pageAll<{ user_id: string }>((from) =>
    sb.from("user_profiles").select("user_id").eq("organization_slug", "encre").order("user_id").range(from, from + 999),
  );
  const encreIds = encreUsers.map((u) => u.user_id);
  console.log(`\n[7] encre audience(user_profiles.organization_slug='encre') = ${encreIds.length}명`);

  // encre 사용자 snapshot 상태(존재/버전/stale/computed_at)
  let snapPresent = 0, verMatch = 0, stale = 0, missingSnap = 0;
  let minComputed = "9999", maxComputed = "0";
  const computedByUser = new Map<string, string>();
  const verByUser = new Map<string, number>();
  const staleByUser = new Map<string, boolean>();
  for (let i = 0; i < encreIds.length; i += 50) {
    const chunk = encreIds.slice(i, i + 50);
    const { data, error } = await sb
      .from("cluster4_weekly_card_snapshots")
      .select("user_id,dto_version,is_stale,computed_at")
      .in("user_id", chunk);
    if (error) throw new Error(error.message);
    const seen = new Set<string>();
    for (const r of (data ?? []) as Array<{ user_id: string; dto_version: number; is_stale: boolean; computed_at: string }>) {
      seen.add(r.user_id);
      snapPresent++;
      if (r.dto_version === WEEKLY_CARDS_DTO_VERSION) verMatch++;
      if (r.is_stale) stale++;
      computedByUser.set(r.user_id, r.computed_at);
      verByUser.set(r.user_id, r.dto_version);
      staleByUser.set(r.user_id, r.is_stale);
      if (r.computed_at < minComputed) minComputed = r.computed_at;
      if (r.computed_at > maxComputed) maxComputed = r.computed_at;
    }
    for (const id of chunk) if (!seen.has(id)) missingSnap++;
  }
  console.log(`    snapshot 보유=${snapPresent} · 누락(행없음)=${missingSnap}`);
  console.log(`[6] dto_version==${WEEKLY_CARDS_DTO_VERSION}(최신) = ${verMatch} / 구버전 = ${snapPresent - verMatch}`);
  console.log(`[5] is_stale=true = ${stale} / fresh = ${snapPresent - stale}`);
  console.log(`[4] computed_at 범위: ${minComputed.slice(0, 19)} ~ ${maxComputed.slice(0, 19)}`);
  // EC 라인 최신 created_at 이후에 재계산된 사용자 수
  const recomputedAfterEc = [...computedByUser.values()].filter((c) => c > ecLatestCreated).length;
  console.log(`    EC 라인 최신 created_at(${ecLatestCreated?.slice(0, 19)}) 이후 재계산된 snapshot = ${recomputedAfterEc} / ${snapPresent}`);

  // ── (3/8) 표본 encre 고객: LIVE vs SNAPSHOT info 라인 diff ─────────────
  // EC info 라인을 "봐야 하는" 고객을 우선 표본으로: 그 라인이 개설된 주차에 카드가 있는 encre 유저.
  console.log(`\n[3/8] 표본 ${SAMPLE_USERS}명 LIVE(어드민/직접계산) vs SNAPSHOT(고객) info 라인 비교`);
  const sample = encreIds.slice(0, SAMPLE_USERS);
  let anyGap = false;
  for (const uid of sample) {
    let live: Cluster4WeeklyCardDto[] = [];
    try {
      live = await getCluster4WeeklyCardsForProfileUser(uid);
    } catch (e) {
      console.log(`  - ${uid.slice(0, 8)} LIVE 계산 실패: ${e instanceof Error ? e.message : e}`);
      continue;
    }
    const snap = await readWeeklyCardsSnapshot(uid);
    const snapCards = snap.status === "hit" || snap.status === "stale" ? snap.cards : [];
    const liveInfo = infoLinesOf(live);
    const snapInfo = infoLinesOf(snapCards);
    const keyOf = (x: { weekId: string | null; lineId: string | null }) => `${x.weekId}|${x.lineId}`;
    const snapKeys = new Set(snapInfo.map(keyOf));
    const liveKeys = new Set(liveInfo.map(keyOf));
    // EC 라인에 해당하는 live info 중 snapshot 에 없는 것
    const missingInSnap = liveInfo.filter((x) => x.weekId && ecWeekIds.has(x.weekId) && !snapKeys.has(keyOf(x)));
    const extraInSnap = snapInfo.filter((x) => x.weekId && ecWeekIds.has(x.weekId) && !liveKeys.has(keyOf(x)));
    const ver = verByUser.get(uid);
    const st = staleByUser.get(uid);
    const flag = missingInSnap.length || extraInSnap.length ? "  <<< GAP" : "";
    console.log(
      `  - ${uid.slice(0, 8)} snap=${snap.status}/v${ver}/stale=${st} liveInfo=${liveInfo.length} snapInfo=${snapInfo.length} ` +
      `EC주차_누락(live-only)=${missingInSnap.length} 잉여(snap-only)=${extraInSnap.length}${flag}`,
    );
    if (missingInSnap.length) {
      anyGap = true;
      for (const m of missingInSnap.slice(0, 4)) console.log(`        LIVE-only: wk=${m.weekId?.slice(0, 8)} code=${m.displayLineCode} "${(m.mainTitle ?? "").slice(0, 24)}" st=${m.status}`);
    }
  }
  console.log(`\n결론 단서: 표본에서 LIVE 에만 있고 SNAPSHOT 에 없는 EC-주차 info 라인 ${anyGap ? "발견(=고객 미반영 재현)" : "미발견"}`);
}

main().catch((e) => {
  console.error("ERR", e instanceof Error ? e.stack : e);
  process.exit(1);
});
