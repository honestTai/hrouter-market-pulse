param(
    [int]$Port = 8787
)

$env:HROUTER_REPORT_PORT = $Port.ToString()
$pluginRoot = Split-Path -Parent $PSScriptRoot
node (Join-Path $pluginRoot 'mcp\server.bundle.mjs')
