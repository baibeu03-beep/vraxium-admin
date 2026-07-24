/**
 * verify-experience-line-select-at-zero-http.ts
 * 실무 경험 — 평점 0점에서도 라인명 선택·저장·조회·유지 (평점과 라인명 분리).
 *
 *   1) 평점 0점으로 라인명 저장 → 201, 저장됨(null 로 지워지지 않음)
 *   2) 새로고침(재 GET)해도 선택 라인명 유지
 *   3) 0 → 1 → 0 으로 바꿔도 선택 라인명 유지(자동 초기화 없음)
 *   4) 팀 총괄 보드(개설 검수 조회)에서도 평점 0 셀의 라인명이 노출됨(읽기 경로 동일)
 *   5) 라인명 목록(lineOptions.derivation) 이 평점과 무관하게 노출됨
 *   6) 일반 모드 / mode=test / 여러 org 에서 동일 DTO·동일 동작
 *
 * 스냅샷 무영향 확인(코드 불변): 개설 완료 대상자 게이트(openTeamOverall: checked && score>0 &&
 *   selectedLineId)는 그대로다. 이 스크립트는 개설 완료를 호출하지 않으므로 고객 라인/평가/snapshot 을
 *   생성하지 않는다 — 저장된 0점 라인이 대상자로 새지 않음은 그 게이트가 독립 보장한다.
 *
 * 사전: dev 서버(:3000) 기동.
 * 실행: npx tsx --env-file=.env.local scripts/verify-experience-line-select-at-zero-http.ts
 *
 * ⚠ 비파괴: 대상 파트의 기존 신청(헤더+셀)을 raw 스냅샷 → 검증 후 원상 복원(없었으면 삭제).
 *    team_overall 헤더/셀·고객 라인은 건드리지 않는다. 말미에 복원 결과를 단언한다.
 */
import { config } from "dotenv";
config({ path: ".env.local" });
import { createClient } from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";

const BASE = process.env.SMOKE_BASE_URL ?? "http://localhost:3000";
const ADMIN_EMAIL = process.env.SMOKE_ADMIN_EMAIL ?? "vanuatu.golden@gmail.com";
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const ANON = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const sb = createClient(SUPABASE_URL, SERVICE);

const WEEK_ID = "39aae7a0-216f-4262-8a67-6beef1bccf22"; // W2 2026-summer (3 org 개설 기간)

type Scenario = { label: string; org: string; teamName: string; part: string; mode: "operating" | "test" };
const SCENARIOS: Scenario[] = [
  { label: "oranke · 일반",   org: "oranke",  teamName: "과일(T)",   part: "수박",   mode: "operating" },
  { label: "oranke · test",   org: "oranke",  teamName: "음료(T)",   part: "커피",   mode: "test" },
  { label: "encre · 일반",    org: "encre",   teamName: "비주얼랩(T)", part: "포토",   mode: "operating" },
  { label: "encre · test",    org: "encre",   teamName: "사운드(T)",   part: "보컬",   mode: "test" },
  { label: "phalanx · 일반",  org: "phalanx", teamName: "전략(T)",   part: "리서치", mode: "operating" },
  { label: "phalanx · test",  org: "phalanx", teamName: "운영(T)",   part: "정책",   mode: "test" },
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

async function teamId(org: string, teamName: string): Promise<string | null> {
  const { data } = await sb
    .from("cluster4_teams")
    .select("id")
    .eq("organization_slug", org)
    .eq("team_name", teamName)
    .maybeSingle();
  return (data as { id: string } | null)?.id ?? null;
}

async function getPart(cookie: string, s: Scenario, tid: string) {
  const qs = new URLSearchParams({
    organization: s.org,
    week_id: WEEK_ID,
    team_id: tid,
    team_name: s.teamName,
    part: s.part,
  });
  if (s.mode === "test") qs.set("mode", "test");
  const res = await fetch(`${BASE}/api/admin/cluster4/experience/part-input?${qs}`, { headers: { cookie } });
  return { status: res.status, json: await res.json() };
}

async function postPart(cookie: string, s: Scenario, tid: string, cells: Cell[]) {
  const res = await fetch(`${BASE}/api/admin/cluster4/experience/part-input`, {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({
      organization: s.org,
      week_id: WEEK_ID,
      team_id: tid,
      team_name: s.teamName,
      part: s.part,
      cells,
      ...(s.mode === "test" ? { mode: "test" } : {}),
    }),
  });
  return { status: res.status, json: await res.json() };
}

async function getBoardCell(
  cookie: string,
  s: Scenario,
  tid: string,
  crewId: string,
): Promise<{ selectedLineId: string | null; score: number; checked: boolean } | null> {
  const qs = new URLSearchParams({
    organization: s.org,
    week_id: WEEK_ID,
    team_id: tid,
    team_name: s.teamName,
  });
  if (s.mode === "test") qs.set("mode", "test");
  const res = await fetch(`${BASE}/api/admin/cluster4/experience/team-overall?${qs}`, { headers: { cookie } });
  const json = await res.json();
  for (const part of json?.data?.parts ?? []) {
    for (const crew of part.crews ?? []) {
      if (crew.userId === crewId) {
        const cell = crew.cells?.derivation;
        return cell ? { selectedLineId: cell.selectedLineId ?? null, score: cell.score, checked: cell.checked } : null;
      }
    }
  }
  return null;
}

// 대상 파트 신청 raw 스냅샷 / 복원 — 비파괴 보장.
async function snapshotSubmission(org: string, tid: string, part: string) {
  const { data: hdr } = await sb
    .from("cluster4_experience_part_submissions")
    .select("id,submitted_by,submitted_at")
    .eq("organization_slug", org)
    .eq("week_id", WEEK_ID)
    .eq("team_id", tid)
    .eq("part_name", part)
    .maybeSingle();
  const header = hdr as { id: string; submitted_by: string | null; submitted_at: string | null } | null;
  if (!header) return { existed: false as const, header: null, cells: [] as Array<Record<string, unknown>> };
  const { data: cells } = await sb
    .from("cluster4_experience_part_submission_cells")
    .select("crew_user_id,line_type,checked,score,selected_line_id")
    .eq("submission_id", header.id);
  return { existed: true as const, header, cells: (cells ?? []) as Array<Record<string, unknown>> };
}

async function restoreSubmission(
  org: string,
  tid: string,
  part: string,
  snap: Awaited<ReturnType<typeof snapshotSubmission>>,
) {
  // 현재 신청(내가 만든 것) 제거.
  await sb
    .from("cluster4_experience_part_submissions")
    .delete()
    .eq("organization_slug", org)
    .eq("week_id", WEEK_ID)
    .eq("team_id", tid)
    .eq("part_name", part);
  if (!snap.existed || !snap.header) return;
  // 원본 헤더 재삽입.
  const { data: reHdr } = await sb
    .from("cluster4_experience_part_submissions")
    .insert({
      id: snap.header.id,
      organization_slug: org,
      week_id: WEEK_ID,
      team_id: tid,
      part_name: part,
      submitted_by: snap.header.submitted_by,
      submitted_at: snap.header.submitted_at,
    })
    .select("id")
    .single();
  const hid = (reHdr as { id: string } | null)?.id;
  if (hid && snap.cells.length > 0) {
    await sb.from("cluster4_experience_part_submission_cells").insert(
      snap.cells.map((c) => ({
        submission_id: hid,
        crew_user_id: c.crew_user_id,
        line_type: c.line_type,
        checked: c.checked,
        score: c.score,
        selected_line_id: c.selected_line_id ?? null,
      })),
    );
  }
}

const cellDtoShapes = new Set<string>();

async function runScenario(cookie: string, s: Scenario) {
  console.log(`\n=== ${s.label} (${s.org}/${s.teamName}/${s.part}, mode=${s.mode}) ===`);
  const tid = await teamId(s.org, s.teamName);
  if (!tid) {
    check("팀 조회", false, `${s.org}/${s.teamName} 없음`);
    return;
  }

  const snap = await snapshotSubmission(s.org, tid, s.part);
  try {
    const g0 = await getPart(cookie, s, tid);
    const crews = (g0.json?.data?.crews ?? []) as Array<{ userId: string }>;
    const options = (g0.json?.data?.lineOptions?.derivation ?? []) as Array<{ id: string }>;
    if (g0.status !== 200 || crews.length === 0 || options.length === 0) {
      check("사전조건(크루/라인옵션)", false, `status=${g0.status} crews=${crews.length} opts=${options.length}`);
      return;
    }
    // (5) 라인명 목록이 평점과 무관하게 노출.
    check("[5] 라인명 목록 노출(derivation 옵션 존재)", options.length > 0, `${options.length}개`);
    const crewId = crews[0].userId;
    const lineId = options[0].id;

    // 기준선: 이 크루의 기존 고객 대상자 수(과거 개설분 포함). 0점 저장이 이 수를 늘리면 안 된다.
    const { count: tgtBefore } = await sb
      .from("cluster4_line_targets")
      .select("id", { count: "exact", head: true })
      .eq("week_id", WEEK_ID)
      .eq("target_user_id", crewId);

    const cellsWith = (score: number, checked: boolean): Cell[] => [
      { crewUserId: crewId, lineType: "derivation", checked, score, selectedLineId: lineId },
      { crewUserId: crewId, lineType: "analysis", checked: true, score: 7, selectedLineId: null },
      { crewUserId: crewId, lineType: "evaluation", checked: true, score: 7, selectedLineId: null },
    ];

    // (1)(2)(3) 평점 0점 + 라인명 저장 → 201, 재조회 시 유지.
    const p1 = await postPart(cookie, s, tid, cellsWith(0, false));
    check("[1] 평점 0점 라인명 저장 201", p1.status === 201 && p1.json?.success === true, `status=${p1.status} ${JSON.stringify(p1.json?.error)}`);

    const g1 = await getPart(cookie, s, tid);
    const cell1 = ((g1.json?.data?.cells ?? []) as Cell[]).find(
      (c) => c.crewUserId === crewId && c.lineType === "derivation",
    );
    if (cell1) cellDtoShapes.add(Object.keys(cell1).sort().join(","));
    check("[2] 새로고침 후 라인명 유지", cell1?.selectedLineId === lineId, `selectedLineId=${cell1?.selectedLineId}`);
    check("[3] 평점 0점 그대로 저장(계산 로직 불변)", cell1?.score === 0 && cell1?.checked === false, `score=${cell1?.score} checked=${cell1?.checked}`);

    // (4) 팀 총괄 보드(개설 검수 조회)에서도 0점 셀 라인명 노출.
    const boardCell = await getBoardCell(cookie, s, tid, crewId);
    check("[4] 팀 총괄 보드에서 0점 셀 라인명 노출", boardCell?.selectedLineId === lineId, `board.selectedLineId=${boardCell?.selectedLineId}`);

    // (6) 0 → 1 → 0 유지.
    await postPart(cookie, s, tid, cellsWith(1, true));
    const gA = await getPart(cookie, s, tid);
    const cellA = ((gA.json?.data?.cells ?? []) as Cell[]).find((c) => c.crewUserId === crewId && c.lineType === "derivation");
    check("[6a] 0→1 후 라인명 유지", cellA?.selectedLineId === lineId, `selectedLineId=${cellA?.selectedLineId} score=${cellA?.score}`);

    await postPart(cookie, s, tid, cellsWith(0, false));
    const gB = await getPart(cookie, s, tid);
    const cellB = ((gB.json?.data?.cells ?? []) as Cell[]).find((c) => c.crewUserId === crewId && c.lineType === "derivation");
    check("[6b] 1→0 후 라인명 유지", cellB?.selectedLineId === lineId && cellB?.score === 0, `selectedLineId=${cellB?.selectedLineId} score=${cellB?.score}`);

    // 스냅샷 무영향 — 0점 라인 저장이 고객 대상자를 새로 만들지 않는다(개설 게이트 독립·개설 미호출).
    //   ⚠ 절대 0 이 아니라 기준선 대비 delta 0 으로 판정 — 과거 개설분(opened 팀)의 기존 대상자가 있을 수 있다.
    const { count: tgtAfter } = await sb
      .from("cluster4_line_targets")
      .select("id", { count: "exact", head: true })
      .eq("week_id", WEEK_ID)
      .eq("target_user_id", crewId);
    check(
      "[스냅샷] 0점 라인이 고객 대상자로 새지 않음(기준선 대비 증가 0)",
      (tgtAfter ?? 0) === (tgtBefore ?? 0),
      `before=${tgtBefore} after=${tgtAfter}`,
    );
  } finally {
    await restoreSubmission(s.org, tid, s.part, snap);
    const after = await snapshotSubmission(s.org, tid, s.part);
    const same =
      after.existed === snap.existed &&
      after.cells.length === snap.cells.length;
    check("[정리] 대상 파트 신청 원상 복원", same, `existed ${snap.existed}→${after.existed}, cells ${snap.cells.length}→${after.cells.length}`);
  }
}

async function main() {
  const cookie = await adminCookieHeader();
  for (const s of SCENARIOS) await runScenario(cookie, s);

  console.log("\n=== DTO 동일성(모드/org 무관) ===");
  check("셀 DTO 키 1종", cellDtoShapes.size === 1, [...cellDtoShapes].join(" / "));

  console.log(`\n결과: ${pass} pass / ${fail} fail`);
  process.exit(fail === 0 ? 0 : 1);
}

void main();
