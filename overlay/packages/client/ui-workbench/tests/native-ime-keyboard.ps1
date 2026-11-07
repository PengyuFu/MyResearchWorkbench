<#
Test-only native keyboard helper for a caller-owned MyResearchWorkbench window.
The caller must supply the launched PID, executable path and HWND. Inspect never changes focus.
Type uses physical scan-code key events, so Windows' active IME receives pinyin.
No Unicode key injection, clipboard paste, DOM event dispatch or global language preference change occurs.
#>
param(
  [Parameter(Mandatory=$true)][uint32]$ExpectedProcessId,
  [Parameter(Mandatory=$true)][string]$ExpectedExecutable,
  [Parameter(Mandatory=$true)][long]$WindowHandle,
  [Parameter(Mandatory=$true)][ValidateSet('Inspect','Focus','Click','Type','Commit','ShiftTap')][string]$Mode,
  [ValidatePattern('^[a-z]*$')][string]$Text = '',
  [string]$ScreenshotPath = '',
  [double]$ClientX = -1,
  [double]$ClientY = -1,
  [double]$ViewportWidth = 0,
  [double]$ViewportHeight = 0
)
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;
public static class MrwNativeIme {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X, Y; }
  public class ClickObservation { public int x,y,clientWidth,clientHeight; public long hitHandle; public uint hitProcessId; }
  [StructLayout(LayoutKind.Sequential)] public struct GUITHREADINFO {
    public uint cbSize, flags;
    public IntPtr hwndActive, hwndFocus, hwndCapture, hwndMenuOwner, hwndMoveSize, hwndCaret;
    public RECT rcCaret;
  }
  [StructLayout(LayoutKind.Sequential)] public struct MOUSEINPUT {
    public int dx, dy;
    public uint mouseData, dwFlags, time;
    public UIntPtr dwExtraInfo;
  }
  [StructLayout(LayoutKind.Sequential)] public struct KEYBDINPUT {
    public ushort wVk, wScan;
    public uint dwFlags, time;
    public UIntPtr dwExtraInfo;
  }
  [StructLayout(LayoutKind.Explicit)] public struct INPUTUNION {
    [FieldOffset(0)] public MOUSEINPUT mouse;
    [FieldOffset(0)] public KEYBDINPUT keyboard;
  }
  [StructLayout(LayoutKind.Sequential)] public struct INPUT { public uint type; public INPUTUNION data; }
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetDpiForWindow(IntPtr hwnd);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hwnd, out RECT rect);
  [DllImport("user32.dll")] public static extern bool GetClientRect(IntPtr hwnd, out RECT rect);
  [DllImport("user32.dll")] public static extern bool ClientToScreen(IntPtr hwnd, ref POINT point);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(POINT point);
  [DllImport("user32.dll")] public static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint processId);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hwnd);
  [DllImport("user32.dll")] public static extern bool GetGUIThreadInfo(uint threadId, ref GUITHREADINFO value);
  [DllImport("user32.dll")] public static extern IntPtr GetKeyboardLayout(uint threadId);
  [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr hwnd, uint flags);
  [DllImport("user32.dll")] public static extern uint MapVirtualKey(uint code, uint kind);
  [DllImport("user32.dll", SetLastError=true)] public static extern uint SendInput(uint count, INPUT[] inputs, int size);
  [DllImport("imm32.dll", CharSet=CharSet.Unicode)] public static extern uint ImmGetDescriptionW(IntPtr hkl, StringBuilder description, uint size);
  [DllImport("imm32.dll", CharSet=CharSet.Unicode)] public static extern uint ImmGetIMEFileNameW(IntPtr hkl, StringBuilder filename, uint size);
  [DllImport("imm32.dll")] public static extern IntPtr ImmGetContext(IntPtr hwnd);
  [DllImport("imm32.dll")] public static extern bool ImmReleaseContext(IntPtr hwnd, IntPtr context);
  [DllImport("imm32.dll")] public static extern bool ImmGetOpenStatus(IntPtr context);
  [DllImport("imm32.dll")] public static extern bool ImmGetConversionStatus(IntPtr context, out uint conversion, out uint sentence);

  public static ClickObservation Click(IntPtr target, uint expected, double x, double y, double viewportWidth, double viewportHeight) {
    if(viewportWidth<=0 || viewportHeight<=0 || x<0 || y<0 || x>=viewportWidth || y>=viewportHeight)
      throw new InvalidOperationException("Native click must be inside the measured renderer viewport.");
    var previous=SetThreadDpiAwarenessContext(new IntPtr(-4));
    try {
      RECT rect; var origin=new POINT();
      if(!GetClientRect(target,out rect) || !ClientToScreen(target,ref origin))
        throw new Win32Exception(Marshal.GetLastWin32Error(),"Cannot measure the owned physical client area.");
      var point=new POINT { X=origin.X+(int)Math.Floor(x*(rect.Right-rect.Left)/viewportWidth),
        Y=origin.Y+(int)Math.Floor(y*(rect.Bottom-rect.Top)/viewportHeight) };
      uint owner;GetWindowThreadProcessId(target,out owner);
      if(owner!=expected || GetForegroundWindow()!=target)
        throw new InvalidOperationException("Native click target lost owned foreground identity.");
      if(!SetCursorPos(point.X,point.Y)) throw new Win32Exception(Marshal.GetLastWin32Error());
      var hit=WindowFromPoint(point);uint hitOwner;GetWindowThreadProcessId(hit,out hitOwner);
      if(GetAncestor(hit,2)!=target || hitOwner!=expected || GetForegroundWindow()!=target)
        throw new InvalidOperationException("Measured editor point is not an owned foreground window descendant.");
      INPUT down=new INPUT { type=0,data=new INPUTUNION { mouse=new MOUSEINPUT { dwFlags=2 } } };
      INPUT up=new INPUT { type=0,data=new INPUTUNION { mouse=new MOUSEINPUT { dwFlags=4 } } };
      if(SendInput(2,new INPUT[]{down,up},Marshal.SizeOf(typeof(INPUT)))!=2)
        throw new Win32Exception(Marshal.GetLastWin32Error(),"Native mouse click was not accepted.");
      return new ClickObservation { x=point.X,y=point.Y,clientWidth=rect.Right-rect.Left,clientHeight=rect.Bottom-rect.Top,
        hitHandle=hit.ToInt64(),hitProcessId=hitOwner };
    } finally { SetThreadDpiAwarenessContext(previous); }
  }

  public static void Key(ushort virtualKey) {
    ushort scan = (ushort)MapVirtualKey(virtualKey, 0);
    if (scan == 0) throw new InvalidOperationException("Virtual key has no scan code.");
    INPUT down = new INPUT { type=1, data=new INPUTUNION { keyboard=new KEYBDINPUT { wScan=scan, dwFlags=8 } } };
    INPUT up = new INPUT { type=1, data=new INPUTUNION { keyboard=new KEYBDINPUT { wScan=scan, dwFlags=10 } } };
    if (SendInput(2, new INPUT[] { down, up }, Marshal.SizeOf(typeof(INPUT))) != 2)
      throw new Win32Exception(Marshal.GetLastWin32Error(), "Native keyboard input was not accepted.");
  }
}
'@

$target = [IntPtr]$WindowHandle
$process = Get-Process -Id $ExpectedProcessId
if (-not [String]::Equals([IO.Path]::GetFullPath($process.Path), [IO.Path]::GetFullPath($ExpectedExecutable), [StringComparison]::OrdinalIgnoreCase)) {
  throw 'PID does not belong to the explicitly selected test executable.'
}
$ownerPid = [uint32]0
$threadId = [MrwNativeIme]::GetWindowThreadProcessId($target, [ref]$ownerPid)
if ($ownerPid -ne $ExpectedProcessId -or $threadId -eq 0) { throw 'HWND does not belong to the explicitly selected test PID.' }

function Assert-TargetForeground {
  if ([MrwNativeIme]::GetForegroundWindow() -ne $target) { throw 'The owned test window lost foreground focus; no further keys are sent.' }
  $currentOwner = [uint32]0
  [void][MrwNativeIme]::GetWindowThreadProcessId($target, [ref]$currentOwner)
  if ($currentOwner -ne $ExpectedProcessId) { throw 'The test HWND changed owner; no further keys are sent.' }
}

$sentKeys = New-Object 'System.Collections.Generic.List[int]'
$nativeClick = $null
if ($Mode -eq 'Focus') {
  [void][MrwNativeIme]::SetForegroundWindow($target)
  Assert-TargetForeground
}
if ($Mode -eq 'Click') {
  Assert-TargetForeground
  $nativeClick = [MrwNativeIme]::Click($target,$ExpectedProcessId,$ClientX,$ClientY,$ViewportWidth,$ViewportHeight)
  Assert-TargetForeground
}
if ($Mode -eq 'Type' -or $Mode -eq 'Commit' -or $Mode -eq 'ShiftTap') {
  Assert-TargetForeground
  $virtualKeys = @()
  if ($Mode -eq 'Type') {
    if ($Text.Length -eq 0) { throw 'Type requires nonempty lowercase pinyin.' }
    $virtualKeys = @($Text.ToUpperInvariant().ToCharArray() | ForEach-Object { [int][char]$_ })
  } elseif ($Mode -eq 'Commit') {
    $virtualKeys = @(32)
  } else {
    # The native IME receives the shift tap; its resulting input mode must be observed by the caller.
    $virtualKeys = @(16)
  }
  foreach ($key in $virtualKeys) {
    Assert-TargetForeground
    [MrwNativeIme]::Key([uint16]$key)
    $sentKeys.Add($key)
  }
  Assert-TargetForeground
}

$gui = New-Object MrwNativeIme+GUITHREADINFO
$gui.cbSize = [Runtime.InteropServices.Marshal]::SizeOf($gui)
$guiAvailable = [MrwNativeIme]::GetGUIThreadInfo($threadId, [ref]$gui)
$imeWindow = if ($guiAvailable -and $gui.hwndFocus -ne [IntPtr]::Zero) { $gui.hwndFocus } else { $target }
$imeContext = [MrwNativeIme]::ImmGetContext($imeWindow)
$ime = $null
if ($imeContext -ne [IntPtr]::Zero) {
  try {
    $conversion = [uint32]0
    $sentence = [uint32]0
    $conversionAvailable = [MrwNativeIme]::ImmGetConversionStatus($imeContext, [ref]$conversion, [ref]$sentence)
    $ime = [ordered]@{
      open = [MrwNativeIme]::ImmGetOpenStatus($imeContext)
      conversionAvailable = $conversionAvailable; conversion = $conversion; sentence = $sentence
    }
  } finally { [void][MrwNativeIme]::ImmReleaseContext($imeWindow, $imeContext) }
}
$layout = [MrwNativeIme]::GetKeyboardLayout($threadId)
$description = New-Object Text.StringBuilder 512
$imeFilename = New-Object Text.StringBuilder 512
[void][MrwNativeIme]::ImmGetDescriptionW($layout, $description, 512)
[void][MrwNativeIme]::ImmGetIMEFileNameW($layout, $imeFilename, 512)
$screenshot = $null
if ($ScreenshotPath.Length -gt 0) {
  Assert-TargetForeground
  if ([IO.File]::Exists($ScreenshotPath)) { throw 'Refuse to overwrite an existing native screenshot.' }
  if (-not [IO.Directory]::Exists([IO.Path]::GetDirectoryName($ScreenshotPath))) { throw 'Screenshot parent must already exist.' }
  Add-Type -AssemblyName System.Drawing
  Add-Type -AssemblyName System.Windows.Forms
  $previousAwareness = [MrwNativeIme]::SetThreadDpiAwarenessContext([IntPtr](-4))
  try {
    $rect = New-Object MrwNativeIme+RECT
    if (-not [MrwNativeIme]::GetWindowRect($target, [ref]$rect)) { throw 'Cannot read the owned window rectangle.' }
    $screen = [Windows.Forms.SystemInformation]::VirtualScreen
    $left = [Math]::Max($rect.Left, $screen.Left)
    $top = [Math]::Max($rect.Top, $screen.Top)
    $right = [Math]::Min($rect.Right, $screen.Right)
    $bottom = [Math]::Min($rect.Bottom, $screen.Bottom)
    $width = $right - $left
    $height = $bottom - $top
    if ($width -le 0 -or $height -le 0) { throw 'Owned window is outside the visible screen.' }
    $bitmap = New-Object Drawing.Bitmap($width, $height)
    try {
      $graphics = [Drawing.Graphics]::FromImage($bitmap)
      try { $graphics.CopyFromScreen($left, $top, 0, 0, $bitmap.Size) } finally { $graphics.Dispose() }
      $bitmap.Save($ScreenshotPath, [Drawing.Imaging.ImageFormat]::Png)
    } finally { $bitmap.Dispose() }
    $screenshot = [ordered]@{ path=$ScreenshotPath; physicalRectangle=[ordered]@{ x=$left; y=$top; width=$width; height=$height }; scope='Owned foreground window clipped to visible desktop' }
  } finally { [void][MrwNativeIme]::SetThreadDpiAwarenessContext($previousAwareness) }
}

$result = [ordered]@{
  capturedAtUtc = [DateTime]::UtcNow.ToString('o')
  mode = $Mode; pid = $ExpectedProcessId; executable = $process.Path
  processStartedUtc = $process.StartTime.ToUniversalTime().ToString('o')
  windowHandle = $WindowHandle; windowDpi = [MrwNativeIme]::GetDpiForWindow($target)
  foregroundIsTarget = ([MrwNativeIme]::GetForegroundWindow() -eq $target)
  keyboardLayout = ('0x{0:X}' -f $layout.ToInt64())
  legacyImeDescription = $description.ToString(); legacyImeFileName = $imeFilename.ToString()
  screenshot = $screenshot
  focusWindow = $imeWindow.ToInt64(); immStatus = $ime
  sentVirtualKeys = $sentKeys.ToArray(); nativeClick = $nativeClick
  inputMethod = 'Win32 SendInput with KEYEVENTF_SCANCODE; no KEYEVENTF_UNICODE'
  changedGlobalSettings = $false
}
# Emit UTF-8 bytes directly so redirected PowerShell output preserves Chinese paths without changing console settings.
$json = ($result | ConvertTo-Json -Depth 5) + [Environment]::NewLine
$bytes = [Text.Encoding]::UTF8.GetBytes($json)
$stdout = [Console]::OpenStandardOutput()
$stdout.Write($bytes, 0, $bytes.Length)
$stdout.Flush()
