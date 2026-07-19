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

verify("phalanx only", ["phalanx"], { phalanx: "success", oranke: "aggregating", encre: "aggregating" });
verify("phalanx + oranke", ["phalanx", "oranke"], { phalanx: "success", oranke: "fail", encre: "aggregating" });
verify("all", ["phalanx", "oranke", "encre"], { phalanx: "success", oranke: "fail", encre: "success" });

const mismatch = resolveWeekResultStatus({
  uwsStatus: null, isCurrentWeek: false, isPublished: true,
  organizationReviewStatus: "published", weekIsOfficialRest: false,
  experienceVerdictStatus: null,
});
if (mismatch.status !== "reviewing" || mismatch.inconsistency !== "published_without_uws") {
  throw new Error(`published-without-UWS invariant failed: ${JSON.stringify(mismatch)}`);
}
console.log("PASS published without UWS remains a reviewing card", mismatch);
