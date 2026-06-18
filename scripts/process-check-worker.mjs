// 프로세스 체크 자동 검수 worker — 정규/변동 공용 (로컬 어드민 PC 전용).
//
//   검수 시점(scheduled_check_at)이 도래한 [체크 신청] 항목을 주기 폴링 →
//   검수 링크 댓글 크롤링(기존 cafe-line-crew 로직 재사용) → 크루 식별(org+mode 스코프) →
//   결과 저장(process_check_review_recipients) + status='completed' 자동 처리.
//
//   대상:
//     · 정규  : process_check_statuses (status='pending' · scheduled_check_at<=now · review_link)
//     · 변동: process_irregular_acts (kind='review_request' · status='pending' · scheduled<=now · review_link)
//
//   · 서버/Vercel 크롤링 불가 → 운영진 PC 에서 admin(localhost:3000)과 함께 실행.
//   · 밀린 작업: 폴링 조건이 "scheduled<=now AND pending" 이라 PC 재가동 시 자동 소급.
//   · 재시도: 실패 시 attempt_count++ · last_error · last_attempt_at. MAX 회 초과/쿨다운 중이면 스킵.
//   · ⚠ user_weekly_points · 주차 성장 · snapshot · checkGate 무접촉(관리 기록만).
//
//   실행:  node scripts/process-check-worker.mjs            # 루프(기본 60초 주기)
//          node scripts/process-check-worker.mjs --once     # 1회만
//   중지:  Ctrl+C
//   env:   POLL_INTERVAL_MS(기본 60000) · WORKER_MAX_ATTEMPTS(5) · WORKER_COOLDOWN_MS(600000)
//          WORKER_ORGS=oranke,encre (스코프 한정) · WORKER_MODES=operating,test · WORKER_BASE_URL
//
//   ※ runOnce / defaultCrawlAndMatch 는 검증 스크립트에서 재사용(crawlAndMatch 주입 가능).

import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const adminRoot = resolve(__dirname, "..");
const req = createRequire(resolve(adminRoot, "package.json"));
const { createClient } = req("@supabase/supabase-js");
const { createServerClient } = req("@supabase/ssr");

const env = readFileSync(resolve(adminRoot, ".env.local"), "utf8");
const getEnv = (k) => process.env[k] ?? env.match(new RegExp(`^${k}=(.+)$`, "m"))?.[1]?.trim();

const URL = getEnv("NEXT_PUBLIC_SUPABASE_URL");
const ANON = getEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY");
const SERVICE = getEnv("SUPABASE_SERVICE_ROLE_KEY");
const BASE = getEnv("WORKER_BASE_URL") ?? "http://localhost:3000";
const ADMIN_EMAIL = getEnv("WORKER_ADMIN_EMAIL") ?? "vanuatu.golden@gmail.com";

const MAX_ATTEMPTS = Number(getEnv("WORKER_MAX_ATTEMPTS") ?? 5);
const COOLDOWN_MS = Number(getEnv("WORKER_COOLDOWN_MS") ?? 600_000);
const POLL_MS = Number(getEnv("POLL_INTERVAL_MS") ?? 60_000);

export const serviceClient = () => createClient(URL, SERVICE, { auth: { persistSession: false } });

// 어드민 세션 쿠키(magiclink) — cafe-line-crew(POST)는 admin 인증이 필요하다.
export async function ensureAdminCookie() {
  const sb = createClient(URL, SERVICE);
  const brow = createClient(URL, ANON);
  const { data: link } = await sb.auth.admin.generateLink({ type: "magiclink", email: ADMIN_EMAIL });
  const { data: v } = await brow.auth.verifyOtp({
    email: ADMIN_EMAIL,
    token: link.properties.email_otp,
    type: "magiclink",
  });
  const cap = [];
  const srv = createServerClient(URL, ANON, { cookies: { getAll: () => [], setAll: (i) => cap.push(...i) } });
  await srv.auth.setSession({ access_token: v.session.access_token, refresh_token: v.session.refresh_token });
  return cap.map((i) => `${i.name}=${i.value}`).join("; ");
}

// 기본 크롤+매칭 — 기존 cafe-line-crew(POST) 재사용(org+mode 스코프 내장, 로컬 전용).
//   반환: { matched:[{userId,nickname,reason}], review:[{nickname,reason}] }
export async function defaultCrawlAndMatch(baseUrl, cookie, org, mode, url) {
  const res = await fetch(
    `${baseUrl}/api/admin/cluster4/cafe-line-crew?organization=${encodeURIComponent(org)}&mode=${encodeURIComponent(mode)}`,
    { method: "POST", headers: { "Content-Type": "application/json", cookie }, body: JSON.stringify({ url }) },
  );
  const json = await res.json().catch(() => ({}));
  if (!res.ok || !json.success) throw new Error(json.message || json.error || `HTTP ${res.status}`);
  return {
    matched: (json.data.matched ?? []).map((m) => ({ userId: m.crew.userId, nickname: m.nickname, reason: m.matchReason })),
    review: (json.data.review ?? []).map((r) => ({ nickname: r.nickname, reason: r.reason })),
  };
}

// 기본 적립 트리거 — admin 엔드포인트(/api/admin/processes/accrue) 경유로 TS 적립 로직 재사용.
//   ledger 멱등·user_weekly_points 재계산·snapshot 무효화·era 경계·org/mode 스코프 전부 lib 단일 SoT.
//   반환: { ok, accruedUserIds?, skipped?, reason? }. 검증 스크립트가 주입 가능(crawlAndMatch 패턴).
export async function defaultAccrue(baseUrl, cookie, source, refId) {
  const res = await fetch(`${baseUrl}/api/admin/processes/accrue`, {
    method: "POST",
    headers: { "Content-Type": "application/json", cookie },
    body: JSON.stringify({ source, ref_id: refId }),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || !json.success) throw new Error(json.error || `HTTP ${res.status}`);
  return json.data;
}

// ── 만기 항목 조회(정규+변동) ─────────────────────────────────────────────────
export async function findDueItems(sb, nowIso) {
  const sel = "id,organization_slug,scope_mode,review_link,attempt_count,last_attempt_at";
  const [{ data: reg }, { data: irr }] = await Promise.all([
    sb.from("process_check_statuses").select(sel)
      .eq("status", "pending").lte("scheduled_check_at", nowIso).not("review_link", "is", null),
    sb.from("process_irregular_acts").select(sel)
      .eq("kind", "review_request").eq("status", "pending").lte("scheduled_check_at", nowIso).not("review_link", "is", null),
  ]);
  return [
    ...((reg ?? []).map((r) => ({ ...r, source: "regular", table: "process_check_statuses" }))),
    ...((irr ?? []).map((r) => ({ ...r, source: "irregular", table: "process_irregular_acts" }))),
  ];
}

// ── 1회 처리 — 만기 항목 크롤링→식별→결과 저장→완료. (crawlAndMatch 주입) ──────────
//   onlyIds: 지정 시 해당 id 만 처리(검증 스크립트가 자기 시드만 건드리도록 — 운영은 미지정).
export async function runOnce({ sb, now = Date.now(), orgs = null, modes = null, onlyIds = null, crawlAndMatch, accrue = null, log = () => {} }) {
  const nowIso = new Date(now).toISOString();
  const due = await findDueItems(sb, nowIso);

  // 쓰기 직전 스코프 재검증용 테스트 유저 집합(틱당 1회). 조회 실패 → 빈 집합(fail-safe:
  //   operating 은 전원 통과, test 는 전원 차단 → 실유저 절대 유입 안 됨, lib/userScope 와 동일 축).
  const { data: markerRows } = await sb.from("test_user_markers").select("user_id");
  const testIds = new Set(((markerRows ?? []).map((r) => r.user_id)).filter(Boolean));

  // org/mode 한정 + (옵션)id 화이트리스트 + 재시도 소진/쿨다운 필터.
  const eligible = due.filter(
    (d) =>
      (!orgs || orgs.includes(d.organization_slug)) &&
      (!modes || modes.includes(d.scope_mode ?? "operating")) &&
      (!onlyIds || onlyIds.includes(d.id)) &&
      (d.attempt_count ?? 0) < MAX_ATTEMPTS &&
      (!d.last_attempt_at || now - Date.parse(d.last_attempt_at) >= COOLDOWN_MS),
  );

  let succeeded = 0, failed = 0;
  for (const item of eligible) {
    const mode = item.scope_mode ?? "operating";
    try {
      const { matched, review } = await crawlAndMatch(item.organization_slug, mode, item.review_link);

      // ── 쓰기 직전 스코프 재검증(defense-in-depth) — cafe-line-crew 가 이미 org+mode 풀로
      //   좁히지만, 다른 write 경로(createManualGrant·info-lines·competency)와 동일하게 worker 도
      //   2차 가드를 둔다. matched user_id 전원이 (item.scope_mode 모집단) AND (item.organization_slug
      //   소속)이어야 한다. 하나라도 어긋나면 throw → recipients 미기록 · attempt_count++ (fail-closed).
      const matchedIds = matched.map((m) => m.userId).filter(Boolean);
      if (matchedIds.length) {
        const modeOffenders = matchedIds.filter((id) => (mode === "test") !== testIds.has(id));
        if (modeOffenders.length) {
          throw new Error(`scope violation(mode=${mode}): ${modeOffenders.length} user(s) out of test/operating scope`);
        }
        const { data: profRows, error: profErr } = await sb
          .from("user_profiles").select("user_id,organization_slug").in("user_id", matchedIds);
        if (profErr) throw new Error(`org check: ${profErr.message}`);
        const orgById = new Map((profRows ?? []).map((r) => [r.user_id, r.organization_slug]));
        const orgOffenders = matchedIds.filter((id) => orgById.get(id) !== item.organization_slug);
        if (orgOffenders.length) {
          throw new Error(`scope violation(org=${item.organization_slug}): ${orgOffenders.length} cross-org user(s)`);
        }
      }

      // 결과 저장(멱등: source+ref_id delete 후 재삽입).
      await sb.from("process_check_review_recipients").delete().eq("source", item.source).eq("ref_id", item.id);
      const rows = [
        ...matched.map((m) => ({
          source: item.source, ref_id: item.id, organization_slug: item.organization_slug, scope_mode: mode,
          user_id: m.userId, nickname: m.nickname, match_type: "matched", match_reason: m.reason ?? null,
        })),
        ...review.map((r) => ({
          source: item.source, ref_id: item.id, organization_slug: item.organization_slug, scope_mode: mode,
          user_id: null, nickname: r.nickname, match_type: "review", match_reason: r.reason ?? null,
        })),
      ];
      if (rows.length) {
        const { error } = await sb.from("process_check_review_recipients").insert(rows);
        if (error) throw new Error(`recipients insert: ${error.message}`);
      }

      // 완료 처리 (user_weekly_points/snapshot 무접촉).
      //   성공도 처리 기록을 남긴다 — last_attempt_at(언제 처리) + attempt_count(몇 번째 시도에 성공).
      //   완료 행은 findDueItems(status='pending')에서 재폴링되지 않으므로 retry 게이트에 무해.
      const upd = {
        status: "completed",
        completed_at: new Date(now).toISOString(),
        last_error: null,
        attempt_count: (item.attempt_count ?? 0) + 1,
        last_attempt_at: new Date(now).toISOString(),
      };
      if (item.source === "regular") upd.checked_crew_count = matched.length;
      const { error: uErr } = await sb.from(item.table).update(upd).eq("id", item.id);
      if (uErr) throw new Error(`complete update: ${uErr.message}`);

      // ── 포인트 적립(완료 즉시) — ledger 멱등·user_weekly_points 재계산·snapshot 무효화(lib SoT).
      //   best-effort: 적립 실패가 완료 처리를 되돌리지 않는다(완료는 멱등 재실행으로 적립 재시도 가능).
      //   era 경계(operating=summer+/test=+W13)·org/mode 스코프는 적립 lib 내부에서 강제.
      if (accrue) {
        try {
          const acc = await accrue(item.source, item.id);
          const tail = acc?.skipped ? `skip(${acc.reason})` : `accrued ${acc?.accruedUserIds?.length ?? 0}`;
          log(`  ↳ 적립 ${item.source} ${item.id}: ${tail}`);
        } catch (accErr) {
          log(`  ↳ 적립 실패(격리) ${item.id}: ${String(accErr?.message ?? accErr).slice(0, 200)}`);
        }
      }

      succeeded++;
      log(`✓ ${item.source} ${item.id} (${item.organization_slug}/${mode}) → matched ${matched.length} · review ${review.length}`);
    } catch (e) {
      failed++;
      const msg = String(e?.message ?? e).slice(0, 500);
      await sb.from(item.table).update({
        attempt_count: (item.attempt_count ?? 0) + 1,
        last_attempt_at: new Date(now).toISOString(),
        last_error: msg,
      }).eq("id", item.id);
      log(`✗ ${item.source} ${item.id} attempt ${(item.attempt_count ?? 0) + 1}/${MAX_ATTEMPTS}: ${msg}`);
    }
  }
  return { due: due.length, eligible: eligible.length, succeeded, failed };
}

// ── CLI 루프 ────────────────────────────────────────────────────────────────────
async function main() {
  const ORGS = getEnv("WORKER_ORGS")?.split(",").map((s) => s.trim()).filter(Boolean) ?? null;
  const MODES = getEnv("WORKER_MODES")?.split(",").map((s) => s.trim()).filter(Boolean) ?? null;
  const ONCE = process.argv.includes("--once");
  const sb = serviceClient();

  let cookie = await ensureAdminCookie();
  let cookieAt = Date.now();
  const tick = async () => {
    try {
      if (Date.now() - cookieAt > 30 * 60_000) { cookie = await ensureAdminCookie(); cookieAt = Date.now(); }
      const crawl = (org, mode, url) => defaultCrawlAndMatch(BASE, cookie, org, mode, url);
      const accrue = (source, refId) => defaultAccrue(BASE, cookie, source, refId);
      const r = await runOnce({ sb, orgs: ORGS, modes: MODES, crawlAndMatch: crawl, accrue, log: (m) => console.log(`  ${m}`) });
      console.log(`[${new Date().toISOString()}] due=${r.due} eligible=${r.eligible} ok=${r.succeeded} fail=${r.failed}`);
    } catch (e) {
      console.error(`[worker] tick error: ${e?.message ?? e}`);
    }
  };

  console.log(`[worker] start — base=${BASE} orgs=${ORGS ?? "all"} modes=${MODES ?? "all"} poll=${POLL_MS}ms once=${ONCE}`);
  await tick();
  if (!ONCE) {
    setInterval(tick, POLL_MS);
  }
}

// 직접 실행 시에만 루프 시작(검증 스크립트가 import 할 땐 미실행).
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((e) => { console.error("FATAL:", e?.stack ?? e); process.exit(1); });
}
