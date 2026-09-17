$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent $PSScriptRoot
$signingDir = Join-Path $env:LOCALAPPDATA 'SirverData\signing'
$keystore = Join-Path $signingDir 'sirverdata-android-release.p12'
$protectedPassword = Join-Path $signingDir 'password.dpapi'
$properties = Join-Path $repoRoot 'src-tauri\gen\android\keystore.properties'
$ndk = Join-Path $env:ANDROID_HOME 'ndk\28.2.13676358'

foreach ($required in @($keystore, $protectedPassword, (Join-Path $ndk 'source.properties'))) {
  if (-not (Test-Path -LiteralPath $required)) {
    throw "Required local Android signing/build file is missing: $required"
  }
}
if (Test-Path -LiteralPath $properties) {
  throw "Refusing to overwrite an existing signing properties file: $properties"
}

$protectedText = (Get-Content -LiteralPath $protectedPassword -Raw).Trim()
$secure = ConvertTo-SecureString $protectedText
$pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
try {
  $password = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer)
  $escapedStore = $keystore.Replace('\', '/')
  [IO.File]::WriteAllText(
    $properties,
    "storeFile=$escapedStore`nkeyAlias=sirverdata-release`npassword=$password`n",
    [Text.UTF8Encoding]::new($false)
  )
  $env:NDK_HOME = $ndk
  Push-Location $repoRoot
  try {
    & npm.cmd run build:android:release
    if ($LASTEXITCODE -ne 0) { throw "Tauri Android release build failed with exit code $LASTEXITCODE" }
  } finally {
    Pop-Location
  }
} finally {
  if (Test-Path -LiteralPath $properties) { Remove-Item -LiteralPath $properties -Force }
  if ($pointer -ne [IntPtr]::Zero) { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer) }
  $password = $null
  $secure = $null
}
