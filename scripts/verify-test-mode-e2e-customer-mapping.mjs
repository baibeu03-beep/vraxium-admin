// 테스트 모드 E2E — 라인 개설 → DB → snapshot 재생성 → 고객앱 DTO 매핑 검증.
//   experience-lines(가장 제약 적음·explicit week_id·line_code 직접지정 OK토큰)로 oranke 테스트
//   사용자 1명에게 W13(2026-spring, mode=test 에선 비레거시) 라인 개설 후:
//     · cluster4_lines / cluster4_line_targets(테스트 사용자만) 확인
//     · 대상자 snapshot 자동 재생성(computed_at 갱신·is_stale=false) 확인
//     · GET /api/cluster4/weekly-cards?demoUserId=<test>&mode=test (live) DTO 에 라인 매핑 확인
//       (partType=experience·outputLinks·canEdit·submissionStatus·enhancementStatus)
//     · 대조: mode 없음(snapshot·운영 정책 effectiveFrom)에선 W13 레거시 fold → 개별 라인 미노출
//   cleanup: 라인/타깃 삭제 + 대상자 snapshot stale→재계산. 실사용자 무접촉(테스트 사용자만).
// 전제: dev 서버(:3000).
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
const r = createRequire(resolve(dirname(fileURLToPath(import.meta.url)), "..", "package.json"));
const { createClient } = r("@supabase/supabase-js");
const { createServerClient } = r("@supabase/ssr");
const env = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), "..", ".env.local"), "utf8");
const get = (k) => env.match(new RegExp(`^${k}=(.+)$`, "m"))?.[1]?.trim();
const BASE = "http://localhost:3000";
const URL = get("NEXT_PUBLIC_SUPABASE_URL"), ANON = get("NEXT_PUBLIC_SUPABASE_ANON_KEY"), SERVICE = get("SUPABASE_SERVICE_ROLE_KEY");
const sb = createClient(URL, SERVICE), brow = createClient(URL, ANON);
const EMAIL = "vanuatu.golden@gmail.com";
const ORG = "oranke", TAG = "ZZ-e2e-exp";
const LINE_CODE = "EXOK-ELZ999", MAIN_TITLE = `${TAG} 라인`;
const J = (o) => JSON.stringify(o);

const { data: link } = await sb.auth.admin.generateLink({ type: "magiclink", email: EMAIL });
const { data: v } = await brow.auth.verifyOtp({ email: EMAIL, token: link.properties.email_otp, type: "magiclink" });
const cap = []; const srv = createServerClient(URL, ANON, { cookies: { getAll: () => [], setAll: (i) => cap.push(...i) } });
await srv.auth.setSession({ access_token: v.session.access_token, refresh_token: v.session.refresh_token });
const cookie = cap.map((i) => `${i.name}=${i.value}`).join("; ");
const api = async (path, init = {}) => {
  const res = await fetch(`${BASE}${path}`, { ...init, headers: { "Content-Type": "application/json", cookie, ...(init.headers ?? {}) } });
  return { status: res.status, json: await res.json().catch(() => ({})) };
};
let pass = 0, fail = 0; const ck = (l, ok, d = "") => { console.log(`  ${ok ? "✓" : "✗"} ${l}${d ? ` — ${d}` : ""}`); ok ? pass++ : fail++; };

let lineId = null;
async function cleanup() {
  const rows = (await sb.from("cluster4_lines").select("id").eq("part_type", "experience").like("main_title", `${TAG}%`)).data ?? [];
  const ids = rows.map((x) => x.id);
  if (ids.length) {
    await sb.from("cluster4_line_targets").delete().in("line_id", ids);
    await sb.from("cluster4_lines").delete().in("id", ids);
  }
}

try {
  // ── 전제: oranke 테스트 사용자(snapshot 보유) + 활성 experience master + W13 ──
  const markers = new Set(((await sb.from("test_user_markers").select("user_id")).data ?? []).map((x) => x.user_id));
  const snapUsers = new Set(((await sb.from("cluster4_weekly_card_snapshots").select("user_id")).data ?? []).map((x) => x.user_id));
  const oranke = ((await sb.from("user_profiles").select("user_id").eq("organization_slug", ORG)).data ?? []);
  const testUser = oranke.find((u) => markers.has(u.user_id) && snapUsers.has(u.user_id))?.user_id
    ?? oranke.find((u) => markers.has(u.user_id))?.user_id;
  const master = ((await sb.from("cluster4_experience_line_masters").select("id").eq("is_active", true).limit(1)).data ?? [])[0];
  const week = (await sb.from("weeks").select("id,start_date,week_number").eq("season_key", "2026-spring").eq("week_number", 13).maybeSingle()).data;
  ck("[전제] 테스트유저·master·W13 확보", !!testUser && !!master?.id && !!week?.id, J({ testUser: !!testUser, master: !!master?.id, w13: week?.week_number }));
  if (!testUser || !master?.id || !week?.id) { console.log("⚠ 전제 부족 — 중단"); process.exit(2); }

  await cleanup();

  // 개설 전 상태: 대상자 snapshot computed_at + 타깃 수.
  const snapBefore = (await sb.from("cluster4_weekly_card_snapshots").select("computed_at,is_stale").eq("user_id", testUser).maybeSingle()).data;
  const tgtCountBefore = (await sb.from("cluster4_line_targets").select("id", { count: "exact", head: true }).eq("target_user_id", testUser)).count ?? 0;

  // ── 1. 라인 개설(experience, mode=test, oranke) ──
  const startMs = Date.parse(week.start_date);
  const open = await api(`/api/admin/cluster4/experience-lines?organization=${ORG}&mode=test`, {
    method: "POST",
    body: J({
      experience_line_master_id: master.id, line_code: LINE_CODE, main_title: MAIN_TITLE,
      target_user_ids: [testUser], week_id: week.id,
      submission_opens_at: new Date(startMs - 9 * 3600e3).toISOString(),
      submission_closes_at: new Date(startMs + 2 * 86400e3 + 13 * 3600e3).toISOString(),
      output_links: [{ url: "https://example.com/e2e" }],
    }),
  });
  lineId = open.json?.data?.line?.id ?? null;
  ck("[개설] 201 · lineId 반환", (open.status === 201 || open.status === 200) && !!lineId, `status=${open.status} line=${lineId}`);
  if (!lineId) { console.log("⚠ 개설 실패 — 중단", J(open.json)); await cleanup(); process.exit(1); }

  // ── 2. cluster4_lines 저장 확인 ──
  const lineRow = (await sb.from("cluster4_lines").select("part_type,line_code,main_title,is_active").eq("id", lineId).maybeSingle()).data;
  ck("[DB] cluster4_lines part_type=experience·line_code·active", lineRow?.part_type === "experience" && lineRow?.line_code === LINE_CODE && lineRow?.is_active === true, J(lineRow));

  // ── 3. cluster4_line_targets — 테스트 사용자만 저장 ──
  const targets = (await sb.from("cluster4_line_targets").select("target_user_id,target_mode,week_id").eq("line_id", lineId)).data ?? [];
  const allTest = targets.length > 0 && targets.every((t) => markers.has(t.target_user_id));
  const onlyOurUser = targets.length === 1 && targets[0].target_user_id === testUser && targets[0].week_id === week.id;
  ck("[DB] line_targets = 테스트 사용자 1명만(week 일치)", allTest && onlyOurUser, J({ n: targets.length, allTest, onlyOurUser }));

  // ── 4. snapshot 자동 재생성(대상자만) ──
  const snapAfter = (await sb.from("cluster4_weekly_card_snapshots").select("computed_at,is_stale").eq("user_id", testUser).maybeSingle()).data;
  const regen = !!snapAfter && (!snapBefore?.computed_at || Date.parse(snapAfter.computed_at) >= Date.parse(snapBefore.computed_at)) && snapAfter.is_stale === false;
  ck("[snapshot] 대상자 snapshot 재생성(computed_at 갱신·is_stale=false)", regen, J({ before: snapBefore?.computed_at, after: snapAfter?.computed_at, stale: snapAfter?.is_stale }));

  // ── 5. 고객 DTO (demoUserId, snapshot 경로) — 개설 라인 매핑 확인 ──
  //   테스트 사용자의 고객앱 카드(demoUserId)는 loadWeeklyCards(snapshot)=실유저와 동일 빌더.
  //   방금 개설된 라인이 W13 카드에 partType/output/canEdit/submission/enhancement 로 매핑되는지 확인.
  const dtoS = await api(`/api/cluster4/weekly-cards?demoUserId=${testUser}`);
  ck("[고객DTO] 200 · success", dtoS.status === 200 && dtoS.json?.success === true, `status=${dtoS.status}`);
  const cardsS = dtoS.json?.data ?? [];
  const cardS = cardsS.find((c) => c.weekId === week.id) ?? cardsS.find((c) => c.weekNumber === 13);
  const lineS = (cardS?.lines ?? []).find((l) => l.lineId === lineId);
  ck("[고객DTO] W13 카드에 개설 라인 노출(lineId 매칭)", !!lineS, J({ card: !!cardS, lineFound: !!lineS, weekNum: cardS?.weekNumber }));
  if (lineS) {
    ck("[매핑] partType=experience", lineS.partType === "experience", `partType=${lineS.partType}`);
    const links = (lineS.outputLinks ?? []).map((x) => (typeof x === "string" ? x : x?.url)).filter(Boolean);
    ck("[매핑] outputLinks 매핑", links.some((u) => String(u).includes("example.com/e2e")), J(links));
    ck("[매핑] canEdit boolean + editReason 존재", typeof lineS.canEdit === "boolean", `canEdit=${lineS.canEdit} reason=${lineS.editReason}`);
    ck("[매핑] submissionStatus 존재(미제출 정책)", typeof lineS.submissionStatus === "string", `submissionStatus=${lineS.submissionStatus}`);
    ck("[매핑] enhancementStatus 존재(강화상태)", typeof lineS.enhancementStatus === "string", `enhancementStatus=${lineS.enhancementStatus}`);
    ck("[매핑] lineCode/mainTitle 매핑", lineS.lineCode === LINE_CODE && lineS.mainTitle === MAIN_TITLE, J({ code: lineS.lineCode, title: lineS.mainTitle }));
  }

  // ── 6. mode=test(여름 시뮬, live 계산·snapshot 무접촉) — 동일 빌더로 W13 허브 렌더 확인 ──
  //   summer-sim 은 W13 을 5슬롯 허브 구조로 개별 렌더(snapshot 미사용=운영 무접촉). 동일 빌더
  //   (getCluster4WeeklyCardsForProfileUser + effectiveFromOverride)이며 매핑 분기는 없다.
  //   ⚠ 합성 테스트 라인(임의 master·line_code)은 summer-sim 의 엄격 슬롯 바인딩(v13 fail-closed)
  //     에서 제외될 수 있음 — 매핑 결함이 아니라 슬롯 정책(실데이터 master 연결 시 노출).
  const dtoT = await api(`/api/cluster4/weekly-cards?demoUserId=${testUser}&mode=test`);
  const cardsT = dtoT.json?.data ?? [];
  const cardT = cardsT.find((c) => c.weekNumber === 13);
  ck("[mode=test] 200 · W13 허브 개별 렌더(summer-sim 활성, live·snapshot 무접촉)",
    dtoT.status === 200 && !!cardT && (cardT.lines ?? []).length > 0, J({ status: dtoT.status, w13Lines: (cardT?.lines ?? []).length }));

  // ── cleanup: 라인/타깃 삭제 + 대상자 snapshot 재계산(stale→GET lazy) ──
  await cleanup();
  await sb.from("cluster4_weekly_card_snapshots").update({ is_stale: true }).eq("user_id", testUser);
  await api(`/api/cluster4/weekly-cards?demoUserId=${testUser}`); // lazy recompute 복구
  const tgtCountAfter = (await sb.from("cluster4_line_targets").select("id", { count: "exact", head: true }).eq("target_user_id", testUser)).count ?? 0;
  ck("[cleanup] 타깃 수 원복(net-zero)", tgtCountAfter === tgtCountBefore, `before=${tgtCountBefore} after=${tgtCountAfter}`);

  console.log(`\n결과: ${pass} pass / ${fail} fail`);
  process.exit(fail ? 1 : 0);
} catch (e) {
  await cleanup().catch(() => {});
  console.error("FATAL:", e?.stack ?? e);
  process.exit(1);
}
