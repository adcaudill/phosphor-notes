import React, { useCallback, useEffect, useState } from 'react';
import type {
  McpActivityEntry,
  McpClientConfig,
  McpNoteVersion,
  McpStatus
} from '../../../types/phosphor.d';
import '../styles/McpSettingsPanel.css';

const PRIVACY_DISCLOSURE =
  'Enabling this lets AI apps you connect (Claude Desktop, Claude Code, etc.) read the contents ' +
  'of this vault over a local connection. Note content will be sent to whatever AI model that ' +
  'app uses - this is a real change from "your data never leaves your machine". The vault must ' +
  'be open and unlocked here for any of it to work, and there is no way to unlock the vault from ' +
  'the AI app itself.\n\nEnable the local MCP server?';

const WRITE_DISCLOSURE =
  'This lets connected AI apps change your vault, not just read it. They will be able to:\n' +
  '  - create new notes (and replace a note if they explicitly ask to),\n' +
  '  - add text to the end of existing notes or under an existing bullet,\n' +
  '  - add, complete, update, and delete tasks (new tasks go to today’s daily note by default).\n\n' +
  'They cannot edit other text already in a note, or delete, rename, or move notes (unless you ' +
  'also allow those below), or unlock the vault. Changes happen immediately without asking you each ' +
  'time, but Phosphor keeps the previous version of every note an AI app changes, so you can ' +
  'revert it from "Recent AI changes" below. AI apps are refused if you have unsaved edits open ' +
  'in the same note. Content written into an encrypted vault is encrypted like any other note.\n\n' +
  'AI apps that are already connected may need to be restarted to see the new tools.\n\n' +
  'Allow AI apps to create and edit notes?';

const EDIT_DISCLOSURE =
  'This additionally lets connected AI apps change text that is already in your notes, not just ' +
  'add to it. They will be able to:\n' +
  '  - replace or remove specific passages, sections, and bullets,\n' +
  '  - move sections and bullets around within a note,\n' +
  '  - change frontmatter (title, tags, and other properties),\n' +
  '  - restore an earlier version of a note they changed.\n\n' +
  'Phosphor keeps the previous version of every note an AI app changes (see "Recent AI changes" ' +
  'below), so any change can be reverted. Deleting, renaming, and moving whole notes need their ' +
  'own permission below, and AI apps are refused if you have unsaved edits open in the same note.\n\n' +
  'Allow AI apps to edit existing text?';

const ORGANIZE_DISCLOSURE =
  'This lets connected AI apps rename notes and move them to other folders. Links to a moved ' +
  'note are updated across your vault, exactly as when you rename or move a note yourself, and ' +
  'a note’s child notes can be moved along with it.\n\n' +
  'AI apps never overwrite an existing note, and every rename can be reverted from "Recent AI ' +
  'changes" below, which also restores the links it updated. Your folder limits apply to the ' +
  'note, its destination, and every note whose links would change.\n\n' +
  'Allow AI apps to rename and move notes?';

const DELETE_DISCLOSURE =
  'This lets connected AI apps delete notes. A deleted note goes to your system Trash, and ' +
  'Phosphor also keeps a copy you can restore from "Recent AI changes" below for 30 days.\n\n' +
  'AI apps are refused if other notes link to the note (unless they explicitly ask to delete it ' +
  'anyway), if it is outside the folders you allow, or if you have unsaved edits open in it.\n\n' +
  'Allow AI apps to delete notes?';

function parseFolderList(text: string): string[] {
  return text
    .split(/[\n,]/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

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
  const [allowDraft, setAllowDraft] = useState('');
  const [denyDraft, setDenyDraft] = useState('');
  const [versions, setVersions] = useState<McpNoteVersion[]>([]);

  const refreshActivity = useCallback(() => {
    window.phosphor.mcpGetActivity().then(setActivity).catch(console.error);
    window.phosphor.mcpListVersions(20).then(setVersions).catch(console.error);
  }, []);

  useEffect(() => {
    window.phosphor
      .mcpGetStatus()
      .then((s) => {
        setStatus(s);
        setPortDraft(String(s.port));
        setAllowDraft(s.writeAllowFolders.join('\n'));
        setDenyDraft(s.writeDenyFolders.join('\n'));
      })
      .catch(console.error);
    refreshActivity();

    const unsubscribe = window.phosphor.onMcpStatusChange((s) => {
      setStatus(s);
      const focused = document.activeElement?.id;
      setPortDraft((prev) => (focused === 'mcp-port' ? prev : String(s.port)));
      setAllowDraft((prev) =>
        focused === 'mcp-allow-folders' ? prev : s.writeAllowFolders.join('\n')
      );
      setDenyDraft((prev) =>
        focused === 'mcp-deny-folders' ? prev : s.writeDenyFolders.join('\n')
      );
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

  const handleWriteToggle = async (checked: boolean): Promise<void> => {
    if (checked && !window.confirm(WRITE_DISCLOSURE)) return;
    setBusy(true);
    try {
      const next = await window.phosphor.mcpSetWriteEnabled(checked);
      setStatus(next);
    } catch (err) {
      console.error('Failed to toggle MCP write access:', err);
    } finally {
      setBusy(false);
    }
  };

  const handleEditToggle = async (checked: boolean): Promise<void> => {
    if (checked && !window.confirm(EDIT_DISCLOSURE)) return;
    setBusy(true);
    try {
      const next = await window.phosphor.mcpSetEditEnabled(checked);
      setStatus(next);
    } catch (err) {
      console.error('Failed to toggle MCP edit access:', err);
    } finally {
      setBusy(false);
    }
  };

  const handleTierToggle = async (tier: 'organize' | 'delete', checked: boolean): Promise<void> => {
    if (checked && !window.confirm(tier === 'organize' ? ORGANIZE_DISCLOSURE : DELETE_DISCLOSURE)) {
      return;
    }
    setBusy(true);
    try {
      const next =
        tier === 'organize'
          ? await window.phosphor.mcpSetOrganizeEnabled(checked)
          : await window.phosphor.mcpSetDeleteEnabled(checked);
      setStatus(next);
    } catch (err) {
      console.error(`Failed to toggle MCP ${tier} access:`, err);
    } finally {
      setBusy(false);
    }
  };

  const handleScopeBlur = async (): Promise<void> => {
    if (!status) return;
    const allow = parseFolderList(allowDraft);
    const deny = parseFolderList(denyDraft);
    if (
      allow.join('\n') === status.writeAllowFolders.join('\n') &&
      deny.join('\n') === status.writeDenyFolders.join('\n')
    ) {
      return;
    }
    setBusy(true);
    try {
      const next = await window.phosphor.mcpSetWriteScope(allow, deny);
      setStatus(next);
      // Show the normalized result (e.g. trailing slashes and duplicates removed).
      setAllowDraft(next.writeAllowFolders.join('\n'));
      setDenyDraft(next.writeDenyFolders.join('\n'));
    } catch (err) {
      console.error('Failed to update MCP write scope:', err);
    } finally {
      setBusy(false);
    }
  };

  const handleRevert = async (version: McpNoteVersion): Promise<void> => {
    const when = new Date(version.ts).toLocaleString();
    const question =
      version.kind === 'rename'
        ? `Move "${version.path}" back to "${version.fromPath}" (renamed by ${version.tool}, ${when})?\n\nLinks to it are updated back as well.`
        : version.kind === 'delete'
          ? `Restore "${version.path}", deleted by ${version.tool} (${when})?`
          : null;
    if (question !== null) {
      if (!window.confirm(question)) return;
    } else if (
      !window.confirm(
        `Revert "${version.path}" to how it was before this change (${version.tool}, ` +
          `${new Date(version.ts).toLocaleString()})?\n\nIts current content will be saved first, so ` +
          'you can undo the revert the same way.'
      )
    ) {
      return;
    }
    setBusy(true);
    try {
      await window.phosphor.mcpRestoreVersion(version.id);
    } catch (err) {
      console.error('Failed to revert note:', err);
      window.alert('Could not revert the note. Is the vault open and unlocked?');
    } finally {
      setBusy(false);
      refreshActivity();
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
        connect to this vault over a local, token-authenticated connection. Off by default.{' '}
        {status.editEnabled
          ? `Read, write, and edit: connected AI apps can create notes, add to them, and edit existing text${
              status.organizeEnabled ? ', rename and move notes' : ''
            }${status.deleteEnabled ? ', delete notes' : ''}, but cannot unlock anything.`
          : status.writeEnabled
            ? 'Read and write: connected AI apps can create notes and append to existing ones, but cannot edit existing text, delete, rename, or unlock anything.'
            : 'Read-only: connected AI apps can read but not change your vault.'}
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

      <div className="setting-item setting-checkbox mcp-subsetting">
        <label htmlFor="mcp-write-enabled">
          <input
            id="mcp-write-enabled"
            type="checkbox"
            checked={status.writeEnabled}
            disabled={busy || !status.enabled}
            onChange={(e) => handleWriteToggle(e.target.checked)}
          />
          Allow connected AI apps to create notes and add to existing notes
        </label>
        {!status.enabled && <p className="setting-hint">Turn on the MCP server first.</p>}
      </div>

      <div className="setting-item setting-checkbox mcp-subsetting mcp-subsetting-nested">
        <label htmlFor="mcp-edit-enabled">
          <input
            id="mcp-edit-enabled"
            type="checkbox"
            checked={status.editEnabled}
            disabled={busy || !status.writeEnabled}
            onChange={(e) => handleEditToggle(e.target.checked)}
          />
          Also allow editing existing text (replace and remove passages, sections, and frontmatter)
        </label>
        {status.enabled && !status.writeEnabled && (
          <p className="setting-hint">Allow creating and adding to notes first.</p>
        )}
      </div>

      {status.writeEnabled && (
        <>
          <div className="setting-item setting-checkbox mcp-subsetting mcp-subsetting-nested-2">
            <label htmlFor="mcp-organize-enabled">
              <input
                id="mcp-organize-enabled"
                type="checkbox"
                checked={status.organizeEnabled}
                disabled={busy || !status.editEnabled}
                onChange={(e) => handleTierToggle('organize', e.target.checked)}
              />
              Also allow renaming and moving notes (links to them are updated)
            </label>
          </div>
          <div className="setting-item setting-checkbox mcp-subsetting mcp-subsetting-nested-2">
            <label htmlFor="mcp-delete-enabled">
              <input
                id="mcp-delete-enabled"
                type="checkbox"
                checked={status.deleteEnabled}
                disabled={busy || !status.editEnabled}
                onChange={(e) => handleTierToggle('delete', e.target.checked)}
              />
              Also allow deleting notes (to the Trash, restorable from Recent AI changes)
            </label>
            {!status.editEnabled && (
              <p className="setting-hint">Allow editing existing text first.</p>
            )}
          </div>
        </>
      )}

      {status.writeEnabled && (
        <div className="setting-item setting-checkbox mcp-subsetting">
          <label htmlFor="mcp-tasks-enabled">
            <input
              id="mcp-tasks-enabled"
              type="checkbox"
              checked={status.tasksEnabled}
              disabled={busy}
              onChange={async (e) => {
                setBusy(true);
                try {
                  setStatus(await window.phosphor.mcpSetTasksEnabled(e.target.checked));
                } catch (err) {
                  console.error('Failed to toggle MCP task access:', err);
                } finally {
                  setBusy(false);
                }
              }}
            />
            Allow changes to tasks
          </label>
          <p className="setting-hint">
            Creating, completing and updating tasks (and, with the options above, editing and
            deleting them). Tasks aren&apos;t in a folder, so the folder limits below don&apos;t
            apply to them.
          </p>
        </div>
      )}

      {status.writeEnabled && (
        <div className="setting-item mcp-subsetting">
          <label htmlFor="mcp-allow-folders">Only allow changes in these folders</label>
          <textarea
            id="mcp-allow-folders"
            rows={2}
            placeholder="One folder per line, e.g. Inbox. Leave empty for the whole vault."
            value={allowDraft}
            disabled={busy}
            onChange={(e) => setAllowDraft(e.target.value)}
            onBlur={() => void handleScopeBlur()}
          />
          <label htmlFor="mcp-deny-folders">Never allow changes in these folders</label>
          <textarea
            id="mcp-deny-folders"
            rows={2}
            placeholder="One folder per line, e.g. Private"
            value={denyDraft}
            disabled={busy}
            onChange={(e) => setDenyDraft(e.target.value)}
            onBlur={() => void handleScopeBlur()}
          />
          <p className="setting-hint">
            A folder includes its subfolders and its own index note (e.g. People.md for People).
            Excluded folders win over allowed ones. Today&apos;s daily note lives at the top of the
            vault, so limiting changes to folders also stops AI apps adding tasks to it.
          </p>
        </div>
      )}

      <div className="mcp-status-row">
        <span
          className={`mcp-status-dot ${status.listening ? 'ok' : status.enabled ? 'warn' : ''}`}
        />
        <span>{statusLabel}</span>
      </div>
      <div className="mcp-status-row mcp-status-secondary">
        <span>Vault: {status.vaultReadable ? 'open and unlocked' : 'closed or locked'}</span>
      </div>
      {status.enabled && (
        <div className="mcp-status-row mcp-status-secondary">
          <span>
            Access:{' '}
            {status.editEnabled
              ? [
                  'read, write, edit',
                  status.organizeEnabled && 'organize',
                  status.deleteEnabled && 'delete'
                ]
                  .filter(Boolean)
                  .join(', ')
              : status.writeEnabled
                ? 'read and write'
                : 'read-only'}
          </span>
        </div>
      )}

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

      {(status.writeEnabled || versions.length > 0) && (
        <div className="setting-item">
          <div className="mcp-activity-header">
            <label>Recent AI changes</label>
            <button type="button" className="mcp-btn-secondary" onClick={refreshActivity}>
              Refresh
            </button>
          </div>
          <p className="setting-hint">
            Each entry is a note as it was just before an AI app changed it. Reverting saves the
            current content first, so a revert can be undone too. Kept for 30 days.
          </p>
          {versions.length === 0 ? (
            <p className="setting-hint">No changes yet.</p>
          ) : (
            <ul className="mcp-activity-list">
              {versions.map((version) => (
                <li key={version.id} className="ok">
                  <span className="mcp-activity-time">{new Date(version.ts).toLocaleString()}</span>
                  <span className="mcp-activity-tool">
                    {version.tool}
                    <span className="mcp-activity-target">
                      {version.kind === 'rename'
                        ? ` ${version.fromPath} → ${version.path}`
                        : version.kind === 'delete'
                          ? ` deleted ${version.path}`
                          : ` ${version.path}`}
                    </span>
                  </span>
                  <button
                    type="button"
                    className="mcp-btn-secondary"
                    disabled={busy}
                    onClick={() => void handleRevert(version)}
                  >
                    Revert
                  </button>
                </li>
              ))}
            </ul>
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
                  {entry.write && <span className="mcp-activity-write-badge">write</span>}
                  <span className="mcp-activity-tool">
                    {entry.tool}
                    {entry.target && <span className="mcp-activity-target"> {entry.target}</span>}
                  </span>
                  <span className="mcp-activity-result">{entry.ok ? 'ok' : entry.errorCode}</span>
                </li>
              ))}
          </ul>
        )}
      </div>
    </>
  );
};
