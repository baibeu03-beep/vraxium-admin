/**
 * [DB 직결] 라인 마감 자동 지급 스윕 — 4허브 공통 정책(2026-07-30 리팩터) 검증.
 *
 *   npx tsx --env-file=.env.local scripts/verify-line-close-sweep-hub-unified.ts
 *
 * 배경: 예전엔 자동 마감 스윕(cluster4LineCloseDueSweep) 대상 허브가 info/competency 뿐이었다.
 *   experience/career 는 "평점 입력 시점에 이미 지급됐을 것"이라는 전제로 제외돼 있었는데, 실제로는
 *   평점이 마감 **전**에 입력되는 경우가 많아 그 시점 reconcile 이 정확히 pending 판정을 내리고
 *   지급을 보류한 뒤, 마감이 지나도 재확인하는 장치가 없어 지급이 영구 누락됐다(2026-summer W4
 *   experience 실사례). 이번 리팩터로 SWEEP_HUBS 를 4허브로 넓히고, 지급 판정을 전부
 *   computeCluster4Enhancement() 결과(카드의 line.enhancementStatus) 하나로 통일했다.
 *
 * ⚠ 쓰기 범위 — **QA 테스트 라인(cluster4_lines.is_qa_test=true)** 의 기존 (user, line) 조합만
 *   건드린다. runDueLineCloseSweep({ onlyLineIds }) 를 실제 프로덕션 함수 그대로 호출한다(별도
 *   재구현 없음). 운영 라인/실사용자 데이터는 어떤 경로로도 건드리지 않는다.
 *
 * 검증:
 *   ① 정보(info): 마감 후 자동 지급(source='line' 원장 활성화)
 *   ② 역량(competency): 마감 후 자동 지급
 *   ③ 경험(experience) 평점 7(≥4): 마감 후 강화 시 포인트 + 평점 Point A 둘 다 자동 지급
 *   ④ 경험(experience) 평점 3(<4): 마감이 지나도 지급되지 않음(강화 실패 — 조기 확정 정책)
 *   ⑤ 위 4건 전부 — 스윕을 2회 연속 호출해도 원장 값이 바뀌지 않음(멱등 · 중복 지급 없음)
 *   ⑥ finalizeLineResultAwards 가 4허브 어디서도 hub 별 success 조건을 다시 계산하지 않고
 *      카드(computeCluster4Enhancement 결과)를 그대로 따르는지 — 코드 정적 확인은 리뷰로 별도 확인,
 *      여기서는 실제 지급 결과가 카드 enhancementStatus 와 100% 일치하는지로 간접 검증한다.
 */
/* eslint-disable @typescript-eslint/no-explicit-any -- 검증 스크립트: 원장 raw row 를 훑는다. */
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { runDueLineCloseSweep } from "@/lib/cluster4LineCloseDueSweep";
import { resolveCrewWeekCard } from "@/lib/adminCrewWeekDetail";

let failed = 0;
const ck = (n: string, ok: boolean, d?: unknown) => {
  console.log(`${ok ? "✅" : "❌"} ${n}${d !== undefined ? " :: " + JSON.stringify(d) : ""}`);
  if (!ok) failed++;
};

type Fixture = {
  label: string;
  lineId: string;
  userId: string;
  weekId: string;
  expectPaid: boolean; // source='line' 원장이 활성화돼야 하는가
  expectRatingPaid?: boolean; // source='line_rating' 원장도 활성화돼야 하는가(experience 만)
};

async function ledger(userId: string, lineId: string) {
  const { data } = await supabaseAdmin
    .from("process_point_awards")
    .select("source,point_check,point_advantage,point_penalty,cancelled_at,updated_at")
    .eq("user_id", userId)
    .eq("ref_id", lineId)
    .in("source", ["line", "line_rating"]);
  const rows = (data ?? []) as any[];
  const line = rows.find((r) => r.source === "line") ?? null;
  const rating = rows.find((r) => r.source === "line_rating") ?? null;
  return {
    linePaid: line != null && line.cancelled_at == null,
    lineA: line?.point_check ?? null,
    lineB: line?.point_advantage ?? null,
    ratingPaid: rating != null && rating.cancelled_at == null,
    ratingA: rating?.point_check ?? null,
    raw: { line, rating },
  };
}

async function verifyLineMatchesCard(userId: string, weekId: string, lineId: string) {
  const resolved = await resolveCrewWeekCard(userId, weekId);
  if (!resolved.ok) return null;
  return resolved.card.lines.find((l) => l.lineId === lineId) ?? null;
}

async function findFixtures(): Promise<Fixture[]> {
  const fixtures: Fixture[] = [];

  // ── info: 임의의 QA info 대상 1건 ──
  {
    const { data: lines } = await supabaseAdmin
      .from("cluster4_lines")
      .select("id,submission_closes_at")
      .eq("part_type", "info")
      .eq("is_qa_test", true)
      .eq("is_active", true);
    const lineIds = ((lines ?? []) as any[]).map((l) => l.id);
    const { data: tgts } = await supabaseAdmin
      .from("cluster4_line_targets")
      .select("id,line_id,week_id,target_user_id")
      .in("line_id", lineIds)
      .eq("target_mode", "user")
      .not("target_user_id", "is", null)
      .limit(1);
    const t = ((tgts ?? []) as any[])[0];
    if (t) {
      fixtures.push({
        label: "info",
        lineId: t.line_id,
        userId: t.target_user_id,
        weekId: t.week_id,
        expectPaid: true,
      });
    }
  }

  // ── competency: 임의의 QA competency 대상 1건 ──
  {
    const { data: lines } = await supabaseAdmin
      .from("cluster4_lines")
      .select("id")
      .eq("part_type", "competency")
      .eq("is_qa_test", true)
      .eq("is_active", true);
    const lineIds = ((lines ?? []) as any[]).map((l) => l.id);
    const { data: tgts } = await supabaseAdmin
      .from("cluster4_line_targets")
      .select("id,line_id,week_id,target_user_id")
      .in("line_id", lineIds)
      .eq("target_mode", "user")
      .not("target_user_id", "is", null)
      .limit(1);
    const t = ((tgts ?? []) as any[])[0];
    if (t) {
      fixtures.push({
        label: "competency",
        lineId: t.line_id,
        userId: t.target_user_id,
        weekId: t.week_id,
        expectPaid: true,
      });
    }
  }

  // ── experience: 평점 >=4(지급) / <4(미지급) 각 1건 ──
  {
    const { data: lines } = await supabaseAdmin
      .from("cluster4_lines")
      .select("id")
      .eq("part_type", "experience")
      .eq("is_qa_test", true)
      .eq("is_active", true);
    const lineIds = ((lines ?? []) as any[]).map((l) => l.id);
    const { data: tgts } = await supabaseAdmin
      .from("cluster4_line_targets")
      .select("id,line_id,week_id,target_user_id")
      .in("line_id", lineIds)
      .eq("target_mode", "user")
      .not("target_user_id", "is", null);
    const targets = (tgts ?? []) as any[];
    const { data: evs } = await supabaseAdmin
      .from("cluster4_experience_line_evaluations")
      .select("line_target_id,user_id,rating,evaluated_by")
      .in("line_target_id", targets.map((t) => t.id));
    const evByTarget = new Map(((evs ?? []) as any[]).map((e) => [e.line_target_id, e]));

    const high = targets.find((t) => {
      const e = evByTarget.get(t.id);
      return e && e.evaluated_by != null && (e.rating ?? 0) >= 4;
    });
    const low = targets.find((t) => {
      const e = evByTarget.get(t.id);
      return e && e.evaluated_by != null && (e.rating ?? 0) >= 1 && (e.rating ?? 0) <= 3;
    });

    if (high) {
      const e = evByTarget.get(high.id)!;
      fixtures.push({
        label: `experience(rating=${e.rating}, 지급 대상)`,
        lineId: high.line_id,
        userId: high.target_user_id,
        weekId: high.week_id,
        expectPaid: true,
        expectRatingPaid: true,
      });
    }
    if (low) {
      const e = evByTarget.get(low.id)!;
      fixtures.push({
        label: `experience(rating=${e.rating}, 미지급 대상)`,
        lineId: low.line_id,
        userId: low.target_user_id,
        weekId: low.week_id,
        expectPaid: false,
        expectRatingPaid: false,
      });
    }
  }

  return fixtures;
}

async function main() {
  const fixtures = await findFixtures();
  if (fixtures.length === 0) {
    console.log("⚠ 검증 가능한 QA 픽스처가 없어 종료합니다(무해).");
    process.exit(0);
  }

  console.log(`픽스처 ${fixtures.length}건 확보\n`);
  for (const f of fixtures) {
    console.log(`  - ${f.label}: line=${f.lineId.slice(0, 8)} user=${f.userId.slice(0, 8)} week=${f.weekId.slice(0, 8)}`);
  }
  console.log("");

  // ── 안전 가드: 전부 QA 라인인지 재확인(운영 라인 오염 방지) ──
  for (const f of fixtures) {
    const { data: lineRow } = await supabaseAdmin
      .from("cluster4_lines")
      .select("is_qa_test")
      .eq("id", f.lineId)
      .maybeSingle();
    ck(`${f.label} — is_qa_test=true 확인(운영 라인 아님)`, (lineRow as any)?.is_qa_test === true);
  }

  const before = new Map<string, Awaited<ReturnType<typeof ledger>>>();
  for (const f of fixtures) before.set(f.lineId, await ledger(f.userId, f.lineId));

  // ── 1차 스윕 실행 — 실제 프로덕션 함수(runDueLineCloseSweep) 그대로 호출 ──
  console.log("── 1차 스윕 실행 ──");
  const sweep1 = await runDueLineCloseSweep({ onlyLineIds: fixtures.map((f) => f.lineId) });
  console.log(`found=${sweep1.found} processed=${sweep1.processed}\n`);
  ck("1차 스윕 — 지정한 라인 전부 처리됨", sweep1.processed === fixtures.length, {
    expected: fixtures.length,
    processed: sweep1.processed,
  });

  const after1 = new Map<string, Awaited<ReturnType<typeof ledger>>>();
  for (const f of fixtures) after1.set(f.lineId, await ledger(f.userId, f.lineId));

  for (const f of fixtures) {
    const a = after1.get(f.lineId)!;
    const card = await verifyLineMatchesCard(f.userId, f.weekId, f.lineId);

    ck(`${f.label} — 강화 시 포인트(source='line') 지급 상태 = expectPaid(${f.expectPaid})`, a.linePaid === f.expectPaid, {
      expected: f.expectPaid,
      actual: a.linePaid,
      lineA: a.lineA,
      lineB: a.lineB,
    });

    if (f.expectRatingPaid !== undefined) {
      ck(`${f.label} — 평점 Point A(source='line_rating') 지급 상태 = expectRatingPaid(${f.expectRatingPaid})`, a.ratingPaid === f.expectRatingPaid, {
        expected: f.expectRatingPaid,
        actual: a.ratingPaid,
        ratingA: a.ratingA,
      });
    }

    ck(`${f.label} — 지급 결과가 카드 enhancementStatus 와 일치(허브별 재계산 없음 간접 증거)`, card != null && (a.linePaid === (card.enhancementStatus === "success")), {
      cardStatus: card?.enhancementStatus ?? null,
      linePaid: a.linePaid,
    });
  }

  // ── 2차 스윕 실행 — 멱등성(중복 지급 없음) ──
  console.log("\n── 2차 스윕 실행(멱등성 확인) ──");
  const sweep2 = await runDueLineCloseSweep({ onlyLineIds: fixtures.map((f) => f.lineId) });
  console.log(`found=${sweep2.found} processed=${sweep2.processed}\n`);

  const after2 = new Map<string, Awaited<ReturnType<typeof ledger>>>();
  for (const f of fixtures) after2.set(f.lineId, await ledger(f.userId, f.lineId));

  for (const f of fixtures) {
    const a1 = after1.get(f.lineId)!;
    const a2 = after2.get(f.lineId)!;
    ck(`${f.label} — 2회 연속 스윕 후 원장 값 불변(중복 지급 없음)`, JSON.stringify({ lineA: a1.lineA, lineB: a1.lineB, ratingA: a1.ratingA, linePaid: a1.linePaid, ratingPaid: a1.ratingPaid }) ===
      JSON.stringify({ lineA: a2.lineA, lineB: a2.lineB, ratingA: a2.ratingA, linePaid: a2.linePaid, ratingPaid: a2.ratingPaid }), {
      first: { lineA: a1.lineA, ratingA: a1.ratingA },
      second: { lineA: a2.lineA, ratingA: a2.ratingA },
    });

    // process_point_awards 행 자체가 늘어나지 않았는지(소스별 최대 1행) 직접 확인.
    const { count } = await supabaseAdmin
      .from("process_point_awards")
      .select("id", { count: "exact", head: true })
      .eq("user_id", f.userId)
      .eq("ref_id", f.lineId)
      .eq("source", "line");
    ck(`${f.label} — source='line' 원장 행 수 <= 1(중복 행 생성 없음)`, (count ?? 0) <= 1, { count });
  }

  console.log(failed === 0 ? "\nALL PASS" : `\n${failed} FAIL`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
