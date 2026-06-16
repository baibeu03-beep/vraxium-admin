# 카페 크롤러 운영 스크립트 공용 헬퍼 (Windows / PowerShell)
#   ⚠ 시크릿·네이버 비밀번호는 어떤 경우에도 출력하지 않는다(길이/존재 여부만 표시).
#   다른 스크립트에서 점(.) 소싱:  . "$PSScriptRoot\_common-windows.ps1"

$ErrorActionPreference = "Stop"

# repo 루트(= crawler 의 부모).
function Get-RepoRoot {
  return (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
}

# .env.local 에서 키 값 1개 추출(없으면 $null). 값은 호출부가 출력하지 않도록 주의.
function Get-EnvValue {
  param([Parameter(Mandatory = $true)][string]$Key)
  $envPath = Join-Path (Get-RepoRoot) ".env.local"
  if (-not (Test-Path $envPath)) { return $null }
  foreach ($line in Get-Content $envPath) {
    if ($line -match "^\s*$([regex]::Escape($Key))\s*=\s*(.+?)\s*$") {
      return $Matches[1].Trim('"').Trim("'")
    }
  }
  return $null
}

# 크롤러 포트(.env.local 의 CAFE_CRAWLER_PORT, 기본 8787). 인자 우선.
function Get-CrawlerPort {
  param([int]$Port = 0)
  if ($Port -gt 0) { return $Port }
  $p = Get-EnvValue "CAFE_CRAWLER_PORT"
  if ([string]::IsNullOrWhiteSpace($p)) { return 8787 }
  return [int]$p
}

# 시크릿 해소: 인자 우선 → .env.local. (반환값은 절대 로그 금지)
function Resolve-CrawlerSecret {
  param([string]$Secret = "")
  if (-not [string]::IsNullOrWhiteSpace($Secret)) { return $Secret }
  return (Get-EnvValue "CAFE_CRAWLER_SECRET")
}

function Get-CrawlerBase {
  param([int]$Port = 0)
  return "http://localhost:$(Get-CrawlerPort -Port $Port)"
}
