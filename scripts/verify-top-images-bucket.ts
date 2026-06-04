// details 10 업로드 버킷 검증 — portfolio-top-images (app/api/portfolio-top-cards/upload/route.ts)
//   public / fileSizeLimit 5MB / allowedMimeTypes 4종 확인. read-only.
import { config } from "dotenv";
config({ path: ".env.local" });

async function main() {
  const { createClient } = await import("@supabase/supabase-js");
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const sb = createClient(url, process.env.SUPABASE_SERVICE_ROLE_KEY!);
  console.log("supabase project:", url);

  const { data, error } = await sb.storage.listBuckets();
  if (error) throw error;
  console.log("\n전체 buckets:");
  for (const b of data ?? []) {
    console.log(
      `- ${b.name} public=${b.public} fileSizeLimit=${(b as any).file_size_limit ?? "?"} mime=${JSON.stringify((b as any).allowed_mime_types ?? null)}`,
    );
  }

  const target = (data ?? []).find((b) => b.name === "portfolio-top-images");
  if (!target) {
    console.log("\n결과: portfolio-top-images 버킷 없음 → 생성 필요");
    process.exitCode = 2;
    return;
  }
  console.log("\n결과: portfolio-top-images 존재 ✓");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
