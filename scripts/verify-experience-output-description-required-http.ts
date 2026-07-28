/**
 * verify-experience-output-description-required-http.ts
 * 실무 경험 [팀 총괄] 개설 검수/완료 — 아웃풋 **설명 2종** 필수 입력 검증.
 *   요구(2026-07-27): /admin/integrated/line-opening/practical-experience 의 산출물 링크 설명(설명1)이
 *   선택 → **필수**. 이어서(2026-07-28) **이미지 설명**(아웃풋 이미지 1 설명)도 필수로 확대.
 *   공백만 입력한 값도 누락으로 판정(trim). mode/org 무관 동일 정책이며,
 *   프론트 `required` 뿐 아니라 **서버 API 도 같은 함수로** 차단한다.
 *
 * 검증(설명 2종 = description · imageDescription 각각 동일 케이스로):
 *   [A] 순수 판정 SoT(validateOverallOutputRequirements) — 프론트/서버 공용 단일 함수.
 *       빈 문자열·공백만·필드 누락 모두 차단 / 여러 칸 중 1곳만 누락 시 그 카테고리를 정확히 지목 /
 *       우선순위 링크 → 설명 → 이미지 → 이미지 설명 / 확장류는 확장 주간에만 검사.
 *   [B] 실제 HTTP 가드 — 전 org(encre·oranke·phalanx) × 일반(operating)·테스트(test) ×
 *       review·open 에서 설명 누락 = 422 + 각 필드 전용 문구, 설명 충족 = 아웃풋 게이트 통과.
 *   [C] 임퍼소네이션(actAsTestUserId) 경로 = 일반 사용자 경로와 동일 status/문구(별도 검증 로직 없음).
 *       ※ 이 라우트에 demoUserId 개념은 없다(고객 앱 전용) — 임퍼소네이션이 그 대응 경로.
 *   [D] 실제 저장 성공 라운드트립 — 클린-슬레이트 팀에 설명 2종 정상 입력 → review/open 201,
 *       DB output_description·output_image_description 저장, 보드 재조회 아웃풋 DTO 키 불변,
 *       weekly_card_snapshots count 불변. 각 설명만 비우면 422(실 대상에서도 차단). 실행 후 완전 원복.
 *
 * 실행: npx tsx --env-file=.env.local scripts/verify-experience-output-description-required-http.ts
 */
import { config } from "dotenv";
config({ path: ".env.local" });
import { createClient } from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";
import { getTeamOverallBoard } from "@/lib/adminExperienceTeamOverall";
import { resolveTeamNameById } from "@/lib/experienceImpersonation";
import { isWeekOfficialRestById } from "@/lib/cluster4OfficialRestWeek";
import { ORGANIZATIONS } from "@/lib/organizations";
import {
  EXPERIENCE_OVERALL_CATEGORIES,
  OVERALL_OUTPUT_REQUIRED_MESSAGES,
  validateOverallOutputRequirements,
  type ExperienceOverallCategory,
  type ExperienceTeamOverallBoard as BoardDto,
  type OverallOutput,
} from "@/lib/experienceTeamOverallTypes";

const BASE = process.env.SMOKE_BASE_URL ?? "http://localhost:3000";
const ADMIN_EMAIL = process.env.SMOKE_ADMIN_EMAIL ?? "vanuatu.golden@gmail.com";
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const ANON = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const sb = createClient(SUPABASE_URL, SERVICE);

type Mode = "operating" | "test";
type PartCat = "derivation" | "analysis" | "evaluation";
const ALL_CATS = EXPERIENCE_OVERALL_CATEGORIES.map((c) => c.key);

let pass = 0;
let fail = 0;
const check = (label: string, ok: boolean, detail = "") => {
  console.log(`  ${ok ? "✓" : "✗"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (ok) pass++;
  else fail++;
};

// 검증 대상 설명 2종 — 링크 설명(description)과 이미지 설명(imageDescription).
//   둘 다 같은 정책(필수 · trim · 첫 누락 1곳 안내)이라 동일 케이스를 두 필드에 모두 돌린다.
const DESC_FIELDS = [
  { field: "description" as const, label: "링크 설명", message: OVERALL_OUTPUT_REQUIRED_MESSAGES.description },
  { field: "imageDescription" as const, label: "이미지 설명", message: OVERALL_OUTPUT_REQUIRED_MESSAGES.imageDescription },
];
type DescField = (typeof DESC_FIELDS)[number]["field"];

// 나머지 필수 3칸은 항상 채우고 대상 설명 필드만 케이스별로 바꾼다 —
//   해당 설명의 필수 여부를 단독 변수로 관찰하기 위함.
function outs(opts?: {
  field?: DescField;
  value?: string;
  valueByCategory?: Partial<Record<ExperienceOverallCategory, string>>;
  omitField?: boolean;
}): OverallOutput[] {
  const target = opts?.field ?? "description";
  return ALL_CATS.map((key) => {
    const row: OverallOutput = {
      category: key,
      link: `https://example.com/${key}`,
      description: "산출물 설명",
      imageUrl: `https://example.com/${key}.png`,
      imageDescription: "산출물 이미지 설명",
    };
    if (!opts) return row;
    if (opts.omitField) {
      const partial = { ...row } as Partial<OverallOutput>;
      delete partial[target];
      return partial as OverallOutput;
    }
    const override = opts.valueByCategory?.[key] ?? opts.value;
    if (override !== undefined) row[target] = override;
    return row;
  });
}

async function adminCookieHeader(): Promise<string> {
  const browser = createClient(SUPABASE_URL, ANON);
  const { data: link, error } = await sb.auth.admin.generateLink({
    type: "magiclink",
    email: ADMIN_EMAIL,
  });
  if (error) throw error;
  const otp = link.properties?.email_otp;
  if (!otp) throw new Error("email_otp 없음");
  const { data: verified, error: verifyError } = await browser.auth.verifyOtp({
    email: ADMIN_EMAIL,
    token: otp,
    type: "magiclink",
  });
  if (verifyError) throw verifyError;
  const captured: Array<{ name: string; value: string }> = [];
  const server = createServerClient(SUPABASE_URL, ANON, {
    cookies: { getAll: () => [], setAll: (items) => captured.push(...items) },
  });
  await server.auth.setSession({
    access_token: verified.session!.access_token,
    refresh_token: verified.session!.refresh_token,
  });
  return captured.map(({ name, value }) => `${name}=${value}`).join("; ");
}

// 현재 admin 세션 쿠키. 장시간 실행 중 간헐적으로 401 이 나는 경우가 있어(토큰 갱신 레이스)
//   401 이면 쿠키를 재발급해 한 번 재시도한다 — 검증 대상(422/201 판정)과 무관한 인프라 잡음을
//   결과에서 걷어내기 위함. 재발급 값이 이후 호출에도 이어지도록 모듈 레벨 단일 값으로 들고 있는다.
let authCookie = "";

async function postOnce(body: unknown) {
  const res = await fetch(`${BASE}/api/admin/cluster4/experience/team-overall`, {
    method: "POST",
    headers: { cookie: authCookie, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json().catch(() => ({}))) as Record<string, unknown> };
}

async function httpPost(body: unknown) {
  const first = await postOnce(body);
  if (first.status !== 401) return first;
  authCookie = await adminCookieHeader();
  return postOnce(body);
}

async function getBoardOnce(org: string, weekId: string, teamId: string, teamName: string, mode: Mode) {
  const url =
    `${BASE}/api/admin/cluster4/experience/team-overall?organization=${org}` +
    `&week_id=${weekId}&team_id=${teamId}&team_name=${encodeURIComponent(teamName)}&mode=${mode}`;
  const res = await fetch(url, { headers: { cookie: authCookie } });
  return { status: res.status, json: (await res.json().catch(() => ({}))) as { data?: BoardDto } };
}

async function httpGetBoard(org: string, weekId: string, teamId: string, teamName: string, mode: Mode) {
  const first = await getBoardOnce(org, weekId, teamId, teamName, mode);
  if (first.status !== 401) return first;
  authCookie = await adminCookieHeader();
  return getBoardOnce(org, weekId, teamId, teamName, mode);
}

// ───────────────────────── [A] 순수 판정 SoT ─────────────────────────
function verifyPureValidator() {
  console.log("\n=== [A] 순수 판정 SoT — 프론트/서버 공용 validateOverallOutputRequirements ===");

  check("설명 2종 정상 입력 → 통과(null)", validateOverallOutputRequirements(outs(), false) === null);

  for (const { field, label, message } of DESC_FIELDS) {
    console.log(`  — ${label}(${field})`);
    const empty = validateOverallOutputRequirements(outs({ field, value: "" }), false);
    check(
      `${label} 빈 문자열 → 차단 + 전용 문구`,
      empty?.firstMissingField === field && empty?.message === message,
      `field=${empty?.firstMissingField} msg=${empty?.message}`,
    );

    for (const blank of [" ", "   ", "\t", "\n", " \t\n "]) {
      const ws = validateOverallOutputRequirements(outs({ field, value: blank }), false);
      check(
        `${label} 공백만(${JSON.stringify(blank)}) → 차단(trim 판정)`,
        ws?.firstMissingField === field && ws?.message === message,
        `field=${ws?.firstMissingField}`,
      );
    }

    const omitted = validateOverallOutputRequirements(outs({ field, omitField: true }), false);
    check(
      `${label} 필드 자체 누락(구버전 클라) → 차단`,
      omitted?.firstMissingField === field && omitted?.message === message,
      `field=${omitted?.firstMissingField}`,
    );

    // 여러 칸 중 하나만 누락 → 그 카테고리를 정확히 지목(화면 강조/스크롤 대상 = 이 값).
    for (const target of ALL_CATS.filter((c) => c !== "extension")) {
      const one = validateOverallOutputRequirements(
        outs({ field, valueByCategory: { [target]: "   " } }),
        false,
      );
      check(
        `${label} 중 [${target}] 1곳만 공백 → 그 카테고리 정확 지목`,
        one?.firstMissingField === field && one?.firstMissingCategory === target,
        `cat=${one?.firstMissingCategory} field=${one?.firstMissingField}`,
      );
    }

    // 확장류: 확장 주간이 아니면 검사 대상 아님(기존 링크/이미지 정책과 동일).
    const extOnlyBlank = outs({ field, valueByCategory: { extension: "" } });
    check(
      `확장 주간 아님 → 확장류 ${label} 미검사`,
      validateOverallOutputRequirements(extOnlyBlank, false) === null,
    );
    const extActive = validateOverallOutputRequirements(extOnlyBlank, true);
    check(
      `확장 주간 → 확장류 ${label}도 필수`,
      extActive?.firstMissingField === field && extActive?.firstMissingCategory === "extension",
      `cat=${extActive?.firstMissingCategory}`,
    );
  }

  // 우선순위(화면 한 행 좌→우): 링크 → 설명 → 이미지 → 이미지 설명.
  //   4칸을 전부 비우고 하나씩 채워가며 안내 순서가 그대로인지 본다.
  console.log("  — 안내 우선순위(링크 → 설명 → 이미지 → 이미지 설명)");
  const blankAll: OverallOutput[] = ALL_CATS.map((key) => ({
    category: key,
    link: "",
    description: "",
    imageUrl: "",
    imageDescription: "",
  }));
  const order: OverallOutputRequiredField[] = ["link", "description", "image", "imageDescription"];
  const fill: Record<OverallOutputRequiredField, (o: OverallOutput) => OverallOutput> = {
    link: (o) => ({ ...o, link: "https://example.com" }),
    description: (o) => ({ ...o, description: "설명" }),
    image: (o) => ({ ...o, imageUrl: "https://example.com/a.png" }),
    imageDescription: (o) => ({ ...o, imageDescription: "이미지 설명" }),
  };
  let rows = blankAll;
  for (const expected of order) {
    const issue = validateOverallOutputRequirements(rows, false);
    check(
      `남은 누락 중 [${expected}] 우선 안내`,
      issue?.firstMissingField === expected &&
        issue?.message === OVERALL_OUTPUT_REQUIRED_MESSAGES[expected],
      `field=${issue?.firstMissingField}`,
    );
    rows = rows.map(fill[expected]);
  }
  check("4칸 모두 채우면 통과(null)", validateOverallOutputRequirements(rows, false) === null);
}

// ────────────── [B][C] HTTP 가드 — 전 org × 모드 × action (+임퍼 경로 파리티) ──────────────
async function verifyHttpGuard(weekId: string) {
  console.log("\n=== [B] HTTP 가드 — 전 org × 일반/테스트 모드 × review/open ===");
  const blockedCases = DESC_FIELDS.flatMap(({ field, label, message }) => [
    { label: `${label} 빈 문자열`, values: outs({ field, value: "" }), message },
    { label: `${label} 공백만`, values: outs({ field, value: "   " }), message },
    { label: `${label} 필드 누락`, values: outs({ field, omitField: true }), message },
    // 여러 칸 중 하나(분석)만 누락 — 나머지는 정상.
    {
      label: `${label} 1곳(분석)만 누락`,
      values: outs({ field, valueByCategory: { analysis: " " } }),
      message,
    },
  ]);
  // 아웃풋 게이트만 관찰하기 위한 더미 팀 — 게이트가 DB write 보다 앞에 있으므로 데이터 변경 없음.
  const teamKey = "output-description-required-http-guard";
  const impersonationStatuses = new Map<string, string>();

  for (const organization of ORGANIZATIONS) {
    for (const mode of ["operating", "test"] as Mode[]) {
      for (const action of ["review", "open"] as const) {
        console.log(`  · ${organization}/${mode}/${action} …`);
        for (const scenario of blockedCases) {
          const { status, json } = await httpPost({
            action,
            organization,
            week_id: weekId,
            team_id: teamKey,
            team_name: teamKey,
            mode,
            leaderCells: [],
            outputs: scenario.values,
            lineSelections: [],
          });
          check(
            `[${organization}/${mode}/${action}] ${scenario.label} → 422 차단 + 전용 문구`,
            status === 422 && json.error === scenario.message,
            `status=${status} error=${String(json.error)}`,
          );
        }

        // 설명 충족 → 아웃풋 필수 게이트는 통과(더미 팀이므로 이후 다른 업무 사유로 막힐 수 있음).
        const okRes = await httpPost({
          action,
          organization,
          week_id: weekId,
          team_id: teamKey,
          team_name: teamKey,
          mode,
          leaderCells: [],
          outputs: outs(),
          lineSelections: [],
        });
        const outputGateMessages: string[] = [
          OVERALL_OUTPUT_REQUIRED_MESSAGES.link,
          OVERALL_OUTPUT_REQUIRED_MESSAGES.description,
          OVERALL_OUTPUT_REQUIRED_MESSAGES.image,
          OVERALL_OUTPUT_REQUIRED_MESSAGES.imageDescription,
        ];
        check(
          `[${organization}/${mode}/${action}] 설명 2종 정상 → 아웃풋 게이트 통과`,
          !outputGateMessages.includes(String(okRes.json.error)),
          `status=${okRes.status} error=${String(okRes.json.error ?? "(없음)")}`,
        );

        // [C] 임퍼소네이션(actAsTestUserId) 경로 파리티 — 같은 body + actAsTestUserId. 설명 2종 각각.
        for (const { field } of DESC_FIELDS) {
          const impRes = await httpPost({
            action,
            organization,
            week_id: weekId,
            team_id: teamKey,
            team_name: teamKey,
            mode,
            leaderCells: [],
            outputs: outs({ field, value: "   " }),
            lineSelections: [],
            actAsTestUserId: "00000000-0000-0000-0000-000000000000",
          });
          impersonationStatuses.set(
            `${organization}/${mode}/${action}/${field}`,
            `${impRes.status}:${String(impRes.json.error)}`,
          );
        }
      }
    }
  }

  console.log("\n=== [C] 임퍼소네이션(actAsTestUserId) 경로 = 일반 경로 동일 판정 ===");
  for (const { field, label, message } of DESC_FIELDS) {
    const seen = new Set(
      [...impersonationStatuses.entries()]
        .filter(([k]) => k.endsWith(`/${field}`))
        .map(([, v]) => v),
    );
    check(
      `actAsTestUserId 경로도 ${label} 공백 → 동일 422 + 동일 문구(별도 검증 로직 없음)`,
      seen.size === 1 && [...seen][0] === `422:${message}`,
      [...seen].join(" / "),
    );
  }
}

// ────────────── [D] 실제 저장 성공 + DTO/snapshot 불변 (클린 (T)팀, 실행 후 원복) ──────────────
type Target = {
  org: string;
  teamId: string;
  teamName: string;
  weekId: string;
  weekLabel: string;
  board: BoardDto;
};

// 개설 가능 후보 탐색 — diag-experience-overall-open-candidates.ts 와 동일한 원천을 쓴다:
//   cluster4_week_opening_configs(open_confirmed) → config.practicalExperience 에 켜진 (week, team).
//   무작정 팀×주차를 훑는 대신 "실제로 개설 대상으로 설정된" 조합만 보므로 훨씬 빠르고 적중률이 높다.
//   클린-슬레이트(overall 헤더 없음)만 대상 — 기존 검수/개설 데이터는 건드리지 않는다.
async function discover(mode: Mode, weekLabels: Map<string, string>): Promise<Target | null> {
  const { data: configs } = await sb
    .from("cluster4_week_opening_configs")
    .select("week_id,organization_slug,config,updated_at")
    .eq("open_confirmed", true)
    .order("updated_at", { ascending: false })
    .limit(60);
  for (const row of (configs ?? []) as Array<{
    week_id: string;
    organization_slug: string;
    config: Record<string, unknown> | null;
  }>) {
    if (!(ORGANIZATIONS as readonly string[]).includes(row.organization_slug)) continue;
    const pe = (
      row.config as {
        practicalExperience?: Record<string, boolean | Record<string, boolean>>;
      } | null
    )?.practicalExperience;
    const teamIds = Object.entries(pe ?? {})
      .filter(([, v]) => (typeof v === "boolean" ? v : Object.values(v ?? {}).some(Boolean)))
      .map(([k]) => k);
    for (const teamId of teamIds) {
      const { data: hdr } = await sb
        .from("cluster4_experience_team_overall")
        .select("id")
        .eq("organization_slug", row.organization_slug)
        .eq("week_id", row.week_id)
        .eq("team_id", teamId)
        .maybeSingle();
      if (hdr) continue; // 클린-슬레이트만(기존 검수/개설 데이터 훼손 금지).
      const teamName = await resolveTeamNameById(teamId).catch(() => null);
      if (!teamName) continue;
      let board: BoardDto;
      try {
        board = await getTeamOverallBoard(row.organization_slug, row.week_id, teamId, teamName, mode);
      } catch {
        continue;
      }
      if (!board.canOpen || !board.application?.allPartsApplied) continue;
      const hasOptions = (["derivation", "analysis", "evaluation"] as PartCat[]).every(
        (c) => (board.lineOptions[c]?.length ?? 0) > 0,
      );
      if (!hasOptions) continue;
      return {
        org: row.organization_slug,
        teamId,
        teamName,
        weekId: row.week_id,
        weekLabel: weekLabels.get(row.week_id) ?? row.week_id,
        board,
      };
    }
  }
  return null;
}

const outputDtoShapes = new Set<string>();

async function verifyRealSave(mode: Mode, tgt: Target) {
  const { org, teamId, teamName, weekId, weekLabel, board } = tgt;
  console.log(`\n=== [D] 실제 저장 — [${mode}] ${org} / ${teamName} / ${weekLabel} ===`);

  const crews = board.parts.flatMap((p) => p.crews);
  const mgmtOptId = board.lineOptions.management?.[0]?.id ?? null;
  const leaderCells = crews
    .filter((c) => c.isPartLeader || c.statusLabel === "에이전트")
    .map((c) => ({
      crewUserId: c.userId,
      category: "management" as const,
      checked: true,
      score: 7,
      selectedLineId: mgmtOptId,
    }));
  // 파트장 라인명 게이트 통과 — 전 파트장 미체크(라인 불필요). 이 스크립트의 관심은 아웃풋 설명뿐.
  const lineSelections = crews
    .filter((c) => c.isPartLeader)
    .flatMap((c) =>
      (["derivation", "analysis", "evaluation"] as PartCat[]).map((lt) => ({
        crewUserId: c.userId,
        lineType: lt,
        selectedLineId: null,
        checked: false,
        score: 0,
      })),
    );
  const bodyBase = {
    organization: org,
    week_id: weekId,
    team_id: teamId,
    team_name: teamName,
    mode,
    leaderCells,
    lineSelections,
  };

  const { count: snapBefore } = await sb
    .from("cluster4_weekly_card_snapshots")
    .select("*", { count: "exact", head: true });

  // 실 대상에서도 설명 2종 누락은 각각 차단(더미 팀 결과가 우연이 아님을 확인).
  for (const { field, label, message } of DESC_FIELDS) {
    const blocked = await httpPost({
      ...bodyBase,
      action: "review",
      outputs: outs({ field, value: "  " }),
    });
    check(
      `실 대상 ${label} 공백 → 422 차단`,
      blocked.status === 422 && blocked.json.error === message,
      `status=${blocked.status} error=${String(blocked.json.error)}`,
    );
    const { data: hdrAfterBlocked } = await sb
      .from("cluster4_experience_team_overall")
      .select("id")
      .eq("organization_slug", org)
      .eq("week_id", weekId)
      .eq("team_id", teamId);
    check(`${label} 차단 시 DB write 없음(헤더 미생성)`, (hdrAfterBlocked ?? []).length === 0);
  }

  // 설명 2종 정상 → 검수 성공. 카테고리별로 서로 다른 값을 넣어 저장/재조회를 대조한다.
  const goodOutputs: OverallOutput[] = ALL_CATS.map((key) => ({
    category: key,
    link: `https://example.com/${key}`,
    description: `설명-${key}`,
    imageUrl: `https://example.com/${key}.png`,
    imageDescription: `이미지설명-${key}`,
  }));
  const rev = await httpPost({ ...bodyBase, action: "review", outputs: goodOutputs });
  check("설명 2종 정상 → 검수 201 성공", rev.status === 201 && rev.json.success === true, `status=${rev.status} ${String(rev.json.error ?? "")}`);

  const { data: hdrRow } = await sb
    .from("cluster4_experience_team_overall")
    .select("id")
    .eq("organization_slug", org)
    .eq("week_id", weekId)
    .eq("team_id", teamId)
    .maybeSingle();
  const overallId = (hdrRow as { id: string } | null)?.id ?? null;
  const { data: outRows } = await sb
    .from("cluster4_experience_team_overall_outputs")
    .select("category,output_link,output_description,output_image_url,output_image_description")
    .eq("overall_id", overallId ?? "x");
  const savedRows = new Map(
    (
      (outRows ?? []) as Array<{
        category: string;
        output_description: string | null;
        output_image_description: string | null;
      }>
    ).map((r) => [r.category, r]),
  );
  const activeCats = ALL_CATS.filter((c) => c !== "extension" || board.extensionActive);
  check(
    "링크 설명이 output_description 컬럼에 저장(활성 류 전부)",
    activeCats.every((c) => savedRows.get(c)?.output_description === `설명-${c}`),
    activeCats.map((c) => `${c}=${savedRows.get(c)?.output_description}`).join(", "),
  );
  check(
    "이미지 설명이 output_image_description 컬럼에 저장(활성 류 전부)",
    activeCats.every((c) => savedRows.get(c)?.output_image_description === `이미지설명-${c}`),
    activeCats.map((c) => `${c}=${savedRows.get(c)?.output_image_description}`).join(", "),
  );

  // 보드 재조회 — 아웃풋 DTO 키 불변(기존 저장/조회 DTO 변경 없음).
  const got = await httpGetBoard(org, weekId, teamId, teamName, mode);
  const gotOutputs = got.json.data?.outputs ?? [];
  for (const o of gotOutputs) outputDtoShapes.add(Object.keys(o).sort().join(","));
  const roundTripped = new Map(gotOutputs.map((o) => [o.category, o]));
  check(
    "재조회 DTO 설명 2종 라운드트립 일치",
    activeCats.every(
      (c) =>
        roundTripped.get(c)?.description === `설명-${c}` &&
        roundTripped.get(c)?.imageDescription === `이미지설명-${c}`,
    ),
    activeCats
      .map((c) => `${c}=${roundTripped.get(c)?.description}/${roundTripped.get(c)?.imageDescription}`)
      .join(", "),
  );

  // 설명 정상 → 개설 완료 성공.
  const openRes = await httpPost({ ...bodyBase, action: "open", outputs: goodOutputs });
  check("설명 2종 정상 → 개설 완료 201 성공", openRes.status === 201 && openRes.json.success === true, `status=${openRes.status} ${String(openRes.json.error ?? "")}`);

  const { data: openedLines } = await sb
    .from("cluster4_experience_team_overall_opened_lines")
    .select("line_id")
    .eq("overall_id", overallId ?? "x");
  const lineIds = ((openedLines ?? []) as Array<{ line_id: string }>).map((r) => r.line_id);

  const { count: snapAfter } = await sb
    .from("cluster4_weekly_card_snapshots")
    .select("*", { count: "exact", head: true });
  check(
    "snapshot 생성 로직 무영향(count 불변)",
    (snapAfter ?? 0) === (snapBefore ?? 0),
    `${snapBefore}→${snapAfter}`,
  );

  // ── 원복 ──
  const cancelRes = await httpPost({ ...bodyBase, action: "cancel", leaderCells: [], lineSelections: [] });
  check("[원복] cancel 성공", cancelRes.status === 200 && cancelRes.json.success === true, `status=${cancelRes.status}`);
  await sb
    .from("cluster4_experience_team_overall")
    .delete()
    .eq("organization_slug", org)
    .eq("week_id", weekId)
    .eq("team_id", teamId);
  const { data: linesResidue } = await sb
    .from("cluster4_lines")
    .select("id")
    .in("id", lineIds.length ? lineIds : ["x"]);
  check("[원복] 개설 라인 잔여 0", (linesResidue ?? []).length === 0);
  const { data: hdrResidue } = await sb
    .from("cluster4_experience_team_overall")
    .select("id")
    .eq("organization_slug", org)
    .eq("week_id", weekId)
    .eq("team_id", teamId);
  check("[원복] team_overall 헤더 잔여 0", (hdrResidue ?? []).length === 0);
}

async function main() {
  verifyPureValidator();

  authCookie = await adminCookieHeader();
  const { data: recentWeeks } = await sb
    .from("weeks")
    .select("id,week_number,start_date,season_key")
    .not("week_number", "is", null)
    .order("start_date", { ascending: false })
    .limit(20);
  const nonRestWeeks: Array<{ id: string; label: string }> = [];
  for (const w of (recentWeeks ?? []) as Array<{
    id: string;
    week_number: number;
    start_date: string;
    season_key: string | null;
  }>) {
    const { rest } = await isWeekOfficialRestById(w.id);
    if (!rest) nonRestWeeks.push({ id: w.id, label: `${w.season_key ?? "?"} W${w.week_number} (${w.start_date})` });
  }
  if (nonRestWeeks.length === 0) throw new Error("검증용 비휴식 주차 없음");

  await verifyHttpGuard(nonRestWeeks[0].id);

  const weekLabels = new Map(nonRestWeeks.map((w) => [w.id, w.label]));
  let ran = 0;
  for (const mode of ["test", "operating"] as Mode[]) {
    const tgt = await discover(mode, weekLabels);
    if (!tgt) {
      console.log(`\n- [D] ${mode}: 클린-슬레이트 개설가능 팀 없음 → 실 저장 케이스 skip`);
      continue;
    }
    await verifyRealSave(mode, tgt);
    ran++;
  }

  console.log("\n=== 기존 저장/조회 DTO 불변 ===");
  check(
    "아웃풋 DTO 키 1종(category,description,imageDescription,imageUrl,link)",
    outputDtoShapes.size <= 1 &&
      (outputDtoShapes.size === 0 ||
        [...outputDtoShapes][0] === "category,description,imageDescription,imageUrl,link"),
    [...outputDtoShapes].join(" / ") || "(실 저장 케이스 미실행)",
  );

  console.log(`\n결과: ${pass} pass / ${fail} fail (실 저장 대상 ${ran}건)`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
