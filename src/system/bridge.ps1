# Nim's system bridge.
#
# One long-lived PowerShell process that knows a fixed list of operations on
# this computer - the volume, the windows that are open, the installed apps -
# and nothing else. Nim's main process sends it one JSON request per line and
# gets one JSON answer per line back.
#
# There is no operation here that runs a command, evaluates text, or touches a
# path it was given. Every request names one of the operations below and
# carries plain numbers or names, each checked again here. That is the point
# of this file: the parts of Windows that need native calls are reachable,
# and arbitrary PowerShell is not.
#
# It stays running because starting PowerShell and compiling the audio
# interop costs a second or two; after that each request takes milliseconds.

$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [System.Text.Encoding]::UTF8
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;

namespace NimBridge {
  // The Windows Core Audio endpoint for the default speakers. Unused slots in
  // the COM vtable are declared only to keep the method order right.
  [Guid("5CDF2C82-841E-4546-9722-0CF74078229A"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IAudioEndpointVolume {
    int RegisterControlChangeNotify(IntPtr n);
    int UnregisterControlChangeNotify(IntPtr n);
    int GetChannelCount(out int count);
    int SetMasterVolumeLevel(float db, ref Guid ctx);
    int SetMasterVolumeLevelScalar(float level, ref Guid ctx);
    int GetMasterVolumeLevel(out float db);
    int GetMasterVolumeLevelScalar(out float level);
    int SetChannelVolumeLevel(uint ch, float db, ref Guid ctx);
    int SetChannelVolumeLevelScalar(uint ch, float level, ref Guid ctx);
    int GetChannelVolumeLevel(uint ch, out float db);
    int GetChannelVolumeLevelScalar(uint ch, out float level);
    int SetMute([MarshalAs(UnmanagedType.Bool)] bool mute, ref Guid ctx);
    int GetMute([MarshalAs(UnmanagedType.Bool)] out bool mute);
  }
  [Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IMMDevice {
    int Activate(ref Guid iid, int clsCtx, IntPtr activationParams, [MarshalAs(UnmanagedType.IUnknown)] out object iface);
  }
  [Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IMMDeviceEnumerator {
    int EnumAudioEndpoints(int flow, int mask, out IntPtr devices);
    int GetDefaultAudioEndpoint(int flow, int role, out IMMDevice device);
  }
  [ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")]
  class MMDeviceEnumerator { }

  public static class Audio {
    static IAudioEndpointVolume Endpoint() {
      var en = (IMMDeviceEnumerator)(new MMDeviceEnumerator());
      IMMDevice dev;
      Marshal.ThrowExceptionForHR(en.GetDefaultAudioEndpoint(0, 1, out dev));   // render, multimedia
      var iid = typeof(IAudioEndpointVolume).GUID;
      object o;
      Marshal.ThrowExceptionForHR(dev.Activate(ref iid, 23, IntPtr.Zero, out o));
      return (IAudioEndpointVolume)o;
    }
    public static float GetLevel() { float v; Marshal.ThrowExceptionForHR(Endpoint().GetMasterVolumeLevelScalar(out v)); return v; }
    public static void SetLevel(float v) { var g = Guid.Empty; Marshal.ThrowExceptionForHR(Endpoint().SetMasterVolumeLevelScalar(v, ref g)); }
    public static bool GetMute() { bool m; Marshal.ThrowExceptionForHR(Endpoint().GetMute(out m)); return m; }
    public static void SetMute(bool m) { var g = Guid.Empty; Marshal.ThrowExceptionForHR(Endpoint().SetMute(m, ref g)); }
  }

  public static class Win {
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
    [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
    [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);
    [DllImport("user32.dll")] public static extern bool LockWorkStation();
    [DllImport("powrprof.dll")] public static extern bool SetSuspendState(bool hibernate, bool force, bool wakeupEventsDisabled);
    public delegate bool EnumProc(IntPtr h, IntPtr l);
    [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr l);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
    [DllImport("user32.dll")] public static extern int GetWindowTextLength(IntPtr h);

    public static void Tap(byte vk) { keybd_event(vk, 0, 0, UIntPtr.Zero); keybd_event(vk, 0, 2, UIntPtr.Zero); }

    [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
    [StructLayout(LayoutKind.Sequential)] public struct MONITORINFO { public int cbSize; public RECT rcMonitor; public RECT rcWork; public uint dwFlags; }
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
    [DllImport("user32.dll")] public static extern IntPtr MonitorFromWindow(IntPtr h, uint flags);
    [DllImport("user32.dll")] public static extern bool GetMonitorInfo(IntPtr m, ref MONITORINFO mi);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassName(IntPtr h, StringBuilder s, int n);

    /* The window in front covers its whole screen - a game, a film - and is
     * not the desktop itself. */
    public static string FullScreen() {
      IntPtr h = GetForegroundWindow();
      if (h == IntPtr.Zero) return "";
      var cls = new StringBuilder(64);
      GetClassName(h, cls, cls.Capacity);
      string c = cls.ToString();
      if (c == "Progman" || c == "WorkerW" || c == "Shell_TrayWnd") return "";
      RECT r;
      if (!GetWindowRect(h, out r)) return "";
      var mi = new MONITORINFO(); mi.cbSize = Marshal.SizeOf(typeof(MONITORINFO));
      if (!GetMonitorInfo(MonitorFromWindow(h, 2), ref mi)) return "";
      RECT m = mi.rcMonitor;
      if (r.Left <= m.Left && r.Top <= m.Top && r.Right >= m.Right && r.Bottom >= m.Bottom) {
        uint pid; GetWindowThreadProcessId(h, out pid);
        return pid.ToString();
      }
      return "";
    }

    /* Every visible top-level window with a title - all of them, not one per
     * app: a browser with three windows has three titles. */
    public static List<string> Windows() {
      var list = new List<string>();
      EnumWindows(delegate (IntPtr h, IntPtr l) {
        if (!IsWindowVisible(h)) return true;
        int n = GetWindowTextLength(h);
        if (n == 0) return true;
        var sb = new StringBuilder(n + 1);
        GetWindowText(h, sb, sb.Capacity);
        uint pid;
        GetWindowThreadProcessId(h, out pid);
        list.Add(pid + "\t" + h.ToInt64() + "\t" + sb.ToString());
        return true;
      }, IntPtr.Zero);
      return list;
    }
  }
}
'@

# Processes Nim will never close: Windows itself, and Nim.
$Protected = @('explorer', 'dwm', 'csrss', 'winlogon', 'wininit', 'lsass', 'services', 'smss', 'svchost',
               'sihost', 'fontdrvhost', 'electron', 'powershell', 'conhost', 'searchhost', 'startmenuexperiencehost',
               'shellexperiencehost', 'textinputhost', 'lockapp', 'systemsettings')

# The only keys it will press: media keys.
$MediaKeys = @{ playpause = 0xB3; next = 0xB0; previous = 0xB1; stop = 0xB2 }

function Volume-State {
  @{ level = [int][math]::Round([NimBridge.Audio]::GetLevel() * 100); muted = [NimBridge.Audio]::GetMute() }
}

function Window-List {
  # process names looked up once per listing (ids are reused over time)
  $names = @{}
  foreach ($p in Get-Process) { $names[$p.Id] = $p.ProcessName }
  @([NimBridge.Win]::Windows() | ForEach-Object {
    $parts = $_ -split "`t", 3
    $id = [int]$parts[0]
    $name = $names[$id]
    $title = $parts[2]
    if ($name -and $name -ne 'TextInputHost' -and $title.Trim()) {
      @{ pid = $id; process = $name; title = $title }
    }
  })
}

function Foreground {
  $h = [NimBridge.Win]::GetForegroundWindow()
  $fpid = [uint32]0
  [void][NimBridge.Win]::GetWindowThreadProcessId($h, [ref]$fpid)
  $p = Get-Process -Id $fpid -ErrorAction SilentlyContinue
  if ($p) { @{ pid = $p.Id; process = $p.ProcessName; title = $p.MainWindowTitle } } else { @{ pid = [int]$fpid } }
}

function Window-Process([object]$id) {
  $n = 0
  if (-not [int]::TryParse([string]$id, [ref]$n) -or $n -le 0) { throw 'not a process id' }
  $p = Get-Process -Id $n -ErrorAction SilentlyContinue
  if (-not $p -or $p.MainWindowHandle -eq 0) { throw 'that app has no window open' }
  if ($Protected -contains $p.ProcessName.ToLower()) { throw 'that is part of Windows (or Nim), so I leave it alone' }
  $p
}

function App-Paths {
  $found = @{}
  foreach ($exe in @('brave.exe', 'chrome.exe', 'msedge.exe', 'firefox.exe', 'Code.exe', 'opera.exe', 'vivaldi.exe')) {
    foreach ($root in @('HKCU:', 'HKLM:', 'HKLM:\SOFTWARE\WOW6432Node')) {
      $key = Join-Path $root ('SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\' + $exe)
      if ($root -like '*WOW6432Node') { $key = Join-Path $root ('Microsoft\Windows\CurrentVersion\App Paths\' + $exe) }
      if (Test-Path $key) {
        $v = (Get-ItemProperty $key).'(default)'
        if ($v -and (Test-Path ($v.Trim('"')))) { $found[$exe.ToLower()] = $v.Trim('"'); break }
      }
    }
  }
  $found
}

# What is playing: Windows' own media sessions - Spotify, a browser tab playing
# a song or video, any app that shows in the volume flyout. Read only.
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$null = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager, Windows.Media.Control, ContentType = WindowsRuntime]
$AsTask = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
  $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1' })[0]
function Await-Op($op, [Type]$type) {
  $task = $AsTask.MakeGenericMethod($type).Invoke($null, @($op))
  if (-not $task.Wait(3000)) { throw 'Windows did not answer in time' }
  $task.Result
}
$script:Media = $null
function Media-Now {
  if (-not $script:Media) {
    $script:Media = Await-Op ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager]::RequestAsync()) `
      ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager])
  }
  $pick = $null
  foreach ($s in $script:Media.GetSessions()) {
    if ([string]$s.GetPlaybackInfo().PlaybackStatus -eq 'Playing') { $pick = $s; break }
    if (-not $pick) { $pick = $s }
  }
  if (-not $pick) { return @{ status = 'none' } }
  $info = $pick.GetPlaybackInfo()
  $props = $null
  try { $props = Await-Op ($pick.TryGetMediaPropertiesAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties]) } catch { }
  # how long the item is, when the app says (an ad is short; a song is not)
  # and where it is: the position as of the moment the app last reported it
  $length = 0; $at = 0; $updated = 0
  try {
    $t = $pick.GetTimelineProperties()
    $length = [math]::Round(($t.EndTime - $t.StartTime).TotalSeconds)
    $at = [math]::Round($t.Position.TotalSeconds, 2)
    $updated = $t.LastUpdatedTime.ToUnixTimeMilliseconds()
  } catch { }
  @{
    status = [string]$info.PlaybackStatus
    kind = [string]$info.PlaybackType
    app = [string]$pick.SourceAppUserModelId
    title = if ($props) { [string]$props.Title } else { '' }
    artist = if ($props) { [string]$props.Artist } else { '' }
    album = if ($props) { [string]$props.AlbumTitle } else { '' }
    length = $length
    position = $at
    updated = $updated
  }
}

# Pause or play through the media session itself, not a key press: a key only
# toggles (and would start music that was already paused), and with the PC
# locked a key press goes nowhere. Pause takes what is playing; play takes what
# was paused, the current session first.
function Media-Set([string]$what) {
  if ($what -ne 'pause' -and $what -ne 'play') { throw 'not a media action' }
  if (-not $script:Media) {
    $script:Media = Await-Op ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager]::RequestAsync()) `
      ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager])
  }
  $pick = $null
  if ($what -eq 'pause') {
    foreach ($s in $script:Media.GetSessions()) { if ([string]$s.GetPlaybackInfo().PlaybackStatus -eq 'Playing') { $pick = $s; break } }
  } else {
    $cur = $script:Media.GetCurrentSession()
    if ($cur -and [string]$cur.GetPlaybackInfo().PlaybackStatus -eq 'Paused') { $pick = $cur }
    if (-not $pick) {
      foreach ($s in $script:Media.GetSessions()) { if ([string]$s.GetPlaybackInfo().PlaybackStatus -eq 'Paused') { $pick = $s; break } }
    }
  }
  if (-not $pick) { return @{ done = $false; why = 'nothing to ' + $what } }
  $ok = if ($what -eq 'pause') { Await-Op ($pick.TryPauseAsync()) ([bool]) } else { Await-Op ($pick.TryPlayAsync()) ([bool]) }
  @{ done = [bool]$ok; app = [string]$pick.SourceAppUserModelId }
}

# Which app opens a file type, if any: your own choice first, then the system's.
function File-App([string]$ext) {
  if ($ext -notmatch '^\.[a-z0-9]{1,8}$') { throw 'not a file type' }
  $user = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Explorer\FileExts\$ext\UserChoice"
  if (Test-Path $user) { $p = (Get-ItemProperty $user).ProgId; if ($p) { return @{ progId = $p; by = 'you' } } }
  $sys = "Registry::HKEY_CLASSES_ROOT\$ext"
  if (Test-Path $sys) { $p = (Get-ItemProperty $sys).'(default)'; if ($p) { return @{ progId = $p; by = 'windows' } } }
  return @{ progId = ''; by = '' }
}

function Default-Browser {
  $k = 'HKCU:\Software\Microsoft\Windows\Shell\Associations\UrlAssociations\https\UserChoice'
  if (Test-Path $k) { (Get-ItemProperty $k).ProgId } else { '' }
}

function Handle($req) {
  switch ([string]$req.op) {
    'ping'        { return @{ pong = $true } }
    'volume.get'  { return Volume-State }
    'volume.set'  {
      $lv = [double]$req.level
      if ($lv -lt 0 -or $lv -gt 100) { throw 'volume must be 0 to 100' }
      [NimBridge.Audio]::SetLevel([float]($lv / 100))
      if ($lv -gt 0 -and [NimBridge.Audio]::GetMute()) { [NimBridge.Audio]::SetMute($false) }
      return Volume-State
    }
    'volume.mute' { [NimBridge.Audio]::SetMute([bool]$req.on); return Volume-State }
    'windows'     { return ,(Window-List) }
    'foreground'  { return Foreground }
    'fullscreen'  {
      $fpid = [NimBridge.Win]::FullScreen()
      if (-not $fpid) { return @{ full = $false } }
      $p = Get-Process -Id ([int]$fpid) -ErrorAction SilentlyContinue
      return @{ full = $true; process = if ($p) { $p.ProcessName } else { '' } }
    }
    'focus'       {
      $p = Window-Process $req.pid
      $h = $p.MainWindowHandle
      if ([NimBridge.Win]::IsIconic($h)) { [void][NimBridge.Win]::ShowWindow($h, 9) }
      # Windows only lets the app the user last touched take the foreground; a
      # tap of Alt counts as that touch, which is how every launcher does this
      [NimBridge.Win]::Tap(0x12)
      [void][NimBridge.Win]::SetForegroundWindow($h)
      Start-Sleep -Milliseconds 150
      return Foreground
    }
    'close'       {
      $p = Window-Process $req.pid
      # the same as clicking its X: the app gets to ask about unsaved work
      return @{ asked = $p.CloseMainWindow() }
    }
    'apps'        { return ,@(Get-StartApps | ForEach-Object { @{ name = $_.Name; id = $_.AppID } }) }
    'apppaths'    { return App-Paths }
    'browser'     { return @{ progId = Default-Browser } }
    'fileapp'     { return File-App ([string]$req.ext).ToLower() }
    'media.now'   { return Media-Now }
    'media.pause' { return Media-Set 'pause' }
    'media.play'  { return Media-Set 'play' }
    'mediakey'    {
      $vk = $MediaKeys[[string]$req.key]
      if (-not $vk) { throw 'not a media key' }
      [NimBridge.Win]::Tap([byte]$vk)
      return @{ pressed = [string]$req.key }
    }
    'lock'        { return @{ locked = [NimBridge.Win]::LockWorkStation() } }
    'sleep'       { return @{ asleep = [NimBridge.Win]::SetSuspendState($false, $false, $false) } }
    default       { throw ('unknown operation ' + [string]$req.op) }
  }
}

[Console]::Out.WriteLine('{"ready":true}')
[Console]::Out.Flush()

while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }
  if (-not $line.Trim()) { continue }
  $id = $null
  try {
    $req = $line | ConvertFrom-Json
    $id = $req.id
    $result = Handle $req
    $out = @{ id = $id; ok = $true; result = $result } | ConvertTo-Json -Compress -Depth 6
  } catch {
    $out = @{ id = $id; ok = $false; error = $_.Exception.Message } | ConvertTo-Json -Compress
  }
  [Console]::Out.WriteLine($out)
  [Console]::Out.Flush()
}
