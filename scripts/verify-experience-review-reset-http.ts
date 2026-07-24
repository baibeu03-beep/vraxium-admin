/**
 * verify-experience-review-reset-http.ts
 * 실무 경험 [개설 검수] 무효화 — 실제 HTTP 라우트로 검증한다.
 *
 *   · 변경 없는 저장 → 팝업 없음(200/201) + 검수 상태 유지
 *   · 실제 변경 저장(확인 전) → 409 + code=REVIEW_RESET_CONFIRM_CODE + **DB 무변경**(저장도 안 됨)
 *   · 확인 후 저장 → 저장 반영 + 검수 취소(board.status='none')
 *   · 신청 취소(DELETE)도 동일 규약
 *   · 일반 모드(operating) / mode=test / 여러 org 에서 동일 요청·응답(DTO)·동일 동작
 *
 * 사전: dev 서버(:3000) 기동. (2026-07-23 마이그레이션은 선택 — 미적용이면 reviewed_at sentinel 로 동작)
 * 실행: npx tsx --env-file=.env.local scripts/verify-experience-review-reset-http.ts
 *
 * ⚠ 쓰기 범위: 시나리오가 직접 만든 파트 신청(임시 파트 포함)과 팀 총괄 헤더뿐이다.
 *    기존 헤더가 있는 팀(phalanx)은 헤더 전체를 스냅샷 → 검증 후 원래 값으로 복원하고,
 *    셀은 임시 파트만 사용해 기존 파트 신청 데이터를 건드리지 않는다. 말미에 잔여물 0 을 단언한다.
 *    snapshot(cluster4_weekly_card_snapshots) 생성/조회 경로는 호출하지 않는다.
 */
import { config } from "dotenv";
config({ path: ".env.local" });
import { createClient } from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";
import { REVIEW_RESET_CONFIRM_CODE, REVIEW_RESET_CONFIRM_MESSAGE } from "@/lib/experienceReviewResetPolicy";

const BASE = process.env.SMOKE_BASE_URL ?? "http://localhost:3000";
const ADMIN_EMAIL = process.env.SMOKE_ADMIN_EMAIL ?? "vanuatu.golden@gmail.com";
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const ANON = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const sb = createClient(SUPABASE_URL, SERVICE);

// W2 2026-summer — 3개 org(oranke/encre/phalanx) 팀이 모두 실무 경험 개설 기간인 주차.
const WEEK_ID = "39aae7a0-216f-4262-8a67-6beef1bccf22";
const TMP_PART = "검증임시파트";

type Scenario = {
  label: string;
  org: string;
  teamName: string;
  part: string; // 실제 파트(크루 조회용) — 저장 대상 파트는 usePart
  usePart?: string; // 저장 대상 파트(미지정 시 part)
  mode: "operating" | "test";
  /** 기존 팀 총괄 헤더가 있는 팀: 스냅샷 후 복원(없으면 검증 후 삭제). */
  headerPreexisting?: boolean;
};

const SCENARIOS: Scenario[] = [
  { label: "oranke · 일반 모드", org: "oranke", teamName: "과일(T)", part: "수박", mode: "operating" },
  { label: "oranke · mode=test", org: "oranke", teamName: "음료(T)", part: "커피", mode: "test" },
  { label: "encre · 일반 모드", org: "encre", teamName: "비주얼랩(T)", part: "포토", mode: "operating" },
  { label: "encre · mode=test", org: "encre", teamName: "사운드(T)", part: "보컬", mode: "test" },
  {
    label: "phalanx · 일반 모드",
    org: "phalanx",
    teamName: "전략(T)",
    part: "기획",
    usePart: TMP_PART,
    mode: "operating",
    headerPreexisting: true,
  },
  {
    label: "phalanx · mode=test",
    org: "phalanx",
    teamName: "운영(T)",
    part: "정책",
    usePart: TMP_PART,
    mode: "test",
    headerPreexisting: true,
  },
];

let pass = 0;
let fail = 0;
const check = (label: string, ok: boolean, detail = "") => {
  console.log(`  ${ok ? "✓" : "✗"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (ok) pass++;
  else fail++;
};

async function adminCookieHeader(): Promise<string> {
  const admin = createClient(SUPABASE_URL, SERVICE);
  const browser = createClient(SUPABASE_URL, ANON);
  const { data: linkData, error: linkErr } = await admin.auth.admin.generateLink({
    type: "magiclink",
    email: ADMIN_EMAIL,
  });
  if (linkErr) throw linkErr;
  const otp = linkData.properties?.email_otp;
  if (!otp) throw new Error("email_otp 없음");
  const { data: verifyData, error: vErr } = await browser.auth.verifyOtp({
    email: ADMIN_EMAIL,
    token: otp,
    type: "magiclink",
  });
  if (vErr) throw vErr;
  const captured: Array<{ name: string; value: string }> = [];
  const server = createServerClient(SUPABASE_URL, ANON, {
    cookies: { getAll: () => [], setAll: (items) => captured.push(...items) },
  });
  await server.auth.setSession({
    access_token: verifyData.session!.access_token,
    refresh_token: verifyData.session!.refresh_token,
  });
  return captured.map((c) => `${c.name}=${c.value}`).join("; ");
}

type Cell = {
  crewUserId: string;
  lineType: "derivation" | "analysis" | "evaluation";
  checked: boolean;
  score: number;
  selectedLineId: string | null;
};

async function partInputGet(
  cookie: string,
  s: Scenario,
  teamId: string,
  part: string,
) {
  const qs = new URLSearchParams({
    organization: s.org,
    week_id: WEEK_ID,
    team_id: teamId,
    team_name: s.teamName,
    part,
  });
  if (s.mode === "test") qs.set("mode", "test");
  const res = await fetch(`${BASE}/api/admin/cluster4/experience/part-input?${qs}`, {
    headers: { cookie },
  });
  return { status: res.status, json: await res.json() };
}

async function partInputPost(
  cookie: string,
  s: Scenario,
  teamId: string,
  part: string,
  cells: Cell[],
  confirmReviewReset: boolean,
) {
  const res = await fetch(`${BASE}/api/admin/cluster4/experience/part-input`, {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({
      organization: s.org,
      week_id: WEEK_ID,
      team_id: teamId,
      team_name: s.teamName,
      part,
      cells,
      ...(s.mode === "test" ? { mode: "test" } : {}),
      ...(confirmReviewReset ? { confirmReviewReset: true } : {}),
    }),
  });
  return { status: res.status, json: await res.json() };
}

async function partInputDelete(
  cookie: string,
  s: Scenario,
  teamId: string,
  part: string,
  confirmReviewReset: boolean,
) {
  const qs = new URLSearchParams({
    organization: s.org,
    week_id: WEEK_ID,
    team_id: teamId,
    part,
  });
  if (s.mode === "test") qs.set("mode", "test");
  if (confirmReviewReset) qs.set("confirmReviewReset", "1");
  const res = await fetch(`${BASE}/api/admin/cluster4/experience/part-input?${qs}`, {
    method: "DELETE",
    headers: { cookie },
  });
  return { status: res.status, json: await res.json() };
}

async function boardStatus(cookie: string, s: Scenario, teamId: string): Promise<string> {
  const qs = new URLSearchParams({
    organization: s.org,
    week_id: WEEK_ID,
    team_id: teamId,
    team_name: s.teamName,
  });
  if (s.mode === "test") qs.set("mode", "test");
  const res = await fetch(`${BASE}/api/admin/cluster4/experience/team-overall?${qs}`, {
    headers: { cookie },
  });
  const json = await res.json();
  return json?.data?.status ?? `(http ${res.status})`;
}

// DB 직접 조회 — 응답 DTO 가 아니라 실제 저장 상태를 본다.
async function storedCellSignature(
  org: string,
  teamId: string,
  part: string,
): Promise<string> {
  const { data: hdr } = await sb
    .from("cluster4_experience_part_submissions")
    .select("id")
    .eq("organization_slug", org)
    .eq("week_id", WEEK_ID)
    .eq("team_id", teamId)
    .eq("part_name", part)
    .maybeSingle();
  const id = (hdr as { id: string } | null)?.id;
  if (!id) return "(없음)";
  const { data: cells } = await sb
    .from("cluster4_experience_part_submission_cells")
    .select("crew_user_id,line_type,checked,score,selected_line_id")
    .eq("submission_id", id);
  return ((cells ?? []) as Array<Record<string, unknown>>)
    .map((c) => `${c.crew_user_id}|${c.line_type}|${c.checked}|${c.score}|${c.selected_line_id ?? "-"}`)
    .sort()
    .join(";");
}

async function rawHeader(org: string, teamId: string) {
  const { data } = await sb
    .from("cluster4_experience_team_overall")
    .select("id,status,reviewed_by,reviewed_at,opened_by,opened_at")
    .eq("organization_slug", org)
    .eq("week_id", WEEK_ID)
    .eq("team_id", teamId)
    .maybeSingle();
  return data as {
    id: string;
    status: string;
    reviewed_by: string | null;
    reviewed_at: string | null;
    opened_by: string | null;
    opened_at: string | null;
  } | null;
}

/** [개설 검수] 완료 상태 seed — 검수 API 전체(아웃풋/파트장 라인 필수)를 타지 않고 상태만 만든다. */
async function seedReviewed(org: string, teamId: string) {
  const existing = await rawHeader(org, teamId);
  if (existing) {
    const { error } = await sb
      .from("cluster4_experience_team_overall")
      .update({ status: "reviewed", reviewed_at: new Date().toISOString() })
      .eq("id", existing.id);
    if (error) throw new Error(`seedReviewed(update): ${error.message}`);
    return;
  }
  const { error } = await sb.from("cluster4_experience_team_overall").insert({
    organization_slug: org,
    week_id: WEEK_ID,
    team_id: teamId,
    status: "reviewed",
    reviewed_at: new Date().toISOString(),
  });
  if (error) throw new Error(`seedReviewed(insert): ${error.message}`);
}

const dtoShapes = { ok: new Set<string>(), conflict: new Set<string>() };

/** 현재 모집단 스코프 밖 사용자(= savePartSubmission 이 write 전에 422 로 막는 크루). */
async function outOfScopeUserId(org: string): Promise<string | null> {
  const { data: markers } = await sb.from("test_user_markers").select("user_id");
  const marked = new Set(
    ((markers ?? []) as Array<{ user_id: string }>).map((m) => m.user_id),
  );
  const { data: profiles } = await sb
    .from("user_profiles")
    .select("user_id")
    .eq("organization_slug", org)
    .limit(500);
  for (const p of (profiles ?? []) as Array<{ user_id: string }>) {
    if (!marked.has(p.user_id)) return p.user_id;
  }
  return null;
}

async function runScenario(cookie: string, s: Scenario) {
  const savePart = s.usePart ?? s.part;
  console.log(`\n=== ${s.label} (${s.org}/${s.teamName}/${savePart}, mode=${s.mode}) ===`);

  const { data: team } = await sb
    .from("cluster4_teams")
    .select("id")
    .eq("organization_slug", s.org)
    .eq("team_name", s.teamName)
    .maybeSingle();
  const teamId = (team as { id: string } | null)?.id;
  if (!teamId) {
    check("팀 조회", false, `${s.org}/${s.teamName} 없음`);
    return;
  }

  // 평가 대상 크루 — 실제 파트의 GET DTO 에서 가져온다(모드 스코프 그대로).
  const crewRes = await partInputGet(cookie, s, teamId, s.part);
  const crews = (crewRes.json?.data?.crews ?? []) as Array<{ userId: string }>;
  if (crewRes.status !== 200 || crews.length === 0) {
    check("크루 조회", false, `status=${crewRes.status} crews=${crews.length}`);
    return;
  }
  const crewId = crews[0].userId;

  const headerBefore = await rawHeader(s.org, teamId);
  if (s.headerPreexisting && !headerBefore) {
    check("기존 헤더 스냅샷", false, "헤더가 없음(시나리오 가정 불일치)");
    return;
  }

  const base: Cell[] = [
    { crewUserId: crewId, lineType: "derivation", checked: true, score: 7, selectedLineId: null },
    { crewUserId: crewId, lineType: "analysis", checked: true, score: 7, selectedLineId: null },
    { crewUserId: crewId, lineType: "evaluation", checked: true, score: 7, selectedLineId: null },
  ];
  // 실제 변경 = 도출 점수 7 → 9(라인 선택 없이 점수만 바꾼다 — 라인 유형 검증과 무관하게 diff 만 본다).
  const changedCells: Cell[] = base.map((c) =>
    c.lineType === "derivation" ? { ...c, score: 9 } : c,
  );

  try {
    // ── [1] 기준 신청 저장(검수 전) ──
    const r1 = await partInputPost(cookie, s, teamId, savePart, base, false);
    check(
      "[1] 신청 저장(검수 전) 201",
      r1.status === 201 && r1.json?.success === true,
      `status=${r1.status} ${JSON.stringify(r1.json?.error ?? r1.json?.data)}`,
    );
    if (r1.status === 201) dtoShapes.ok.add(Object.keys(r1.json.data ?? {}).sort().join(","));
    check(
      "[1] 검수 취소 없음(reviewReset=false)",
      r1.json?.data?.reviewReset === false && r1.json?.data?.reviewResetFailed === false,
      JSON.stringify(r1.json?.data),
    );
    const sigBase = await storedCellSignature(s.org, teamId, savePart);

    // ── [2] 개설 검수 완료 상태 seed ──
    await seedReviewed(s.org, teamId);
    check("[2] 검수 완료 seed → board.status='reviewed'", (await boardStatus(cookie, s, teamId)) === "reviewed");

    // ── [3] 변경 없는 저장 → 팝업 없음 + 검수 유지 ──
    const r3 = await partInputPost(cookie, s, teamId, savePart, base, false);
    check(
      "[3] 변경 없는 저장 201(팝업 없음)",
      r3.status === 201 && r3.json?.data?.changed === false,
      `status=${r3.status} changed=${r3.json?.data?.changed}`,
    );
    check("[3] 검수 취소 안 됨", r3.json?.data?.reviewReset === false);
    check(
      "[3] 검수 상태 유지(board.status='reviewed')",
      (await boardStatus(cookie, s, teamId)) === "reviewed",
    );

    // ── [4] 실제 변경 + 확인 전 → 409, 저장도 검수 취소도 없음 ──
    const r4 = await partInputPost(cookie, s, teamId, savePart, changedCells, false);
    check(
      "[4] 실제 변경 저장 409",
      r4.status === 409 && r4.json?.code === REVIEW_RESET_CONFIRM_CODE,
      `status=${r4.status} code=${r4.json?.code}`,
    );
    check(
      "[4] 확인 문구 일치",
      r4.json?.error === REVIEW_RESET_CONFIRM_MESSAGE,
      JSON.stringify(r4.json?.error),
    );
    if (r4.status === 409) dtoShapes.conflict.add(Object.keys(r4.json ?? {}).sort().join(","));
    check(
      "[4] 취소 시 데이터 무변경(DB 셀 동일)",
      (await storedCellSignature(s.org, teamId, savePart)) === sigBase,
    );
    check(
      "[4] 취소 시 검수 상태 유지",
      (await boardStatus(cookie, s, teamId)) === "reviewed",
    );

    // ── [5] 확인 후 저장 → 저장 반영 + 검수 취소 ──
    const r5 = await partInputPost(cookie, s, teamId, savePart, changedCells, true);
    check(
      "[5] 확인 후 저장 201",
      r5.status === 201 && r5.json?.success === true,
      `status=${r5.status}`,
    );
    check(
      "[5] 검수 취소됨(reviewReset=true, 실패 없음)",
      r5.json?.data?.reviewReset === true && r5.json?.data?.reviewResetFailed === false,
      JSON.stringify(r5.json?.data),
    );
    const sigAfter = await storedCellSignature(s.org, teamId, savePart);
    check("[5] 변경 저장 반영(DB 셀 변경됨)", sigAfter !== sigBase && sigAfter.includes("|9|"));
    check(
      "[5] board.status='none' — 다시 개설 검수 가능",
      (await boardStatus(cookie, s, teamId)) === "none",
    );

    // ── [8] 저장 실패 시 검수 취소 금지 ──
    //   확인(confirmReviewReset=true)까지 통과했지만 저장이 422 로 실패하는 payload
    //   (모집단 스코프 밖 크루) → 저장도 검수 취소도 일어나면 안 된다.
    await seedReviewed(s.org, teamId);
    const outsider = await outOfScopeUserId(s.org);
    if (!outsider) {
      check("[8] 스코프 밖 크루 확보", false, "후보 없음 — 저장 실패 케이스 생략");
    } else {
      const r8 = await partInputPost(
        cookie,
        s,
        teamId,
        savePart,
        [
          ...changedCells,
          { crewUserId: outsider, lineType: "derivation", checked: true, score: 5, selectedLineId: null },
        ],
        true,
      );
      check(
        "[8] 저장 실패(422)",
        r8.status === 422 && r8.json?.success === false,
        `status=${r8.status} ${JSON.stringify(r8.json?.error)}`,
      );
      check(
        "[8] 저장 실패 시 검수 취소 안 됨(board.status='reviewed')",
        (await boardStatus(cookie, s, teamId)) === "reviewed",
      );
      check(
        "[8] 저장 실패 시 데이터 무변경",
        (await storedCellSignature(s.org, teamId, savePart)) === sigAfter,
      );
    }

    // ── [6] 신청 취소(DELETE)도 동일 규약 ──
    await seedReviewed(s.org, teamId);
    const r6 = await partInputDelete(cookie, s, teamId, savePart, false);
    check(
      "[6] 신청 취소 확인 전 409",
      r6.status === 409 && r6.json?.code === REVIEW_RESET_CONFIRM_CODE,
      `status=${r6.status} code=${r6.json?.code}`,
    );
    check(
      "[6] 취소 시 신청 유지",
      (await storedCellSignature(s.org, teamId, savePart)) === sigAfter,
    );
    const r7 = await partInputDelete(cookie, s, teamId, savePart, true);
    check(
      "[7] 확인 후 신청 취소 200 + 검수 취소",
      r7.status === 200 && r7.json?.data?.reviewReset === true,
      `status=${r7.status} ${JSON.stringify(r7.json?.data)}`,
    );
    check(
      "[7] 신청 삭제됨",
      (await storedCellSignature(s.org, teamId, savePart)) === "(없음)",
    );
    check("[7] board.status='none'", (await boardStatus(cookie, s, teamId)) === "none");
  } finally {
    // ── 정리 — 임시 신청 삭제 + 헤더 복원/삭제 ──
    await sb
      .from("cluster4_experience_part_submissions")
      .delete()
      .eq("organization_slug", s.org)
      .eq("week_id", WEEK_ID)
      .eq("team_id", teamId)
      .eq("part_name", savePart);
    const teamRow = await sb
      .from("cluster4_teams")
      .select("id")
      .eq("organization_slug", s.org)
      .eq("team_name", s.teamName)
      .maybeSingle();
    const tid = (teamRow.data as { id: string } | null)?.id;
    if (tid) {
      if (headerBefore) {
        await sb
          .from("cluster4_experience_team_overall")
          .update({
            status: headerBefore.status,
            reviewed_by: headerBefore.reviewed_by,
            reviewed_at: headerBefore.reviewed_at,
            opened_by: headerBefore.opened_by,
            opened_at: headerBefore.opened_at,
          })
          .eq("id", headerBefore.id);
        const restored = await rawHeader(s.org, tid);
        check(
          "[정리] 기존 헤더 원복",
          JSON.stringify(restored) === JSON.stringify(headerBefore),
          `${JSON.stringify(restored)} vs ${JSON.stringify(headerBefore)}`,
        );
      } else {
        await sb
          .from("cluster4_experience_team_overall")
          .delete()
          .eq("organization_slug", s.org)
          .eq("week_id", WEEK_ID)
          .eq("team_id", tid);
        check("[정리] 생성한 헤더 삭제", (await rawHeader(s.org, tid)) === null);
      }
      check(
        "[정리] 임시 신청 삭제",
        (await storedCellSignature(s.org, tid, savePart)) === "(없음)",
      );
    }
  }
}

async function main() {
  const cookie = await adminCookieHeader();
  for (const s of SCENARIOS) await runScenario(cookie, s);

  console.log("\n=== DTO 동일성(모드/org 무관) ===");
  check(
    "성공 응답 data 키 1종",
    dtoShapes.ok.size === 1,
    [...dtoShapes.ok].join(" / "),
  );
  check(
    "409 응답 키 1종",
    dtoShapes.conflict.size === 1,
    [...dtoShapes.conflict].join(" / "),
  );

  console.log(`\n결과: ${pass} pass / ${fail} fail`);
  process.exit(fail === 0 ? 0 : 1);
}

void main();
