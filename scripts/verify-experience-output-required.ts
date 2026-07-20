import { config } from "dotenv";
config({ path: ".env.local" });
import { createClient } from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";
import {
  EXPERIENCE_OVERALL_CATEGORIES,
  OVERALL_OUTPUT_REQUIRED_MESSAGES,
  PART_LEADER_LINE_REQUIRED_MESSAGE,
  validateOverallOutputRequirements,
  validatePartLeaderLineRequirements,
  type OverallOutput,
} from "@/lib/experienceTeamOverallTypes";

const BASE = process.env.SMOKE_BASE_URL ?? "http://localhost:3000";
const ADMIN_EMAIL = process.env.SMOKE_ADMIN_EMAIL ?? "vanuatu.golden@gmail.com";
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const ANON = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const admin = createClient(SUPABASE_URL, SERVICE);

function outputs(link: string, imageUrl: string): OverallOutput[] {
  return EXPERIENCE_OVERALL_CATEGORIES.map(({ key }) => ({
    category: key,
    link,
    imageUrl,
    description: "",
    imageDescription: "",
  }));
}

function check(label: string, condition: boolean, detail = "") {
  if (!condition) throw new Error(`${label}: ${detail}`);
  console.log(`✓ ${label}${detail ? ` — ${detail}` : ""}`);
}

async function cookieHeader(): Promise<string> {
  const browser = createClient(SUPABASE_URL, ANON);
  const { data: link, error } = await admin.auth.admin.generateLink({ type: "magiclink", email: ADMIN_EMAIL });
  if (error) throw error;
  const { data: verified, error: verifyError } = await browser.auth.verifyOtp({
    email: ADMIN_EMAIL,
    token: link.properties.email_otp!,
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

async function main() {
  check("링크+이미지 누락 시 링크 우선", validateOverallOutputRequirements(outputs("", ""), false)?.message === OVERALL_OUTPUT_REQUIRED_MESSAGES.link);
  check("링크만 누락", validateOverallOutputRequirements(outputs("", "https://example.com/a.png"), false)?.message === OVERALL_OUTPUT_REQUIRED_MESSAGES.link);
  check("이미지만 누락", validateOverallOutputRequirements(outputs("https://example.com", ""), false)?.message === OVERALL_OUTPUT_REQUIRED_MESSAGES.image);
  check("링크+이미지 충족", validateOverallOutputRequirements(outputs("https://example.com", "https://example.com/a.png"), false) === null);
  check("확장 주간에는 확장류도 필수", validateOverallOutputRequirements(outputs("https://example.com", "https://example.com/a.png").filter((o) => o.category !== "extension"), true)?.firstMissingCategory === "extension");
  const leaderSelections = ["derivation", "analysis", "evaluation"].map((lineType) => ({
    crewUserId: "leader-1",
    lineType: lineType as "derivation" | "analysis" | "evaluation",
    selectedLineId: lineType === "derivation" ? null : `line-${lineType}`,
    checked: true,
    score: 7,
  }));
  check("파트장 라인명 미선택 차단", validatePartLeaderLineRequirements(leaderSelections, ["leader-1"])?.message === PART_LEADER_LINE_REQUIRED_MESSAGE);
  check("파트장 보이드 셀은 제외", validatePartLeaderLineRequirements([{ ...leaderSelections[0], checked: false, score: 0 }], ["leader-1"])?.category === "analysis");

  const { data: week } = await admin.from("weeks").select("id").limit(1).single();
  if (!week?.id) throw new Error("HTTP 검증용 week 없음");
  const cookie = await cookieHeader();
  const httpCases = [
    { label: "링크+이미지 없음(링크 우선)", values: outputs("", ""), message: OVERALL_OUTPUT_REQUIRED_MESSAGES.link },
    { label: "링크 없음", values: outputs("", "https://example.com/a.png"), message: OVERALL_OUTPUT_REQUIRED_MESSAGES.link },
    { label: "이미지 없음", values: outputs("https://example.com", ""), message: OVERALL_OUTPUT_REQUIRED_MESSAGES.image },
  ];
  for (const action of ["review", "open"] as const) {
    for (const mode of ["operating", "test"] as const) {
      for (const scenario of httpCases) {
      const response = await fetch(`${BASE}/api/admin/cluster4/experience/team-overall`, {
        method: "POST",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({
          action,
          organization: mode === "test" ? "encre" : "oranke",
          week_id: week.id,
          team_id: "output-required-http-guard",
          team_name: "output-required-http-guard",
          mode,
          leaderCells: [],
          outputs: scenario.values,
          lineSelections: [],
        }),
      });
      const json = await response.json();
      check(`HTTP ${action}/${mode} ${scenario.label} 차단`, response.status === 422 && json.error === scenario.message, `status=${response.status}`);
      }
    }
  }

  const { data: leaders } = await admin
    .from("user_profiles")
    .select("user_id,organization_slug")
    .eq("role", "part_leader");
  const leaderIds = (leaders ?? []).map((leader) => leader.user_id);
  const { data: memberships } = leaderIds.length
    ? await admin
        .from("user_memberships")
        .select("user_id,team_name,is_current")
        .in("user_id", leaderIds)
        .eq("is_current", true)
    : { data: [] };
  const { data: markers } = leaderIds.length
    ? await admin.from("test_user_markers").select("user_id").in("user_id", leaderIds)
    : { data: [] };
  const testIds = new Set((markers ?? []).map((marker) => marker.user_id));
  const membershipByUser = new Map((memberships ?? []).map((membership) => [membership.user_id, membership]));
  for (const mode of ["operating", "test"] as const) {
    const leader = (leaders ?? []).find((candidate) =>
      Boolean(membershipByUser.get(candidate.user_id)?.team_name) &&
      testIds.has(candidate.user_id) === (mode === "test"),
    );
    if (!leader) {
      console.log(`- HTTP 파트장 라인명 ${mode}: 대상 데이터 없음(순수 판정은 검증됨)`);
      continue;
    }
    const teamName = membershipByUser.get(leader.user_id)!.team_name;
    const boardResponse = await fetch(
      `${BASE}/api/admin/cluster4/experience/team-overall?organization=${encodeURIComponent(leader.organization_slug)}&week_id=${week.id}&team_id=part-leader-line-http-guard&team_name=${encodeURIComponent(teamName)}&mode=${mode}`,
      { headers: { cookie } },
    );
    const boardJson = await boardResponse.json();
    const hasScopedLeader = (boardJson.data?.parts ?? []).some((part: { crews?: Array<{ isPartLeader?: boolean }> }) =>
      (part.crews ?? []).some((crew) => crew.isPartLeader),
    );
    if (!hasScopedLeader) {
      console.log(`- HTTP 파트장 라인명 ${mode}: 현재 보드 스코프에 대상 파트장 없음(순수 판정은 검증됨)`);
      continue;
    }
    for (const action of ["review", "open"] as const) {
      const response = await fetch(`${BASE}/api/admin/cluster4/experience/team-overall`, {
        method: "POST",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({
          action,
          organization: leader.organization_slug,
          week_id: week.id,
          team_id: "part-leader-line-http-guard",
          team_name: teamName,
          mode,
          leaderCells: [],
          outputs: outputs("https://example.com", "https://example.com/a.png"),
          lineSelections: [],
        }),
      });
      const json = await response.json();
      check(`HTTP ${action}/${mode} 파트장 라인명 차단`, response.status === 422 && json.error === PART_LEADER_LINE_REQUIRED_MESSAGE, `status=${response.status}`);
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
