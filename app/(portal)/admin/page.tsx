import HomeLaunchGrid from "@/components/admin/HomeLaunchGrid";
import AdminHelp from "@/components/admin/AdminHelp";

// /admin HOME 안내 화면.
// 기존 대시보드(카드/통계/차트)는 노출하지 않는다 — UI 교체 작업 (백엔드/DTO/snapshot 무관).
// 데스크톱 관리자 화면 기준 "안내문" 레이아웃 — 큰 본문 크기·넉넉한 문단 간격·중앙 정렬.
export default function AdminHomePage() {
  return (
    <>
      <div className="flex justify-end">
        <AdminHelp />
      </div>
      {/* 홈 콘텐츠 공통 컨테이너: 좌우 여백을 줄이되 과도하게 넓지 않은 중간 폭(6xl≈1152px).
          w-full 로 넓은 화면일수록 자연스럽게 확장하고, 그 위에서는 max-w 로 상한만 둔다.
          아래 세 영역(안내 문구 / 주의 박스 / 진입 카드 그리드)은 모두 이 한 컨테이너 폭을
          공통 기준으로 사용해 좌우 시작/끝 라인이 정렬된다 — 개별 섹션에 별도 max-width 를 두지 않는다. */}
      <div className="mx-auto flex min-h-[78vh] w-full max-w-6xl flex-col justify-center gap-14 px-8 py-16">
      <section className="flex flex-col gap-7 text-center">
        <p className="text-xl leading-10 text-foreground">
          본 시스템은 ‘전국청춘성장 클럽- 기업/실무자 관리 후원회 (BlackSmith)’
          에서,
        </p>
        <p className="text-xl leading-10 text-foreground">
          각 클럽 크루들의 성장을 지원하고, 시스템과 데이터베이스 유지/보수,
          기능 관리를 후원하고 있습니다.
        </p>
        <p className="py-4 text-3xl font-bold leading-relaxed tracking-tight text-foreground md:text-4xl">
          “대한민국 최고의 인재들이,
          <br className="hidden md:block" /> 클럽에서 무럭무럭 성장할 수
          있도록!”
        </p>
        <p className="text-xl leading-10 text-foreground">
          많은 관리자와 선배 크루, 후원사 담당자 분들의 노고와 후원에 깊히
          감사드립니다. 😊
        </p>
      </section>

      <section className="flex flex-col gap-7 rounded-xl border border-red-200 bg-red-50/60 px-10 py-9 dark:border-red-900/50 dark:bg-red-950/20">
        <p className="text-[19px] font-bold leading-9 text-red-600 dark:text-red-400">
          (주의!) 본 관리 시스템과 계정은 다수의 후원사에서 감독/검수를 통해
          관리하는 시스템으로서, 클럽 크루들의 성장을 신뢰성 있게 집계하는 데에
          그 목적을 두고 있습니다. 본 시스템을 사용하는 모든 분들이 각자 주어진
          권한 안에서 보안 상 이상이 없도록 철저하게 유의해주시기 바라며,
          부득이한 보안 상 문제, 유출, 임의의 사고가 발생할 경우 필요한 법적
          조처가 진행될 수 있음을 명시드립니다.
        </p>
        <p className="text-[19px] font-bold leading-9 text-red-600 dark:text-red-400">
          (주의!) 만약 보안 유출과 관련된 위험 가능성이 생긴 경우, 해당
          관리자에게 즉각적으로 알려 피해를 최소화 해주셔야 합니다.
        </p>
        <p className="text-[17px] leading-8 text-muted-foreground">
          ex) 공공 디바이스에서 로그인 후 그대로 유지된 상태, 비밀번호가 본인
          외에 타인이 알게 된 상태 등
        </p>
      </section>

      <HomeLaunchGrid />
      </div>
    </>
  );
}
