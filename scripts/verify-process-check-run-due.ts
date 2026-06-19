// run-due-checks 자동 검수 sweep 검증 — direct(lib) + HTTP(엔드포인트) 동등·멱등·실패정책·snapshot.
//   run: npx tsx --env-file=.env.local scripts/verify-process-check-run-due.ts
//   전제: admin(:3000) 기동 + process_point_awards.sql + process_check v2 적용 + INTERNAL_API_KEY.
//
//   crawl 은 결정적으로:
//     · direct 성공/실패 → crawlAndMatch 주입(가짜 매칭 / throw).
//     · HTTP 실패 → 비카페 URL 로 fetchCafeNicknames 가 invalid_url 즉시 반환(브라우저 미기동).
//     · HTTP 멱등 → 이미 completed 인 항목은 due 에서 제외 → 재적립 0(중복 적립 없음 실측).
//   적립은 W13(2026-spring) 테스트 예외 주차 + test 유저로만(운영/실유저 무접촉). cleanup 원복.
import { createClient } from "@supabase/supabase-js";
import { runDueProcessCheckSweep } from "@/lib/processCheckDueSweep";
import { accrueForCompletedRegular } from "@/lib/processPointAccrual";
import { readWeeklyCardsSnapshot, recomputeAndStoreWeeklyCardsSnapshot } from "@/lib/cluster4WeeklyCardsSnapshot";

const URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const KEY = process.env.INTERNAL_API_KEY;
const BASE = process.env.WORKER_BASE_URL ?? "http://localhost:3000";
const sb = createClient(URL, SERVICE, { auth: { persistSession: false } });
const J = (o: unknown) => JSON.stringify(o);
const TAG = "ZZ-rundue";
const PAST = "2020-01-01T00:00:00.000Z";
const ORG = "oranke";
const PER = 5;
let pass = 0, fail = 0;
const ck = (l: string, ok: boolean, d = "") => { console.log(`  ${ok ? "✓" : "✗"} ${l}${d ? ` — ${d}` : ""}`); ok ? pass++ : fail++; };

// 주입 crawl.
const matchUser = (userId: string) => async () => ({
  matched: [{ userId, nickname: `${TAG} 매칭닉`, reason: "test:match" }],
  review: [{ nickname: `${TAG} 수동닉`, reason: "형식 불명" }],
});
const throwCrawl = async () => { throw new Error("crawl boom"); };
const accrue = (_s: "regular" | "irregular", refId: string) => accrueForCompletedRegular(refId);

async function http(body: unknown, key = KEY) {
  const res = await fetch(`${BASE}/api/admin/processes/check/run-due-checks`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(key ? { "x-internal-api-key": key } : {}) },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json().catch(() => ({}))) as any };
}

async function cleanup() {
  const grp = (await sb.from("process_line_groups").select("id").like("name", `${TAG}%`)).data ?? [];
  const gIds = (grp as any[]).map((g) => g.id);
  if (gIds.length) {
    const acts = (await sb.from("process_acts").select("id").in("line_group_id", gIds)).data ?? [];
    const aIds = (acts as any[]).map((a) => a.id);
    if (aIds.length) {
      const sts = (await sb.from("process_check_statuses").select("id").in("act_id", aIds)).data ?? [];
      const sIds = (sts as any[]).map((s) => s.id);
      for (const sid of sIds) {
        await sb.from("process_check_review_recipients").delete().eq("ref_id", sid);
        await sb.from("process_point_awards").delete().eq("source", "regular").eq("ref_id", sid);
      }
      await sb.from("process_check_statuses").delete().in("act_id", aIds);
      await sb.from("process_acts").delete().in("id", aIds);
    }
    await sb.from("process_line_groups").delete().in("id", gIds);
  }
}

async function main() {
  if (!KEY) { console.log("⚠ INTERNAL_API_KEY 미설정(.env.local) — HTTP 검증 불가"); process.exit(2); }
  const probe = await sb.from("process_point_awards").select("id").limit(1);
  if (probe.error) { console.log(`⚠ process_point_awards 미적용(${probe.error.code})`); process.exit(2); }

  const markers = new Set(((await sb.from("test_user_markers").select("user_id")).data ?? []).map((x: any) => x.user_id));
  const oranke = ((await sb.from("user_profiles").select("user_id").eq("organization_slug", ORG)).data ?? []) as any[];
  const user = oranke.find((u) => markers.has(u.user_id))?.user_id;
  const realUser = oranke.find((u) => !markers.has(u.user_id))?.user_id;
  const week = (await sb.from("weeks").select("id,iso_year,iso_week,week_number,start_date").eq("season_key", "2026-spring").eq("week_number", 13).maybeSingle()).data as any;
  ck("[전제] test유저 · 실유저 · W13(2026-spring)", !!user && !!realUser && !!week?.id, J({ user: !!user, real: !!realUser, week: week?.id }));
  if (!user || !realUser || !week?.id) { console.log(`\n결과: ${pass} pass / ${fail} fail`); process.exit(2); }
  const iso = { y: week.iso_year as number, w: week.iso_week as number };
  const pointsOf = async () => ((await sb.from("user_weekly_points").select("points").eq("user_id", user).eq("year", iso.y).eq("week_number", iso.w).maybeSingle()).data as any)?.points ?? 0;

  // 원본 보존.
  const origRow = (await sb.from("user_weekly_points").select("id,points,advantages,penalty,checks_migrated").eq("user_id", user).eq("year", iso.y).eq("week_number", iso.w).maybeSingle()).data as any;

  await cleanup();

  // ── 시드: group + acts + statuses(전부 pending·info·W13·test·scheduled past) ──
  const grp = (await sb.from("process_line_groups").insert({ hub: "info", name: `${TAG} 라인급` }).select("id").single()).data as any;
  const mkAct = async (n: number) => (await sb.from("process_acts").insert({
    line_group_id: grp.id, hub: "info", act_name: `${TAG} 액트${n}`, duration_minutes: 10,
    occur_week: "N", occur_dow: 2, occur_time: "06:30", check_week: "N", check_dow: 3, check_time: "21:00",
    point_check: PER, point_advantage: 0, point_penalty: 0, cafe: "occur", check_target: "check", act_type: "required",
  }).select("id").single()).data as any;
  const mkStatus = async (actId: string, link: string) => (await sb.from("process_check_statuses").insert({
    organization_slug: ORG, hub: "info", week_id: week.id, line_group_id: grp.id, act_id: actId,
    status: "pending", review_link: link, scheduled_check_at: PAST, scope_mode: "test",
  }).select("id").single()).data as any;

  const aOk = await mkAct(1), aFhttp = await mkAct(2), aFdir = await mkAct(3), aMix = await mkAct(4);
  const s1 = (await mkStatus(aOk.id, "https://cafe.naver.com/x/1")).id;
  const sFhttp = (await mkStatus(aFhttp.id, "https://example.com/not-a-cafe")).id; // HTTP 실패(invalid_url)
  const sFdir = (await mkStatus(aFdir.id, "https://cafe.naver.com/x/3")).id;       // direct 실패(throw)
  const sMix = (await mkStatus(aMix.id, "https://cafe.naver.com/x/4")).id;         // 스코프 혼입
  ck("[시드] 상태행 4개(pending·info·W13·test)", !!s1 && !!sFhttp && !!sFdir && !!sMix);

  // ── 1) direct 성공 — 완료 + recipients + 적립 ──────────────────────────────
  const r1 = await runDueProcessCheckSweep({ onlyIds: [s1], modes: ["test"], crawlAndMatch: matchUser(user), accrue });
  ck("[1 direct 성공] succeeded=1 · outcome=completed · matched=1 · accrued=1",
    r1.succeeded === 1 && r1.failed === 0 && r1.items[0]?.outcome === "completed" &&
    (r1.items[0] as any).matched === 1 && (r1.items[0] as any).accrued === 1, J(r1.items[0]));
  const s1row = (await sb.from("process_check_statuses").select("status,completed_at,checked_crew_count,last_error").eq("id", s1).maybeSingle()).data as any;
  ck("[2 완료 전이] status=completed · completed_at · checked_crew_count=1 · last_error null",
    s1row?.status === "completed" && !!s1row?.completed_at && s1row?.checked_crew_count === 1 && !s1row?.last_error, J(s1row));
  const rec = (await sb.from("process_check_review_recipients").select("user_id,match_type").eq("source", "regular").eq("ref_id", s1)).data ?? [];
  ck("[3 recipients] matched(test유저)+review 저장",
    (rec as any[]).some((x) => x.match_type === "matched" && x.user_id === user) && (rec as any[]).some((x) => x.match_type === "review" && x.user_id === null), J((rec as any[]).map((x) => x.match_type)));
  const led = (await sb.from("process_point_awards").select("point_check").eq("source", "regular").eq("ref_id", s1)).data ?? [];
  ck("[4 ledger] 1행 · point_check=PER", led.length === 1 && (led as any[])[0]?.point_check === PER, J(led));
  ck("[5 user_weekly_points] points=PER", (await pointsOf()) === PER, `points=${await pointsOf()}/${PER}`);

  // ── 6) snapshot 영향(#8/#9) — 적립이 invalidate → 조회 시 lazy 재계산(hit). 별도 배치 불필요. ──
  const snap = await readWeeklyCardsSnapshot(user);
  ck("[6 snapshot] 적립 후 조회 시 재계산(hit) — 별도 batch 불필요", snap.status === "hit", `status=${snap.status}`);

  // ── 7) direct 멱등(#4) — 완료건 재처리 0 + 직접 재적립 2회 불변 ──────────────
  const r1b = await runDueProcessCheckSweep({ onlyIds: [s1], modes: ["test"], crawlAndMatch: matchUser(user), accrue });
  await accrueForCompletedRegular(s1); await accrueForCompletedRegular(s1);
  ck("[7 direct 멱등] 완료건 eligible 0 · 재적립 불변(points=PER)", r1b.eligible === 0 && (await pointsOf()) === PER, `eligible=${r1b.eligible} points=${await pointsOf()}`);

  // ── 8) HTTP 멱등(#4) — 완료된 s1 을 엔드포인트로 호출해도 due 제외 → 중복 적립 0 ──
  const h1 = await http({ onlyIds: [s1], modes: ["test"] });
  ck("[8 HTTP 멱등] 200 · 완료건 eligible 0 · points 불변(PER)", h1.status === 200 && h1.json?.success === true && h1.json?.data?.eligible === 0 && (await pointsOf()) === PER, `status=${h1.status} eligible=${h1.json?.data?.eligible} points=${await pointsOf()}`);

  // ── 9) HTTP 인증 — 키 없으면 401 ───────────────────────────────────────────
  const hNoKey = await http({ onlyIds: [s1] }, ""); // "" → 헤더 미부착(default param 회피)
  ck("[9 HTTP 인증] x-internal-api-key 없으면 401(실행 안 됨)", hNoKey.status === 401, `status=${hNoKey.status}`);
  const hBadKey = await http({ onlyIds: [s1] }, "wrong-key");
  ck("[9b HTTP 인증] 틀린 키 401", hBadKey.status === 401, `status=${hBadKey.status}`);

  // ── 10) HTTP 실패정책 — 비카페 URL(invalid_url) → failed · pending 유지 · attempt++ ──
  const hFail = await http({ onlyIds: [sFhttp], modes: ["test"] });
  const fhRow = (await sb.from("process_check_statuses").select("status,attempt_count,last_error").eq("id", sFhttp).maybeSingle()).data as any;
  ck("[10 HTTP 실패] failed=1 · outcome=failed · pending · attempt_count=1 · last_error",
    hFail.status === 200 && hFail.json?.data?.failed === 1 && hFail.json?.data?.items?.[0]?.outcome === "failed" &&
    fhRow?.status === "pending" && fhRow?.attempt_count === 1 && !!fhRow?.last_error, J({ http: hFail.json?.data?.items?.[0], row: fhRow }));

  // ── 11) direct 실패정책(#5) — throw → failed · pending · attempt++ ──────────
  const r3 = await runDueProcessCheckSweep({ onlyIds: [sFdir], modes: ["test"], crawlAndMatch: throwCrawl, accrue });
  const fdRow = (await sb.from("process_check_statuses").select("status,attempt_count,last_error").eq("id", sFdir).maybeSingle()).data as any;
  ck("[11 direct 실패] failed=1 · pending · attempt_count=1 · last_error(boom)",
    r3.failed === 1 && r3.succeeded === 0 && fdRow?.status === "pending" && fdRow?.attempt_count === 1 && /boom/.test(fdRow?.last_error ?? ""), J({ r3: r3.items[0], row: fdRow }));

  // ── 12) direct == HTTP(#3) — 실패 경로 관측 상태 동등 ───────────────────────
  const same =
    (hFail.json?.data?.items?.[0]?.outcome === r3.items[0]?.outcome) &&
    (fhRow?.status === fdRow?.status) && (fhRow?.attempt_count === fdRow?.attempt_count) &&
    (!!fhRow?.last_error === !!fdRow?.last_error);
  ck("[12 direct==HTTP] 실패 경로 상태 동등(outcome·status·attempt·last_error)", same,
    J({ http: { outcome: hFail.json?.data?.items?.[0]?.outcome, ...fhRow }, direct: { outcome: r3.items[0]?.outcome, ...fdRow } }));

  // ── 13) 스코프 혼입 가드 — test 상태에 실유저 매칭 주입 → 차단(미완료·ledger 0) ──
  const r4 = await runDueProcessCheckSweep({ onlyIds: [sMix], modes: ["test"], crawlAndMatch: matchUser(realUser), accrue });
  const mixRow = (await sb.from("process_check_statuses").select("status").eq("id", sMix).maybeSingle()).data as any;
  const mixLed = (await sb.from("process_point_awards").select("id", { count: "exact", head: true }).eq("source", "regular").eq("ref_id", sMix)).count ?? 0;
  ck("[13 스코프 가드] test에 실유저 매칭 → failed · pending · ledger 0",
    r4.failed === 1 && mixRow?.status === "pending" && mixLed === 0, J({ r4: r4.items[0], status: mixRow?.status, led: mixLed }));

  // ── 14) cleanup 원복 ───────────────────────────────────────────────────────
  await cleanup();
  await sb.from("process_point_awards").delete().eq("user_id", user).eq("year", iso.y).eq("week_number", iso.w);
  if (origRow) await sb.from("user_weekly_points").update({ points: origRow.points, advantages: origRow.advantages, penalty: origRow.penalty, checks_migrated: origRow.checks_migrated }).eq("id", origRow.id);
  else await sb.from("user_weekly_points").delete().eq("user_id", user).eq("year", iso.y).eq("week_number", iso.w);
  await recomputeAndStoreWeeklyCardsSnapshot(user);
  const { syncGradeStats } = await import("@/lib/cluster3ClubRankData");
  await syncGradeStats(user);
  const ledLeft = (await sb.from("process_point_awards").select("id", { count: "exact", head: true }).eq("user_id", user).eq("year", iso.y).eq("week_number", iso.w)).count ?? 0;
  ck("[14 cleanup] ledger 0 · user_weekly_points 원복", ledLeft === 0 && (await pointsOf()) === (origRow?.points ?? 0), `ledger=${ledLeft} points=${await pointsOf()}/${origRow?.points ?? "(none)"}`);

  console.log(`\n결과: ${pass} pass / ${fail} fail`);
  process.exit(fail ? 1 : 0);
}

main().catch(async (e) => { console.error("FATAL:", e?.stack ?? e); process.exit(1); });
