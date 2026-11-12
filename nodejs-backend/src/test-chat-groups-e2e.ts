/**
 * test-chat-groups-e2e.ts — live check of custom chat groups (chat.routes.ts / chat.service.ts).
 *
 * Needs a running backend on API_BASE and its database. Uses the seeded users manan (admin = A),
 * daood (employee = B) and haseeb (employee = C). Everything it creates (conversations, their
 * messages, the notifications those messages raised) is removed at the end.
 *
 * ensureAdminHrInAllGroups() / syncDepartmentGroupMembers() run in-process against the same DB;
 * both are idempotent and only touch department groups.
 *
 *   npm run test-chat-groups-e2e
 */
import 'dotenv/config';
import axios, { AxiosRequestConfig } from 'axios';
import WebSocket from 'ws';
import prisma from './prisma';
import { ensureAdminHrInAllGroups, syncDepartmentGroupMembers } from './services/chat.service';

const API = process.env.API_BASE || 'http://localhost:5000/api';
const ORIGIN = API.replace(/\/api$/, '');
const WS = ORIGIN.replace(/^http/, 'ws');
const CHAT = `${API}/chat`;

const ADMIN = { username: 'manan', password: 'admin123' };
const EMPLOYEE = { username: 'daood', password: '1234' };
const OTHER = { username: 'haseeb', password: '1234' };

let passed = 0;
let failed = 0;
function check(name: string, ok: boolean, detail = '') {
  if (ok) { passed++; console.log(`  PASS  ${name}`); }
  else { failed++; console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
}
const skip = (name: string) => console.log(`  SKIP  ${name}`);
const warn = (msg: string) => console.log(`  WARN  ${msg}`);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const noThrow: AxiosRequestConfig = { validateStatus: () => true };
const bearer = (t: string): AxiosRequestConfig => ({ ...noThrow, headers: { Authorization: `Bearer ${t}` } });
const legacy = (uid: string): AxiosRequestConfig => ({ ...noThrow, headers: { 'X-User-Id': uid } });

function openSocket(url: string) {
  const ws = new WebSocket(url);
  const msgs: any[] = [];
  ws.on('message', (d) => { try { msgs.push(JSON.parse(d.toString())); } catch { /* ignore */ } });
  const opened = new Promise<boolean>((res) => { ws.once('open', () => res(true)); ws.once('error', () => res(false)); ws.once('unexpected-response', () => res(false)); });
  /** Wait for a message matching a predicate or a type name; returns it or null on timeout. */
  const waitFor = async (match: string | ((m: any) => boolean), ms = 4000) => {
    const pred = typeof match === 'string' ? (m: any) => m.type === match : match;
    const end = Date.now() + ms;
    while (Date.now() < end) {
      const hit = msgs.find(pred);
      if (hit) return hit;
      await sleep(50);
    }
    return null;
  };
  /** True if nothing matching arrives within ms. */
  const expectNone = async (match: string | ((m: any) => boolean), ms = 1500) => !(await waitFor(match, ms));
  return { ws, msgs, opened, waitFor, expectNone, clear: () => { msgs.length = 0; } };
}

async function main() {
  const testStart = new Date();
  const sockets: WebSocket[] = [];
  const convIds: string[] = [];

  console.log(`\nChat groups e2e against ${API}\n`);
  const rowA = (await prisma.user.findUnique({ where: { username: ADMIN.username } }))!;
  const rowB = (await prisma.user.findUnique({ where: { username: EMPLOYEE.username } }))!;
  const rowC = (await prisma.user.findUnique({ where: { username: OTHER.username } }))!;
  const [idA, idB, idC] = [rowA.id, rowB.id, rowC.id];
  let dmCreated: string | null = null;

  try {
    const login = async (c: { username: string; password: string }) => (await axios.post(`${API}/auth/login`, c)).data.token as string;
    const [tokA, tokB, tokC] = [await login(ADMIN), await login(EMPLOYEE), await login(OTHER)];

    // ── Setup ──────────────────────────────────────────────
    console.log('Setup');
    if (rowB.department_id === rowC.department_id) warn('B and C share a department');
    else check('B and C are in different departments', true);
    const A = openSocket(`${WS}/chat-ws?userId=${idA}`);
    const B = openSocket(`${WS}/chat-ws?userId=${idB}`);
    const C = openSocket(`${WS}/chat-ws?userId=${idC}`);
    sockets.push(A.ws, B.ws, C.ws);
    check('chat sockets for A, B, C open', (await Promise.all([A.opened, B.opened, C.opened])).every(Boolean));
    await Promise.all([A, B, C].map((s) => s.waitFor('CONNECTED')));

    const inactive = await prisma.user.findFirst({ where: { status: { not: 'active' } }, select: { id: true } });
    const deptGroup = await prisma.chatConversation.findFirst({ where: { conversation_type: 'group', department_id: { not: null } }, select: { id: true } });
    let direct: { id: string } | null = await prisma.chatConversation.findFirst({
      where: { conversation_type: 'direct', participants: { some: { user_id: idA } } }, select: { id: true },
    });
    const hr = await prisma.user.findFirst({ where: { role: 'hr', status: 'active' }, select: { id: true } });
    if (hr) skip('HR-login cases (no known HR password)');

    const listIds = async (uid: string) =>
      ((await axios.get(`${CHAT}/conversations`, legacy(uid))).data as any[]).map((c) => c.id);
    const post = (uid: string, convId: string, text: string) =>
      axios.post(`${CHAT}/conversations/${convId}/messages`, { text }, legacy(uid));
    const activeIds = async (convId: string) =>
      (await prisma.chatParticipant.findMany({ where: { conversation_id: convId, is_active: true }, select: { user_id: true } })).map((p) => p.user_id);
    const same = (a: string[], b: string[]) => JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());

    // ── 1. Auth ────────────────────────────────────────────
    console.log('1. Auth');
    const goodBody = { title: 'x', member_ids: [idC] };
    check('create without token -> 401', (await axios.post(`${CHAT}/groups/custom`, goodBody, noThrow)).status === 401);
    check('employee create -> 403', (await axios.post(`${CHAT}/groups/custom`, goodBody, bearer(tokB))).status === 403);

    // ── 2. Validation ──────────────────────────────────────
    console.log('2. Validation (as admin)');
    const mk = (b: any) => axios.post(`${CHAT}/groups/custom`, b, bearer(tokA));
    // Track anything a "should have been rejected" call accidentally created, so cleanup removes it.
    const trackStray = (r: any) => { if (r?.data?.id) convIds.push(r.data.id); return r; };
    check('empty title -> 400', trackStray(await mk({ title: '', member_ids: [idB] })).status === 400);
    check('whitespace title -> 400', trackStray(await mk({ title: '   ', member_ids: [idB] })).status === 400);
    check('81-char title -> 400', trackStray(await mk({ title: 'x'.repeat(81), member_ids: [idB] })).status === 400);
    check('member_ids [] -> 400', trackStray(await mk({ title: 'E2E v', member_ids: [] })).status === 400);
    check('member_ids not an array -> 400', trackStray(await mk({ title: 'E2E v', member_ids: idB })).status === 400);
    check('member_ids [creator] only -> 400', trackStray(await mk({ title: 'E2E v', member_ids: [idA] })).status === 400);
    const ghost = 'no-such-user-e2e';
    const rGhost = trackStray(await mk({ title: 'E2E v', member_ids: [idB, ghost] }));
    check('unknown id -> 400 mentioning the id', rGhost.status === 400 && String(rGhost.data?.error).includes(ghost), JSON.stringify(rGhost.data));
    if (inactive) check('inactive user id -> 400', trackStray(await mk({ title: 'E2E v', member_ids: [inactive.id] })).status === 400);
    else skip('inactive user id (none in DB)');

    // ── 3. Create ──────────────────────────────────────────
    console.log('3. Create');
    const title = `E2E chat ${Date.now()}`;
    const cr = await mk({ title, member_ids: [idB, idB, idC] });
    const g = cr.data;
    if (g?.id) convIds.push(g.id);
    check('create [B,B,C] -> 200', cr.status === 200, JSON.stringify(cr.data));
    if (!g?.id) throw new Error('group not created, cannot continue');
    check('response: id, type group, title, no department, creator A',
      g.type === 'group' && g.title === title && g.department == null && g.created_by_user_id === idA, JSON.stringify(g));
    check('response participants are exactly {A,B,C} (dupes collapsed)', same((g.participants ?? []).map((p: any) => p.id), [idA, idB, idC]));
    check('A, B and C each get CONVERSATIONS_CHANGED',
      (await Promise.all([A, B, C].map((s) => s.waitFor('CONVERSATIONS_CHANGED')))).every(Boolean));

    // ── 4. Listing ─────────────────────────────────────────
    console.log('4. Listing');
    for (const [n, uid] of [['B', idB], ['C', idC]] as const) {
      const row = ((await axios.get(`${CHAT}/conversations`, legacy(uid))).data as any[]).find((c) => c.id === g.id);
      check(`${n}'s inbox lists the group with its title`, row?.title === title && row.type === 'group');
    }
    check('DB: participants exactly A,B,C, all active',
      same(await activeIds(g.id), [idA, idB, idC]) && (await prisma.chatParticipant.count({ where: { conversation_id: g.id } })) === 3);

    // ── 5. Privacy ─────────────────────────────────────────
    console.log('5. Privacy');
    await ensureAdminHrInAllGroups();
    check('ensureAdminHrInAllGroups leaves custom group participants unchanged',
      same(await activeIds(g.id), [idA, idB, idC]) && (await prisma.chatParticipant.count({ where: { conversation_id: g.id } })) === 3);
    if (rowB.department_id != null) {
      await syncDepartmentGroupMembers(rowB.department_id);
      const b = await prisma.user.findUnique({ where: { id: idB }, select: { status: true } });
      check('syncDepartmentGroupMembers(B dept): B still active, custom group intact',
        b?.status === 'active' && same(await activeIds(g.id), [idA, idB, idC]));
    } else skip('syncDepartmentGroupMembers (B has no department)');

    // ── 6. Messaging ───────────────────────────────────────
    console.log('6. Messaging');
    const isMsg = (text: string) => (m: any) => m.type === 'MESSAGE' && m.message?.message_text === text;
    const r6 = await post(idB, g.id, 'hello from B');
    check('B sends text -> 200', r6.status === 200, JSON.stringify(r6.data));
    check('C and A receive MESSAGE', !!(await C.waitFor(isMsg('hello from B'))) && !!(await A.waitFor(isMsg('hello from B'))));
    const c6 = await axios.get(`${CHAT}/conversations/${g.id}/messages`, legacy(idC));
    check('C can fetch messages', c6.status === 200 && c6.data.some((m: any) => m.message_text === 'hello from B'));

    // ── 7. Permissions ─────────────────────────────────────
    console.log('7. Permissions');
    const memberUrl = (gid: string, uid: string) => `${CHAT}/groups/${gid}/members/${uid}`;
    check('non-creator employee add member -> 403', (await axios.post(`${CHAT}/groups/${g.id}/members`, { user_ids: [idA] }, bearer(tokB))).status === 403);
    check('non-creator employee remove C -> 403', (await axios.delete(memberUrl(g.id, idC), bearer(tokB))).status === 403);
    const nope = '00000000-0000-0000-0000-000000000000';
    check('add on nonexistent group -> 404', (await axios.post(`${CHAT}/groups/${nope}/members`, { user_ids: [idB] }, bearer(tokA))).status === 404);
    check('remove on nonexistent group -> 404', (await axios.delete(memberUrl(nope, idB), bearer(tokA))).status === 404);
    check('leave on nonexistent group -> 404', (await axios.post(`${CHAT}/groups/${nope}/leave`, {}, bearer(tokB))).status === 404);

    // ── 8. Remove ──────────────────────────────────────────
    console.log('8. Remove');
    [A, B, C].forEach((s) => s.clear());
    check('A removes B -> 200', (await axios.delete(memberUrl(g.id, idB), bearer(tokA))).status === 200);
    check('B gets CONVERSATIONS_CHANGED', !!(await B.waitFor('CONVERSATIONS_CHANGED')));
    check("B's inbox no longer has the group", !(await listIds(idB)).includes(g.id));
    check('B send -> 403 (not a participant)', (await post(idB, g.id, 'ghost')).status === 403);
    check('B fetch messages -> 403', (await axios.get(`${CHAT}/conversations/${g.id}/messages`, legacy(idB))).status === 403);
    check('C gets CONVERSATIONS_CHANGED', !!(await C.waitFor('CONVERSATIONS_CHANGED')));
    B.clear();
    check('C posts -> 200', (await post(idC, g.id, 'after removal')).status === 200);
    check('A receives it', !!(await A.waitFor(isMsg('after removal'))));
    check('B does NOT receive a MESSAGE', await B.expectNone('MESSAGE', 1500));

    // ── 9. Remove edge cases ───────────────────────────────
    console.log('9. Remove edge cases');
    check('remove B again -> 404', (await axios.delete(memberUrl(g.id, idB), bearer(tokA))).status === 404);
    check('remove creator A -> 400', (await axios.delete(memberUrl(g.id, idA), bearer(tokA))).status === 400);
    if (deptGroup) check('remove on a department group -> 400', (await axios.delete(memberUrl(deptGroup.id, idB), bearer(tokA))).status === 400);
    else skip('remove on department group (none exist)');
    if (!direct) {
      const d = await axios.post(`${CHAT}/direct`, { other_user_id: idB }, legacy(idA));
      if (d.status === 200 && d.data?.id) { direct = { id: d.data.id }; dmCreated = d.data.id; convIds.push(d.data.id); }
    }
    if (direct) check('leave on a direct conversation -> 400', (await axios.post(`${CHAT}/groups/${direct.id}/leave`, {}, bearer(tokA))).status === 400);
    else skip('leave on direct conversation (could not obtain one)');

    // ── 10. Re-add ─────────────────────────────────────────
    console.log('10. Re-add');
    [A, B, C].forEach((s) => s.clear());
    check('A adds [B] -> 200', (await axios.post(`${CHAT}/groups/${g.id}/members`, { user_ids: [idB] }, bearer(tokA))).status === 200);
    check('B active again in DB', (await activeIds(g.id)).includes(idB));
    check("B's inbox shows the group", (await listIds(idB)).includes(g.id));
    check('B gets CONVERSATIONS_CHANGED', !!(await B.waitFor('CONVERSATIONS_CHANGED')));
    check('add [] -> 400', (await axios.post(`${CHAT}/groups/${g.id}/members`, { user_ids: [] }, bearer(tokA))).status === 400);
    check('add unknown id -> 400', (await axios.post(`${CHAT}/groups/${g.id}/members`, { user_ids: [ghost] }, bearer(tokA))).status === 400);

    // ── 11. Leave ──────────────────────────────────────────
    console.log('11. Leave');
    [A, B, C].forEach((s) => s.clear());
    check('C leaves -> 200', (await axios.post(`${CHAT}/groups/${g.id}/leave`, {}, bearer(tokC))).status === 200);
    check("C's inbox lacks the group", !(await listIds(idC)).includes(g.id));
    check('C leave again -> 403', (await axios.post(`${CHAT}/groups/${g.id}/leave`, {}, bearer(tokC))).status === 403);
    check('A and B get CONVERSATIONS_CHANGED', !!(await A.waitFor('CONVERSATIONS_CHANGED')) && !!(await B.waitFor('CONVERSATIONS_CHANGED')));

    // ── 12. Creator leaves ─────────────────────────────────
    console.log('12. Creator leaves');
    check('A (creator) leaves -> 200', (await axios.post(`${CHAT}/groups/${g.id}/leave`, {}, bearer(tokA))).status === 200);
    // A is admin, so admins always manage: A can still add C back after leaving.
    check('A (admin, no longer a member) adds C back -> 200', (await axios.post(`${CHAT}/groups/${g.id}/members`, { user_ids: [idC] }, bearer(tokA))).status === 200);
    check('C is active again', (await activeIds(g.id)).includes(idC));
    // Not covered: "a creator who left can no longer manage" (assertCanManage) only bites a
    // non-admin (HR) creator; it needs HR credentials, which this suite does not have.
  } finally {
    console.log('\nCleanup');
    for (const s of sockets) { try { s.close(); } catch { /* ignore */ } }
    try {
      // messages, attachments, reactions and participants cascade from the conversation.
      const del = await prisma.chatConversation.deleteMany({ where: { id: { in: convIds } } });
      const notif = await prisma.notification.deleteMany({
        where: { user_id: { in: [idA, idB, idC] }, type: 'new_message', created_at: { gte: testStart } },
      });
      console.log(`  deleted ${del.count} conversation(s)${dmCreated ? ' (incl. new A<->B DM)' : ''}, ${notif.count} new_message notification(s)`);
    } catch (e) { console.log(`  cleanup failed: ${(e as Error).message}`); failed++; }
    await prisma.$disconnect();
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
