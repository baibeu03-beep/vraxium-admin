// 벤치(HTTP): /admin/line-opening/* 3허브의 [라인 개설]·[개설 취소] 실제 응답시간.
//
//   사전조건: admin dev 서버 :3000 (LINE_OPEN_TRACE=1 로 띄우면 서버 콘솔에 구간 트레이스도 남는다)
//   실행:     node scripts/bench-line-open-cancel-http.mjs
//   옵션(env):
//     BASE=http://localhost:3000   대상 서버
//     ROUNDS=3                     각 조합 반복 횟수(cold/warm 분리 — 1회차=cold)
//     ONLY=info|experience|competency  특정 허브만
//     LABEL=before|after           결과 파일 접미사
//
// 측정 대상(허브별 개설↔취소 왕복):
//   info       POST/DELETE /api/admin/cluster4/info-lines
//   experience POST        /api/admin/cluster4/experience/team-overall  {action:open|cancel}
//   competency POST        /api/admin/cluster4/competency/opening       {action:open|cancel}
//
// 사이클: 개설 → 중복 개설(멱등/409 확인) → 취소 → 재개설 → 취소  (끝나면 원상복구)
//
// ⚠ **무개설 조합만** 대상으로 한다(2026-07-28 확정). 이미 개설된 라인/팀/신청은 절대 건드리지
//   않는다 — 기존 개설분을 취소했다가 다시 열면 라인 id·원장이 새로 생겨 "원복"이 되지 않는다.
//   따라서 픽스처는 다음만 고른다:
//     info       : (org, week, activity_type) 에 활성 라인이 **없는** 조합
//     experience : team_overall.status === 'reviewed' (opened 는 제외)
//     competency : 그 주차에 resolution='opened' 신청이 **0건**인 조합
//   사이클이 취소로 끝나므로 순증 상태 변화는 0이다(잔여물 = append-only 개설 로그 + 멱등 snapshot 재계산).
import { createRequire } from "node:module";
import { readFileSync, writeFileSync, appendFileSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const adminRoot = resolve(__dirname, "..");
const rq = createRequire(resolve(adminRoot, "package.json"));
const { createClient } = rq("@supabase/supabase-js");
const { createServerClient } = rq("@supabase/ssr");

const env = readFileSync(resolve(adminRoot, ".env.local"), "utf8");
const getEnv = (k) => env.match(new RegExp(`^${k}=(.+)$`, "m"))?.[1]?.trim();
const BASE = process.env.BASE || "http://localhost:3000";
const ROUNDS = Number(process.env.ROUNDS || 3);
const ONLY = process.env.ONLY || null;
const LABEL = process.env.LABEL || "run";
// 측정 모드(기본 둘 다). 전후 비교는 같은 모드 하나로 고정해야 의미가 있다.
const MODES = (process.env.MODES || "operating,test").split(",").map((s) => s.trim()).filter(Boolean);
// 사이클 사이 대기(ms). 개설/취소는 응답 후 백그라운드 snapshot 재계산을 남기므로, 그 부하가
//   다음 측정에 섞이지 않도록 비운다. 전후 비교 시 같은 값으로 맞출 것.
const COOLDOWN_MS = Number(process.env.COOLDOWN_MS || 0);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const SUPA_URL = getEnv("NEXT_PUBLIC_SUPABASE_URL");
const ANON = getEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY");
const SERVICE = getEnv("SUPABASE_SERVICE_ROLE_KEY");
const EMAIL = process.env.ADMIN_EMAIL || "vanuatu.golden@gmail.com";

const OUTDIR = resolve(adminRoot, "scripts/_bench");
mkdirSync(OUTDIR, { recursive: true });
const OUT = resolve(OUTDIR, `line-open-cancel-${LABEL}.txt`);
const JSONOUT = resolve(OUTDIR, `line-open-cancel-${LABEL}.json`);
writeFileSync(OUT, `line open/cancel bench [${LABEL}] ${new Date().toISOString()} BASE=${BASE}\n\n`);
const log = (m) => {
  appendFileSync(OUT, m + "\n");
  process.stdout.write(m + "\n");
};

const sb = createClient(SUPA_URL, SERVICE);
const brow = createClient(SUPA_URL, ANON);

async function loginCookies() {
  const { data: link } = await sb.auth.admin.generateLink({ type: "magiclink", email: EMAIL });
  const { data: v } = await brow.auth.verifyOtp({
    email: EMAIL,
    token: link.properties.email_otp,
    type: "magiclink",
  });
  const cap = [];
  const srv = createServerClient(SUPA_URL, ANON, {
    cookies: { getAll: () => [], setAll: (i) => cap.push(...i) },
  });
  await srv.auth.setSession({
    access_token: v.session.access_token,
    refresh_token: v.session.refresh_token,
  });
  return cap.map((i) => `${i.name}=${i.value}`).join("; ");
}

let COOKIE = "";
const calls = [];

async function http(method, path, body, tag) {
  const t0 = performance.now();
  const res = await fetch(BASE + path, {
    method,
    headers: {
      cookie: COOKIE,
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  const ms = performance.now() - t0;
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {}
  const rec = { tag, method, path: path.split("?")[0], status: res.status, ms, ok: json?.success === true };
  calls.push(rec);
  return { ...rec, json, text };
}

// ── 픽스처 탐색 ─────────────────────────────────────────────────────────
async function findFixtures() {
  const out = { info: [], experience: [], competency: [] };

  // 개설 가능 주차 + org 오픈 설정 = 서버 게이트와 같은 소스(cluster4_week_opening_configs).
  const { data: cfgs } = await sb
    .from("cluster4_week_opening_configs")
    .select("week_id,organization_slug,open_confirmed,config")
    .eq("open_confirmed", true);

  const { data: weeks } = await sb.from("weeks").select("id,iso_year,iso_week,start_date");
  const weekById = new Map((weeks ?? []).map((w) => [w.id, w]));

  for (const c of cfgs ?? []) {
    const cfg = c.config ?? {};
    const wk = weekById.get(c.week_id);
    if (!wk) continue;

    const infoCfg = cfg.practicalInfo ?? {};
    for (const [actId, on] of Object.entries(infoCfg)) {
      if (on === true) {
        out.info.push({ org: c.organization_slug, weekId: c.week_id, activityTypeId: actId, week: `${wk.iso_year}W${wk.iso_week}` });
      }
    }
    if (cfg.practicalCompetency?.checked === true) {
      out.competency.push({ org: c.organization_slug, weekId: c.week_id, week: `${wk.iso_year}W${wk.iso_week}` });
    }
    const expCfg = cfg.practicalExperience ?? {};
    for (const [teamId, slots] of Object.entries(expCfg)) {
      if (slots && typeof slots === "object" && Object.values(slots).some((v) => v === true)) {
        out.experience.push({ org: c.organization_slug, weekId: c.week_id, teamId, week: `${wk.iso_year}W${wk.iso_week}` });
      }
    }
  }

  // experience 는 team_overall 헤더가 reviewed/opened 인 것만 개설 가능(검수 선행 필수).
  const { data: overalls } = await sb
    .from("cluster4_experience_team_overall")
    .select("organization_slug,week_id,team_id,status");
  const overallKey = new Map(
    (overalls ?? []).map((o) => [`${o.organization_slug}|${o.week_id}|${o.team_id}`, o.status]),
  );
  // ⚠ reviewed 만 — opened 팀은 기존 개설분이라 건드리지 않는다(원복 불가).
  out.experience = out.experience
    .map((f) => ({ ...f, status: overallKey.get(`${f.org}|${f.weekId}|${f.teamId}`) ?? null }))
    .filter((f) => f.status === "reviewed");

  // 팀명(team-overall API 필수 파라미터).
  const teamIds = [...new Set(out.experience.map((f) => f.teamId))];
  if (teamIds.length > 0) {
    const { data: teams } = await sb.from("teams").select("id,name").in("id", teamIds);
    const nameById = new Map((teams ?? []).map((t) => [t.id, t.name]));
    out.experience = out.experience.map((f) => ({ ...f, teamName: nameById.get(f.teamId) ?? null }));
    out.experience = out.experience.filter((f) => f.teamName);
  }

  // competency: 승인 신청이 있고 **아직 개설(opened)된 신청이 0건**인 주차만(원복 가능 조합).
  const { data: apps } = await sb
    .from("cluster4_competency_applications")
    .select("organization_slug,week_id,resolution,approval_checked");
  const appStat = new Map();
  for (const a of apps ?? []) {
    const k = `${a.organization_slug}|${a.week_id}`;
    const e = appStat.get(k) ?? { approved: 0, opened: 0 };
    if (a.approval_checked) e.approved++;
    if (a.resolution === "opened") e.opened++;
    appStat.set(k, e);
  }
  out.competency = out.competency
    .map((f) => ({ ...f, ...(appStat.get(`${f.org}|${f.weekId}`) ?? { approved: 0, opened: 0 }) }))
    .filter((f) => f.opened === 0 && f.approved > 0)
    .sort((a, b) => b.approved - a.approved);

  // info: (org, week, activity_type) 에 활성 라인이 이미 있는 조합은 제외(원복 가능 조합만).
  const { data: activeLines } = await sb
    .from("cluster4_lines")
    .select("id,activity_type_id,line_code,week_id")
    .eq("part_type", "info")
    .eq("is_active", true);
  const { data: tgtRows } = await sb
    .from("cluster4_line_targets")
    .select("line_id,week_id");
  const weeksOfLine = new Map();
  for (const t of tgtRows ?? []) {
    if (!t.line_id) continue;
    const s = weeksOfLine.get(t.line_id) ?? new Set();
    s.add(t.week_id);
    weeksOfLine.set(t.line_id, s);
  }
  const occupied = new Set();
  for (const l of activeLines ?? []) {
    const wks = new Set(weeksOfLine.get(l.id) ?? []);
    if (l.week_id) wks.add(l.week_id);
    for (const w of wks) occupied.add(`${l.activity_type_id}|${w}`);
  }
  out.info = out.info.filter((f) => !occupied.has(`${f.activityTypeId}|${f.weekId}`));

  return out;
}

// ── 허브별 사이클 ───────────────────────────────────────────────────────

// 개설 대상 크루 후보 — 그 org 의 실제 크루(개설 폼이 넘기는 target_user_ids 와 동일 성격).
//   ⚠ QA 기간(QA_HIDE_REAL_USERS=true)에는 서버 resolveUserScope 가 mode 와 무관하게 test 모집단으로
//     고정되므로, 어드민 화면의 크루 선택창과 동일하게 여기서도 테스트 유저만 고른다(picker == write target).
//     QA 종료 후에는 operating 이 실사용자를 고르도록 QA_SCOPE=0 으로 실행한다.
const QA_SCOPE = process.env.QA_SCOPE !== "0";
async function infoTargets(org, mode, limit) {
  const { data: markers } = await sb.from("test_user_markers").select("user_id");
  const testIds = new Set((markers ?? []).map((m) => m.user_id));
  const { data: profs } = await sb
    .from("user_profiles")
    .select("user_id")
    .eq("organization_slug", org);
  const all = (profs ?? []).map((p) => p.user_id);
  const useTest = QA_SCOPE || mode === "test";
  const scoped = useTest ? all.filter((u) => testIds.has(u)) : all.filter((u) => !testIds.has(u));
  return scoped.slice(0, limit);
}

async function cycleInfo(fx, mode, round) {
  const qs = `organization=${fx.org}${mode === "test" ? "&mode=test" : ""}`;
  const delPath = `/api/admin/cluster4/info-lines?week_id=${fx.weekId}&activity_type_id=${fx.activityTypeId}&${qs}`;
  // 사전 정리 없음 — 무개설 조합만 대상이므로 기존 개설분을 지우지 않는다.
  const targets = await infoTargets(fx.org, mode, Number(process.env.TARGETS || 12));
  const openBody = {
    activity_type_id: fx.activityTypeId,
    main_title: `[bench] ${LABEL} r${round}`,
    output_links: [{ url: "https://example.com/bench", label: "bench" }],
    output_images: [],
    target_user_ids: targets,
    week_id: fx.weekId,
    submission_opens_at: new Date().toISOString(),
    submission_closes_at: new Date(Date.now() + 7 * 864e5).toISOString(),
  };
  const openPath = `/api/admin/cluster4/info-lines?${qs}`;

  const o1 = await http("POST", openPath, openBody, "info:open");
  const dup = await http("POST", openPath, openBody, "info:open-dup");
  const c1 = await http("DELETE", delPath, null, "info:cancel");
  const o2 = await http("POST", openPath, openBody, "info:reopen");
  const c2 = await http("DELETE", delPath, null, "info:cancel2");
  return { targets: targets.length, o1, dup, c1, o2, c2 };
}

async function cycleExperience(fx, mode, round) {
  const base = {
    organization: fx.org,
    week_id: fx.weekId,
    team_id: fx.teamId,
    team_name: fx.teamName,
    ...(mode === "test" ? { mode: "test" } : {}),
  };
  const path = "/api/admin/cluster4/experience/team-overall";
  // 보드 조회 → open payload(leaderCells/outputs/lineSelections)를 화면과 동일하게 복원.
  const boardQs = new URLSearchParams({
    organization: fx.org,
    week_id: fx.weekId,
    team_id: fx.teamId,
    team_name: fx.teamName,
    ...(mode === "test" ? { mode: "test" } : {}),
  });
  const board = await http("GET", `${path}?${boardQs}`, null, "experience:board");
  const b = board.json?.data;
  if (!b) return { skipped: "board load failed", board };

  const leaderCells = [];
  const lineSelections = [];
  for (const part of b.parts ?? []) {
    for (const crew of part.crews ?? []) {
      for (const cat of ["management", "extension"]) {
        const cell = crew.cells?.[cat];
        if (!cell) continue;
        leaderCells.push({
          crewUserId: crew.userId,
          category: cat,
          checked: !!cell.checked,
          score: typeof cell.score === "number" ? cell.score : 0,
          selectedLineId: cell.selectedLineId ?? null,
        });
      }
    }
  }
  const outputs = (b.outputs ?? []).map((o) => ({
    category: o.category,
    link: o.link ?? "",
    description: o.description ?? "",
    imageUrl: o.imageUrl ?? "",
    imageDescription: o.imageDescription ?? "",
  }));

  // 이미 opened 면 기존 개설분이므로 측정하지 않는다(취소→재개설은 원복이 아니다).
  if (b.status === "opened") return { skipped: "already opened (기존 개설분 — 무접촉)" };

  const openBody = { ...base, action: "open", leaderCells, outputs, lineSelections };
  const o1 = await http("POST", path, openBody, "experience:open");
  const dup = await http("POST", path, openBody, "experience:open-dup");
  const c1 = await http("POST", path, { ...base, action: "cancel" }, "experience:cancel");
  const o2 = await http("POST", path, openBody, "experience:reopen");
  const c2 = await http("POST", path, { ...base, action: "cancel" }, "experience:cancel2");
  return { crews: leaderCells.length, o1, dup, c1, o2, c2 };
}

async function cycleCompetency(fx, mode, round) {
  const path = "/api/admin/cluster4/competency/opening";
  const base = {
    organization: fx.org,
    week_id: fx.weekId,
    ...(mode === "test" ? { mode: "test" } : {}),
  };
  // 사전 정리 없음 — opened 신청이 0건인 주차만 대상이다.
  const openBody = {
    ...base,
    action: "open",
    output_link_1: "https://example.com/bench",
    output_description: `bench ${LABEL} r${round}`,
  };
  const o1 = await http("POST", path, openBody, "competency:open");
  const dup = await http("POST", path, openBody, "competency:open-dup");
  const c1 = await http("POST", path, { ...base, action: "cancel" }, "competency:cancel");
  const o2 = await http("POST", path, openBody, "competency:reopen");
  const c2 = await http("POST", path, { ...base, action: "cancel" }, "competency:cancel2");
  return { approved: fx.approved, o1, dup, c1, o2, c2 };
}

// ── 실행 ────────────────────────────────────────────────────────────────
function fmt(r) {
  if (!r) return "  -";
  return `${String(r.status).padStart(3)} ${r.ms.toFixed(0).padStart(7)}ms  ${r.ok ? "ok " : "ERR"} ${r.json?.error ? String(r.json.error).slice(0, 60) : ""}`;
}

async function main() {
  COOKIE = await loginCookies();
  log("admin session acquired\n");

  const fx = await findFixtures();
  log("=== fixtures ===");
  log(`info      : ${fx.info.length} → ${fx.info.slice(0, 4).map((f) => `${f.org}/${f.week}/${f.activityTypeId}`).join(" ")}`);
  log(`experience: ${fx.experience.length} → ${fx.experience.slice(0, 4).map((f) => `${f.org}/${f.week}/${f.teamName}(${f.status})`).join(" ")}`);
  log(`competency: ${fx.competency.length} → ${fx.competency.slice(0, 4).map((f) => `${f.org}/${f.week}/appr${f.approved}`).join(" ")}`);
  log("");

  const results = [];
  const plan = [];
  if (!ONLY || ONLY === "info") for (const f of fx.info.slice(0, 2)) plan.push(["info", f]);
  if (!ONLY || ONLY === "experience") for (const f of fx.experience.slice(0, 2)) plan.push(["experience", f]);
  if (!ONLY || ONLY === "competency") for (const f of fx.competency.slice(0, 2)) plan.push(["competency", f]);

  for (const [hub, f] of plan) {
    for (const mode of MODES) {
      for (let round = 1; round <= ROUNDS; round++) {
        const label = `${hub} ${f.org}/${f.week} mode=${mode} r${round}${round === 1 ? " (cold)" : ""}`;
        log(`── ${label}`);
        if (COOLDOWN_MS > 0) await sleep(COOLDOWN_MS);
        let r;
        try {
          r =
            hub === "info"
              ? await cycleInfo(f, mode, round)
              : hub === "experience"
                ? await cycleExperience(f, mode, round)
                : await cycleCompetency(f, mode, round);
        } catch (e) {
          log(`   EXCEPTION ${e.message}`);
          continue;
        }
        if (r.skipped) {
          log(`   skipped: ${r.skipped}`);
          continue;
        }
        log(`   scale     : ${JSON.stringify({ targets: r.targets, crews: r.crews, approved: r.approved })}`);
        log(`   개설       : ${fmt(r.o1)}`);
        log(`   개설(중복) : ${fmt(r.dup)}`);
        log(`   개설취소   : ${fmt(r.c1)}`);
        log(`   재개설     : ${fmt(r.o2)}`);
        log(`   재취소     : ${fmt(r.c2)}`);
        results.push({ hub, org: f.org, week: f.week, mode, round, cold: round === 1, ...["o1", "dup", "c1", "o2", "c2"].reduce((a, k) => ({ ...a, [k]: r[k] ? { ms: r[k].ms, status: r[k].status, ok: r[k].ok } : null }), {}) });
      }
    }
  }

  // 요약 — 허브×모드별 개설/취소 평균·최대(cold 분리).
  log("\n=== 요약 (ms) ===");
  log("hub/mode".padEnd(28) + "op".padEnd(10) + "n".padStart(3) + "cold".padStart(9) + "warm avg".padStart(10) + "warm max".padStart(10));
  const groups = new Map();
  for (const r of results) {
    for (const [k, opLabel] of [["o1", "개설"], ["c1", "취소"], ["o2", "재개설"], ["c2", "재취소"], ["dup", "중복개설"]]) {
      if (!r[k]) continue;
      const key = `${r.hub}|${r.mode}|${opLabel}`;
      const g = groups.get(key) ?? { cold: null, warm: [] };
      if (r.cold) g.cold = r[k].ms;
      else g.warm.push(r[k].ms);
      groups.set(key, g);
    }
  }
  for (const [key, g] of groups) {
    const [hub, mode, op] = key.split("|");
    const avg = g.warm.length ? g.warm.reduce((a, b) => a + b, 0) / g.warm.length : NaN;
    const max = g.warm.length ? Math.max(...g.warm) : NaN;
    log(
      `${hub}/${mode}`.padEnd(28) +
        op.padEnd(10) +
        String(g.warm.length).padStart(3) +
        (g.cold != null ? g.cold.toFixed(0) : "-").padStart(9) +
        (isNaN(avg) ? "-" : avg.toFixed(0)).padStart(10) +
        (isNaN(max) ? "-" : max.toFixed(0)).padStart(10),
    );
  }

  writeFileSync(JSONOUT, JSON.stringify({ label: LABEL, at: new Date().toISOString(), results, calls }, null, 2));
  log(`\nwrote ${OUT}\n      ${JSONOUT}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
