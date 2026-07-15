/** READ-ONLY: computeReviewReadiness(모달이 소비하는 DTO)를 직접 호출해 항목 출력 확인. */
import { computeReviewReadiness } from "@/lib/adminWeekReviewReadiness";

async function main() {
  const wid = "39aae7a0-216f-4262-8a67-6beef1bccf22"; // 2026-07-06, iso 2026/28
  for (const scope of ["operating", "qa"] as const) {
    const r = await computeReviewReadiness(wid, scope);
    console.log(`\n════ scope=${scope} · applicable=${r.applicable} · ready=${r.ready} · scopeIsTest=${r.scopeIsTest} ════`);
    if (!r.applicable) { console.log(`  notApplicable: ${r.notApplicableReason}`); continue; }
    for (const it of r.items) {
      console.log(`  [${it.ok ? "✅" : "❌"}] ${it.label} — ${it.detail}`);
    }
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
