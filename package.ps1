# package.ps1 — builds the Chrome Web Store upload zip.
#
# Ships ONLY what the extension loads: manifest.json, the emitted .js files,
# icons and the popup. TypeScript sources (.ts), documentation (.md), any CSV
# export of a real account (.csv) and these build scripts (.ps1) must never
# reach the package. The checks live in tools/package.mjs so CI can run them
# on any OS; this file is the Windows convenience wrapper.
#
# Usage:
#   powershell -NoProfile -ExecutionPolicy Bypass -File package.ps1
#   powershell -NoProfile -ExecutionPolicy Bypass -File package.ps1 -SkipBuild
#
# Produces dist/KoboEnhance-<version>.zip.
[CmdletBinding()]
param(
  [switch]$SkipBuild
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
. (Join-Path $root "tools\runtime.ps1")

$node = Resolve-KeNode
$env:KE_NODE = $node

Push-Location $root
try {
  if (-not $SkipBuild) {
    & powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $root "build.ps1")
    if ($LASTEXITCODE -ne 0) { throw "build.ps1 exited $LASTEXITCODE" }
  }

  & $node (Join-Path $root "tools\package.mjs")
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
} finally {
  Pop-Location
}
