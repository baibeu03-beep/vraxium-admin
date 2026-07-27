// 시즌 휴식 = 활동·평가 모집단 제외 — 상태 전환 실 HTTP 검증 (2026-07-27)
//
//   node --dns-result-order=ipv4first scripts/verify-season-rest-population-http.mjs
//
// 같은 사용자를 [활동] ↔ [시즌 휴식] 으로 전환하며 4개 화면이 **동시에** 같은 판정을 하는지 본다.
//   1) 활동 상태      — 클러빙_축소 포함 · 팀·파트 소속 포함 · <운용> 파트 포함 · 평가 대상 포함
//   2) 시즌 휴식 상태 — 클러빙_확대엔 존재 · 축소 제외 · 팀·파트 제외 · <운용> 제외 · 평가 대상 제외
//   3) 그 파트에 휴식자만 → team-parts <운용> 목록/practical-experience 드롭다운 모두 제외
//   4) 활동 크루 1명 추가 → 두 화면 모두 파트 표시 + 그 크루가 평가 대상에 표시
// 추가: operating / test / actAsTestUserId 3경로의 status·DTO 키·userId 집합·파트 목록 동일.
//
// net-zero: user_season_statuses 원본 행과 주차 override 를 전부 원복한다.
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const adminRoot = resolve(__dirname, "..");
const requireAdmin = createRequire(resolve(adminRoot, "package.json"));
const { createClient } = requireAdmin("@supabase/supabase-js");
const { createServerClient } = requireAdmin("@supabase/ssr");

const env = readFileSync(resolve(adminRoot, ".env.local"), "utf8");
const get = (k) => env.match(new RegExp(`^${k}=(.+)$`, "m"))?.[1]?.trim();
const BASE = process.env.SMOKE_BASE_URL ?? "http://localhost:3000";
const SUPABASE_URL = get("NEXT_PUBLIC_SUPABASE_URL");
const ANON = get("NEXT_PUBLIC_SUPABASE_ANON_KEY");
const sb = createClient(SUPABASE_URL, get("SUPABASE_SERVICE_ROLE_KEY"), {
  auth: { persistSession: false },
});

const ORG = "encre";
const TEAM_NAME = "비주얼랩(T)";
const MODE = "test";
const PART = "테스트";

let pass = 0;
let fail = 0;
const ck = (label, ok, detail = "") => {
  console.log(`  ${ok ? "✓" : "✗"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (ok) pass++;
  else fail++;
};
const J = (v) => JSON.stringify(v);
const setEq = (a, b) => J([...a].sort()) === J([...b].sort());

let COOKIE = "";
async function makeAdminCookie() {
  const { data: adm } = await sb
    .from("admin_users").select("email").eq("is_active", true).not("email", "is", null).limit(1);
  const adminEmail = process.env.SMOKE_ADMIN_EMAIL ?? adm?.[0]?.email;
  const b = createClient(SUPABASE_URL, ANON);
  const { data: linkData } = await sb.auth.admin.generateLink({ type: "magiclink", email: adminEmail });
  const { data: verifyData } = await b.auth.verifyOtp({
    email: adminEmail, token: linkData.properties.email_otp, type: "magiclink",
  });
  const captured = [];
  const server = createServerClient(SUPABASE_URL, ANON, {
    cookies: { getAll: () => [], setAll: (items) => captured.push(...items) },
  });
  await server.auth.setSession({
    access_token: verifyData.session.access_token,
    refresh_token: verifyData.session.refresh_token,
  });
  console.log(`admin = ${adminEmail}`);
  return captured.map((i) => `${i.name}=${i.value}`).join("; ");
}

async function api(path) {
  const res = await fetch(`${BASE}${path}`, { headers: { cookie: COOKIE } });
  let json = null;
  try { json = await res.json(); } catch { /* non-JSON */ }
  return { status: res.status, json };
}

// ── 화면별 조회 ──────────────────────────────────────────────────────────────
async function membersRoster(filter, mode = MODE) {
  const qs = new URLSearchParams({ organization: ORG, filter, page: "1", pageSize: "200" });
  if (mode === "test") qs.set("mode", "test");
  const r = await api(`/api/admin/members/roster?${qs}`);
  return { status: r.status, ids: (r.json?.data?.members ?? []).map((m) => m.userId) };
}
async function teamParts(teamHalfId, weekId, mode = MODE) {
  const qs = new URLSearchParams({ organization: ORG, teamHalfId });
  if (weekId) qs.set("weekId", weekId);
  if (mode === "test") qs.set("mode", "test");
  const r = await api(`/api/admin/team-parts/info/team-detail/week-summary?${qs}`);
  const d = r.json?.data ?? {};
  return {
    status: r.status,
    parts: (d.operatedParts ?? []).map((p) => p.partName).filter((p) => p !== "일반"),
    crewIds: (d.crewRows ?? []).map((c) => c.userId),
    crewTotal: d.crew?.total ?? null,
    weekId: d.week?.weekId ?? null,
  };
}
async function experience(teamId, weekId, part = null, mode = MODE, actAs = null) {
  const qs = new URLSearchParams({ organization: ORG, team_id: teamId, team_name: TEAM_NAME });
  if (weekId) qs.set("week_id", weekId);
  if (part) qs.set("part", part);
  if (mode === "test") qs.set("mode", "test");
  if (actAs) qs.set("actAsTestUserId", actAs);
  const r = await api(`/api/admin/cluster4/experience/part-input?${qs}`);
  const d = r.json?.data ?? {};
  return {
    status: r.status,
    keys: Object.keys(d),
    parts: d.parts ?? [],
    crewIds: (d.crews ?? []).map((c) => c.userId),
  };
}

void (async () => {
  COOKIE = await makeAdminCookie();

  const { data: half } = await sb
    .from("cluster4_team_halves")
    .select("id,team_id,half_key,team_name,organization_slug")
    .eq("organization_slug", ORG).eq("team_name", TEAM_NAME).eq("is_active", true)
    .order("half_key", { ascending: false }).limit(1).maybeSingle();
  const TEAM_HALF_ID = half.id;
  const teamsRes = await api(`/api/admin/cluster4/teams?organization=${ORG}&mode=${MODE}`);
  const TEAM_ID = (teamsRes.json?.data ?? []).find((t) => t.teamName === TEAM_NAME)?.id ?? half.team_id;

  const base = await teamParts(TEAM_HALF_ID, null);
  const WEEK_ID = base.weekId;
  const { data: wk } = await sb.from("weeks").select("season_key,start_date").eq("id", WEEK_ID).maybeSingle();
  const SEASON = wk.season_key;
  const WEEK_START = wk.start_date;
  console.log(`fixture = [${ORG}] ${TEAM_NAME} week=${WEEK_ID}(${WEEK_START}, ${SEASON}) part='${PART}'\n`);

  // 대상자 = 그 시즌 휴식이면서 이 팀 PART 에 배정된 크루.
  //   ⚠ override 는 "해당 주차 이하 최신"이 유효하다(resolveOverrideAt) — 정확히 그 주차 행만 보면 놓친다.
  const { data: ovrRows } = await sb
    .from("cluster4_team_week_position_overrides")
    .select("user_id,raw_team,raw_part,position_code,week_start_date")
    .eq("organization", ORG).eq("raw_part", PART).lte("week_start_date", WEEK_START)
    .order("week_start_date", { ascending: false });
  const SUBJECT = (ovrRows ?? [])[0]?.user_id;
  if (!SUBJECT) {
    console.error(`'${PART}' 파트 배정 override 를 찾지 못했습니다 — 픽스처 불일치`);
    process.exit(1);
  }
  const { data: subjProf } = await sb.from("user_profiles").select("display_name").eq("user_id", SUBJECT).maybeSingle();
  console.log(`대상자 = ${subjProf?.display_name}(${SUBJECT})\n`);

  // 원본 시즌 상태 백업(net-zero).
  const { data: origRows } = await sb
    .from("user_season_statuses").select("*").eq("user_id", SUBJECT).eq("season_key", SEASON);
  const ORIG = (origRows ?? [])[0] ?? null;
  if (!ORIG || ORIG.status !== "rest") {
    console.error(`대상자의 ${SEASON} 시즌 상태가 'rest' 가 아닙니다(${ORIG?.status}) — 픽스처 불일치`);
    process.exit(1);
  }

  const setStatus = async (status) => {
    const { error } = await sb
      .from("user_season_statuses").update({ status }).eq("user_id", SUBJECT).eq("season_key", SEASON);
    if (error) throw new Error(error.message);
  };

  let extraUser = null; // ④ 에서 임시 배정한 활동 크루
  try {
    // ── ① 활동 상태 ──────────────────────────────────────────────────────────
    console.log("① 활동 상태(시즌 status='active')");
    await setStatus("active");
    {
      const reduce = await membersRoster("clubbing_reduce");
      const expand = await membersRoster("clubbing_expand");
      ck("클러빙_확대 포함", expand.ids.includes(SUBJECT));
      ck("클러빙_축소 포함", reduce.ids.includes(SUBJECT));
      const tp = await teamParts(TEAM_HALF_ID, WEEK_ID);
      ck("team-parts 팀 소속 크루 포함", tp.crewIds.includes(SUBJECT), `crew.total=${tp.crewTotal}`);
      ck(`team-parts <운용> 파트에 '${PART}' 포함`, tp.parts.includes(PART), J(tp.parts));
      const ex = await experience(TEAM_ID, WEEK_ID);
      ck(`practical-experience 드롭다운에 '${PART}' 포함`, ex.parts.includes(PART), J(ex.parts));
      const exPart = await experience(TEAM_ID, WEEK_ID, PART);
      ck("practical-experience 평가 대상 포함", exPart.crewIds.includes(SUBJECT), J(exPart.crewIds));
    }

    // ── ②③ 시즌 휴식 상태 (이 파트엔 휴식자만 남는다) ────────────────────────
    console.log("\n②③ 시즌 휴식 상태(시즌 status='rest') — 이 파트엔 휴식자만");
    await setStatus("rest");
    {
      const expand = await membersRoster("clubbing_expand");
      const reduce = await membersRoster("clubbing_reduce");
      ck("클러빙_확대에는 존재", expand.ids.includes(SUBJECT));
      ck("클러빙_축소에서 제외", !reduce.ids.includes(SUBJECT));
      const tp = await teamParts(TEAM_HALF_ID, WEEK_ID);
      ck("team-parts 팀 소속 크루에서 제외", !tp.crewIds.includes(SUBJECT), `crew.total=${tp.crewTotal}`);
      ck(`team-parts <운용> 파트에서 '${PART}' 제외`, !tp.parts.includes(PART), J(tp.parts));
      const ex = await experience(TEAM_ID, WEEK_ID);
      ck(`practical-experience 드롭다운에서 '${PART}' 제외`, !ex.parts.includes(PART), J(ex.parts));
      const exPart = await experience(TEAM_ID, WEEK_ID, PART);
      ck("practical-experience 평가 대상에서 제외", !exPart.crewIds.includes(SUBJECT), J(exPart.crewIds));
      ck("두 화면 판정 동일(둘 다 파트 미표시)", !tp.parts.includes(PART) && !ex.parts.includes(PART));
    }

    // ── ④ 활동 가능한 크루 1명 추가 ──────────────────────────────────────────
    console.log("\n④ 활동 크루 1명을 같은 파트에 배정");
    {
      // 이 팀의 활동(비휴식) 크루 1명을 골라 그 주차 override 로 '테스트' 파트에 임시 배정.
      const ex0 = await experience(TEAM_ID, WEEK_ID, "무드");
      const donor = ex0.crewIds[0];
      if (!donor) throw new Error("기증 크루를 찾지 못했습니다");
      const { data: prevOvr } = await sb
        .from("cluster4_team_week_position_overrides")
        .select("*").eq("organization", ORG).eq("week_start_date", WEEK_START).eq("user_id", donor);
      extraUser = { userId: donor, prev: (prevOvr ?? [])[0] ?? null };
      const patch = {
        organization: ORG, week_start_date: WEEK_START, user_id: donor,
        raw_team: TEAM_NAME, raw_part: PART,
        position_code: extraUser.prev?.position_code ?? "regular",
      };
      const { error: upErr } = await sb
        .from("cluster4_team_week_position_overrides")
        .upsert(patch, { onConflict: "user_id,week_start_date,organization,raw_team" });
      if (upErr) throw new Error(upErr.message);

      const tp = await teamParts(TEAM_HALF_ID, WEEK_ID);
      ck(`team-parts <운용> 파트에 '${PART}' 표시`, tp.parts.includes(PART), J(tp.parts));
      const ex = await experience(TEAM_ID, WEEK_ID);
      ck(`practical-experience 드롭다운에 '${PART}' 표시`, ex.parts.includes(PART), J(ex.parts));
      const exPart = await experience(TEAM_ID, WEEK_ID, PART);
      ck("추가한 활동 크루가 평가 대상에 표시", exPart.crewIds.includes(donor), J(exPart.crewIds));
      ck("시즌 휴식자는 여전히 제외", !exPart.crewIds.includes(SUBJECT), J(exPart.crewIds));
      ck("파트 크루 = 활동 크루 1명", exPart.crewIds.length === 1, `n=${exPart.crewIds.length}`);

      // 3경로 파리티(operating / test / actAs)
      console.log("\n④-b 모드 파리티(operating / test / actAsTestUserId)");
      const { data: tu } = await sb
        .from("test_user_markers").select("user_id").limit(50);
      const { data: leaders } = await sb
        .from("user_profiles").select("user_id,role")
        .in("user_id", (tu ?? []).map((x) => x.user_id)).eq("role", "team_leader").limit(1);
      const actAsId = (leaders ?? [])[0]?.user_id ?? null;
      const a = await experience(TEAM_ID, WEEK_ID, PART, "operating");
      const b = await experience(TEAM_ID, WEEK_ID, PART, "test");
      const c = actAsId ? await experience(TEAM_ID, WEEK_ID, PART, "test", actAsId) : b;
      ck("HTTP status 동일", a.status === b.status && b.status === c.status, `${a.status}/${b.status}/${c.status}`);
      ck("DTO 키 집합·순서 동일", J(a.keys) === J(b.keys) && J(b.keys) === J(c.keys), J(a.keys));
      ck("파트 목록 동일", setEq(a.parts, b.parts) && setEq(b.parts, c.parts), `${J(a.parts)} / ${J(c.parts)}`);
      ck("userId 집합 동일", setEq(a.crewIds, b.crewIds) && setEq(b.crewIds, c.crewIds), `${J(a.crewIds)} / ${J(c.crewIds)}`);
      const tpOp = await teamParts(TEAM_HALF_ID, WEEK_ID, "operating");
      const tpTest = await teamParts(TEAM_HALF_ID, WEEK_ID, "test");
      ck("team-parts operating==test 크루 집합", setEq(tpOp.crewIds, tpTest.crewIds));
      ck("team-parts operating==test 파트 목록", setEq(tpOp.parts, tpTest.parts));
    }
  } finally {
    // ── 원복(net-zero) ──────────────────────────────────────────────────────
    console.log("\n정리");
    await sb.from("user_season_statuses").update({ status: ORIG.status })
      .eq("user_id", SUBJECT).eq("season_key", SEASON);
    const { data: after } = await sb
      .from("user_season_statuses").select("status").eq("user_id", SUBJECT).eq("season_key", SEASON);
    ck("net-zero: 시즌 상태 원복", (after ?? [])[0]?.status === ORIG.status, `status=${(after ?? [])[0]?.status}`);
    if (extraUser) {
      if (extraUser.prev) {
        await sb.from("cluster4_team_week_position_overrides")
          .update({ raw_team: extraUser.prev.raw_team, raw_part: extraUser.prev.raw_part, position_code: extraUser.prev.position_code })
          .eq("organization", ORG).eq("week_start_date", WEEK_START).eq("user_id", extraUser.userId);
      } else {
        await sb.from("cluster4_team_week_position_overrides").delete()
          .eq("organization", ORG).eq("week_start_date", WEEK_START).eq("user_id", extraUser.userId);
      }
      const { data: chk } = await sb.from("cluster4_team_week_position_overrides")
        .select("raw_part").eq("organization", ORG).eq("week_start_date", WEEK_START).eq("user_id", extraUser.userId);
      ck("net-zero: 임시 배정 override 원복",
        J((chk ?? [])[0]?.raw_part ?? null) === J(extraUser.prev?.raw_part ?? null),
        `raw_part=${(chk ?? [])[0]?.raw_part ?? null}`);
    }
  }

  console.log(`\n== PASS ${pass} / FAIL ${fail} ==`);
  if (fail > 0) process.exit(1);
})();
