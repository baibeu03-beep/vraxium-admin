/**
 * 검증 — 주차별 파트/클래스 override 저장([B]) + [A]/effective 정합.
 *   저장 라운드트립 · [A]==[B] · UPH 원본 불변 · override row만 생성 · 서버 검증(422) · op==test.
 *   ⚠ override 를 생성한다 → 종료 시 supabase 로 정리. 사전조건: dev :3000.
 *   Usage: node scripts/verify-team-week-position-save.mjs
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
const BASE = "http://localhost:3000";
const URL_ = get("NEXT_PUBLIC_SUPABASE_URL");
const ANON = get("NEXT_PUBLIC_SUPABASE_ANON_KEY");
const SERVICE = get("SUPABASE_SERVICE_ROLE_KEY");
const sb = createClient(URL_, SERVICE);
const brow = createClient(URL_, ANON);

let fail = 0;
const ck = (l, ok, d = "") => { console.log(`  ${ok ? "✓" : "✗"} ${l}${d ? ` — ${d}` : ""}`); if (!ok) fail++; };
const ORG = "encre";

async function cookieHeader() {
  const { data: admins } = await sb.from("admin_users").select("email").eq("is_active", true).not("email", "is", null).limit(1);
  const email = admins?.[0]?.email;
  const { data: link } = await sb.auth.admin.generateLink({ type: "magiclink", email });
  const { data: v } = await brow.auth.verifyOtp({ email, token: link.properties.email_otp, type: "magiclink" });
  const cap = [];
  const srv = createServerClient(URL_, ANON, { cookies: { getAll: () => [], setAll: (i) => cap.push(...i) } });
  await srv.auth.setSession({ access_token: v.session.access_token, refresh_token: v.session.refresh_token });
  console.log(`admin: ${email}`);
  return cap.map((i) => `${i.name}=${i.value}`).join("; ");
}

async function main() {
  const cookie = await cookieHeader();
  const api = (path, opts = {}) =>
    fetch(`${BASE}${path}`, { ...opts, headers: { cookie, "content-type": "application/json", ...(opts.headers || {}) } }).then((r) => r.json().then((j) => ({ status: r.status, j })));

  // 팀 선택 — encre 현재 반기 활성 QA 테스트 팀 1개.
  const { data: th } = await sb.from("cluster4_team_halves").select("id,team_name,half_key,is_qa_test,is_active,organization_slug")
    .eq("organization_slug", ORG).eq("is_active", true).eq("is_qa_test", true).order("display_order").limit(1);
  const team = th?.[0];
  if (!team) { console.log("팀 없음 — abort"); process.exit(1); }
  const teamHalfId = team.id, teamName = team.team_name;
  console.log(`팀: ${teamName} (${teamHalfId})`);

  const S = (weekId) => `/api/admin/team-parts/info/team-detail/week-summary?organization=${ORG}&teamHalfId=${teamHalfId}${weekId ? `&mode=test&weekId=${weekId}` : "&mode=test"}`;
  const before = (await api(S())).j.data;
  const weekId = before.week.weekId, weekStart = before.week.weekStartDate;
  console.log(`주차: ${before.week.label} (${weekStart}) reviewCompleted=${before.week.reviewCompleted}`);

  // [A]==[B] 정합(초기).
  const rows = before.crewRows;
  ck("[A].전체 == [B] 행수", before.crew.total === rows.length, `${before.crew.total} vs ${rows.length}`);
  ck("[A].정규 == regular 행수", before.crew.regular === rows.filter((r) => r.positionCode === "regular").length);
  ck("[A].심화 == advanced_* 행수", before.crew.advanced === rows.filter((r) => r.positionCode.startsWith("advanced")).length);
  const partCountFromRows = new Set(rows.filter((r) => (r.rawPart ?? "").trim()).map((r) => r.rawPart)).size;
  ck("[A].운용 파트 == crewRows distinct part", before.operatedParts.length === partCountFromRows, `${before.operatedParts.length} vs ${partCountFromRows}`);

  if (before.week.reviewCompleted) { console.log("검수 완료 주차 — 저장 스킵(잠금)"); }

  // 저장 대상 — 파트를 다른 파트로 이동(가능하면). 없으면 클래스만.
  //   ⚠ '심화(파트장)'을 대상으로 고르면, 이동할 파트에 이미 파트장이 있을 때 규칙상 422 로 막힌다
  //     (파트장 ≤1/파트 — 정상 동작). 픽스처는 규칙에 걸리지 않는 크루를 고른다.
  const target = rows.find((r) => r.positionCode !== "advanced_part_leader") ?? rows[0];
  const otherPart = rows.map((r) => r.rawPart).find((p) => p && p !== target.rawPart) ?? "일반";
  const newPart = otherPart !== target.rawPart ? otherPart : target.rawPart;
  const origUphPart = await sb.from("user_position_histories").select("raw_part").eq("user_id", target.userId).eq("week_start_date", weekStart).limit(1).then((r) => r.data?.[0]?.raw_part ?? null);
  // 대상에게 **이미 있던** override(관리자가 브라우저로 저장해 둔 값)를 기록해 두었다가 정리 단계에서
  //   되돌린다. 없던 경우에만 행을 삭제한다 — 검증이 남의 데이터를 지우지 않게 하는 안전장치.
  const preExisting = await sb.from("cluster4_team_week_position_overrides")
    .select("raw_part,position_code,week_id,created_by,updated_by")
    .eq("user_id", target.userId).eq("week_start_date", weekStart).eq("organization", ORG).eq("raw_team", teamName)
    .maybeSingle().then((r) => r.data ?? null);
  if (preExisting) console.log(`  · 대상에 기존 override 존재(${preExisting.raw_part}/${preExisting.position_code}) — 종료 시 복원`);

  // ── 저장(PATCH) ──
  const patch = await api(`/api/admin/team-parts/info/team-detail/week-position?mode=test`, {
    method: "PATCH",
    body: JSON.stringify({ organization: ORG, weekId, rawTeam: teamName, changes: [{ userId: target.userId, rawPart: newPart, positionCode: target.positionCode }] }),
  });
  ck("저장 PATCH 200", patch.status === 200, JSON.stringify(patch.j).slice(0, 80));

  // 재조회 — 반영 확인.
  const after = (await api(S(weekId))).j.data;
  const afterRow = after.crewRows.find((r) => r.userId === target.userId);
  ck("저장 후 crew 파트 반영(effective)", afterRow?.rawPart === newPart, `${target.rawPart} → ${afterRow?.rawPart}`);
  ck("저장 후 [A].전체 불변", after.crew.total === before.crew.total, `${before.crew.total} → ${after.crew.total}`);
  // operatedParts: newPart 운용 유지, 이전 파트는 크루수 -1(0이면 목록에서 빠짐).
  ck("저장 후 newPart 운용", after.operatedParts.some((p) => p.partName === newPart));

  // UPH 원본 불변.
  const uphPartNow = await sb.from("user_position_histories").select("raw_part").eq("user_id", target.userId).eq("week_start_date", weekStart).limit(1).then((r) => r.data?.[0]?.raw_part ?? null);
  ck("UPH 원본 raw_part 불변", uphPartNow === origUphPart, `UPH=${uphPartNow} (orig=${origUphPart})`);
  // override row 생성 확인.
  const { data: ovr } = await sb.from("cluster4_team_week_position_overrides").select("user_id,raw_part,position_code").eq("user_id", target.userId).eq("week_start_date", weekStart).eq("organization", ORG).eq("raw_team", teamName);
  ck("override row 생성됨", (ovr?.length ?? 0) === 1 && ovr[0].raw_part === newPart, JSON.stringify(ovr));

  // ── 서버 검증(422) — 같은 파트 2명 파트장. newPart 에 2명 이상 있으면 시도. ──
  const inNewPart = after.crewRows.filter((r) => r.rawPart === newPart).slice(0, 2);
  if (inNewPart.length >= 2) {
    const bad = await api(`/api/admin/team-parts/info/team-detail/week-position?mode=test`, {
      method: "PATCH",
      body: JSON.stringify({ organization: ORG, weekId, rawTeam: teamName, changes: inNewPart.map((r) => ({ userId: r.userId, rawPart: newPart, positionCode: "advanced_part_leader" })) }),
    });
    ck("파트장 2명 → 422 차단", bad.status === 422, `status=${bad.status} ${JSON.stringify(bad.j).slice(0, 60)}`);
  } else { console.log("  · 파트장 중복 테스트 스킵(newPart 크루<2)"); }
  // 잘못된 positionCode → 400.
  const bad2 = await api(`/api/admin/team-parts/info/team-detail/week-position?mode=test`, {
    method: "PATCH", body: JSON.stringify({ organization: ORG, weekId, rawTeam: teamName, changes: [{ userId: target.userId, rawPart: newPart, positionCode: "operating_team_leader" }] }),
  });
  ck("비허용 positionCode → 400", bad2.status === 400);

  // op==test DTO 키 동일.
  const opKeys = Object.keys((await api(`/api/admin/team-parts/info/team-detail/week-summary?organization=${ORG}&teamHalfId=${teamHalfId}`)).j.data ?? {}).sort();
  const tsKeys = Object.keys((await api(S())).j.data ?? {}).sort();
  ck("op/test DTO 키 동일", JSON.stringify(opKeys) === JSON.stringify(tsKeys), `op=${opKeys.length} test=${tsKeys.length}`);

  // 정리 — 테스트 override 삭제. ⚠ override 는 이제 공통 SoT(카드 snapshot 소비)라, 직접 삭제하면
  //   그 유저 snapshot 이 삭제 전 effective 값으로 굳는다. 삭제 대상 유저를 먼저 모아 두고,
  //   삭제 후 명시 재계산해 base(UPH/멤버십) 값으로 되돌린다.
  //   ⚠⚠ 삭제 범위는 **이 스크립트가 건드린 user_id 로 한정**한다. 종전에는 (org, week, team) 전체를
  //     지워서, 관리자가 브라우저로 저장해 둔 다른 크루의 override 까지 날렸다(2026-07-22 실제 사고:
  //     사용자 테스트 4행 소실 → 수동 복원). 이 스크립트는 target 1명만 저장하므로 그 1명만 지운다.
  const clearedIds = [target.userId];
  let delErr = null;
  if (preExisting) {
    // 원래 있던 값으로 복원(삭제 금지).
    const { error } = await sb.from("cluster4_team_week_position_overrides")
      .update({ raw_part: preExisting.raw_part, position_code: preExisting.position_code })
      .eq("user_id", target.userId).eq("week_start_date", weekStart).eq("organization", ORG).eq("raw_team", teamName);
    delErr = error ?? null;
    console.log(delErr ? `[정리] 복원 실패: ${delErr.message}` : `[정리] 기존 override 복원 완료(${preExisting.raw_part}/${preExisting.position_code})`);
  } else {
    const { error } = await sb.from("cluster4_team_week_position_overrides").delete()
      .eq("week_start_date", weekStart).eq("organization", ORG).eq("raw_team", teamName).eq("user_id", target.userId);
    delErr = error ?? null;
    console.log(delErr ? `[정리] 삭제 실패: ${delErr.message}` : `[정리] 검증용 override 삭제 완료`);
  }
  if (!delErr && clearedIds.length > 0) {
    const { execFileSync } = await import("node:child_process");
    try {
      execFileSync("npx", ["tsx", "--env-file=.env.local", "scripts/backfill-week-position-override-snapshots.ts", "--apply", `--users=${clearedIds.join(",")}`], { cwd: adminRoot, stdio: "ignore", shell: true });
      console.log(`[정리] snapshot 재계산 완료(${clearedIds.length}명)`);
    } catch {
      console.log(`[정리] ⚠ snapshot 재계산 실패 — 수동 실행: npx tsx --env-file=.env.local scripts/backfill-week-position-override-snapshots.ts --apply --users=${clearedIds.join(",")}`);
    }
  }

  console.log(`\n=== RESULT: ${fail === 0 ? "ALL PASS" : fail + " FAIL"} ===`);
  process.exit(fail === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
