/**
 * carry-forward 검증 — "저장한 주차부터 이후 전부 반영, 이전 주차는 불변".
 *
 * 요구사항(2026-07-22):
 *   2026 여름 4주차에서 정규/비트 → 정규/보컬 저장
 *     → 4주 보컬, 5주 보컬, 6주 보컬
 *     → 3주는 비트 그대로
 *
 * 검증 대상(실제 HTTP):
 *   · 파트×주차 존재표(GET /api/admin/team-parts/info) — 주차 컬럼별 ON 파트로 이월을 직접 관찰
 *   · 팀 상세 [B](week-summary) — 이전 주차/저장 주차 각각 조회해 값 비교
 *
 *   ⚠ override 를 생성/원복한다(테스트 스코프 QA 팀). 사전조건: admin dev :3000.
 *   Usage: node scripts/verify-week-position-carry-forward.mjs
 */
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const adminRoot = resolve(__dirname, "..");
const rq = createRequire(resolve(adminRoot, "package.json"));
const { createClient } = rq("@supabase/supabase-js");
const { createServerClient } = rq("@supabase/ssr");

const env = readFileSync(resolve(adminRoot, ".env.local"), "utf8");
const get = (k) => env.match(new RegExp(`^${k}=(.+)$`, "m"))?.[1]?.trim();
const ADMIN = "http://localhost:3000";
const URL_ = get("NEXT_PUBLIC_SUPABASE_URL");
const ANON = get("NEXT_PUBLIC_SUPABASE_ANON_KEY");
const sb = createClient(URL_, get("SUPABASE_SERVICE_ROLE_KEY"));
const brow = createClient(URL_, ANON);
const OVR = "cluster4_team_week_position_overrides";

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

async function main() {
  const cookie = await cookieHeader();
  const call = (path, init) =>
    fetch(`${ADMIN}${path}`, { ...init, headers: { cookie, "content-type": "application/json", ...(init?.headers ?? {}) }, cache: "no-store" })
      .then(async (r) => ({ status: r.status, j: await r.json().catch(() => null) }));

  const ORG = "encre", MODE = "test";
  const { data: th } = await sb.from("cluster4_team_halves")
    .select("id,team_name,half_key").eq("organization_slug", ORG).eq("is_active", true).eq("is_qa_test", true)
    .order("display_order").limit(1);
  const team = th?.[0];
  if (!team) { console.log("QA 팀 없음 — abort"); process.exit(1); }
  const TEAM = team.team_name;

  const S = (weekId) => `/api/admin/team-parts/info/team-detail/week-summary?organization=${ORG}&teamHalfId=${team.id}&mode=${MODE}${weekId ? `&weekId=${weekId}` : ""}`;
  const cur = (await call(S())).j?.data;
  if (!cur?.week || cur.week.reviewCompleted) { console.log("편집 가능한 주차 없음 — abort"); process.exit(1); }
  const WEEK = cur.week.weekStartDate, weekId = cur.week.weekId;

  // 이전 주차(선택 가능한 주차 중 저장 주차 직전).
  const selectable = (cur.selectableWeeks ?? []).slice().sort((a, b) => a.weekStartDate.localeCompare(b.weekStartDate));
  const idxCur = selectable.findIndex((w) => w.weekStartDate === WEEK);
  const prevWeek = idxCur > 0 ? selectable[idxCur - 1] : null;
  console.log(`팀=${TEAM} 저장주차=${cur.week.label}(${WEEK}) 이전주차=${prevWeek?.label ?? "(없음)"}(${prevWeek?.weekStartDate ?? "-"})`);
  ck("이전 주차 확보(불변 검증용)", Boolean(prevWeek));
  if (!prevWeek) { console.log(`\n=== RESULT: ${fail} FAIL ===`); process.exit(1); }

  // 매트릭스 — 주차 컬럼별 ON 파트.
  const infoUrl = `/api/admin/team-parts/info?organization=${ORG}&half=${team.half_key}&mode=${MODE}`;
  const matrixParts = (dto) => {
    const cols = dto?.weekColumns ?? [];
    const t = (dto?.teams ?? []).find((x) => x.teamName === TEAM);
    const m = t?.partWeekMatrix;
    return cols.map((c, wi) => {
      const on = new Set();
      m?.partNames.forEach((p, y) => { if (m.present?.[y]?.[wi]) on.add(p); });
      return { week: c.weekStartDate, label: c.label, on };
    });
  };
  const before = matrixParts((await call(infoUrl)).j?.data);
  const wi = before.findIndex((r) => r.week === WEEK);
  ck("매트릭스에 저장 주차 컬럼 존재", wi >= 0, `idx=${wi}`);
  if (wi < 0) { console.log(`\n=== RESULT: ${fail} FAIL ===`); process.exit(1); }
  const laterIdx = before.map((_, i) => i).filter((i) => i > wi).slice(0, 3);
  console.log(`  이후 주차 컬럼 ${laterIdx.length}개로 이월 검증`);

  // 대상 크루 + 이동할 미운용 파트.
  const rows = cur.crewRows ?? [];
  const target = rows.find((r) => r.positionCode !== "advanced_part_leader") ?? rows[0];
  const operated = new Set((cur.operatedParts ?? []).map((p) => p.partName));
  const { data: catalog } = await sb.from("cluster4_team_parts")
    .select("part_name,display_order").eq("team_half_id", team.id).order("display_order");
  const newPart = (catalog ?? []).map((c) => c.part_name).find((p) => p && p !== target.rawPart && !operated.has(p));
  ck("미운용 파트 확보(이월 관측용)", Boolean(newPart), `${target?.rawPart} → ${newPart}`);
  if (!newPart) { console.log(`\n=== RESULT: ${fail} FAIL ===`); process.exit(1); }

  const { data: prof } = await sb.from("user_profiles").select("display_name").eq("user_id", target.userId).maybeSingle();
  console.log(`대상: ${prof?.display_name} — ${target.rawPart}/${target.positionCode} → ${newPart}/${target.positionCode}\n`);
  const ovrBefore = (await sb.from(OVR).select("raw_part,position_code")
    .eq("user_id", target.userId).eq("week_start_date", WEEK).eq("organization", ORG).eq("raw_team", TEAM).maybeSingle()).data ?? null;
  const prevWeekRowBefore = ((await call(S(prevWeek.weekId))).j?.data?.crewRows ?? []).find((r) => r.userId === target.userId);

  // ── 저장 ──
  const patch = await call(`/api/admin/team-parts/info/team-detail/week-position?mode=${MODE}`, {
    method: "PATCH",
    body: JSON.stringify({ organization: ORG, weekId, rawTeam: TEAM, changes: [{ userId: target.userId, rawPart: newPart, positionCode: target.positionCode }] }),
  });
  ck("PATCH 200", patch.status === 200, JSON.stringify(patch.j).slice(0, 110));

  // ── 이월 확인 ──
  const after = matrixParts((await call(infoUrl)).j?.data);
  console.log("  매트릭스 주차별 ON 파트:");
  for (const i of [wi - 1, wi, ...laterIdx].filter((i) => i >= 0)) {
    console.log(`    ${before[i].label.padEnd(14)} ${[...before[i].on].join(",")}  →  ${[...after[i].on].join(",")}`);
  }
  ck(`저장 주차(${before[wi].label}) 새 파트 ON`, after[wi].on.has(newPart), [...after[wi].on].join(","));
  for (const i of laterIdx)
    ck(`이후 주차(${before[i].label}) 새 파트 ON (이월)`, after[i].on.has(newPart), [...after[i].on].join(","));
  if (wi > 0) {
    const same = JSON.stringify([...before[wi - 1].on].sort()) === JSON.stringify([...after[wi - 1].on].sort());
    ck(`이전 주차(${before[wi - 1].label}) 불변`, same, `${[...before[wi - 1].on].join(",")} → ${[...after[wi - 1].on].join(",")}`);
  }
  const prevWeekRowAfter = ((await call(S(prevWeek.weekId))).j?.data?.crewRows ?? []).find((r) => r.userId === target.userId);
  ck(`이전 주차 [B] 값 불변`,
    prevWeekRowAfter?.rawPart === prevWeekRowBefore?.rawPart && prevWeekRowAfter?.positionCode === prevWeekRowBefore?.positionCode,
    `${prevWeekRowBefore?.rawPart}/${prevWeekRowBefore?.positionCode} → ${prevWeekRowAfter?.rawPart}/${prevWeekRowAfter?.positionCode}`);
  const curRowAfter = ((await call(S(weekId))).j?.data?.crewRows ?? []).find((r) => r.userId === target.userId);
  ck("저장 주차 [B] 값 반영", curRowAfter?.rawPart === newPart, `${curRowAfter?.rawPart}`);

  // ── 원복 ──
  await call(`/api/admin/team-parts/info/team-detail/week-position?mode=${MODE}`, {
    method: "PATCH",
    body: JSON.stringify({ organization: ORG, weekId, rawTeam: TEAM, changes: [{ userId: target.userId, rawPart: target.rawPart, positionCode: target.positionCode }] }),
  });
  if (!ovrBefore) {
    await sb.from(OVR).delete().eq("user_id", target.userId).eq("week_start_date", WEEK).eq("organization", ORG).eq("raw_team", TEAM);
    const { execFileSync } = await import("node:child_process");
    try {
      execFileSync("npx", ["tsx", "--env-file=.env.local", "scripts/backfill-week-position-override-snapshots.ts", "--apply", `--users=${target.userId}`],
        { cwd: adminRoot, stdio: "ignore", shell: true });
    } catch { console.log("  ⚠ 원복 snapshot 재계산 실패"); }
  }
  const restored = matrixParts((await call(infoUrl)).j?.data);
  const backSame = JSON.stringify([...before[wi].on].sort()) === JSON.stringify([...restored[wi].on].sort());
  ck("원복 — 매트릭스 원값 복귀", backSame, `[${[...restored[wi].on].join(",")}]`);

  console.log(`\n=== RESULT: ${fail === 0 ? "ALL PASS" : fail + " FAIL"} ===`);
  process.exit(fail === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
