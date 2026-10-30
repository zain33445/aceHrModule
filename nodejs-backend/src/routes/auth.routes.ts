import { Router } from 'express';
import prisma from '../prisma';
import {
  findSessionUser,
  signSessionToken,
  TOKEN_EXPIRED_CODE,
  verifyUserToken,
} from '../middleware/requireUser';

const router = Router();

// Basic login logic compatible with the old Python API
router.post('/login', async (req, res) => {
  const { username, password } = req.body;
  try {
    const user = await prisma.user.findFirst({
      where: {
        OR: [
          { username: username },
          { id: username }
        ],
        password_hash: password
      },
      include: {
        led_departments: {
          select: { id: true }
        }
      }
    });
    
    if (!user) {
      return res.status(401).json({ detail: "Invalid username or password" });
    }

    // One row per sign-in, so logging out on one device ends only that one.
    const session = await prisma.userSession.create({ data: { user_id: user.id } });

    res.json({
      user_id: user.id,
      name: user.name,
      role: user.role,
      is_lead: user.led_departments.length > 0,
      // Signed session token. Additive — the fields above are unchanged so
      // existing clients keep working. Used by the strict (requireUser) routes.
      token: signSessionToken({ id: user.id, name: user.name, role: user.role }, session.id),
    });
  } catch (error) {
    res.status(500).json({ msg: "Internal server error", error });
  }
});

/** The bearer token, verified but allowed to be expired. */
function bearerPayload(req: any) {
  const header = String(req.headers.authorization || '');
  if (!header.startsWith('Bearer ')) return null;
  const payload = verifyUserToken(header.substring(7), { ignoreExpiration: true });
  return payload?.typ === 'session' && payload.sessionId ? payload : null;
}

// Trade a (possibly expired) session token for a fresh one. Works for as long
// as the session has not been logged out.
router.post('/refresh', async (req, res) => {
  const payload = bearerPayload(req);
  try {
    const user = payload && (await findSessionUser(payload.sessionId!, payload.userId));
    if (!user || user.status !== 'active') {
      return res.status(401).json({ error: 'Session has ended.', code: TOKEN_EXPIRED_CODE });
    }
    res.json({ token: signSessionToken(user, payload!.sessionId!) });
  } catch (error) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Revoke the session: every token issued for it stops working immediately.
router.post('/logout', async (req, res) => {
  const payload = bearerPayload(req);
  try {
    if (payload) {
      await prisma.userSession.updateMany({
        where: { id: payload.sessionId, user_id: payload.userId, revoked_at: null },
        data: { revoked_at: new Date() },
      });
    }
    res.json({ ok: true });
  } catch (error) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Update password
router.post('/update-password', async (req, res) => {
  const { user_id, new_password } = req.body;
  try {
    await prisma.user.update({
      where: { id: String(user_id) },
      data: { password_hash: new_password }
    });
    res.json({ message: "Password updated successfully" });
  } catch (error) {
    res.status(500).json({ error: "Failed to update password" });
  }
});

// Change password (secure, requires current password verification)
router.post('/change-password', async (req, res) => {
  const { user_id, current_password, new_password } = req.body;
  try {
    const user = await prisma.user.findFirst({
      where: { id: String(user_id), password_hash: current_password }
    });
    
    if (!user) {
      return res.status(401).json({ detail: "Incorrect current password" });
    }

    await prisma.user.update({
      where: { id: String(user_id) },
      data: { password_hash: new_password }
    });
    res.json({ message: "Password changed successfully" });
  } catch (error) {
    res.status(500).json({ detail: "Failed to update password" });
  }
});

export default router;
