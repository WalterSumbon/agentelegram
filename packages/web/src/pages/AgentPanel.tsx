/**
 * Agent Management Panel — M4
 *
 * Displays agent state (skills, memory, cron, MCP) and allows management.
 * Data flows: Frontend → REST API → Server → WebSocket → Agent → back.
 */
import { useState, useEffect, useCallback } from 'react';
import type {
  AgentInfo,
  SkillInfo,
  MemoryOverview,
  CronJob,
  McpServerInfo,
} from '../api';
import {
  listAgents,
  getAgentSkills,
  updateAgentSkill,
  getAgentMemory,
  readAgentMemory,
  getAgentCron,
  createAgentCron,
  updateAgentCron,
  deleteAgentCron,
  getAgentMcp,
  updateAgentMcp,
} from '../api';

// ---------------------------------------------------------------------------
// Agent List (sidebar content)
// ---------------------------------------------------------------------------

export function AgentList({
  selectedAgentId,
  onSelect,
}: {
  selectedAgentId: string | null;
  onSelect: (id: string) => void;
}) {
  const [agents, setAgents] = useState<AgentInfo[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    listAgents()
      .then((data) => { if (!cancelled) setAgents(data); })
      .catch((err) => console.error('[agents]', err))
      .finally(() => { if (!cancelled) setLoading(false); });

    // Poll every 10s for online status updates
    const interval = setInterval(() => {
      listAgents()
        .then((data) => { if (!cancelled) setAgents(data); })
        .catch(() => {});
    }, 10_000);

    return () => { cancelled = true; clearInterval(interval); };
  }, []);

  if (loading) {
    return (
      <div className="agent-list-loading">
        <div className="skeleton-line" />
        <div className="skeleton-line short" />
        <div className="skeleton-line" />
      </div>
    );
  }

  if (agents.length === 0) {
    return <div className="empty-hint">No agents registered</div>;
  }

  return (
    <div className="agent-list">
      {agents.map((a) => (
        <div
          key={a.id}
          className={`agent-item ${selectedAgentId === a.id ? 'active' : ''}`}
          onClick={() => onSelect(a.id)}
        >
          <div className="agent-item-avatar">
            {a.displayName.charAt(0)}
          </div>
          <div className="agent-item-info">
            <div className="agent-item-name">{a.displayName}</div>
            <div className="agent-item-meta">@{a.name}</div>
          </div>
          <div className={`agent-status-dot ${a.online ? 'online' : 'offline'}`}
               title={a.online ? 'Online' : 'Offline'} />
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Agent Management Panel (main area)
// ---------------------------------------------------------------------------

type Tab = 'skills' | 'memory' | 'cron' | 'mcp';

export function AgentManagementPanel({ agentId }: { agentId: string }) {
  const [tab, setTab] = useState<Tab>('skills');
  const [agent, setAgent] = useState<AgentInfo | null>(null);

  useEffect(() => {
    listAgents().then((agents) => {
      const a = agents.find((x) => x.id === agentId);
      if (a) setAgent(a);
    });
  }, [agentId]);

  return (
    <div className="mgmt-panel">
      {/* Header */}
      <div className="mgmt-header">
        <div className="mgmt-header-info">
          <div className="mgmt-avatar">
            {agent?.displayName?.charAt(0) ?? '?'}
          </div>
          <div>
            <h2 className="mgmt-agent-name">{agent?.displayName ?? 'Agent'}</h2>
            <span className="mgmt-agent-meta">@{agent?.name}</span>
          </div>
        </div>
        <div className={`mgmt-status ${agent?.online ? 'online' : 'offline'}`}>
          <span className="mgmt-status-dot" />
          {agent?.online ? 'Online' : 'Offline'}
        </div>
      </div>

      {/* Tab bar */}
      <div className="mgmt-tabs">
        {(['skills', 'memory', 'cron', 'mcp'] as Tab[]).map((t) => (
          <button
            key={t}
            className={`mgmt-tab ${tab === t ? 'active' : ''}`}
            onClick={() => setTab(t)}
          >
            {t === 'skills' ? 'Skills' : t === 'memory' ? 'Memory' : t === 'cron' ? 'Cron Jobs' : 'MCP Servers'}
          </button>
        ))}
      </div>

      {/* Tab content */}
      <div className="mgmt-content">
        {!agent?.online ? (
          <div className="mgmt-offline-notice">
            <div className="mgmt-offline-icon">!</div>
            <p>Agent is offline. Connect the agent to manage its state.</p>
          </div>
        ) : (
          <>
            {tab === 'skills' && <SkillsPanel agentId={agentId} />}
            {tab === 'memory' && <MemoryPanel agentId={agentId} />}
            {tab === 'cron' && <CronPanel agentId={agentId} />}
            {tab === 'mcp' && <McpPanel agentId={agentId} />}
          </>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Skills Panel
// ---------------------------------------------------------------------------

function SkillsPanel({ agentId }: { agentId: string }) {
  const [skills, setSkills] = useState<SkillInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const load = useCallback(() => {
    setLoading(true);
    setError('');
    getAgentSkills(agentId)
      .then(setSkills)
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, [agentId]);

  useEffect(() => { load(); }, [load]);

  const toggle = async (name: string, enabled: boolean) => {
    try {
      await updateAgentSkill(agentId, name, enabled);
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  if (loading) return <SkeletonLoader rows={4} />;
  if (error) return <ErrorMsg message={error} onRetry={load} />;

  return (
    <div className="mgmt-section">
      <div className="mgmt-section-header">
        <h3>Skills & Skillsets</h3>
        <span className="mgmt-count">{countSkills(skills)} skills</span>
      </div>
      <div className="skill-list">
        {skills.map((s) => (
          <SkillItem key={s.name} skill={s} onToggle={toggle} depth={0} />
        ))}
      </div>
    </div>
  );
}

function SkillItem({
  skill,
  onToggle,
  depth,
}: {
  skill: SkillInfo;
  onToggle: (name: string, enabled: boolean) => void;
  depth: number;
}) {
  const [expanded, setExpanded] = useState(true);
  const isSet = skill.type === 'skillset';

  return (
    <div className="skill-item" style={{ paddingLeft: `${depth * 20}px` }}>
      <div className="skill-row">
        {isSet && (
          <button className="skill-expand" onClick={() => setExpanded(!expanded)}>
            {expanded ? '\u25BE' : '\u25B8'}
          </button>
        )}
        <div className="skill-info">
          <span className="skill-name">{skill.name}</span>
          {isSet && <span className="skill-type-badge">set</span>}
          {skill.description && <span className="skill-desc">{skill.description}</span>}
        </div>
        <ToggleSwitch
          checked={skill.enabled}
          onChange={(v) => onToggle(skill.name, v)}
        />
      </div>
      {isSet && expanded && skill.children && (
        <div className="skill-children">
          {skill.children.map((child) => (
            <SkillItem key={child.name} skill={child} onToggle={onToggle} depth={depth + 1} />
          ))}
        </div>
      )}
    </div>
  );
}

function countSkills(skills: SkillInfo[]): number {
  let count = 0;
  for (const s of skills) {
    count++;
    if (s.children) count += countSkills(s.children);
  }
  return count;
}

// ---------------------------------------------------------------------------
// Memory Panel
// ---------------------------------------------------------------------------

function MemoryPanel({ agentId }: { agentId: string }) {
  const [memory, setMemory] = useState<MemoryOverview | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [expandedKey, setExpandedKey] = useState<string | null>(null);
  const [keyContent, setKeyContent] = useState<Record<string, string>>({});
  const [loadingKey, setLoadingKey] = useState<string | null>(null);

  const load = useCallback(() => {
    setLoading(true);
    setError('');
    getAgentMemory(agentId)
      .then(setMemory)
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, [agentId]);

  useEffect(() => { load(); }, [load]);

  const loadExtendedKey = async (key: string) => {
    if (expandedKey === key) {
      setExpandedKey(null);
      return;
    }
    setExpandedKey(key);
    if (keyContent[key]) return; // already loaded

    setLoadingKey(key);
    try {
      const data = await readAgentMemory(agentId, 'extended', key);
      setKeyContent((prev) => ({ ...prev, [key]: typeof data === 'string' ? data : JSON.stringify(data, null, 2) }));
    } catch (err: any) {
      setKeyContent((prev) => ({ ...prev, [key]: `Error: ${err.message}` }));
    } finally {
      setLoadingKey(null);
    }
  };

  if (loading) return <SkeletonLoader rows={5} />;
  if (error) return <ErrorMsg message={error} onRetry={load} />;
  if (!memory) return null;

  return (
    <div className="mgmt-section">
      {/* Core Memory */}
      <div className="mgmt-section-header">
        <h3>Core Memory</h3>
      </div>
      <div className="memory-core">
        {Object.entries(memory.core).map(([key, value]) => (
          <div key={key} className="memory-core-block">
            <div className="memory-core-key">{key}</div>
            <pre className="memory-core-value">{typeof value === 'string' ? value : JSON.stringify(value, null, 2)}</pre>
          </div>
        ))}
      </div>

      {/* Extended Memory */}
      <div className="mgmt-section-header" style={{ marginTop: '24px' }}>
        <h3>Extended Memory</h3>
        <span className="mgmt-count">{memory.extended.length} keys</span>
      </div>
      <div className="memory-extended">
        {memory.extended.map((entry) => (
          <div key={entry.key} className="memory-ext-item">
            <div className="memory-ext-row" onClick={() => loadExtendedKey(entry.key)}>
              <span className="memory-ext-expand">{expandedKey === entry.key ? '\u25BE' : '\u25B8'}</span>
              <div className="memory-ext-info">
                <span className="memory-ext-key">{entry.key}</span>
                {entry.description && <span className="memory-ext-desc">{entry.description}</span>}
              </div>
              {entry.size != null && (
                <span className="memory-ext-size">{formatSize(entry.size)}</span>
              )}
            </div>
            {expandedKey === entry.key && (
              <div className="memory-ext-content">
                {loadingKey === entry.key ? (
                  <div className="skeleton-line" />
                ) : (
                  <pre>{keyContent[entry.key] ?? 'Loading...'}</pre>
                )}
              </div>
            )}
          </div>
        ))}
        {memory.extended.length === 0 && (
          <div className="mgmt-empty">No extended memory keys</div>
        )}
      </div>
    </div>
  );
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

// ---------------------------------------------------------------------------
// Cron Panel
// ---------------------------------------------------------------------------

function CronPanel({ agentId }: { agentId: string }) {
  const [crons, setCrons] = useState<CronJob[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [showAdd, setShowAdd] = useState(false);
  const [newSchedule, setNewSchedule] = useState('');
  const [newDesc, setNewDesc] = useState('');

  const load = useCallback(() => {
    setLoading(true);
    setError('');
    getAgentCron(agentId)
      .then(setCrons)
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, [agentId]);

  useEffect(() => { load(); }, [load]);

  const toggle = async (cronId: string, enabled: boolean) => {
    try {
      await updateAgentCron(agentId, cronId, { enabled });
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const remove = async (cronId: string) => {
    try {
      await deleteAgentCron(agentId, cronId);
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const add = async () => {
    if (!newSchedule.trim() || !newDesc.trim()) return;
    try {
      await createAgentCron(agentId, newSchedule.trim(), newDesc.trim());
      setNewSchedule('');
      setNewDesc('');
      setShowAdd(false);
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  if (loading) return <SkeletonLoader rows={3} />;
  if (error) return <ErrorMsg message={error} onRetry={load} />;

  return (
    <div className="mgmt-section">
      <div className="mgmt-section-header">
        <h3>Cron Jobs</h3>
        <button className="mgmt-add-btn" onClick={() => setShowAdd(!showAdd)}>
          {showAdd ? 'Cancel' : '+ Add'}
        </button>
      </div>

      {showAdd && (
        <div className="cron-add-form">
          <input
            type="text"
            placeholder="Schedule (e.g., 0 9 * * *)"
            value={newSchedule}
            onChange={(e) => setNewSchedule(e.target.value)}
          />
          <input
            type="text"
            placeholder="Description"
            value={newDesc}
            onChange={(e) => setNewDesc(e.target.value)}
          />
          <button className="btn-primary" onClick={add} disabled={!newSchedule.trim() || !newDesc.trim()}>
            Create
          </button>
        </div>
      )}

      <div className="cron-list">
        {crons.map((c) => (
          <div key={c.id} className="cron-item">
            <div className="cron-item-main">
              <div className="cron-item-info">
                <span className="cron-desc">{c.description}</span>
                <code className="cron-schedule">{c.schedule}</code>
              </div>
              <div className="cron-item-actions">
                <ToggleSwitch checked={c.enabled} onChange={(v) => toggle(c.id, v)} />
                <button className="cron-delete-btn" onClick={() => remove(c.id)} title="Delete">
                  &times;
                </button>
              </div>
            </div>
            <div className="cron-item-meta">
              {c.lastRun && <span>Last: {formatTime(c.lastRun)}</span>}
              {c.nextRun && <span>Next: {formatTime(c.nextRun)}</span>}
            </div>
          </div>
        ))}
        {crons.length === 0 && (
          <div className="mgmt-empty">No cron jobs configured</div>
        )}
      </div>
    </div>
  );
}

function formatTime(ts: number): string {
  return new Date(ts).toLocaleString([], {
    month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
  });
}

// ---------------------------------------------------------------------------
// MCP Panel
// ---------------------------------------------------------------------------

function McpPanel({ agentId }: { agentId: string }) {
  const [servers, setServers] = useState<McpServerInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [expandedMcp, setExpandedMcp] = useState<string | null>(null);

  const load = useCallback(() => {
    setLoading(true);
    setError('');
    getAgentMcp(agentId)
      .then(setServers)
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, [agentId]);

  useEffect(() => { load(); }, [load]);

  const toggle = async (name: string, enabled: boolean) => {
    try {
      await updateAgentMcp(agentId, name, enabled);
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  if (loading) return <SkeletonLoader rows={3} />;
  if (error) return <ErrorMsg message={error} onRetry={load} />;

  return (
    <div className="mgmt-section">
      <div className="mgmt-section-header">
        <h3>MCP Servers</h3>
        <span className="mgmt-count">{servers.length} servers</span>
      </div>
      <div className="mcp-list">
        {servers.map((s) => (
          <div key={s.name} className="mcp-item">
            <div className="mcp-item-main" onClick={() => setExpandedMcp(expandedMcp === s.name ? null : s.name)}>
              <div className="mcp-item-info">
                <span className="mcp-name">{s.name}</span>
                <span className="mcp-type">{s.type}</span>
                {s.toolCount != null && <span className="mcp-tools">{s.toolCount} tools</span>}
              </div>
              <ToggleSwitch checked={s.enabled} onChange={(v) => toggle(s.name, v)} />
            </div>
            {expandedMcp === s.name && s.tools && s.tools.length > 0 && (
              <div className="mcp-tool-list">
                {s.tools.map((tool) => (
                  <span key={tool} className="mcp-tool-chip">{tool}</span>
                ))}
              </div>
            )}
          </div>
        ))}
        {servers.length === 0 && (
          <div className="mgmt-empty">No MCP servers configured</div>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Shared components
// ---------------------------------------------------------------------------

function ToggleSwitch({
  checked,
  onChange,
}: {
  checked: boolean;
  onChange: (value: boolean) => void;
}) {
  return (
    <button
      className={`toggle-switch ${checked ? 'on' : 'off'}`}
      onClick={(e) => { e.stopPropagation(); onChange(!checked); }}
      role="switch"
      aria-checked={checked}
    >
      <span className="toggle-thumb" />
    </button>
  );
}

function SkeletonLoader({ rows }: { rows: number }) {
  return (
    <div className="mgmt-skeleton">
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className={`skeleton-line ${i % 3 === 2 ? 'short' : ''}`} />
      ))}
    </div>
  );
}

function ErrorMsg({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="mgmt-error">
      <p>{message}</p>
      <button className="btn-secondary" onClick={onRetry}>Retry</button>
    </div>
  );
}
