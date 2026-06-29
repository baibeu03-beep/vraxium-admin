import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";

export default function HomePage() {
  return (
    <main className="flex min-h-screen flex-1 items-center justify-center bg-muted/40 px-6">
      <Card className="w-full max-w-md">
        <CardContent className="flex flex-col gap-6 p-8">
          <div>
            <p className="text-sm text-muted-foreground">Vraxium Admin</p>
            <h1 className="mt-2 text-3xl font-semibold tracking-tight">
              Cluv Crew Care Page
            </h1>
          </div>
          <Button
            render={<Link href="/login" />}
            nativeButton={false}
            className="w-full"
          >
            로그인
          </Button>
        </CardContent>
      </Card>
    </main>
  );
}
