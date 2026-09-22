import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import api from '../../services/api';
import { useChatSocket } from '../../hooks/useChatSocket';

const ADMIN_ROLES = new Set(['superadmin', 'admin']);

function timeAgo(date) {
  if (!date) return '';
  const seconds = Math.floor((Date.now() - new Date(date).getTime()) / 1000);
  if (seconds < 10) return 'just now';
  if (seconds < 60) return `${seconds} sec ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hr ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

/**
 * ChatHub — department group chats + 1:1 direct messages.
 * Permission rules enforced server-side; this file mirrors them for the DM picker and + Group button:
 *   DM: same-dept | either side HR/Admin | lead ↔ lead (any dept); no self-DM.
 *   Groups: admin/superadmin/role-hr or employee of a department named "HR".
 */
export default function ChatHub({ user }) {
  const myId = user?.user_id;
  const [conversations, setConversations] = useState([]);
  const [activeId, setActiveId] = useState(null);
  const [messages, setMessages] = useState([]);
  const [text, setText] = useState('');
  const [attachments, setAttachments] = useState([]); // {file_name, mime_type, data}
  const [employees, setEmployees] = useState([]);
  const [leadIds, setLeadIds] = useState(new Set());
  const [departments, setDepartments] = useState([]);
  const [typingIn, setTypingIn] = useState(null);
  const [showNew, setShowNew] = useState(false);
  const [showGroup, setShowGroup] = useState(false);
  const scrollRef = useRef(null);
  const typingTimer = useRef(null);
  const sendReadRef = useRef(null);

  const isAdminRole = ADMIN_ROLES.has(user?.role);
  const myDepartmentId = useMemo(
    () => employees.find((u) => u.id === myId)?.department_id ?? user?.department_id ?? null,
    [employees, myId, user],
  );
  const myDeptName = useMemo(
    () => departments.find((d) => d.id === myDepartmentId)?.name ?? null,
    [departments, myDepartmentId],
  );
  const iAmHr = user?.role === 'hr' || (myDeptName || '').trim().toLowerCase() === 'hr';
  const iAmLead = !!(user?.is_lead || leadIds.has(myId));
  const iAmAdmin = isAdminRole;
  const canCreateGroup = iAmAdmin || iAmHr;

  const deptNameOf = useCallback(
    (deptId) => departments.find((d) => d.id === deptId)?.name ?? null,
    [departments],
  );
  const targetIsHr = (u) =>
    u.role === 'hr' || (deptNameOf(u.department_id) || '').trim().toLowerCase() === 'hr';
  const targetIsAdmin = (u) => ADMIN_ROLES.has(u.role);
  const targetIsLead = (u) => leadIds.has(u.id);

  const refreshConversations = useCallback(async () => {
    if (!myId) return;
    try {
      const { data } = await api.getChatConversations(myId);
      setConversations(data);
    } catch (e) { console.error('load conversations failed', e); }
  }, [myId]);

  // Initial load
  useEffect(() => {
    refreshConversations();
    api.getEmployees().then(({ data }) => setEmployees(data)).catch(() => {});
    api.getDepartments().then(({ data }) => {
      setDepartments(data);
      setLeadIds(new Set(data.map((d) => d.lead_id).filter(Boolean)));
    }).catch(() => {});
  }, [refreshConversations]);

  // WS events
  const onEvent = useCallback((evt) => {
    if (evt.type === 'MESSAGE') {
      const m = evt.message;
      if (m.conversation_id === activeId) {
        setMessages((prev) => (prev.some((x) => x.id === m.id) ? prev : [...prev, m]));
        if (m.sender_user_id !== myId) sendReadRef.current?.(activeId);
      }
      refreshConversations();
    } else if (evt.type === 'READ_RECEIPT' && evt.conversationId === activeId) {
      const now = new Date();
      setMessages((prev) => prev.map((m) =>
        m.sender_user_id === myId && !m.seen ? { ...m, seen: true, seen_at: now } : m
      ));
      refreshConversations();
    } else if (evt.type === 'TYPING' && evt.conversationId === activeId && evt.userId !== myId) {
      setTypingIn(evt.conversationId);
      clearTimeout(typingTimer.current);
      typingTimer.current = setTimeout(() => setTypingIn(null), 3000);
    }
  }, [activeId, myId, refreshConversations]);

  const { connected, sendTyping, sendRead } = useChatSocket(myId, onEvent);

  useEffect(() => { sendReadRef.current = sendRead; }, [sendRead]);

  // Open a conversation
  const openConversation = useCallback(async (id) => {
    setActiveId(id);
    setMessages([]);
    try {
      const { data } = await api.getChatMessages(myId, id);
      setMessages(data);
      sendRead(id);
      refreshConversations();
    } catch (e) { console.error('load messages failed', e); }
  }, [myId, refreshConversations, sendRead]);

  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [messages]);

  // Send
  const send = async () => {
    if (!activeId || (!text.trim() && attachments.length === 0)) return;
    const payloadText = text;
    const payloadAtt = attachments;
    setText(''); setAttachments([]);
    try {
      const { data: sent } = await api.sendChatMessage(myId, activeId, payloadText, payloadAtt);
      // Show immediately even if the socket is down; dedup by id when the broadcast arrives.
      setMessages((prev) => (prev.some((x) => x.id === sent.id) ? prev : [...prev, sent]));
      refreshConversations();
    } catch (e) {
      console.error('send failed', e);
      alert(e?.response?.data?.error || 'Failed to send');
      setText(payloadText); setAttachments(payloadAtt);
    }
  };

  const onPickFiles = (e) => {
    const files = Array.from(e.target.files || []);
    files.forEach((file) => {
      const reader = new FileReader();
      reader.onload = () => setAttachments((prev) => [...prev, { file_name: file.name, mime_type: file.type, data: reader.result }]);
      reader.readAsDataURL(file);
    });
    e.target.value = '';
  };

  // Who can I DM (client-side mirror of server canOpenDirect)
  const dmCandidates = useMemo(() => employees.filter((u) => {
    if (u.id === myId) return false;
    const sameDept = myDepartmentId != null && u.department_id === myDepartmentId;
    if (sameDept) return true;
    if (iAmHr || iAmAdmin || targetIsHr(u) || targetIsAdmin(u)) return true;
    if (iAmLead && targetIsLead(u)) return true;
    return false;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [employees, myId, myDepartmentId, iAmHr, iAmAdmin, iAmLead, leadIds, departments]);

  const startDirect = async (otherId) => {
    try {
      const { data } = await api.openDirectChat(myId, otherId);
      setShowNew(false);
      await refreshConversations();
      openConversation(data.id);
    } catch (e) { alert(e?.response?.data?.error || 'Cannot open chat'); }
  };

  const createGroup = async (deptId) => {
    try {
      const { data } = await api.createDepartmentGroup(myId, deptId);
      setShowGroup(false);
      await refreshConversations();
      openConversation(data.id);
    } catch (e) { alert(e?.response?.data?.error || 'Cannot create group'); }
  };  

  const titleOf = (c) => {
    if (c.type === 'group') return `# ${c.department?.name || 'Department'}`;
    const other = c.participants?.find((p) => p.id !== myId);
    return other?.name || 'Direct message';
  };

  const deptsWithoutGroup = departments.filter((d) => !conversations.some((c) => c.type === 'group' && c.department?.id === d.id));

  return (
    <div style={S.wrap}>
      {/* Left: conversation list */}
      <div style={S.list}>
        <div style={S.listHeader}>
          <span style={{ fontWeight: 700 }}>Messages</span>
          <span style={{ fontSize: 11, color: connected ? '#16a34a' : '#94a3b8' }}>{connected ? '● live' : '○ offline'}</span>
        </div>
        <div style={{ display: 'flex', gap: 6, padding: '8px 10px' }}>
          <button style={S.btn} onClick={() => setShowNew(true)}>+ New chat</button>
          {canCreateGroup && <button style={S.btn} onClick={() => setShowGroup(true)}>+ Group</button>}
        </div>
        <div style={{ overflowY: 'auto', flex: 1 }}>
          {conversations.map((c) => (
            <div key={c.id} onClick={() => openConversation(c.id)}
              style={{ ...S.convItem, background: c.id === activeId ? '#eef2ff' : 'transparent' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                <span style={{ fontWeight: 600, fontSize: 14 }}>{titleOf(c)}</span>
                {c.unread > 0 && <span style={S.badge}>{c.unread}</span>}
              </div>
              <div style={{ fontSize: 12, color: '#64748b', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {c.last_message?.sender_user_id === myId && (
                  <span style={{ marginRight: 4, fontWeight: 500 }}>{c.last_message_seen ? 'Seen' : 'Sent'}</span>
                )}
                {c.last_message?.message_text || (c.last_message ? '📎 attachment' : 'No messages yet')}
              </div>
            </div>
          ))}
          {conversations.length === 0 && <div style={{ padding: 16, color: '#94a3b8', fontSize: 13 }}>No conversations yet.</div>}
        </div>
      </div>

      {/* Right: thread */}
      <div style={S.thread}>
        {activeId ? (
          <>
            <div style={S.threadHeader}>{titleOf(conversations.find((c) => c.id === activeId) || {})}</div>
            <div ref={scrollRef} style={S.messages}>
              {(() => {
                return messages.map((m, idx) => {
                  const isMine = m.sender_user_id === myId;
                  const isLastMessage = idx === messages.length - 1;
                  let seenStatus = conversations.find((c) => c.id === activeId)?.last_message_seen;
                  const showSeenStatus = isMine && isLastMessage && seenStatus;

                  if ( isLastMessage) 
                  console.log('last',seenStatus);

                return (
                  <div key={m.id} style={{ ...S.msgRow, justifyContent: isMine ? 'flex-end' : 'flex-start' }}>
                    <div>
                      <div style={{ ...S.bubble, background: isMine ? '#4f46e5' : '#f1f5f9', color: isMine ? '#fff' : '#0f172a' }}>
                        <div style={{ fontSize: 11, opacity: 0.7, marginBottom: 2 }}>{isMine ? '': m.sender?.name || m.sender_user_id}</div>
                        {m.message_text && <div style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{m.message_text}</div>}
                        {(m.attachments || []).map((a) => (
                          <a key={a.id} href={api.chatAttachmentUrl(a.id, myId)} target="_blank" rel="noreferrer"
                            style={{ display: 'block', fontSize: 12, marginTop: 4, color: isMine ? '#c7d2fe' : '#4f46e5' }}>
                            📎 {a.file_name} ({Math.round(a.size_bytes / 1024)} KB)
                          </a>
                        ))}
                      </div>
                      {isMine && (
                        <div style={{ textAlign: 'right', marginTop: 2, fontSize: 11, color: '#94a3b8' }}>
                          {showSeenStatus ? `Seen ${timeAgo(m.seen_at)}` : isLastMessage ? 'Sent' : null}
                        </div>
                      )}
                    </div>
                  </div>
                );
              });
              })()}
              {typingIn === activeId && <div style={{ fontSize: 12, color: '#94a3b8', padding: 4 }}>typing…</div>}
            </div>
            {attachments.length > 0 && (
              <div style={{ padding: '4px 10px', fontSize: 12, color: '#475569' }}>
                {attachments.map((a, i) => (
                  <span key={i} style={S.chip}>📎 {a.file_name} <b style={{ cursor: 'pointer' }} onClick={() => setAttachments((p) => p.filter((_, j) => j !== i))}>×</b></span>
                ))}
              </div>
            )}
            <div style={S.composer}>
              <label style={S.attachBtn}>📎<input type="file" multiple style={{ display: 'none' }} onChange={onPickFiles} /></label>
              <input style={S.input} value={text} placeholder="Type a message…"
                onChange={(e) => { setText(e.target.value); sendTyping(activeId); }}
                onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } }} />
              <button style={S.sendBtn} onClick={send}>Send</button>
            </div>
          </>
        ) : (
          <div style={{ margin: 'auto', color: '#94a3b8' }}>Select a conversation</div>
        )}
      </div>

      {/* New DM modal */}
      {showNew && (
        <Modal onClose={() => setShowNew(false)} title="Start a direct message">
          {dmCandidates.length === 0 && <div style={{ color: '#94a3b8' }}>No one available to message.</div>}
          {dmCandidates.map((u) => (
            <div key={u.id} style={S.pickRow} onClick={() => startDirect(u.id)}>
              <span>{u.name}</span><span style={{ fontSize: 11, color: '#94a3b8' }}>{u.role}</span>
            </div>
          ))}
        </Modal>
      )}

      {/* New group modal */}
      {showGroup && (
        <Modal onClose={() => setShowGroup(false)} title="Create a department group">
          {deptsWithoutGroup.length === 0 && <div style={{ color: '#94a3b8' }}>Every department already has a group.</div>}
          {deptsWithoutGroup.map((d) => (
            <div key={d.id} style={S.pickRow} onClick={() => createGroup(d.id)}><span># {d.name}</span></div>
          ))}
        </Modal>
      )}
    </div>
  );
}

function Modal({ title, children, onClose }) {
  return (
    <div style={S.overlay} onClick={onClose}>
      <div style={S.modal} onClick={(e) => e.stopPropagation()}>
        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 10 }}>
          <b>{title}</b><span style={{ cursor: 'pointer' }} onClick={onClose}>×</span>
        </div>
        <div style={{ maxHeight: 360, overflowY: 'auto' }}>{children}</div>
      </div>
    </div>
  );
}

const S = {
  wrap: { display: 'flex', height: 'calc(100vh - 160px)', minHeight: 420, border: '1px solid #e2e8f0', borderRadius: 12, overflow: 'hidden', background: '#fff' },
  list: { width: 300, borderRight: '1px solid #e2e8f0', display: 'flex', flexDirection: 'column' },
  listHeader: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '12px 14px', borderBottom: '1px solid #e2e8f0' },
  btn: { flex: 1, padding: '6px 8px', fontSize: 12, border: '1px solid #e2e8f0', borderRadius: 8, background: '#f8fafc', cursor: 'pointer' },
  convItem: { padding: '10px 14px', cursor: 'pointer', borderBottom: '1px solid #f1f5f9' },
  badge: { background: '#ef4444', color: '#fff', borderRadius: 10, fontSize: 11, padding: '0 6px', minWidth: 18, textAlign: 'center' },
  thread: { flex: 1, display: 'flex', flexDirection: 'column' },
  threadHeader: { padding: '12px 16px', borderBottom: '1px solid #e2e8f0', fontWeight: 700 },
  messages: { flex: 1, overflowY: 'auto', padding: 14, display: 'flex', flexDirection: 'column', gap: 8, },
  msgRow: { display: 'flex'},
  bubble: { minWidth: '70%', padding: '8px 12px', borderRadius: 12, fontSize: 14 },
  composer: { display: 'flex', gap: 8, padding: 10, borderTop: '1px solid #e2e8f0', alignItems: 'center' },
  input: { flex: 1, padding: '10px 12px', border: '1px solid #e2e8f0', borderRadius: 8, fontSize: 14, outline: 'none' },
  attachBtn: { cursor: 'pointer', fontSize: 18, padding: '0 4px' },
  sendBtn: { padding: '10px 18px', background: '#4f46e5', color: '#fff', border: 'none', borderRadius: 8, cursor: 'pointer', fontWeight: 600 },
  chip: { background: '#eef2ff', borderRadius: 8, padding: '2px 8px', marginRight: 6 },
  overlay: { position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 },
  modal: { background: '#fff', borderRadius: 12, padding: 18, width: 360, maxWidth: '90vw' },
  pickRow: { display: 'flex', justifyContent: 'space-between', padding: '10px 8px', borderBottom: '1px solid #f1f5f9', cursor: 'pointer' },
};
