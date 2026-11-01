/**
 * ErrorBoundary, rebuilt on the primitives. `variant="app"` (default, the
 * whole window) or `variant="region"` (one per sidebar / main / bottom pane,
 * so one crashing view leaves the rest usable). No vh units: it fills its
 * parent (the zoom wrapper).
 */
import { Component, type ErrorInfo, type ReactNode } from 'react'
import { Copy, RefreshCw, RotateCcw, TriangleAlert } from 'lucide-react'
import { Button } from './Button'

interface Props {
  children: ReactNode
  /** Region name for the message ("Sidebar"). */
  name?: string
  variant?: 'app' | 'region'
  /** Called after "Try again". */
  onReset?: () => void
  /** Custom fallback. */
  fallback?: (error: Error, reset: () => void) => ReactNode
}

interface State {
  hasError: boolean
  error: Error | null
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false, error: null }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error(`[ErrorBoundary${this.props.name ? `: ${this.props.name}` : ''}]`, error, info.componentStack)
  }

  handleReload = () => {
    window.location.reload()
  }

  handleDismiss = () => {
    this.setState({ hasError: false, error: null })
    this.props.onReset?.()
  }

  handleCopy = () => {
    const e = this.state.error
    const text = `${e?.name ?? 'Error'}: ${e?.message ?? ''}\n${e?.stack ?? ''}`
    navigator.clipboard?.writeText(text).catch(() => {})
  }

  render() {
    if (!this.state.hasError) return this.props.children
    const err = this.state.error ?? new Error('An unexpected error occurred.')
    if (this.props.fallback) return this.props.fallback(err, this.handleDismiss)
    const region = this.props.variant === 'region'
    return (
      <div role="alert" className={region ? 'h-full w-full overflow-auto flex items-center justify-center p-4 bg-background text-foreground' : 'h-full w-full flex items-center justify-center bg-background text-foreground'}>
        <div className="flex flex-col items-center gap-3 max-w-md text-center px-6">
          <TriangleAlert size={region ? 32 : 40} strokeWidth={1.75} className="text-destructive" aria-hidden />
          <h1 className={region ? 'text-base font-semibold' : 'text-lg font-semibold'}>
            {this.props.name ? `${this.props.name} failed to render` : 'Something went wrong'}
          </h1>
          <p className="text-sm text-muted-foreground break-words">{err.message || 'An unexpected error occurred.'}</p>
          <div className="flex flex-wrap justify-center gap-2">
            <Button variant="secondary" size="sm" leftIcon={Copy} onClick={this.handleCopy}>
              Copy details
            </Button>
            <Button variant={region ? 'primary' : 'secondary'} size="sm" leftIcon={RotateCcw} onClick={this.handleDismiss}>
              Try again
            </Button>
            {!region && (
              <Button variant="primary" size="sm" leftIcon={RefreshCw} onClick={this.handleReload}>
                Reload
              </Button>
            )}
          </div>
        </div>
      </div>
    )
  }
}
