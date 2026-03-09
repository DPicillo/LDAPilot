import { AppLayout } from './components/layout/AppLayout'
import { ToastContainer } from './components/ui/Toast'
import { ErrorBoundary } from './components/ui/ErrorBoundary'
import { KeyboardShortcutsDialog } from './components/ui/KeyboardShortcuts'
import { GoToDNDialog } from './components/ui/GoToDNDialog'
import { useKeyboardShortcuts } from './hooks/useKeyboardShortcuts'
import { useUIStore } from './stores/uiStore'

function App() {
  const { showShortcuts, closeShortcuts, showGoToDN, closeGoToDN } = useKeyboardShortcuts();
  const zoomLevel = useUIStore((s) => s.zoomLevel);

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
        <AppLayout />
        <ToastContainer />
        {showShortcuts && <KeyboardShortcutsDialog onClose={closeShortcuts} />}
        {showGoToDN && <GoToDNDialog onClose={closeGoToDN} />}
      </ErrorBoundary>
    </div>
  );
}

export default App
