interface Session {
  conversationId: string;
  workingDirectory: string;
  createdAt: Date;
  lastActivity: Date;
}

class SessionManager {
  private sessions: Map<number, Session> = new Map();

  getSession(chatId: number): Session | undefined {
    return this.sessions.get(chatId);
  }

  createSession(chatId: number, workingDirectory: string): Session {
    const session: Session = {
      conversationId: this.generateConversationId(),
      workingDirectory,
      createdAt: new Date(),
      lastActivity: new Date(),
    };
    this.sessions.set(chatId, session);
    return session;
  }

  updateActivity(chatId: number): void {
    const session = this.sessions.get(chatId);
    if (session) {
      session.lastActivity = new Date();
    }
  }

  setWorkingDirectory(chatId: number, directory: string): Session {
    const existing = this.sessions.get(chatId);
    if (existing) {
      existing.workingDirectory = directory;
      existing.lastActivity = new Date();
      return existing;
    }
    return this.createSession(chatId, directory);
  }

  clearSession(chatId: number): void {
    this.sessions.delete(chatId);
  }

  private generateConversationId(): string {
    return `conv_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
  }
}

export const sessionManager = new SessionManager();
