/**
 * 공통 resolver SoT 전수 검증 — "현재 주차의 팀/파트/클래스가 바뀌면, 그 값을 보는 모든 화면이
 * 같은 결과를 보여준다" 를 **실제 브라우저가 호출하는 API 응답**으로 확인한다.
 *
 * 종전 propagation 스크립트(6화면)의 확장판. 추가로 검증하는 것:
 *   · 주차 축     : W-1 / W / W+1 — override 는 저장 주차부터 **이후만** 이월되고 과거는 불변.
 *   · 모집단 축   : operating / mode=test / actAsTestUserId / demoUserId 네 경로가 같은 값.
 *   · 화면 축     : 아래 14종(현재 상태 A / 주차 B / 시즌 C).
 *   · snapshot 축 : 생성·조회·lazy recompute 가 같은 DTO 를 만드는지(카드 재조회 일치).
 *
 * ⚠ 관측 유효 조건 — override 클래스/파트가 **현재 멤버십 유도값과 달라야** 한다. 같으면 어느 SoT 를
 *   쓰든 값이 같아 통과가 무의미하다. 아래 chooseTarget 이 이 조건을 스스로 확인하고 아니면 abort 한다.
 * ⚠ cleanup 범위는 "내가 만든 행"으로만 좁힌다(사용자가 저장해 둔 override 를 지우지 않는다).
 *
 * 사전조건: admin dev :3000, front dev :3001.
 * Usage: npm run verify:position-resolver-sot
 *
 * ⚠ **반드시 `--dns-result-order=ipv4first` 로 실행할 것**(npm script 에 포함돼 있다). node 18+ 는
 *   `localhost` 를 ::1 로 먼저 잡는데 Next dev 서버는 IPv4 만 바인딩해서, 그냥 `node` 로 돌리면
 *   front 호출이 UND_ERR_HEADERS_TIMEOUT 으로 죽고 "크루 앱 미기동" 으로 오판된다. 127.0.0.1 로
 *   바꾸는 것은 해법이 아니다 — Host 가 달라져 front 가 308 로 리다이렉트한다.
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
const ADMIN = process.env.ADMIN_BASE ?? "http://localhost:3000";
const FRONT = process.env.FRONT_BASE ?? "http://localhost:3001";
const URL_ = get("NEXT_PUBLIC_SUPABASE_URL");
const ANON = get("NEXT_PUBLIC_SUPABASE_ANON_KEY");
const sb = createClient(URL_, get("SUPABASE_SERVICE_ROLE_KEY"));
const brow = createClient(URL_, ANON);

const OVR = "cluster4_team_week_position_overrides";
// 공통 변환기(lib/adminMembersTypes.resolvePositionLabels)와 같은 매핑. 스크립트가 라벨을 재정의하지
//   않도록 코드→라벨 2종만 여기 둔다(어휘 혼선 재발 방지).
const CLASS_LABEL = {
  regular: "정규",
  advanced_agent: "심화(에이전트)",
  advanced_part_leader: "심화(파트장)",
  operating_team_leader: "운영진(팀장)",
  operating_ambassador: "운영진(앰배서더)",
  operating_club_leader: "운영진(클럽장)",
};
const STATUS_LABEL = {
  regular: "일반",
  advanced_agent: "심화(에이전트)",
  advanced_part_leader: "심화(파트장)",
  operating_team_leader: "팀장",
  operating_ambassador: "앰배서더",
};

let fail = 0;
let skipped = 0;
const ck = (l, ok, d = "") => {
  console.log(`  ${ok ? "✓" : "✗"} ${l}${d ? ` — ${d}` : ""}`);
  if (!ok) fail++;
};
// 조용한 스킵 금지 — 스킵은 개수를 세고 마지막에 반드시 출력한다.
const skip = (l, why) => {
  console.log(`  ~ ${l} — SKIP: ${why}`);
  skipped++;
};
const hr = (t) => console.log(`\n──────── ${t} ────────`);

async function cookieHeader() {
  const { data: admins } = await sb
    .from("admin_users")
    .select("email")
    .eq("is_active", true)
    .not("email", "is", null)
    .limit(1);
  const email = admins?.[0]?.email;
  const { data: link } = await sb.auth.admin.generateLink({ type: "magiclink", email });
  const { data: v } = await brow.auth.verifyOtp({
    email,
    token: link.properties.email_otp,
    type: "magiclink",
  });
  const cap = [];
  const srv = createServerClient(URL_, ANON, {
    cookies: { getAll: () => [], setAll: (i) => cap.push(...i) },
  });
  await srv.auth.setSession({
    access_token: v.session.access_token,
    refresh_token: v.session.refresh_token,
  });
  console.log(`admin session = ${email}`);
  return cap.map((i) => `${i.name}=${i.value}`).join("; ");
}

// 응답 어디에 있든 userId 로 행을 찾는다(화면마다 배열 이름이 다르다).
function findRow(node, userId, depth = 0) {
  if (!node || depth > 8) return null;
  if (Array.isArray(node)) {
    for (const it of node) {
      const hit = findRow(it, userId, depth + 1);
      if (hit) return hit;
    }
    return null;
  }
  if (typeof node !== "object") return null;
  if (node.userId === userId || node.user_id === userId) return node;
  for (const v of Object.values(node)) {
    const hit = findRow(v, userId, depth + 1);
    if (hit) return hit;
  }
  return null;
}

// 행에서 팀/파트/클래스에 해당하는 값을 이름 변형까지 흡수해 뽑는다.
const pick = (row, keys) => {
  for (const k of keys) {
    const v = row?.[k];
    if (typeof v === "string" && v.trim() !== "") return v.trim();
  }
  return null;
};
// weekly-cards 응답은 `data` 가 **카드 배열 자체**다(`data.cards` 아님 — 실측). 두 shape 모두 흡수.
const cardsOf = (j) => {
  const d = j?.data;
  if (Array.isArray(d)) return d;
  if (Array.isArray(d?.cards)) return d.cards;
  if (Array.isArray(j?.cards)) return j.cards;
  return [];
};
const rowTeam = (r) => pick(r, ["teamName", "currentTeamName", "team", "rawTeam", "teamLabel"]);
const rowPart = (r) => pick(r, ["partName", "currentPartName", "part", "rawPart", "partLabel"]);
const rowClass = (r) => pick(r, ["classLabel", "className", "statusLabel", "roleLabel"]);

async function main() {
  const cookie = await cookieHeader();
  // ⚠ 모든 호출에 타임아웃을 건다. 하나가 무한 대기하면 finally(원복)까지 못 가서 **사용자 데이터에
  //   저장된 override 가 검증값인 채로 남는다**(실측: 내부키 라우트에서 행업).
  const TIMEOUT_MS = Number(process.env.VERIFY_TIMEOUT_MS ?? 60000);
  const call = (base, path, init) =>
    fetch(`${base}${path}`, {
      ...init,
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: { cookie, "content-type": "application/json", ...(init?.headers ?? {}) },
    })
      .then(async (r) => ({ status: r.status, j: await r.json().catch(() => null) }))
      .catch((e) => ({ status: 0, j: null, err: String(e) }));

  // ⚠ node fetch 는 localhost 를 ::1 로 먼저 잡는 경우가 있어, dev 서버가 IPv4 만 바인딩하면
  //   HEAD 1회 시도로는 "미기동" 오판이 난다(실측: PowerShell 은 200, node 는 실패). 재시도 +
  //   127.0.0.1 폴백 + GET 까지 시도한 뒤에야 미기동으로 판정한다.
  //   ⚠ 판정에만 127.0.0.1 폴백을 쓰고, **실제 호출은 원래 호스트(localhost)로 한다** — front 는
  //     호스트가 다르면 308 로 리다이렉트해서 API 응답을 못 받는다(실측).
  const frontBase = FRONT;
  const ping = async (base) => {
    for (const method of ["HEAD", "GET"]) {
      try {
        await fetch(base, { method, signal: AbortSignal.timeout(15000) });
        return true;
      } catch {
        /* 다음 방법 시도 */
      }
    }
    return false;
  };
  let frontUp = false;
  for (let i = 0; i < 3 && !frontUp; i++) {
    frontUp =
      (await ping(FRONT)) || (await ping(FRONT.replace("localhost", "127.0.0.1")));
    if (!frontUp) await new Promise((r) => setTimeout(r, 3000));
  }
  ck(`front dev(${frontBase}) 기동`, frontUp, frontUp ? "" : "크루 앱 미기동 — front 경로 검증 불가");
  if (!frontUp) {
    console.log(`\n=== RESULT: ${fail} FAIL ===`);
    process.exit(1);
  }

  // ── 1) 대상 팀/주차 선정 (QA 팀 · 편집 가능 주차) ────────────────────────────
  hr("대상 선정");
  const { data: th } = await sb
    .from("cluster4_team_halves")
    .select("id,team_name,half_key,is_qa_test,organization_slug")
    .eq("organization_slug", "encre")
    .eq("is_active", true)
    .eq("is_qa_test", true)
    .order("display_order")
    .limit(1);
  const team = th?.[0];
  if (!team) {
    console.log("QA 팀 없음 — abort");
    process.exit(1);
  }
  const ORG = "encre";
  const MODE = "test";
  const wsUrl = (weekId) =>
    `/api/admin/team-parts/info/team-detail/week-summary?organization=${ORG}` +
    `&teamHalfId=${team.id}&mode=${MODE}${weekId ? `&weekId=${weekId}` : ""}`;
  const before = (await call(ADMIN, wsUrl())).j?.data;
  if (!before?.week || before.week.reviewCompleted) {
    console.log("편집 가능한 주차 없음 — abort");
    process.exit(1);
  }
  const { weekId, weekStartDate: WEEK } = before.week;
  console.log(`팀=${team.team_name} half=${team.half_key} 기준주차=${before.week.label}(${WEEK})`);
  // 휴식 관리 등 시즌 파라미터가 필요한 화면용 — weeks 행에서 직접 해소.
  const { data: wkRow } = await sb.from("weeks").select("season_key").eq("id", weekId).maybeSingle();
  const SEASON_KEY = wkRow?.season_key ?? "";
  // 경험 계열 라우트는 team_id 를 요구한다(cluster4_teams). team-detail 의 team.teamId 는 null 일 수 있다.
  const { data: teamRow } = await sb
    .from("cluster4_teams")
    .select("id")
    .eq("team_name", team.team_name)
    .eq("organization_slug", ORG)
    .maybeSingle();
  const TEAM_ID = teamRow?.id ?? "";

  // W-1 / W+1 주차 — weeks 테이블에서 실제 인접 주차를 잡는다(달력 갭 방어).
  const { data: weeksAround } = await sb
    .from("weeks")
    .select("id,start_date")
    .order("start_date", { ascending: true });
  const allWeeks = (weeksAround ?? []).map((w) => ({
    id: w.id,
    start: String(w.start_date).slice(0, 10),
  }));
  const idx = allWeeks.findIndex((w) => w.start === WEEK);
  const WPREV = idx > 0 ? allWeeks[idx - 1] : null;
  const WNEXT = idx >= 0 && idx + 1 < allWeeks.length ? allWeeks[idx + 1] : null;
  console.log(`W-1=${WPREV?.start ?? "(없음)"}  W=${WEEK}  W+1=${WNEXT?.start ?? "(없음)"}`);

  // ── 2) 관측 유효한 대상 크루 선정 ───────────────────────────────────────────
  const rowsAll = before.crewRows ?? [];
  const regCount = rowsAll.filter((r) => r.positionCode === "regular").length;
  // 카드/snapshot/4경로 블록까지 한 대상으로 검증하려면 **그 주차 카드를 가진 크루**여야 한다.
  //   카드가 0건인 크루를 고르면 그 블록이 통째로 SKIP 되어 검증이 비어 버린다(실측).
  const hasCardAtWeek = async (uid) => {
    const r = await call(ADMIN, `/api/cluster4/weekly-cards?userId=${uid}`);
    return cardsOf(r.j).some((c) => (c.startDate ?? "").slice(0, 10) === WEEK);
  };
  const carded = [];
  for (const r of rowsAll.slice(0, 12)) if (await hasCardAtWeek(r.userId)) carded.push(r.userId);
  console.log(`  W 카드 보유 크루 ${carded.length}/${Math.min(rowsAll.length, 12)}명`);
  const prefer = (arr) => arr.find((r) => carded.includes(r.userId)) ?? arr[0];
  const advRow = prefer(rowsAll.filter((r) => r.positionCode !== "regular"));
  const target = advRow ?? prefer(rowsAll);
  if (!target) {
    console.log("대상 크루 없음 — abort");
    process.exit(1);
  }
  // 클래스가 **반드시 바뀌는** 방향(심화→정규는 인원 제약 없음).
  const newCode = advRow
    ? "regular"
    : rowsAll.length - regCount + 1 <= regCount - 1
      ? "advanced_agent"
      : null;
  // 파트도 **다른 파트**로 옮겨야 파트 변화가 관측된다.
  const parts = [...new Set(rowsAll.map((r) => r.rawPart).filter(Boolean))];
  const newPart = parts.find((p) => p !== target.rawPart) ?? null;
  ck(
    "클래스가 실제로 바뀌는 대상 확보",
    newCode != null && newCode !== target.positionCode,
    `${target.name ?? target.userId}: ${target.positionCode} → ${newCode}`,
  );
  ck(
    "파트가 실제로 바뀌는 대상 확보",
    newPart != null && newPart !== target.rawPart,
    `${target.rawPart ?? "-"} → ${newPart ?? "-"}`,
  );
  if (newCode == null || newPart == null) {
    console.log("\n관측 유효 조건 불충족 — abort(무의미한 통과 방지)");
    process.exit(1);
  }
  const UID = target.userId;
  const expClass = CLASS_LABEL[newCode];
  const expStatus = STATUS_LABEL[newCode];

  // ── 2-b) PATCH 전 baseline 확보 ────────────────────────────────────────────
  //   과거 주차 불변 판정은 "저장값과 다른가" 가 아니라 "**PATCH 전과 같은가**" 로 해야 한다.
  //   대상 크루가 W-1 에 이미 저장값과 같은 클래스일 수 있어, 전자는 거짓 실패를 낸다.
  const baselineAt = async (wk) => {
    if (!wk) return null;
    const r = await call(ADMIN, wsUrl(wk.id));
    const row = findRow(r.j?.data ?? r.j, UID);
    return row ? { code: row.positionCode ?? null, part: row.rawPart ?? null } : null;
  };
  const basePrev = await baselineAt(WPREV);
  console.log(`  baseline W-1 = ${JSON.stringify(basePrev)}`);
  // 카드(주차 DTO) baseline — W-1/W/W+1 3주차. 이월/불변 판정을 **카드에서도** 한다.
  //   ([B] 표만 보면 관리자 화면만 검증한 것이고, 고객이 보는 카드는 미검증으로 남는다.)
  const cardSigAt = (cards, ws) => {
    const c = cards.find((x) => (x.startDate ?? "").slice(0, 10) === ws);
    return c
      ? { team: c.teamName ?? null, part: c.partName ?? null, code: c.crewClassPositionCode ?? null }
      : null;
  };
  const baseCards = cardsOf((await call(ADMIN, `/api/cluster4/weekly-cards?userId=${UID}`)).j);
  const baseCardPrev = WPREV ? cardSigAt(baseCards, WPREV.start) : null;
  const baseCardNext = WNEXT ? cardSigAt(baseCards, WNEXT.start) : null;
  console.log(
    `  baseline 카드 W-1=${JSON.stringify(baseCardPrev)} W+1=${JSON.stringify(baseCardNext)}`,
  );
  // 시즌 클래스 baseline. 시즌 결과는 **그 시즌 주차들의 effective 이력**으로 만들어지므로
  //   현재 시즌(맨 위 행)은 override 로 바뀌는 것이 정상이다. 검증 대상은 **과거 시즌 불변**.
  const seasonSig = async () => {
    const r = await call(ADMIN, `/api/admin/members/${UID}`);
    const s = r.j?.data?.seasonResults ?? r.j?.data?.detail?.seasonResults ?? null;
    return Array.isArray(s)
      ? s.map((x) => (x.memberships ?? []).map((m) => m.classLabel).join("/"))
      : null;
  };
  const baseSeason = await seasonSig();
  console.log(`  baseline 시즌 클래스 = ${JSON.stringify(baseSeason) ?? "(없음)"}`);

  // ── 집계 화면 3종의 (총원, 정규, 심화) 를 한 번에 읽는다 ────────────────────
  //   필드 경로는 화면마다 다르다(실측): [A]=data.currentCrew.*, 라인관리=teams[].headcount.*,
  //   팀내역요약=rows[clubId].*  — 최상위에서 찾으면 전부 null 이라 조용한 SKIP 이 된다.
  const readAggregates = async () => {
    const [a, lm, sm] = await Promise.all([
      call(ADMIN, `/api/admin/team-parts/info/team-detail?organization=${ORG}&teamHalfId=${team.id}&mode=${MODE}`),
      call(ADMIN, `/api/admin/cluster4/experience/line-manage?organization=${ORG}&mode=${MODE}`),
      call(ADMIN, `/api/admin/team-parts/info/summary?organization=${ORG}&mode=${MODE}`),
    ]);
    const cc = a.j?.data?.currentCrew ?? null;
    const teamDetail = cc
      ? { total: cc.clubbingCount ?? null, regular: cc.regularCrewCount ?? null, advanced: cc.advancedCrewCount ?? null }
      : null;
    const t = (lm.j?.data?.teams ?? []).find((x) => x.teamName === team.team_name);
    const hc = t?.headcount ?? null;
    // 라인 관리 headcount 는 normal/partLeader/agent 로 쪼개져 있다 — 심화 = partLeader + agent.
    const lineManage = hc
      ? { total: hc.total ?? null, regular: hc.normal ?? null, advanced: (hc.partLeader ?? 0) + (hc.agent ?? 0) }
      : null;
    const row = (sm.j?.data?.rows ?? []).find((x) => x.clubId === ORG || x.clubSlug === ORG);
    const summary = row
      ? { total: row.clubbingCount ?? null, regular: row.regularCrewCount ?? null, advanced: row.advancedCrewCount ?? null }
      : null;
    return { teamDetail, lineManage, summary };
  };
  const aggBase = await readAggregates();
  console.log(`  baseline 집계 = ${JSON.stringify(aggBase)}`);

  // 기존 override 행 백업(정확히 이 (user,org,week,team) 1건만) — 원복 대상.
  const { data: preExisting } = await sb
    .from(OVR)
    .select("*")
    .eq("user_id", UID)
    .eq("organization", ORG)
    .eq("week_start_date", WEEK);
  const hadRow = (preExisting ?? [])[0] ?? null;

  // ── 카드 3주차 구간 검증 ────────────────────────────────────────────────────
  //   조건: 편집 가능(reviewCompleted=false) + 대상 행 존재 + W-1·W·W+1 **모두 카드 보유**.
  //   원복: 그 주차에 원래 행이 있었으면 값 복원, 없었으면 그 1건만 삭제. 다른 주차/사람 불변.
  async function verifyCardWindow() {
    hr("카드 3주차 구간 — W-1 기존값 · W 변경값 · W+1 carry-forward");
    const cards0 = cardsOf((await call(ADMIN, `/api/cluster4/weekly-cards?userId=${UID}`)).j);
    const cardWeeks = new Set(cards0.map((c) => (c.startDate ?? "").slice(0, 10)));
    let picked = null;
    for (let i = 1; i < allWeeks.length - 1; i++) {
      const [p, c, n] = [allWeeks[i - 1], allWeeks[i], allWeeks[i + 1]];
      if (!cardWeeks.has(p.start) || !cardWeeks.has(c.start) || !cardWeeks.has(n.start)) continue;
      const s = await call(ADMIN, wsUrl(c.id));
      const wk = s.j?.data?.week;
      // ⚠ week-summary 는 weekId 가 이 org·모집단의 선택 가능 목록에 없으면 **조용히 현재 주차를
      //   돌려준다**. weekId 를 대조하지 않으면 "과거 주차를 잡았다"고 착각한 채 현재 주차를 편집하게
      //   된다(실사고: 사용자가 저장해 둔 현재 주차 행을 덮었다).
      if (!wk || wk.weekId !== c.id) continue;
      if (wk.reviewCompleted) continue;
      const rows = s.j?.data?.crewRows ?? [];
      const me = rows.find((r) => r.userId === UID);
      if (!me) continue;
      picked = { prev: p, cur: c, next: n, rows, me };
      break;
    }
    if (!picked) {
      skip("카드 3주차 구간", "앞뒤로 카드가 있는 편집 가능 주차를 찾지 못함");
      return;
    }
    const { prev, cur, next, rows } = picked;
    // 대상 크루 선정 — **강등(심화→정규)은 인원 규칙 제약이 없어 항상 관측 가능**하다.
    //   승격은 심화≤정규 규칙에 막히는 경우가 많아(실측) 강등 가능한 크루를 우선 고른다.
    //   그 크루가 W-1·W·W+1 3주차 카드를 모두 가져야 카드 레벨 이월을 볼 수 있다.
    const parts2All = [...new Set(rows.map((r) => r.rawPart).filter(Boolean))];
    let CUID = null, code2 = null, part2 = null, cards0b = null;
    for (const r of rows.filter((x) => x.positionCode !== "regular").slice(0, 6)) {
      const p2c = parts2All.find((p) => p !== r.rawPart) ?? null;
      if (!p2c) continue;
      const cs = cardsOf((await call(ADMIN, `/api/cluster4/weekly-cards?userId=${r.userId}`)).j);
      const has = (ws) => cs.some((c) => (c.startDate ?? "").slice(0, 10) === ws);
      if (!has(prev.start) || !has(cur.start) || !has(next.start)) continue;
      CUID = r.userId; code2 = "regular"; part2 = p2c; cards0b = cs;
      break;
    }
    if (!CUID) {
      skip("카드 3주차 구간", "그 주차에 (강등 가능 + 3주차 카드 보유) 크루가 없음");
      return;
    }
    const meRow = rows.find((r) => r.userId === CUID);
    console.log(
      `  구간 W-1=${prev.start} W=${cur.start} W+1=${next.start} · 대상=${meRow?.name ?? CUID.slice(0,8)} ${meRow?.positionCode}/${meRow?.rawPart} → ${code2}/${part2}`,
    );

    const sigAt = (cards, ws) => {
      const c = cards.find((x) => (x.startDate ?? "").slice(0, 10) === ws);
      return c
        ? { team: c.teamName ?? null, part: c.partName ?? null, code: c.crewClassPositionCode ?? null }
        : null;
    };
    const basePrevSig = sigAt(cards0b, prev.start);

    const { data: had } = await sb
      .from(OVR)
      .select("*")
      .eq("user_id", CUID)
      .eq("organization", ORG)
      .eq("week_start_date", cur.start);
    const hadRow2 = (had ?? [])[0] ?? null;

    // ⚠ mode 는 **쿼리스트링**에서 읽힌다(body 에 넣으면 operating 으로 떨어져 다른 주차에 저장된다).
    const p2 = await call(ADMIN, `/api/admin/team-parts/info/team-detail/week-position?mode=${MODE}`, {
      method: "PATCH",
      body: JSON.stringify({
        organization: ORG,
        weekId: cur.id,
        rawTeam: team.team_name,
        changes: [{ userId: CUID, rawPart: part2, positionCode: code2 }],
      }),
    });
    ck("구간 PATCH 200", p2.status === 200, `status=${p2.status} ${JSON.stringify(p2.j?.error ?? "")}`);
    if (p2.status !== 200) return;
    // 저장이 **그 주차**에 떨어졌는지 확인. 아니면 아무 것도 단언하지 않고 즉시 원복한다.
    const { data: landed2 } = await sb
      .from(OVR).select("week_start_date,raw_part,position_code")
      .eq("user_id", CUID).eq("organization", ORG).eq("week_start_date", cur.start);
    if (!(landed2 ?? []).length) {
      ck("구간 저장이 의도한 주차에 기록됨", false, `week=${cur.start} 에 행 없음 — 다른 주차 저장 의심`);
      return;
    }
    ck("구간 저장이 의도한 주차에 기록됨", true, `week=${cur.start}`);

    try {
      for (const [label, base, path] of [
        ["operating", ADMIN, `/api/cluster4/weekly-cards?userId=${CUID}`],
        ["mode=test", ADMIN, `/api/cluster4/weekly-cards?userId=${CUID}&mode=test`],
        ["임퍼소네이션", ADMIN, `/api/cluster4/weekly-cards?userId=${CUID}&actAsTestUserId=${CUID}`],
        ["demoUserId(front)", frontBase, `/api/cluster4/weekly-cards?demoUserId=${CUID}`],
      ]) {
        const res = await call(base, path);
        if (res.status !== 200) {
          ck(`구간 ${label} 200`, false, `status=${res.status}`);
          continue;
        }
        const cs = cardsOf(res.j);
        const gPrev = sigAt(cs, prev.start);
        const gCur = sigAt(cs, cur.start);
        const gNext = sigAt(cs, next.start);
        ck(
          `구간 ${label} W-1 기존값 불변`,
          JSON.stringify(gPrev) === JSON.stringify(basePrevSig),
          `got=${JSON.stringify(gPrev)} base=${JSON.stringify(basePrevSig)}`,
        );
        ck(`구간 ${label} W 변경값(클래스)`, gCur?.code === code2, `got=${gCur?.code} exp=${code2}`);
        ck(`구간 ${label} W 변경값(파트)`, gCur?.part === part2, `got=${gCur?.part} exp=${part2}`);
        ck(`구간 ${label} W+1 carry-forward(클래스)`, gNext?.code === code2, `got=${gNext?.code} exp=${code2}`);
        ck(`구간 ${label} W+1 carry-forward(파트)`, gNext?.part === part2, `got=${gNext?.part} exp=${part2}`);
      }
    } finally {
      // 원복 — **대상 1명의 그 주차 행 1건만**.
      if (hadRow2) {
        const { error } = await sb
          .from(OVR)
          .update({
            raw_part: hadRow2.raw_part,
            position_code: hadRow2.position_code,
            raw_team: hadRow2.raw_team,
          })
          .eq("user_id", CUID)
          .eq("organization", ORG)
          .eq("week_start_date", cur.start);
        ck("구간 원복(기존 행 값 복원)", !error, error?.message ?? "");
      } else {
        const { error } = await sb
          .from(OVR)
          .delete()
          .eq("user_id", CUID)
          .eq("organization", ORG)
          .eq("week_start_date", cur.start);
        ck("구간 원복(생성 행 삭제)", !error, error?.message ?? "");
      }
      await sb.from("cluster4_weekly_card_snapshots").update({ is_stale: true }).eq("user_id", CUID);
    }
  }

  // ── 전체 override 테이블 지문 — 검증 종료 시 **한 행도 달라지면 안 된다** ──────
  //   대상 선정이 실행마다 달라질 수 있어(카드 보유·클래스 조건) 개별 원복만으로는
  //   "다른 사람 행을 건드렸다"를 못 잡는다. 실제로 한 번 밟았다(2026-07-22: 대상이 바뀌면서
  //   앞선 실행이 남긴 값이 다음 실행의 baseline 이 돼 원본이 유실). 시작·종료 지문을 비교한다.
  const fingerprint = async () => {
    const { data } = await sb
      .from(OVR)
      .select("user_id,organization,week_start_date,raw_team,raw_part,position_code")
      .order("week_start_date", { ascending: true });
    return (data ?? [])
      .map((r) => `${r.week_start_date}|${r.organization}|${r.raw_team}|${r.raw_part}|${r.position_code}|${r.user_id}`)
      .sort()
      .join("\n");
  };
  const fpBefore = await fingerprint();
  console.log(`  override 지문(시작) = ${fpBefore.split("\n").length}행`);

  // ── 원복 — **대상 1명의 그 주차 행 1건만** 정확히 되돌린다 ────────────────────
  //   기존 행이 있었으면 그 값으로 복원, 없었으면 내가 만든 1건만 삭제.
  //   다른 사용자/다른 주차/다른 조직 행은 절대 건드리지 않는다(과거 실사고: 정리 단계가
  //   (org, week, team) 전체를 지워 사용자가 저장해 둔 행까지 날렸다).
  //   ⚠ 성공 경로뿐 아니라 **PATCH 실패/타임아웃 경로에서도** 반드시 호출한다.
  let restored = false;
  async function restoreTarget() {
    if (restored) return;
    restored = true;
    hr("원복");
    if (hadRow) {
      const { error } = await sb
        .from(OVR)
        .update({
          raw_part: hadRow.raw_part,
          position_code: hadRow.position_code,
          raw_team: hadRow.raw_team,
        })
        .eq("user_id", UID)
        .eq("organization", ORG)
        .eq("week_start_date", WEEK);
      ck("기존 override 값 복원", !error, error?.message ?? "");
    } else {
      const { error } = await sb
        .from(OVR)
        .delete()
        .eq("user_id", UID)
        .eq("organization", ORG)
        .eq("week_start_date", WEEK);
      ck("생성한 override 행 삭제", !error, error?.message ?? "");
    }
    // 복원 결과를 DB 로 재확인한다(원복이 조용히 실패하면 검증값이 남는다).
    const { data: after } = await sb
      .from(OVR)
      .select("raw_part,position_code")
      .eq("user_id", UID)
      .eq("organization", ORG)
      .eq("week_start_date", WEEK);
    const row = (after ?? [])[0] ?? null;
    const ok = hadRow
      ? row?.raw_part === hadRow.raw_part && row?.position_code === hadRow.position_code
      : row == null;
    ck(
      "원복 검증(DB 재확인)",
      ok,
      `now=${JSON.stringify(row)} expected=${hadRow ? JSON.stringify({ raw_part: hadRow.raw_part, position_code: hadRow.position_code }) : "행 없음"}`,
    );
    await sb.from("cluster4_weekly_card_snapshots").update({ is_stale: true }).eq("user_id", UID);
    console.log("  · 대상 유저 snapshot stale 표시(다음 조회 시 원복값으로 재계산)");

    // 전체 테이블 지문 대조 — 한 행이라도 다르면 **실패**로 보고하고 차이를 그대로 출력한다.
    const fpAfter = await fingerprint();
    if (fpAfter === fpBefore) {
      ck("override 테이블 무변경(전체 지문 일치)", true, `${fpAfter.split("\n").length}행`);
    } else {
      const b = new Set(fpBefore.split("\n"));
      const a = new Set(fpAfter.split("\n"));
      const lost = [...b].filter((x) => !a.has(x));
      const added = [...a].filter((x) => !b.has(x));
      ck("override 테이블 무변경(전체 지문 일치)", false, "아래 차이 확인 — 수동 복원 필요");
      for (const l of lost) console.log(`      - 유실: ${l}`);
      for (const x of added) console.log(`      + 잔존: ${x}`);
    }
  }

  // ── 3) 저장(실제 관리자 PATCH 경로) ────────────────────────────────────────
  hr("PATCH — 관리자 팀 상세 주차 편집");
  const patch = await call(ADMIN, `/api/admin/team-parts/info/team-detail/week-position?mode=${MODE}`, {
    method: "PATCH",
    body: JSON.stringify({
      organization: ORG,
      weekId,
      rawTeam: team.team_name,
      changes: [{ userId: UID, rawPart: newPart, positionCode: newCode }],
    }),
  });
  ck("PATCH 200", patch.status === 200, `status=${patch.status} ${JSON.stringify(patch.j?.error ?? "")}`);
  if (patch.status !== 200) {
    // ⚠ 클라이언트 타임아웃(status=0)이어도 **서버에는 반영됐을 수 있다**. 그냥 종료하면 검증값이
    //   그대로 남는다. 원복 경로를 반드시 태운 뒤 종료한다.
    await restoreTarget();
    console.log(`\n=== RESULT: ${fail} FAIL ===`);
    process.exit(1);
  }
  // ⚠ **저장이 의도한 주차에 떨어졌는지 DB 로 확인**한다. 라우트가 다른 주차로 폴백하면 원복 대상이
  //   어긋나 사용자가 저장해 둔 행이 검증값인 채로 남는다(실사고).
  {
    const { data: landed } = await sb
      .from(OVR)
      .select("week_start_date,raw_part,position_code")
      .eq("user_id", UID)
      .eq("organization", ORG)
      .eq("week_start_date", WEEK);
    const row = (landed ?? [])[0] ?? null;
    ck(
      "저장이 의도한 주차에 기록됨",
      row?.position_code === newCode && row?.raw_part === newPart,
      `week=${WEEK} row=${JSON.stringify(row)}`,
    );
    if (!row) {
      console.log("\n⚠ 다른 주차에 저장됐을 수 있다 — 원복 범위가 어긋나므로 즉시 중단한다.");
      console.log(`=== RESULT: ${fail} FAIL ===`);
      process.exit(1);
    }
  }
  console.log(`  invalidated=${JSON.stringify(patch.j?.data?.invalidated ?? null)}`);

  try {
    // ── 4) 현재 상태 화면(A) 전수 — 모두 같은 값이어야 한다 ────────────────────
    hr("A. 현재 상태 화면 — 공통 resolver 동일 결과");
    const TEAM_Q = encodeURIComponent(team.team_name);
    const aScreens = [
      ["회원 목록", `/api/admin/members?organization=${ORG}&mode=${MODE}&limit=200`],
      ["회원 명부(roster)", `/api/admin/members/roster?organization=${ORG}&mode=${MODE}`],
      ["회원 상세", `/api/admin/members/${UID}`],
      ["라인 개설 대상자(크루)", `/api/admin/cluster4/crews?organization=${ORG}&mode=${MODE}`],
      ["휴식 관리 목록", `/api/admin/rest-management/list?organization=${ORG}&season_key=${SEASON_KEY}`],
      ["프로세스 체크", `/api/admin/processes/check?org=${ORG}&mode=${MODE}&hub=info`],
      ["액트 체크 관리", `/api/admin/team-parts/info/weeks/${weekId}/act-check-management?club=${ORG}&mode=${MODE}`],
      ["경험 팀 총괄", `/api/admin/cluster4/experience/team-overall?organization=${ORG}&week_id=${weekId}&team_id=${team.id}&team_name=${TEAM_Q}&mode=${MODE}`],
      // ⚠ 경험 계열 라우트의 파라미터는 **snake_case**(team_name/team_id/week_id)다. camelCase 로
      //   보내면 200 이지만 빈 목록이 와서 "대상 행 없음" SKIP 으로 위장된다(실측).
      [
        "경험 파트 입력",
        `/api/admin/cluster4/experience/part-input?organization=${ORG}&team_name=${TEAM_Q}` +
          `&team_id=${TEAM_ID}&week_id=${weekId}&part=${encodeURIComponent(newPart)}&mode=${MODE}`,
      ],
    ];
    for (const [label, path] of aScreens) {
      const res = await call(ADMIN, path);
      if (res.status === 404) {
        skip(label, `라우트 없음(${path})`);
        continue;
      }
      if (res.status !== 200) {
        ck(label, false, `status=${res.status}`);
        continue;
      }
      const row = findRow(res.j?.data ?? res.j, UID);
      if (!row) {
        skip(label, "응답에 대상 크루 행 없음(스코프/페이지네이션)");
        continue;
      }
      const cls = rowClass(row);
      const part = rowPart(row);
      // 클래스/파트 필드를 애초에 안 내려주는 화면(등급 raw 만 쓰는 목록 등)은 단언 대상이 아니다.
      //   "필드 없음" 을 실패로 세면 노이즈가 되고, 조용히 통과시키면 미검증이 숨는다 → SKIP 으로 센다.
      if (cls == null) skip(`${label} 클래스`, "응답에 클래스 필드 없음");
      else ck(`${label} 클래스`, cls === expClass || cls === expStatus, `got=${cls} exp=${expClass}|${expStatus}`);
      if (part == null) skip(`${label} 파트`, "응답에 파트 필드 없음");
      else ck(`${label} 파트`, part === newPart, `got=${part} exp=${newPart}`);
    }

    // ── 집계 화면 — 사람 행이 없으므로 **버킷 카운트 이동**으로 검증한다 ──────────
    //   심화(파트장) → 정규 로 바꿨으면 그 팀/클럽의 심화 −1, 정규 +1 이어야 한다.
    //   라벨 어휘 2종이 섞이면 어느 버킷에도 안 걸려 **총원이 줄어든다**(실측 [A] 정규6→4).
    //   총원(clubbing/total)이 baseline 과 같은지까지 봐야 그 함정을 잡는다.
    hr("집계 화면 — 버킷 이동 · 총원 보존");
    const aggAfter = await readAggregates();
    for (const [label, base, after] of [
      ["팀 상세 [A] 현재 크루", aggBase.teamDetail, aggAfter.teamDetail],
      ["경험 라인 관리 headcount", aggBase.lineManage, aggAfter.lineManage],
      ["팀 내역 요약(클럽)", aggBase.summary, aggAfter.summary],
    ]) {
      if (!base || !after) {
        skip(label, "집계 필드를 찾지 못함");
        continue;
      }
      ck(
        `${label} 총원 보존`,
        base.total === after.total,
        `base=${base.total} after=${after.total} (줄었다면 어휘 불일치로 버킷에서 탈락)`,
      );
      ck(
        `${label} 심화 −1`,
        after.advanced === base.advanced - 1,
        `base=${base.advanced} after=${after.advanced}`,
      );
      ck(
        `${label} 정규 +1`,
        after.regular === base.regular + 1,
        `base=${base.regular} after=${after.regular}`,
      );
    }

    // [A] 집계가 [B] 표를 같은 어휘로 센 값과 일치하는지(두 화면 정합).
    {
      const b = await call(ADMIN, wsUrl(weekId));
      const bRows = b.j?.data?.crewRows ?? [];
      const bReg = bRows.filter((r) => r.positionCode === "regular").length;
      const bAdv = bRows.filter(
        (r) => r.positionCode === "advanced_agent" || r.positionCode === "advanced_part_leader",
      ).length;
      if (!aggAfter.teamDetail) skip("팀 상세 [A] == [B] 집계", "[A] 집계 없음");
      else {
        ck("팀 상세 [A] 정규 수 == [B] 정규 수", aggAfter.teamDetail.regular === bReg, `A=${aggAfter.teamDetail.regular} B=${bReg}`);
        ck("팀 상세 [A] 심화 수 == [B] 심화 수", aggAfter.teamDetail.advanced === bAdv, `A=${aggAfter.teamDetail.advanced} B=${bAdv}`);
      }
    }

    // ── 5) 주차 화면(B) — W-1 불변 / W·W+1 이월 ────────────────────────────────
    hr("B. 주차 화면 — 과거 불변 · 저장 주차부터 이월");
    const weekChecks = [
      ["W-1(과거·불변)", WPREV, false],
      ["W(저장 주차)", { id: weekId, start: WEEK }, true],
      ["W+1(이월)", WNEXT, true],
    ];
    for (const [label, wk, shouldApply] of weekChecks) {
      if (!wk) {
        skip(`팀 상세 [B] ${label}`, "인접 주차 없음");
        continue;
      }
      const res = await call(ADMIN, wsUrl(wk.id));
      if (res.status !== 200) {
        ck(`팀 상세 [B] ${label}`, false, `status=${res.status}`);
        continue;
      }
      const row = findRow(res.j?.data ?? res.j, UID);
      if (!row) {
        skip(`팀 상세 [B] ${label}`, "그 주차 행 없음");
        continue;
      }
      if (shouldApply) {
        ck(`팀 상세 [B] ${label} 클래스`, row.positionCode === newCode, `got=${row.positionCode} exp=${newCode}`);
        ck(`팀 상세 [B] ${label} 파트`, (row.rawPart ?? null) === newPart, `got=${row.rawPart} exp=${newPart}`);
      } else if (!basePrev) {
        skip(`팀 상세 [B] ${label} 과거 불변`, "baseline 미확보");
      } else {
        // ⚠ "저장값과 다른가" 가 아니라 "**PATCH 전과 같은가**". 대상이 원래부터 저장값과
        //   같은 클래스일 수 있어, 전자로 판정하면 거짓 실패가 난다.
        ck(
          `팀 상세 [B] ${label} 과거 불변`,
          (row.positionCode ?? null) === basePrev.code && (row.rawPart ?? null) === basePrev.part,
          `got=${row.positionCode}/${row.rawPart} baseline=${basePrev.code}/${basePrev.part}`,
        );
      }
    }

    // 주차 상세 / 주차별 결과 — 그 주차 effective 를 보여야 한다(현재 role 우선 금지).
    for (const [label, path] of [
      ["회원 상세(주차별 결과·시즌 결과 포함)", `/api/admin/members/${UID}`],
      ["주차 상세", `/api/admin/members/${UID}/weeks/${weekId}`],
    ]) {
      const res = await call(ADMIN, path);
      if (res.status === 404) {
        skip(label, "라우트 없음");
        continue;
      }
      if (res.status !== 200) {
        ck(label, false, `status=${res.status}`);
        continue;
      }
      const txt = JSON.stringify(res.j);
      ck(`${label} 응답 수신`, txt.length > 0, `bytes=${txt.length}`);
      // 그 주차 카드에 저장 클래스가 반영됐는지(라벨 문자열 포함 여부로 관측).
      ck(`${label} 저장 주차 클래스 반영`, txt.includes(expClass), `exp="${expClass}" 포함`);
    }

    // ── 6) 시즌 화면(C) — 3주룰이라 1주 override 로는 대표가 안 바뀌는 것이 정상 ──
    hr("C. 시즌 화면 — effective 이력 기반(3주룰)");
    {
      // 시즌별 결과 = 회원 상세 DTO 안(seasonResults). 시즌 대표는 3주룰이라 1주 override 로는
      //   바뀌지 않는 것이 **정상** — 여기서는 "응답이 서고 과거 시즌이 오염되지 않는다"를 본다.
      const afterSeason = await seasonSig();
      if (baseSeason == null || afterSeason == null) skip("시즌별 결과", "seasonResults 없음");
      else {
        // [0] = 현재 시즌(최신). 현재 시즌은 그 주차 effective 를 반영해 바뀌는 것이 **정상**.
        ck(
          "현재 시즌 — 주차 effective 반영",
          afterSeason[0] !== baseSeason[0] || baseSeason[0] === expClass,
          `after=${afterSeason[0]} base=${baseSeason[0]}`,
        );
        // 과거 시즌은 override 가 소급되면 안 된다 — 이게 진짜 회귀 지점.
        const pastSame = JSON.stringify(afterSeason.slice(1)) === JSON.stringify(baseSeason.slice(1));
        ck(
          "과거 시즌 — override 소급 없음",
          pastSame,
          `after=${JSON.stringify(afterSeason.slice(1))} base=${JSON.stringify(baseSeason.slice(1))}`,
        );
      }

      // 이력서는 internal key 인증(고객앱 graft 경로). 키가 없으면 조용히 넘기지 않고 SKIP 로 센다.
      const IKEY = get("INTERNAL_API_KEY");
      if (!IKEY) skip("이력서(시즌 직책)", "INTERNAL_API_KEY 미설정");
      else {
        const r = await fetch(`${ADMIN}/api/cluster1/resume?userId=${UID}`, {
          headers: { "x-internal-api-key": IKEY },
          signal: AbortSignal.timeout(TIMEOUT_MS),
        })
          .then(async (x) => ({ status: x.status, j: await x.json().catch(() => null) }))
          .catch((e) => ({ status: 0, j: null, err: String(e) }));
        ck("이력서(시즌 직책) 200", r.status === 200, `status=${r.status}`);
      }
    }

    // ── 7) 모집단 4경로 — 같은 카드 DTO ────────────────────────────────────────
    hr("모집단 4경로 — 동일 resolver · 동일 DTO");
    // 카드 대상 선정 — override 대상 크루가 카드를 못 가진 환경이 있다(실측: override 주차에
    //   uws/UPH 0건 → 전 유저 카드 0건). 그럴 때 조용히 넘기지 않고, **카드를 가진 유저**로
    //   경로 파리티(4경로가 같은 DTO builder 를 쓰는가)만이라도 반드시 검증한다.
    let CARD_UID = null;
    let CARD_WEEK = WEEK;
    const probe = await call(ADMIN, `/api/cluster4/weekly-cards?userId=${UID}`);
    const probeCards = cardsOf(probe.j);
    if (probeCards.some((c) => (c.startDate ?? "").slice(0, 10) === WEEK)) {
      CARD_UID = UID;
    } else {
      // uws 가 있는 최신 주차 → 그 주차 유저 중 하나. (uws 키는 week_id 가 아니라 week_start_date)
      const { data: uwsRow, error: uwsErr } = await sb
        .from("user_week_statuses")
        .select("user_id,week_start_date,status")
        .not("week_start_date", "is", null)
        .order("week_start_date", { ascending: false })
        .limit(1);
      if (uwsErr) console.log(`  ⓘ uws 조회 실패: ${uwsErr.message}`);
      const cand = (uwsRow ?? [])[0];
      if (cand) {
        CARD_UID = cand.user_id;
        CARD_WEEK = String(cand.week_start_date).slice(0, 10);
      }
      console.log(
        `  ⓘ override 대상(${UID.slice(0, 8)})은 W 카드 0건 — 경로 파리티는 대체 대상(${
          CARD_UID?.slice(0, 8) ?? "없음"
        } @${CARD_WEEK})으로 검증. **override×카드 조합은 이 DB 에서 관측 불가**.`,
      );
    }

    if (!CARD_UID) {
      skip("4경로 카드 DTO 동일", "카드 보유 유저를 찾지 못함(uws 0건)");
      skip("stale 후 재계산 동일", "카드 보유 유저 없음");
    } else {
      // ⚠ /api/cluster4/weekly-cards 는 **actAsTestUserId 를 파라미터로 받지 않는다**(실측: 넘기면
      //   무시되고 관리자 본인 카드가 돌아와 전 필드 null 로 보인다). 임퍼소네이션 대상 지정은
      //   userId 로 하고, actAsTestUserId 를 실제로 해석하는 라우트는 weekly-line-enhancement 다.
      const cardPaths = [
        ["operating(admin)", ADMIN, `/api/cluster4/weekly-cards?userId=${CARD_UID}`],
        ["mode=test(admin)", ADMIN, `/api/cluster4/weekly-cards?userId=${CARD_UID}&mode=test`],
        ["임퍼소네이션(userId)", ADMIN, `/api/cluster4/weekly-cards?userId=${CARD_UID}&actAsTestUserId=${CARD_UID}`],
        ["demoUserId(front)", frontBase, `/api/cluster4/weekly-cards?demoUserId=${CARD_UID}`],
      ];
      const cardSigs = [];
      for (const [label, base, path] of cardPaths) {
        const res = await call(base, path);
        if (res.status !== 200) {
          ck(`${label} 카드 200`, false, `status=${res.status}`);
          continue;
        }
        const cards = cardsOf(res.j);
        const card = cards.find((c) => (c.startDate ?? "").slice(0, 10) === CARD_WEEK) ?? null;
        if (!card) {
          const have = cards.map((c) => (c.startDate ?? "?").slice(0, 10)).slice(-6).join(",");
          skip(`${label} 카드`, `${CARD_WEEK} 카드 없음 (보유 주차 최근: ${have || "0건"})`);
          continue;
        }
        cardSigs.push([
          label,
          JSON.stringify({
            team: card.teamName ?? null,
            part: card.partName ?? null,
            code: card.crewClassPositionCode ?? null,
            role: card.roleLabel ?? null,
          }),
        ]);
        // override 대상 본인일 때만 저장값 단언(대체 대상은 파리티만 본다).
        if (CARD_UID === UID) {
          ck(`${label} W 클래스`, card.crewClassPositionCode === newCode, `got=${card.crewClassPositionCode} exp=${newCode}`);
          ck(`${label} W 파트`, (card.partName ?? null) === newPart, `got=${card.partName} exp=${newPart}`);
          // ── W-1 기존값 불변 / W+1 carry-forward — **카드에서** 확인 ──────────
          if (!WPREV || !baseCardPrev) skip(`${label} W-1 불변`, "W-1 카드 baseline 없음");
          else {
            const got = cardSigAt(cards, WPREV.start);
            ck(
              `${label} W-1 기존값 불변`,
              JSON.stringify(got) === JSON.stringify(baseCardPrev),
              `got=${JSON.stringify(got)} base=${JSON.stringify(baseCardPrev)}`,
            );
          }
          if (!WNEXT) skip(`${label} W+1 이월`, "W+1 주차 없음");
          else {
            const got = cardSigAt(cards, WNEXT.start);
            // W 는 현재 주차라 W+1 은 **미래**다. 카드는 지나간 주차에만 생성되므로 어떤 유저에게도
            //   W+1 카드가 없다(전 크루 확인). 카드 레벨 W+1 이월은 그 주차가 실제로 도래해야 관측된다.
            //   그 주차의 이월 판정 자체는 [B] 표(같은 resolver 출력)에서 검증돼 있다.
            if (!got)
              skip(
                `${label} W+1 이월(카드)`,
                `W+1(${WNEXT.start})=미래 주차 → 전 크루 카드 미생성. [B] 표에서 이월 검증됨`,
              );
            else {
              ck(`${label} W+1 carry-forward 클래스`, got.code === newCode, `got=${got.code} exp=${newCode}`);
              ck(`${label} W+1 carry-forward 파트`, got.part === newPart, `got=${got.part} exp=${newPart}`);
            }
          }
        }
      }
      if (cardSigs.length >= 2) {
        const allSame = cardSigs.every(([, s]) => s === cardSigs[0][1]);
        ck("4경로 카드 DTO 동일", allSame, allSame ? `${cardSigs.length}경로` : cardSigs.map(([l, s]) => `${l}=${s}`).join(" | "));
      } else {
        skip("4경로 카드 DTO 동일", `비교 가능한 경로 ${cardSigs.length}개`);
      }

      // actAsTestUserId 를 실제로 해석하는 라우트. 인증은 **x-internal-api-key 전용**
      //   (관리자 세션 미사용 — 고객앱 서버 proxy 만 호출). 쿠키로 부르면 401 이 정상이다.
      {
        const IKEY2 = get("INTERNAL_API_KEY");
        if (!IKEY2) skip("actAsTestUserId 라우트", "INTERNAL_API_KEY 미설정");
        else {
          const r = await fetch(
            `${ADMIN}/api/cluster4/weekly-line-enhancement?userId=${CARD_UID}&weekId=${weekId}&actAsTestUserId=${CARD_UID}`,
            { headers: { "x-internal-api-key": IKEY2 }, signal: AbortSignal.timeout(TIMEOUT_MS) },
          )
            .then((x) => ({ status: x.status }))
            .catch((e) => ({ status: 0, err: String(e) }));
          ck("actAsTestUserId 라우트 200", r.status === 200, `status=${r.status} ${r.err ?? ""}`);
        }
      }

      // ── 7-b) **카드 3주차 구간** — W-1 기존값 / W 변경값 / W+1 carry-forward ──
      //   현재 주차는 미래라 W+1 카드가 없다. 카드까지 3주차를 다 보려면 **앞뒤로 카드가 있는
      //   편집 가능 주차**를 따로 골라야 한다(실측: 2026-02-23 4주차가 그런 주차).
      //   이 블록은 자체 PATCH + 자체 원복을 갖는다(대상 1명의 그 주차 행만 건드린다).
      await verifyCardWindow();

      // ── 8) snapshot 생성 == stale 후 재계산(lazy recompute 경로) ──────────────
      hr("snapshot — 생성 · 조회 · 재계산 동일");
      const sig = (r) => {
        const c = cardsOf(r.j).find((x) => (x.startDate ?? "").slice(0, 10) === CARD_WEEK);
        return c ? JSON.stringify({ t: c.teamName, p: c.partName, k: c.crewClassPositionCode }) : null;
      };
      const first = await call(ADMIN, `/api/cluster4/weekly-cards?userId=${CARD_UID}`);
      await sb.from("cluster4_weekly_card_snapshots").update({ is_stale: true }).eq("user_id", CARD_UID);
      const second = await call(ADMIN, `/api/cluster4/weekly-cards?userId=${CARD_UID}`);
      const s1 = sig(first);
      const s2 = sig(second);
      if (s1 == null || s2 == null) skip("stale 후 재계산 동일", `${CARD_WEEK} 카드 없음`);
      else ck("stale 후 재계산 동일", s1 === s2, `${s1} vs ${s2}`);
    }
  } finally {
    await restoreTarget();
  }

  console.log(`\n=== RESULT: ${fail} FAIL / ${skipped} SKIP ===`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
