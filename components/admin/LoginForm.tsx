"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Eye, EyeOff } from "lucide-react";
import { supabaseClient } from "@/lib/supabaseClient";
import { setKeepSignedIn } from "@/lib/adminPersistSession";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { CheckboxField } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

// 저장된 Admin Code(이메일)만 보관하는 localStorage 키. 비밀번호/토큰은 절대 저장하지
// 않는다 — 비밀번호는 브라우저 비밀번호 관리자에 위임한다.
const SAVED_EMAIL_KEY = "savedAdminEmail";

function sleep(ms: number) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

async function waitForServerAdminSession() {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const response = await fetch("/api/admin/debug-session", {
      cache: "no-store",
      credentials: "include",
    });

    if (response.ok) {
      return true;
    }

    await sleep(150);
  }

  return false;
}

function describeCallbackParams(params: URLSearchParams): {
  kind: "info" | "error";
  message: string;
} | null {
  const error = params.get("error");
  if (error) {
    if (error === "missing_email") {
      return {
        kind: "error",
        message:
          "소셜 계정에서 이메일 정보를 제공받지 못했습니다. 계정 설정(예: Kakao 동의항목)에서 이메일 제공을 허용한 뒤 다시 시도해주세요.",
      };
    }
    if (error === "missing_code") {
      return {
        kind: "error",
        message: "로그인 응답이 비어 있습니다. 다시 시도해주세요.",
      };
    }
    if (error === "exchange_failed") {
      return {
        kind: "error",
        message: "세션 발급에 실패했습니다. 다시 시도해주세요.",
      };
    }
    return { kind: "error", message: error };
  }

  if (params.get("reason") === "idle") {
    return {
      kind: "info",
      message: "장시간 미사용으로 자동 로그아웃되었습니다. 다시 로그인해주세요.",
    };
  }

  if (params.get("pending") === "1") {
    return {
      kind: "info",
      message:
        "가입 신청을 접수했습니다. 관리자의 승인을 기다려주세요.",
    };
  }

  const info = params.get("info");
  if (info === "approved_user_no_app") {
    return {
      kind: "info",
      message:
        "승인된 일반 사용자 계정입니다. 이 화면은 어드민 전용이므로, 사용자 페이지에서 로그인해주세요.",
    };
  }

  return null;
}

export default function LoginForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [rememberEmail, setRememberEmail] = useState(false);
  const [keepSignedIn, setKeepSignedInState] = useState(false);
  const [errorMessage, setErrorMessage] = useState("");
  const [loading, setLoading] = useState(false);
  const [kakaoLoading, setKakaoLoading] = useState(false);
  const callbackBanner = useMemo(
    () => describeCallbackParams(searchParams),
    [searchParams],
  );

  // 저장된 Admin Code(이메일)를 재방문 시 자동으로 채운다. localStorage 접근은 클라이언트
  // 전용이라 effect 에서 읽어 하이드레이션 불일치를 피한다(초기 SSR 값은 "").
  useEffect(() => {
    try {
      const saved = window.localStorage.getItem(SAVED_EMAIL_KEY);
      if (saved) {
        // localStorage(외부 시스템)와 동기화 — 마운트 시 1회. 하이드레이션 후 실행돼
        // SSR("")과 불일치가 없다.
        // eslint-disable-next-line react-hooks/set-state-in-effect
        setEmail(saved);
        setRememberEmail(true);
      }
    } catch {
      // localStorage 접근 불가(프라이빗 모드 등) — 무시하고 빈 값 유지.
    }
  }, []);

  // "이메일(Admin Code) 저장" 토글: 해제 즉시 저장분을 삭제한다(요구사항 2).
  const handleRememberEmailChange = (checked: boolean) => {
    setRememberEmail(checked);
    if (!checked) {
      try {
        window.localStorage.removeItem(SAVED_EMAIL_KEY);
      } catch {
        // 무시
      }
    }
  };

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMessage("");
    setLoading(true);

    // 이메일 저장 선호도 반영 — 비밀번호는 저장하지 않는다.
    try {
      if (rememberEmail) {
        window.localStorage.setItem(SAVED_EMAIL_KEY, email);
      } else {
        window.localStorage.removeItem(SAVED_EMAIL_KEY);
      }
    } catch {
      // localStorage 접근 불가 — 로그인 자체는 계속 진행.
    }

    // "로그인 상태 유지" 선호도를 signInWithPassword 이전에 확정해야, 로그인으로 발급되는
    // 인증 쿠키가 곧바로 7일 지속 쿠키로 기록된다(미체크 시 기존 세션쿠키 정책).
    setKeepSignedIn(keepSignedIn);

    const { data, error } = await supabaseClient.auth.signInWithPassword({
      email,
      password,
    });

    if (error || !data.user) {
      setErrorMessage("Admin Code 또는 비밀번호가 올바르지 않습니다.");
      setLoading(false);
      return;
    }

    const { data: adminUser, error: adminError } = await supabaseClient
      .from("admin_users")
      .select("id, role, is_active")
      .eq("id", data.user.id)
      .single();

    if (adminError || !adminUser) {
      await supabaseClient.auth.signOut();
      setErrorMessage("관리자 권한이 없는 계정입니다.");
      setLoading(false);
      return;
    }

    const serverSessionReady = await waitForServerAdminSession();
    if (!serverSessionReady) {
      setErrorMessage("로그인 세션을 서버에서 확인하지 못했습니다. 다시 시도해주세요.");
      setLoading(false);
      return;
    }

    router.refresh();
    router.replace("/admin");
  };

  const handleKakaoLogin = async () => {
    if (kakaoLoading) return;
    setErrorMessage("");
    setKakaoLoading(true);

    const redirectTo = `${window.location.origin}/auth/callback`;

    const { error } = await supabaseClient.auth.signInWithOAuth({
      provider: "kakao",
      options: {
        redirectTo,
      },
    });

    if (error) {
      setErrorMessage(
        error.message ?? "카카오 로그인을 시작하지 못했습니다.",
      );
      setKakaoLoading(false);
      return;
    }
    // signInWithOAuth triggers a full-page redirect — keep the spinner visible
    // until the navigation happens.
  };

  return (
    <main className="flex min-h-screen items-center justify-center bg-muted/40 px-6">
      <Card className="w-full max-w-md">
        <CardHeader className="gap-1.5 pt-1">
          <CardTitle className="text-lg">Admin Login</CardTitle>
        </CardHeader>
        <CardContent>
          {callbackBanner && (
            <div
              className={
                "mb-5 rounded-lg border px-4 py-3 text-sm leading-relaxed " +
                (callbackBanner.kind === "info"
                  ? "border-emerald-200 bg-emerald-50 text-emerald-700"
                  : "border-red-200 bg-red-50 text-red-700")
              }
            >
              {callbackBanner.message}
            </div>
          )}
          <form onSubmit={handleLogin} className="flex flex-col gap-5">
            <div className="flex flex-col gap-2">
              <Label htmlFor="email">Admin Code</Label>
              <Input
                id="email"
                name="email"
                type="email"
                autoComplete="username"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                className="h-11 px-3.5"
              />
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="password">Password</Label>
              <div className="relative">
                <Input
                  id="password"
                  name="password"
                  type={showPassword ? "text" : "password"}
                  autoComplete="current-password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                  className="h-11 px-3.5 pr-11"
                />
                <button
                  type="button"
                  onClick={() => setShowPassword((prev) => !prev)}
                  aria-label={showPassword ? "비밀번호 숨기기" : "비밀번호 보기"}
                  aria-pressed={showPassword}
                  className="absolute inset-y-0 right-0 flex items-center px-3 text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 rounded-r-lg"
                >
                  {showPassword ? (
                    <EyeOff className="h-5 w-5" aria-hidden="true" />
                  ) : (
                    <Eye className="h-5 w-5" aria-hidden="true" />
                  )}
                </button>
              </div>
            </div>
            <div className="flex flex-col gap-2.5">
              <CheckboxField
                label="이메일(Admin Code) 저장"
                checked={rememberEmail}
                onChange={(e) => handleRememberEmailChange(e.target.checked)}
              />
              <CheckboxField
                label="로그인 상태 유지"
                checked={keepSignedIn}
                onChange={(e) => setKeepSignedInState(e.target.checked)}
              />
            </div>
            {errorMessage && (
              <p className="text-sm text-destructive">{errorMessage}</p>
            )}
            <Button
              type="submit"
              className="mt-1 h-11 w-full text-base"
              loading={loading}
              disabled={kakaoLoading}
            >
              로그인
            </Button>
            <Link
              href="/forgot-password"
              className="text-center text-sm text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
            >
              비밀번호를 잊으셨나요?
            </Link>
          </form>

          {/* 카카오 로그인 — 어드민 페이지에서는 사용 불가 (주석 처리)
          <div className="my-4 flex items-center gap-3 text-xs uppercase tracking-wider text-muted-foreground">
            <span className="h-px flex-1 bg-border" />
            <span>또는</span>
            <span className="h-px flex-1 bg-border" />
          </div>

          <Button
            type="button"
            variant="outline"
            className="w-full bg-[#FEE500] text-[#191919] hover:bg-[#FEE500]/90 hover:text-[#191919]"
            onClick={() => void handleKakaoLogin()}
            disabled={loading || kakaoLoading}
          >
            {kakaoLoading ? "카카오로 이동 중..." : "카카오로 로그인"}
          </Button>
          <p className="mt-3 text-xs leading-relaxed text-muted-foreground">
            처음 카카오 로그인 시에는 가입 신청이 접수되며, 관리자의 승인 후
            이용할 수 있습니다.
          </p>
          */}
        </CardContent>
      </Card>
    </main>
  );
}
