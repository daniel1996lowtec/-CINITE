/** Ephemeral text-only channel on the existing lobby socket. No separate transport. */
export interface ChatMessage {
  id: string;
  roomCode: string;
  senderId: string;
  senderName: string;
  text: string;
  sentAt: number;
}
export type ChatEvent = {type: 'state'; roomCode: string | null}
  | {type: 'message'; message: ChatMessage} | {type: 'error'; reason: string};

export class RoomTextChat {
  public roomCode: string | null = null;
  private readonly listeners = new Set<(event: ChatEvent) => void>();
  private readonly seen = new Set<string>();

  public subscribe(listener: (event: ChatEvent) => void): () => void {
    this.listeners.add(listener);
    listener({type: 'state', roomCode: this.roomCode});
    return () => { this.listeners.delete(listener); };
  }
  private emit(event: ChatEvent): void { for (const listener of this.listeners) listener(event); }
  public joined(roomCode: string): void {
    this.seen.clear(); this.roomCode = roomCode;
    this.emit({type: 'state', roomCode});
  }
  public reset(): void {
    this.seen.clear(); this.roomCode = null;
    this.emit({type: 'state', roomCode: null});
  }
  public receive(packet: Record<string, unknown>): void {
    if (!this.roomCode || packet.roomCode !== this.roomCode) return;
    if (packet.type === 'chat_rejected') {
      const reason = packet.code === 'rate_limited' ? 'Slow down: 5 messages per 10 seconds.'
        : 'Use 1–240 characters on one line.';
      this.emit({type: 'error', reason}); return;
    }
    if (packet.type !== 'chat_message') return;
    const {id, senderId, senderName, text, sentAt} = packet;
    if (typeof id !== 'string' || !id || id.length > 64 || this.seen.has(id) ||
      typeof senderId !== 'string' || senderId.length > 128 ||
      typeof senderName !== 'string' || senderName.length > 64 ||
      typeof text !== 'string' || !text.trim() || text.length > 240 ||
      typeof sentAt !== 'number' || !Number.isFinite(sentAt)) return;
    this.seen.add(id);
    if (this.seen.size > 100) this.seen.delete(this.seen.values().next().value!);
    this.emit({type: 'message', message: {id, roomCode: this.roomCode, senderId, senderName, text, sentAt}});
  }
}
