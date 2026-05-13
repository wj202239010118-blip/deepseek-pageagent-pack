# Push to GitHub — Helper Script
# 
# Usage: 
#   powershell -ExecutionPolicy Bypass -File push-to-github.ps1
#
# This script creates a new GitHub repository and pushes the local repo.

param(
    [string]$RepoName = "deepseek-pageagent-pack",
    [string]$Description = "DeepSeek TUI + Page Agent AI toolkit — terminal AI coding assistant with browser control",
    [string]$Visibility = "public"
)

$ErrorActionPreference = "Stop"

Write-Host ""
Write-Host "╔══════════════════════════════════════════════════╗" -ForegroundColor Cyan
Write-Host "║  Push DeepSeek + Page Agent to GitHub            ║" -ForegroundColor Cyan
Write-Host "╚══════════════════════════════════════════════════╝" -ForegroundColor Cyan
Write-Host ""

# ─── Check Git ───
Write-Host "[1/4] Checking prerequisites..." -ForegroundColor Yellow
$gitVersion = git --version 2>&1
if ($LASTEXITCODE -ne 0) {
    Write-Host "  ❌ Git not found. Install from https://git-scm.com/" -ForegroundColor Red
    exit 1
}
Write-Host "  ✅ $gitVersion"

# ─── Get GitHub credentials ───
Write-Host ""
Write-Host "[2/4] GitHub authentication..." -ForegroundColor Yellow
Write-Host ""
Write-Host "  To create the repository, you need a GitHub Personal Access Token."
Write-Host "  Create one at: https://github.com/settings/tokens"
Write-Host "  Required permissions: repo (Full control of private repositories)"
Write-Host ""

$Username = Read-Host "  GitHub username"
$Token = Read-Host "  GitHub Personal Access Token" -AsSecureString
$BSTR = [System.Runtime.InteropServices.Marshal]::SecureStringToBSTR($Token)
$TokenPlain = [System.Runtime.InteropServices.Marshal]::PtrToStringAuto($BSTR)
[System.Runtime.InteropServices.Marshal]::ZeroFreeBSTR($BSTR)

if (-not $Username -or -not $TokenPlain) {
    Write-Host "  ❌ Username and token are required." -ForegroundColor Red
    exit 1
}

# ─── Create GitHub repo ───
Write-Host ""
Write-Host "[3/4] Creating GitHub repository '$RepoName'..." -ForegroundColor Yellow

$body = @{
    name        = $RepoName
    description = $Description
    private     = ($Visibility -eq "private")
    auto_init   = $false
} | ConvertTo-Json

$headers = @{
    "Authorization" = "Basic " + [Convert]::ToBase64String([Text.Encoding]::ASCII.GetBytes("${Username}:${TokenPlain}"))
    "Accept"        = "application/vnd.github+json"
}

try {
    $response = Invoke-RestMethod -Uri "https://api.github.com/user/repos" -Method Post -Headers $headers -Body $body -ContentType "application/json"
    Write-Host "  ✅ Repository created: $($response.html_url)" -ForegroundColor Green
} catch {
    if ($_.Exception.Response.StatusCode -eq 422) {
        Write-Host "  ⚠️  Repository already exists, will use existing one." -ForegroundColor Yellow
    } else {
        Write-Host "  ❌ Failed to create repository: $_" -ForegroundColor Red
        exit 1
    }
}

# ─── Push ───
Write-Host ""
Write-Host "[4/4] Pushing to GitHub..." -ForegroundColor Yellow

$remoteUrl = "https://${Username}:${TokenPlain}@github.com/${Username}/${RepoName}.git"

# Add remote (ignore error if already exists)
git remote remove origin 2>$null
git remote add origin $remoteUrl

# Push
git push -u origin master 2>&1
if ($LASTEXITCODE -ne 0) {
    Write-Host "  ❌ Push failed. Check your token permissions and network." -ForegroundColor Red
    # Remove remote with token for safety
    git remote remove origin
    exit 1
}

# Remove remote with token, re-add without token
git remote remove origin
git remote add origin "https://github.com/${Username}/${RepoName}.git"

Write-Host ""
Write-Host "╔══════════════════════════════════════════════════╗" -ForegroundColor Green
Write-Host "║  ✅ Successfully pushed to GitHub!               ║" -ForegroundColor Green
Write-Host "║                                                  ║" -ForegroundColor Green
Write-Host "║  Repository: https://github.com/${Username}/${RepoName}" -ForegroundColor Green
Write-Host "╚══════════════════════════════════════════════════╝" -ForegroundColor Green
Write-Host ""
Write-Host "Next steps for your colleagues:"
Write-Host ""
Write-Host "  1. git clone https://github.com/${Username}/${RepoName}.git"
Write-Host "  2. cd ${RepoName}"
Write-Host "  3. setup.bat"
Write-Host "  4. Edit ~/.deepseek/config.toml → add API key"
Write-Host "  5. deepseek"
Write-Host ""
