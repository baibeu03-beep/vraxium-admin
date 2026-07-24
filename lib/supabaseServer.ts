import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import {
  ADMIN_PERSIST_COOKIE,
  applyAdminSessionCookieOptions,
} from "@/lib/sessionCookieOptions";

export async function getSupabaseServerClient() {
  const cookieStore = await cookies();
  // Honor the "keep me signed in" opt-in when refreshing auth cookies server-side.
  const persistSession = cookieStore.get(ADMIN_PERSIST_COOKIE)?.value === "1";

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
              // Default: session cookies (end on browser close). With the opt-in:
              // persistent 7-day cookies. See lib/sessionCookieOptions.ts.
              cookieStore.set(
                name,
                value,
                applyAdminSessionCookieOptions(options, persistSession),
              );
            }
          } catch {
            // Server Components cannot always mutate cookies; middleware can be added later if refresh is needed.
          }
        },
      },
    },
  );
}
