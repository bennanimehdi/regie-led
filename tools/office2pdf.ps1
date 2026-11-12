# Régie LED — convertit un document Word ou Excel en PDF sous Windows (automation COM d'Office).
#   powershell -NoProfile -ExecutionPolicy Bypass -File tools\office2pdf.ps1 <word|excel> <fichier source> <fichier PDF>
# La régie lit ensuite ce PDF elle-même (pdf.js) et en fait une image par page.
# Ouvre le fichier en lecture seule, sans fenêtre, et referme l'application seulement si c'est ce script qui l'a lancée.
param([Parameter(Mandatory = $true)][string]$Kind, [Parameter(Mandatory = $true)][string]$File, [Parameter(Mandatory = $true)][string]$Pdf)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.Encoding]::UTF8
function Fail($msg) { [Console]::Error.WriteLine($msg); exit 1 }

$File = [IO.Path]::GetFullPath($File); $Pdf = [IO.Path]::GetFullPath($Pdf)
$app = $null; $mine = $false
try {
  if ($Kind -eq 'word') {
    try { $app = [Runtime.InteropServices.Marshal]::GetActiveObject('Word.Application') } catch { }
    if (-not $app) { try { $app = New-Object -ComObject Word.Application; $mine = $true } catch { Fail 'Word introuvable : 80040154' } }
    $app.DisplayAlerts = 0
    $doc = $app.Documents.Open($File, $false, $true, $false)              # ConfirmConversions=non, ReadOnly=oui, AddToRecentFiles=non
    try { $doc.ExportAsFixedFormat($Pdf, 17) }                             # 17 = wdExportFormatPDF
    finally { $doc.Close(0); if ($mine) { $app.Quit() } }
  } elseif ($Kind -eq 'excel') {
    try { $app = [Runtime.InteropServices.Marshal]::GetActiveObject('Excel.Application') } catch { }
    if (-not $app) { try { $app = New-Object -ComObject Excel.Application; $mine = $true } catch { Fail 'Excel introuvable : 80040154' } }
    $app.DisplayAlerts = $false
    $wb = $app.Workbooks.Open($File, 0, $true)                             # UpdateLinks=non, ReadOnly=oui
    try { $wb.ExportAsFixedFormat(0, $Pdf) }                               # 0 = xlTypePDF : tout le classeur
    finally { $wb.Close($false); if ($mine) { $app.Quit() } }
  } else { Fail "Type inconnu : $Kind" }
  if (-not (Test-Path $Pdf)) { Fail 'Aucun PDF produit.' }
  Write-Output 'ok'
} catch {
  Fail $_.Exception.Message
}
