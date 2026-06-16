// 실무 역량 라인 개설 → 고객 weekly-cards 반영 검증 (결정적·저부하).
//   근본 원인: 역량 개설이 markWeeklyCardsSnapshotStaleMany(마크-스테일만) 를 써서, snapshot-only
//   조회 런타임에서 고객이 옛 snapshot 을 계속 봤다. info/experience 는 invalidateWeeklyCardsForUsers
//   (= 즉시/백그라운드 recompute) 라 개설 직후 반영된다. 수정: 역량도 invalidate 로 통일.
//
//   ① direct(live)            = getCluster4WeeklyCardsForProfileUser / recomputeAndStore 가 굽는 값
//   ② HTTP/고객(snapshot-only) = readWeeklyCardsSnapshot (실 /api/cluster4/weekly-cards 서빙값)
//
//   설계: 네트워크 일시 실패(이 개발 PC↔Supabase)로 무거운 계산이 흔들리므로, "한 번 계산해 저장한
//   값" 을 그 자신의 read 와 대조한다(교차-계산 드리프트 0 — recompute 는 계산한 cards 를 그대로
//   저장·반환하고 read 는 그 바이트를 돌려준다). 라인 생성 전/후 저장본의 차이로 "반영" 을 측정한다.
// 사용법: npx tsx --env-file=.env.local scripts/verify-competency-snapshot-reflect.ts
import { createClient } from "@supabase/supabase-js";
import {
  readWeeklyCardsSnapshot,
  recomputeAndStoreWeeklyCardsSnapshot,
  markWeeklyCardsSnapshotStaleMany,
  invalidateWeeklyCardsForUsers,
} from "../lib/cluster4WeeklyCardsSnapshot";
import { collectLineOrgAudience } from "../lib/adminCluster4LinesData";
import { resolveUserScope } from "../lib/userScope";

const sb = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

const WEEK_ID = "a2112b50-64d2-42d6-a243-faf9fcdc6ffc"; // 2026-spring W13(test 모드 역량 개설 대상)
const MASTER = "aa416631-3c6c-4139-ab44-84b2c410c133";

let pass = 0,
  fail = 0;
const check = (label: string, ok: boolean, detail = "") => {
  console.log(`  ${ok ? "✓" : "✗"} ${label}${detail ? ` — ${detail}` : ""}`);
  ok ? pass++ : fail++;
};
// 정규(키 정렬) JSON — JSONB 라운드트립이 키 순서를 바꿔도 의미 동일하면 같게 비교한다.
function canonical(v: any): any {
  if (Array.isArray(v)) return v.map(canonical);
  if (v && typeof v === "object") {
    const out: Record<string, any> = {};
    for (const k of Object.keys(v).sort()) out[k] = canonical(v[k]);
    return out;
  }
  return v;
}
const w13 = (cards: any[]): string =>
  JSON.stringify(canonical((cards ?? []).find((x) => x.weekId === WEEK_ID) ?? null));
const readW13 = async (u: string) => {
  const r = await readWeeklyCardsSnapshot(u);
  return { status: (r as any).status as string, json: w13((r as any).cards ?? []) };
};

async function pickPhalanxTestTarget(): Promise<string | null> {
  const { data: tgts } = await sb
    .from("cluster4_line_targets")
    .select("target_user_id,cluster4_lines!inner(part_type,is_active)")
    .eq("week_id", WEEK_ID)
    .eq("cluster4_lines.part_type", "competency")
    .eq("cluster4_lines.is_active", true);
  const cand = Array.from(
    new Set(((tgts ?? []) as any[]).map((r) => r.target_user_id).filter(Boolean)),
  );
  const scope = await resolveUserScope("test", "phalanx");
  for (const u of cand) {
    if (scope.filter([u]).length === 0) continue;
    const { data: p } = await sb
      .from("user_profiles")
      .select("organization_slug")
      .eq("user_id", u)
      .maybeSingle();
    if ((p as any)?.organization_slug === "phalanx") return u;
  }
  return null;
}
async function createTempLine(userId: string): Promise<string> {
  const { data: line, error } = await sb
    .from("cluster4_lines")
    .insert({
      part_type: "competency",
      line_code: `CPPX-VERIFY${Date.now()}`, // phalanx 토큰(PX)
      main_title: `__COMPVERIFY_${Date.now()}`,
      competency_line_master_id: MASTER,
      output_links: [{ url: "https://example.com", label: "verify" }],
      output_images: [],
      submission_opens_at: "2026-05-24T15:00:00+00:00",
      submission_closes_at: "2026-05-27T13:00:00+00:00",
      is_active: true,
    })
    .select("id")
    .single();
  if (error) throw new Error(error.message);
  const id = (line as { id: string }).id;
  const { error: tErr } = await sb.from("cluster4_line_targets").insert({
    line_id: id,
    week_id: WEEK_ID,
    target_mode: "user",
    target_user_id: userId,
    target_rule: {},
  });
  if (tErr) throw new Error(tErr.message);
  return id;
}
async function deleteLine(id: string) {
  await sb.from("cluster4_line_targets").delete().eq("line_id", id);
  await sb.from("cluster4_lines").delete().eq("id", id);
}
async function snapMeta(u: string) {
  const { data } = await sb
    .from("cluster4_weekly_card_snapshots")
    .select("is_stale,computed_at")
    .eq("user_id", u)
    .maybeSingle();
  return data as { is_stale: boolean; computed_at: string } | null;
}

async function main() {
  const U = await pickPhalanxTestTarget();
  if (!U) {
    console.log("phalanx test 타깃을 찾지 못함 — 중단");
    process.exit(1);
  }
  console.log(`\n대상 phalanx test 유저 U = ${U}`);

  let lineId: string | null = null;
  try {
    // ── Phase 0: 라인 생성 전 — 한 번 계산해 저장(cards0). read 가 그 값을 그대로 서빙하는지. ──
    const cards0 = w13(await recomputeAndStoreWeeklyCardsSnapshot(U));
    const s0 = await readW13(U);
    check("Phase0: snapshot(HTTP) == 방금 계산·저장한 direct (서빙 정합)",
      s0.json === cards0, `status=${s0.status}`);

    // ── Phase 1: 새 역량 라인 생성 + 옛(버그) 동작 markStale-only ──
    lineId = await createTempLine(U);
    await markWeeklyCardsSnapshotStaleMany([U]); // ← 옛 동작
    const sStale = await readW13(U);
    check("Phase1(버그 재현): markStale-only → 고객은 옛 snapshot(라인 미반영)",
      sStale.json === cards0, `status=${sStale.status}`);
    const mStale = await snapMeta(U);
    check("Phase1: markStale 후 is_stale=true (재계산 안 함)", mStale?.is_stale === true);

    // ── Phase 2: 새(수정) 동작 invalidateWeeklyCardsForUsers → 자동 recompute ──
    const before = await snapMeta(U);
    await invalidateWeeklyCardsForUsers([U]); // ← 수정 동작(≤10 즉시 recompute)
    const after = await snapMeta(U);
    const sFresh = await readW13(U);
    check("Phase2(수정): invalidate 후 is_stale=false (recompute 자동 실행)",
      after?.is_stale === false, `is_stale ${before?.is_stale}→${after?.is_stale}`);
    check("Phase2: computed_at 갱신(재계산 수행 증거)",
      Boolean(after && before && after.computed_at > before.computed_at),
      `${before?.computed_at} → ${after?.computed_at}`);
    check("Phase2: 새 역량 라인이 고객 snapshot 에 반영(옛값과 달라짐)",
      sFresh.json !== cards0, `status=${sFresh.status}`);

    // ── Phase 2b: 반영된 snapshot == 그 시점 direct(live) 저장본 (direct==HTTP) ──
    const cardsLive = w13(await recomputeAndStoreWeeklyCardsSnapshot(U));
    const sAfterLive = await readW13(U);
    check("Phase2b: snapshot(HTTP) == direct(live) 저장본 — 동일 DTO",
      sAfterLive.json === cardsLive);
    check("Phase2b: 그 direct 값도 라인 생성 전과 달라짐(개설이 DTO 를 바꿈 = 측정 유효)",
      cardsLive !== cards0);

    // ── Phase 3: org 격리 — phalanx(CPPX) 라인의 recompute audience 에 타 실org 누설 없음 ──
    //   collectLineOrgAudience 가 무효화/재계산 대상 산정의 단일 출처(route 의 scopeAffectedUsers 는
    //   여기에 test 모집단 필터를 더 좁힐 뿐 — 넓히지 않음). org 판정은 organization_slug 로(테스트
    //   스코프는 org-agnostic 이라 부적합). phalanx 라인은 phalanx + org-null(미상=항상 노출)만 허용.
    const audience = await collectLineOrgAudience(lineId);
    let otherRealOrg: string[] = [];
    let phalanxCnt = 0,
      nullCnt = 0;
    if (audience.length) {
      const { data: profs } = await sb
        .from("user_profiles")
        .select("user_id,organization_slug")
        .in("user_id", audience);
      const orgById = new Map((profs ?? []).map((p: any) => [p.user_id, p.organization_slug]));
      for (const u of audience) {
        const o = orgById.get(u) ?? null;
        if (o === "phalanx") phalanxCnt++;
        else if (o == null) nullCnt++;
        else otherRealOrg.push(o);
      }
    }
    check("Phase3: CPPX(phalanx) 라인 audience 에 다른 실조직(encre/oranke) 0 — 누설 없음",
      otherRealOrg.length === 0,
      `audience=${audience.length} (phalanx=${phalanxCnt}, org-null=${nullCnt}, 타실org=${otherRealOrg.length})`);
    check("Phase3: audience 는 phalanx 소속 중심(개설 org 격리 성립)", phalanxCnt > 0);

    // ── Phase 4: 고객 조회는 mode 인자 없는 단일 snapshot 경로(operating==test==demoUserId) ──
    const a = await readWeeklyCardsSnapshot(U);
    const b = await readWeeklyCardsSnapshot(U);
    check("Phase4: readWeeklyCardsSnapshot 단일 DTO 경로(mode 무관·반복 동일)",
      JSON.stringify((a as any).cards) === JSON.stringify((b as any).cards));
  } finally {
    if (lineId) {
      await deleteLine(lineId);
      await recomputeAndStoreWeeklyCardsSnapshot(U); // 원복(fresh)
      console.log("\n[cleanup] 임시 라인 삭제 + U snapshot 재계산 완료");
    }
  }

  console.log(`\n결과: pass=${pass} fail=${fail}`);
  if (fail > 0) process.exitCode = 1;
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
