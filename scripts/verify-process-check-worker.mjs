// 프로세스 체크 자동 검수 worker 검증 — runOnce(주입 crawl)로 정규/변동 처리.
//   due 선택 · 크루 식별 저장 · 완료 전이 · 재시도/쿨다운 · 밀린작업(catch-up) · org/mode 스코프 ·
//   고객앱/snapshot 무영향(user_weekly_points 불변). 실제 네이버 크롤링 없이 결정적 검증.
// 전제: 2026-06-15_process_irregular_acts.sql + _process_check_worker.sql 적용.
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
const __dirname = dirname(fileURLToPath(import.meta.url));
const adminRoot = resolve(__dirname, "..");
const req = createRequire(resolve(adminRoot, "package.json"));
const { createClient } = req("@supabase/supabase-js");
const env = readFileSync(resolve(adminRoot, ".env.local"), "utf8");
const get = (k) => env.match(new RegExp(`^${k}=(.+)$`, "m"))?.[1]?.trim();
const sb = createClient(get("NEXT_PUBLIC_SUPABASE_URL"), get("SUPABASE_SERVICE_ROLE_KEY"));
const ORG = "oranke", TAG = "ZZ-irr-worker";
const J = (o) => JSON.stringify(o);

const { runOnce } = await import("./process-check-worker.mjs");

let pass = 0, fail = 0; const ck = (l, ok, d = "") => { console.log(`  ${ok ? "✓" : "✗"} ${l}${d ? ` — ${d}` : ""}`); ok ? pass++ : fail++; };

async function cleanup() {
  const irr = (await sb.from("process_irregular_acts").select("id").like("act_name", `${TAG}%`)).data ?? [];
  const grp = (await sb.from("process_line_groups").select("id").like("name", `${TAG}%`)).data ?? [];
  const grpIds = grp.map((g) => g.id);
  const acts = grpIds.length ? ((await sb.from("process_acts").select("id").in("line_group_id", grpIds)).data ?? []) : [];
  const actIds = acts.map((a) => a.id);
  const statusIds = actIds.length ? ((await sb.from("process_check_statuses").select("id").in("act_id", actIds)).data ?? []).map((s) => s.id) : [];
  const refIds = [...irr.map((x) => x.id), ...statusIds];
  if (refIds.length) await sb.from("process_check_review_recipients").delete().in("ref_id", refIds);
  if (irr.length) await sb.from("process_irregular_acts").delete().in("id", irr.map((x) => x.id));
  if (statusIds.length) await sb.from("process_check_statuses").delete().in("id", statusIds);
  if (actIds.length) await sb.from("process_acts").delete().in("id", actIds);
  if (grpIds.length) await sb.from("process_line_groups").delete().in("id", grpIds);
}

try {
  const probe = await sb.from("process_check_review_recipients").select("id").limit(1);
  if (probe.error) { console.log(`⚠ 마이그레이션 미적용(${probe.error.code}) — _process_check_worker.sql 적용 후 재실행`); process.exit(2); }
  const sm = await sb.from("process_irregular_acts").select("scope_mode").limit(1);
  if (sm.error) { console.log(`⚠ scope_mode 컬럼 없음(${sm.error.code})`); process.exit(2); }

  await cleanup();

  // 전제 데이터.
  const markers = new Set(((await sb.from("test_user_markers").select("user_id")).data ?? []).map((x) => x.user_id));
  const opUser = ((await sb.from("user_profiles").select("user_id").eq("organization_slug", ORG)).data ?? []).find((u) => !markers.has(u.user_id));
  const week = (await sb.from("weeks").select("id").order("start_date", { ascending: false }).limit(1).maybeSingle()).data;
  ck("[전제] oranke 운영 유저 + weeks 존재", !!opUser && !!week?.id);
  const pastIso = new Date(Date.now() - 3600_000).toISOString();
  const futureIso = new Date(Date.now() + 3600_000).toISOString();

  // ── 시드: 변동 review_request (만기 pending) ──
  const irr = (await sb.from("process_irregular_acts").insert({
    organization_slug: ORG, week_id: week.id, kind: "review_request", act_name: `${TAG} 변동만기`,
    applicant_admin_name: "검증", scope_mode: "operating", point_a: 3, point_b: 1, point_c: 0,
    crew_reaction: "partial", review_link: "https://cafe.naver.com/x/1", scheduled_check_at: pastIso, status: "pending",
  }).select("id").single()).data;
  // 미만기(future) 변동 — due 아님.
  const irrFuture = (await sb.from("process_irregular_acts").insert({
    organization_slug: ORG, week_id: week.id, kind: "review_request", act_name: `${TAG} 변동미만기`,
    applicant_admin_name: "검증", scope_mode: "operating", review_link: "https://cafe.naver.com/x/2",
    scheduled_check_at: futureIso, status: "pending",
  }).select("id").single()).data;

  // ── 시드: 정규 process_check_statuses (만기 pending) ──
  const grp = (await sb.from("process_line_groups").insert({ hub: "info", name: `${TAG} 라인급` }).select("id").single()).data;
  const act = (await sb.from("process_acts").insert({
    line_group_id: grp.id, hub: "info", act_name: `${TAG} 액트`, duration_minutes: 10,
    occur_week: "N", occur_dow: 2, occur_time: "06:30", check_week: "N", check_dow: 3, check_time: "21:00",
    point_check: 1, point_advantage: 0, point_penalty: 0, cafe: "occur", check_target: "check", act_type: "required",
  }).select("id").single()).data;
  const reg = (await sb.from("process_check_statuses").insert({
    organization_slug: ORG, hub: "info", week_id: week.id, line_group_id: grp.id, act_id: act.id,
    status: "pending", review_link: "https://cafe.naver.com/x/3", scheduled_check_at: pastIso, scope_mode: "operating",
  }).select("id").single()).data;
  ck("[시드] 변동(만기/미만기) + 정규 만기 행 생성", !!irr?.id && !!irrFuture?.id && !!reg?.id);
  // ⚠ 실데이터 보호 — 이 검증은 자기 시드 행만 처리하도록 onlyIds 화이트리스트로 한정한다.
  const myIds = [irr.id, irrFuture.id, reg.id, /* 실패행은 아래서 추가 */];

  // 주입 crawl — 결정적(매칭 1명=opUser + review 1명).
  const fakeCrawl = async () => ({
    matched: [{ userId: opUser.user_id, nickname: `${TAG} 매칭닉`, reason: "test:match" }],
    review: [{ nickname: `${TAG} 수동닉`, reason: "형식 불명" }],
  });

  // 고객앱 무영향 — 처리 전 user_weekly_points 카운트.
  const uwpBefore = (await sb.from("user_weekly_points").select("user_id", { count: "exact", head: true }).eq("user_id", opUser.user_id)).count ?? 0;

  // ── 1. runOnce — 내 시드 만기 2건(변동+정규) 처리, 미만기 제외 ──
  const r1 = await runOnce({ sb, onlyIds: myIds, crawlAndMatch: fakeCrawl, log: () => {} });
  ck("[처리] 내 시드 만기 2건 성공(미만기 제외)", r1.succeeded === 2 && r1.failed === 0, J(r1));

  // ── 2. 변동 완료 + recipients ──
  const irrAfter = (await sb.from("process_irregular_acts").select("status,completed_at,last_error").eq("id", irr.id).maybeSingle()).data;
  ck("[변동] status=completed · completed_at 채움 · last_error null", irrAfter?.status === "completed" && !!irrAfter?.completed_at && !irrAfter?.last_error);
  const irrRec = (await sb.from("process_check_review_recipients").select("user_id,match_type,nickname").eq("source", "irregular").eq("ref_id", irr.id)).data ?? [];
  ck("[변동] recipients matched(opUser)+review 저장", irrRec.some((x) => x.match_type === "matched" && x.user_id === opUser.user_id) && irrRec.some((x) => x.match_type === "review" && x.user_id === null), J(irrRec.map((x) => x.match_type)));

  // ── 3. 정규 완료 + checked_crew_count + recipients ──
  const regAfter = (await sb.from("process_check_statuses").select("status,completed_at,checked_crew_count").eq("id", reg.id).maybeSingle()).data;
  ck("[정규] status=completed · checked_crew_count=1", regAfter?.status === "completed" && regAfter?.checked_crew_count === 1, J(regAfter));
  const regRec = (await sb.from("process_check_review_recipients").select("match_type").eq("source", "regular").eq("ref_id", reg.id)).data ?? [];
  ck("[정규] recipients 저장(source=regular)", regRec.length >= 1);

  // ── 4. 미만기 행은 미처리(pending 유지) ──
  const fut = (await sb.from("process_irregular_acts").select("status").eq("id", irrFuture.id).maybeSingle()).data;
  ck("[catch-up 경계] 미만기(future) 행 pending 유지", fut?.status === "pending");

  // ── 5. 재처리 — 이미 완료된 건 due 아님(중복 처리 0) ──
  const r2 = await runOnce({ sb, onlyIds: myIds, crawlAndMatch: fakeCrawl, log: () => {} });
  ck("[멱등] 재실행 시 due 처리 0(완료건 제외)", r2.succeeded === 0, J(r2));

  // ── 6. 재시도 — 크롤 실패 시 attempt_count++ · last_error · pending 유지 ──
  const irrFail = (await sb.from("process_irregular_acts").insert({
    organization_slug: ORG, week_id: week.id, kind: "review_request", act_name: `${TAG} 실패행`,
    applicant_admin_name: "검증", scope_mode: "operating", review_link: "https://cafe.naver.com/x/4",
    scheduled_check_at: pastIso, status: "pending",
  }).select("id").single()).data;
  const failCrawl = async () => { throw new Error("crawl boom"); };
  const r3 = await runOnce({ sb, onlyIds: [irrFail.id], crawlAndMatch: failCrawl, log: () => {} });
  const failed = (await sb.from("process_irregular_acts").select("status,attempt_count,last_error").eq("id", irrFail.id).maybeSingle()).data;
  ck("[재시도] 실패 → attempt_count=1 · last_error 기록 · pending 유지", r3.failed >= 1 && failed?.status === "pending" && failed?.attempt_count === 1 && /boom/.test(failed?.last_error ?? ""), J(failed));

  // ── 7. 쿨다운 — 방금 실패한 건은 즉시 재시도서 제외(eligible 감소) ──
  const r4 = await runOnce({ sb, onlyIds: [irrFail.id], crawlAndMatch: failCrawl, log: () => {} });
  ck("[쿨다운] 직후 재실행 eligible 0", r4.eligible === 0, J(r4));
  const failed2 = (await sb.from("process_irregular_acts").select("attempt_count").eq("id", irrFail.id).maybeSingle()).data;
  ck("[쿨다운] attempt_count 불변=1", failed2?.attempt_count === 1, `att=${failed2?.attempt_count}`);

  // ── 8. org 스코프 — encre 한정 실행은 oranke 실패행 미처리 ──
  const r5 = await runOnce({ sb, onlyIds: [irrFail.id], crawlAndMatch: fakeCrawl, orgs: ["encre"], log: () => {} });
  ck("[org스코프] orgs=[encre] → oranke 행 eligible 0", r5.eligible === 0, J(r5));

  // ── 9. 고객앱/snapshot 무영향 — user_weekly_points 카운트 불변 ──
  const uwpAfter = (await sb.from("user_weekly_points").select("user_id", { count: "exact", head: true }).eq("user_id", opUser.user_id)).count ?? 0;
  ck("[고객앱 무영향] user_weekly_points 카운트 불변", uwpBefore === uwpAfter, `before=${uwpBefore} after=${uwpAfter}`);
} catch (e) { console.error("ERROR:", e?.stack ?? e?.message ?? e); fail++; }
finally { await cleanup(); console.log("(cleanup — net-zero)"); console.log(`\n결과: ${pass} pass / ${fail} fail`); process.exit(fail > 0 ? 1 : 0); }
