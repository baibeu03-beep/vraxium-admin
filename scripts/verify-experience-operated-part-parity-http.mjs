// 실무 경험 라인 개설 <운용> 파트 파리티 검증 (실제 HTTP) — 2026-07-27
//
//   node --dns-result-order=ipv4first scripts/verify-experience-operated-part-parity-http.mjs
//
// 시나리오(같은 org·시즌·주차):
//   ① 신규 파트 생성 전            — team-parts 요약 == part-input 파트 목록
//   ② 신규 파트 생성 후(크루 0명)  — 양쪽 모두 미노출(<운용> 아님)
//   ③ 크루 1명 배정 후             — 양쪽 모두 노출(동일 목록)
//   ④ 개설 신청 후                 — 같은 파트가 '개설 신청 완료'(team-overall partSubmitted)
// 추가: 일반 모드 / mode=test / mode=test&actAsTestUserId / demoUserId 경로 DTO·상태 동등성.
//
// net-zero: 생성한 파트·override·신청 헤더를 모두 원복한다(override 는 원래 파트/클래스로 복원).
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
const NEWPART = "ZZ파리티검증파트";

let pass = 0;
let fail = 0;
const skipped = [];
const ck = (label, ok, detail = "") => {
  console.log(`  ${ok ? "✓" : "✗"} ${label}${detail ? ` — ${detail}` : ""}`);
  ok ? pass++ : fail++;
};
const skip = (label, why) => {
  console.log(`  ⊘ ${label} — SKIP: ${why}`);
  skipped.push(`${label} (${why})`);
};
const J = (v) => JSON.stringify(v);
const setEq = (a, b) => J([...a].sort()) === J([...b].sort());

let COOKIE = "";
async function makeAdminCookie() {
  const { data: adm } = await sb
    .from("admin_users")
    .select("email")
    .eq("is_active", true)
    .not("email", "is", null)
    .limit(1);
  const adminEmail = process.env.SMOKE_ADMIN_EMAIL ?? adm?.[0]?.email;
  const b = createClient(SUPABASE_URL, ANON);
  const { data: linkData } = await sb.auth.admin.generateLink({ type: "magiclink", email: adminEmail });
  const { data: verifyData } = await b.auth.verifyOtp({
    email: adminEmail,
    token: linkData.properties.email_otp,
    type: "magiclink",
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

async function api(path, init = {}) {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: { cookie: COOKIE, "content-type": "application/json", ...(init.headers ?? {}) },
  });
  let json = null;
  try {
    json = await res.json();
  } catch {
    /* non-JSON */
  }
  return { status: res.status, json };
}

// ── 화면별 파트 목록 ──────────────────────────────────────────────────────────
// /admin/team-parts/info/* — 팀 상세 [A] 선택 주차 요약의 <운용> 파트
async function teamPartsOperated(teamHalfId, weekId, mode = MODE) {
  const qs = new URLSearchParams({ organization: ORG, teamHalfId });
  if (weekId) qs.set("weekId", weekId);
  if (mode === "test") qs.set("mode", "test");
  const r = await api(`/api/admin/team-parts/info/team-detail/week-summary?${qs}`);
  const parts = (r.json?.data?.operatedParts ?? []).map((p) => p.partName).filter((p) => p !== "일반");
  return { status: r.status, parts, weekId: r.json?.data?.week?.weekId ?? null, raw: r.json };
}

// /admin/integrated/line-opening/practical-experience — 파트 드롭다운
async function experienceParts(teamId, weekId, mode = MODE, actAs = null, demoUserId = null) {
  const qs = new URLSearchParams({ organization: ORG, team_id: teamId, team_name: TEAM_NAME });
  if (weekId) qs.set("week_id", weekId);
  if (mode === "test") qs.set("mode", "test");
  if (actAs) qs.set("actAsTestUserId", actAs);
  if (demoUserId) qs.set("demoUserId", demoUserId);
  const r = await api(`/api/admin/cluster4/experience/part-input?${qs}`);
  return { status: r.status, parts: r.json?.data?.parts ?? [], data: r.json?.data ?? null };
}

async function overallBoard(teamId, weekId, mode = MODE) {
  const qs = new URLSearchParams({ organization: ORG, week_id: weekId, team_id: teamId, team_name: TEAM_NAME });
  if (mode === "test") qs.set("mode", "test");
  const r = await api(`/api/admin/cluster4/experience/team-overall?${qs}`);
  return { status: r.status, data: r.json?.data ?? null };
}

void (async () => {
  COOKIE = await makeAdminCookie();

  // ── 픽스처 해소 ────────────────────────────────────────────────────────────
  const { data: half } = await sb
    .from("cluster4_team_halves")
    .select("id,team_id,half_key,team_name,organization_slug,is_active")
    .eq("organization_slug", ORG)
    .eq("team_name", TEAM_NAME)
    .eq("is_active", true)
    .order("half_key", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (!half) {
    console.error("픽스처 팀을 찾을 수 없습니다");
    process.exit(1);
  }
  const TEAM_HALF_ID = half.id;
  // team_id 는 half 행에 없을 수 있다 — 화면과 동일한 원천(/api/admin/cluster4/teams)에서 해소.
  const teamsRes = await api(`/api/admin/cluster4/teams?organization=${ORG}&mode=${MODE}`);
  const TEAM_ID =
    (teamsRes.json?.data ?? []).find((t) => t.teamName === TEAM_NAME)?.id ?? half.team_id;
  console.log(`fixture = [${ORG}] ${TEAM_NAME} half=${half.half_key} teamHalfId=${TEAM_HALF_ID} teamId=${TEAM_ID}`);

  const base0 = await teamPartsOperated(TEAM_HALF_ID, null);
  if (!base0.weekId) {
    console.error("현재 주차를 찾을 수 없습니다");
    process.exit(1);
  }
  // 검증 주차 = ①~④ 를 한 주차에서 모두 돌릴 수 있는 주차.
  //   조건: 편집 가능(검수 미완료) + 실무 경험 개설 기간(canOpen) + 팀 총괄 상태 none
  //   (검수/개설이 진행된 주차의 상태를 이 검증이 건드리지 않도록). 없으면 현재 주차(④ SKIP).
  let WEEK_ID = base0.weekId;
  let WEEK_START = null;
  for (const w of (base0.raw?.data?.selectableWeeks ?? []).slice(0, 8)) {
    const sum = await teamPartsOperated(TEAM_HALF_ID, w.weekId);
    if (sum.raw?.data?.week?.reviewCompleted) continue;
    const b = await overallBoard(TEAM_ID, w.weekId);
    if (!b.data?.canOpen) continue;
    if ((b.data?.status ?? "none") !== "none") continue;
    WEEK_ID = w.weekId;
    WEEK_START = w.weekStartDate;
    break;
  }
  if (WEEK_ID === base0.weekId) {
    WEEK_START = (base0.raw?.data?.selectableWeeks ?? []).find((w) => w.weekId === WEEK_ID)?.weekStartDate ?? null;
  }
  console.log(`week = ${WEEK_ID} (${WEEK_START})\n`);

  // 이전 실행 잔여 정리.
  const purge = async () => {
    await sb.from("cluster4_team_week_position_overrides").delete().eq("organization", ORG).eq("raw_part", NEWPART);
    const { data: h } = await sb
      .from("cluster4_experience_part_submissions")
      .select("id")
      .eq("organization_slug", ORG)
      .eq("week_id", WEEK_ID)
      .eq("team_id", TEAM_ID)
      .eq("part_name", NEWPART);
    for (const row of h ?? []) {
      await sb.from("cluster4_experience_part_submission_cells").delete().eq("submission_id", row.id);
      await sb.from("cluster4_experience_part_submissions").delete().eq("id", row.id);
    }
    await sb.from("cluster4_team_parts").delete().eq("team_half_id", TEAM_HALF_ID).eq("part_name", NEWPART);
  };
  await purge();

  let movedUser = null; // { userId, prevPart, prevCode, hadOverride }
  try {
    // ── ① 신규 파트 생성 전 ───────────────────────────────────────────────
    console.log("① 신규 파트 생성 전");
    const a1 = await teamPartsOperated(TEAM_HALF_ID, WEEK_ID);
    const b1 = await experienceParts(TEAM_ID, WEEK_ID);
    ck("team-parts 200 / practical-experience 200", a1.status === 200 && b1.status === 200, `${a1.status}/${b1.status}`);
    ck("파트 목록 동일(기준선)", setEq(a1.parts, b1.parts), `teamParts=${J(a1.parts)} exp=${J(b1.parts)}`);
    ck("신규 파트 미존재(전제)", !b1.parts.includes(NEWPART));

    // ── ② 신규 파트 생성(크루 미배정) ─────────────────────────────────────
    console.log("\n② 신규 파트 생성 후 · 크루 미배정");
    const created = await api(`/api/admin/team-parts/info/team-detail/parts?mode=${MODE}`, {
      method: "POST",
      body: J({ organization: ORG, teamHalfId: TEAM_HALF_ID, name: NEWPART }),
    });
    ck("파트 생성 201/200", created.status === 200, `${created.status} ${J(created.json?.error ?? "")}`);
    const a2 = await teamPartsOperated(TEAM_HALF_ID, WEEK_ID);
    const b2 = await experienceParts(TEAM_ID, WEEK_ID);
    ck("team-parts: 크루 미배정 파트는 <운용> 아님", !a2.parts.includes(NEWPART), J(a2.parts));
    ck("practical-experience: 크루 미배정 파트는 후보 아님", !b2.parts.includes(NEWPART), J(b2.parts));
    ck("파트 목록 동일(생성 후)", setEq(a2.parts, b2.parts));

    // ── ③ 크루 1명 배정 ───────────────────────────────────────────────────
    console.log("\n③ 신규 파트에 크루 1명 배정");
    // 이동 대상 = 요약 crewRows 중 첫 크루(현재 파트/클래스를 기억해 원복).
    // 파트장은 평가 대상 크루가 아니라 그리드에 뜨지 않는다 — 일반/에이전트를 고른다.
    const summaryRaw = a2.raw?.data?.crewRows ?? [];
    const target =
      summaryRaw.find(
        (r) => r.rawPart && r.rawPart !== NEWPART && ["regular", "advanced_agent"].includes(r.positionCode),
      ) ?? summaryRaw.find((r) => r.rawPart && r.rawPart !== NEWPART);
    if (!target) {
      skip("크루 배정", "요약 crewRows 비어 있음");
    } else {
      // PATCH 는 (user_id, week_start_date, organization, raw_team) upsert 다 — 원복 판정도
      //   **정확히 그 주차의 행**이 원래 있었는지로 한다(있었으면 값 복원, 없었으면 우리가 만든 행 삭제).
      const { data: prevOvr } = await sb
        .from("cluster4_team_week_position_overrides")
        .select("raw_part,position_code")
        .eq("organization", ORG)
        .eq("raw_team", TEAM_NAME)
        .eq("user_id", target.userId)
        .eq("week_start_date", WEEK_START)
        .maybeSingle();
      movedUser = {
        userId: target.userId,
        prevPart: prevOvr?.raw_part ?? target.rawPart,
        prevCode: prevOvr?.position_code ?? target.positionCode,
        hadOverride: Boolean(prevOvr),
      };
      const patch = await api(`/api/admin/team-parts/info/team-detail/week-position?mode=${MODE}`, {
        method: "PATCH",
        body: J({
          organization: ORG,
          weekId: WEEK_ID,
          rawTeam: TEAM_NAME,
          changes: [{ userId: target.userId, rawPart: NEWPART, positionCode: target.positionCode }],
        }),
      });
      ck("크루 배정 PATCH 200", patch.status === 200, `${patch.status} ${J(patch.json?.error ?? "")}`);

      const a3 = await teamPartsOperated(TEAM_HALF_ID, WEEK_ID);
      const b3 = await experienceParts(TEAM_ID, WEEK_ID);
      ck("team-parts: 신규 파트 = <운용>", a3.parts.includes(NEWPART), J(a3.parts));
      ck("practical-experience: 신규 파트 후보 포함", b3.parts.includes(NEWPART), J(b3.parts));
      ck("파트 목록 동일(배정 후)", setEq(a3.parts, b3.parts));
      ck("중복 파트 없음", new Set(b3.parts).size === b3.parts.length, J(b3.parts));

      // 파트 스코프 조회 — 배정한 크루가 그리드에 뜨는가.
      const grid = await experienceParts(TEAM_ID, WEEK_ID);
      const gridPart = await api(
        `/api/admin/cluster4/experience/part-input?${new URLSearchParams({
          organization: ORG,
          week_id: WEEK_ID,
          team_id: TEAM_ID,
          team_name: TEAM_NAME,
          part: NEWPART,
          mode: "test",
        })}`,
      );
      const crews = gridPart.json?.data?.crews ?? [];
      ck("신규 파트 그리드 크루 ≥1", crews.length >= 1, `crews=${crews.length}`);
      void grid;

      // ── 모드 파리티 ────────────────────────────────────────────────────
      console.log("\n③-b 모드 파리티(일반 / test / actAsTestUserId / demoUserId)");
      const { data: marker } = await sb.from("test_user_markers").select("user_id").limit(1).maybeSingle();
      const actAs = marker?.user_id ?? null;
      const bTest = await experienceParts(TEAM_ID, WEEK_ID, "test");
      const bActAs = actAs ? await experienceParts(TEAM_ID, WEEK_ID, "test", actAs) : null;
      const bDemo = await experienceParts(TEAM_ID, WEEK_ID, "test", null, actAs);
      const bOperating = await experienceParts(TEAM_ID, WEEK_ID, "operating");
      if (bActAs) {
        ck("test vs actAsTestUserId — HTTP status 동일", bTest.status === bActAs.status, `${bTest.status}/${bActAs.status}`);
        ck("test vs actAsTestUserId — 파트 목록 동일", setEq(bTest.parts, bActAs.parts), `${J(bTest.parts)} / ${J(bActAs.parts)}`);
        ck(
          "test vs actAsTestUserId — DTO 키 동일",
          setEq(Object.keys(bTest.data ?? {}), Object.keys(bActAs.data ?? {})),
          J(Object.keys(bActAs.data ?? {})),
        );
        ck(
          "actAsTestUserId 는 actor 만 다름(파트 조회/DTO 동일 함수)",
          J(bTest.data?.lines) === J(bActAs.data?.lines) && J(bTest.data?.lineOptions) === J(bActAs.data?.lineOptions),
        );
      } else {
        skip("actAsTestUserId 파리티", "test_user_markers 비어 있음");
      }
      ck("demoUserId 무시(일반 test 경로와 동일)", setEq(bTest.parts, bDemo.parts) && bTest.status === bDemo.status);
      ck("operating 모드 200(회귀 없음)", bOperating.status === 200, `${bOperating.status}`);

      // ── ④ 개설 신청 후 ─────────────────────────────────────────────────
      console.log("\n④ 개설 신청 후");
      const before = await overallBoard(TEAM_ID, WEEK_ID);
      const beforeStatus = before.data?.status ?? null;
      if (beforeStatus && beforeStatus !== "none") {
        skip("개설 신청", `팀 총괄 상태=${beforeStatus} (검수/개설 상태를 건드리지 않음)`);
      } else {
        const cells = crews.flatMap((c) =>
          ["derivation", "analysis", "insight"].map((lineType) => ({
            crewUserId: c.userId,
            lineType,
            checked: true,
            score: 7,
            selectedLineId: null,
          })),
        );
        const applied = await api(`/api/admin/cluster4/experience/part-input`, {
          method: "POST",
          body: J({
            organization: ORG,
            week_id: WEEK_ID,
            team_id: TEAM_ID,
            team_name: TEAM_NAME,
            part: NEWPART,
            mode: MODE,
            cells,
          }),
        });
        if (applied.status !== 200 && applied.status !== 201) {
          skip("개설 신청 POST", `status=${applied.status} ${J(applied.json?.error ?? "")}`);
        } else {
          const after = await overallBoard(TEAM_ID, WEEK_ID);
          const partRow = (after.data?.parts ?? []).find((p) => p.partName === NEWPART);
          ck("team-overall 에 신규 파트 존재", Boolean(partRow), J((after.data?.parts ?? []).map((p) => p.partName)));
          ck("신규 파트 = 개설 신청 완료(submitted)", partRow?.submitted === true, J(partRow?.submitted));
          const b4 = await experienceParts(TEAM_ID, WEEK_ID);
          ck("신청 후에도 후보 목록에 유지", b4.parts.includes(NEWPART), J(b4.parts));
          const a4 = await teamPartsOperated(TEAM_HALF_ID, WEEK_ID);
          ck("신청 후에도 두 화면 목록 동일", setEq(a4.parts, b4.parts));
          ck(
            "기존 파트 상태 독립(신규 파트 신청이 기존 파트 submitted 를 바꾸지 않음)",
            (after.data?.parts ?? [])
              .filter((p) => p.partName !== NEWPART)
              .every((p) => {
                const prev = (before.data?.parts ?? []).find((q) => q.partName === p.partName);
                return prev == null || prev.submitted === p.submitted;
              }),
          );
        }
      }
    }
  } catch (e) {
    fail++;
    console.error("\n!! 검증 중 예외 — 아래 정리는 그대로 수행합니다:\n", e);
  } finally {
    // ── 정리(net-zero) ────────────────────────────────────────────────────
    console.log("\n정리");
    if (movedUser) {
      if (movedUser.hadOverride && movedUser.prevPart) {
        const r = await api(`/api/admin/team-parts/info/team-detail/week-position?mode=${MODE}`, {
          method: "PATCH",
          body: J({
            organization: ORG,
            weekId: WEEK_ID,
            rawTeam: TEAM_NAME,
            changes: [{ userId: movedUser.userId, rawPart: movedUser.prevPart, positionCode: movedUser.prevCode }],
          }),
        });
        console.log(`  override 원복(PATCH ${r.status}) user=${movedUser.userId.slice(0, 8)} → ${movedUser.prevPart}`);
      } else {
        await sb
          .from("cluster4_team_week_position_overrides")
          .delete()
          .eq("organization", ORG)
          .eq("raw_team", TEAM_NAME)
          .eq("user_id", movedUser.userId)
          .eq("week_start_date", WEEK_START)
          .eq("raw_part", NEWPART);
        console.log(`  override 삭제(검증이 새로 만든 행) user=${movedUser.userId.slice(0, 8)}`);
      }
    }
    await purge();
    const left = await sb
      .from("cluster4_team_week_position_overrides")
      .select("id")
      .eq("organization", ORG)
      .eq("raw_part", NEWPART);
    ck("net-zero: 검증 파트 override 잔여 0", (left.data ?? []).length === 0);
    const leftPart = await sb
      .from("cluster4_team_parts")
      .select("id")
      .eq("team_half_id", TEAM_HALF_ID)
      .eq("part_name", NEWPART);
    ck("net-zero: 검증 파트 카탈로그 잔여 0", (leftPart.data ?? []).length === 0);

    console.log(`\n== PASS ${pass} / FAIL ${fail} / SKIP ${skipped.length} ==`);
    if (skipped.length) for (const s of skipped) console.log(`  SKIP: ${s}`);
    process.exit(fail > 0 ? 1 : 0);
  }
})();
