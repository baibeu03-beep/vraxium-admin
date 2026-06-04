// 이슈3 재현 — portfolio-channel-cards / portfolio-top-cards 업로드 500
//   node scripts/diag-upload-500.mjs [base]
const BASE = process.argv[2] || "http://localhost:3001";
const UID = "bf3b4305-751a-49e3-88ad-95a20e5c4dad"; // T윤도현 (test_user_markers 등재)

// 1x1 PNG
const PNG_BYTES = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

async function tryUpload(path, fields) {
  const fd = new FormData();
  fd.append("file", new Blob([PNG_BYTES], { type: "image/png" }), "slot-1.png");
  for (const [k, v] of Object.entries(fields)) fd.append(k, v);
  const url = `${BASE}${path}?demoUserId=${UID}`;
  const res = await fetch(url, { method: "POST", body: fd });
  let body = null;
  try { body = await res.json(); } catch { body = await res.text().catch(() => null); }
  console.log(`${res.status} POST ${path} →`, JSON.stringify(body)?.slice(0, 300));
  return { status: res.status, body };
}

console.log("base:", BASE);
await tryUpload("/api/portfolio-channel-cards/upload", { cardIndex: "1", slotIndex: "1" });
await tryUpload("/api/portfolio-top-cards/upload", { cardType: "output", cardIndex: "1", imageType: "thumb" });
