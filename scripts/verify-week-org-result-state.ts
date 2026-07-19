import { resolveWeekResultStatus } from "@/lib/growthCore";

type Org = "phalanx" | "oranke" | "encre";
const uws: Record<Org, "success" | "fail" | null> = {
  phalanx: "success", oranke: "fail", encre: "success",
};

function status(org: Org, published: ReadonlySet<Org>) {
  return resolveWeekResultStatus({
    uwsStatus: uws[org], isCurrentWeek: false, isPublished: true,
    organizationReviewStatus: published.has(org) ? "published" : "aggregating",
    weekIsOfficialRest: false, experienceVerdictStatus: null,
  }).status;
}

function verify(label: string, published: Org[], expected: Record<Org, string>) {
  const set = new Set(published);
  const actual = Object.fromEntries((Object.keys(uws) as Org[]).map((org) => [org, status(org, set)]));
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${label}: ${JSON.stringify(actual)} != ${JSON.stringify(expected)}`);
  }
  console.log(`PASS ${label}`, actual);
}

// 미공표(org=aggregating) → 고객 카드는 내부어휘(aggregating/reviewing) 미노출, 기존 'tallying'(성장 집계 중)으로 매핑.
verify("phalanx only", ["phalanx"], { phalanx: "success", oranke: "tallying", encre: "tallying" });
verify("phalanx + oranke", ["phalanx", "oranke"], { phalanx: "success", oranke: "fail", encre: "tallying" });
verify("all", ["phalanx", "oranke", "encre"], { phalanx: "success", oranke: "fail", encre: "success" });

const mismatch = resolveWeekResultStatus({
  uwsStatus: null, isCurrentWeek: false, isPublished: true,
  organizationReviewStatus: "published", weekIsOfficialRest: false,
  experienceVerdictStatus: null,
});
// 공표됐으나 그 사용자 uws 부재 = 데이터 불일치: 카드 드롭 없이 'tallying'으로 유지하고 inconsistency 만 기록(어휘 미노출).
if (mismatch.status !== "tallying" || mismatch.inconsistency !== "published_without_uws") {
  throw new Error(`published-without-UWS invariant failed: ${JSON.stringify(mismatch)}`);
}
console.log("PASS published without UWS remains a tallying card + inconsistency flag", mismatch);
