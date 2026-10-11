import { Component, type ReactNode } from 'react';

/** Shows a recoverable error screen instead of an empty page when rendering throws. */
export class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error) {
    console.error('tabShare crashed:', error);
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="center-card">
        <h2>Something went wrong</h2>
        <p className="muted small">{this.state.error.message}</p>
        <button className="btn primary" onClick={() => location.reload()}>
          Reload
        </button>
      </div>
    );
  }
}
