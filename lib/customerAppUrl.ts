// 단일 출처: 고객(front) 앱 base URL resolver.
// ──────────────────────────────────────────────────────────────────────────
// admin 앱과 고객(front) 앱은 서로 다른 Vercel 프로젝트(= 다른 도메인)로 배포된다.
//   - 이 repo 에는 크루 페이지 라우트(/cluster-4-marketing 등)가 존재하지 않는다.
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
// 폴백 정책(코드에 localhost 를 하드코딩하지 않는다 — 환경 분기는 전적으로 env 가 담당):
//   - 로컬에서 localhost 고객앱을 열려면 .env.local 의 NEXT_PUBLIC_CUSTOMER_APP_URL
//     (예: http://localhost:3001) 로 주입한다. (env = config, code 아님)
//   - Vercel(운영/preview) 은 프로젝트 env 의 고객 도메인을 사용한다.
//   - env 가 어디에도 없으면 운영 고객 도메인으로 폴백한다 — 절대 localhost 로 가지 않는다.
// ──────────────────────────────────────────────────────────────────────────

import { organizationRouteSuffix } from "@/lib/organizations";

// 운영 고객(front) 앱 기본 도메인. env 미설정 시 안전망(절대 localhost 아님).
//   로컬에서 localhost 로 열려면 NEXT_PUBLIC_CUSTOMER_APP_URL 을 .env.local 에 설정한다.
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

  // env 가 어디에도 없을 때: 로컬/운영 구분 없이 운영 고객 도메인(절대 localhost 아님).
  //   로컬에서 localhost 를 열려면 NEXT_PUBLIC_CUSTOMER_APP_URL 을 .env.local 에 설정한다.
  return PROD_CUSTOMER_APP_URL;
}

// 프로필 사진 URL 해석(단일 출처) — 어드민에서 깨지지 않게 절대 URL 로 정규화한다.
// ──────────────────────────────────────────────────────────────────────────
//   user_profiles.profile_photo_url 은 고객(front) 앱 public 기준의 "상대 경로"
//   (예: "/images/0/cluster4/아호 캐릭터-px.png")로 저장되는 경우가 있다. 이 경로는
//   고객 도메인에서만 200 이고, 어드민 도메인에서 그대로 <img src> 에 넣으면 어드민
//   public 에 없어 404(깨진 이미지)가 된다.
//   - 상대 경로("/…")  → 고객 앱 base URL 을 붙여 절대 URL 로(공백·한글은 URL 이 자동
//     퍼센트 인코딩 → 브라우저 로드 성공). base 해석 실패 시 null(프론트가 placeholder).
//   - 이미 절대(http/https) URL(실제 Supabase Storage/외부 사진) → 그대로 통과.
//   - 그 외(빈값/비정상) → null. 운영/test 동일 DTO 경로(adminCrewDetailData)에서 사용.
export function resolveProfilePhotoUrl(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (/^https?:\/\//i.test(trimmed)) return trimmed; // 이미 절대 — 그대로
  if (!trimmed.startsWith("/")) return null; // 절대도 상대(/…)도 아닌 비정상값
  const base = resolveCustomerAppUrl();
  if (!base) return null;
  try {
    // URL 생성자가 path 의 공백·한글을 자동으로 퍼센트 인코딩한다.
    return new URL(trimmed, base).toString();
  } catch {
    return null;
  }
}

// 고객 앱 cluster-4 페이지 절대 URL(단일 출처). 어드민→고객 SoT 진입 경로.
//   - 라우트: /cluster-4-<suffix> (조직별 분기, lib/organizations 매핑).
//   - test 여부로 쿼리/대상 사용자 식별 파라미터가 갈린다(고객앱 해석 규칙에 정합):
//     · test=true  → demoUserId + mode=test (+demoUserName) : 고객앱이 demoUserId 존재 시
//       "테스트 유저 모드" 배너 표시 + test_user_markers 백엔드 검증 + 여름 시뮬레이션.
//       (test_user_markers 등재 유저만 demoUserId 가 유효 — 일반 유저에 쓰면 안 됨)
//     · test=false → userId 만 : 해당 "실제(운영)" 유저의 cluster-4 카드. demoUserId/mode=test
//       을 절대 붙이지 않으므로 배너가 뜨지 않는다. 고객앱은 userId(=session admin 시 targetUserId)
//       로 해당 유저의 실제 데이터를 조회한다.
//   - admin=true 는 공통(배너 트리거 아님 — 배너는 demoUserId 존재 여부로만 결정).
//   - base URL 해석 실패(운영 env 미설정) 시 null — 호출자가 안내/차단.
export function buildCustomerClusterUrl(
  orgSlug: string | null,
  userId: string,
  options: { test?: boolean; name?: string | null } = {},
): string | null {
  const base = resolveCustomerAppUrl();
  if (!base) return null;
  const path = `/cluster-4-${organizationRouteSuffix(orgSlug)}`;
  const url = new URL(`${base}${path}`);
  url.searchParams.set("admin", "true");
  if (options.test) {
    // 테스트 유저(test_user_markers): demoUserId → 배너 + 데모 게이트, mode=test → 여름 시뮬.
    url.searchParams.set("demoUserId", userId);
    url.searchParams.set("mode", "test");
    if (options.name && options.name.trim()) {
      url.searchParams.set("demoUserName", options.name.trim());
    }
  } else {
    // 일반(운영) 크루: userId 만 → 실제 사용자 카드(배너 없음·demoUserId/mode 없음).
    url.searchParams.set("userId", userId);
  }
  return url.toString();
}
