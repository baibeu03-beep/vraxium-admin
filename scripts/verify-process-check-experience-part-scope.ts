// 실무 경험 체크 — 팀·파트 스코프(실제 팀 구조 기준) direct==HTTP 검증 (2026-06-15 개정).
//   run: npx tsx --env-file=.env.local scripts/verify-process-check-experience-part-scope.ts
//   전제: admin dev(:3000) + process_check v2/v3 + (독립검증) v4(part_name). oranke F&B 파트 ≥2.
//   net-zero(TAG 시드 cleanup). user_weekly_points/snapshot 무접촉.
//
//   파트 출처 = user_memberships(실제 팀 파트, listTeamParts) — process_line_groups 아님.
//   액트 파트 여부 = 라인급명("파트" 포함). 파트별 체크 상태는 part_name 으로 독립(v4).
//   "direct" = listTeamParts(순수)+DB(process_check_statuses) / "HTTP" = GET 보드 + POST 가드.
import { createClient } from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";
import { listTeamParts } from "@/lib/adminExperiencePartInput";

const BASE = "http://localhost:3000";
const URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const ANON = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const sb = createClient(URL, SERVICE, { auth: { persistSession: false } });
const EMAIL = "vanuatu.golden@gmail.com";
const HUB = "experience";
const ORG = "oranke";
const TEAM_NAME = "F&B"; // 운영 팀(파트 ≥2)
const TAG = "ZZ-pchk-part";
const J = (o: unknown) => JSON.stringify(o);
const DAY = 86_400_000;
const iso = (ms: number) => new Date(ms).toISOString();

let pass = 0,
  fail = 0;
const ck = (l: string, ok: boolean, d = "") => {
  console.log(`  ${ok ? "✓" : "✗"} ${l}${d ? ` — ${d}` : ""}`);
  ok ? pass++ : fail++;
};

async function adminCookie(): Promise<string> {
  const brow = createClient(URL, ANON);
  const { data: link } = await sb.auth.admin.generateLink({ type: "magiclink", email: EMAIL });
  const { data: v } = await brow.auth.verifyOtp({
    email: EMAIL,
    token: link!.properties.email_otp,
    type: "magiclink",
  });
  const cap: { name: string; value: string }[] = [];
  const srv = createServerClient(URL, ANON, {
    cookies: { getAll: () => [], setAll: (items) => cap.push(...items) },
  });
  await srv.auth.setSession({
    access_token: v!.session!.access_token,
    refresh_token: v!.session!.refresh_token,
  });
  return cap.map((i) => `${i.name}=${i.value}`).join("; ");
}

let cookie = "";
const api = async (path: string, init: RequestInit = {}) => {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", cookie, ...(init.headers ?? {}) },
  });
  return { status: res.status, json: (await res.json().catch(() => ({}))) as any };
};

async function cleanup() {
  const g =
    (await sb.from("process_line_groups").select("id").eq("hub", HUB).like("name", `${TAG}%`)).data ?? [];
  const ids = (g as { id: string }[]).map((x) => x.id);
  if (ids.length) {
    const acts = (await sb.from("process_acts").select("id").in("line_group_id", ids)).data ?? [];
    const actIds = (acts as { id: string }[]).map((x) => x.id);
    if (actIds.length) {
      await sb.from("process_check_logs").delete().in("act_id", actIds);
      await sb.from("process_check_statuses").delete().in("act_id", actIds);
      await sb.from("process_acts").delete().in("id", actIds);
    }
    await sb.from("process_line_groups").delete().in("id", ids);
  }
}

const seedGroup = async (name: string) =>
  (await api("/api/admin/processes/line-groups", { method: "POST", body: J({ hub: HUB, name }) })).json
    .data?.id as string | undefined;
const seedAct = async (groupId: string, name: string) =>
  (
    await api("/api/admin/processes/acts", {
      method: "POST",
      body: J({
        line_group_id: groupId, hub: HUB, act_name: name, duration_minutes: 10,
        occur_week: "N", occur_dow: 2, occur_time: "06:30", check_week: "N", check_dow: 3, check_time: "21:00",
        point_check: 1, point_advantage: 0, point_penalty: 0, cafe: "occur", check_target: "check",
        act_type: "required", overview: null, remarks: null,
      }),
    })
  ).json.data as { id: string } | undefined;

const board = (teamId: string, scope: string, part?: string) =>
  api(`/api/admin/processes/check?hub=${HUB}&org=${ORG}&team=${teamId}&scope=${scope}${part ? `&part=${encodeURIComponent(part)}` : ""}`);
const post = (body: Record<string, unknown>) =>
  api("/api/admin/processes/check", { method: "POST", body: J(body) });
const findAct = (b: any, id: string) => (b?.acts ?? []).find((a: any) => a.actId === id) ?? null;
let HAS_V4 = false;
const dbStatus = async (actId: string, teamId: string, partName: string | null) => {
  const sel = HAS_V4 ? "status,part_name" : "status";
  let q = sb.from("process_check_statuses").select(sel).eq("organization_slug", ORG)
    .eq("hub", HUB).eq("act_id", actId).eq("team_id", teamId);
  if (HAS_V4) q = partName ? q.eq("part_name", partName) : q.is("part_name", null);
  return (await q.maybeSingle()).data as { status: string; part_name?: string | null } | null;
};

async function main() {
  cookie = await adminCookie();

  // 스키마 게이트 — v3(team_id) 필수, v4(part_name) 는 독립검증에만 필요.
  if ((await sb.from("process_check_statuses").select("team_id").limit(1)).error) {
    console.log("⚠ v3(team_id) 미적용 — 적용 후 재실행"); process.exit(2);
  }
  const v4 = !(await sb.from("process_check_statuses").select("part_name").limit(1)).error;
  HAS_V4 = v4;
  console.log(v4 ? "▶ v4(part_name) 적용됨 — 전체(파트 독립 포함) 검증" : "▶ v4 미적용 — 공통 검증 + 파트 write fail-closed 확인");

  await cleanup();

  // 팀/파트(실제 구조).
  const team = (await sb.from("cluster4_teams").select("id,team_name").eq("organization_slug", ORG).eq("team_name", TEAM_NAME).eq("is_active", true).maybeSingle()).data as { id: string } | null;
  ck(`[전제] 운영 팀 ${TEAM_NAME} 존재`, !!team);
  if (!team) { await cleanup(); process.exit(2); }
  const parts = await listTeamParts(ORG, TEAM_NAME, "operating");
  ck(`[전제] ${TEAM_NAME} 실제 파트 ≥2 (user_memberships)`, parts.length >= 2, J(parts));
  if (parts.length < 2) { await cleanup(); process.exit(2); }
  const P1 = parts[0], P2 = parts[1];
  // 다른 팀의 파트(이 팀 파트 아님) — 강제 422 용.
  const foreign = (await listTeamParts(ORG, "커머스", "operating")).find((p) => !parts.includes(p)) ?? "베네핏";

  // 시드 — 총괄 라인급 + 파트 라인급(이름에 "파트").
  const gOverall = await seedGroup(`${TAG} 총괄관리`);
  const gPart = await seedGroup(`${TAG} 가공파트`);
  const O1 = await seedAct(gOverall!, `${TAG} 총괄액트`);
  const PA = await seedAct(gPart!, `${TAG} 가공파트액트`);
  ck("[시드] 총괄/파트 라인급 + 체크 액트", !!gOverall && !!gPart && !!O1 && !!PA);

  // ── 1. 드롭다운 파트 = 실제 팀 파트(라인급 아님). direct(listTeamParts) == HTTP(board.teamParts) ──
  const bAll = (await board(team.id, "team_all")).json.data;
  ck("[드롭다운] HTTP teamParts == 실제 팀 파트(direct)", J([...bAll.teamParts].sort()) === J([...parts].sort()), J(bAll.teamParts));
  ck("[드롭다운] 파트 라인급 미등록이어도 실제 파트 노출", bAll.teamParts.includes(P1) && bAll.teamParts.includes(P2));

  // ── 2. 팀 전체(team_all) = 총괄+파트 액트 모두 · 읽기 전용 ──
  ck("[팀 전체] 총괄+파트 액트 모두 포함", !!findAct(bAll, O1!.id) && !!findAct(bAll, PA!.id));

  // ── 3. 팀 총괄(team_overall) = 파트 아닌 액트만 ──
  const bOverall = (await board(team.id, "team_overall")).json.data;
  ck("[팀 총괄] 총괄액트만(파트액트 제외)", !!findAct(bOverall, O1!.id) && !findAct(bOverall, PA!.id));

  // ── 4. 파트(P1) = 파트 액트만 + 크루 수 ──
  const bPart1 = (await board(team.id, "part", P1)).json.data;
  ck(`[파트 ${P1}] 파트액트만(총괄액트 제외)`, !!findAct(bPart1, PA!.id) && !findAct(bPart1, O1!.id));
  ck(`[파트 ${P1}] selectedPart 크루 수 노출`, !!bPart1.selectedPart && bPart1.selectedPart.name === P1 && bPart1.selectedPart.crewCount > 0, J(bPart1.selectedPart));

  // ── 4b. "팀 & 파트" 컬럼(partLabel) — "팀 전체"는 값으로 안 씀 ──
  const allRows = (b: any, id: string) => (b?.acts ?? []).filter((a: any) => a.actId === id);
  ck('[컬럼] team_all 총괄액트 partLabel="팀 총괄"', findAct(bAll, O1!.id)?.partLabel === "팀 총괄");
  const partRowsAll = allRows(bAll, PA!.id);
  ck(
    "[컬럼] team_all 파트액트 = 팀 파트마다 1행(펼침)·각 partLabel=파트명",
    partRowsAll.length === parts.length && parts.every((p) => partRowsAll.some((r: any) => r.partLabel === p)),
    J(partRowsAll.map((r: any) => r.partLabel)),
  );
  ck(
    '[컬럼] team_all 어디에도 "팀 전체" 값 없음',
    (bAll.acts ?? []).every((a: any) => a.partLabel !== "팀 전체"),
  );
  ck('[컬럼] team_overall 액트 partLabel="팀 총괄"', findAct(bOverall, O1!.id)?.partLabel === "팀 총괄");
  ck(`[컬럼] part(${P1}) 액트 partLabel=선택 파트명`, findAct(bPart1, PA!.id)?.partLabel === P1);

  // ── 5. write 가드(공통) ──
  const reqExtra = { review_link: "https://cafe.naver.com/x/1", scheduled_check_at: iso(Date.now() + DAY) };
  const rAll = await post({ hub: HUB, organization: ORG, act_id: O1!.id, team_id: team.id, scope: "team_all", action: "request", ...reqExtra });
  ck("[가드] team_all POST → 422", rAll.status === 422, rAll.json.error);
  const rOvPart = await post({ hub: HUB, organization: ORG, act_id: PA!.id, team_id: team.id, scope: "team_overall", action: "request", ...reqExtra });
  ck("[가드] team_overall + 파트액트 → 422", rOvPart.status === 422, rOvPart.json.error);
  const rPartOverallAct = await post({ hub: HUB, organization: ORG, act_id: O1!.id, team_id: team.id, scope: "part", part_name: P1, action: "request", ...reqExtra });
  ck("[가드] part + 총괄액트 → 422", rPartOverallAct.status === 422, rPartOverallAct.json.error);
  const rForeign = await post({ hub: HUB, organization: ORG, act_id: PA!.id, team_id: team.id, scope: "part", part_name: foreign, action: "request", ...reqExtra });
  ck(`[가드] part + 타 팀 파트(${foreign}) → 422`, rForeign.status === 422, rForeign.json.error);
  // operating + (T) 테스트 팀 → 422.
  const tTeam = (await sb.from("cluster4_teams").select("id").eq("organization_slug", ORG).eq("team_name", "과일(T)").maybeSingle()).data as { id: string } | null;
  if (tTeam) {
    const rMode = await post({ hub: HUB, organization: ORG, act_id: O1!.id, team_id: tTeam.id, scope: "team_overall", action: "request", ...reqExtra });
    ck("[가드] operating + (T)테스트 팀 → 422", rMode.status === 422, rMode.json.error);
  }

  // ── 6. 팀 총괄 정상 체크(공통) ──
  const rOverallOk = await post({ hub: HUB, organization: ORG, act_id: O1!.id, team_id: team.id, scope: "team_overall", action: "request", ...reqExtra });
  ck("[정상] team_overall + 총괄액트 → 201 pending", rOverallOk.status === 201 && rOverallOk.json.data?.status === "pending", `status=${rOverallOk.status} ${rOverallOk.json.error ?? ""}`);
  ck("[정상] team_overall DB part_name IS NULL pending", (await dbStatus(O1!.id, team.id, null))?.status === "pending");

  if (!v4) {
    // v4 미적용 — 파트 write 는 fail-closed.
    const rPartNoCol = await post({ hub: HUB, organization: ORG, act_id: PA!.id, team_id: team.id, scope: "part", part_name: P1, action: "request", ...reqExtra });
    ck("[v4미적용] 파트 write → fail-closed(2xx 아님)", rPartNoCol.status >= 400, `status=${rPartNoCol.status} ${rPartNoCol.json.error ?? ""}`);
    console.log("\n→ v4(part_name) 적용 후 재실행하면 파트 독립 검증까지 수행합니다.");
  } else {
    // ── 7. 파트별 독립 (핵심) ──
    const rP1 = await post({ hub: HUB, organization: ORG, act_id: PA!.id, team_id: team.id, scope: "part", part_name: P1, action: "request", ...reqExtra });
    ck(`[독립] 파트 ${P1} 체크 신청 → 201 pending`, rP1.status === 201 && rP1.json.data?.status === "pending", `status=${rP1.status} ${rP1.json.error ?? ""}`);
    // P1 신청 후 P2 는 여전히 needed(무변경).
    ck(`[독립] ${P1} 신청 → ${P2} 상태 무변경(needed)`, (await dbStatus(PA!.id, team.id, P2)) === null && findAct((await board(team.id, "part", P2)).json.data, PA!.id)?.status === "needed");
    // P2 신청 → 둘 다 pending, 독립 행.
    const rP2 = await post({ hub: HUB, organization: ORG, act_id: PA!.id, team_id: team.id, scope: "part", part_name: P2, action: "request", ...reqExtra });
    ck(`[독립] 파트 ${P2} 체크 신청 → 201`, rP2.status === 201);
    ck("[독립] DB 파트별 독립 행 2개(P1·P2 pending)", (await dbStatus(PA!.id, team.id, P1))?.status === "pending" && (await dbStatus(PA!.id, team.id, P2))?.status === "pending");
    // direct == HTTP : 보드 part=P1 status == DB.
    const bP1 = (await board(team.id, "part", P1)).json.data;
    ck("[direct==HTTP] 파트 P1 보드 status == DB", findAct(bP1, PA!.id)?.status === (await dbStatus(PA!.id, team.id, P1))?.status);
    // P1 취소 → P2 무변경(독립).
    const cP1 = await post({ hub: HUB, organization: ORG, act_id: PA!.id, team_id: team.id, scope: "part", part_name: P1, action: "cancel" });
    ck(`[독립] ${P1} 취소 → 201 needed`, cP1.status === 201 && cP1.json.data?.status === "needed");
    ck(
      `[독립] ${P1} 취소(needed) → ${P2} 여전히 pending(무변경)`,
      ((await dbStatus(PA!.id, team.id, P1))?.status ?? "needed") === "needed" &&
        (await dbStatus(PA!.id, team.id, P2))?.status === "pending",
    );
    // 팀 총괄(O1)도 무변경.
    ck("[독립] 파트 체크가 팀 총괄(part_name NULL) 상태 무변경", (await dbStatus(O1!.id, team.id, null))?.status === "pending");
  }

  // ── 8. org 분리 — encre 보드엔 oranke 시드 상태 비침투 ──
  const encreTeam = (await sb.from("cluster4_teams").select("id").eq("organization_slug", "encre").eq("is_active", true).limit(1).maybeSingle()).data as { id: string } | null;
  if (encreTeam) {
    const bEnc = (await api(`/api/admin/processes/check?hub=${HUB}&org=encre&team=${encreTeam.id}&scope=team_overall`)).json.data;
    ck("[org] encre 보드 총괄액트 = needed(oranke 비침투)", (findAct(bEnc, O1!.id)?.status ?? "needed") === "needed");
  }

  console.log(`\n결과: ${pass} pass / ${fail} fail`);
}

main()
  .catch((e) => { console.error("FATAL:", e?.stack ?? e); fail++; })
  .finally(async () => { await cleanup().catch(() => {}); console.log("(cleanup 완료 — net-zero)"); process.exit(fail > 0 ? 1 : 0); });
