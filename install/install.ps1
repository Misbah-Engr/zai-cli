param(
    [string]$Package = (Join-Path $PSScriptRoot 'striking-lions-zc-0.2.0.tgz'),
    [switch]$AddPath
)
$ErrorActionPreference = 'Stop'
$ConfigChanged = $false
$Committed = $false
$PowerShellShimMoved = $false
$Version = '0.2.0'
$NodeVersion = '24.22.0'
$Arch = if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64') { 'arm64' } elseif ($env:PROCESSOR_ARCHITECTURE -eq 'AMD64') { 'x64' } else { throw 'Use an x64 or arm64 Windows host.' }
$Package = (Resolve-Path -LiteralPath $Package).Path
$Base = Join-Path $env:LOCALAPPDATA 'StrikingLions\ZC'
$Bin = Join-Path $env:USERPROFILE '.local\bin'
$EngineName = "node-v$NodeVersion-win-$Arch"
$Engine = Join-Path $Base "engines\$EngineName"
$Node = Join-Path $Engine 'node.exe'
$Npm = Join-Path $Engine 'node_modules\npm\bin\npm-cli.js'
$Stage = Join-Path $Base ('releases\.install-' + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Force -Path $Stage, $Bin, (Join-Path $Base 'engines') | Out-Null
function Check-Exit([string]$Operation) { if ($LASTEXITCODE -ne 0) { throw "$Operation failed with exit code $LASTEXITCODE. Previous installation remains available." } }
try {
    $Manifest = Join-Path $PSScriptRoot 'SHA256SUMS.txt'
    if (Test-Path -LiteralPath $Manifest) {
        $Name = [IO.Path]::GetFileName($Package)
        $Matches = @(Get-Content -LiteralPath $Manifest | Where-Object { $_ -match ('^[a-fA-F0-9]{64}\s+' + [regex]::Escape($Name) + '$') })
        if ($Matches.Count -ne 1) { throw 'Package checksum entry is missing or ambiguous.' }
        $Expected = ($Matches[0] -split '\s+')[0]
        if ((Get-FileHash -Algorithm SHA256 -LiteralPath $Package).Hash -ne $Expected) { throw 'Package checksum mismatch.' }
    }
    if (!(Test-Path -LiteralPath $Node)) {
        [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
        $Zip = Join-Path $Stage 'node.zip'
        Write-Host "Installing an isolated Node $NodeVersion engine. System Node is unchanged."
        Invoke-WebRequest -UseBasicParsing -Uri "https://nodejs.org/dist/v$NodeVersion/$EngineName.zip" -OutFile $Zip
        $Sums = (Invoke-WebRequest -UseBasicParsing -Uri "https://nodejs.org/dist/v$NodeVersion/SHASUMS256.txt").Content
        $Match = @($Sums -split "`n" | Where-Object { $_.Trim() -match ('^[a-fA-F0-9]{64}\s+' + [regex]::Escape("$EngineName.zip") + '$') })
        if ($Match.Count -ne 1) { throw 'Node checksum entry is missing or ambiguous.' }
        $Expected = ($Match[0] -split '\s+')[0]
        if ((Get-FileHash -Algorithm SHA256 -LiteralPath $Zip).Hash -ne $Expected) { throw 'Node checksum mismatch.' }
        Expand-Archive -LiteralPath $Zip -DestinationPath $Stage
        if (Test-Path -LiteralPath $Engine) { throw 'An incomplete engine directory exists. It was not overwritten.' }
        Move-Item -LiteralPath (Join-Path $Stage $EngineName) -Destination $Engine
    }
    if ((& $Node --version) -ne "v$NodeVersion") { throw 'Managed Node version mismatch.' }
    $env:PATH = "$Engine;" + $env:PATH
    & $Node $Npm install --prefix (Join-Path $Stage 'app') --ignore-scripts --no-audit --no-fund --save-exact --registry=https://registry.npmjs.org/ --fetch-retries=3 --fetch-timeout=120000 $Package
    Check-Exit 'Package installation'
    $Entry = Join-Path $Stage 'app\node_modules\@striking-lions\zc\bin\zc.mjs'
    if ((& $Node $Entry --version) -ne $Version) { throw 'Installed ZC version mismatch.' }
    & $Node (Join-Path $Stage 'app\node_modules\@striking-lions\zc\scripts\verify-runtime.mjs')
    Check-Exit 'Runtime validation'
    & $Node $Entry config | Set-Content -Encoding UTF8 -LiteralPath (Join-Path $Stage 'previous-zc-config.json')
    Check-Exit 'Configuration backup'
    $Release = Join-Path $Base ('releases\' + $Version + '-' + [Guid]::NewGuid().ToString('N'))
    Move-Item -LiteralPath $Stage -Destination $Release
    $Entry = Join-Path $Release 'app\node_modules\@striking-lions\zc\bin\zc.mjs'
    $Launcher = Join-Path $Bin 'zc.cmd'
    $Temporary = Join-Path $Bin ('.zc-' + [Guid]::NewGuid().ToString('N') + '.cmd')
    [IO.File]::WriteAllText($Temporary, "@echo off`r`n`"$Node`" `"$Entry`" %*`r`nexit /b %errorlevel%`r`n", [Text.Encoding]::Default)
    if (Test-Path -LiteralPath $Launcher) { Copy-Item -LiteralPath $Launcher -Destination (Join-Path $Release 'previous-launcher.cmd') }
    if (Test-Path -LiteralPath $Launcher -PathType Container) { throw 'Launcher path is a directory. It was not replaced.' }
    # An older npm .ps1 shim can take precedence over the new .cmd launcher.
    $OldPowerShellShim = Join-Path $Bin 'zc.ps1'
    if (Test-Path -LiteralPath $OldPowerShellShim -PathType Leaf) {
        Move-Item -LiteralPath $OldPowerShellShim -Destination (Join-Path $Release 'previous-launcher.ps1')
        $PowerShellShimMoved = $true
    }
    & $Node $Entry config managed
    Check-Exit 'Managed runtime configuration'
    $ConfigChanged = $true
    Move-Item -Force -LiteralPath $Temporary -Destination $Launcher
    $Committed = $true
    if ($AddPath) {
        $Old = [Environment]::GetEnvironmentVariable('Path', 'User')
        if (($Old -split ';') -notcontains $Bin) { [Environment]::SetEnvironmentVariable('Path', "$Bin;$Old", 'User') }
    }
    Write-Host "Installed ZC $Version. Open a new terminal, enter your project, and run zc."
    Write-Host "Use immediately: $Launcher"
    Write-Host 'First account connection: zc login. Existing credentials were not deleted.'
} catch {
    $Failure = $_
    if ($ConfigChanged -and !$Committed) {
        & $Node (Join-Path $Release 'app\node_modules\@striking-lions\zc\scripts\restore-config.mjs') (Join-Path $Release 'previous-zc-config.json')
        if ($LASTEXITCODE -ne 0) { Write-Warning "ZC preferences need manual recovery from $Release\previous-zc-config.json" }
    }
    if ($PowerShellShimMoved -and !$Committed -and !(Test-Path -LiteralPath $OldPowerShellShim)) {
        Move-Item -LiteralPath (Join-Path $Release 'previous-launcher.ps1') -Destination $OldPowerShellShim
    }
    throw $Failure
} finally {
    if (Test-Path -LiteralPath $Stage) { Remove-Item -Recurse -Force -LiteralPath $Stage }
}
