import { createClient } from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";
import {
  resolvePersonDisplayNames,
  romanizeKoreanPersonName,
} from "@/lib/koreanRomanization";

const base = process.env.ADMIN_BASE_URL ?? "http://localhost:3012";
const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const service = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const email = process.env.SMOKE_ADMIN_EMAIL ?? "vanuatu.golden@gmail.com";

async function adminCookie() {
  const admin = createClient(url, service);
  const browser = createClient(url, anon);
  const { data: link, error: linkError } =
    await admin.auth.admin.generateLink({ type: "magiclink", email });
  if (linkError) throw linkError;
  const { data: verified, error: verifyError } = await browser.auth.verifyOtp({
    email,
    token: link.properties.email_otp,
    type: "magiclink",
  });
  if (verifyError || !verified.session) throw verifyError ?? new Error("No session");
  const captured: Array<{ name: string; value: string }> = [];
  const server = createServerClient(url, anon, {
    cookies: {
      getAll: () => [],
      setAll: (items) =>
        captured.push(...items.map(({ name, value }) => ({ name, value }))),
    },
  });
  await server.auth.setSession(verified.session);
  return {
    header: captured.map(({ name, value }) => `${name}=${value}`).join("; "),
    browser: captured.map(({ name, value }) => ({
      name,
      value,
      domain: "localhost",
      path: "/",
      httpOnly: false,
      secure: false,
      sameSite: "Lax" as const,
    })),
  };
}

async function main() {
  const db = createClient(url, service);
  const { data: profiles, error } = await db
    .from("user_profiles")
    .select("user_id,display_name,english_name,organization_slug")
    .not("english_name", "is", null)
    .limit(10000);
  if (error) throw error;
  const { data: markers, error: markerError } = await db
    .from("test_user_markers")
    .select("user_id");
  if (markerError) throw markerError;
  const testIds = new Set((markers ?? []).map((marker) => marker.user_id));
  const target = (profiles ?? []).find(
    (profile) =>
      testIds.has(profile.user_id) &&
      romanizeKoreanPersonName(profile.display_name) !==
      (profile.english_name ?? ""),
  );
  if (!target) throw new Error("No stored/automatic English-name mismatch found");

  const cookie = await adminCookie();
  const headers = { cookie: cookie.header };
  const [crewResponse, resumeResponse, normalListResponse, testListResponse] =
    await Promise.all([
      fetch(`${base}/api/admin/crews/${target.user_id}`, { headers }),
      fetch(`${base}/api/admin/crews/${target.user_id}/resume-card`, { headers }),
      fetch(`${base}/api/admin/crews`, { headers }),
      fetch(`${base}/api/admin/crews?mode=test`, { headers }),
    ]);
  const [crew, resume, normalList, testList] = await Promise.all([
    crewResponse.json(),
    resumeResponse.json(),
    normalListResponse.json(),
    testListResponse.json(),
  ]);
  const expected = resolvePersonDisplayNames(target.display_name, {
    isTestUser: true,
  }).englishName;
  const crewData = crew.data;
  const resumeData = resume.data;
  if (
    !crewResponse.ok ||
    !resumeResponse.ok ||
    crewData.displayName !== target.display_name ||
    crewData.englishName !== expected ||
    resumeData.profile.display_name !== target.display_name ||
    resumeData.englishName !== expected ||
    resumeData.profile.english_name !== expected
  ) {
    throw new Error(
      `HTTP person-name contract mismatch: ${JSON.stringify({
        crewStatus: crewResponse.status,
        resumeStatus: resumeResponse.status,
        crew,
        resume,
        expected,
      })}`,
    );
  }
  const sameKeys =
    normalListResponse.ok &&
    testListResponse.ok &&
    JSON.stringify(Object.keys(normalList.data?.[0] ?? {}).sort()) ===
      JSON.stringify(Object.keys(testList.data?.[0] ?? {}).sort());
  console.log(
    JSON.stringify(
      {
        target,
        expected,
        crewHttp: {
          status: crewResponse.status,
          displayName: crewData.displayName,
          englishName: crewData.englishName,
        },
        resumeHttp: {
          status: resumeResponse.status,
          displayName: resumeData.profile.display_name,
          englishName: resumeData.englishName,
        },
        normalAndTestDtoKeysEqual: sameKeys,
      },
      null,
      2,
    ),
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
