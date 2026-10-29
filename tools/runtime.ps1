# tools/runtime.ps1 — resolves the Node.js executable used by build.ps1 and
# package.ps1.
#
# Resolution order:
#   1. KE_NODE (explicit override, also set by package.ps1 for its child)
#   2. node.exe on PATH (normal developer/CI install)
#   3. TSC_NODE (legacy override)
#
# Dot-source it:  . "$PSScriptRoot\tools\runtime.ps1"

function Resolve-KeNode {
  if ($env:KE_NODE -and (Test-Path -LiteralPath $env:KE_NODE)) {
    return (Resolve-Path -LiteralPath $env:KE_NODE).Path
  }

  $onPath = Get-Command node -ErrorAction SilentlyContinue
  if ($onPath) { return $onPath.Source }

  if ($env:TSC_NODE -and (Test-Path -LiteralPath $env:TSC_NODE)) {
    return (Resolve-Path -LiteralPath $env:TSC_NODE).Path
  }

  throw "Node.js not found. Install Node.js 20+ (https://nodejs.org), then run: npm ci"
}
