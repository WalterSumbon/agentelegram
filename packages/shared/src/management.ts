// ---------------------------------------------------------------------------
// Agent Management Protocol — types for agent state query & control
// ---------------------------------------------------------------------------
//
// Flow: Frontend → REST API → Server → WebSocket (mgmt_request) → Agent
//                                    ← WebSocket (mgmt_response) ← Agent
//       Frontend ← REST response ← Server
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Management actions
// ---------------------------------------------------------------------------

export type MgmtAction =
  | 'query_state'
  | 'query_skills'
  | 'update_skill'
  | 'query_memory'
  | 'read_memory'
  | 'write_memory'
  | 'delete_memory'
  | 'query_cron'
  | 'create_cron'
  | 'update_cron'
  | 'delete_cron'
  | 'query_mcp'
  | 'update_mcp';

// ---------------------------------------------------------------------------
// WebSocket management events (piggyback on existing WS connection)
// ---------------------------------------------------------------------------

/** Server → Agent: management request forwarded from REST API */
export interface MgmtRequest {
  type: 'mgmt_request';
  requestId: string;
  action: MgmtAction;
  payload?: Record<string, unknown>;
}

/** Agent → Server: management response */
export interface MgmtResponse {
  type: 'mgmt_response';
  requestId: string;
  success: boolean;
  data?: unknown;
  error?: string;
}

// ---------------------------------------------------------------------------
// Agent state domain types
// ---------------------------------------------------------------------------

/** Full agent state overview (returned by query_state) */
export interface AgentState {
  online: boolean;
  skills: SkillInfo[];
  memory: MemoryOverview;
  cron: CronJob[];
  mcp: McpServerInfo[];
}

/** A skill or skillset entry */
export interface SkillInfo {
  name: string;
  description?: string;
  enabled: boolean;
  type: 'skill' | 'skillset';
  children?: SkillInfo[];
}

/** Memory overview with core + extended key listing */
export interface MemoryOverview {
  core: Record<string, unknown>;
  extended: ExtendedMemoryKey[];
}

/** An extended memory key descriptor */
export interface ExtendedMemoryKey {
  key: string;
  description?: string;
  size?: number;
}

/** A cron job managed by the agent */
export interface CronJob {
  id: string;
  schedule: string;
  description: string;
  enabled: boolean;
  lastRun?: number;
  nextRun?: number;
}

/** An MCP server configured on the agent */
export interface McpServerInfo {
  name: string;
  enabled: boolean;
  type: string;
  toolCount?: number;
  tools?: string[];
}
