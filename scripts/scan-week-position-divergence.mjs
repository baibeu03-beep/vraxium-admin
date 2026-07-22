/**
 * 발산 스캔 — 같은 (유저, 주차)에 대해 **각 화면의 실제 HTTP 응답**이 보여주는 소속/클래스를
 * 한 줄씩 나열해, 어느 화면이 override 를 반영하고 어느 화면이 안 하는지 눈으로 확정한다.
 *
 * 판별 기준(중요): override 로 저장한 클래스가 현재 멤버십에서 유도되는 클래스와 **다른** 유저만
 * 의미 있는 관측이 된다(같으면 어느 SoT 를 쓰든 값이 같아 구분 불가).
 *
 *   Usage: node scripts/scan-week-position-divergence.mjs
 *   읽기 전용 — 아무것도 쓰지 않는다.
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
const FRONT = "http://localhost:3001";
const URL_ = get("NEXT_PUBLIC_SUPABASE_URL");
const ANON = get("NEXT_PUBLIC_SUPABASE_ANON_KEY");
const sb = createClient(URL_, get("SUPABASE_SERVICE_ROLE_KEY"));
let fail = 0;
const brow = createClient(URL_, ANON);

async function cookieHeader() {
  const { data: admins } = await sb.from("admin_users").select("email").eq("is_active", true).not("email", "is", null).limit(1);
  const email = admins?.[0]?.email;
  const { data: link } = await sb.auth.admin.generateLink({ type: "magiclink", email });
  const { data: v } = await brow.auth.verifyOtp({ email, token: link.properties.email_otp, type: "magiclink" });
  const cap = [];
  const srv = createServerClient(URL_, ANON, { cookies: { getAll: () => [], setAll: (i) => cap.push(...i) } });
  await srv.auth.setSession({ access_token: v.session.access_token, refresh_token: v.session.refresh_token });
  return cap.map((i) => `${i.name}=${i.value}`).join("; ");
}

const CODE_LABEL = {
  regular: "정규", advanced_agent: "심화(에이전트)", advanced_part_leader: "심화(파트장)",
  operating_team_leader: "운영진(팀장)", operating_ambassador: "운영진(앰배서더)", operating_club_leader: "운영진(클럽장)",
};

async function main() {
  const cookie = await cookieHeader();
  const call = (base, path) =>
    fetch(`${base}${path}`, { headers: { cookie, "content-type": "application/json" } })
      .then(async (r) => ({ status: r.status, j: await r.json().catch(() => null) }))
      .catch((e) => ({ status: 0, j: null, err: String(e) }));

  // 최신 override = 관측 기준
  const { data: ovr } = await sb.from("cluster4_team_week_position_overrides")
    .select("user_id,organization,week_start_date,raw_team,raw_part,position_code,updated_at")
    .order("updated_at", { ascending: false }).limit(4);
  if (!ovr?.length) { console.log("override 없음 — abort"); process.exit(1); }
  const newest = ovr[0].updated_at;
  const batch = ovr.filter((r) => r.updated_at === newest);
  const ORG = batch[0].organization, TEAM = batch[0].raw_team, WEEK = String(batch[0].week_start_date).slice(0, 10);
  console.log(`기준 override 배치: ${ORG} / ${TEAM} / ${WEEK} / @${newest} / ${batch.length}명\n`);

  const { data: thAll } = await sb.from("cluster4_team_halves")
    .select("id,half_key,is_qa_test").eq("organization_slug", ORG).eq("team_name", TEAM).eq("is_active", true);
  const { data: wkRow } = await sb.from("weeks").select("id").eq("start_date", WEEK).maybeSingle();
  const MODE = thAll?.[0]?.is_qa_test ? "test" : "operating";
  let half = null;
  for (const c of thAll ?? []) {
    const r = await call(ADMIN, `/api/admin/team-parts/info?organization=${ORG}&half=${c.half_key}&mode=${MODE}`);
    if ((r.j?.data?.weekColumns ?? []).some((x) => x.weekStartDate === WEEK)) { half = c; break; }
  }
  console.log(`teamHalfId=${half?.id} half=${half?.half_key} mode=${MODE} weekId=${wkRow?.id}\n`);

  for (const o of batch) {
    const { data: p } = await sb.from("user_profiles").select("display_name,role").eq("user_id", o.user_id).maybeSingle();
    const { data: m } = await sb.from("user_memberships").select("membership_level,part_name").eq("user_id", o.user_id).eq("is_current", true).maybeSingle();
    const expect = o.position_code;
    console.log(`══════ ${p?.display_name} (${o.user_id.slice(0, 8)})`);
    console.log(`  override(저장값)            : part=${o.raw_part} class=${expect} (${CODE_LABEL[expect]})`);
    console.log(`  현재 멤버십(비교용)         : part=${m?.part_name} level=${m?.membership_level} role=${p?.role}`);
    const discriminating = !((p?.role === "part_leader" && expect === "advanced_part_leader") || (p?.role === "crew" && m?.membership_level === "일반" && expect === "regular"));
    console.log(`  → 멤버십 유도값과 다른가?   : ${discriminating ? "YES (관측 유효)" : "NO (구분 불가)"}`);

    const rows = [];
    const expectLabel = CODE_LABEL[expect];
    const expectPart = o.raw_part;
    // ① 팀 상세 [B]
    const a = await call(ADMIN, `/api/admin/team-parts/info/team-detail/week-summary?organization=${ORG}&teamHalfId=${half?.id}&mode=${MODE}&weekId=${wkRow?.id}`);
    const r1 = (a.j?.data?.crewRows ?? []).find((r) => r.userId === o.user_id);
    rows.push(["팀 상세 [B] week-summary", `${r1?.rawPart}/${r1?.positionCode}`,
      r1?.positionCode === expect && r1?.rawPart === expectPart]);
    // ①b 팀 상세 [A] 현재 시점 크루 strip — [B] 집계와 일치해야 한다(같은 팀·같은 시점).
    const td = await call(ADMIN, `/api/admin/team-parts/info/team-detail?organization=${ORG}&teamHalfId=${half?.id}&mode=${MODE}`);
    const cc = td.j?.data?.currentTeam?.currentCrew ?? td.j?.data?.team?.currentCrew ?? null;
    const bRows = a.j?.data?.crewRows ?? [];
    const bReg = bRows.filter((r) => r.positionCode === "regular").length;
    const bAdv = bRows.filter((r) => String(r.positionCode).startsWith("advanced")).length;
    rows.push(["팀 상세 [A] 현재크루 == [B] 집계",
      cc ? `[A]정규${cc.regularCrewCount}/심화${cc.advancedCrewCount} vs [B]정규${bReg}/심화${bAdv}` : "(미노출)",
      cc ? cc.regularCrewCount === bReg && cc.advancedCrewCount === bAdv : null]);
    // ② 회원 목록 — statusLabel(클래스)·currentPartName(소속)
    const ml = await call(ADMIN, `/api/admin/members?organization=${ORG}&mode=${MODE}&limit=200`);
    const mrow = (ml.j?.data?.rows ?? ml.j?.data?.members ?? ml.j?.data ?? []).find?.((r) => r.userId === o.user_id);
    // 화면의 "클래스" 컬럼이 렌더하는 값 = m.classLabel(서버 계산). statusLabel 은 상태 칩 어휘라
    //   "정규" 대신 "일반" 을 쓴다 — 어휘가 다르므로 각각 자기 어휘로 검증한다.
    rows.push(["회원 목록 /api/admin/members",
      mrow ? `${mrow.currentPartName}/클래스=${mrow.classLabel}/상태칩=${mrow.statusLabel}` : "(행 없음)",
      mrow ? mrow.classLabel === expectLabel && mrow.currentPartName === expectPart : false]);
    // ③ 크루 카드 서빙(admin) — front 가 proxy 하는 라우트
    const wc = await call(ADMIN, `/api/cluster4/weekly-cards?userId=${o.user_id}`);
    const card = (wc.j?.data ?? []).find((c) => String(c.startDate ?? "").slice(0, 10) === WEEK);
    rows.push(["크루카드(admin serving)", `${card?.partName}/${card?.crewClassPositionCode} label=${card?.roleLabel}`,
      card?.crewClassPositionCode === expect && card?.partName === expectPart]);
    // ④ 크루 페이지(front :3001 proxy) — 사용자가 실제로 보는 그 앱
    const fc = await call(FRONT, `/api/cluster4/weekly-cards?demoUserId=${o.user_id}`);
    const fcard = (fc.j?.data ?? []).find((c) => String(c.startDate ?? "").slice(0, 10) === WEEK);
    rows.push([`크루페이지(front :3001) [${fc.status}]`,
      fcard ? `${fcard.partName}/${fcard.crewClassPositionCode} label=${fcard.roleLabel}` : `(카드없음)`,
      fcard ? fcard.crewClassPositionCode === expect && fcard.partName === expectPart : false]);

    for (const [name, val, ok] of rows) {
      const mark = ok === null ? "·" : ok ? "✓" : "✗";
      if (ok === false) fail++;
      console.log(`     ${mark} ${name.padEnd(32)} ${val}`);
    }
    console.log("");
  }
  console.log(`=== RESULT: ${fail === 0 ? "ALL PASS" : fail + " FAIL"} ===`);
  process.exit(fail === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
