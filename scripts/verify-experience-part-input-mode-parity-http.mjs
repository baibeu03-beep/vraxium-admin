// 실무 경험 part-input — 모드별 실제 HTTP 응답 필드 단위 대조 (2026-07-27)
//
//   node --dns-result-order=ipv4first scripts/verify-experience-part-input-mode-parity-http.mjs
//
// 같은 (organization, team_id, team_name, week_id, part) 로 아래 3경로를 호출해 비교한다.
//   A: mode=operating
//   B: mode=test
//   C: mode=test&actAsTestUserId=<test_user_markers 유저>
//
// 기대:
//   · HTTP status 동일
//   · DTO 키 집합·순서 동일
//   · parts (목록 + **순서**) · submitted · lines · lineOptions · crews · cells · aggregate 동일
//   · actor 만 다르다 — 그리고 그 차이는 임퍼소네이션 필드에 한정(A==B, C 만 actor 치환)
//
// 읽기 전용(GET). 쓰기·정리 없음.
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
const sb = createClient(SUPABASE_URL, get("SUPABASE_SERVICE_ROLE_KEY"), { auth: { persistSession: false } });

const ORG = process.env.PARITY_ORG ?? "encre";
const TEAM_NAME = process.env.PARITY_TEAM ?? "비주얼랩(T)";

let pass = 0;
let fail = 0;
const ck = (label, ok, detail = "") => {
  console.log(`  ${ok ? "✓" : "✗"} ${label}${detail ? ` — ${detail}` : ""}`);
  ok ? pass++ : fail++;
};
const J = (v) => JSON.stringify(v);

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

async function api(path) {
  const res = await fetch(`${BASE}${path}`, { headers: { cookie: COOKIE } });
  let json = null;
  try {
    json = await res.json();
  } catch {
    /* non-JSON */
  }
  return { status: res.status, json };
}

async function partInput({ teamId, weekId, part, mode, actAs }) {
  const qs = new URLSearchParams({ organization: ORG, team_id: teamId, team_name: TEAM_NAME, week_id: weekId });
  if (part) qs.set("part", part);
  if (mode === "test") qs.set("mode", "test");
  if (actAs) qs.set("actAsTestUserId", actAs);
  const r = await api(`/api/admin/cluster4/experience/part-input?${qs}`);
  return { status: r.status, data: r.json?.data ?? null, url: `?${qs}` };
}

// 세 응답의 한 키를 대조. order-sensitive(JSON.stringify) 비교.
const COMPARE_KEYS = ["parts", "submitted", "lines", "lineOptions", "crews", "cells", "aggregate"];

function compareTriple(label, A, B, C) {
  console.log(`\n── ${label} ──`);
  ck("HTTP status 동일 (operating / test / actAs)", A.status === B.status && B.status === C.status, `${A.status} / ${B.status} / ${C.status}`);
  ck(
    "DTO 키 집합·순서 동일",
    J(Object.keys(A.data ?? {})) === J(Object.keys(B.data ?? {})) &&
      J(Object.keys(B.data ?? {})) === J(Object.keys(C.data ?? {})),
    J(Object.keys(C.data ?? {})),
  );
  for (const k of COMPARE_KEYS) {
    const a = J(A.data?.[k] ?? null);
    const b = J(B.data?.[k] ?? null);
    const c = J(C.data?.[k] ?? null);
    const sizeOf = (v) => (Array.isArray(v) ? `len=${v.length}` : typeof v === "object" && v ? "obj" : String(v));
    const okAB = a === b;
    const okBC = b === c;
    ck(
      `${k}: operating == test == actAs (순서 포함)`,
      okAB && okBC,
      okAB && okBC
        ? sizeOf(B.data?.[k])
        : `A=${a.slice(0, 160)}\n        B=${b.slice(0, 160)}\n        C=${c.slice(0, 160)}`,
    );
  }
  // actor — A==B 여야 하고, C 만 임퍼소네이션 필드가 달라야 한다.
  const actorA = A.data?.actor ?? null;
  const actorB = B.data?.actor ?? null;
  const actorC = C.data?.actor ?? null;
  ck("actor: operating == test (모드는 actor 를 바꾸지 않는다)", J(actorA) === J(actorB), J(actorB));
  const diffKeys = Object.keys(actorC ?? {}).filter((k) => J(actorB?.[k]) !== J(actorC?.[k]));
  ck("actor: actAs 경로만 actor 가 다르다", diffKeys.length > 0, `다른 필드=${J(diffKeys)}`);
  ck(
    "actor 차이는 임퍼소네이션 축에 한정(role/team/part/memberRole/defaultPart/impersonating/impersonatedUserId)",
    diffKeys.every((k) =>
      ["role", "teamName", "partName", "memberRole", "defaultPart", "impersonating", "impersonatedUserId"].includes(k),
    ),
    J(diffKeys),
  );
  ck("actor.impersonating: operating=false / test=false / actAs=true", actorA?.impersonating === false && actorB?.impersonating === false && actorC?.impersonating === true, `${actorA?.impersonating} / ${actorB?.impersonating} / ${actorC?.impersonating}`);
  console.log(`     actor(A=operating) = ${J(actorA)}`);
  console.log(`     actor(B=test)      = ${J(actorB)}`);
  console.log(`     actor(C=actAs)     = ${J(actorC)}`);
}

void (async () => {
  COOKIE = await makeAdminCookie();

  // 팀/주차 픽스처 — 화면과 동일 원천에서 해소.
  const teamsRes = await api(`/api/admin/cluster4/teams?organization=${ORG}&mode=test`);
  const TEAM_ID = (teamsRes.json?.data ?? []).find((t) => t.teamName === TEAM_NAME)?.id;
  const { data: halfRow } = await sb
    .from("cluster4_team_halves")
    .select("id")
    .eq("organization_slug", ORG)
    .eq("team_name", TEAM_NAME)
    .eq("is_active", true)
    .order("half_key", { ascending: false })
    .limit(1)
    .maybeSingle();
  const sum = await api(
    `/api/admin/team-parts/info/team-detail/week-summary?organization=${ORG}&teamHalfId=${halfRow.id}&mode=test`,
  );
  // 대조 주차 = 신청 데이터(cells)가 실제로 존재하는 주차를 우선 선택(빈 배열끼리 비교로 위장되지 않게).
  const weeks = (sum.json?.data?.selectableWeeks ?? []).slice(0, 8);
  let WEEK_ID = sum.json?.data?.week?.weekId ?? null;
  let PART = null;
  for (const w of weeks) {
    const { data: headers } = await sb
      .from("cluster4_experience_part_submissions")
      .select("part_name")
      .eq("organization_slug", ORG)
      .eq("week_id", w.weekId)
      .eq("team_id", TEAM_ID)
      .limit(1);
    if (headers?.length) {
      WEEK_ID = w.weekId;
      PART = headers[0].part_name;
      break;
    }
  }
  if (!PART) {
    const probe = await partInput({ teamId: TEAM_ID, weekId: WEEK_ID, part: null, mode: "test" });
    PART = probe.data?.parts?.[0] ?? null;
  }

  // actAsTestUserId = 그 팀 소속 테스트 유저(actor 가 실제로 바뀌도록). 없으면 아무 마커 유저.
  const { data: markers } = await sb.from("test_user_markers").select("user_id");
  const markerIds = (markers ?? []).map((m) => m.user_id);
  const { data: teamMems } = await sb
    .from("user_memberships")
    .select("user_id,team_name")
    .in("user_id", markerIds.slice(0, 200))
    .eq("team_name", TEAM_NAME);
  const ACT_AS = teamMems?.[0]?.user_id ?? markerIds[0];

  console.log(`fixture = [${ORG}] ${TEAM_NAME} teamId=${TEAM_ID}`);
  console.log(`week    = ${WEEK_ID}`);
  console.log(`part    = ${PART}`);
  console.log(`actAs   = ${ACT_AS}`);

  // ── 대조 1: 파트 미지정(파트 드롭다운 조회 경로) ────────────────────────
  {
    const A = await partInput({ teamId: TEAM_ID, weekId: WEEK_ID, part: null, mode: "operating" });
    const B = await partInput({ teamId: TEAM_ID, weekId: WEEK_ID, part: null, mode: "test" });
    const C = await partInput({ teamId: TEAM_ID, weekId: WEEK_ID, part: null, mode: "test", actAs: ACT_AS });
    compareTriple("① part 미지정 (파트 드롭다운 조회)", A, B, C);
    console.log(`     parts = ${J(B.data?.parts)}`);
  }

  // ── 대조 2: 실제 파트 지정(크루/셀 포함) ────────────────────────────────
  if (PART) {
    const A = await partInput({ teamId: TEAM_ID, weekId: WEEK_ID, part: PART, mode: "operating" });
    const B = await partInput({ teamId: TEAM_ID, weekId: WEEK_ID, part: PART, mode: "test" });
    const C = await partInput({ teamId: TEAM_ID, weekId: WEEK_ID, part: PART, mode: "test", actAs: ACT_AS });
    compareTriple(`② part=${PART} (그리드 — crews/cells 포함)`, A, B, C);
    ck("관측 유효: crews 비어 있지 않음", (B.data?.crews ?? []).length > 0, `crews=${(B.data?.crews ?? []).length}`);
    ck("관측 유효: cells 비어 있지 않음", (B.data?.cells ?? []).length > 0, `cells=${(B.data?.cells ?? []).length}`);
    ck("submitted 값 관측됨", typeof B.data?.submitted === "boolean", J(B.data?.submitted));
  }

  // ── 대조 3: 팀 총괄(집계 DTO) ──────────────────────────────────────────
  {
    const A = await partInput({ teamId: TEAM_ID, weekId: WEEK_ID, part: "__overall__", mode: "operating" });
    const B = await partInput({ teamId: TEAM_ID, weekId: WEEK_ID, part: "__overall__", mode: "test" });
    const C = await partInput({ teamId: TEAM_ID, weekId: WEEK_ID, part: "__overall__", mode: "test", actAs: ACT_AS });
    compareTriple("③ part=팀 총괄 (aggregate)", A, B, C);
  }

  console.log(`\n== PASS ${pass} / FAIL ${fail} ==`);
  process.exit(fail > 0 ? 1 : 0);
})();
