param(
    [Parameter(Mandatory = $true)]
    [string]$ProjectPath,

    [Parameter(Mandatory = $true)]
    [string]$PromptPath,

    [Parameter(Mandatory = $true)]
    [string]$OutputPath
)

$ErrorActionPreference = 'Stop'

$resolvedProject = (Resolve-Path -LiteralPath $ProjectPath).Path
$resolvedPrompt = (Resolve-Path -LiteralPath $PromptPath).Path
$resolvedSchema = (Resolve-Path -LiteralPath (Join-Path $resolvedProject 'updates\public-update-output-schema.json')).Path
$resolvedOutputParent = (Resolve-Path -LiteralPath (Split-Path -Parent $OutputPath)).Path
$resolvedOutput = Join-Path $resolvedOutputParent (Split-Path -Leaf $OutputPath)

function Get-RelativePathCompat {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Root,

        [Parameter(Mandatory = $true)]
        [string]$Candidate
    )

    $method = [System.IO.Path].GetMethod(
        'GetRelativePath',
        [type[]]@([string], [string])
    )
    if ($null -ne $method) {
        return [string]$method.Invoke($null, @($Root, $Candidate))
    }

    $separator = [System.IO.Path]::DirectorySeparatorChar
    $rootWithSeparator = $Root.TrimEnd(
        [System.IO.Path]::DirectorySeparatorChar,
        [System.IO.Path]::AltDirectorySeparatorChar
    ) + $separator
    $rootUri = New-Object System.Uri($rootWithSeparator)
    $candidateUri = New-Object System.Uri($Candidate)
    $relativeUri = $rootUri.MakeRelativeUri($candidateUri)
    if ($relativeUri.IsAbsoluteUri) {
        return $Candidate
    }
    return [System.Uri]::UnescapeDataString($relativeUri.ToString()).Replace('/', $separator)
}

function Test-PathInsideProject {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Root,

        [Parameter(Mandatory = $true)]
        [string]$Candidate
    )

    $relative = Get-RelativePathCompat -Root $Root -Candidate $Candidate
    return -not [System.IO.Path]::IsPathRooted($relative) -and $relative -notmatch '^\.\.(?:[\\/]|$)'
}

if (-not (Test-PathInsideProject -Root $resolvedProject -Candidate $resolvedPrompt)) {
    throw 'PromptPath must be inside ProjectPath.'
}
if (-not (Test-PathInsideProject -Root $resolvedProject -Candidate $resolvedOutput)) {
    throw 'OutputPath must be inside ProjectPath.'
}
if (Test-Path -LiteralPath $resolvedOutput) {
    throw 'OutputPath must not already exist.'
}

$prompt = Get-Content -LiteralPath $resolvedPrompt -Raw -Encoding UTF8
$outputInstruction = "`nReturn only the final JSON object. The wrapper captures the final response at the explicit output path: $resolvedOutput`nThe sandbox is read-only. Do not attempt to create, edit, rename, or delete any project file; do not create a scheduled task; do not access logged-in BOSS pages."
$fullPrompt = $prompt + $outputInstruction

$codexNpmShim = if ($env:APPDATA) {
    Join-Path $env:APPDATA 'npm\codex.cmd'
} else {
    $null
}
if ($codexNpmShim -and (Test-Path -LiteralPath $codexNpmShim -PathType Leaf)) {
    $codexSource = $codexNpmShim
} else {
    $codexCommand = Get-Command codex -CommandType Application -ErrorAction Stop |
        Select-Object -First 1
    $codexSource = $codexCommand.Source
}
$arguments = @(
    'exec',
    '--skip-git-repo-check',
    '--sandbox', 'read-only',
    '-C', $resolvedProject,
    '--ephemeral',
    '--output-schema', $resolvedSchema,
    '--output-last-message', $resolvedOutput,
    $fullPrompt
)

& $codexSource @arguments
if ($LASTEXITCODE -ne 0) {
    throw "Codex exited with code $LASTEXITCODE."
}
if (-not (Test-Path -LiteralPath $resolvedOutput -PathType Leaf)) {
    throw 'Codex did not create the candidate JSON file.'
}
if ((Get-Item -LiteralPath $resolvedOutput).Length -eq 0) {
    throw 'Codex created an empty candidate file.'
}
