# Régie LED — exporte les diapositives d'un PowerPoint en images sous Windows (automation COM).
#   powershell -NoProfile -ExecutionPolicy Bypass -File tools\pptexport.ps1 <fichier.pptx> <préfixe de sortie> <largeur px> <nb max de pages> <JPG|PNG>
# Écrit <préfixe>001.jpg, <préfixe>002.jpg… et affiche le nombre d'images écrites. Sert à la vignette (1 page) et à l'import « en images ».
# N'ouvre le fichier qu'en lecture, sans fenêtre, et referme PowerPoint seulement si c'est ce script qui l'a lancé.
param([Parameter(Mandatory = $true)][string]$File, [Parameter(Mandatory = $true)][string]$Prefix, [int]$Width = 1920, [int]$MaxPages = 200, [string]$Format = 'JPG')
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.Encoding]::UTF8
function Fail($msg) { [Console]::Error.WriteLine($msg); exit 1 }

$app = $null; $mine = $false
try {
  try { $app = [Runtime.InteropServices.Marshal]::GetActiveObject('PowerPoint.Application') } catch { }
  if (-not $app) {
    try { $app = New-Object -ComObject PowerPoint.Application; $mine = $true } catch { Fail 'PowerPoint introuvable : 80040154' }
  }
  $File = [IO.Path]::GetFullPath($File)
  $pres = $app.Presentations.Open($File, -1, 0, 0)                           # ReadOnly=oui, Untitled=non, WithWindow=non
  try {
    $w = [Math]::Max(256, [Math]::Min(4096, $Width))
    $h = [Math]::Round($w * $pres.PageSetup.SlideHeight / $pres.PageSetup.SlideWidth)
    $n = [Math]::Min($pres.Slides.Count, $MaxPages)
    $ext = if ($Format -eq 'PNG') { 'png' } else { 'jpg' }
    for ($i = 1; $i -le $n; $i++) {
      $out = '{0}{1:d3}.{2}' -f $Prefix, $i, $ext
      $pres.Slides.Item($i).Export($out, $Format, $w, $h)
    }
    Write-Output $n
  } finally {
    $pres.Close()
    if ($mine -and $app.Presentations.Count -eq 0) { $app.Quit() }
  }
} catch {
  Fail $_.Exception.Message
}
