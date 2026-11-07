param(
  [Parameter(Mandatory=$true)][int]$OwnedProcessId,
  [Parameter(Mandatory=$true)][string]$ExpectedExe,
  [ValidateSet('Inspect','Normal','Maximize')][string]$Action='Inspect',
  [int]$Width=1440,
  [int]$Height=1000
)
$ErrorActionPreference = 'Stop'
$mrwProcess = Get-Process -Id $OwnedProcessId
if ([IO.Path]::GetFullPath($mrwProcess.Path) -ine [IO.Path]::GetFullPath($ExpectedExe)) {
  throw 'Owned process identity does not match the validation executable'
}
Add-Type @'
using System;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public static class MrwOwnedLayout {
  public delegate bool EnumProc(IntPtr h, IntPtr p);
  [StructLayout(LayoutKind.Sequential)] public struct Rect { public int left, top, right, bottom; }
  [StructLayout(LayoutKind.Sequential)] public struct MonitorInfo {
    public int size; public Rect monitor; public Rect work; public uint flags;
  }
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc callback, IntPtr p);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetWindowText(IntPtr h, StringBuilder text, int max);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetClassName(IntPtr h, StringBuilder text, int max);
  [DllImport("user32.dll")] static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
  [DllImport("user32.dll")] static extern uint GetDpiForWindow(IntPtr h);
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out Rect rect);
  [DllImport("user32.dll")] static extern bool GetClientRect(IntPtr h, out Rect rect);
  [DllImport("user32.dll")] static extern IntPtr MonitorFromWindow(IntPtr h, uint flags);
  [DllImport("user32.dll")] static extern bool GetMonitorInfo(IntPtr monitor, ref MonitorInfo info);
  [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr h, int command);
  [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int width, int height, uint flags);
  public class Snapshot {
    public long handle; public uint processId; public string title; public string className;
    public uint windowDpi; public Rect window; public Rect client; public Rect monitor; public Rect work;
  }
  public static IntPtr Find(uint owned) {
    var windows = new List<IntPtr>();
    EnumWindows((h,p) => {
      uint pid; GetWindowThreadProcessId(h, out pid);
      if (pid == owned && IsWindowVisible(h)) {
        var title = new StringBuilder(512); var type = new StringBuilder(256);
        GetWindowText(h, title, title.Capacity); GetClassName(h, type, type.Capacity);
        if (type.ToString().StartsWith("Chrome_WidgetWin") && title.ToString().Contains("MyResearchWorkbench")) windows.Add(h);
      }
      return true;
    }, IntPtr.Zero);
    if (windows.Count != 1) throw new InvalidOperationException("Expected one visible owned product window, found " + windows.Count);
    return windows[0];
  }
  public static Snapshot Read(uint owned, string action, int width, int height) {
    IntPtr previous = SetThreadDpiAwarenessContext(new IntPtr(-4));
    try {
      IntPtr h = Find(owned);
      uint dpi = GetDpiForWindow(h);
      if (dpi == 0) throw new InvalidOperationException("Owned window DPI is unavailable");
      var info = new MonitorInfo(); info.size = Marshal.SizeOf(typeof(MonitorInfo));
      if (!GetMonitorInfo(MonitorFromWindow(h, 2), ref info)) throw new InvalidOperationException("Owned monitor is unavailable");
      if (action == "Normal") {
        if (width < 400 || height < 300 || width > 4000 || height > 3000) throw new ArgumentOutOfRangeException("window dimensions");
        ShowWindow(h, 9);
        int physicalWidth = Math.Min((int)Math.Round(width * dpi / 96.0), info.work.right - info.work.left - 32);
        int physicalHeight = Math.Min((int)Math.Round(height * dpi / 96.0), info.work.bottom - info.work.top - 32);
        if (!SetWindowPos(h, IntPtr.Zero, info.work.left + 16, info.work.top + 16, physicalWidth, physicalHeight, 0x0004))
          throw new InvalidOperationException("Owned window resize failed");
        SetForegroundWindow(h);
      } else if (action == "Maximize") {
        ShowWindow(h, 3); SetForegroundWindow(h);
      }
      Rect window, client;
      if (!GetWindowRect(h, out window) || !GetClientRect(h, out client)) throw new InvalidOperationException("Owned window bounds unavailable");
      var title = new StringBuilder(512); var type = new StringBuilder(256);
      GetWindowText(h, title, title.Capacity); GetClassName(h, type, type.Capacity);
      return new Snapshot { handle=h.ToInt64(), processId=owned, title=title.ToString(), className=type.ToString(),
        windowDpi=dpi, window=window, client=client, monitor=info.monitor, work=info.work };
    } finally { if (previous != IntPtr.Zero) SetThreadDpiAwarenessContext(previous); }
  }
}
'@
$mrwSnapshot = [MrwOwnedLayout]::Read([uint32]$OwnedProcessId, $Action, $Width, $Height)
$mrwResult = [pscustomobject]@{
  capturedAt=(Get-Date).ToUniversalTime().ToString('o')
  action=$Action
  requested96Dpi=@{width=$Width;height=$Height}
  dimensions='Native physical pixels; Normal requests use 96-DPI units multiplied by GetDpiForWindow and clamped to this monitor work area.'
  snapshot=$mrwSnapshot
}
$mrwJson = ($mrwResult | ConvertTo-Json -Depth 6 -Compress) + [Environment]::NewLine
$mrwBytes = [Text.Encoding]::UTF8.GetBytes($mrwJson)
$mrwStdout = [Console]::OpenStandardOutput()
$mrwStdout.Write($mrwBytes, 0, $mrwBytes.Length)
$mrwStdout.Flush()
