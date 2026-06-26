"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

// /auth/recovery 가 실패 시 ?error=… 로 되돌려 보내는 키 → 안내 문구.
function describeRecoveryError(params: URLSearchParams): string | null {
  const error = params.get("error");
  if (!error) return null;
  switch (error) {
    case "link_expired":
      return "재설정 링크가 만료되었거나 이미 사용되었습니다. 메일을 다시 요청해주세요.";
    case "exchange_failed":
      return "재설정 세션을 만들지 못했습니다. 재설정을 요청했던 같은 브라우저에서 링크를 열어주세요.";
    case "link_invalid":
    case "missing_code":
      return "재설정 링크가 올바르지 않습니다. 메일을 다시 요청해주세요.";
    default:
      return "재설정 링크 처리에 실패했습니다. 메일을 다시 요청해주세요.";
  }
}

export default function ForgotPasswordForm() {
  const searchParams = useSearchParams();
  const [email, setEmail] = useState("");
  const [loading, setLoading] = useState(false);
  const [sent, setSent] = useState(false);
  const [errorMessage, setErrorMessage] = useState("");
  const recoveryError = useMemo(
    () => describeRecoveryError(searchParams),
    [searchParams],
  );

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMessage("");
    setLoading(true);

    try {
      const response = await fetch("/api/auth/password-reset/request", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email }),
      });
      const json = (await response.json().catch(() => ({}))) as {
        success?: boolean;
        error?: string;
      };

      if (!response.ok || !json.success) {
        setErrorMessage(
          json.error ?? "메일 발송에 실패했습니다. 잠시 후 다시 시도해주세요.",
        );
        return;
      }
      setSent(true);
    } catch {
      setErrorMessage("메일 발송에 실패했습니다. 잠시 후 다시 시도해주세요.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <main className="flex min-h-screen items-center justify-center bg-muted/40 px-6">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle>비밀번호 재설정</CardTitle>
        </CardHeader>
        <CardContent>
          {recoveryError && !sent && (
            <div className="mb-4 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
              {recoveryError}
            </div>
          )}

          {sent ? (
            <div className="flex flex-col gap-4">
              <div className="rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-700">
                관리자 계정이라면 비밀번호 재설정 메일이 발송됩니다.
                <br />
                메일함을 확인한 뒤, 링크를 열어 새 비밀번호를 설정해주세요.
              </div>
              <p className="text-xs text-muted-foreground">
                메일이 오지 않으면 스팸함을 확인하거나 잠시 후 다시
                요청해주세요. 보안을 위해 재설정 링크는 이 요청을 보낸 브라우저에서
                열어야 합니다.
              </p>
              <Link
                href="/login"
                className="text-sm text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
              >
                로그인 화면으로 돌아가기
              </Link>
            </div>
          ) : (
            <form onSubmit={handleSubmit} className="flex flex-col gap-4">
              <p className="text-sm text-muted-foreground">
                가입한 관리자 이메일을 입력하면 비밀번호 재설정 링크를
                보내드립니다.
              </p>
              <div className="flex flex-col gap-2">
                <Label htmlFor="email">Email</Label>
                <Input
                  id="email"
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  autoComplete="email"
                  required
                />
              </div>
              {errorMessage && (
                <p className="text-sm text-destructive">{errorMessage}</p>
              )}
              <Button type="submit" className="w-full" loading={loading}>
                재설정 메일 보내기
              </Button>
              <Link
                href="/login"
                className="text-center text-sm text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
              >
                로그인 화면으로 돌아가기
              </Link>
            </form>
          )}
        </CardContent>
      </Card>
    </main>
  );
}
