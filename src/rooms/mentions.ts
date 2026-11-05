import type { ActorId } from '../agent.js';
import type { AgentId } from './types.js';

/**
 * Match complete room agent IDs, not emails or ID prefixes;
 * unknown mentions remain ordinary text.
 */
export function roomMentions(text: string, participants: readonly ActorId[]): AgentId[] {
  const members = new Set(participants.filter((id): id is AgentId => id.startsWith('agent:')));
  const mentions = new Set<AgentId>();
  // Allow adjacent Han characters and common punctuation, but not adjoining English identifiers.
  for (const match of text.matchAll(
    /(?:^|[\s([{"',!?;:，。！？：；、\p{Script=Han}])@([a-zA-Z0-9][a-zA-Z0-9_.-]{0,127})(?=$|[\s)\]}"',!?;:，。！？：；、\p{Script=Han}])/gu,
  )) {
    const id: AgentId = `agent:${match[1]}`;
    const withoutSentencePeriod: AgentId = `agent:${match[1]!.replace(/\.+$/, '')}`;
    // Dots are valid in IDs: try the full ID before removing sentence periods;
    // never truncate a.other.
    if (members.has(id)) mentions.add(id);
    else if (members.has(withoutSentencePeriod)) mentions.add(withoutSentencePeriod);
  }
  return [...mentions];
}
