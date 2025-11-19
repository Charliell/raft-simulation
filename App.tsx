import React, { useState, useEffect, useRef, useCallback } from 'react';
import { RaftNode, NodeState, Packet, PacketType, LogEntry } from './types';
import * as Logic from './utils/raftLogic';
import { explainClusterState } from './services/ai';

// --- Icons ---
const PlayIcon = () => <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polygon points="5 3 19 12 5 21 5 3"></polygon></svg>;
const PauseIcon = () => <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="6" y="4" width="4" height="16"></rect><rect x="14" y="4" width="4" height="16"></rect></svg>;
const PlusIcon = () => <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="12" y1="5" x2="12" y2="19"></line><line x1="5" y1="12" x2="19" y2="12"></line></svg>;
const RefreshIcon = () => <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="23 4 23 10 17 10"></polyline><polyline points="1 20 1 14 7 14"></polyline><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"></path></svg>;
const SparklesIcon = () => <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="m12 3-1.912 5.813a2 2 0 0 1-1.275 1.275L3 12l5.813 1.912a2 2 0 0 1 1.275 1.275L12 21l1.912-5.813a2 2 0 0 1 1.275-1.275L21 12l-5.813-1.912a2 2 0 0 1-1.275-1.275L12 3Z"/></svg>;

const NODE_COUNT = 5;
const TICK_RATE = 30; // ms

export default function App() {
  // --- State ---
  const [nodes, setNodes] = useState<RaftNode[]>([]);
  const [packets, setPackets] = useState<Packet[]>([]);
  const [paused, setPaused] = useState(false);
  const [votesReceived, setVotesReceived] = useState<Record<number, Set<number>>>({});
  const [playbackSpeed, setPlaybackSpeed] = useState(1);
  const [aiAnalysis, setAiAnalysis] = useState<string>("");
  const [isAnalyzing, setIsAnalyzing] = useState(false);

  // Refs for mutable state during tick to avoid stale closures without massive dependency arrays
  const stateRef = useRef({
    nodes: [] as RaftNode[],
    packets: [] as Packet[],
    votesReceived: {} as Record<number, Set<number>>,
  });

  // Initialize
  useEffect(() => {
    const initialNodes = Array.from({ length: NODE_COUNT }, (_, i) => Logic.createNode(i, NODE_COUNT));
    setNodes(initialNodes);
    stateRef.current.nodes = initialNodes;
    
    // Initialize votes tracking
    const initialVotes: Record<number, Set<number>> = {};
    initialNodes.forEach(n => initialVotes[n.id] = new Set());
    setVotesReceived(initialVotes);
    stateRef.current.votesReceived = initialVotes;
  }, []);

  // --- Helpers ---
  const broadcast = (sender: RaftNode, type: PacketType, payload: any, nodesList: RaftNode[]) => {
    const newPackets: Packet[] = nodesList
      .filter(n => n.id !== sender.id && n.state !== NodeState.CRASHED)
      .map(target => ({
        id: crypto.randomUUID(),
        from: sender.id,
        to: target.id,
        type,
        payload,
        progress: 0,
        speed: Logic.PACKET_SPEED * playbackSpeed
      }));
    return newPackets;
  };

  // --- The Tick Loop ---
  const tick = useCallback(() => {
    if (paused) return;

    let currentNodes = [...stateRef.current.nodes];
    let currentPackets = [...stateRef.current.packets];
    let currentVotes = { ...stateRef.current.votesReceived };

    // 1. Move Packets
    const survivingPackets: Packet[] = [];
    const arrivedPackets: Packet[] = [];

    currentPackets.forEach(p => {
      p.progress += p.speed;
      if (p.progress >= 100) {
        arrivedPackets.push(p);
      } else {
        survivingPackets.push(p);
      }
    });

    // 2. Process Arrived Packets
    arrivedPackets.forEach(packet => {
      const targetNodeIndex = currentNodes.findIndex(n => n.id === packet.to);
      if (targetNodeIndex === -1) return;
      let targetNode = currentNodes[targetNodeIndex];

      if (targetNode.state === NodeState.CRASHED) return;

      // Process based on type
      if (packet.type === PacketType.REQUEST_VOTE) {
        const { updatedNode, replyPacket } = Logic.processRequestVote(targetNode, packet);
        currentNodes[targetNodeIndex] = updatedNode;
        if (replyPacket) survivingPackets.push(replyPacket);
      } 
      else if (packet.type === PacketType.VOTE_RESPONSE) {
        const { updatedNode } = Logic.processVoteResponse(targetNode, packet, NODE_COUNT);
        currentNodes[targetNodeIndex] = updatedNode;
        
        const { term, voteGranted } = packet.payload;
        // Handle vote counting in the "Controllers" logic here in the loop
        if (updatedNode.state === NodeState.CANDIDATE && term === updatedNode.currentTerm && voteGranted) {
           if (!currentVotes[updatedNode.id]) currentVotes[updatedNode.id] = new Set();
           currentVotes[updatedNode.id].add(packet.from);
           
           // Check for Victory
           if (currentVotes[updatedNode.id].size + 1 > NODE_COUNT / 2) { // +1 for self
             updatedNode.state = NodeState.LEADER;
             updatedNode.heartbeatTimer = 0; // Send immediately
             // Initialize leader volatile state
             currentNodes.forEach(n => {
               updatedNode.nextIndex[n.id] = updatedNode.log.length;
               updatedNode.matchIndex[n.id] = 0;
             });
             // Clear vote tracker for next time
             currentVotes[updatedNode.id] = new Set();
           }
        }
      }
      else if (packet.type === PacketType.APPEND_ENTRIES) {
        const { updatedNode, replyPacket } = Logic.processAppendEntries(targetNode, packet);
        currentNodes[targetNodeIndex] = updatedNode;
        if (replyPacket) survivingPackets.push(replyPacket);
      }
      else if (packet.type === PacketType.APPEND_RESPONSE) {
        // Leader processing response
        const { term, success, matchIndex } = packet.payload;
        if (term > targetNode.currentTerm) {
          targetNode.state = NodeState.FOLLOWER;
          targetNode.currentTerm = term;
          targetNode.votedFor = null;
        } else if (targetNode.state === NodeState.LEADER && term === targetNode.currentTerm) {
          if (success) {
            targetNode.matchIndex[packet.from] = matchIndex;
            targetNode.nextIndex[packet.from] = matchIndex + 1;
            
            // Check commit index update
            // If there exists an N such that N > commitIndex, a majority of matchIndex[i] >= N, and log[N].term == currentTerm: set commitIndex = N
            const matchIndexes = [targetNode.log.length - 1, ...Object.values(targetNode.matchIndex)] as number[];
            matchIndexes.sort((a, b) => b - a); // Descending
            // Majority index is at floor(total/2)
            const majorityN = matchIndexes[Math.floor(NODE_COUNT / 2)];
            
            if (majorityN > targetNode.commitIndex && targetNode.log[majorityN] && targetNode.log[majorityN].term === targetNode.currentTerm) {
                targetNode.commitIndex = majorityN;
            }
          } else {
            // Failed, decrement nextIndex
            targetNode.nextIndex[packet.from] = Math.max(0, (targetNode.nextIndex[packet.from] || 1) - 1);
          }
        }
        currentNodes[targetNodeIndex] = targetNode;
      }
    });

    // 3. Node Maintenance (Timeouts, Heartbeats)
    currentNodes = currentNodes.map(node => {
      if (node.state === NodeState.CRASHED) return node;

      let updatedNode = { ...node };

      // Election Timeout (Follower/Candidate)
      if (updatedNode.state !== NodeState.LEADER) {
        updatedNode.electionTimeout -= 1;
        if (updatedNode.electionTimeout <= 0) {
          // Start Election
          updatedNode.state = NodeState.CANDIDATE;
          updatedNode.currentTerm += 1;
          updatedNode.votedFor = updatedNode.id;
          currentVotes[updatedNode.id] = new Set(); // Reset votes
          updatedNode.currentTimeoutDuration = Logic.getRandomTimeout();
          updatedNode.electionTimeout = updatedNode.currentTimeoutDuration;

          // Broadcast RequestVote
          const lastLogIndex = updatedNode.log.length - 1;
          const lastLogTerm = lastLogIndex >= 0 ? updatedNode.log[lastLogIndex].term : -1;
          
          const votePackets = broadcast(updatedNode, PacketType.REQUEST_VOTE, {
            term: updatedNode.currentTerm,
            candidateId: updatedNode.id,
            lastLogIndex,
            lastLogTerm
          }, currentNodes);
          survivingPackets.push(...votePackets);
        }
      }

      // Heartbeats (Leader)
      if (updatedNode.state === NodeState.LEADER) {
        updatedNode.heartbeatTimer -= 1;
        if (updatedNode.heartbeatTimer <= 0) {
          updatedNode.heartbeatTimer = Logic.HEARTBEAT_INTERVAL;
          
          // Send AppendEntries to all
          currentNodes.forEach(peer => {
             if (peer.id === updatedNode.id || peer.state === NodeState.CRASHED) return;
             
             const prevLogIndex = (updatedNode.nextIndex[peer.id] || 1) - 1;
             const prevLogTerm = prevLogIndex >= 0 && prevLogIndex < updatedNode.log.length 
                ? updatedNode.log[prevLogIndex].term 
                : -1; // -1 implies beginning
             
             const entries = updatedNode.log.slice(prevLogIndex + 1);

             survivingPackets.push({
               id: crypto.randomUUID(),
               from: updatedNode.id,
               to: peer.id,
               type: PacketType.APPEND_ENTRIES,
               payload: {
                 term: updatedNode.currentTerm,
                 leaderId: updatedNode.id,
                 prevLogIndex,
                 prevLogTerm,
                 entries,
                 leaderCommit: updatedNode.commitIndex
               },
               progress: 0,
               speed: Logic.PACKET_SPEED * playbackSpeed
             });
          });
        }
      }

      return updatedNode;
    });

    // Update Refs and State
    stateRef.current.nodes = currentNodes;
    stateRef.current.packets = survivingPackets;
    stateRef.current.votesReceived = currentVotes;
    
    setNodes(currentNodes);
    setPackets(survivingPackets);
    setVotesReceived(currentVotes);

  }, [paused, playbackSpeed]);

  // --- Timer Hook ---
  useEffect(() => {
    const interval = setInterval(tick, TICK_RATE);
    return () => clearInterval(interval);
  }, [tick]);

  // --- User Actions ---

  const toggleNodeState = (id: number) => {
    const newNodes = [...stateRef.current.nodes];
    const node = newNodes.find(n => n.id === id);
    if (node) {
      if (node.state === NodeState.CRASHED) {
        node.state = NodeState.FOLLOWER;
        node.electionTimeout = Logic.getRandomTimeout();
      } else {
        node.state = NodeState.CRASHED;
      }
    }
    stateRef.current.nodes = newNodes;
    setNodes(newNodes);
  };

  const proposeLog = () => {
    const newNodes = [...stateRef.current.nodes];
    const leader = newNodes.find(n => n.state === NodeState.LEADER);
    if (leader) {
      const commands = ["SET X=5", "ADD USER", "DEL DB", "INC Y", "MOV A->B"];
      const cmd = commands[Math.floor(Math.random() * commands.length)];
      const entry: LogEntry = { term: leader.currentTerm, command: cmd };
      leader.log.push(entry);
      stateRef.current.nodes = newNodes;
      setNodes(newNodes);
    } else {
      alert("No Leader elected to propose entry!");
    }
  };

  const handleAnalyze = async () => {
    setIsAnalyzing(true);
    setAiAnalysis("Analyzing cluster state...");
    const result = await explainClusterState(stateRef.current.nodes, paused);
    setAiAnalysis(result);
    setIsAnalyzing(false);
  };

  // --- Rendering Helpers ---
  const getNodeColor = (state: NodeState) => {
    switch (state) {
      case NodeState.LEADER: return 'bg-emerald-500 border-emerald-300 shadow-[0_0_30px_rgba(16,185,129,0.5)]';
      case NodeState.CANDIDATE: return 'bg-amber-500 border-amber-300 shadow-[0_0_30px_rgba(245,158,11,0.5)]';
      case NodeState.CRASHED: return 'bg-red-900/50 border-red-800 text-red-500 grayscale';
      default: return 'bg-slate-700 border-slate-500';
    }
  };

  return (
    <div className="w-full h-screen flex flex-col md:flex-row bg-slate-950 text-slate-100 font-sans selection:bg-indigo-500/30">
      
      {/* Left: Controls & Info */}
      <div className="w-full md:w-80 border-r border-slate-800 flex flex-col bg-slate-900/50 p-6 gap-6 overflow-y-auto z-10 backdrop-blur-md">
        <header>
          <h1 className="text-2xl font-bold bg-gradient-to-r from-indigo-400 to-cyan-400 bg-clip-text text-transparent">Raft Visualizer</h1>
          <p className="text-sm text-slate-400 mt-1">Distributed Consensus Protocol</p>
        </header>

        <div className="space-y-4">
          <div className="flex items-center gap-2 bg-slate-800/50 p-2 rounded-lg border border-slate-700">
            <button onClick={() => setPaused(!paused)} className="p-2 hover:bg-slate-700 rounded-md transition-colors">
              {paused ? <PlayIcon /> : <PauseIcon />}
            </button>
            <div className="h-6 w-px bg-slate-700 mx-1"></div>
            <button onClick={proposeLog} className="flex-1 flex items-center justify-center gap-2 bg-indigo-600 hover:bg-indigo-500 text-sm font-medium py-1.5 rounded-md transition-all active:scale-95 disabled:opacity-50 disabled:cursor-not-allowed" disabled={paused}>
              <PlusIcon /> Add Log
            </button>
          </div>
          
          <div className="space-y-2">
             <label className="text-xs font-semibold text-slate-500 uppercase tracking-wider">Simulation Speed</label>
             <input 
              type="range" 
              min="0.5" 
              max="5" 
              step="0.5" 
              value={playbackSpeed}
              onChange={(e) => setPlaybackSpeed(parseFloat(e.target.value))}
              className="w-full accent-indigo-500 h-1.5 bg-slate-700 rounded-lg appearance-none cursor-pointer"
             />
          </div>
        </div>

        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold text-slate-400 uppercase tracking-wider">Legend</h2>
            <button onClick={handleAnalyze} disabled={isAnalyzing} className="text-xs flex items-center gap-1 text-cyan-400 hover:text-cyan-300 transition-colors">
              <SparklesIcon /> AI Explain
            </button>
          </div>
          
          <div className="grid grid-cols-2 gap-2 text-xs">
            <div className="flex items-center gap-2"><div className="w-3 h-3 rounded-full bg-emerald-500 shadow-emerald-500/50 shadow-sm"></div> Leader</div>
            <div className="flex items-center gap-2"><div className="w-3 h-3 rounded-full bg-amber-500 shadow-amber-500/50 shadow-sm"></div> Candidate</div>
            <div className="flex items-center gap-2"><div className="w-3 h-3 rounded-full bg-slate-600"></div> Follower</div>
            <div className="flex items-center gap-2"><div className="w-3 h-3 rounded-full bg-red-900 border border-red-500"></div> Crashed</div>
          </div>

          {aiAnalysis && (
            <div className="bg-slate-800/80 border border-slate-700 p-3 rounded-lg text-sm text-slate-300 leading-relaxed shadow-inner animate-in fade-in slide-in-from-top-2 duration-500">
              <strong className="text-indigo-400 block mb-1">Gemini Analysis:</strong>
              {aiAnalysis}
            </div>
          )}
        </div>

        <div className="flex-1 overflow-y-auto">
           <h2 className="text-sm font-semibold text-slate-400 uppercase tracking-wider mb-3">Cluster Status</h2>
           <div className="space-y-2">
             {nodes.map(node => (
               <div key={node.id} className="flex items-center justify-between p-2 rounded bg-slate-800/30 border border-slate-800 text-xs">
                 <div className="flex items-center gap-2">
                   <div className={`w-2 h-2 rounded-full ${node.state === NodeState.LEADER ? 'bg-emerald-500' : node.state === NodeState.CANDIDATE ? 'bg-amber-500' : node.state === NodeState.CRASHED ? 'bg-red-500' : 'bg-slate-500'}`}></div>
                   <span className="font-mono text-slate-300">Node {node.id}</span>
                 </div>
                 <div className="flex gap-2">
                   <span className="text-slate-500">Term: {node.currentTerm}</span>
                   <button onClick={() => toggleNodeState(node.id)} className="text-slate-400 hover:text-red-400 transition-colors" title="Toggle Crash">
                     <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M18.36 6.64a9 9 0 1 1-12.73 0"></path><line x1="12" y1="2" x2="12" y2="12"></line></svg>
                   </button>
                 </div>
               </div>
             ))}
           </div>
        </div>
      </div>

      {/* Right: Visualization Area */}
      <div className="flex-1 relative bg-slate-950 overflow-hidden flex items-center justify-center">
        {/* Grid Background */}
        <div className="absolute inset-0 bg-[linear-gradient(to_right,#80808012_1px,transparent_1px),linear-gradient(to_bottom,#80808012_1px,transparent_1px)] bg-[size:24px_24px]"></div>
        
        <div className="relative w-[600px] h-[600px]">
          
          {/* Packets Layer (SVG) */}
          <svg className="absolute inset-0 w-full h-full pointer-events-none z-20 overflow-visible">
            {packets.map(p => {
               const source = nodes.find(n => n.id === p.from);
               const target = nodes.find(n => n.id === p.to);
               if (!source || !target) return null;
               
               const x = source.x + (target.x - source.x) * (p.progress / 100);
               const y = source.y + (target.y - source.y) * (p.progress / 100);
               
               let color = '#94a3b8'; // Default
               if (p.type === PacketType.REQUEST_VOTE) color = '#f59e0b'; // Amber
               if (p.type === PacketType.VOTE_RESPONSE) color = '#f59e0b'; // Amber
               if (p.type === PacketType.APPEND_ENTRIES) color = '#10b981'; // Emerald
               
               return (
                 <g key={p.id}>
                   <circle cx={x} cy={y} r="5" fill={color} className="shadow-lg" />
                   {/* Optional: Trace line */}
                   {/* <line x1={source.x} y1={source.y} x2={target.x} y2={target.y} stroke={color} strokeWidth="1" strokeOpacity="0.2" /> */}
                 </g>
               );
            })}
          </svg>

          {/* Nodes Layer */}
          {nodes.map(node => (
            <div 
              key={node.id}
              className={`absolute w-28 h-28 -ml-14 -mt-14 rounded-full border-4 flex flex-col items-center justify-center transition-all duration-300 z-30 ${getNodeColor(node.state)}`}
              style={{ left: node.x, top: node.y }}
            >
              <div className="text-xs font-bold mb-1">Node {node.id}</div>
              <div className="text-[10px] opacity-80">Term: {node.currentTerm}</div>
              
              {/* Timer Ring (Visualization of election timeout) */}
              {node.state !== NodeState.LEADER && node.state !== NodeState.CRASHED && (
                  <svg className="absolute inset-0 w-full h-full -rotate-90 pointer-events-none">
                    <circle 
                      cx="50%" cy="50%" r="52" 
                      fill="none" stroke="currentColor" strokeWidth="2" 
                      className="text-white opacity-20"
                      strokeDasharray="326"
                      strokeDashoffset={326 - (326 * (node.electionTimeout / node.currentTimeoutDuration))}
                      style={{ transition: 'stroke-dashoffset 30ms linear' }}
                    />
                  </svg>
              )}

              {/* State Badge */}
              <div className="absolute -bottom-3 bg-slate-900 text-[9px] px-2 py-0.5 rounded-full border border-slate-700 text-slate-300 uppercase tracking-wider">
                {node.state}
              </div>

              {/* Log Visualization Container */}
              <div className="absolute top-0 left-full ml-4 w-32 flex flex-col gap-1 pointer-events-none">
                 {node.log.slice(-5).map((entry, idx) => {
                   // Calculate actual index
                   const realIndex = node.log.length - 5 + idx;
                   const isCommitted = realIndex <= node.commitIndex;
                   return (
                    <div key={idx} className={`text-[10px] px-2 py-1 rounded border backdrop-blur-sm transition-all ${isCommitted ? 'bg-slate-800/90 border-indigo-500/50 text-indigo-200' : 'bg-slate-900/50 border-slate-700 text-slate-500'}`}>
                       <span className="opacity-50 mr-1">{entry.term}:</span>{entry.command}
                    </div>
                   )
                 })}
                 {node.log.length > 5 && <div className="text-[9px] text-slate-500 pl-1">... {node.log.length - 5} more</div>}
              </div>
            </div>
          ))}

        </div>

        <div className="absolute bottom-6 right-6 text-slate-500 text-xs text-right pointer-events-none">
           <p>Packets in flight: {packets.length}</p>
           <p>Global Term Max: {Math.max(...nodes.map(n => n.currentTerm))}</p>
        </div>
      </div>
    </div>
  );
}