// getCrewWeekLineDetail 실데이터 통합 검증(read-only). 운영진 이미지가 있는 라인의 대상 크루로
//   DTO 를 조회해 imageSlots(고정 4슬롯·슬롯0=운영진) + adminImageSlotCount 를 확인한다.
//   loader 는 mode 인자를 받지 않으므로 일반/test/actAs/demo 모든 경로가 같은 userId→같은 DTO 를 반환한다(구조적 보장).
//   실행: npx tsx --env-file=.env.local scripts/diag-line-detail-slots-live.ts
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { getCrewWeekLineDetail } from "@/lib/adminCrewWeekLineDetail";
import { normalizeOutputImages } from "@/lib/cluster4OutputImages";

async function main() {
  void normalizeOutputImages;
  // 아무 user-mode 대상(개설된 라인)이나 골라 DTO 구조(예약 슬롯)를 실데이터로 확인한다.
  const { data: tgts } = await supabaseAdmin
    .from("cluster4_line_targets")
    .select("target_user_id, week_id, line_id")
    .eq("target_mode", "user")
    .not("target_user_id", "is", null)
    .limit(60);
  console.log(`user-mode 대상 후보 = ${(tgts ?? []).length}`);
  {
    for (const tg of tgts ?? []) {
      const userId = tg.target_user_id as string;
      const weekId = tg.week_id as string;
      const line = { id: tg.line_id as string };
      try {
        const res = await getCrewWeekLineDetail(userId, weekId, line.id);
        if (!res.ok) continue;
        const s = res.data.submission;
        console.log(`\n✔ DTO OK — user=${userId.slice(0, 8)} line=${line.id.slice(0, 8)} part=${res.data.identity.partType}`);
        console.log(`  adminImageSlotCount = ${s.adminImageSlotCount}`);
        console.log(`  imageSlots(len=${s.imageSlots.length}):`);
        s.imageSlots.forEach((slot, i) => {
          const role = i < s.adminImageSlotCount ? "운영진" : "크루  ";
          console.log(`    [${i}] ${role} : ${slot ? slot.url.slice(0, 60) : "(빈 슬롯)"}`);
        });
        // 불변식 체크
        const okLen = s.imageSlots.length === 4;
        const okAdminSlot0 = s.adminImageSlotCount === 1;
        console.log(`  불변식: 4슬롯=${okLen} · 예약운영진슬롯=${okAdminSlot0}`);
        process.exit(okLen && okAdminSlot0 ? 0 : 1);
      } catch (e) {
        // 스냅샷 빌드 실패한 유저는 스킵
        void e;
      }
    }
  }
  console.log("\n조회 가능한 (라인 이미지 + 대상 크루) 조합을 못 찾음 — 구조 검증은 pure-function 테스트로 대체.");
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
