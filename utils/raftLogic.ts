import { RaftNode, NodeState, Packet, PacketType, LogEntry } from "../types";

export const MIN_ELECTION_TIMEOUT = 150;
export const MAX_ELECTION_TIMEOUT = 300;
export const HEARTBEAT_INTERVAL = 50;
export const PACKET_SPEED = 1.5;

export const getRandomTimeout = () => 
  Math.floor(Math.random() * (MAX_ELECTION_TIMEOUT - MIN_ELECTION_TIMEOUT + 1) + MIN_ELECTION_TIMEOUT);

export const createNode = (id: number, totalNodes: number): RaftNode => {
  const angle = (id / totalNodes) * 2 * Math.PI - Math.PI / 2;
  const radius = 180; // px
  const centerX = 300;
  const centerY = 300;

  return {
    id,
    state: NodeState.FOLLOWER,
    currentTerm: 0,
    votedFor: null,
    log: [],
    commitIndex: -1,
    electionTimeout: getRandomTimeout(),
    currentTimeoutDuration: getRandomTimeout(),
    nextIndex: {},
    matchIndex: {},
    heartbeatTimer: 0,
    x: centerX + radius * Math.cos(angle),
    y: centerY + radius * Math.sin(angle),
  };
};

// --- Packet Processors ---

export const processRequestVote = (node: RaftNode, packet: Packet): { updatedNode: RaftNode, replyPacket?: Packet } => {
  const { term, candidateId, lastLogIndex, lastLogTerm } = packet.payload;
  let updatedNode = { ...node };
  let voteGranted = false;

  // Rule: If RPC request or response contains term T > currentTerm: set currentTerm = T, convert to follower
  if (term > updatedNode.currentTerm) {
    updatedNode.currentTerm = term;
    updatedNode.state = NodeState.FOLLOWER;
    updatedNode.votedFor = null;
  }

  // Vote Logic
  const myLastLogIndex = updatedNode.log.length - 1;
  const myLastLogTerm = myLastLogIndex >= 0 ? updatedNode.log[myLastLogIndex].term : -1;
  
  const logIsUpToDate = (lastLogTerm > myLastLogTerm) || 
                        (lastLogTerm === myLastLogTerm && lastLogIndex >= myLastLogIndex);

  if (
    term >= updatedNode.currentTerm &&
    (updatedNode.votedFor === null || updatedNode.votedFor === candidateId) &&
    logIsUpToDate
  ) {
    voteGranted = true;
    updatedNode.votedFor = candidateId;
    // Granting vote resets election timer
    updatedNode.electionTimeout = updatedNode.currentTimeoutDuration;
  }

  const replyPacket: Packet = {
    id: crypto.randomUUID(),
    from: node.id,
    to: candidateId,
    type: PacketType.VOTE_RESPONSE,
    payload: { term: updatedNode.currentTerm, voteGranted },
    progress: 0,
    speed: PACKET_SPEED
  };

  return { updatedNode, replyPacket };
};

export const processVoteResponse = (node: RaftNode, packet: Packet, totalNodes: number): { updatedNode: RaftNode, newPackets: Packet[] } => {
  const { term, voteGranted } = packet.payload;
  let updatedNode = { ...node };
  let newPackets: Packet[] = [];

  if (term > updatedNode.currentTerm) {
    updatedNode.currentTerm = term;
    updatedNode.state = NodeState.FOLLOWER;
    updatedNode.votedFor = null;
    return { updatedNode, newPackets };
  }

  if (updatedNode.state === NodeState.CANDIDATE && voteGranted && term === updatedNode.currentTerm) {
    // Count votes (simplified: we don't store vote count in state, we'd ideally need to, 
    // but for visualization we can assume if we are still candidate we are collecting)
    // **Visualization Shortcut**: To do this properly without complex vote tracking in the "node" object 
    // (which makes the object heavy), we will trust that the simulation engine handles counting 
    // or we add a transient field. 
    // Let's check specific logic: A node needs to know how many votes it has. 
    // We'll add a temporary property check in the main loop or just check the messages. 
    
    // Actually, let's stick to standard Raft:
    // Since we don't want to mutate the node type definition too much, let's assume 
    // we process votes in the main loop? No, that's messy.
    // Let's just add a 'votesReceived' set to the node type in a real app. 
    // For this demo, we'll assume the Node state handles transition if we detect majority.
    
    // REVISION: We will handle majority check in the main loop by counting incoming packets 
    // before they disappear? No, packets disappear once processed. 
    // Okay, let's add `votesReceived` to the node state for correctness.
  }

  return { updatedNode, newPackets };
};

export const processAppendEntries = (node: RaftNode, packet: Packet): { updatedNode: RaftNode, replyPacket?: Packet } => {
  const { term, leaderId, prevLogIndex, prevLogTerm, entries, leaderCommit } = packet.payload;
  let updatedNode = { ...node };
  let success = false;

  if (term >= updatedNode.currentTerm) {
      updatedNode.currentTerm = term;
      updatedNode.state = NodeState.FOLLOWER;
      updatedNode.votedFor = null; // Reset vote if we see a valid leader (usually) or just updated term
      updatedNode.electionTimeout = updatedNode.currentTimeoutDuration; // Heartbeat received
  }

  if (term < updatedNode.currentTerm) {
    success = false;
  } else {
    // Log Consistency Check
    // Does log contain an entry at prevLogIndex with term prevLogTerm?
    const logOk = prevLogIndex === -1 || 
                  (updatedNode.log.length > prevLogIndex && updatedNode.log[prevLogIndex].term === prevLogTerm);
    
    if (!logOk) {
      success = false;
    } else {
      success = true;
      // Insert entries
      // If an existing entry conflicts with a new one (same index but different terms), 
      // delete the existing entry and all that follow it
      let logInsertIndex = prevLogIndex + 1;
      let newEntriesIndex = 0;

      while(newEntriesIndex < entries.length) {
        if (logInsertIndex >= updatedNode.log.length) {
            updatedNode.log.push(entries[newEntriesIndex]);
        } else if (updatedNode.log[logInsertIndex].term !== entries[newEntriesIndex].term) {
            // Conflict, truncate and replace
            updatedNode.log = updatedNode.log.slice(0, logInsertIndex);
            updatedNode.log.push(entries[newEntriesIndex]);
        }
        // If match, keep going
        logInsertIndex++;
        newEntriesIndex++;
      }

      // Update commit index
      if (leaderCommit > updatedNode.commitIndex) {
        updatedNode.commitIndex = Math.min(leaderCommit, updatedNode.log.length - 1);
      }
    }
  }

  const replyPacket: Packet = {
    id: crypto.randomUUID(),
    from: node.id,
    to: leaderId,
    type: PacketType.APPEND_RESPONSE,
    payload: { term: updatedNode.currentTerm, success, matchIndex: updatedNode.log.length - 1 },
    progress: 0,
    speed: PACKET_SPEED
  };

  return { updatedNode, replyPacket };
};
