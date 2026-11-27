import React from 'react';
import '../styles/AppErrorBoundary.css';

interface State {
  error: Error | null;
  copied: boolean;
}

/**
 * Last line of defense for errors thrown while rendering the app. Without it,
 * React unmounts the whole tree on an uncaught render error and the window
 * goes blank; this shows what happened and a way back instead. (Failures
 * before React renders at all are handled by public/startup-error.js.)
 */
export class AppErrorBoundary extends React.Component<{ children: React.ReactNode }, State> {
  state: State = { error: null, copied: false };

  static getDerivedStateFromError(error: unknown): Partial<State> {
    return { error: error instanceof Error ? error : new Error(String(error)) };
  }

  componentDidCatch(error: unknown, info: React.ErrorInfo): void {
    console.error('Unhandled error while rendering the app:', error, info.componentStack);
  }

  private details(): string {
    const { error } = this.state;
    if (!error) return '';
    return error.stack && error.stack.includes(error.message)
      ? error.stack
      : `${error.message}\n\n${error.stack ?? ''}`.trim();
  }

  private copyDetails = (): void => {
    navigator.clipboard
      ?.writeText(this.details())
      .then(() => this.setState({ copied: true }))
      .catch(() => {});
  };

  render(): React.ReactNode {
    const { error, copied } = this.state;
    if (!error) return this.props.children;

    return (
      <div className="app-error" role="alert">
        <h1>Something went wrong</h1>
        <p>
          Phosphor Notes hit an unexpected error and couldn&apos;t continue. Your notes are saved on
          disk; anything you typed in the last moment before this may not have been.
        </p>
        <p>Reloading usually fixes it. If it keeps happening, please report it with the details.</p>
        <pre>{error.message}</pre>
        {error.stack && (
          <details>
            <summary>Technical details</summary>
            <pre>{this.details()}</pre>
          </details>
        )}
        <div className="app-error-actions">
          <button type="button" className="primary" onClick={() => window.location.reload()}>
            Reload
          </button>
          <button type="button" onClick={this.copyDetails}>
            {copied ? 'Copied' : 'Copy details'}
          </button>
        </div>
      </div>
    );
  }
}
