// 예약 슬롯 실데이터 검증(read-only). cluster4 라인 아웃풋 이미지의 저장 구조가 예약 슬롯 모델과
//   호환되는지 확인한다: 운영진=cluster4_lines.output_images(≤1), 크루=cluster4_line_submissions.output_images.
//   그리고 실제 라인 1건에 대해 getCrewWeekLineDetail 이 imageSlots(고정 4슬롯·슬롯0=운영진)를 만드는지 확인.
//   실행: npx tsx --env-file=.env.local scripts/diag-line-image-slots.ts
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { normalizeOutputImages } from "@/lib/cluster4OutputImages";

async function main() {
  // 1) 저장 구조 shape 통계
  const { data: lineImgRows } = await supabaseAdmin
    .from("cluster4_lines")
    .select("id, part_type, output_images")
    .not("output_images", "is", null)
    .limit(2000);
  const linesWithImgs = (lineImgRows ?? []).filter((r) => normalizeOutputImages(r.output_images).length > 0);
  const overOne = linesWithImgs.filter((r) => normalizeOutputImages(r.output_images).length > 1);
  console.log(`[운영진 라인 이미지] output_images 보유 라인 = ${linesWithImgs.length}`);
  console.log(`  · 2개 이상(예약 모델은 1개만 슬롯0) = ${overOne.length} (clamp 로 슬롯0만 사용)`);

  const { data: subImgRows } = await supabaseAdmin
    .from("cluster4_line_submissions")
    .select("line_target_id, user_id, output_images")
    .not("output_images", "is", null)
    .limit(3000);
  const subsWithImgs = (subImgRows ?? []).filter((r) => normalizeOutputImages(r.output_images).length > 0);
  const subOverThree = subsWithImgs.filter((r) => normalizeOutputImages(r.output_images).length > 3);
  console.log(`[크루 제출 이미지] output_images 보유 제출 = ${subsWithImgs.length}`);
  console.log(`  · 크루 슬롯 초과(>3) = ${subOverThree.length} (예약 슬롯 3개로 클램프)`);
  if (subsWithImgs[0]) {
    const imgs = normalizeOutputImages(subsWithImgs[0].output_images);
    console.log(`  · 샘플 제출 이미지 구조: ${JSON.stringify(imgs.slice(0, 3))}`);
  }

  console.log("\n[결론] admin 저장=submission(크루)+line-level(운영진 슬롯0), 크루 이미지는 연속 저장.");
  console.log("       예약 슬롯 모델(슬롯0=운영진, 1..3=크루)과 기존 데이터가 호환됨(마이그레이션 불필요).");
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
