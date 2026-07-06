/**
 * QA 라인 숨김 정책 종단 검증 — QA_HIDE_REAL_USERS 기준(mode=test URL 무의존).
 *
 *   setup:   npx tsx --env-file=.env.local scripts/verify-qa-hide-policy.ts --setup
 *   check:   npx tsx --env-file=.env.local scripts/verify-qa-hide-policy.ts --check
 *   cleanup: npx tsx --env-file=.env.local scripts/verify-qa-hide-policy.ts --cleanup
 *
 * check 는 현재 lib/qaFixedScope.ts QA_HIDE_REAL_USERS 값을 읽어 기대치를 자동 분기한다:
 *   true  → QA 라인 + 운영 라인 "모두" 표시 기대.
 *   false → QA 라인 "제외", 운영 라인만 표시 기대.
 * 검증 경로: direct(getCluster4WeeklyCardsForProfileUser) / snapshot(recompute→read) / HTTP(weekly-cards).
 *   snapshot 은 recomputeAndStoreWeeklyCardsSnapshot 로 생성 단계 필터를 강제 재적용한다.
 * HTTP 는 dev 서버(VERIFY_PORT, 기본 3200)가 "동일한 flag" 로 떠 있어야 일치한다.
 */
import { createClient } from "@supabase/supabase-js";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { QA_HIDE_REAL_USERS } from "@/lib/qaFixedScope";
import { getCluster4WeeklyCardsForProfileUser } from "@/lib/cluster4WeeklyCardsData";
import {
  recomputeAndStoreWeeklyCardsSnapshot,
  readWeeklyCardsSnapshot,
} from "@/lib/cluster4WeeklyCardsSnapshot";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const internalKey = process.env.INTERNAL_API_KEY!;
const sb = createClient(url, key);
const PORT = process.env.VERIFY_PORT ?? "3200";
const TAG = "QAHIDECHK";
const PAST = "2020-01-01T00:00:00Z";
const FIX = process.env.QA_FIX_PATH ?? "./scratchpad-qa-hide-fixture.json";

function lineIds(cards: any[], weekId: string): Set<string> {
  const c = (cards ?? []).find((x) => x.weekId === weekId);
  return new Set((c?.lines ?? []).map((l: any) => l.lineId).filter(Boolean));
}

async function pickWeekWithCard(userId: string): Promise<string | null> {
  const cards = await getCluster4WeeklyCardsForProfileUser(userId);
  // 비휴식·비합성(weekId 있음) 최근 주차.
  const cand = (cards ?? []).find(
    (c: any) => c.weekId && !c.isRestWeek && c.userWeekStatus !== "running",
  );
  return cand?.weekId ?? (cards ?? []).find((c: any) => c.weekId)?.weekId ?? null;
}

async function setup() {
  const { data: markers } = await sb.from("test_user_markers").select("user_id");
  const testers = (markers ?? []).map((m) => m.user_id as string);
  // 카드가 있는 테스트 유저 + 유효 activity_type + 그 유저 주차 확보.
  const { data: at } = await sb.from("activity_types").select("id").limit(1);
  const activityTypeId = at?.[0]?.id as string | undefined;
  let userId: string | null = null;
  let weekId: string | null = null;
  for (const u of testers.slice(0, 40)) {
    const w = await pickWeekWithCard(u);
    if (w) { userId = u; weekId = w; break; }
  }
  if (!userId || !weekId || !activityTypeId) {
    throw new Error(`fixture 확보 실패 ${JSON.stringify({ userId, weekId, activityTypeId })}`);
  }

  async function makeInfoLine(isQa: boolean, label: string): Promise<string> {
    const { data, error } = await sb.from("cluster4_lines").insert({
      part_type: "info",
      activity_type_id: activityTypeId,
      main_title: `${TAG} ${label}`,
      line_code: `IFOK-${TAG}${isQa ? "Q" : "O"}`,
      week_id: weekId,
      submission_opens_at: PAST,
      submission_closes_at: PAST,
      is_active: true,
      is_qa_test: isQa,
    }).select("id").single();
    if (error || !data) throw new Error(`makeInfoLine ${label}: ${error?.message}`);
    const { error: tErr } = await sb.from("cluster4_line_targets").insert({
      line_id: data.id, week_id: weekId, target_mode: "user", target_user_id: userId,
    });
    if (tErr) throw new Error(`target ${label}: ${tErr.message}`);
    return data.id;
  }

  const qaLineId = await makeInfoLine(true, "qa");
  const opLineId = await makeInfoLine(false, "operating");

  // is_qa_test 저장 확인(DB 직독).
  const { data: rows } = await sb
    .from("cluster4_lines")
    .select("id, is_qa_test")
    .in("id", [qaLineId, opLineId]);
  const qaFlag = rows?.find((r) => r.id === qaLineId)?.is_qa_test;
  const opFlag = rows?.find((r) => r.id === opLineId)?.is_qa_test;

  writeFileSync(FIX, JSON.stringify({ userId, weekId, qaLineId, opLineId }, null, 2));
  console.log("SETUP 완료:");
  console.log(JSON.stringify({ userId, weekId, qaLineId, opLineId, qa_is_qa_test: qaFlag, op_is_qa_test: opFlag }, null, 2));
  console.log(`is_qa_test 저장: QA=${qaFlag} (기대 true) / 운영=${opFlag} (기대 false)`);
}

async function httpCards(userId: string, param: "userId" | "demoUserId") {
  try {
    const headers = param === "userId" ? { "x-internal-api-key": internalKey } : undefined;
    const res = await fetch(`http://localhost:${PORT}/api/cluster4/weekly-cards?${param}=${userId}`, { headers });
    const json = res.status === 200 ? await res.json() : null;
    return { status: res.status, data: json?.data ?? [] };
  } catch (e) {
    return { status: -1, data: [], error: e instanceof Error ? e.message : String(e) };
  }
}

async function check() {
  if (!existsSync(FIX)) throw new Error("fixture 없음 — 먼저 --setup 실행");
  const { userId, weekId, qaLineId, opLineId } = JSON.parse(readFileSync(FIX, "utf8"));
  console.log(`\n===== CHECK (QA_HIDE_REAL_USERS = ${QA_HIDE_REAL_USERS}) =====`);
  console.log(`user=${userId} week=${weekId}\n  qaLine=${qaLineId} opLine=${opLineId}`);

  // 1) snapshot 재계산(생성 단계 필터 강제 적용) → snapshot 직독.
  await recomputeAndStoreWeeklyCardsSnapshot(userId);
  const snap = await readWeeklyCardsSnapshot(userId);
  const snapCards = snap.status === "hit" || snap.status === "stale" ? (snap as any).cards : [];
  const snapIds = lineIds(snapCards, weekId);

  // 2) direct.
  const directIds = lineIds(await getCluster4WeeklyCardsForProfileUser(userId), weekId);

  // 3) HTTP (userId internal-key + demoUserId 동일 DTO 확인).
  const httpU = await httpCards(userId, "userId");
  const httpD = await httpCards(userId, "demoUserId");
  const httpIds = lineIds(httpU.data, weekId);
  const demoIds = httpD.status === 200 ? lineIds(httpD.data, weekId) : null;

  const show = (s: Set<string>) => ({ qa: s.has(qaLineId), op: s.has(opLineId) });
  const expectQa = QA_HIDE_REAL_USERS; // true→표시 / false→숨김
  console.log("가시성 (qa / op):");
  console.log("  direct   :", JSON.stringify(show(directIds)));
  console.log("  snapshot :", JSON.stringify(show(snapIds)), `(status=${snap.status})`);
  console.log(`  HTTP     : ${httpU.status === 200 ? JSON.stringify(show(httpIds)) : "HTTP " + httpU.status}`);
  console.log(`  demoUser : ${demoIds ? JSON.stringify(show(demoIds)) : "HTTP " + httpD.status + " (demo 게이트/비활성)"}`);

  const checks: [string, boolean][] = [
    [`QA 라인 표시 == ${expectQa} (direct)`, directIds.has(qaLineId) === expectQa],
    [`QA 라인 표시 == ${expectQa} (snapshot)`, snapIds.has(qaLineId) === expectQa],
    [`운영 라인 항상 표시 (direct)`, directIds.has(opLineId)],
    [`운영 라인 항상 표시 (snapshot)`, snapIds.has(opLineId)],
    [`direct == snapshot`, directIds.has(qaLineId) === snapIds.has(qaLineId) && directIds.has(opLineId) === snapIds.has(opLineId)],
  ];
  if (httpU.status === 200) {
    checks.push([`QA 라인 표시 == ${expectQa} (HTTP)`, httpIds.has(qaLineId) === expectQa]);
    checks.push([`direct == HTTP`, directIds.has(qaLineId) === httpIds.has(qaLineId) && directIds.has(opLineId) === httpIds.has(opLineId)]);
  }
  if (demoIds) checks.push([`demoUserId == userId 경로(동일 DTO)`, demoIds.has(qaLineId) === httpIds.has(qaLineId) && demoIds.has(opLineId) === httpIds.has(opLineId)]);
  // 운영(false)일 때: snapshot 에 QA 라인 잔존 없음(재계산 후).
  if (!QA_HIDE_REAL_USERS) checks.push([`운영 snapshot 재계산 후 QA 라인 잔존 없음`, !snapIds.has(qaLineId)]);

  let ok = true;
  console.log("판정:");
  for (const [label, pass] of checks) { console.log(`  ${pass ? "✓" : "✗"} ${label}`); if (!pass) ok = false; }
  console.log(ok ? `\nRESULT(flag=${QA_HIDE_REAL_USERS}): PASS` : `\nRESULT(flag=${QA_HIDE_REAL_USERS}): FAIL`);
  process.exitCode = ok ? 0 : 1;
}

async function cleanup() {
  if (!existsSync(FIX)) { console.log("fixture 없음 — 정리 대상 없음"); return; }
  const { userId, qaLineId, opLineId } = JSON.parse(readFileSync(FIX, "utf8"));
  await sb.from("cluster4_lines").delete().in("id", [qaLineId, opLineId]);
  await recomputeAndStoreWeeklyCardsSnapshot(userId); // 임시 라인 제거 반영.
  console.log(`cleanup: 임시 라인 2개 삭제 + snapshot 재계산 (user=${userId})`);
}

const MODE = process.argv.includes("--setup") ? setup
  : process.argv.includes("--cleanup") ? cleanup
  : check;
MODE().catch((e) => { console.error(e); process.exit(1); });
