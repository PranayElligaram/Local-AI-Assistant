param(
    [Parameter(Mandatory = $true)]
    [string]$WakePhrase,

    [Parameter(Mandatory = $true)]
    [string]$RecognizerId
)

$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)

$engine = $null
try {
    Add-Type -AssemblyName System.Speech
    $recognizerInfo = [System.Speech.Recognition.SpeechRecognitionEngine]::InstalledRecognizers() |
        Where-Object { $_.Id -eq $RecognizerId } |
        Select-Object -First 1
    if ($null -eq $recognizerInfo) {
        throw "Windows speech recognizer '$RecognizerId' is not installed."
    }

    $engine = [System.Speech.Recognition.SpeechRecognitionEngine]::new($recognizerInfo)
    $choices = [System.Speech.Recognition.Choices]::new()
    $choices.Add([string[]]@($WakePhrase))
    $builder = [System.Speech.Recognition.GrammarBuilder]::new()
    $builder.Culture = $recognizerInfo.Culture
    $builder.Append($choices)
    $engine.LoadGrammar([System.Speech.Recognition.Grammar]::new($builder))
    $engine.SetInputToDefaultAudioDevice()

    while ($true) {
        $result = $engine.Recognize()
        if ($null -eq $result) {
            continue
        }
        @{
            status = "success"
            text = $result.Text
            confidence = [double]$result.Confidence
        } | ConvertTo-Json -Compress | Write-Output
        [Console]::Out.Flush()
    }
}
catch {
    @{
        status = "error"
        error = $_.Exception.Message
    } | ConvertTo-Json -Compress | Write-Output
    [Console]::Out.Flush()
    exit 1
}
finally {
    if ($null -ne $engine) {
        $engine.Dispose()
    }
}
