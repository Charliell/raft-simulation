export enum NodeState {
  FOLLOWER = 'FOLLOWER',
  CANDIDATE = 'CANDIDATE',
  LEADER = 'LEADER',
  CRASHED = 'CRASHED',
}

export enum PacketType {
  REQUEST_VOTE = 'REQUEST_VOTE',
  VOTE_RESPONSE = 'VOTE_RESPONSE',
  APPEND_ENTRIES = 'APPEND_ENTRIES',
  APPEND_RESPONSE = 'APPEND_RESPONSE',
}

export interface LogEntry {
  term: number;
  command: string;
}

export interface RaftNode {
  id: number;
  state: NodeState;
  currentTerm: number;
  votedFor: number | null;
  log: LogEntry[];
  commitIndex: number;
  
  // Volatile state on all servers
  electionTimeout: number; // Ticks remaining
  currentTimeoutDuration: number; // The random duration set
  
  // Volatile state on leaders
  nextIndex: Record<number, number>;
  matchIndex: Record<number, number>;
  heartbeatTimer: number;

  // UI Visuals
  x: number;
  y: number;
}

export interface Packet {
  id: string;
  from: number;
  to: number;
  type: PacketType;
  payload: any;
  progress: number; // 0 to 100
  speed: number;
}

export interface SimulationState {
  nodes: RaftNode[];
  packets: Packet[];
  paused: boolean;
  speedMultiplier: number;
  globalTerm: number; // Just for stats
  logsCommitted: number;
}