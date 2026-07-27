// 두 화면의 **크루 ID 대조** (실제 HTTP) — 2026-07-27
//
//   node --dns-result-order=ipv4first scripts/verify-experience-team-parts-crew-parity-http.mjs
//
// 비교(같은 org·팀·주차·파트):
//   A) /api/admin/team-parts/info/team-detail/week-summary  → operatedParts · crewRows(rawPart 별)
//   B) /api/admin/cluster4/experience/part-input            → parts(드롭다운) · crews(평가 대상)
//
// 기대(불변식):
//   ① B.parts 의 모든 파트는 B.crews ≥1  ("평가 대상 크루가 없습니다" 상태 불가)
//   ② B.parts ⊆ A.operatedParts
//   ③ B.crews(userId) ⊆ A.crewRows(같은 파트, userId)  — 파트가 갈리는 크루 0명
//   ④ A 에는 있는데 B 에 없는 크루는 **정책 규칙**으로만 설명된다:
//        · classLabel 이 심화(파트장) = 평가자 전용 역할(평가 대상 아님)
//        · 집합 ② 평가 제외 축: 시즌 휴식 · (효력 발생 후) 활동 중단 · 엘리트 · 바사노스
//      그 외 사유가 1건이라도 있으면 FAIL(크루 ID 를 출력한다).
//   ⑤ A.operatedParts 인데 B.parts 에 없는 파트는 평가 대상 크루가 실제 0명이다.
//
// 범위: 활성 반기 팀 전수 × mode(operating/test) × 현재 주차. 읽기 전용(GET only).
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

let pass = 0;
let fail = 0;
const failures = [];
const ck = (label, ok, detail = "") => {
  if (!ok) {
    console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`);
    failures.push(label);
    fail++;
  } else pass++;
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

void (async () => {
  COOKIE = await makeAdminCookie();

  const { data: halves } = await sb
    .from("cluster4_team_halves")
    .select("id,team_name,organization_slug,half_key,is_active")
    .eq("is_active", true)
    .order("half_key", { ascending: false });

  // org 별 팀 id 해소(화면과 동일 원천).
  const teamIdCache = new Map();
  const teamId = async (org, teamName, mode) => {
    const key = `${org}::${mode}`;
    if (!teamIdCache.has(key)) {
      const r = await api(`/api/admin/cluster4/teams?organization=${org}&mode=${mode}`);
      teamIdCache.set(key, r.json?.data ?? []);
    }
    return (teamIdCache.get(key) ?? []).find((t) => t.teamName === teamName)?.id ?? null;
  };

  // 그 주차 시즌의 시즌 전체 휴식자(정책 사유 확인용).
  const restCache = new Map();
  // 평가 제외 축(집합 ②) — 엘리트(growth_status='graduated') · 바사노스(그 주차까지 누적 승인 ≥ 29).
  const evalExcludeCache = new Map();
  const evalExclude = async (weekStart) => {
    if (evalExcludeCache.has(weekStart)) return evalExcludeCache.get(weekStart);
    const elite = new Set();
    const basanos = new Set();
    const { data: gr } = await sb.from('user_profiles').select('user_id').eq('growth_status', 'graduated');
    for (const r of gr ?? []) elite.add(r.user_id);
    // ⚠ PostgREST 1000행 cap — range 페이지네이션 없이는 누적이 잘려 바사노스가 통째로 누락된다.
    const cnt = new Map();
    for (let from = 0; ; from += 1000) {
      const { data: succ } = await sb.from('user_week_statuses').select('user_id')
        .eq('status', 'success').lte('week_start_date', weekStart)
        .order('user_id', { ascending: true }).range(from, from + 999);
      const rows = succ ?? [];
      for (const r of rows) cnt.set(r.user_id, (cnt.get(r.user_id) ?? 0) + 1);
      if (rows.length < 1000) break;
    }
    for (const [uid, n] of cnt) if (n >= 29 && !elite.has(uid)) basanos.add(uid);
    const out = { elite, basanos };
    evalExcludeCache.set(weekStart, out);
    return out;
  };

  const seasonRest = async (weekId) => {
    if (restCache.has(weekId)) return restCache.get(weekId);
    const { data: w } = await sb.from("weeks").select("season_key").eq("id", weekId).maybeSingle();
    const set = new Set();
    if (w?.season_key) {
      const { data: rows } = await sb
        .from("user_season_statuses")
        .select("user_id")
        .eq("season_key", w.season_key)
        .eq("status", "rest");
      for (const r of rows ?? []) set.add(r.user_id);
    }
    restCache.set(weekId, set);
    return set;
  };

  const seenHalf = new Set();
  let combos = 0;
  const policyDrops = [];

  for (const h of halves ?? []) {
    const key = `${h.organization_slug}::${h.team_name}`;
    if (seenHalf.has(key)) continue;
    seenHalf.add(key);

    for (const mode of ["operating", "test"]) {
      const tid = await teamId(h.organization_slug, h.team_name, mode);
      if (!tid) continue;
      const modeQs = mode === "test" ? "&mode=test" : "";

      const sum = await api(
        `/api/admin/team-parts/info/team-detail/week-summary?organization=${h.organization_slug}&teamHalfId=${h.id}${modeQs}`,
      );
      const weekId = sum.json?.data?.week?.weekId;
      if (sum.status !== 200 || !weekId) continue;
      combos++;
      const label = `[${h.organization_slug}] ${h.team_name}/${mode}`;
      const operated = (sum.json.data.operatedParts ?? [])
        .map((p) => p.partName)
        .filter((p) => p !== "일반");
      const crewRows = sum.json.data.crewRows ?? [];
      const restIds = await seasonRest(weekId);
      const { data: wkRow } = await sb.from('weeks').select('start_date').eq('id', weekId).maybeSingle();
      const weekStart = String(wkRow?.start_date ?? '').slice(0, 10);
      const { elite: eliteIds, basanos: basanosIds } = await evalExclude(weekStart);

      const teamQs =
        `organization=${h.organization_slug}&team_id=${tid}` +
        `&team_name=${encodeURIComponent(h.team_name)}&week_id=${weekId}${modeQs}`;
      const b = await api(`/api/admin/cluster4/experience/part-input?${teamQs}`);
      ck(`${label} part-input 200`, b.status === 200, `status=${b.status}`);
      const parts = b.json?.data?.parts ?? [];

      // ② 드롭다운 ⊆ <운용> 파트
      const over = parts.filter((p) => !operated.includes(p));
      ck(`${label} 드롭다운 ⊆ <운용> 파트`, over.length === 0, `초과=${J(over)}`);

      for (const part of operated) {
        const r = await api(`/api/admin/cluster4/experience/part-input?${teamQs}&part=${encodeURIComponent(part)}`);
        const crews = r.json?.data?.crews ?? [];
        const crewIds = new Set(crews.map((c) => c.userId));
        const sotInPart = crewRows.filter((x) => (x.rawPart ?? "").trim() === part);
        const sotIds = new Set(sotInPart.map((x) => x.userId));

        if (parts.includes(part)) {
          // ① 드롭다운 파트는 크루 ≥1
          ck(`${label} '${part}' 드롭다운 파트 크루 ≥1`, crews.length > 0, `crews=0`);
        } else {
          // ⑤ 드롭다운에 없는 <운용> 파트는 평가 대상 0명
          ck(`${label} '${part}' 드롭다운 제외 = 평가 대상 0명`, crews.length === 0, `crews=${crews.length}`);
        }

        // ③ part-input 크루 ⊆ team-parts 같은 파트 크루
        const stray = crews.filter((c) => !sotIds.has(c.userId));
        ck(
          `${label} '${part}' 크루 ⊆ 팀상세 동일 파트`,
          stray.length === 0,
          `팀상세에 없거나 파트가 다른 크루=${J(stray.map((c) => `${c.userId}(${c.displayName})`))}`,
        );

        // ④ 빠진 크루는 정책 규칙으로만 설명
        for (const row of sotInPart) {
          if (crewIds.has(row.userId)) continue;
          const isLeader = row.positionCode === "advanced_part_leader";
          const isRest = restIds.has(row.userId);
          const isElite = eliteIds.has(row.userId);
          const isBasanos = basanosIds.has(row.userId);
          ck(
            `${label} '${part}' 제외 크루 ${row.userId} 사유가 정책 규칙`,
            isLeader || isRest || isElite || isBasanos,
            `class=${row.classLabel}(${row.positionCode}) rest=${isRest} elite=${isElite} basanos=${isBasanos} name=${row.name ?? ""}`,
          );
          if (isLeader || isRest || isElite || isBasanos) {
            policyDrops.push(
              `${label} '${part}' ${row.name ?? row.userId} — ${[isLeader && "파트장(평가자)", isRest && "시즌 휴식", isElite && "엘리트", isBasanos && "바사노스"].filter(Boolean).join(" + ")}`,
            );
          }
        }
      }
    }
  }

  console.log(`\n── 정책 규칙으로 제외된 크루 ${policyDrops.length}건(사유 명시) ──`);
  for (const d of policyDrops.slice(0, 60)) console.log(`  · ${d}`);
  if (policyDrops.length > 60) console.log(`  … 외 ${policyDrops.length - 60}건`);
  console.log(`\n== 조합 ${combos} · PASS ${pass} / FAIL ${fail} ==`);
  if (fail > 0) {
    console.log(`실패 목록:\n${failures.map((f) => `  - ${f}`).join("\n")}`);
    process.exit(1);
  }
})();
