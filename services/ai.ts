import { GoogleGenAI } from "@google/genai";
import { RaftNode, NodeState } from "../types";

// Initialize the client with the API key from the environment
const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });

export const explainClusterState = async (nodes: RaftNode[], paused: boolean): Promise<string> => {
  try {
    const activeLeader = nodes.find(n => n.state === NodeState.LEADER);
    const candidates = nodes.filter(n => n.state === NodeState.CANDIDATE);
    const crashed = nodes.filter(n => n.state === NodeState.CRASHED);
    
    const summary = {
      totalNodes: nodes.length,
      leaderId: activeLeader ? activeLeader.id : "None",
      currentTerm: Math.max(...nodes.map(n => n.currentTerm)),
      candidates: candidates.map(c => c.id),
      crashedNodes: crashed.map(c => c.id),
      logDepths: nodes.map(n => ({ id: n.id, logLength: n.log.length, commitIndex: n.commitIndex }))
    };

    const prompt = `
      You are an expert distributed systems engineer. Analyze this specific Raft Consensus state:
      ${JSON.stringify(summary, null, 2)}

      The simulation is currently ${paused ? "PAUSED" : "RUNNING"}.
      
      Explain what is happening in the cluster briefly (max 3 sentences). 
      - Is the cluster healthy? 
      - Is an election happening? 
      - Are logs inconsistent?
      
      Do not use markdown formatting like bolding or headers. Just plain text.
    `;

    const response = await ai.models.generateContent({
      model: 'gemini-2.5-flash',
      contents: prompt,
    });

    return response.text || "Unable to analyze state.";
  } catch (error) {
    console.error("Gemini Error:", error);
    return "Error connecting to AI analysis service. Please check your API Key.";
  }
};