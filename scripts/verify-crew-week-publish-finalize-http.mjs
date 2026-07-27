// 클럽 활동 검수(공표) 통합 검증 — **실 HTTP + 실 DB**.
//
//   2026-07-27 통합: 공표가 종전 `/weeks/*` [주차 검수] 의 확정 작업까지 함께 수행한다.
//   이 스크립트는 "정말 그런지"를 화면 내부 함수가 아니라 실제 API 응답과 DB 행으로 확인한다.
//
//   검증 순서(대상 = 종료된 주차 1개 × 조직):
//     [0] 원상태 스냅샷(복원용)
//     [1] 예비(GET ?action=preview) — 200 · **저장 0**(uws/run/crew rows 불변)
//     [2] 공표(POST publish) — uws 코호트 확정 · 공표/검수 시각 · 원장 정합 · 고객 카드 snapshot
//                              · 성장 통계 · run/crew/team snapshot · org 상태 published
//     [3] 재실행(멱등) — 활성 run 1건 유지 · crew rows 중복 없음 · 원장/통계 중복 없음
//     [4] 공표 취소 — uws 역연산 · 공표/검수 해제 · run reverted · org 상태 aggregating
//     [5] 모드 비교(일반 / mode=test / actAsTestUserId / demoUserId) — HTTP·DTO 키·scope 동일성
//     [6] 원상태 복원
//
//   ⚠ 실제로 쓰기를 수행한다. QA_HIDE_REAL_USERS=true 인 환경에서는 scope 가 test/qa 로 강제되어
//     운영 코호트·운영 weeks 행을 건드리지 않는다(qa_weeks_state 오버레이 사용).
//
//   실행: node scripts/verify-crew-week-publish-finalize-http.mjs [org] [weekNumber]
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const adminRoot = resolve(__dirname, "..");
const rq = createRequire(resolve(adminRoot, "package.json"));
const { createClient } = rq("@supabase/supabase-js");
const { createServerClient } = rq("@supabase/ssr");

const env = readFileSync(resolve(adminRoot, ".env.local"), "utf8");
const get = (k) => env.match(new RegExp(`^${k}=(.+)$`, "m"))?.[1]?.trim();
const BASE = "http://localhost:3000";
const URL_ = get("NEXT_PUBLIC_SUPABASE_URL");
const ANON = get("NEXT_PUBLIC_SUPABASE_ANON_KEY");
const SERVICE = get("SUPABASE_SERVICE_ROLE_KEY");
const OWNER_EMAIL = "vanuatu.golden@gmail.com";

const ORG = process.argv[2] ?? "encre";
const SEASON_KEY = "2026-summer";
const WEEK_NUMBER = Number(process.argv[3] ?? 4);

const sb = createClient(URL_, SERVICE);

let fail = 0;
const ck = (label, ok, detail = "") => {
  console.log(`  ${ok ? "✓" : "✗"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) fail++;
};
const section = (t) => console.log(`\n${t}`);

async function cookieHeader() {
  const brow = createClient(URL_, ANON);
  const { data: link, error } = await sb.auth.admin.generateLink({
    type: "magiclink",
    email: OWNER_EMAIL,
  });
  if (error) throw new Error(`generateLink: ${error.message}`);
  const { data: v, error: e2 } = await brow.auth.verifyOtp({
    email: OWNER_EMAIL,
    token: link.properties.email_otp,
    type: "magiclink",
  });
  if (e2) throw new Error(`verifyOtp: ${e2.message}`);
  const cap = [];
  const srv = createServerClient(URL_, ANON, {
    cookies: { getAll: () => [], setAll: (i) => cap.push(...i) },
  });
  await srv.auth.setSession({
    access_token: v.session.access_token,
    refresh_token: v.session.refresh_token,
  });
  return cap.map((i) => `${i.name}=${i.value}`).join("; ");
}

// ── DB 사실 수집 ────────────────────────────────────────────────────────────
async function snapshotState(week) {
  const [runs, uws, qaState, orgStates, wk] = await Promise.all([
    sb
      .from("cluster4_week_finalize_runs")
      .select("id,organization_slug,scope,snapshot_captured,reverted_at,created_uws_ids,updated_uws")
      .eq("week_id", week.id),
    sb.from("user_week_statuses").select("id,user_id,status").eq("week_start_date", week.start_date),
    sb.from("qa_weeks_state").select("*").eq("week_id", week.id).maybeSingle(),
    sb.from("cluster4_week_org_result_states").select("*").eq("week_id", week.id),
    sb.from("weeks").select("id,result_published_at,result_reviewed_at").eq("id", week.id).single(),
  ]);
  const runIds = (runs.data ?? []).map((r) => r.id);
  const crew = runIds.length
    ? await sb.from("cluster4_week_finalize_run_crew_results").select("run_id,user_id,result,reason_code").in("run_id", runIds)
    : { data: [] };
  const team = runIds.length
    ? await sb.from("cluster4_week_finalize_run_team_results").select("run_id,team_id").in("run_id", runIds)
    : { data: [] };
  return {
    runs: runs.data ?? [],
    activeRuns: (runs.data ?? []).filter((r) => r.reverted_at == null),
    uws: uws.data ?? [],
    qaState: qaState.data ?? null,
    orgStates: orgStates.data ?? [],
    weeksRow: wk.data ?? null,
    crew: crew.data ?? [],
    team: team.data ?? [],
  };
}

// 라인 A/B 원장 · 성장 통계 · 고객 카드 snapshot (중복 지급/누적 검사용)
async function ledgerFacts(week, userIds) {
  if (userIds.length === 0) return { ledger: [], growth: [], cards: 0 };
  const [ledger, growth, cards] = await Promise.all([
    // 라인 결과 A/B 지급 원장 = process_point_awards(reconcileLineAwardsForWeek 가 정합하는 원천).
    sb
      .from("process_point_awards")
      .select("id,user_id,points,week_id")
      .in("user_id", userIds.slice(0, 200))
      .eq("week_id", week.id),
    sb.from("user_growth_stats").select("user_id,approved_weeks,cumulative_weeks,updated_at").in("user_id", userIds.slice(0, 200)),
    sb
      .from("cluster4_weekly_card_snapshots")
      .select("user_id", { count: "exact", head: true })
      .in("user_id", userIds.slice(0, 200)),
  ]);
  return { ledger: ledger.data ?? [], growth: growth.data ?? [], cards: cards.count ?? 0 };
}

const detailUrl = (weekId, extra = "") =>
  `${BASE}/api/admin/team-parts/info/crew-week-results/${ORG}/${weekId}${extra}`;

async function api(cookie, url, init = {}) {
  const res = await fetch(url, {
    ...init,
    headers: { Cookie: cookie, "Content-Type": "application/json", ...(init.headers ?? {}) },
  });
  let json = null;
  try {
    json = await res.json();
  } catch {
    /* non-json */
  }
  return { status: res.status, json };
}

async function main() {
  const cookie = await cookieHeader();

  const { data: wkRow } = await sb
    .from("weeks")
    .select("id,season_key,week_number,start_date,end_date,is_official_rest")
    .eq("season_key", SEASON_KEY)
    .eq("week_number", WEEK_NUMBER)
    .single();
  if (!wkRow) throw new Error(`주차를 찾을 수 없습니다: ${SEASON_KEY} W${WEEK_NUMBER}`);
  const week = wkRow;
  console.log(
    `대상: ${ORG} · ${SEASON_KEY} W${week.week_number} (${week.start_date}~${week.end_date}) · weekId=${week.id}`,
  );

  section("[0] 원상태 스냅샷");
  const before = await snapshotState(week);
  const cohortIdsBefore = [...new Set(before.uws.map((u) => u.user_id))];
  const beforeLedger = await ledgerFacts(week, cohortIdsBefore);
  console.log(
    `  runs=${before.runs.length} active=${before.activeRuns.length} uws=${before.uws.length} ` +
      `weeks.pub=${!!before.weeksRow?.result_published_at} weeks.rev=${!!before.weeksRow?.result_reviewed_at} ` +
      `qa.pub=${!!before.qaState?.result_published_at} qa.rev=${!!before.qaState?.result_reviewed_at} ` +
      `orgStates=${JSON.stringify(before.orgStates.map((s) => `${s.organization_slug}/${s.scope}=${s.status}`))}`,
  );

  // ── [1] 예비 = 저장 0 ─────────────────────────────────────────────────────
  section("[1] 예비 검수 — HTTP 200 · 저장 0");
  const prev1 = await api(cookie, detailUrl(week.id, "?action=preview"));
  ck("예비 HTTP 200", prev1.status === 200, `status=${prev1.status}`);
  ck("예비 DTO kind=preview", prev1.json?.data?.preview?.kind === "preview");
  ck("예비 published=false", prev1.json?.data?.preview?.published === false);
  const afterPreview = await snapshotState(week);
  ck("예비 후 run 수 불변", afterPreview.runs.length === before.runs.length, `${before.runs.length}→${afterPreview.runs.length}`);
  ck("예비 후 uws 수 불변", afterPreview.uws.length === before.uws.length, `${before.uws.length}→${afterPreview.uws.length}`);
  ck("예비 후 crew rows 불변", afterPreview.crew.length === before.crew.length);
  ck(
    "예비 후 공표/검수 시각 불변",
    !!afterPreview.weeksRow?.result_published_at === !!before.weeksRow?.result_published_at &&
      !!afterPreview.qaState?.result_published_at === !!before.qaState?.result_published_at,
  );
  const previewCrewCount = prev1.json?.data?.preview?.crewResults?.length ?? 0;
  const previewUwsMissing = (prev1.json?.data?.preview?.crewResults ?? []).filter(
    (c) => c.reasonCode === "uws_missing",
  ).length;
  console.log(`  (예비: 크루 ${previewCrewCount}명 · uws_missing ${previewUwsMissing}명 — 확정 전이라 정상)`);

  // ── [2] 공표 = 통합 확정 ──────────────────────────────────────────────────
  section("[2] 공표 — 통합 확정 트랜잭션");
  const t0 = Date.now();
  const pub = await api(cookie, detailUrl(week.id), {
    method: "POST",
    body: JSON.stringify({ action: "publish" }),
  });
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  ck("공표 HTTP 200", pub.status === 200, `status=${pub.status} ${pub.status !== 200 ? JSON.stringify(pub.json) : `${elapsed}s`}`);
  if (pub.status !== 200) {
    console.log(`\n  ⚠ 공표가 차단되어 이후 단계를 진행할 수 없습니다: ${pub.json?.error ?? ""}`);
    console.log(`\n결과: ${fail} 실패`);
    process.exit(fail > 0 ? 1 : 0);
  }
  ck("공표 DTO kind=published", pub.json?.data?.published?.kind === "published");
  ck("publication 동봉", pub.json?.data?.publication != null);
  ck("publication.orgStatus=published", pub.json?.data?.publication?.orgStatus === "published");
  ck("publication.hasActiveSnapshot", pub.json?.data?.publication?.hasActiveSnapshot === true);

  const after = await snapshotState(week);
  const scopeUsed = pub.json?.data?.scope;
  console.log(`  (scope=${scopeUsed} · 소요 ${elapsed}s)`);

  // 확정 작업 7종
  //   ① 은 "행이 늘었는가"가 아니라 "부족분이 채워졌는가"다 — 이미 전원 확정된 주차는 증가 0이 정상.
  //     실제 판정은 아래 "uws_missing 0건"(어드민 snapshot 이 확정된 uws 를 읽었다는 직접 증거)이다.
  ck(
    "① uws 코호트 확정(부족분 보충 · 감소 없음)",
    after.uws.length >= before.uws.length,
    `${before.uws.length}→${after.uws.length}${after.uws.length === before.uws.length ? " (이미 전원 확정)" : ""}`,
  );
  const qaScope = scopeUsed === "test";
  // 실효 공표/검수 시각 — qa 스코프는 overlay(qa) ?? 운영 baseline(weeks) 순으로 해석한다
  //   (revertWeeklyCardFinalization 의 effectivePublishedAt 과 동일 규칙).
  const effPub = (s) => (qaScope ? (s.qaState?.result_published_at ?? s.weeksRow?.result_published_at) : s.weeksRow?.result_published_at);
  const effRev = (s) => (qaScope ? (s.qaState?.result_reviewed_at ?? s.weeksRow?.result_reviewed_at) : s.weeksRow?.result_reviewed_at);
  ck("② 공표 시각 반영(result_published_at)", effPub(after) != null, qaScope ? "qa overlay ?? weeks baseline" : "weeks");
  ck("⑥ 검수 시각 반영(result_reviewed_at)", effRev(after) != null, qaScope ? "qa overlay ?? weeks baseline" : "weeks");
  ck(
    "⑦ org 상태 published",
    after.orgStates.some((s) => s.organization_slug === ORG && s.status === "published"),
    JSON.stringify(after.orgStates.map((s) => `${s.organization_slug}/${s.scope}=${s.status}`)),
  );

  // run 단일화 — uws provenance 와 snapshot 이 **같은 행**에 있어야 한다(통합의 핵심).
  //   ⚠ 활성 run 유일성은 (week, org, **scope**) 단위다. 다른 scope 의 기존 run 은 무관하므로 함께 센다.
  const runScope = scopeUsed === "test" ? "qa" : "operating";
  const ofScope = (s) => s.activeRuns.filter((r) => r.organization_slug === ORG && r.scope === runScope);
  const activeOrgRuns = ofScope(after);
  ck("활성 run 조직×scope 당 1건", activeOrgRuns.length === 1, `scope=${runScope} count=${activeOrgRuns.length}`);
  const theRun = activeOrgRuns[0];
  ck("run.snapshot_captured=true", theRun?.snapshot_captured === true);
  // uws 가 실제로 바뀐 경우에만 provenance 가 있어야 한다(변경 0건이면 되돌릴 것도 없다).
  const uwsChanged = after.uws.length !== before.uws.length;
  const provenance = (theRun?.created_uws_ids ?? []).length + (theRun?.updated_uws ?? []).length;
  const provDetail = `created=${(theRun?.created_uws_ids ?? []).length} updated=${(theRun?.updated_uws ?? []).length}`;
  if (uwsChanged) {
    ck("run 에 uws provenance 보유(단일 run 통합)", provenance > 0, provDetail);
  } else {
    console.log(`  · uws 변경 0건 → provenance 불필요 (${provDetail})`);
  }

  // crew snapshot 이 확정된 uws 를 읽었는가 = uws_missing 이 남지 않아야 한다.
  const runCrew = after.crew.filter((c) => c.run_id === theRun?.id);
  ck("크루 결과 snapshot 생성", runCrew.length > 0, `rows=${runCrew.length}`);
  const missing = runCrew.filter((c) => c.reason_code === "uws_missing");
  ck("uws_missing 0건(활동 0건 크루도 확정됨)", missing.length === 0, `missing=${missing.length}`);
  const runTeam = after.team.filter((t) => t.run_id === theRun?.id);
  console.log(`  (팀 결과 snapshot ${runTeam.length}건)`);

  // ③④⑤ 원장/카드/성장통계
  const cohortIds = [...new Set(after.uws.map((u) => u.user_id))];
  const afterLedger = await ledgerFacts(week, cohortIds);
  ck("④ 고객 앱 weekly-card snapshot 존재", afterLedger.cards > 0, `snapshots=${afterLedger.cards}`);
  ck("⑤ user_growth_stats 갱신 행 존재", afterLedger.growth.length > 0, `rows=${afterLedger.growth.length}`);
  console.log(`  (③ 라인 A/B 원장 행 ${beforeLedger.ledger.length}→${afterLedger.ledger.length})`);

  // 확정 결과 == 공표 snapshot 결과 (고객 앱 SoT 와 어드민 snapshot 일치)
  const uwsByUser = new Map(after.uws.map((u) => [u.user_id, u.status]));
  const mismatched = runCrew.filter((c) => {
    const s = uwsByUser.get(c.user_id);
    if (c.result === "success") return s !== "success";
    if (c.result === "failure") return s == null || s === "success";
    return false;
  });
  ck("어드민 snapshot 결과 == uws(성장 SoT)", mismatched.length === 0, `mismatch=${mismatched.length}`);

  // ── [3] 멱등 — 재공표 ────────────────────────────────────────────────────
  section("[3] 재공표(멱등)");
  const rePub = await api(cookie, detailUrl(week.id), {
    method: "POST",
    body: JSON.stringify({ action: "publish" }),
  });
  ck("재공표 HTTP 200", rePub.status === 200, `status=${rePub.status} ${rePub.status !== 200 ? JSON.stringify(rePub.json) : ""}`);
  const after2 = await snapshotState(week);
  const activeOrgRuns2 = ofScope(after2);
  ck("재공표 후에도 활성 run 조직×scope 당 1건", activeOrgRuns2.length === 1, `count=${activeOrgRuns2.length}`);
  // 재공표는 uws provenance 를 이어받아야 한다(안 그러면 공표 취소가 이전 실행분을 못 지운다).
  const prov2 = (activeOrgRuns2[0]?.created_uws_ids ?? []).length + (activeOrgRuns2[0]?.updated_uws ?? []).length;
  ck(
    "재공표 run 이 uws provenance 승계",
    prov2 >= provenance,
    `${provenance} → ${prov2}`,
  );
  const runCrew2 = after2.crew.filter((c) => c.run_id === activeOrgRuns2[0]?.id);
  const dupUsers = runCrew2.length - new Set(runCrew2.map((c) => c.user_id)).size;
  ck("crew rows 사용자 중복 0", dupUsers === 0, `dup=${dupUsers}`);
  ck("uws 수 폭증 없음", Math.abs(after2.uws.length - after.uws.length) <= 0, `${after.uws.length}→${after2.uws.length}`);
  const afterLedger2 = await ledgerFacts(week, cohortIds);
  ck(
    "라인 A/B 원장 중복 지급 없음",
    afterLedger2.ledger.length === afterLedger.ledger.length,
    `${afterLedger.ledger.length}→${afterLedger2.ledger.length}`,
  );
  const growthSame = afterLedger2.growth.every((g) => {
    const p = afterLedger.growth.find((x) => x.user_id === g.user_id);
    return !p || (p.approved_weeks === g.approved_weeks && p.cumulative_weeks === g.cumulative_weeks);
  });
  ck("성장 통계 중복 누적 없음", growthSame);

  // ── [5] 모드 비교 (공표 상태에서 조회 파리티) ────────────────────────────
  section("[5] 모드 비교 — 일반 / mode=test / actAsTestUserId / demoUserId");
  const modes = [
    ["일반", ""],
    ["mode=test", "?mode=test"],
    ["actAsTestUserId", "?actAsTestUserId=00000000-0000-0000-0000-000000000000"],
    ["demoUserId", "?demoUserId=00000000-0000-0000-0000-000000000000"],
  ];
  const modeResults = [];
  for (const [label, q] of modes) {
    const r = await api(cookie, detailUrl(week.id, q));
    const d = r.json?.data ?? {};
    modeResults.push({
      label,
      status: r.status,
      keys: Object.keys(d).sort().join(","),
      scope: d.scope,
      orgStatus: d.publication?.orgStatus,
      hasSnap: d.publication?.hasActiveSnapshot,
      runId: d.published?.runId,
      success: d.published?.growthSuccessCount,
      fail: d.published?.growthFailureCount,
      member: d.published?.memberCount,
      crew: d.published?.crewResults?.length,
    });
  }
  for (const m of modeResults) {
    console.log(
      `  ${m.label.padEnd(16)} status=${m.status} scope=${m.scope} keys=[${m.keys}] org=${m.orgStatus} snap=${m.hasSnap} run=${(m.runId ?? "").slice(0, 8)} 성공=${m.success} 실패=${m.fail} 인원=${m.member} 크루=${m.crew}`,
    );
  }
  const b0 = modeResults[0];
  ck("모든 모드 HTTP 200", modeResults.every((m) => m.status === 200));
  ck("모든 모드 DTO 키 동일", modeResults.every((m) => m.keys === b0.keys), b0.keys);
  ck("모든 모드 scope 동일", modeResults.every((m) => m.scope === b0.scope), `scope=${b0.scope}`);
  ck("모든 모드 공표 상태 동일", modeResults.every((m) => m.orgStatus === b0.orgStatus && m.hasSnap === b0.hasSnap));
  ck("모든 모드 동일 run(같은 snapshot)", modeResults.every((m) => m.runId === b0.runId));
  ck(
    "모든 모드 성공/실패/인원 동일",
    modeResults.every((m) => m.success === b0.success && m.fail === b0.fail && m.member === b0.member && m.crew === b0.crew),
  );
  // demoUserId 가 별도 검수 상태를 만들지 않았는지 = org state 행 수 불변
  const afterModes = await snapshotState(week);
  ck(
    "demoUserId/actAs 경로가 검수 상태를 추가 생성하지 않음",
    afterModes.orgStates.length === after2.orgStates.length,
    `${after2.orgStates.length}→${afterModes.orgStates.length}`,
  );

  // ── [4] 공표 취소 = 확정 취소 ────────────────────────────────────────────
  section("[4] 공표 취소 — 확정 취소 통합");
  const unpub = await api(cookie, detailUrl(week.id), {
    method: "POST",
    body: JSON.stringify({ action: "unpublish" }),
  });
  ck("공표 취소 HTTP 200", unpub.status === 200, `status=${unpub.status} ${unpub.status !== 200 ? JSON.stringify(unpub.json) : ""}`);
  ck("weekRevert 동봉(확정 취소 수행)", unpub.json?.data?.weekRevert != null);
  const rev = await snapshotState(week);
  ck("활성 run 0건(조직×scope)", ofScope(rev).length === 0, `scope=${runScope}`);
  // qa 스코프 해제 = overlay 에 명시 null 기록(운영 baseline 은 건드리지 않는다).
  ck(
    "공표 시각 해제",
    qaScope
      ? rev.qaState != null && rev.qaState.result_published_at == null
      : rev.weeksRow?.result_published_at == null,
    qaScope ? `qa overlay published=${rev.qaState?.result_published_at ?? "null"}` : "",
  );
  ck(
    "검수 시각 해제",
    qaScope
      ? rev.qaState != null && rev.qaState.result_reviewed_at == null
      : rev.weeksRow?.result_reviewed_at == null,
  );
  ck(
    "org 상태 aggregating",
    rev.orgStates.some((s) => s.organization_slug === ORG && s.status === "aggregating"),
    JSON.stringify(rev.orgStates.map((s) => `${s.organization_slug}/${s.scope}=${s.status}`)),
  );
  ck("uws 역연산(생성분 삭제)", rev.uws.length === before.uws.length, `${after2.uws.length}→${rev.uws.length} (원래 ${before.uws.length})`);
  const getAfterRevert = await api(cookie, detailUrl(week.id));
  ck("취소 후 조회 200 · published=null", getAfterRevert.status === 200 && getAfterRevert.json?.data?.published == null);

  // ── [6] 원상태 복원 ──────────────────────────────────────────────────────
  section("[6] 원상태 복원");
  ck("uws 원복", rev.uws.length === before.uws.length);
  ck("weeks(운영) 공표 시각 무접촉", !!rev.weeksRow?.result_published_at === !!before.weeksRow?.result_published_at);
  ck("weeks(운영) 검수 시각 무접촉", !!rev.weeksRow?.result_reviewed_at === !!before.weeksRow?.result_reviewed_at);

  // QA 오버레이 원복 — 원래 행이 없었으면 삭제, 있었으면 원래 값으로 되돌린다.
  if (before.qaState == null) {
    await sb.from("qa_weeks_state").delete().eq("week_id", week.id);
  } else {
    await sb.from("qa_weeks_state").upsert(before.qaState, { onConflict: "week_id" });
  }
  // 조직 검수 상태 원복(테스트가 만든 행은 원래 없었으면 삭제).
  for (const s of after2.orgStates) {
    const orig = before.orgStates.find(
      (b) => b.organization_slug === s.organization_slug && b.scope === s.scope,
    );
    if (!orig) {
      await sb
        .from("cluster4_week_org_result_states")
        .delete()
        .eq("week_id", week.id)
        .eq("organization_slug", s.organization_slug)
        .eq("scope", s.scope);
    } else {
      await sb.from("cluster4_week_org_result_states").upsert(orig, {
        onConflict: "week_id,organization_slug,scope",
      });
    }
  }
  const restored = await snapshotState(week);
  ck(
    "qa_weeks_state 원복",
    (restored.qaState == null) === (before.qaState == null) &&
      (restored.qaState?.result_published_at ?? null) === (before.qaState?.result_published_at ?? null),
  );
  ck(
    "org 검수 상태 원복",
    restored.orgStates.length === before.orgStates.length &&
      before.orgStates.every((b) =>
        restored.orgStates.some(
          (r) => r.organization_slug === b.organization_slug && r.scope === b.scope && r.status === b.status,
        ),
      ),
    JSON.stringify(restored.orgStates.map((s) => `${s.organization_slug}/${s.scope}=${s.status}`)),
  );
  console.log(
    `  (남은 run ${restored.runs.length}건 — 전부 reverted_at 기록·물리 삭제 없음 = 감사 이력 보존 정책)`,
  );

  console.log(`\n결과: ${fail === 0 ? "전부 통과" : `${fail}건 실패`}`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
