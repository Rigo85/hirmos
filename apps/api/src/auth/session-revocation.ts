import { EventEmitter } from 'node:events';

export class SessionRevocationNotifier {
  private readonly events = new EventEmitter();

  public session(sessionId: string): void {
    this.events.emit('session', sessionId);
  }

  public user(userId: string): void {
    this.events.emit('user', userId);
  }

  public onSession(listener: (sessionId: string) => void): () => void {
    this.events.on('session', listener);
    return () => this.events.off('session', listener);
  }

  public onUser(listener: (userId: string) => void): () => void {
    this.events.on('user', listener);
    return () => this.events.off('user', listener);
  }
}
