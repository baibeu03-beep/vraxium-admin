// details 10 이미지 업로드 운영 HTTP 검증 — /api/portfolio-top-cards/upload (bucket: portfolio-top-images)
//   node scripts/verify-detail10-upload-http.mjs [base]
//   1) demoUserId 업로드 200  2) 같은 slot 재업로드 200  3) public URL GET 200
//   4) 카드 PUT 저장 + GET 재조회로 mainImage 유지 확인  5) 일반모드(세션 없음) → 401 (auth 게이트, storage 무관)
const BASE = process.argv[2] || "https://vraxium.vercel.app";
const UID = "bf3b4305-751a-49e3-88ad-95a20e5c4dad"; // T윤도현 (test_user_markers 등재)
const CARD_INDEX = 10; // details 10 의 마지막 칸

// 1x1 PNG
const PNG_BYTES = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

let failures = 0;
function check(label, ok, detail) {
  console.log(`${ok ? "PASS" : "FAIL"} — ${label}${detail ? ` (${detail})` : ""}`);
  if (!ok) failures++;
}

async function upload(withDemo) {
  const fd = new FormData();
  fd.append("file", new Blob([PNG_BYTES], { type: "image/png" }), "main.png");
  fd.append("cardType", "detail");
  fd.append("cardIndex", String(CARD_INDEX));
  fd.append("imageType", "main");
  // trailingSlash:true — 비-슬래시 경로는 308 redirect 되고 Node fetch 가 FormData body 를
  // 재전송하지 못해 "Failed to parse body as FormData" 500 이 난다(진단 함정). 슬래시 직접 부착.
  const url = `${BASE}/api/portfolio-top-cards/upload/${withDemo ? `?demoUserId=${UID}` : ""}`;
  const res = await fetch(url, { method: "POST", body: fd });
  let body = null;
  try { body = await res.json(); } catch { body = null; }
  return { status: res.status, body };
}

console.log("base:", BASE, "| cardType=detail cardIndex=" + CARD_INDEX);

// 1) demoUserId 테스트모드 업로드
const up1 = await upload(true);
check("demoUserId 업로드 200", up1.status === 200 && up1.body?.url, `status=${up1.status} ${JSON.stringify(up1.body)?.slice(0, 200)}`);

// 2) 같은 slot 재업로드 (UI 삭제=필드 비움 후 새 업로드 → 동일 slot POST 재호출)
const up2 = await upload(true);
check("같은 slot 재업로드 200", up2.status === 200 && up2.body?.url, `status=${up2.status}`);

// 3) public URL 읽기
if (up2.body?.url) {
  const pub = await fetch(up2.body.url);
  check("public URL GET 200", pub.status === 200, `status=${pub.status} content-type=${pub.headers.get("content-type")}`);
} else {
  check("public URL GET 200", false, "업로드 실패로 URL 없음");
}

// 4) 카드 PUT 저장 + GET 재조회 (새로고침 유지의 서버측 근거)
const putRes = await fetch(`${BASE}/api/portfolio-top-cards/?demoUserId=${UID}`, {
  method: "PUT",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    cardType: "detail",
    cardIndex: CARD_INDEX,
    mainTitle: "diag-detail10",
    subTitle: "업로드 검증",
    roleDescription: "검증",
    report: "검증",
    insight: "검증",
    platform: "",
    contribution: 0,
    periodStartYear: 2026, periodStartMonth: 6, periodStartDay: 1,
    periodEndYear: 2026, periodEndMonth: 6, periodEndDay: 4,
    roles: ["검증"],
    tools: [],
    mainImage: up2.body?.url ?? null,
    subImages: [null, null],
    mainImageCaption: "",
    subImageCaptions: ["", ""],
    metrics: ["", "", "", "", "", ""],
    links: ["", "", ""],
  }),
});
const putJson = await putRes.json().catch(() => null);
check("카드 PUT 저장 200", putRes.status === 200, `status=${putRes.status} ${JSON.stringify(putJson)?.slice(0, 200)}`);

const getRes = await fetch(`${BASE}/api/portfolio-top-cards/?userId=${UID}&cardType=detail`);
const getJson = await getRes.json().catch(() => null);
const savedCard = (getJson?.cards ?? []).find((c) => c.cardIndex === CARD_INDEX);
check(
  "GET 재조회 mainImage 유지",
  !!savedCard && savedCard.mainImage === up2.body?.url,
  savedCard ? `mainImage=${String(savedCard.mainImage).slice(-50)}` : `card 미발견, keys=${getJson ? Object.keys(getJson).join(",") : getRes.status}`,
);

// 5) 일반모드(세션 없음) — 401 이면 auth 게이트 정상(스토리지/버킷 문제 아님)
const up3 = await upload(false);
check("일반모드 무세션 401(auth 게이트)", up3.status === 401, `status=${up3.status} ${JSON.stringify(up3.body)?.slice(0, 150)}`);

console.log(failures === 0 ? "\n전체 PASS" : `\n${failures}건 FAIL`);
process.exit(failures === 0 ? 0 : 1);
