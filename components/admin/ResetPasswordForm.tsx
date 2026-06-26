"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Eye, EyeOff } from "lucide-react";
import { supabaseClient } from "@/lib/supabaseClient";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { LoadingState } from "@/components/ui/loading-state";

// /auth/recovery 에서 recovery 세션(쿠키)이 발급된 상태로 진입하는 화면.
// 세션이 없으면 재요청 안내만 보여준다.
export default function ResetPasswordForm() {
  const router = useRouter();
  const [sessionState, setSessionState] = useState<
    "checking" | "ready" | "missing"
  >("checking");
  const [password, setPassword] = useState("");
  const [passwordConfirm, setPasswordConfirm] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  const [done, setDone] = useState(false);
  const [errorMessage, setErrorMessage] = useState("");

  useEffect(() => {
    let cancelled = false;
    const check = async () => {
      const { data } = await supabaseClient.auth.getSession();
      if (cancelled) return;
      setSessionState(data.session ? "ready" : "missing");
    };
    void check();
    return () => {
      cancelled = true;
    };
  }, []);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMessage("");

    if (password !== passwordConfirm) {
      setErrorMessage("비밀번호가 서로 일치하지 않습니다.");
      return;
    }
    if (password.length < 8) {
      setErrorMessage("비밀번호는 8자 이상이어야 합니다.");
      return;
    }

    setLoading(true);
    try {
      const response = await fetch("/api/auth/password-reset/complete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password }),
      });
      const json = (await response.json().catch(() => ({}))) as {
        success?: boolean;
        error?: string;
      };

      if (!response.ok || !json.success) {
        setErrorMessage(
          json.error ??
            "비밀번호 변경에 실패했습니다. 잠시 후 다시 시도해주세요.",
        );
        return;
      }

      setDone(true);
      // recovery 세션이 정상 세션으로 유지되므로 바로 admin 으로 이동.
      window.setTimeout(() => {
        router.replace("/admin");
        router.refresh();
      }, 1200);
    } catch {
      setErrorMessage(
        "비밀번호 변경에 실패했습니다. 잠시 후 다시 시도해주세요.",
      );
    } finally {
      setLoading(false);
    }
  };

  return (
    <main className="flex min-h-screen items-center justify-center bg-muted/40 px-6">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle>새 비밀번호 설정</CardTitle>
        </CardHeader>
        <CardContent>
          {sessionState === "checking" && (
            <LoadingState
              active
              variant="inline"
              title="재설정 세션을 확인하는 중..."
            />
          )}

          {sessionState === "missing" && (
            <div className="flex flex-col gap-4">
              <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
                재설정 세션이 없거나 만료되었습니다. 재설정 메일을 다시
                요청해주세요.
              </div>
              <Link
                href="/forgot-password"
                className="text-sm text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
              >
                재설정 메일 다시 요청하기
              </Link>
            </div>
          )}

          {sessionState === "ready" && done && (
            <div className="rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-700">
              비밀번호가 변경되었습니다. 관리자 화면으로 이동합니다...
            </div>
          )}

          {sessionState === "ready" && !done && (
            <form onSubmit={handleSubmit} className="flex flex-col gap-4">
              <div className="flex flex-col gap-2">
                <Label htmlFor="new-password">새 비밀번호</Label>
                <div className="relative">
                  <Input
                    id="new-password"
                    type={showPassword ? "text" : "password"}
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    autoComplete="new-password"
                    required
                    minLength={8}
                    className="pr-9"
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassword((prev) => !prev)}
                    aria-label={
                      showPassword ? "비밀번호 숨기기" : "비밀번호 보기"
                    }
                    aria-pressed={showPassword}
                    className="absolute inset-y-0 right-0 flex items-center px-2 text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 rounded-r-lg"
                  >
                    {showPassword ? (
                      <EyeOff className="h-4 w-4" aria-hidden="true" />
                    ) : (
                      <Eye className="h-4 w-4" aria-hidden="true" />
                    )}
                  </button>
                </div>
                <p className="text-xs text-muted-foreground">
                  8자 이상으로 입력해주세요.
                </p>
              </div>
              <div className="flex flex-col gap-2">
                <Label htmlFor="new-password-confirm">새 비밀번호 확인</Label>
                <Input
                  id="new-password-confirm"
                  type={showPassword ? "text" : "password"}
                  value={passwordConfirm}
                  onChange={(e) => setPasswordConfirm(e.target.value)}
                  autoComplete="new-password"
                  required
                  minLength={8}
                />
              </div>
              {errorMessage && (
                <p className="text-sm text-destructive">{errorMessage}</p>
              )}
              <Button type="submit" className="w-full" loading={loading}>
                비밀번호 변경
              </Button>
            </form>
          )}
        </CardContent>
      </Card>
    </main>
  );
}
