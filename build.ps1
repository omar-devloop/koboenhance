# build.ps1 — compiles the TypeScript sources in-place to the .js files the
# Manifest V3 extension loads. Emits next to each .ts so the manifest paths
# stay unchanged; type errors are reported but emission still happens, so the
# extension always remains loadable.
#
# The toolchain is pinned by package.json: run `npm ci` once, then this script
# uses node_modules/typescript. (Set TSC_JS / KE_NODE to override.)
param()

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
. (Join-Path $root "tools\runtime.ps1")

$node = Resolve-KeNode
$localTsc = Join-Path $root "node_modules\typescript\lib\tsc.js"
$tscJs = if ($env:TSC_JS) { $env:TSC_JS } elseif (Test-Path -LiteralPath $localTsc) { $localTsc } else { $null }

if (-not $tscJs -or -not (Test-Path -LiteralPath $tscJs)) {
  throw "TypeScript not installed. Run: npm ci"
}

Push-Location $root
try {
  & $node $tscJs --noEmitOnError false
  exit $LASTEXITCODE
} finally {
  Pop-Location
}
