import { Component, type ReactNode } from 'react';

/**
 * Contains a render crash to the one admin screen that threw, instead of
 * blanking the whole admin (sidebar included). Keyed by route in Admin.tsx,
 * so navigating away resets it.
 */
export class AdminErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="panel">
        <div className="alert alert-error" style={{ marginBottom: '0.75rem' }}>
          This screen hit an error and could not be shown.
        </div>
        <p className="small muted mono" style={{ wordBreak: 'break-word' }}>{this.state.error.message}</p>
        <button type="button" className="btn btn-ghost small" onClick={() => this.setState({ error: null })}>
          Try again
        </button>
      </div>
    );
  }
}
