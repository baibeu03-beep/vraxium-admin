/**
 * verify-experience-output-description-required-http.ts
 * 실무 경험 [팀 총괄] 개설 검수/완료 — 아웃풋 **설명**(설명1) 필수 입력 검증.
 *   요구(2026-07-27): /admin/integrated/line-opening/practical-experience 의 산출물 링크 설명이
 *   선택 → **필수**. 공백만 입력한 값도 누락으로 판정(trim). mode/org 무관 동일 정책이며,
 *   프론트 `required` 뿐 아니라 **서버 API 도 같은 함수로** 차단한다.
 *
 * 검증:
 *   [A] 순수 판정 SoT(validateOverallOutputRequirements) — 프론트/서버 공용 단일 함수.
 *       빈 문자열·공백만·필드 누락 모두 차단 / 여러 설명 중 1곳만 누락 시 그 카테고리를 정확히 지목 /
 *       우선순위 링크 → 설명 → 이미지 / 확장류는 확장 주간에만 검사.
 *   [B] 실제 HTTP 가드 — 전 org(encre·oranke·phalanx) × 일반(operating)·테스트(test) ×
 *       review·open 에서 설명 누락 = 422 + 동일 문구, 설명 충족 = 아웃풋 게이트 통과.
 *   [C] 임퍼소네이션(actAsTestUserId) 경로 = 일반 사용자 경로와 동일 status/문구(별도 검증 로직 없음).
 *       ※ 이 라우트에 demoUserId 개념은 없다(고객 앱 전용) — 임퍼소네이션이 그 대응 경로.
 *   [D] 실제 저장 성공 라운드트립 — 클린-슬레이트 (T)팀에 설명 정상 입력 → review/open 201,
 *       DB output_description 저장, 보드 재조회 아웃풋 DTO 키 불변, weekly_card_snapshots count 불변.
 *       같은 대상에서 설명만 비우면 422(실 대상에서도 차단). 실행 후 완전 원복.
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

// 링크/이미지는 항상 채우고 설명만 케이스별로 바꾼다 — 설명 필수 여부를 단독 변수로 관찰하기 위함.
function outs(opts?: {
  description?: string;
  descriptionByCategory?: Partial<Record<ExperienceOverallCategory, string>>;
  omitDescriptionField?: boolean;
}): OverallOutput[] {
  return ALL_CATS.map((key) => {
    const base = {
      category: key,
      link: `https://example.com/${key}`,
      imageUrl: `https://example.com/${key}.png`,
      imageDescription: "이미지 설명(선택 항목)",
    };
    if (opts?.omitDescriptionField) return base as unknown as OverallOutput;
    return {
      ...base,
      description: opts?.descriptionByCategory?.[key] ?? opts?.description ?? "산출물 설명",
    };
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

async function httpPost(cookie: string, body: unknown) {
  const res = await fetch(`${BASE}/api/admin/cluster4/experience/team-overall`, {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json().catch(() => ({}))) as Record<string, unknown> };
}

async function httpGetBoard(
  cookie: string,
  org: string,
  weekId: string,
  teamId: string,
  teamName: string,
  mode: Mode,
) {
  const url =
    `${BASE}/api/admin/cluster4/experience/team-overall?organization=${org}` +
    `&week_id=${weekId}&team_id=${teamId}&team_name=${encodeURIComponent(teamName)}&mode=${mode}`;
  const res = await fetch(url, { headers: { cookie } });
  return { status: res.status, json: (await res.json()) as { data?: BoardDto } };
}

// ───────────────────────── [A] 순수 판정 SoT ─────────────────────────
function verifyPureValidator() {
  console.log("\n=== [A] 순수 판정 SoT — 프론트/서버 공용 validateOverallOutputRequirements ===");
  const DESC = OVERALL_OUTPUT_REQUIRED_MESSAGES.description;

  check("설명 정상 입력 → 통과(null)", validateOverallOutputRequirements(outs(), false) === null);

  const empty = validateOverallOutputRequirements(outs({ description: "" }), false);
  check(
    "설명 빈 문자열 → 차단 + 설명 문구",
    empty?.firstMissingField === "description" && empty?.message === DESC && empty?.missingDescription === true,
    `field=${empty?.firstMissingField} msg=${empty?.message}`,
  );

  for (const blank of [" ", "   ", "\t", "\n", " \t\n "]) {
    const ws = validateOverallOutputRequirements(outs({ description: blank }), false);
    check(
      `설명 공백만(${JSON.stringify(blank)}) → 차단(trim 판정)`,
      ws?.firstMissingField === "description" && ws?.message === DESC,
      `field=${ws?.firstMissingField}`,
    );
  }

  const omitted = validateOverallOutputRequirements(outs({ omitDescriptionField: true }), false);
  check(
    "설명 필드 자체 누락(구버전 클라) → 차단",
    omitted?.firstMissingField === "description" && omitted?.message === DESC,
    `field=${omitted?.firstMissingField}`,
  );

  // 여러 설명 중 하나만 누락 → 그 카테고리를 정확히 지목(화면 강조/스크롤 대상 = 이 값).
  for (const target of ALL_CATS.filter((c) => c !== "extension")) {
    const one = validateOverallOutputRequirements(
      outs({ descriptionByCategory: { [target]: "   " } }),
      false,
    );
    check(
      `여러 설명 중 [${target}] 1곳만 공백 → 그 카테고리 정확 지목`,
      one?.firstMissingField === "description" && one?.firstMissingCategory === target,
      `cat=${one?.firstMissingCategory} field=${one?.firstMissingField}`,
    );
  }

  // 우선순위: 링크 → 설명 → 이미지.
  const linkFirst = validateOverallOutputRequirements(
    outs({ description: "" }).map((o) => ({ ...o, link: "" })),
    false,
  );
  check(
    "링크·설명 동시 누락 → 링크 우선 안내",
    linkFirst?.firstMissingField === "link" && linkFirst?.missingDescription === true,
    `field=${linkFirst?.firstMissingField}`,
  );
  const descBeforeImage = validateOverallOutputRequirements(
    outs({ description: "" }).map((o) => ({ ...o, imageUrl: "" })),
    false,
  );
  check(
    "설명·이미지 동시 누락 → 설명 우선 안내",
    descBeforeImage?.firstMissingField === "description" && descBeforeImage?.missingImage === true,
    `field=${descBeforeImage?.firstMissingField}`,
  );

  // 확장류: 확장 주간이 아니면 설명도 검사 대상 아님(기존 링크/이미지 정책과 동일).
  const extOnlyBlank = outs({ descriptionByCategory: { extension: "" } });
  check(
    "확장 주간 아님 → 확장류 설명 미검사",
    validateOverallOutputRequirements(extOnlyBlank, false) === null,
  );
  const extActive = validateOverallOutputRequirements(extOnlyBlank, true);
  check(
    "확장 주간 → 확장류 설명도 필수",
    extActive?.firstMissingField === "description" && extActive?.firstMissingCategory === "extension",
    `cat=${extActive?.firstMissingCategory}`,
  );
}

// ────────────── [B][C] HTTP 가드 — 전 org × 모드 × action (+임퍼 경로 파리티) ──────────────
async function verifyHttpGuard(cookie: string, weekId: string) {
  console.log("\n=== [B] HTTP 가드 — 전 org × 일반/테스트 모드 × review/open ===");
  const DESC = OVERALL_OUTPUT_REQUIRED_MESSAGES.description;
  const blockedCases = [
    { label: "설명 빈 문자열", values: outs({ description: "" }) },
    { label: "설명 공백만", values: outs({ description: "   " }) },
    { label: "설명 필드 누락", values: outs({ omitDescriptionField: true }) },
    // 여러 설명 중 하나(분석)만 누락 — 나머지는 정상.
    { label: "설명 1곳(분석)만 누락", values: outs({ descriptionByCategory: { analysis: " " } }) },
  ];
  // 아웃풋 게이트만 관찰하기 위한 더미 팀 — 게이트가 DB write 보다 앞에 있으므로 데이터 변경 없음.
  const teamKey = "output-description-required-http-guard";
  const impersonationStatuses = new Map<string, string>();

  for (const organization of ORGANIZATIONS) {
    for (const mode of ["operating", "test"] as Mode[]) {
      for (const action of ["review", "open"] as const) {
        console.log(`  · ${organization}/${mode}/${action} …`);
        for (const scenario of blockedCases) {
          const { status, json } = await httpPost(cookie, {
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
            `[${organization}/${mode}/${action}] ${scenario.label} → 422 차단 + 설명 문구`,
            status === 422 && json.error === DESC,
            `status=${status} error=${String(json.error)}`,
          );
        }

        // 설명 충족 → 아웃풋 필수 게이트는 통과(더미 팀이므로 이후 다른 업무 사유로 막힐 수 있음).
        const okRes = await httpPost(cookie, {
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
        ];
        check(
          `[${organization}/${mode}/${action}] 설명 정상 → 아웃풋 게이트 통과`,
          !outputGateMessages.includes(String(okRes.json.error)),
          `status=${okRes.status} error=${String(okRes.json.error ?? "(없음)")}`,
        );

        // [C] 임퍼소네이션(actAsTestUserId) 경로 파리티 — 같은 body + actAsTestUserId.
        const impRes = await httpPost(cookie, {
          action,
          organization,
          week_id: weekId,
          team_id: teamKey,
          team_name: teamKey,
          mode,
          leaderCells: [],
          outputs: outs({ description: "   " }),
          lineSelections: [],
          actAsTestUserId: "00000000-0000-0000-0000-000000000000",
        });
        impersonationStatuses.set(
          `${organization}/${mode}/${action}`,
          `${impRes.status}:${String(impRes.json.error)}`,
        );
      }
    }
  }

  console.log("\n=== [C] 임퍼소네이션(actAsTestUserId) 경로 = 일반 경로 동일 판정 ===");
  const distinct = new Set(impersonationStatuses.values());
  check(
    "actAsTestUserId 경로도 설명 공백 → 동일 422 + 동일 문구(별도 검증 로직 없음)",
    distinct.size === 1 && [...distinct][0] === `422:${DESC}`,
    [...distinct].join(" / "),
  );
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

async function verifyRealSave(cookie: string, mode: Mode, tgt: Target) {
  const { org, teamId, teamName, weekId, weekLabel, board } = tgt;
  console.log(`\n=== [D] 실제 저장 — [${mode}] ${org} / ${teamName} / ${weekLabel} ===`);
  const DESC = OVERALL_OUTPUT_REQUIRED_MESSAGES.description;

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

  // 실 대상에서도 설명 누락은 차단(더미 팀 결과가 우연이 아님을 확인).
  const blocked = await httpPost(cookie, { ...bodyBase, action: "review", outputs: outs({ description: "  " }) });
  check("실 대상 설명 공백 → 422 차단", blocked.status === 422 && blocked.json.error === DESC, `status=${blocked.status}`);
  const { data: hdrAfterBlocked } = await sb
    .from("cluster4_experience_team_overall")
    .select("id")
    .eq("organization_slug", org)
    .eq("week_id", weekId)
    .eq("team_id", teamId);
  check("차단 시 DB write 없음(헤더 미생성)", (hdrAfterBlocked ?? []).length === 0);

  // 설명 정상 → 검수 성공.
  const descByCat: Partial<Record<ExperienceOverallCategory, string>> = {};
  for (const key of ALL_CATS) descByCat[key] = `설명-${key}`;
  const goodOutputs = outs({ descriptionByCategory: descByCat });
  const rev = await httpPost(cookie, { ...bodyBase, action: "review", outputs: goodOutputs });
  check("설명 정상 → 검수 201 성공", rev.status === 201 && rev.json.success === true, `status=${rev.status} ${String(rev.json.error ?? "")}`);

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
  const savedDesc = new Map(
    ((outRows ?? []) as Array<{ category: string; output_description: string | null }>).map((r) => [
      r.category,
      r.output_description,
    ]),
  );
  const activeCats = ALL_CATS.filter((c) => c !== "extension" || board.extensionActive);
  check(
    "설명이 output_description 컬럼에 저장(활성 류 전부)",
    activeCats.every((c) => savedDesc.get(c) === `설명-${c}`),
    activeCats.map((c) => `${c}=${savedDesc.get(c)}`).join(", "),
  );

  // 보드 재조회 — 아웃풋 DTO 키 불변(기존 저장/조회 DTO 변경 없음).
  const got = await httpGetBoard(cookie, org, weekId, teamId, teamName, mode);
  const gotOutputs = got.json.data?.outputs ?? [];
  for (const o of gotOutputs) outputDtoShapes.add(Object.keys(o).sort().join(","));
  const roundTripped = new Map(gotOutputs.map((o) => [o.category, o.description]));
  check(
    "재조회 DTO 설명 라운드트립 일치",
    activeCats.every((c) => roundTripped.get(c) === `설명-${c}`),
    activeCats.map((c) => `${c}=${roundTripped.get(c)}`).join(", "),
  );

  // 설명 정상 → 개설 완료 성공.
  const openRes = await httpPost(cookie, { ...bodyBase, action: "open", outputs: goodOutputs });
  check("설명 정상 → 개설 완료 201 성공", openRes.status === 201 && openRes.json.success === true, `status=${openRes.status} ${String(openRes.json.error ?? "")}`);

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
  const cancelRes = await httpPost(cookie, { ...bodyBase, action: "cancel", leaderCells: [], lineSelections: [] });
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

  const cookie = await adminCookieHeader();
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

  await verifyHttpGuard(cookie, nonRestWeeks[0].id);

  const weekLabels = new Map(nonRestWeeks.map((w) => [w.id, w.label]));
  let ran = 0;
  for (const mode of ["test", "operating"] as Mode[]) {
    const tgt = await discover(mode, weekLabels);
    if (!tgt) {
      console.log(`\n- [D] ${mode}: 클린-슬레이트 개설가능 팀 없음 → 실 저장 케이스 skip`);
      continue;
    }
    await verifyRealSave(cookie, mode, tgt);
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
