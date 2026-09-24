import React, { useCallback, useEffect, useState } from 'react';
import type { McpActivityEntry, McpClientConfig, McpStatus } from '../../../types/phosphor.d';
import '../styles/McpSettingsPanel.css';

const PRIVACY_DISCLOSURE =
  'Enabling this lets AI apps you connect (Claude Desktop, Claude Code, etc.) read the contents ' +
  'of this vault over a local connection. Note content will be sent to whatever AI model that ' +
  'app uses - this is a real change from "your data never leaves your machine". The vault must ' +
  'be open and unlocked here for any of it to work, and there is no way to unlock the vault from ' +
  'the AI app itself.\n\nEnable the local MCP server?';

function formatClientSnippet(config: McpClientConfig): string {
  const mcpRemoteJson = JSON.stringify(
    {
      command: config.mcpRemote.command,
      args: config.mcpRemote.args,
      env: config.mcpRemote.env
    },
    null,
    2
  );
  return (
    `# Claude Code\n${config.claudeCode}\n\n` +
    `# Claude Desktop / other stdio-only clients, via the community "mcp-remote" bridge\n${mcpRemoteJson}\n\n` +
    `# Generic HTTP\nURL:    ${config.url}\nHeader: Authorization: Bearer <token>`
  );
}

export const McpSettingsPanel: React.FC = () => {
  const [status, setStatus] = useState<McpStatus | null>(null);
  const [activity, setActivity] = useState<McpActivityEntry[]>([]);
  const [portDraft, setPortDraft] = useState('');
  const [justGeneratedToken, setJustGeneratedToken] = useState<string | null>(null);
  const [clientConfig, setClientConfig] = useState<McpClientConfig | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);

  const refreshActivity = useCallback(() => {
    window.phosphor.mcpGetActivity().then(setActivity).catch(console.error);
  }, []);

  useEffect(() => {
    window.phosphor
      .mcpGetStatus()
      .then((s) => {
        setStatus(s);
        setPortDraft(String(s.port));
      })
      .catch(console.error);
    refreshActivity();

    const unsubscribe = window.phosphor.onMcpStatusChange((s) => {
      setStatus(s);
      setPortDraft((prev) => (document.activeElement?.id === 'mcp-port' ? prev : String(s.port)));
    });
    return unsubscribe;
  }, [refreshActivity]);

  const copy = (text: string, field: string): void => {
    navigator.clipboard
      .writeText(text)
      .then(() => {
        setCopied(field);
        setTimeout(() => setCopied(null), 2000);
      })
      .catch(console.error);
  };

  const handleToggle = async (checked: boolean): Promise<void> => {
    if (checked) {
      if (!window.confirm(PRIVACY_DISCLOSURE)) return;
    }
    setBusy(true);
    try {
      const next = await window.phosphor.mcpSetEnabled(checked);
      setStatus(next);
      if (checked && !next.hasToken) {
        await handleRegenerateToken();
      }
    } catch (err) {
      console.error('Failed to toggle MCP server:', err);
    } finally {
      setBusy(false);
    }
  };

  const handleRegenerateToken = async (): Promise<void> => {
    if (
      status?.hasToken &&
      !window.confirm('Generate a new token? Any AI app using the current token will stop working.')
    ) {
      return;
    }
    setBusy(true);
    try {
      const token = await window.phosphor.mcpRegenerateToken();
      setJustGeneratedToken(token);
      const config = await window.phosphor.mcpGetClientConfig(token);
      setClientConfig(config);
      const next = await window.phosphor.mcpGetStatus();
      setStatus(next);
    } catch (err) {
      console.error('Failed to generate MCP token:', err);
    } finally {
      setBusy(false);
    }
  };

  const handlePortBlur = async (): Promise<void> => {
    const port = Number(portDraft);
    if (!status || !Number.isInteger(port) || port === status.port) return;
    if (port < 1024 || port > 65535) {
      window.alert('Port must be between 1024 and 65535.');
      setPortDraft(String(status.port));
      return;
    }
    setBusy(true);
    try {
      const next = await window.phosphor.mcpSetPort(port);
      setStatus(next);
    } catch (err) {
      console.error('Failed to change MCP port:', err);
    } finally {
      setBusy(false);
    }
  };

  if (!status) {
    return (
      <>
        <h2>AI Access (MCP)</h2>
        <p className="setting-hint">Loading…</p>
      </>
    );
  }

  const statusLabel = !status.enabled
    ? 'Disabled'
    : status.error
      ? `Error: ${status.error === 'PORT_IN_USE' ? 'port already in use' : status.error}`
      : status.listening
        ? `Listening on http://127.0.0.1:${status.port}/mcp`
        : 'Starting…';

  return (
    <>
      <h2>AI Access (MCP)</h2>
      <p className="setting-hint">
        Let AI apps that support the Model Context Protocol (Claude Desktop, Claude Code, etc.)
        read this vault over a local, token-authenticated connection. Off by default. Read-only for
        now - there is no way for a connected AI app to edit, delete, or unlock your vault.
      </p>

      <div className="setting-item setting-checkbox">
        <label htmlFor="mcp-enabled">
          <input
            id="mcp-enabled"
            type="checkbox"
            checked={status.enabled}
            disabled={busy}
            onChange={(e) => handleToggle(e.target.checked)}
          />
          Enable local MCP server
        </label>
      </div>

      <div className="mcp-status-row">
        <span className={`mcp-status-dot ${status.listening ? 'ok' : status.enabled ? 'warn' : ''}`} />
        <span>{statusLabel}</span>
      </div>
      <div className="mcp-status-row mcp-status-secondary">
        <span>Vault: {status.vaultReadable ? 'open and unlocked' : 'closed or locked'}</span>
      </div>

      <div className="setting-item">
        <label htmlFor="mcp-port">Port</label>
        <input
          id="mcp-port"
          type="number"
          min={1024}
          max={65535}
          value={portDraft}
          disabled={busy}
          onChange={(e) => setPortDraft(e.target.value)}
          onBlur={handlePortBlur}
        />
        <p className="setting-hint">Changing this restarts the local server if it is running.</p>
      </div>

      <div className="setting-item">
        <button
          type="button"
          className="mcp-btn-primary"
          disabled={busy}
          onClick={() => void handleRegenerateToken()}
        >
          {status.hasToken ? 'Regenerate Token' : 'Generate Token'}
        </button>
        {status.tokenCreatedAt && (
          <p className="setting-hint">
            Current token created {new Date(status.tokenCreatedAt).toLocaleString()}.
          </p>
        )}
      </div>

      {justGeneratedToken && (
        <div className="mcp-token-box">
          <p className="mcp-token-warning">
            Copy this now - you won&apos;t be able to see it again. Regenerating creates a new one.
          </p>
          <div className="mcp-copy-row">
            <code>{justGeneratedToken}</code>
            <button type="button" onClick={() => copy(justGeneratedToken, 'token')}>
              {copied === 'token' ? 'Copied!' : 'Copy'}
            </button>
          </div>

          {clientConfig && (
            <>
              <p className="setting-hint">Paste into your MCP client&apos;s configuration:</p>
              <div className="mcp-copy-row mcp-copy-row-block">
                <pre>{formatClientSnippet(clientConfig)}</pre>
                <button
                  type="button"
                  onClick={() => copy(formatClientSnippet(clientConfig), 'config')}
                >
                  {copied === 'config' ? 'Copied!' : 'Copy'}
                </button>
              </div>
            </>
          )}
        </div>
      )}

      <div className="setting-item">
        <div className="mcp-activity-header">
          <label>Recent activity</label>
          <button type="button" className="mcp-btn-secondary" onClick={refreshActivity}>
            Refresh
          </button>
        </div>
        {activity.length === 0 ? (
          <p className="setting-hint">No requests yet.</p>
        ) : (
          <ul className="mcp-activity-list">
            {activity
              .slice()
              .reverse()
              .slice(0, 20)
              .map((entry, i) => (
                <li key={i} className={entry.ok ? 'ok' : 'error'}>
                  <span className="mcp-activity-time">
                    {new Date(entry.ts).toLocaleTimeString()}
                  </span>
                  <span className="mcp-activity-tool">{entry.tool}</span>
                  <span className="mcp-activity-result">{entry.ok ? 'ok' : entry.errorCode}</span>
                </li>
              ))}
          </ul>
        )}
      </div>
    </>
  );
};
