// 이슈3 인프라 수정 — cluster3 포트폴리오 이미지 storage 버킷 생성.
//   근본 원인: front upload 라우트가 참조하는 버킷 2종이 Supabase storage 에 미생성
//   → storage.upload "Bucket not found" → 500 "이미지 업로드에 실패했습니다".
//   (기존 카드 이미지는 /images/0/... 로컬 정적 경로라 업로드가 일어나지 않아,
//    "삭제 후 재업로드" 시점에 처음으로 실제 업로드가 발생하며 드러났다.)
// 라우트 정책과 동일: public 읽기, 5MB 제한, JPEG/PNG/WebP/GIF.
//   - app/api/portfolio-channel-cards/upload/route.ts → portfolio-channel-images
//   - app/api/portfolio-top-cards/upload/route.ts     → portfolio-top-images
// idempotent — 이미 존재하면 skip.
import { config } from "dotenv";
config({ path: ".env.local" });

const BUCKETS = ["portfolio-channel-images", "portfolio-top-images"] as const;

async function main() {
  const { createClient } = await import("@supabase/supabase-js");
  const sb = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  );

  const { data: existing, error: listErr } = await sb.storage.listBuckets();
  if (listErr) throw listErr;
  const existingNames = new Set((existing ?? []).map((b) => b.name));
  console.log("기존 buckets:", [...existingNames].join(", "));

  for (const name of BUCKETS) {
    if (existingNames.has(name)) {
      console.log(`skip (이미 존재): ${name}`);
      continue;
    }
    const { error } = await sb.storage.createBucket(name, {
      public: true, // getPublicUrl 로 노출 (front 라우트가 publicUrl 반환)
      fileSizeLimit: 5 * 1024 * 1024, // 라우트 MAX_FILE_SIZE 와 동일
      allowedMimeTypes: ["image/jpeg", "image/png", "image/webp", "image/gif"],
    });
    if (error) {
      console.error(`생성 실패: ${name} — ${error.message}`);
      process.exitCode = 1;
    } else {
      console.log(`생성 완료: ${name} (public, 5MB, image/*)`);
    }
  }

  const { data: after } = await sb.storage.listBuckets();
  console.log("최종 buckets:", (after ?? []).map((b) => `${b.name}(public=${b.public})`).join(", "));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
