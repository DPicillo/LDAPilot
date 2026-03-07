import { AppLayout } from './components/layout/AppLayout'
import { ToastContainer } from './components/ui/Toast'
import { ErrorBoundary } from './components/ui/ErrorBoundary'
import { useKeyboardShortcuts } from './hooks/useKeyboardShortcuts'

function App() {
  useKeyboardShortcuts();

  return (
    <ErrorBoundary>
      <AppLayout />
      <ToastContainer />
    </ErrorBoundary>
  );
}

export default App
