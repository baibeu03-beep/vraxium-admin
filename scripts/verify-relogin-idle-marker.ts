// Unit + token-shape verification for the re-login idle-marker fix.
//
//  1. Codec round-trips (encode/decode of admin_last_active).
//  2. isSameLogin() correctly distinguishes:
//       · same session id            → same login (idle enforced)
//       · different session id       → new login  (idle NOT enforced)
//       · legacy marker + newer iat  → new login  (idle NOT enforced)
//       · legacy marker + older iat  → same login (idle enforced)
//  3. A real Supabase access token actually carries `session_id` + `iat`.
//
// Run: npx tsx --env-file=.env.local scripts/verify-relogin-idle-marker.ts
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";
import {
  decodeActivityMarker,
  encodeActivityMarker,
  isSameLogin,
} from "../lib/adminActivityCookie";
import { decodeJwtClaims } from "../lib/jwtClaims";

const __dirname = dirname(fileURLToPath(import.meta.url));
const env = readFileSync(resolve(__dirname, "..", ".env.local"), "utf8");
const get = (k: string) =>
  env.match(new RegExp(`^${k}=(.+)$`, "m"))?.[1]?.trim();

let pass = 0;
let fail = 0;
const check = (label: string, ok: boolean, detail = "") => {
  console.log(`  ${ok ? "✓" : "✗"} ${label}${detail ? ` — ${detail}` : ""}`);
  ok ? pass++ : fail++;
};

// ── 1) codec round-trip ──
console.log("\n[1] admin_last_active codec");
{
  const m1 = decodeActivityMarker(encodeActivityMarker(1000, "sid-abc"));
  check("encode/decode with session id", m1?.timestampMs === 1000 && m1?.sessionId === "sid-abc", JSON.stringify(m1));
  const m2 = decodeActivityMarker(encodeActivityMarker(2000, null));
  check("encode/decode legacy (no session id)", m2?.timestampMs === 2000 && m2?.sessionId === null, JSON.stringify(m2));
  const m3 = decodeActivityMarker("3000"); // legacy value from before this deploy
  check("decode legacy plain number", m3?.timestampMs === 3000 && m3?.sessionId === null, JSON.stringify(m3));
  check("decode empty → null", decodeActivityMarker("") === null && decodeActivityMarker(undefined) === null);
  check("decode garbage → null", decodeActivityMarker("nope") === null);
}

// ── 2) isSameLogin semantics ──
console.log("\n[2] isSameLogin");
{
  const old = 1_000_000; // marker timestamp
  // Same session id → same login (idle enforced when stale).
  check(
    "same session id → same login",
    isSameLogin({ timestampMs: old, sessionId: "S1" }, "S1", old + 999) === true,
  );
  // Different session id (re-login) → NOT same login → no idle logout.
  check(
    "different session id → new login",
    isSameLogin({ timestampMs: old, sessionId: "S1" }, "S2", old + 999) === false,
  );
  // Legacy marker + a token issued AFTER it (fresh login) → new login.
  check(
    "legacy marker + newer token iat → new login",
    isSameLogin({ timestampMs: old, sessionId: null }, null, old + 5000) === false,
  );
  // Legacy marker + token issued at/before it (same session) → same login.
  check(
    "legacy marker + older token iat → same login",
    isSameLogin({ timestampMs: old, sessionId: null }, null, old - 5000) === true,
  );
  // No signal at all → default to enforcing idle (safe).
  check(
    "no session id + no iat → default same login",
    isSameLogin({ timestampMs: old, sessionId: null }, null, null) === true,
  );
}

// ── 3) real token carries session_id + iat ──
async function checkRealToken() {
  console.log("\n[3] real Supabase access token claims");
  const SUPABASE_URL = get("NEXT_PUBLIC_SUPABASE_URL")!;
  const ANON = get("NEXT_PUBLIC_SUPABASE_ANON_KEY")!;
  const SERVICE = get("SUPABASE_SERVICE_ROLE_KEY")!;
  const adminEmail = process.env.SMOKE_ADMIN_EMAIL ?? "vanuatu.golden@gmail.com";
  const admin = createClient(SUPABASE_URL, SERVICE);
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
  const token = verifyData.session!.access_token;
  const claims = decodeJwtClaims(token);
  check("token decodes to an object", !!claims, claims ? Object.keys(claims).join(",") : "null");
  check("has session_id claim (string)", typeof claims?.session_id === "string", String(claims?.session_id));
  check("has iat claim (number)", typeof claims?.iat === "number", String(claims?.iat));
  // Second sign-in ⇒ different session_id (the property the fix relies on).
  const { data: linkData2 } = await admin.auth.admin.generateLink({
    type: "magiclink",
    email: adminEmail,
  });
  const browser2 = createClient(SUPABASE_URL, ANON);
  const { data: verifyData2 } = await browser2.auth.verifyOtp({
    email: adminEmail,
    token: linkData2.properties!.email_otp!,
    type: "magiclink",
  });
  const claims2 = decodeJwtClaims(verifyData2.session!.access_token);
  check(
    "a fresh sign-in yields a DIFFERENT session_id",
    typeof claims?.session_id === "string" &&
      typeof claims2?.session_id === "string" &&
      claims!.session_id !== claims2!.session_id,
    `${claims?.session_id} vs ${claims2?.session_id}`,
  );
}

checkRealToken()
  .catch((e) => {
    console.error("ERROR:", e);
    fail++;
  })
  .finally(() => {
    console.log(`\n=== RESULT: ${pass} pass / ${fail} fail ===`);
    process.exit(fail > 0 ? 1 : 0);
  });
