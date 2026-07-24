/**
 * 파트×주차 존재표(partWeekMatrix) effective 규칙 통일 검증 — READ-ONLY.
 *
 * "같은 원천 데이터면 mode/org 무관하게 같은 결과, 그리고 매트릭스 present 는 공통 resolver
 *  (override(≤W) → UPH(W) → 현재 멤버십, 경과 게이트 없음)와 정확히 일치한다" 를
 *  **실제 HTTP API 응답**으로 확인한다.
 *
 * 사전조건: admin dev :3000.
 * Usage:
 *   node scripts/verify-part-week-matrix-effective-sot.mjs --capture before   # 수정 전 스냅샷 저장
 *   node scripts/verify-part-week-matrix-effective-sot.mjs                     # 등가성/회귀 검증 (+ before diff)
 *
 * 등가성은 DB(service-role)로 UPH/override/membership 을 직접 재구성해 API 의 present 와 대조한다
 * (resolvePositionAtBatch 와 동일 규칙의 순수 재현 — 서버 함수 import 없이 규칙만 복제해 교차검증).
 */
import { createRequire } from "node:module";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const adminRoot = resolve(__dirname, "..");
const rq = createRequire(resolve(adminRoot, "package.json"));
const { createClient } = rq("@supabase/supabase-js");
const { createServerClient } = rq("@supabase/ssr");

const env = readFileSync(resolve(adminRoot, ".env.local"), "utf8");
const get = (k) => env.match(new RegExp(`^${k}=(.+)$`, "m"))?.[1]?.trim();
const ADMIN = process.env.ADMIN_BASE ?? "http://localhost:3000";
const URL_ = get("NEXT_PUBLIC_SUPABASE_URL");
const ANON = get("NEXT_PUBLIC_SUPABASE_ANON_KEY");
const sb = createClient(URL_, get("SUPABASE_SERVICE_ROLE_KEY"));
const brow = createClient(URL_, ANON);

const ORGS = ["encre", "oranke", "phalanx"];
const MODES = ["operating", "test"];
const BEFORE_PATH = resolve(adminRoot, "scratchpad-part-week-before.json");
const CAPTURE = process.argv.includes("--capture")
  ? process.argv[process.argv.indexOf("--capture") + 1] ?? "before"
  : null;

const strip = (v) => (v ?? "").replace(/\(.*?\)/g, "").trim();
let fail = 0;
const ck = (l, ok, d = "") => { console.log(`  ${ok ? "✓" : "✗"} ${l}${d ? ` — ${d}` : ""}`); if (!ok) fail++; };

async function cookieHeader() {
  const { data: admins } = await sb.from("admin_users").select("email").eq("is_active", true).not("email", "is", null).limit(1);
  const email = admins?.[0]?.email;
  const { data: link } = await sb.auth.admin.generateLink({ type: "magiclink", email });
  const { data: v } = await brow.auth.verifyOtp({ email, token: link.properties.email_otp, type: "magiclink" });
  const cap = [];
  const srv = createServerClient(URL_, ANON, { cookies: { getAll: () => [], setAll: (i) => cap.push(...i) } });
  await srv.auth.setSession({ access_token: v.session.access_token, refresh_token: v.session.refresh_token });
  console.log(`admin 세션: ${email}`);
  return cap.map((i) => `${i.name}=${i.value}`).join("; ");
}

// ── DB 로 present 재구성 (공통 resolver 규칙: override(≤W) → UPH(W) → 현재 멤버십, 경과 게이트 없음) ──
//   반환: teamName → { partOn: Map(partName→Set<weekIdx>), userWeekPart: Map(`uid|wi`→part|null) }
async function reconstructExpected(organization, mode, teams, weekColumns, halfSeasonKeys, todayIso, currentHalf, selectedHalf) {
  const teamNameSet = new Set(teams.map((t) => t.teamName));
  const wiByStart = new Map(weekColumns.map((c, i) => [c.weekStartDate, i]));
  const applyFallback = selectedHalf === currentHalf;

  // 모집단 스코프(API 와 동일하게) — mode 로 유저 필터.
  const { data: profs } = await sb
    .from("user_profiles")
    .select("user_id,organization_slug,role")
    .eq("organization_slug", organization);
  const orgUserIds = new Set((profs ?? []).map((p) => p.user_id));

  // UPH base (org + 반기 시즌들)
  const uph = [];
  for (let from = 0; ; from += 1000) {
    const { data } = await sb
      .from("user_position_histories")
      .select("user_id,raw_team,raw_part,week_start_date")
      .eq("organization", organization)
      .in("season_key", halfSeasonKeys.length ? halfSeasonKeys : ["__none__"])
      .order("week_start_date", { ascending: true })
      .range(from, from + 999);
    const batch = data ?? [];
    uph.push(...batch);
    if (batch.length < 1000) break;
  }
  const resolveTeam = (rt) => (teamNameSet.has(rt ?? "") ? rt : (teamNameSet.has(strip(rt)) ? strip(rt) : null));

  // assign[team][wi][uid] = Set(part)
  const assign = new Map();
  const slot = (team, wi, uid) => {
    const bw = assign.get(team) ?? new Map(); assign.set(team, bw);
    const bu = bw.get(wi) ?? new Map(); bw.set(wi, bu);
    const s = bu.get(uid) ?? new Set(); bu.set(uid, s); return s;
  };
  const uphWeeksByTeam = new Map();
  for (const r of uph) {
    const team = resolveTeam(r.raw_team); if (!team) continue;
    const wi = wiByStart.get(String(r.week_start_date).slice(0, 10)); if (wi === undefined) continue;
    (uphWeeksByTeam.get(team) ?? uphWeeksByTeam.set(team, new Set()).get(team)).add(wi);
    const part = (r.raw_part ?? "").trim(); if (part) slot(team, wi, r.user_id).add(part);
  }

  // 멤버십 폴백 — 경과 게이트 없음(현재 반기의 UPH 없는 모든 주차). API 와 동일 원천:
  //   is_current, membership_state != 'rest', profile.org == organization, part 비어있지 않음.
  if (applyFallback) {
    const { data: mems } = await sb
      .from("user_memberships")
      .select("user_id,team_name,part_name,membership_state,is_current")
      .in("team_name", teams.map((t) => t.teamName))
      .eq("is_current", true);
    const memRows = (mems ?? []).filter(
      (m) => m.membership_state !== "rest" && orgUserIds.has(m.user_id) && (m.part_name ?? "").trim(),
    );
    const byTeam = new Map();
    for (const m of memRows) {
      if (!teamNameSet.has((m.team_name ?? "").trim())) continue;
      const arr = byTeam.get(m.team_name) ?? []; arr.push({ userId: m.user_id, part: m.part_name.trim() }); byTeam.set(m.team_name, arr);
    }
    for (const t of teams) {
      const rows = byTeam.get(t.teamName); if (!rows || !rows.length) continue;
      const uphWeeks = uphWeeksByTeam.get(t.teamName) ?? new Set();
      for (let wi = 0; wi < weekColumns.length; wi++) {
        if (uphWeeks.has(wi)) continue; // 게이트 제거: 미래 포함 전 주차
        for (const r of rows) slot(t.teamName, wi, r.userId).add(r.part);
      }
    }
  }

  // override carry-forward (org 전체, ≤마지막 주차)
  const lastWeek = weekColumns.length ? weekColumns[weekColumns.length - 1].weekStartDate : null;
  if (lastWeek) {
    const ovr = [];
    for (let from = 0; ; from += 1000) {
      const { data } = await sb
        .from("cluster4_team_week_position_overrides")
        .select("user_id,raw_team,raw_part,week_start_date")
        .eq("organization", organization)
        .lte("week_start_date", lastWeek)
        .order("week_start_date", { ascending: true })
        .range(from, from + 999);
      const batch = data ?? []; ovr.push(...batch);
      if (batch.length < 1000) break;
    }
    const idx = new Map();
    for (const r of ovr) {
      const k = `${r.user_id}::${r.raw_team}`;
      const arr = idx.get(k) ?? []; arr.push(r); idx.set(k, arr);
    }
    const resolveAt = (arr, ws) => { let f = null; for (const r of arr) { if (String(r.week_start_date).slice(0, 10) <= ws) f = r; else break; } return f; };
    for (const arr of idx.values()) {
      arr.sort((a, b) => String(a.week_start_date).localeCompare(String(b.week_start_date)));
      const team = resolveTeam(arr[0].raw_team); if (!team) continue;
      for (let wi = 0; wi < weekColumns.length; wi++) {
        const hit = resolveAt(arr, weekColumns[wi].weekStartDate); if (!hit) continue;
        const s = slot(team, wi, hit.user_id); s.clear();
        const part = (hit.raw_part ?? "").trim(); if (part) s.add(part);
      }
    }
  }

  // partOn 집계
  const out = new Map();
  for (const t of teams) {
    const bw = assign.get(t.teamName) ?? new Map();
    const partOn = new Map();
    for (const [wi, bu] of bw) for (const s of bu.values()) for (const p of s) {
      (partOn.get(p) ?? partOn.set(p, new Set()).get(p)).add(wi);
    }
    out.set(t.teamName, { partOn });
  }
  return out;
}

async function fetchInfo(cookie, organization, mode) {
  const url = `/api/admin/team-parts/info?organization=${organization}&mode=${mode}`;
  const r = await fetch(`${ADMIN}${url}`, { headers: { cookie, "content-type": "application/json" }, cache: "no-store" });
  const j = await r.json().catch(() => null);
  return { status: r.status, data: j?.data ?? null };
}

// 반기 → 시즌키 목록 (halfKeyToSeasonKeys 규칙: YYYY-H1 = 겨울+봄, YYYY-H2 = 여름+가을)
function halfSeasons(halfKey) {
  const m = /^(\d{4})-H([12])$/.exec(halfKey ?? "");
  if (!m) return [];
  const y = m[1];
  return m[2] === "1" ? [`${y}-winter`, `${y}-spring`] : [`${y}-summer`, `${y}-autumn`];
}

async function main() {
  const cookie = await cookieHeader();
  const todayIso = new Date().toISOString().slice(0, 10);
  const before = CAPTURE ? null : (existsSync(BEFORE_PATH) ? JSON.parse(readFileSync(BEFORE_PATH, "utf8")) : null);
  const capture = {};
  const report = [];

  for (const org of ORGS) {
    for (const mode of MODES) {
      const { status, data } = await fetchInfo(cookie, org, mode);
      console.log(`\n=== ${org} / mode=${mode} — HTTP ${status} ===`);
      ck(`HTTP 200 (${org}/${mode})`, status === 200);
      if (status !== 200 || !data) continue;
      const currentHalf = data.currentHalfKey;
      const selectedHalf = data.selectedHalfKey;
      const weekColumns = data.weekColumns ?? [];
      ck(`DTO 키 존재 (${org}/${mode})`, Array.isArray(data.teams) && Array.isArray(weekColumns));
      const teams = (data.teams ?? []).map((t) => ({ teamName: t.teamName, teamHalfId: t.teamHalfId }));
      if (teams.length === 0) { console.log("  (팀 없음)"); continue; }

      // 구조 검증
      for (const t of data.teams ?? []) {
        const m = t.partWeekMatrix;
        if (!m) continue;
        ck(`present 구조 (${org}/${mode}/${t.teamName})`,
          m.present.length === m.partNames.length && m.present.every((row) => row.length === weekColumns.length),
          `rows=${m.present.length} names=${m.partNames.length} cols=${weekColumns.length}`);
      }

      // 등가성: DB 재구성 vs API present
      const expected = await reconstructExpected(
        org, mode, teams, weekColumns, halfSeasons(selectedHalf), todayIso, currentHalf, selectedHalf,
      );
      for (const t of data.teams ?? []) {
        const m = t.partWeekMatrix; if (!m) continue;
        const exp = expected.get(t.teamName); if (!exp) continue;
        let mism = 0; const samples = [];
        for (let pi = 0; pi < m.partNames.length; pi++) {
          const part = m.partNames[pi];
          const expSet = exp.partOn.get(part) ?? new Set();
          for (let wi = 0; wi < weekColumns.length; wi++) {
            const apiOn = !!m.present[pi][wi];
            const expOn = expSet.has(wi);
            if (apiOn !== expOn) { mism++; if (samples.length < 4) samples.push(`${part}@${weekColumns[wi].label}: api=${apiOn} exp=${expOn}`); }
          }
        }
        ck(`등가 present==resolver규칙 (${org}/${mode}/${t.teamName})`, mism === 0, mism ? samples.join(" | ") : "");
      }

      // 캡처/보고용 — 팀별 present + partNames/partCount + 미래 열 파트 집합
      const futureIdx = weekColumns.map((c, i) => ({ c, i })).filter(({ c }) => c.weekStartDate > todayIso).map(({ i }) => i);
      for (const t of data.teams ?? []) {
        const m = t.partWeekMatrix; if (!m) continue;
        const futureParts = new Set();
        for (let pi = 0; pi < m.partNames.length; pi++)
          for (const wi of futureIdx) if (m.present[pi][wi]) futureParts.add(m.partNames[pi]);
        const key = `${org}|${mode}|${t.teamName}`;
        capture[key] = {
          partNames: t.partNames, partCount: t.partCount,
          present: m.present, matrixPartNames: m.partNames,
          futureParts: [...futureParts].sort(),
        };

        // 팀카드 요약 불변식 = "오늘 이하 마지막 주차의 실제 운용 파트"(derivePartsFromMatrix 정의).
        //   미래 투영(override든 멤버십이든)에 휩쓸리지 않아야 한다. before 원값과의 단순 비교가 아니라
        //   **정의 자체**를 검증한다(구 값은 미래 override 투영이 섞인 버그값일 수 있으므로).
        let upperIdx = -1;
        for (let wi = weekColumns.length - 1; wi >= 0; wi--) {
          if (weekColumns[wi].weekStartDate <= todayIso) { upperIdx = wi; break; }
        }
        if (upperIdx < 0) upperIdx = weekColumns.length - 1;
        let lastIdx = -1;
        for (let wi = upperIdx; wi >= 0; wi--) { if (m.present.some((r) => r[wi])) { lastIdx = wi; break; } }
        const expectedNames = lastIdx < 0
          ? ["일반"]
          : (m.partNames.filter((_, pi) => m.present[pi][lastIdx]).length
              ? m.partNames.filter((_, pi) => m.present[pi][lastIdx])
              : ["일반"]);
        const summaryOk = JSON.stringify(expectedNames) === JSON.stringify(t.partNames) && expectedNames.length === t.partCount;
        ck(`팀카드 요약=오늘이하 마지막주차 (${key})`, summaryOk,
          `요약=[${t.partNames}](${t.partCount}) vs W(${lastIdx >= 0 ? weekColumns[lastIdx].label : "-"})=[${expectedNames}]`);

        if (before && before[key]) {
          const b = before[key];
          const changed = JSON.stringify(b.futureParts) !== JSON.stringify([...futureParts].sort());
          const summaryChanged = JSON.stringify(b.partNames) !== JSON.stringify(t.partNames);
          report.push({
            org, mode, team: t.teamName,
            beforeFuture: b.futureParts.join(",") || "∅", afterFuture: [...futureParts].sort().join(",") || "∅", changed,
            summaryNote: summaryChanged ? `요약정정 [${b.partNames}]→[${t.partNames}]` : "",
          });
        }
      }
    }
  }

  if (CAPTURE) {
    writeFileSync(BEFORE_PATH, JSON.stringify(capture, null, 2));
    console.log(`\n[capture=${CAPTURE}] 저장: ${BEFORE_PATH} (${Object.keys(capture).length} 팀)`);
    return;
  }

  if (report.length) {
    console.log(`\n=== 보고: 미래 주차 파트 (변경 전 → 변경 후) ===`);
    console.log(`org       | mode      | 팀                    | 미래(전)        | 미래(후)        | 변화   | 요약정정`);
    for (const r of report.sort((a, b) => Number(b.changed) - Number(a.changed))) {
      console.log(`${r.org.padEnd(9)} | ${r.mode.padEnd(9)} | ${r.team.padEnd(20)} | ${r.beforeFuture.padEnd(14)} | ${r.afterFuture.padEnd(14)} | ${(r.changed ? "★변경" : "-").padEnd(6)} | ${r.summaryNote || "-"}`);
    }
  }
  console.log(`\n=== RESULT: ${fail === 0 ? "ALL PASS" : fail + " FAIL"} ===`);
  process.exit(fail === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
