// 댓글 수집 상태 sweep 검증 — 주입 mock crawl 로 4개 시나리오의 DB 각인을 결정적으로 확인.
//   run: npx tsx --env-file=.env.local scripts/verify-comment-collection-sweep.ts
//   전제: process_check v2 + worker + 2026-07-19_process_check_comment_collection.sql 적용 · W13(2026-spring).
//
//   시나리오(요구):
//     1) 실제 댓글 0개  → success · raw_comment_count=0        (조회 '댓글 없음')
//     2) 댓글 있음·매칭0 → success · raw_comment_count>0 · 매칭0 (조회 '매칭 사용자 없음', 오류 아님)
//     3) 크롤 오류      → error · error_code · pending 유지 · raw 미기록 (조회 '일시 오류')
//     4) 재수집 실패    → 이전 정상 수집(raw=12·recipients)을 0 으로 덮어쓰지 않음(status만 error)
//   적립은 하지 않는다(accrue=null) — user_weekly_points/snapshot 무접촉. cleanup 원복.

import { createClient } from "@supabase/supabase-js";
import { runDueProcessCheckSweep, CommentCollectionError } from "@/lib/processCheckDueSweep";
import { deriveCommentCollectionStatus } from "@/lib/adminProcessCheckTypes";

const URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const sb = createClient(URL, SERVICE, { auth: { persistSession: false } });
const J = (o: unknown) => JSON.stringify(o);
const TAG = "ZZ-collect";
const PAST = "2020-01-01T00:00:00.000Z";
const ORG = "oranke";
let pass = 0,
  fail = 0;
const ck = (l: string, ok: boolean, d = "") => {
  console.log(`  ${ok ? "✓" : "✗"} ${l}${d ? ` — ${d}` : ""}`);
  if (ok) pass++;
  else fail++;
};

// 주입 crawl — rawCommentCount 를 명시해 "정상 0 vs 오류 0" 를 결정적으로 만든다.
const crawlEmpty = async () => ({ matched: [], review: [], rawCommentCount: 0 });
const crawlNoMatch = async () => ({
  matched: [],
  review: [{ nickname: `${TAG} 미매칭닉`, reason: "형식 불명" }],
  rawCommentCount: 7,
});
const crawlMatch = (userId: string) => async () => ({
  matched: [{ userId, nickname: `${TAG} 매칭닉`, reason: "test:match" }],
  review: [{ nickname: `${TAG} 수동닉`, reason: "형식 불명" }],
  rawCommentCount: 12,
});
const crawlBoom = async () => {
  throw new CommentCollectionError("crawl_failed", "boom(주입 크롤 실패)");
};

async function cleanup() {
  const grp = (await sb.from("process_line_groups").select("id").like("name", `${TAG}%`)).data ?? [];
  const gIds = (grp as { id: string }[]).map((g) => g.id);
  if (!gIds.length) return;
  const acts = (await sb.from("process_acts").select("id").in("line_group_id", gIds)).data ?? [];
  const aIds = (acts as { id: string }[]).map((a) => a.id);
  if (aIds.length) {
    const sts = (await sb.from("process_check_statuses").select("id").in("act_id", aIds)).data ?? [];
    for (const s of sts as { id: string }[]) {
      await sb.from("process_check_review_recipients").delete().eq("ref_id", s.id);
      await sb.from("process_point_awards").delete().eq("source", "regular").eq("ref_id", s.id);
    }
    await sb.from("process_check_logs").delete().in("act_id", aIds);
    await sb.from("process_check_statuses").delete().in("act_id", aIds);
    await sb.from("process_acts").delete().in("id", aIds);
  }
  await sb.from("process_line_groups").delete().in("id", gIds);
}

async function main() {
  // 전제: 신규 수집 컬럼 적용 여부.
  const probe = await sb.from("process_check_statuses").select("comment_collection_status").limit(1);
  if (probe.error) {
    console.log(`⚠ 댓글 수집 컬럼 미적용(${probe.error.code}) — 2026-07-19_process_check_comment_collection.sql 적용 필요`);
    process.exit(2);
  }
  const markers = new Set(
    ((await sb.from("test_user_markers").select("user_id")).data ?? []).map((x: { user_id: string }) => x.user_id),
  );
  const oranke = ((await sb.from("user_profiles").select("user_id").eq("organization_slug", ORG)).data ?? []) as {
    user_id: string;
  }[];
  const user = oranke.find((u) => markers.has(u.user_id))?.user_id;
  const week = (
    await sb.from("weeks").select("id").eq("season_key", "2026-spring").eq("week_number", 13).maybeSingle()
  ).data as { id: string } | null;
  ck("[전제] test유저 · W13(2026-spring)", !!user && !!week?.id, J({ user: !!user, week: week?.id }));
  if (!user || !week?.id) {
    console.log(`\n결과: ${pass} pass / ${fail} fail`);
    process.exit(2);
  }

  await cleanup();

  const grp = (await sb.from("process_line_groups").insert({ hub: "info", name: `${TAG} 라인급` }).select("id").single())
    .data as { id: string };
  const mkAct = async (n: number) =>
    (
      await sb
        .from("process_acts")
        .insert({
          line_group_id: grp.id,
          hub: "info",
          act_name: `${TAG} 액트${n}`,
          duration_minutes: 10,
          occur_week: "N",
          occur_dow: 2,
          occur_time: "06:30",
          check_week: "N",
          check_dow: 3,
          check_time: "21:00",
          point_check: 5,
          point_advantage: 0,
          point_penalty: 0,
          cafe: "occur",
          check_target: "check",
          act_type: "required",
        })
        .select("id")
        .single()
    ).data as { id: string };
  const mkStatus = async (actId: string, link: string) =>
    (
      await sb
        .from("process_check_statuses")
        .insert({
          organization_slug: ORG,
          hub: "info",
          week_id: week.id,
          line_group_id: grp.id,
          act_id: actId,
          status: "pending",
          review_link: link,
          scheduled_check_at: PAST,
          scope_mode: "test",
        })
        .select("id")
        .single()
    ).data as { id: string };

  const a1 = await mkAct(1),
    a2 = await mkAct(2),
    a3 = await mkAct(3),
    a4 = await mkAct(4);
  const s1 = (await mkStatus(a1.id, "https://cafe.naver.com/x/1")).id; // 실제 0개
  const s2 = (await mkStatus(a2.id, "https://cafe.naver.com/x/2")).id; // 댓글 있음·매칭 0
  const s3 = (await mkStatus(a3.id, "https://cafe.naver.com/x/3")).id; // 크롤 오류
  const s4 = (await mkStatus(a4.id, "https://cafe.naver.com/x/4")).id; // 재수집 비덮어쓰기
  ck("[시드] 상태행 4개(pending·info·W13·test)", !!s1 && !!s2 && !!s3 && !!s4);

  const sel = "status,raw_comment_count,comment_collection_status,comment_collection_error_code,checked_crew_count";
  const row = async (id: string) =>
    (await sb.from("process_check_statuses").select(sel).eq("id", id).maybeSingle()).data as {
      status: string;
      raw_comment_count: number | null;
      comment_collection_status: string | null;
      comment_collection_error_code: string | null;
      checked_crew_count: number | null;
    } | null;
  const matchedOf = async (id: string) =>
    (
      await sb
        .from("process_check_review_recipients")
        .select("id", { count: "exact", head: true })
        .eq("source", "regular")
        .eq("ref_id", id)
        .eq("match_type", "matched")
    ).count ?? 0;

  // ── 1) 실제 댓글 0개 → success · raw=0 → '댓글 없음' ──
  await runDueProcessCheckSweep({ onlyIds: [s1], modes: ["test"], crawlAndMatch: crawlEmpty, accrue: null });
  const r1 = await row(s1);
  ck(
    "[1 실제0개] completed · status=success · raw=0 · error_code null",
    r1?.status === "completed" && r1?.comment_collection_status === "success" && r1?.raw_comment_count === 0 && !r1?.comment_collection_error_code,
    J(r1),
  );
  ck(
    "[1 파생] collectionKind = collected_no_comments",
    deriveCommentCollectionStatus({ status: "completed", collectionStatus: "success", rawCommentCount: r1?.raw_comment_count ?? null, matchedCount: 0 }) ===
      "collected_no_comments",
  );

  // ── 2) 댓글 있음·매칭 0 → success · raw>0 · 매칭0 → '매칭 사용자 없음' ──
  await runDueProcessCheckSweep({ onlyIds: [s2], modes: ["test"], crawlAndMatch: crawlNoMatch, accrue: null });
  const r2 = await row(s2);
  ck(
    "[2 매칭0] completed · status=success · raw=7 · checked_crew_count=0",
    r2?.status === "completed" && r2?.comment_collection_status === "success" && r2?.raw_comment_count === 7 && r2?.checked_crew_count === 0,
    J(r2),
  );
  ck(
    "[2 파생] collectionKind = collected_no_match (오류 아님)",
    deriveCommentCollectionStatus({ status: "completed", collectionStatus: "success", rawCommentCount: 7, matchedCount: await matchedOf(s2) }) ===
      "collected_no_match",
  );

  // ── 3) 크롤 오류 → error · error_code · pending 유지 · raw 미기록 → '일시 오류' ──
  const r3sweep = await runDueProcessCheckSweep({ onlyIds: [s3], modes: ["test"], crawlAndMatch: crawlBoom, accrue: null });
  const r3 = await row(s3);
  ck(
    "[3 크롤오류] pending 유지 · status=error · error_code=crawl_failed · raw null",
    r3?.status === "pending" && r3?.comment_collection_status === "error" && r3?.comment_collection_error_code === "crawl_failed" && r3?.raw_comment_count == null,
    J(r3),
  );
  ck(
    "[3 sweep item] outcome=failed · isCollectionError=true",
    r3sweep.items[0]?.outcome === "failed" && (r3sweep.items[0] as { isCollectionError?: boolean }).isCollectionError === true,
    J(r3sweep.items[0]),
  );
  ck(
    "[3 파생] collectionKind = error",
    deriveCommentCollectionStatus({ status: "pending", collectionStatus: "error", rawCommentCount: null, matchedCount: 0 }) === "error",
  );

  // ── 4) 재수집 실패 비덮어쓰기 — 먼저 정상 수집(raw=12·매칭1) → completed, 그 뒤 pending 으로 되돌린 상태에서
  //        크롤 실패 재수집 → raw_comment_count·recipients 보존 · status만 error ──
  await runDueProcessCheckSweep({ onlyIds: [s4], modes: ["test"], crawlAndMatch: crawlMatch(user), accrue: null });
  const r4a = await row(s4);
  const m4a = await matchedOf(s4);
  ck("[4a 정상수집] completed · raw=12 · matched=1", r4a?.raw_comment_count === 12 && m4a === 1 && r4a?.status === "completed", J({ r4a, m4a }));
  // 재수집 가능 상태로 되돌림(raw/recipients 는 그대로 둔 채 status만 pending).
  await sb.from("process_check_statuses").update({ status: "pending" }).eq("id", s4);
  // ⚠ recollect 엔드포인트와 동일 경로: ignoreSchedule+ignoreRetryGate 로 그 행을 즉시 재수집한다
  //   (미지정 시 4a 성공 직후 쿨다운 게이트에 걸려 sweep 이 그 행을 건너뛴다 → 재수집 미실행).
  await runDueProcessCheckSweep({
    onlyIds: [s4],
    modes: ["test"],
    crawlAndMatch: crawlBoom,
    accrue: null,
    ignoreSchedule: true,
    ignoreRetryGate: true,
  });
  const r4b = await row(s4);
  const m4b = await matchedOf(s4);
  ck(
    "[4b 재수집 실패] raw=12 보존(0 덮어쓰기 없음) · recipients matched=1 보존 · status=error",
    r4b?.raw_comment_count === 12 && m4b === 1 && r4b?.comment_collection_status === "error",
    J({ r4b, m4b }),
  );

  await cleanup();
  console.log(`\n결과: ${pass} pass / ${fail} fail`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => {
  console.error("FATAL:", e?.stack ?? e);
  process.exit(1);
});
