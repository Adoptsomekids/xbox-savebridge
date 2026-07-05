$ErrorActionPreference = "Stop"

$makeappx = (Get-ChildItem "C:\Program Files (x86)\Windows Kits\10\bin" -Recurse -Filter "makeappx.exe" | Where-Object { $_.FullName -like "*x64*" } | Select-Object -First 1).FullName
if (-not $makeappx) { throw "MakeAppx.exe not found" }
Write-Host "MakeAppx: $makeappx"

$appxPath = "$env:GITHUB_WORKSPACE\SaveBridge_1.0.0.0_x64.appx"

# First: look for a pre-built .appx produced by GenerateAppxPackageOnBuild
$prebuilt = Get-ChildItem "SaveBridge\SaveBridge" -Recurse -Filter "SaveBridge*.appx" -ErrorAction SilentlyContinue `
  | Where-Object { $_.DirectoryName -notlike "*\Dependencies\*" } `
  | Select-Object -First 1

if ($prebuilt) {
    Write-Host "Pre-built APPX found: $($prebuilt.FullName)"
    Copy-Item $prebuilt.FullName $appxPath -Force
} else {
    # MSBuild creates AppPackages\SaveBridge_*_Test\ — the .appx should be in the parent
    # or we need to pack it from the staging layout inside
    $appPackagesDir = "SaveBridge\SaveBridge\AppPackages"
    $testDir = (Get-ChildItem $appPackagesDir -Directory -ErrorAction SilentlyContinue `
      | Where-Object { $_.Name -like "SaveBridge*" } `
      | Select-Object -First 1).FullName

    Write-Host "Test dir: $testDir"

    if ($testDir) {
        # Look for .appx directly inside _Test dir (sometimes MSBuild puts it there)
        $innerAppx = Get-ChildItem $testDir -Filter "SaveBridge*.appx" -ErrorAction SilentlyContinue `
          | Select-Object -First 1
        if ($innerAppx) {
            Write-Host "Inner APPX: $($innerAppx.FullName)"
            Copy-Item $innerAppx.FullName $appxPath -Force
        } else {
            Write-Host "No inner APPX. Assembling layout from bin + assets..."
            $layoutDir = "$env:GITHUB_WORKSPACE\appx_layout"
            New-Item -ItemType Directory -Force -Path $layoutDir | Out-Null
            # Debug build output path
            $binDir = "SaveBridge\SaveBridge\bin\x64\Debug"
            if (-not (Test-Path $binDir)) { $binDir = "SaveBridge\SaveBridge\bin\x64\Release" }
            Copy-Item "$binDir\*" $layoutDir -Recurse -Force -ErrorAction SilentlyContinue
            New-Item -ItemType Directory -Force -Path "$layoutDir\Assets" | Out-Null
            Copy-Item "SaveBridge\SaveBridge\Assets\*" "$layoutDir\Assets\" -Force
            $manifest = (Get-Content "SaveBridge\SaveBridge\Package.appxmanifest" -Raw) -replace '\$targetnametoken\$', 'SaveBridge'
            Set-Content "$layoutDir\AppxManifest.xml" $manifest -Encoding UTF8
            Write-Host "Layout contents:"
            Get-ChildItem $layoutDir | Select-Object Name | Format-Table
            Write-Host "Packing from: $layoutDir"
            & $makeappx pack /d "$layoutDir" /p "$appxPath" /overwrite /nv
            if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
        }
    } else {
        throw "AppPackages directory not found after build"
    }
}

$size = (Get-Item $appxPath).Length
Write-Host "APPX ready: $appxPath ($size bytes)"
"appx_path=$appxPath" | Out-File $env:GITHUB_OUTPUT -Append
