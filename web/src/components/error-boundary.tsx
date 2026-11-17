import { Component, type ErrorInfo, type ReactNode } from 'react'

type Props = {
  children: ReactNode
  fallback?: (error: Error, reset: () => void) => ReactNode
}
type State = { error: Error | null }

// 通用错误边界：一处渲染出错不再整页白屏，降级为可读的回退 UI。
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // 开发期留痕，便于定位
    console.error('[ErrorBoundary]', error, info.componentStack)
  }

  reset = () => this.setState({ error: null })

  render() {
    if (this.state.error) {
      if (this.props.fallback) return this.props.fallback(this.state.error, this.reset)
      return (
        <div className="m-4 rounded-md border border-destructive/40 bg-destructive/5 p-4 text-sm">
          <div className="font-medium text-destructive">这块内容渲染出错</div>
          <div className="mt-1 text-xs text-muted-foreground break-words">
            {this.state.error.message}
          </div>
          <button
            onClick={this.reset}
            className="mt-2 rounded border px-2 py-1 text-xs hover:bg-accent"
          >
            重试
          </button>
        </div>
      )
    }
    return this.props.children
  }
}
