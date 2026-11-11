# Régie LED — pilote le diaporama PowerPoint « en direct » sous Windows (automation COM), équivalent de pptlive.applescript.
#   powershell -NoProfile -ExecutionPolicy Bypass -File tools\pptlive.ps1 open <fichier.pptx>   → ouvre le fichier et lance le diaporama dans une fenêtre
#   powershell ... tools\pptlive.ps1 next | prev | first | pos | stop | park
# Affiche « position/total/hauteur de la fenêtre/hauteur de la barre de titre » (ex. « 3/12/768/31 », même unité pour les deux hauteurs).
# « park » (fait aussi à l'ouverture) : range la fenêtre du diaporama sous le bord bas de l'écran principal, pour que le curseur de la
# souris ne passe jamais dessus (la capture inclut le curseur). Ne ferme jamais une présentation.
param([Parameter(Mandatory = $true)][string]$Act, [string]$File)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.Encoding]::UTF8
Add-Type -AssemblyName System.Windows.Forms

function Fail($msg) { [Console]::Error.WriteLine($msg); exit 1 }

try {
  $app = $null
  try { $app = [Runtime.InteropServices.Marshal]::GetActiveObject('PowerPoint.Application') } catch { }
  if (-not $app) {
    if ($Act -ne 'open') { Fail 'aucun diaporama en cours' }
    try { $app = New-Object -ComObject PowerPoint.Application } catch { Fail 'PowerPoint introuvable : 80040154' }
  }

  if ($Act -eq 'open') {
    if (-not $File) { Fail 'fichier manquant' }
    $File = [IO.Path]::GetFullPath($File)
    $name = [IO.Path]::GetFileName($File)
    $pres = $null
    foreach ($p in $app.Presentations) { if ($p.Name -eq $name) { $pres = $p } }
    if (-not $pres) { $pres = $app.Presentations.Open($File, 0, 0, -1) }     # ReadOnly=non, Untitled=non, WithWindow=oui
    $settings = $pres.SlideShowSettings
    $settings.ShowType = 2                                                   # ppShowTypeWindow : diaporama dans une fenêtre
    $settings.ShowWithAnimation = -1
    $settings.ShowWithNarration = -1
    $null = $settings.Run()
    Start-Sleep -Milliseconds 800
  }

  if ($app.SlideShowWindows.Count -eq 0) { Fail 'aucun diaporama en cours' }
  $win = $app.SlideShowWindows.Item(1)
  $view = $win.View
  try { $view.PointerType = 3 } catch { }                                    # ppSlideShowPointerAlwaysHidden

  # Les tailles de fenêtre PowerPoint sont en points (72 par pouce) ; les écrans en pixels logiques (96 par pouce).
  $pt = 72 / 96
  if ($Act -eq 'open' -or $Act -eq 'park') {
    try {
      $win.Width = 1280 * $pt
      $win.Height = (720 + [Windows.Forms.SystemInformation]::CaptionHeight) * $pt
      $scr = [Windows.Forms.Screen]::PrimaryScreen.Bounds
      $win.Left = [Math]::Max(0, $scr.Width - 1280) * $pt
      $win.Top = ($scr.Height - [Windows.Forms.SystemInformation]::CaptionHeight - 10) * $pt
    } catch { }
  } elseif ($Act -eq 'next') { $view.Next() }
  elseif ($Act -eq 'prev') { $view.Previous() }
  elseif ($Act -eq 'first') { $view.First() }
  elseif ($Act -eq 'stop') { $view.Exit(); Write-Output '0/0'; exit 0 }

  $total = $win.Presentation.Slides.Count
  $h = [Math]::Round($win.Height / $pt)
  $cap = [Windows.Forms.SystemInformation]::CaptionHeight
  Write-Output ("{0}/{1}/{2}/{3}" -f $view.CurrentShowPosition, $total, $h, $cap)
} catch {
  Fail $_.Exception.Message
}
