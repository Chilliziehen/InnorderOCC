import { Component, Fragment, type ErrorInfo, type ReactNode } from "react";

interface RendererErrorBoundaryProps {
  children: ReactNode;
}

interface RendererErrorBoundaryState {
  failed: boolean;
  resetKey: number;
}

export class RendererErrorBoundary extends Component<
  RendererErrorBoundaryProps,
  RendererErrorBoundaryState
> {
  state: RendererErrorBoundaryState = { failed: false, resetKey: 0 };

  static getDerivedStateFromError(): Partial<RendererErrorBoundaryState> {
    return { failed: true };
  }

  componentDidCatch(_error: unknown, _info: ErrorInfo): void {
    // Renderer exceptions stay inside the generic recovery boundary.
  }

  private readonly retry = () => {
    this.setState(({ resetKey }) => ({ failed: false, resetKey: resetKey + 1 }));
  };

  render() {
    if (this.state.failed) {
      return (
        <main className="entry-screen">
          <section className="entry-panel" role="alert">
            <h1>应用无法继续显示</h1>
            <p>当前界面发生错误。请重试应用。</p>
            <button className="primary-action" type="button" onClick={this.retry}>重试应用</button>
          </section>
        </main>
      );
    }
    return <Fragment key={this.state.resetKey}>{this.props.children}</Fragment>;
  }
}
