// 이슈2 검증(정정판) — 클럽 리뷰 링크 순차 작성: 3→6→…→27→30(Total Complete 포함)
//   변경 슬롯만 검사(레거시 30 선채움 사용자도 무관한 저장은 허용).
//   node scripts/verify-review-link-order-http.mjs [base]
//   ⚠ 실행 후 scripts/restore-review-links-tyoondohyun.ts 로 원상 복구할 것.
const BASE = process.argv[2] || "http://localhost:3001";
const UID = "bf3b4305-751a-49e3-88ad-95a20e5c4dad";

let pass = 0, fail = 0;
async function put(links, label, expect) {
  const res = await fetch(`${BASE}/api/review-link/?demoUserId=${UID}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ links }),
  });
  const json = await res.json().catch(() => null);
  const ok = res.status === expect;
  ok ? pass++ : fail++;
  console.log(`${ok ? "✅" : "❌"} ${res.status}(기대 ${expect}) ${label} →`, JSON.stringify(json)?.slice(0, 150));
}

async function getFilled(label) {
  const res = await fetch(`${BASE}/api/review-link/?userId=${UID}`);
  const json = await res.json().catch(() => null);
  const filled = (json?.links ?? []).filter((l) => l.url).map((l) => l.weekIndex);
  console.log(`GET ${label} → 채워진 주차:`, JSON.stringify(filled));
}

await getFilled("초기 상태"); // 기대: [30(레거시), 3]

// 0) 레거시(30 선채움) 사용자도 무관한 슬롯 저장은 허용 — 6 작성(3 채워짐) → 200
await put([{ weekIndex: 6, url: "https://example.com/review-6" }], "레거시 30 존재 중 6주차 순서대로 작성", 200);

// 1) 30 값 수정 시도 — 9~27 미작성 → 400 (작성/수정 모두 전체 선행 필요)
await put([{ weekIndex: 30, url: "https://example.com/total-new" }], "27 미작성 상태에서 30 수정 시도", 400);

// 2) 30 비우기 — 뒤 주차 없음 → 200
await put([{ weekIndex: 30, url: null }], "30 비우기", 200);

// 3) [핵심] 27 미작성 상태에서 30 작성 시도 → 400
await put([{ weekIndex: 30, url: "https://example.com/total" }], "27 미작성 상태에서 30 작성 시도", 400);

// 4) 9 건너뛰고 12 작성 → 400
await put([{ weekIndex: 12, url: "https://example.com/review-12" }], "9 건너뛰고 12 작성 시도", 400);

// 5) 9~27 일괄 작성(한 PUT, 최종 상태 충족) → 200
await put(
  [9, 12, 15, 18, 21, 24, 27].map((w) => ({ weekIndex: w, url: `https://example.com/review-${w}` })),
  "9~27 일괄 순서대로 작성",
  200,
);

// 6) [핵심] 27까지 작성 완료 후 30 작성 → 200
await put([{ weekIndex: 30, url: "https://example.com/total" }], "27 작성 완료 후 30 작성", 200);

// 7) 30 채워진 상태에서 27 비우기 → 400
await put([{ weekIndex: 27, url: null }], "30 존재 중 27 비우기 시도", 400);

// 8) 정리: 30부터 역순 비우기 → 200
await put([{ weekIndex: 30, url: null }], "30 비우기(정리)", 200);
await put(
  [27, 24, 21, 18, 15, 12, 9, 6].map((w) => ({ weekIndex: w, url: null })),
  "27~6 일괄 비우기(정리)",
  200,
);

await getFilled("정리 후 상태"); // 기대: [3] — 30 레거시 값은 복구 스크립트로 원복
console.log(`\n결과: ${pass} pass / ${fail} fail`);
process.exitCode = fail ? 1 : 0;
