import { AppLayout } from './components/layout/AppLayout'
import { ToastContainer } from './components/ui/Toast'
import { ErrorBoundary } from './components/ui/ErrorBoundary'
import { KeyboardShortcutsDialog } from './components/ui/KeyboardShortcuts'
import { GoToDNDialog } from './components/ui/GoToDNDialog'
import { useKeyboardShortcuts } from './hooks/useKeyboardShortcuts'

function App() {
  const { showShortcuts, closeShortcuts, showGoToDN, closeGoToDN } = useKeyboardShortcuts();

  return (
    <ErrorBoundary>
      <AppLayout />
      <ToastContainer />
      {showShortcuts && <KeyboardShortcutsDialog onClose={closeShortcuts} />}
      {showGoToDN && <GoToDNDialog onClose={closeGoToDN} />}
    </ErrorBoundary>
  );
}

export default App
