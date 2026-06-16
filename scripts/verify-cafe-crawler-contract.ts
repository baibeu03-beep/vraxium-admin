// 크롤러 서비스 계약 검증 — buildServer 에 가짜 crawl/checkSession 주입(네이버·Playwright 불요).
//   1) 무인증 POST /crawl → 401
//   2) 틀린 시크릿 → 401
//   3) 비카페 URL → 400 invalid_url (SSRF 엣지 차단)
//   4) 정상 → 200 + 닉네임 목록만(크루/org/user 필드 부재 단언)
//   5) GET /health(shallow) → up
//   6) GET /health?deep=1 (인증) → session=valid · 무인증 → 401
// 사용법: npm run verify:cafe-crawler-contract   (env 불요)
import { buildServer } from "../crawler/server";

const SECRET = "contract-test-secret";
const fakeData = {
  articleUrl: "https://cafe.naver.com/x/1",
  totalComments: 3,
  uniqueNicknames: 2,
  nicknames: ["15기 덕성여대 이채빈", "김민수 콘텐츠팀 국제학부"],
  nicknameCounts: [
    { nickname: "15기 덕성여대 이채빈", count: 2 },
    { nickname: "김민수 콘텐츠팀 국제학부", count: 1 },
  ],
};

const server = buildServer({
  secret: SECRET,
  crawl: async () => ({ ok: true, data: fakeData }),
  checkSession: async () => true,
});

const checks: Array<{ name: string; pass: boolean; detail: string }> = [];
const check = (name: string, pass: boolean, detail = "") => checks.push({ name, pass, detail });

async function main() {
await new Promise<void>((r) => server.listen(0, () => r()));
const addr = server.address();
const port = typeof addr === "object" && addr ? addr.port : 0;
const base = `http://127.0.0.1:${port}`;
const post = (headers: Record<string, string>, body: unknown) =>
  fetch(`${base}/crawl`, { method: "POST", headers, body: JSON.stringify(body) });

try {
  // 1) 무인증
  let res = await post({ "Content-Type": "application/json" }, { url: "https://cafe.naver.com/x/1" });
  check("무인증 401", res.status === 401, `status=${res.status}`);

  // 2) 틀린 시크릿
  res = await post(
    { "Content-Type": "application/json", Authorization: "Bearer wrong" },
    { url: "https://cafe.naver.com/x/1" },
  );
  check("틀린 시크릿 401", res.status === 401, `status=${res.status}`);

  // 3) 비카페 URL
  res = await post(
    { "Content-Type": "application/json", Authorization: `Bearer ${SECRET}` },
    { url: "https://example.com/abc" },
  );
  check("비카페 URL 400 invalid_url", res.status === 400, `status=${res.status}`);

  // 4) 정상 + 닉네임만
  res = await post(
    { "Content-Type": "application/json", Authorization: `Bearer ${SECRET}` },
    { url: "https://cafe.naver.com/x/1" },
  );
  const body = (await res.json()) as { data?: Record<string, unknown> };
  const data = body?.data ?? {};
  const allowed = new Set([
    "articleUrl",
    "totalComments",
    "uniqueNicknames",
    "nicknames",
    "nicknameCounts",
  ]);
  const leakKeys = Object.keys(data).filter((k) => !allowed.has(k));
  check(
    "정상 200 + nicknames(2)",
    res.status === 200 && Array.isArray(data.nicknames) && (data.nicknames as unknown[]).length === 2,
    `status=${res.status}`,
  );
  check("응답에 크루/org/user 필드 부재", leakKeys.length === 0, `extraKeys=${leakKeys.join(",") || "none"}`);

  // 5) health shallow
  res = await fetch(`${base}/health`);
  const h = (await res.json()) as { up?: boolean };
  check("health shallow up", res.status === 200 && h.up === true, `status=${res.status}`);

  // 6) health deep (인증)
  res = await fetch(`${base}/health?deep=1`, { headers: { Authorization: `Bearer ${SECRET}` } });
  const hd = (await res.json()) as { session?: string };
  check("health deep session=valid", res.status === 200 && hd.session === "valid", `session=${hd.session}`);

  // deep 무인증 → 401
  res = await fetch(`${base}/health?deep=1`);
  check("health deep 무인증 401", res.status === 401, `status=${res.status}`);
} finally {
  server.close();
}

let failed = 0;
for (const c of checks) {
  if (!c.pass) failed++;
  console.log(`${c.pass ? "PASS" : "FAIL"} | ${c.name} | ${c.detail}`);
}
process.exit(failed === 0 ? 0 : 1);
}

main();
