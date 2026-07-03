/**
 * HTTP 검증 — 실사용자 이름 복사 후 카페 매칭을 실제 API 응답으로 확인 + direct 동치.
 *   npx tsx --env-file=.env.local scripts/verify-cafe-tprefix-http.ts
 *
 * 백업(seed-test-user-realname-copy-backup.json)을 읽어 실제 변경분을 대상으로 검증:
 *   · GET  (:3000 실 서버): test 모드에서 실사용자 이름으로 검색 → 그 이름을 복사한 T크루 노출.
 *   · POST (:3010 mock): 실명 닉네임 → test 모집단 T크루 자동매칭(matched). HTTP == direct.
 */
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createClient } from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";
import {
  loadCrewRecords,
  matchCafeComments,
  type CrewRecord,
} from "@/lib/cluster4CafeLineMatch";
import { resolveUserScope } from "@/lib/userScope";

const REAL_BASE = process.env.REAL_BASE ?? "http://localhost:3000";
const MOCK_SERVER_BASE = process.env.MOCK_SERVER_BASE ?? "http://localhost:3010";
const MOCK_PORT = Number(process.env.MOCK_PORT ?? 4599);
const ORG = process.env.VERIFY_ORG ?? "phalanx";
const adminEmail = process.env.SMOKE_ADMIN_EMAIL ?? "vanuatu.golden@gmail.com";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const ANON = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY!;

type BackupEntry = { org: string; test_user_id: string; before: string; after: string; source_real_name: string };
const backup: BackupEntry[] = JSON.parse(
  readFileSync(resolve(process.cwd(), "claudedocs", "seed-test-user-realname-copy-backup.json"), "utf8"),
);

let pass = 0, fail = 0;
const check = (label: string, ok: boolean, detail = "") => {
  console.log(`  ${ok ? "✓" : "✗"} ${label}${detail ? ` — ${detail}` : ""}`);
  ok ? pass++ : fail++;
};

async function adminCookie(): Promise<string> {
  const admin = createClient(SUPABASE_URL, SERVICE);
  const browser = createClient(SUPABASE_URL, ANON);
  const { data: link } = await admin.auth.admin.generateLink({ type: "magiclink", email: adminEmail });
  const otp = (link as { properties?: { email_otp?: string } })?.properties?.email_otp;
  const { data: v } = await browser.auth.verifyOtp({ email: adminEmail, token: otp!, type: "magiclink" });
  const cap: Array<{ name: string; value: string }> = [];
  const s = createServerClient(SUPABASE_URL, ANON, { cookies: { getAll: () => [], setAll: (it) => cap.push(...it) } });
  await s.auth.setSession({ access_token: v.session!.access_token, refresh_token: v.session!.refresh_token });
  return cap.map((c) => `${c.name}=${c.value}`).join("; ");
}

function comparable(d: { matched: Array<{ order: number; nickname: string; matchReason: string; crew: { userId: string } }>; review: Array<{ order: number; nickname: string; reason: string; nameCandidates: Array<{ userId: string }> }> }) {
  return JSON.stringify({
    matched: d.matched.map((m) => ({ order: m.order, nickname: m.nickname, userId: m.crew.userId, reason: m.matchReason })),
    review: d.review.map((r) => ({ order: r.order, nickname: r.nickname, reason: r.reason, cand: r.nameCandidates.map((c) => c.userId).sort() })),
  });
}

async function main() {
  const cookie = await adminCookie();
  const orgBackup = backup.filter((b) => b.org === ORG).slice(0, 4);
  console.log(`대상 org=${ORG} · 변경분 ${orgBackup.length}건: ${orgBackup.map((b) => `${b.source_real_name}→${b.after}`).join(", ")}`);

  // ── GET (:3000 실 서버) — 실명 검색으로 복사된 T크루 노출 ──
  console.log(`\n[GET ${REAL_BASE}] test/${ORG} 실명 검색`);
  for (const b of orgBackup.slice(0, 2)) {
    const url = `${REAL_BASE}/api/admin/cluster4/cafe-line-crew?organization=${ORG}&mode=test&q=${encodeURIComponent(b.source_real_name)}`;
    const r = await fetch(url, { headers: { cookie, connection: "close" } });
    const j = await r.json();
    const rows = (j?.data?.crews ?? []) as Array<{ userId: string; name: string }>;
    const hit = rows.find((c) => c.userId === b.test_user_id && c.name === b.after);
    check(`실명 "${b.source_real_name}" 검색 → "${b.after}"(test id ${b.test_user_id.slice(0, 8)}) 노출`, Boolean(hit),
      `rows=${rows.map((c) => c.name).join(",") || "없음"}`);
  }

  // ── test 모집단(라우트와 동일 경로) + 닉네임 ──
  const crews = await loadCrewRecords(ORG);
  const scope = await resolveUserScope("test", ORG);
  const testCrews: CrewRecord[] = scope.filter(crews, (c) => c.userId);
  const nicknames = orgBackup.map((b) => `1기 카페대 ${b.source_real_name}`);
  const direct = matchCafeComments(nicknames, testCrews, { stripTestPrefix: true });

  // ── mock 크롤러 ──
  const mock = createServer((req, res) => {
    let body = ""; req.on("data", (c) => (body += c));
    req.on("end", () => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, data: {
        articleUrl: "https://cafe.naver.com/mock/1", totalComments: nicknames.length,
        uniqueNicknames: nicknames.length, nicknames, nicknameCounts: nicknames.map((n) => ({ nickname: n, count: 1 })),
      } }));
    });
  });
  await new Promise<void>((r) => mock.listen(MOCK_PORT, r));

  console.log(`\n[POST ${MOCK_SERVER_BASE}] mock 실명 닉네임 ${nicknames.length}건`);
  try {
    const r = await fetch(`${MOCK_SERVER_BASE}/api/admin/cluster4/cafe-line-crew?organization=${ORG}&mode=test`, {
      method: "POST", headers: { "Content-Type": "application/json", cookie, connection: "close" },
      body: JSON.stringify({ url: "https://cafe.naver.com/mock/1" }),
    });
    const j = await r.json();
    check("POST 200", r.status === 200, `status=${r.status} ok=${j?.success}`);
    if (j?.success) {
      const http = j.data as Parameters<typeof comparable>[0] & { matchedCrewCount: number };
      const allSurfaced = orgBackup.every((b) => http.matched.some((m) => m.crew.userId === b.test_user_id));
      check("실명 닉네임 → 복사된 T크루 전원 자동매칭", allSurfaced, `matched=${http.matchedCrewCount}`);
      check("direct == HTTP 동치", comparable(http) === comparable(direct));
      console.log(`  matched: ${http.matched.map((m) => `${m.nickname}→${m.crew.name}`).join(", ")}`);
    }
  } finally { mock.close(); }

  console.log(`\n결과: ${pass} pass / ${fail} fail`);
  process.exit(fail > 0 ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
