param(
    [Parameter(Mandatory = $true)]
    [string] $AudioPath,

    [Parameter(Mandatory = $true)]
    [string] $GrammarPath,

    [Parameter(Mandatory = $true)]
    [string] $RecognizerId
)

$ErrorActionPreference = "Stop"

try {
    Add-Type -AssemblyName System.Speech

    $recognizerInfo = [System.Speech.Recognition.SpeechRecognitionEngine]::InstalledRecognizers() |
        Where-Object { $_.Id -eq $RecognizerId } |
        Select-Object -First 1
    if ($null -eq $recognizerInfo) {
        throw "Windows speech recognizer '$RecognizerId' is not installed."
    }

    [string[]] $phrases = Get-Content -LiteralPath $GrammarPath -Raw | ConvertFrom-Json
    if ($phrases.Count -eq 0) {
        throw "The command grammar is empty."
    }

    $recognizer = [System.Speech.Recognition.SpeechRecognitionEngine]::new($recognizerInfo)
    try {
        $choices = [System.Speech.Recognition.Choices]::new()
        $choices.Add($phrases)
        $builder = [System.Speech.Recognition.GrammarBuilder]::new($choices)
        $builder.Culture = $recognizerInfo.Culture
        $grammar = [System.Speech.Recognition.Grammar]::new($builder)
        $recognizer.LoadGrammar($grammar)
        $recognizer.SetInputToWaveFile($AudioPath)

        $result = $recognizer.Recognize()
        if ($null -eq $result) {
            @{ status = "no_match" } | ConvertTo-Json -Compress
        }
        else {
            @{
                status = "success"
                text = $result.Text
                confidence = $result.Confidence
            } | ConvertTo-Json -Compress
        }
    }
    finally {
        if ($null -ne $recognizer) {
            $recognizer.Dispose()
        }
    }
}
catch {
    @{
        status = "error"
        error = $_.Exception.Message
    } | ConvertTo-Json -Compress
    exit 1
}
