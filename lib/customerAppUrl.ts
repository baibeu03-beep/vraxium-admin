// 단일 출처: 고객(front) 앱 base URL resolver.
// ──────────────────────────────────────────────────────────────────────────
// admin 앱과 고객(front) 앱은 서로 다른 Vercel 프로젝트(= 다른 도메인)로 배포된다.
//   - 이 repo 에는 고객 페이지 라우트(/cluster-4-marketing 등)가 존재하지 않는다.
//   - vercel.json 에 고객 앱으로의 rewrite 도 없다.
//   → 따라서 window.location.origin / 요청 헤더(host, x-forwarded-host) 는 모두
//     "admin 도메인" 을 가리키므로 고객 앱 base URL 의 출처로 쓸 수 없다.
//     고객 도메인은 반드시 env 로 주입해야 한다.
//
// 우선순위(앞이 우선):
//   1) NEXT_PUBLIC_CUSTOMER_APP_URL  ← 기존 canonical (고객 앱 전용 도메인)
//   2) NEXT_PUBLIC_APP_URL           ← 범용 별칭(있으면 사용)
//   3) APP_BASE_URL                  ← server 전용 폴백(클라이언트에는 인라인 안 됨)
//
// 폴백 정책:
//   - development 에서만 http://localhost:3001 허용.
//   - production / Vercel(preview 포함) 에서 env 미설정 → 운영 고객 도메인 기본값.
//     (env 를 깜빡해도 절대 localhost 로 가지 않게 하는 안전망. preview/스테이징은
//      위 env 로 override)
// ──────────────────────────────────────────────────────────────────────────

// 개발 환경 고객 앱 기본 포트(admin=3000, customer=3001).
const DEV_CUSTOMER_APP_URL = "http://localhost:3001";

// 운영 고객(front) 앱 기본 도메인. env 미설정 시 안전망으로 사용한다.
const PROD_CUSTOMER_APP_URL = "https://vraxium.vercel.app";

function normalizeBaseUrl(raw: string | undefined | null): string | null {
  if (!raw) return null;
  const trimmed = raw.trim().replace(/\/+$/, "");
  return trimmed.length > 0 ? trimmed : null;
}

// 고객 앱 base URL 을 해석한다. 해석 실패 시 null.
//   - NEXT_PUBLIC_* 는 빌드 시 클라이언트 번들에 인라인된다.
//   - APP_BASE_URL 는 server 컴포넌트/route 에서만 읽힌다(클라이언트에선 undefined).
export function resolveCustomerAppUrl(): string | null {
  const fromEnv =
    normalizeBaseUrl(process.env.NEXT_PUBLIC_CUSTOMER_APP_URL) ??
    normalizeBaseUrl(process.env.NEXT_PUBLIC_APP_URL) ??
    normalizeBaseUrl(process.env.APP_BASE_URL);

  if (fromEnv) return fromEnv;

  // env 가 없을 때: 개발 환경만 localhost 폴백, 운영은 고객 도메인 기본값(localhost 금지).
  return process.env.NODE_ENV !== "production"
    ? DEV_CUSTOMER_APP_URL
    : PROD_CUSTOMER_APP_URL;
}
