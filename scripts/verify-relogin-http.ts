// End-to-end HTTP verification of the re-login idle-marker fix, exercised through
// the REAL middleware. Crafts the `admin_last_active` marker directly (1h old) so
// it runs against a normal dev server with the default idle window.
//
// Scenarios
//   1. Normal recent request                 → 200 + marker re-stamped in the
//                                               new session-keyed format.
//   2. Genuine idle (SAME session_id, stale)  → 401 + sb-* cleared (idle still
//                                               enforced — the fix must NOT
//                                               weaken this).
//   3. Re-login race (NEW session sb-* + stale marker from the PRIOR session)
//                                             → 200 (the bug: previously 401).
//   4. Legacy plain-number stale marker + fresh login (deploy boundary) → 200.
//   5. Re-login race repeated 5× → always 200.
//
// Run (dev server on :3000):
//   npx tsx --env-file=.env.local scripts/verify-relogin-http.ts
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";
import { decodeJwtClaims } from "../lib/jwtClaims";

const __dirname = dirname(fileURLToPath(import.meta.url));
const env = readFileSync(resolve(__dirname, "..", ".env.local"), "utf8");
const get = (k: string) =>
  env.match(new RegExp(`^${k}=(.+)$`, "m"))?.[1]?.trim();

const BASE = process.env.SMOKE_BASE_URL ?? "http://localhost:3000";
const SUPABASE_URL = get("NEXT_PUBLIC_SUPABASE_URL")!;
const ANON = get("NEXT_PUBLIC_SUPABASE_ANON_KEY")!;
const SERVICE = get("SUPABASE_SERVICE_ROLE_KEY")!;
const adminEmail = process.env.SMOKE_ADMIN_EMAIL ?? "vanuatu.golden@gmail.com";
const admin = createClient(SUPABASE_URL, SERVICE);

let pass = 0;
let fail = 0;
const check = (label: string, ok: boolean, detail = "") => {
  console.log(`  ${ok ? "✓" : "✗"} ${label}${detail ? ` — ${detail}` : ""}`);
  ok ? pass++ : fail++;
};

type Session = { cookieHeader: string; sessionId: string | null };

async function makeSession(): Promise<Session> {
  const browser = createClient(SUPABASE_URL, ANON);
  const { data: linkData } = await admin.auth.admin.generateLink({
    type: "magiclink",
    email: adminEmail,
  });
  const { data: verifyData } = await browser.auth.verifyOtp({
    email: adminEmail,
    token: linkData.properties!.email_otp!,
    type: "magiclink",
  });
  const captured: { name: string; value: string }[] = [];
  const server = createServerClient(SUPABASE_URL, ANON, {
    cookies: { getAll: () => [], setAll: (items) => captured.push(...items) },
  });
  await server.auth.setSession({
    access_token: verifyData.session!.access_token,
    refresh_token: verifyData.session!.refresh_token,
  });
  const cookieHeader = captured.map((c) => `${c.name}=${c.value}`).join("; ");
  const claims = decodeJwtClaims(verifyData.session!.access_token);
  const sessionId =
    typeof claims?.session_id === "string" ? claims.session_id : null;
  return { cookieHeader, sessionId };
}

const OLD = Date.now() - 60 * 60 * 1000; // 1h ago — exceeds the 20-min window
const hit = (cookie: string) =>
  fetch(`${BASE}/api/admin/me`, {
    headers: { cookie, connection: "close" },
    redirect: "manual",
  });

async function main() {
  // ── 1) normal recent request ──
  console.log("\n[1] 정상 요청(활동시각 최신)");
  const s1 = await makeSession();
  const r1 = await hit(`${s1.cookieHeader}; admin_last_active=${Date.now()}.${s1.sessionId}`);
  check("정상 요청 → 200", r1.status === 200, `status=${r1.status}`);
  const marker = r1.headers.getSetCookie().find((c) => /^admin_last_active=/.test(c));
  check(
    "admin_last_active 가 세션키 형식으로 슬라이딩(ts.sessionId)",
    /^admin_last_active=\d+\.[0-9a-f-]{36}/.test(marker ?? ""),
    marker ?? "(none)",
  );

  // ── 2) genuine idle: same session, stale marker → still 401 ──
  console.log("\n[2] 진짜 미사용(동일 세션·오래된 마커) → 401 유지");
  const s2 = await makeSession();
  const r2 = await hit(`${s2.cookieHeader}; admin_last_active=${OLD}.${s2.sessionId}`);
  check("동일 세션 + 오래된 마커 → 401(미사용 로그아웃 유지)", r2.status === 401, `status=${r2.status}`);
  check(
    "401 응답이 sb 인증 쿠키를 만료시킴",
    r2.headers.getSetCookie().some((c) => /^sb-/.test(c) && /(Max-Age=0|Expires=)/i.test(c)),
  );

  // ── 3) re-login race: new session + stale PRIOR-session marker → 200 ──
  console.log("\n[3] 재로그인 레이스(새 세션 + 이전 세션의 오래된 마커) → 200 (버그 수정)");
  const sOld = await makeSession();
  const sNew = await makeSession();
  const r3 = await hit(`${sNew.cookieHeader}; admin_last_active=${OLD}.${sOld.sessionId}`);
  check(
    "새 로그인이 이전 세션의 stale 마커에도 로그아웃되지 않음 → 200",
    r3.status === 200,
    `status=${r3.status} (oldSid=${sOld.sessionId?.slice(0, 8)} newSid=${sNew.sessionId?.slice(0, 8)})`,
  );

  // ── 4) legacy plain-number marker + fresh login (deploy boundary) → 200 ──
  console.log("\n[4] 레거시 마커(순수 숫자) + 새 로그인 → 200 (배포 경계)");
  const s4 = await makeSession();
  const r4 = await hit(`${s4.cookieHeader}; admin_last_active=${OLD}`);
  check("레거시 stale 마커 + 새 로그인 → 200", r4.status === 200, `status=${r4.status}`);

  // ── 5) re-login race × 5 ──
  console.log("\n[5] 재로그인 레이스 5회 반복 → 매번 200");
  const statuses: number[] = [];
  for (let i = 0; i < 5; i += 1) {
    const a = await makeSession();
    const b = await makeSession();
    const r = await hit(`${b.cookieHeader}; admin_last_active=${OLD}.${a.sessionId}`);
    statuses.push(r.status);
  }
  check("5회 모두 200", statuses.every((s) => s === 200), `statuses=${statuses.join(",")}`);
}

main()
  .catch((e) => {
    console.error("ERROR:", e);
    fail++;
  })
  .finally(() => {
    console.log(`\n=== RESULT: ${pass} pass / ${fail} fail ===`);
    process.exit(fail > 0 ? 1 : 0);
  });
