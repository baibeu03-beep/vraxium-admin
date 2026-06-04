// Vercel 운영 환경 demoUserId 테스트 모드 저장/조회 경로 진단 (HTTP 실측).
//
// 증상: 테스트 모드에서 사용자 입력 수정값이 저장 직후엔 보이는데 새로고침하면 사라짐.
// 검증 체인: front /api/activity-details(POST, demoUserId) → cluster4_line_submissions(DB)
//   → triggerAdminSnapshotRecompute → admin cluster4_weekly_card_snapshots
//   → front /api/cluster4/weekly-cards(proxy) → admin snapshot-only 조회.
//
// 실행:  node scripts/diag-demo-save-vercel-http.mjs            (읽기 전용 진단)
//        node scripts/diag-demo-save-vercel-http.mjs --write    (저장→검증→원복 풀 사이클)
//        node scripts/diag-demo-save-vercel-http.mjs --write --user <profile_user_id>
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");

// ── env (admin .env.local — Supabase 는 front/admin 동일 프로젝트) ──
for (const line of fs.readFileSync(path.join(repoRoot, ".env.local"), "utf8").split(/\r?\n/)) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}

const FRONT_BASE = process.env.DIAG_FRONT_BASE ?? "https://vraxium.vercel.app";
const ADMIN_BASE = process.env.DIAG_ADMIN_BASE ?? "https://vraxium-admin.vercel.app";
const WRITE = process.argv.includes("--write");
const userArgIdx = process.argv.indexOf("--user");
const USER_OVERRIDE = userArgIdx > -1 ? process.argv[userArgIdx + 1] : null;

const sb = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
);

const log = (...a) => console.log(...a);
const hr = (t) => log(`\n${"─".repeat(70)}\n■ ${t}\n${"─".repeat(70)}`);

async function jfetch(url, init) {
  const t0 = Date.now();
  try {
    const res = await fetch(url, init);
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* 비 JSON */ }
    return { status: res.status, ok: res.ok, json, text, ms: Date.now() - t0 };
  } catch (e) {
    return { status: 0, ok: false, json: null, text: String(e?.message ?? e), ms: Date.now() - t0 };
  }
}

async function readSnapshotRow(userId) {
  const { data, error } = await sb
    .from("cluster4_weekly_card_snapshots")
    .select("user_id, computed_at, is_stale, dto_version, card_count, cards")
    .eq("user_id", userId)
    .maybeSingle();
  if (error) return { error: error.message };
  return data ?? { missing: true };
}

async function readSubmissionRow(lineTargetId, userId) {
  const { data, error } = await sb
    .from("cluster4_line_submissions")
    .select("id, subtitle, growth_point, output_links, output_images, updated_at")
    .eq("line_target_id", lineTargetId)
    .eq("user_id", userId)
    .maybeSingle();
  if (error) return { error: error.message };
  return data;
}

// weekly-cards 응답에서 검증용 라인을 고른다.
//   우선순위: canEdit=true + 기존 submission > canEdit=true > 기존 submission(canEdit=false).
//   canEdit=false 라인은 user_edit_windows 임시 grant(공식 어드민 메커니즘)로 저장을 인가한다.
function pickEditableLine(cards) {
  const editWithSub = [];
  const editNoSub = [];
  const subOnly = [];
  const anyTarget = [];
  for (const card of cards ?? []) {
    for (const line of card.lines ?? []) {
      if (!line.lineTargetId || !card.weekId) continue;
      const entry = { weekId: card.weekId, weekNumber: card.weekNumber, line };
      if (line.canEdit) (line.submission ? editWithSub : editNoSub).push(entry);
      else if (line.submission?.subtitle) subOnly.push(entry);
      else anyTarget.push(entry);
    }
  }
  return editWithSub[0] ?? editNoSub[0] ?? subOnly[0] ?? anyTarget[0] ?? null;
}

function findLine(cards, weekId, lineTargetId) {
  for (const card of cards ?? []) {
    if (card.weekId !== weekId) continue;
    for (const line of card.lines ?? []) {
      if (line.lineTargetId === lineTargetId) return line;
    }
  }
  return null;
}

async function main() {
  log(`FRONT=${FRONT_BASE}  ADMIN=${ADMIN_BASE}  write=${WRITE}`);

  // ── 0. 테스트 유저 목록 ──
  hr("0. test_user_markers 테스트 유저");
  const { data: markers, error: mErr } = await sb
    .from("test_user_markers").select("user_id").limit(20);
  if (mErr) throw new Error(`test_user_markers 조회 실패: ${mErr.message}`);
  const testUserIds = USER_OVERRIDE ? [USER_OVERRIDE] : markers.map((r) => r.user_id);
  log(`테스트 유저 ${testUserIds.length}명`, USER_OVERRIDE ? "(--user override)" : "");

  // ── 1. admin Vercel 데모 게이트 (ENABLE_DEMO_MODE) 실측 ──
  // demoUserId 만으로 200 이면 게이트 ON / 401(Authentication required)이면 OFF(무시→세션 폴백).
  hr("1. admin 운영 데모 게이트 — GET /api/cluster4/weekly-cards?demoUserId=");
  const probeUser = testUserIds[0];
  const adminDemo = await jfetch(
    `${ADMIN_BASE}/api/cluster4/weekly-cards?demoUserId=${probeUser}`,
  );
  log(`status=${adminDemo.status} (${adminDemo.ms}ms)`,
    adminDemo.json?.error ? `error=${JSON.stringify(adminDemo.json.error)}` : `cards=${adminDemo.json?.data?.length}`);
  const adminDemoGateOn = adminDemo.status === 200;
  log(adminDemoGateOn
    ? "→ admin Vercel: 데모 게이트 ON (ENABLE_DEMO_MODE=true)"
    : "→ admin Vercel: 데모 게이트 OFF 또는 인증 폴백 (demoUserId 무시됨!)");

  // ── 2. front Vercel 데모 게이트 + proxy 동작 실측 ──
  hr("2. front 운영 proxy — GET /api/cluster4/weekly-cards?userId=&demoUserId=");
  let chosen = null;
  let frontCardsRes = null;
  for (const uid of testUserIds) {
    const res = await jfetch(
      `${FRONT_BASE}/api/cluster4/weekly-cards?userId=${uid}&demoUserId=${uid}`,
    );
    const cards = res.json?.data;
    log(`user=${uid.slice(0, 8)}… status=${res.status} cards=${Array.isArray(cards) ? cards.length : "-"} (${res.ms}ms)`);
    if (res.status !== 200 || !Array.isArray(cards)) continue;
    const pick = pickEditableLine(cards);
    frontCardsRes = frontCardsRes ?? res;
    if (pick && !chosen) {
      chosen = { userId: uid, ...pick };
      log(`  → 검증 라인 선택: week=${pick.weekNumber} part=${pick.line.partType} canEdit=${pick.line.canEdit} lineTargetId=${pick.line.lineTargetId} 기존제출=${pick.line.submission ? "있음" : "없음"}`);
      break;
    }
  }
  if (!frontCardsRes) {
    log("✗ front proxy 200 응답을 받은 테스트 유저 없음 — proxy/게이트 자체가 막혀 있음");
  }

  // ── 3. 저장 전 스냅샷 상태 ──
  if (chosen) {
    hr("3. 저장 전 admin snapshot 상태(DB 직독 = direct function 기준값)");
    const snapBefore = await readSnapshotRow(chosen.userId);
    log({ computed_at: snapBefore.computed_at, is_stale: snapBefore.is_stale, dto_version: snapBefore.dto_version, card_count: snapBefore.card_count });
    chosen.snapBefore = snapBefore;

    const subBefore = await readSubmissionRow(chosen.line.lineTargetId, chosen.userId);
    log("저장 전 cluster4_line_submissions:", subBefore ? { subtitle: subBefore.subtitle, updated_at: subBefore.updated_at } : "(row 없음)");
    chosen.subBefore = subBefore;
  }

  if (!WRITE || !chosen) {
    hr("결론(읽기 전용 단계)");
    log(`admin 데모 게이트: ${adminDemoGateOn ? "ON" : "OFF"}`);
    log(`front proxy: ${frontCardsRes ? "정상" : "실패"}`);
    log(chosen ? "편집 가능 라인 있음 → --write 로 풀 사이클 검증 가능" : "편집 가능 라인 없음 → 저장 사이클 검증 불가(작성 기간 닫힘)");
    return;
  }

  // ── 4-pre. 작성기간 임시 grant — 어드민 edit-windows 와 동일 메커니즘(user_edit_windows insert).
  // 라인 submission window 가 모두 닫혀 있어도(canEdit=false) 저장 게이트의 hasOpenWindow OR 분기로
  // 인가된다. 테스트 유저 한정 + 검증 종료 시 row 삭제.
  let editWindowId = null;
  if (!chosen.line.canEdit) {
    hr("4-pre. user_edit_windows 임시 grant (cluster4.activity_details, 30분)");
    const nowIso = new Date().toISOString();
    const { data: ew, error: ewErr } = await sb
      .from("user_edit_windows")
      .insert({
        user_id: chosen.userId,
        resource_key: "cluster4.activity_details",
        opened_at: nowIso,
        expires_at: new Date(Date.now() + 30 * 60_000).toISOString(),
        note: "diag-demo-save-vercel-http 자동 검증용 (스크립트가 종료 시 삭제)",
        updated_at: nowIso,
      })
      .select("id")
      .single();
    if (ewErr) throw new Error(`user_edit_windows insert 실패: ${ewErr.message}`);
    editWindowId = ew.id;
    log(`grant id=${editWindowId}`);
  }

  // ── 4. 저장 (front 운영 /api/activity-details POST, demoUserId 테스트 모드) ──
  const MARKER = `DIAG-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  hr(`4. 저장 — POST ${FRONT_BASE}/api/activity-details (subtitle="${MARKER}")`);
  const orig = chosen.subBefore; // null 가능(미제출 라인) — 원복 시 사용
  const postBody = {
    user_id: chosen.userId,
    demoUserId: chosen.userId,
    week_id: chosen.weekId,
    activity_type_id: chosen.line.activityTypeId ?? null,
    line_target_id: chosen.line.lineTargetId,
    sub_title: MARKER,
    growth_point: orig?.growth_point ?? null,
    outputLinks: Array.isArray(orig?.output_links) ? orig.output_links : [],
    image_urls: Array.isArray(orig?.output_images) ? orig.output_images.map((x) => x?.url ?? null) : [],
    image_captions: Array.isArray(orig?.output_images) ? orig.output_images.map((x) => x?.caption ?? "") : [],
  };
  const saveRes = await jfetch(`${FRONT_BASE}/api/activity-details`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(postBody),
  });
  log(`status=${saveRes.status} success=${saveRes.json?.success} (${saveRes.ms}ms)`);
  if (saveRes.json?.error) log("error:", saveRes.json.error, saveRes.json.message ?? "");
  log("응답 submission.subtitle:", saveRes.json?.submission?.subtitle ?? "(없음)");
  const saveOk = saveRes.status === 200 && saveRes.json?.success === true;

  // ── 5. DB persist 확인 (완료조건 1) ──
  hr("5. DB persist 확인 — cluster4_line_submissions 직독");
  const subAfter = await readSubmissionRow(chosen.line.lineTargetId, chosen.userId);
  const persisted = subAfter?.subtitle === MARKER;
  log(persisted ? `✓ DB 반영됨 (subtitle="${subAfter.subtitle}")` : `✗ DB 미반영 (subtitle=${JSON.stringify(subAfter?.subtitle)})`);

  // ── 6. snapshot 재계산 트리거 동작 확인 (완료조건 6) ──
  hr("6. snapshot 재계산 — computed_at 전진 + cards 내 marker 포함 여부");
  // 트리거는 best-effort 비동기일 수 있어 최대 20초 폴링.
  let snapAfter = null, snapHasMarker = false, computedAdvanced = false;
  for (let i = 0; i < 10; i++) {
    snapAfter = await readSnapshotRow(chosen.userId);
    computedAdvanced =
      !chosen.snapBefore.computed_at ||
      (snapAfter.computed_at && snapAfter.computed_at > chosen.snapBefore.computed_at);
    snapHasMarker = JSON.stringify(snapAfter.cards ?? "").includes(MARKER);
    if (snapHasMarker) break;
    await new Promise((r) => setTimeout(r, 2000));
  }
  log(`computed_at: ${chosen.snapBefore.computed_at} → ${snapAfter?.computed_at} (전진=${computedAdvanced})`);
  log(`is_stale: ${chosen.snapBefore.is_stale} → ${snapAfter?.is_stale}`);
  log(snapHasMarker ? "✓ snapshot cards 에 marker 포함 (재계산 트리거 동작)" : "✗ snapshot cards 에 marker 없음 (트리거 미동작/실패 → 새로고침 시 옛값 노출 원인)");

  // ── 7. 저장 직후 HTTP 조회 (완료조건 2) ──
  hr("7. 저장 직후 front HTTP 조회 — 수정값 반영?");
  const read1 = await jfetch(`${FRONT_BASE}/api/cluster4/weekly-cards?userId=${chosen.userId}&demoUserId=${chosen.userId}`);
  const line1 = findLine(read1.json?.data, chosen.weekId, chosen.line.lineTargetId);
  const immediateOk = line1?.submission?.subtitle === MARKER;
  log(`status=${read1.status} subtitle=${JSON.stringify(line1?.submission?.subtitle)} → ${immediateOk ? "✓ 반영" : "✗ 미반영"}`);

  // ── 8. "새로고침" 시뮬레이션 — 지연 후 재조회 (완료조건 3) ──
  hr("8. 새로고침 시뮬레이션 — 10초 후 front 재조회 + admin 직접 조회 비교");
  await new Promise((r) => setTimeout(r, 10_000));
  const read2 = await jfetch(`${FRONT_BASE}/api/cluster4/weekly-cards?userId=${chosen.userId}&demoUserId=${chosen.userId}`);
  const line2 = findLine(read2.json?.data, chosen.weekId, chosen.line.lineTargetId);
  const refreshOk = line2?.submission?.subtitle === MARKER;
  log(`front  status=${read2.status} subtitle=${JSON.stringify(line2?.submission?.subtitle)} → ${refreshOk ? "✓ 유지" : "✗ 사라짐"}`);

  // admin 직접(HTTP) vs DB 직독(direct) 비교 (완료조건 4)
  const readAdmin = adminDemoGateOn
    ? await jfetch(`${ADMIN_BASE}/api/cluster4/weekly-cards?userId=${chosen.userId}&demoUserId=${chosen.userId}`)
    : null;
  const lineAdmin = readAdmin ? findLine(readAdmin.json?.data, chosen.weekId, chosen.line.lineTargetId) : null;
  if (readAdmin) {
    log(`admin  status=${readAdmin.status} subtitle=${JSON.stringify(lineAdmin?.submission?.subtitle)}`);
  }
  const snapFinal = await readSnapshotRow(chosen.userId);
  const lineSnap = findLine(snapFinal.cards, chosen.weekId, chosen.line.lineTargetId);
  log(`DB직독 snapshot subtitle=${JSON.stringify(lineSnap?.submission?.subtitle)}`);
  const directVsHttpMatch =
    JSON.stringify(lineSnap?.submission?.subtitle) === JSON.stringify(line2?.submission?.subtitle);
  log(directVsHttpMatch ? "✓ direct(DB snapshot) == HTTP 응답" : "✗ direct(DB snapshot) != HTTP 응답");

  // ── 9. 원복 ──
  hr("9. 원복");
  if (orig) {
    // 기존 제출이 있던 라인 → 원래 subtitle 로 재저장.
    const restoreBody = { ...postBody, sub_title: orig.subtitle ?? null };
    const restoreRes = await jfetch(`${FRONT_BASE}/api/activity-details`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(restoreBody),
    });
    const subRestored = await readSubmissionRow(chosen.line.lineTargetId, chosen.userId);
    const restoredOk = (subRestored?.subtitle ?? null) === (orig.subtitle ?? null);
    log(`restore status=${restoreRes.status} success=${restoreRes.json?.success} → DB subtitle=${JSON.stringify(subRestored?.subtitle)} (원복 ${restoredOk ? "✓" : "✗"})`);
  } else {
    // 원래 미제출 라인 → 검증으로 생성된 row 자체를 삭제하고, snapshot stale 마킹 후
    // lazy recompute(조회 시 단건 재계산 — 운영 표준 메커니즘)로 원상 복구한다.
    const { error: delSubErr } = await sb
      .from("cluster4_line_submissions")
      .delete()
      .eq("line_target_id", chosen.line.lineTargetId)
      .eq("user_id", chosen.userId);
    log(delSubErr ? `✗ 검증 row 삭제 실패: ${delSubErr.message}` : "✓ 검증으로 생성된 submission row 삭제");
    await sb.from("cluster4_weekly_card_snapshots").update({ is_stale: true }).eq("user_id", chosen.userId);
    const refresh = await jfetch(`${FRONT_BASE}/api/cluster4/weekly-cards?userId=${chosen.userId}&demoUserId=${chosen.userId}`);
    const lineR = findLine(refresh.json?.data, chosen.weekId, chosen.line.lineTargetId);
    const cleaned = lineR?.submission?.subtitle !== MARKER;
    log(`stale 마킹 + lazy recompute 조회: status=${refresh.status} subtitle=${JSON.stringify(lineR?.submission?.subtitle)} (정리 ${cleaned ? "✓" : "✗"})`);
  }
  if (editWindowId) {
    const { error: delErr } = await sb.from("user_edit_windows").delete().eq("id", editWindowId);
    log(delErr ? `✗ 임시 grant 삭제 실패: ${delErr.message} (id=${editWindowId} 수동 삭제 필요)` : `✓ 임시 grant 삭제됨 (id=${editWindowId})`);
  }

  // ── 결론 ──
  hr("결론 — 완료 조건 체크리스트");
  log(`1. 저장 API 응답 성공            : ${saveOk ? "✓" : "✗"} (HTTP ${saveRes.status})`);
  log(`   저장이 실제 DB persist        : ${persisted ? "✓" : "✗"}`);
  log(`2. 저장 직후 조회 API 반영        : ${immediateOk ? "✓" : "✗"}`);
  log(`3. 새로고침 후 조회 API 유지      : ${refreshOk ? "✓" : "✗"}`);
  log(`4. direct vs HTTP 일치           : ${directVsHttpMatch ? "✓" : "✗"}`);
  log(`5. admin 데모 게이트(운영)        : ${adminDemoGateOn ? "ON" : "OFF — demoUserId 가 admin 직접 호출에서 무시됨"}`);
  log(`6. snapshot 재계산 트리거 동작    : ${snapHasMarker ? "✓" : "✗ ← 새로고침 증발의 유력 원인"}`);
}

main().catch((e) => {
  console.error("FATAL:", e);
  process.exit(1);
});
