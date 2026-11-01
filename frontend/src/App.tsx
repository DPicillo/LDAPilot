import { useEffect } from 'react'
import { WindowSetBackgroundColour } from '../wailsjs/runtime/runtime'
import { AppLayout } from './components/layout/AppLayout'
import { ToastContainer } from './components/ui/Toast'
import { ErrorBoundary } from './components/ui/ErrorBoundary'
import { useUIStore } from './stores/uiStore'
import { readBodyBackgroundRGB } from './components/ui/theme'
import { SaveWindowTheme } from './lib/wails-ui'

function App() {
  const zoomLevel = useUIStore((s) => s.zoomLevel);
  const resolvedTheme = useUIStore((s) => s.resolvedTheme);

  // Paint the native window in the active theme so a resize or a slow first
  // frame never flashes the other theme's colour, and remember the theme so
  // the next start opens in it (main.go). No-op in a plain browser.
  useEffect(() => {
    void SaveWindowTheme(resolvedTheme);
    const rgb = readBodyBackgroundRGB();
    if (!rgb) return;
    try {
      WindowSetBackgroundColour(rgb[0], rgb[1], rgb[2], 255);
    } catch {
      /* window.runtime is missing outside Wails */
    }
  }, [resolvedTheme]);

  return (
    <div
      className="zoom-wrapper"
      style={{
        transform: `scale(${zoomLevel})`,
        transformOrigin: '0 0',
        width: `${100 / zoomLevel}%`,
        height: `${100 / zoomLevel}vh`,
      }}
    >
      <ErrorBoundary>
        {/* The feature hosts (certificate trust, deleted objects, bulk/LDIF
            dialogs) and the feature commands live in AppLayout: the hosts
            before LayerHost, the commands after the core set. Every global
            shortcut is a registry command (ui/commands.ts useCommandShortcuts):
            Ctrl+G opens the palette in DN mode, Ctrl+/ the shortcut list. */}
        <AppLayout />
        <ToastContainer />
      </ErrorBoundary>
    </div>
  );
}

export default App
