// ===================================================================
// 크루 상세 흐름 검증(라이브 DB). 상세 API route 가 실행하는 구성과 동일한 경로 +
// 메모 lifecycle + snapshot 불변을 직접 호출로 검증한다(requireAdmin 래퍼만 제외).
//   실행: npx tsx --env-file=.env.local scripts/verify-crew-detail-flow.ts
// ===================================================================
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { getAdminCrewDtoByLegacyUserId } from "@/lib/adminCrewData";
import { getCrewCode, lazyEnsureCrewCode } from "@/lib/adminCrewCodeData";
import { getCrewNote, upsertCrewNote } from "@/lib/adminCrewManagementNotes";

const SNAP = "cluster4_weekly_card_snapshots";
let fail = 0;
function check(ok: boolean, label: string, detail = "") {
  console.log(`${ok ? "✅" : "❌"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) fail += 1;
}

async function snapCount(): Promise<number> {
  const { count, error } = await supabaseAdmin.from(SNAP).select("*", { count: "exact", head: true });
  if (error) throw new Error(error.message);
  return count ?? 0;
}

async function main() {
  // 코드가 생성된 샘플 사용자 1명.
  const { data, error } = await supabaseAdmin
    .from("user_profiles")
    .select("user_id,display_name,crew_code")
    .not("crew_code", "is", null)
    .limit(1);
  if (error) throw new Error(error.message);
  const sample = (data ?? [])[0] as { user_id: string; display_name: string | null; crew_code: string } | undefined;
  if (!sample) { console.error("crew_code 보유 사용자 없음"); process.exit(1); }
  const userId = sample.user_id;
  console.log(`sample: ${sample.display_name} (${userId}) crew_code=${sample.crew_code}`);

  // (A) direct == route-composition (상세 GET 본문과 동일 구성).
  const direct = await getCrewCode(userId);
  const crew = await getAdminCrewDtoByLegacyUserId(userId);
  const routeCode = crew ? await lazyEnsureCrewCode(crew.userId) : null;
  await getCrewNote(userId); // route 가 호출하는 경로 동일 실행
  check(direct === routeCode && routeCode === sample.crew_code, "direct == route-composition == stored", `${direct} / ${routeCode} / ${sample.crew_code}`);

  // (B) lazy freeze — 재호출해도 동일 코드(재생성/중복 없음).
  const again = await lazyEnsureCrewCode(userId);
  check(again === direct, "lazy freeze(재호출 동일 코드)", `${again}`);

  // (C) snapshot 불변 — 메모 lifecycle 전후 snapshot row 수 동일.
  const before = await snapCount();

  // (D) 메모 lifecycle: 저장 → 수정 → 재조회, 행 1개(upsert).
  const origin = await getCrewNote(userId); // 보통 빈 메모
  const saveA = await upsertCrewNote(userId, "TEST_MEMO_A", null);
  const readA = await getCrewNote(userId);
  check(saveA.note === "TEST_MEMO_A" && readA.note === "TEST_MEMO_A", "메모 저장→재조회 A", readA.note);
  const saveB = await upsertCrewNote(userId, "TEST_MEMO_B", null);
  const readB = await getCrewNote(userId);
  check(saveB.note === "TEST_MEMO_B" && readB.note === "TEST_MEMO_B", "메모 수정→재조회 B", readB.note);
  const { count: noteRows } = await supabaseAdmin
    .from("crew_management_notes").select("*", { count: "exact", head: true }).eq("user_id", userId);
  check((noteRows ?? 0) === 1, "메모 행 1개(upsert·중복 없음)", `${noteRows}`);

  // 정리: 원래 메모가 비어있었으면 행 제거(테스트 흔적 제거).
  if (!origin.note) {
    await supabaseAdmin.from("crew_management_notes").delete().eq("user_id", userId);
  } else {
    await upsertCrewNote(userId, origin.note, origin.updatedBy);
  }

  const after = await snapCount();
  check(before === after, "snapshot row 수 불변(메모/코드 무접촉)", `${before} → ${after}`);

  console.log("─".repeat(50));
  console.log(fail === 0 ? "✅ ALL PASS" : `❌ ${fail} FAILED`);
  process.exit(fail === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
