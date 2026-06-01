/**
 * requireAgentToken.ts — JWT-based agent authentication middleware.
 *
 * The Electron agent authenticates independently from the user session.
 * Tokens are issued via POST /api/recording/agent-auth and signed with
 * AGENT_JWT_SECRET. They carry { sub: userId, role: 'agent' }.
 */

import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';

const AGENT_SECRET = process.env.AGENT_JWT_SECRET || 'ace-agent-secret-change-in-prod';

export interface AgentPayload {
  userId: string;
}

/**
 * Express middleware — validates agent JWT from Authorization: Bearer <token> header.
 */
export function requireAgentToken(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  const authHeader = req.headers.authorization;

  if (!authHeader?.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Agent token required. Use Authorization: Bearer <token>.' });
    return;
  }

  const token = authHeader.substring(7);

  try {
    const decoded = jwt.verify(token, AGENT_SECRET) as any;

    if (decoded.role !== 'agent') {
      res.status(403).json({ error: 'Invalid token role. Not an agent token.' });
      return;
    }

    (req as any).agentUser = { userId: decoded.sub } as AgentPayload;
    next();
  } catch (err: any) {
    res.status(401).json({ error: 'Invalid or expired agent token.' });
  }
}

/**
 * Signs a new agent JWT for the given userId. Valid for 30 days.
 */
export function signAgentToken(userId: string): string {
  return jwt.sign({ sub: userId, role: 'agent' }, AGENT_SECRET, {
    expiresIn: '30d',
  });
}

/**
 * Validates a raw agent token string (used by WebSocket gateway).
 * Returns the payload or null if invalid.
 */
export function verifyAgentToken(token: string): AgentPayload | null {
  try {
    const decoded = jwt.verify(token, AGENT_SECRET) as any;
    if (decoded.role !== 'agent') return null;
    return { userId: decoded.sub };
  } catch {
    return null;
  }
}
