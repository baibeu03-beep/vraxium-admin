import { createClient } from "@supabase/supabase-js";
import { tickQuery } from "@/lib/supabaseQueryMeter";

const rawSupabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

// .from() / .rpc() 호출마다 요청 단위 쿼리 카운터를 증가시킨다(계측용).
// 계측 컨텍스트(runWithQueryMeter) 밖에서는 tickQuery 가 no-op 이므로 동작 영향 없음.
export const supabaseAdmin: typeof rawSupabaseAdmin = new Proxy(
  rawSupabaseAdmin,
  {
    get(target, prop, receiver) {
      if (prop === "from" || prop === "rpc") {
        const fn = Reflect.get(target, prop, receiver) as (
          ...args: unknown[]
        ) => unknown;
        return (...args: unknown[]) => {
          tickQuery();
          return fn.apply(target, args);
        };
      }
      return Reflect.get(target, prop, receiver);
    },
  },
);
