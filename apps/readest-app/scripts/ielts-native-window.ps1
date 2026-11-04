param(
    [Parameter(Mandatory)][int]$ProcessId,
    [Parameter(Mandatory)][ValidateSet('List','Close','AltF4')][string]$Action
)
$ErrorActionPreference = 'Stop'
Add-Type @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
public sealed class TrialWindowInfo {
  public long Handle;
  public string ClassName;
  public string Title;
  public bool Visible;
  public long Owner;
}
public static class TrialNativeWindow {
  public delegate bool EnumProc(IntPtr hwnd, IntPtr data);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc callback, IntPtr data);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetWindowText(IntPtr hwnd, StringBuilder text, int size);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetClassName(IntPtr hwnd, StringBuilder text, int size);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr hwnd);
  [DllImport("user32.dll")] static extern IntPtr GetWindow(IntPtr hwnd, uint flags);
  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr hwnd, uint message, IntPtr key, IntPtr flags);
  public static TrialWindowInfo[] List(uint expected) {
    var result = new List<TrialWindowInfo>();
    EnumWindows((hwnd, data) => {
      uint pid;
      GetWindowThreadProcessId(hwnd, out pid);
      if(pid != expected) return true;
      var title = new StringBuilder(1024);
      var cls = new StringBuilder(512);
      GetWindowText(hwnd, title, title.Capacity);
      GetClassName(hwnd, cls, cls.Capacity);
      result.Add(new TrialWindowInfo {
        Handle=hwnd.ToInt64(), ClassName=cls.ToString(), Title=title.ToString(),
        Visible=IsWindowVisible(hwnd), Owner=GetWindow(hwnd, 4).ToInt64()
      });
      return true;
    }, IntPtr.Zero);
    return result.ToArray();
  }
}
'@
$app = Get-Process -Id $ProcessId -ErrorAction Stop
$windows = @([TrialNativeWindow]::List($ProcessId))
[pscustomobject]@{
    pid=$ProcessId
    dotNetMainHandle=$app.MainWindowHandle.ToInt64()
    dotNetMainTitle=$app.MainWindowTitle
    windows=$windows
} | ConvertTo-Json -Depth 5 -Compress
if ($Action -eq 'List') { return }
$targets = @($windows | Where-Object {$_.Visible -and $_.ClassName -eq 'Tauri Window'})
if ($targets.Count -ne 1) { throw 'Expected exactly one visible Tauri window for this OS request.' }
$handle = [IntPtr]$targets[0].Handle
if ($Action -eq 'Close') {
    $ok = [TrialNativeWindow]::PostMessage($handle, 0x0010, [IntPtr]::Zero, [IntPtr]::Zero)
} else {
    $down = [TrialNativeWindow]::PostMessage($handle, 0x0104, [IntPtr]0x73, [IntPtr]0x20000001)
    $up = [TrialNativeWindow]::PostMessage($handle, 0x0105, [IntPtr]0x73, [IntPtr]0xE0000001)
    $ok = $down -and $up
}
if (-not $ok) { throw 'The native message could not be posted.' }
[pscustomobject]@{action=$Action;target=$targets[0];posted=$true} |
    ConvertTo-Json -Depth 3 -Compress
