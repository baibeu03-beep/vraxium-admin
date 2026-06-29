import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import { toSessionCookieOptions } from "@/lib/sessionCookieOptions";

export async function getSupabaseServerClient() {
  const cookieStore = await cookies();

  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        setAll(cookiesToSet) {
          try {
            for (const { name, value, options } of cookiesToSet) {
              // Session cookies: drop maxAge/expires so the session ends on
              // browser close. See lib/sessionCookieOptions.ts.
              cookieStore.set(name, value, toSessionCookieOptions(options));
            }
          } catch {
            // Server Components cannot always mutate cookies; middleware can be added later if refresh is needed.
          }
        },
      },
    },
  );
}
