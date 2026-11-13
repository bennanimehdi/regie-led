# Régie LED — pilote le diaporama PowerPoint « en direct » sous Windows (automation COM), équivalent de pptlive.applescript.
#   powershell -NoProfile -ExecutionPolicy Bypass -File tools\pptlive.ps1 open <fichier.pptx>   → ouvre le fichier et lance le diaporama dans une fenêtre
#   powershell ... tools\pptlive.ps1 next | prev | first | pos | stop | park [<fichier.pptx>]
# Avec le fichier, la commande vise le diaporama DE CE FICHIER : si un autre diaporama est ouvert dans PowerPoint, il n'est pas touché
# (avant, « suivant » faisait avancer le premier diaporama ouvert, pas forcément celui de la régie).
# Affiche « position/total/hauteur capturée/haut à rogner » en pixels (ex. « 3/12/751/31 »).
# « park » (fait aussi à l'ouverture) : place la fenêtre du diaporama là où personne ne la voit, MAIS À L'ÉCRAN : Windows ne
# redessine plus une fenêtre sortie de l'écran, et la capture restait figée sur la première diapositive. Elle va donc :
#   - sur l'écran de la sortie (la TV), juste derrière la fenêtre de sortie plein écran (le curseur de la souris, qui serait
#     capturé avec elle, n'y passe pas pendant le show) ;
#   - sans sortie sur un autre écran : sur l'écran principal, sous toutes les autres fenêtres.
# Taille : 1280 px de large en vrais pixels de l'écran visé (Windows l'agrandissait à l'échelle de la TV : 3072 px à 300 %).
# Ne ferme jamais une présentation.
param([Parameter(Mandatory = $true)][string]$Act, [string]$File)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.Encoding]::UTF8

function Fail($msg) { [Console]::Error.WriteLine($msg); exit 1 }

$needWin = ($Act -eq 'open' -or $Act -eq 'park')          # fenêtres Windows : seulement pour placer / mesurer (« suivant » reste rapide)
if ($needWin) {
Add-Type -TypeDefinition @'
using System; using System.Text; using System.Runtime.InteropServices;
public static class RegieWin {
  public delegate bool EnumCb(IntPtr h, IntPtr l);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X, Y; }
  [StructLayout(LayoutKind.Sequential)] public struct MONITORINFO { public int cbSize; public RECT rcMonitor, rcWork; public int dwFlags; }
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumCb cb, IntPtr l);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint f);
  [DllImport("user32.dll")] public static extern bool GetClientRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool ClientToScreen(IntPtr h, ref POINT p);
  [DllImport("user32.dll")] public static extern IntPtr MonitorFromWindow(IntPtr h, uint f);
  [DllImport("user32.dll")] public static extern bool GetMonitorInfo(IntPtr m, ref MONITORINFO mi);
  [DllImport("user32.dll")] public static extern IntPtr SetThreadDpiAwarenessContext(IntPtr v);
  [DllImport("dwmapi.dll")] public static extern int DwmGetWindowAttribute(IntPtr h, int a, out RECT r, int size);
  /** Première fenêtre visible dont le titre contient tous les mots (pid = 0 : n'importe quel processus). */
  public static IntPtr Find(uint pid, string[] words) {
    IntPtr found = IntPtr.Zero;
    EnumWindows((h, l) => {
      if (!IsWindowVisible(h)) return true;
      uint p; GetWindowThreadProcessId(h, out p);
      if (pid != 0 && p != pid) return true;
      var sb = new StringBuilder(512); GetWindowText(h, sb, 512); var t = sb.ToString();
      foreach (var w in words) if (t.IndexOf(w, StringComparison.OrdinalIgnoreCase) < 0) return true;
      found = h; return false;
    }, IntPtr.Zero);
    return found;
  }
  /** Zone réellement capturée (sans les bordures invisibles de Windows 10/11). */
  public static RECT Frame(IntPtr h) { RECT r; DwmGetWindowAttribute(h, 9, out r, Marshal.SizeOf(typeof(RECT))); return r; }
  public static RECT Monitor(IntPtr h, out bool primary) { var mi = new MONITORINFO(); mi.cbSize = Marshal.SizeOf(mi); GetMonitorInfo(MonitorFromWindow(h, 2), ref mi); primary = (mi.dwFlags & 1) != 0; return mi.rcMonitor; }
}
'@
# Vrais pixels de chaque écran (sinon Windows « virtualise » les coordonnées selon la mise à l'échelle de l'écran principal).
$null = [RegieWin]::SetThreadDpiAwarenessContext([IntPtr](-4))
}

try {
  $app = $null
  try { $app = [Runtime.InteropServices.Marshal]::GetActiveObject('PowerPoint.Application') } catch { }
  if (-not $app) {
    if ($Act -ne 'open') { Fail 'aucun diaporama en cours' }
    try { $app = New-Object -ComObject PowerPoint.Application } catch { Fail 'PowerPoint introuvable : 80040154' }
  }
  $name = if ($File) { [IO.Path]::GetFileName($File) } else { $null }

  # Diaporama de ce fichier (sinon, ancien comportement : le premier diaporama ouvert).
  function ShowOf() {
    foreach ($w in $app.SlideShowWindows) { if (-not $name -or $w.Presentation.Name -eq $name) { return $w } }
    return $null
  }

  if ($Act -eq 'open') {
    if (-not $File) { Fail 'fichier manquant' }
    $File = [IO.Path]::GetFullPath($File)
    if (-not (ShowOf)) {                                                     # déjà en diaporama : on le reprend tel quel
      $pres = $null
      foreach ($p in $app.Presentations) { if ($p.Name -eq $name) { $pres = $p } }
      if (-not $pres) { $pres = $app.Presentations.Open($File, 0, 0, -1) }   # ReadOnly=non, Untitled=non, WithWindow=oui
      $settings = $pres.SlideShowSettings
      $settings.ShowType = 2                                                 # ppShowTypeWindow : diaporama dans une fenêtre
      $settings.ShowWithAnimation = -1
      $settings.ShowWithNarration = -1
      $null = $settings.Run()
      Start-Sleep -Milliseconds 800
    }
  }

  $win = ShowOf
  if (-not $win) { Fail 'aucun diaporama en cours' }
  $view = $win.View
  try { $view.PointerType = 3 } catch { }                                    # ppSlideShowPointerAlwaysHidden

  # Fenêtre Windows du diaporama : titre « Diaporama PowerPoint - <nom sans extension> - … » (« PowerPoint Slide Show » en anglais).
  $pp = Get-Process POWERPNT -ErrorAction SilentlyContinue | Select-Object -First 1
  $base = [IO.Path]::GetFileNameWithoutExtension($win.Presentation.Name)
  $hs = [IntPtr]::Zero
  foreach ($kw in 'Diaporama', 'Slide Show') { if ($needWin -and $hs -eq [IntPtr]::Zero -and $pp) { $hs = [RegieWin]::Find([uint32]$pp.Id, @($kw, $base)) } }

  if (($Act -eq 'open' -or $Act -eq 'park') -and $hs -ne [IntPtr]::Zero) {
    # Fenêtre de sortie principale de la régie (« Régie LED — Sortie ») : on se glisse juste derrière elle, sur son écran.
    $ho = [RegieWin]::Find(0, @('LED', 'Sortie'))
    $after = [IntPtr]1                                                       # HWND_BOTTOM : sous toutes les fenêtres
    $outPrimary = $true
    if ($ho -ne [IntPtr]::Zero) { $mon = [RegieWin]::Monitor($ho, [ref]$outPrimary) }
    if ($ho -ne [IntPtr]::Zero -and -not $outPrimary) { $after = $ho }
    else { $mon = [RegieWin]::Monitor($hs, [ref]$outPrimary) }               # pas de sortie sur un autre écran : écran actuel
    $W = [Math]::Min(1280, $mon.R - $mon.L); $H = [Math]::Round($W * 9 / 16) + 40
    $x = $mon.L; $y = $mon.T
    if ($after -eq [IntPtr]1) { $x = $mon.R - $W; $y = [Math]::Max($mon.T, $mon.B - $H - 48) }   # écran principal : coin bas-droit, au-dessus de la barre des tâches
    # Deux fois : en changeant d'écran, Windows redimensionne la fenêtre à l'échelle du nouvel écran (WM_DPICHANGED).
    # 0x0010 = SWP_NOACTIVATE : la régie garde la main.
    $null = [RegieWin]::SetWindowPos($hs, $after, $x, $y, $W, $H, 0x0010); Start-Sleep -Milliseconds 300
    $null = [RegieWin]::SetWindowPos($hs, $after, $x, $y, $W, $H, 0x0010); Start-Sleep -Milliseconds 200
    # Puis la zone de la diapositive (zone client) exactement en 16/9 : la barre de titre grandit avec l'échelle de l'écran.
    $c = New-Object RegieWin+RECT; $null = [RegieWin]::GetClientRect($hs, [ref]$c)
    $cw = $c.R - $c.L; $ch = $c.B - $c.T
    if ($cw -gt 0 -and $ch -gt 0) {
      $W2 = $W + ($W - $cw); $H2 = $H + ([Math]::Round($cw * 9 / 16) - $ch)
      if ($after -eq [IntPtr]1) { $x = $mon.R - $W2; $y = [Math]::Max($mon.T, $mon.B - $H2 - 48) }
      $null = [RegieWin]::SetWindowPos($hs, $after, $x, $y, $W2, $H2, 0x0010)
    }
  } elseif ($Act -eq 'next') { $view.Next() }
  elseif ($Act -eq 'prev') { $view.Previous() }
  elseif ($Act -eq 'first') { $view.First() }
  elseif ($Act -eq 'stop') { $view.Exit(); Write-Output '0/0'; exit 0 }

  $total = $win.Presentation.Slides.Count
  # Rognage : de la zone capturée (cadre visible) on retire la barre de titre, jusqu'au haut de la zone client (la diapositive).
  $h = 0; $cap = 0
  if ($hs -ne [IntPtr]::Zero) {
    $f = [RegieWin]::Frame($hs); $pt = New-Object RegieWin+POINT; $null = [RegieWin]::ClientToScreen($hs, [ref]$pt)
    $h = $f.B - $f.T; $cap = [Math]::Max(0, $pt.Y - $f.T)
  }
  Write-Output ("{0}/{1}/{2}/{3}" -f $view.CurrentShowPosition, $total, $h, $cap)
} catch {
  # La ligne fautive du script, pour le journal de la régie (l'erreur seule ne dit pas où elle s'est produite).
  Fail ("{0} [commande {1}, ligne {2}]" -f $_.Exception.Message, $Act, $_.InvocationInfo.ScriptLineNumber)
}
