// fetchCafeNicknames(Vercel 클라이언트) 검증 — 스텁 크롤러를 띄우고 호출/매핑/안전실패 확인.
//   1) 정상: 크롤러 닉네임을 그대로 반환(Vercel→크롤러 호출+매핑 증명)
//   2) login_required: ok:false + 안전 메시지(내부 메시지 미노출)
//   3) 서버 예외(500): crawl_failed + 안전 메시지
//   4) 시크릿 불일치(401): crawl_failed 안전 실패
// 사용법: npm run verify:cafe-crawler-client   (env 불요 — 스텁/주입)
import { buildServer } from "../crawler/server";
import { fetchCafeNicknames } from "../lib/cafeCrawlerClient";

const SECRET = "client-test-secret";
const checks: Array<{ name: string; pass: boolean; detail: string }> = [];
const check = (name: string, pass: boolean, detail = "") => checks.push({ name, pass, detail });

const fakeData = {
  articleUrl: "https://cafe.naver.com/x/1",
  totalComments: 1,
  uniqueNicknames: 1,
  nicknames: ["김민수 콘텐츠팀 국제학부"],
  nicknameCounts: [{ nickname: "김민수 콘텐츠팀 국제학부", count: 1 }],
};

// 시나리오 스위치.
let mode: "ok" | "login" | "boom" = "ok";
const server = buildServer({
  secret: SECRET,
  crawl: async () => {
    if (mode === "login")
      return { ok: false, error: "login_required", message: "내부세션상세(노출금지)" };
    if (mode === "boom") throw new Error("boom"); // → 서버 500 crawl_failed
    return { ok: true, data: fakeData };
  },
});
async function main() {
await new Promise<void>((r) => server.listen(0, () => r()));
const addr = server.address();
const port = typeof addr === "object" && addr ? addr.port : 0;

process.env.CAFE_CRAWLER_URL = `http://127.0.0.1:${port}`;
process.env.CAFE_CRAWLER_SECRET = SECRET;
process.env.CAFE_CRAWLER_TIMEOUT_MS = "10000";

try {
  // 1) 정상
  mode = "ok";
  let r = await fetchCafeNicknames("https://cafe.naver.com/x/1");
  check(
    "정상 — 크롤러 닉네임 반환",
    r.ok === true && r.data.nicknames[0] === "김민수 콘텐츠팀 국제학부",
    JSON.stringify(r).slice(0, 120),
  );

  // 2) login_required → 안전 메시지(내부 메시지 미노출)
  mode = "login";
  r = await fetchCafeNicknames("https://cafe.naver.com/x/1");
  check(
    "login_required — 안전 메시지(내부 비노출)",
    r.ok === false && r.error === "login_required" && !r.message.includes("내부세션"),
    r.ok === false ? r.message : "ok=true?!",
  );

  // 3) 서버 예외 → crawl_failed
  mode = "boom";
  r = await fetchCafeNicknames("https://cafe.naver.com/x/1");
  check(
    "서버오류 — crawl_failed 안전 메시지",
    r.ok === false && r.error === "crawl_failed",
    r.ok === false ? r.message : "ok=true?!",
  );

  // 4) 시크릿 불일치 → 안전 실패
  process.env.CAFE_CRAWLER_SECRET = "wrong";
  mode = "ok";
  r = await fetchCafeNicknames("https://cafe.naver.com/x/1");
  check(
    "시크릿 불일치 — 안전 실패(crawl_failed)",
    r.ok === false && r.error === "crawl_failed",
    r.ok === false ? r.message : "ok=true?!",
  );
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
