// Active-window tracking, main process only. Samples never leave this machine: the renderer gets them over IPC and forwards them to the
// loopback backend, with the title already removed for private windows.
//
// Provider: the npm package `get-windows` when it is installed (polled every 2 s), otherwise one long-lived PowerShell process that
// reads the foreground window with user32 (no dependency, no download). Both give { app, title, pid, bounds:{x,y,width,height} }
// with bounds in physical pixels.
const { spawn } = require('child_process')

const SCRIPT = (intervalMs) => `
$ErrorActionPreference = 'SilentlyContinue'
Add-Type -TypeDefinition @"
using System; using System.Text; using System.Runtime.InteropServices;
public static class W {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
}
"@
[void][W]::SetProcessDPIAware()
[Console]::OutputEncoding = [Text.Encoding]::UTF8
while ($true) {
  $h = [W]::GetForegroundWindow()
  if ($h -ne [IntPtr]::Zero) {
    $sb = New-Object Text.StringBuilder 512
    [void][W]::GetWindowText($h, $sb, 512)
    $procId = 0
    [void][W]::GetWindowThreadProcessId($h, [ref]$procId)
    $r = New-Object W+RECT
    [void][W]::GetWindowRect($h, [ref]$r)
    $name = (Get-Process -Id $procId).ProcessName
    @{ app = $name; title = $sb.ToString(); pid = [int]$procId; x = $r.L; y = $r.T; w = $r.R - $r.L; h = $r.B - $r.T } | ConvertTo-Json -Compress
  } else { '{}' }
  Start-Sleep -Milliseconds ${intervalMs}
}
`

function powershellProvider({ intervalMs = 1000, spawnFn = spawn } = {}) {
  let child = null
  let buf = ''
  return {
    name: 'powershell',
    start(onSample) {
      const encoded = Buffer.from(SCRIPT(intervalMs), 'utf16le').toString('base64')
      child = spawnFn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
        { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] })
      child.stdout.setEncoding('utf8')
      child.stdout.on('data', (chunk) => {
        buf += chunk
        let i
        while ((i = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, i).trim()
          buf = buf.slice(i + 1)
          if (!line) continue
          try {
            const j = JSON.parse(line)
            onSample(j.app ? { app: j.app, title: j.title || '', pid: j.pid, bounds: { x: j.x, y: j.y, width: j.w, height: j.h } } : null)
          } catch {}
        }
      })
      child.on('error', () => onSample(null))
    },
    stop() { if (child) { try { child.kill() } catch {} child = null } },
  }
}

// get-windows is ESM-only, hence the dynamic import. Returns null when the package is not installed.
async function getWindowsProvider({ intervalMs = 2000 } = {}) {
  let mod
  try { mod = await import('get-windows') } catch { return null }
  let timer = null
  return {
    name: 'get-windows',
    start(onSample) {
      const tick = async () => {
        try {
          const w = await mod.activeWindow()
          onSample(w ? { app: (w.owner && w.owner.name) || '', title: w.title || '', pid: w.owner && w.owner.processId, bounds: w.bounds } : null)
        } catch { onSample(null) }
      }
      tick()
      timer = setInterval(tick, intervalMs)
    },
    stop() { clearInterval(timer) },
  }
}

// The tracker keeps the latest window that is not Nova itself (typing in her input box makes her the foreground window; the window the
// user was in before is the one a screen look is about). onChange fires only when app, private flag or title change.
function createTracker({ provider, privacy, ownPid = process.pid, onChange = () => {}, now = Date.now }) {
  let current = null
  let foreignSince = 0

  function handle(raw) {
    if (!raw || !raw.app) { if (current) { current = null; onChange(null) } return }
    if (raw.pid && raw.pid === ownPid) return          // Nova's own window in front: keep the last real one
    const priv = privacy.isPrivate(raw.app, raw.title)
    const next = { app: raw.app, private: priv, pid: raw.pid, bounds: raw.bounds || null, sampledAt: now() }
    if (!priv) next.title = raw.title || ''             // a private window's title is dropped right here
    const changed = !current || current.app !== next.app || current.private !== next.private || current.title !== next.title
    if (changed) foreignSince = now()
    current = next
    if (changed) onChange(publicView(next))
  }

  return {
    start() { provider.start(handle) },
    stop() { provider.stop() },
    latest() { return current },
    handle,                                              // exposed for tests
    // What the backend may see: no bounds, no pid, no title for private windows.
    view() { return current ? publicView(current) : null },
    ageMs() { return current ? now() - current.sampledAt : Infinity },
    foreignSince: () => foreignSince,
  }
}

function publicView(w) {
  return w.private ? { app: w.app, private: true } : { app: w.app, title: w.title, private: false }
}

module.exports = { createTracker, powershellProvider, getWindowsProvider, publicView, SCRIPT }
