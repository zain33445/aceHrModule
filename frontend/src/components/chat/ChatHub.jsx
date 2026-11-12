import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import api from '../../services/api';
import { useChatSocket } from '../../hooks/useChatSocket';
import { useCall } from '../../context/call-context';

const ADMIN_ROLES = new Set(['superadmin', 'admin']);
/** Keep in step with the backend's CALL_MAX_PARTICIPANTS. */
const MAX_CALL_PARTICIPANTS = Math.max(
  2,
  parseInt(import.meta.env.VITE_MAX_CALL_PARTICIPANTS || '3', 10)
);

/** Shown at the top of every picker for one-tap reactions. */
const QUICK_REACTIONS = ['👍', '❤️', '😂', '😮', '😢', '🙏'];

/** Composer picker: a small curated set, deliberately dependency-free. */
const EMOJI_SET = [
  '😀', '😁', '😂', '🤣', '😃', '😄', '😅', '😊',
  '😇', '🙂', '🙃', '😉', '😍', '🥰', '😘', '😗',
  '😋', '😛', '😜', '🤪', '😝', '🤗', '🤔', '🤐',
  '😐', '😑', '😶', '🙄', '😏', '😴', '🤤', '😪',
  '😵', '🤯', '🥳', '😎', '🤓', '🧐', '😕', '😟',
  '🙁', '😮', '😯', '😲', '😳', '🥺', '😢', '😭',
  '😱', '😤', '😡', '🤬', '💀', '🤡', '👻', '👽',
  '🤖', '💩', '👍', '👎', '👌', '✌️', '🤞', '🤝',
  '👏', '🙌', '🙏', '💪', '🫶', '❤️', '🧡', '💛',
  '💚', '💙', '💜', '🖤', '🤍', '💔', '🔥', '⭐',
  '✅', '❌', '⚡', '🎉', '🎊', '🎁', '☕', '🍕',
  '🍔', '🌹', '🌈', '☀️', '🌙', '🤷', '🤦', '💯',
];

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

/** Read a File into the attachment shape the send API expects. */
const readAttachment = (file) => new Promise((resolve, reject) => {
  const reader = new FileReader();
  reader.onload = () => resolve({ file_name: file.name, mime_type: file.type, data: reader.result });
  reader.onerror = () => reject(reader.error || new Error('read failed'));
  reader.readAsDataURL(file);
});

/**
 * ChatHub — department group chats + 1:1 direct messages.
 * Permission rules enforced server-side; this file mirrors them for the DM picker and + Group button:
 *   DM: same-dept | either side HR/Admin; no self-DM.
 *   Groups: admin/superadmin/role-hr or employee of a department named "HR".
 */
export default function ChatHub({ user, fullHeight = false }) {
  const myId = user?.user_id;
  const { startCall, status: callStatus, enabled: callEnabled } = useCall();
  const [conversations, setConversations] = useState([]);
  const [activeId, setActiveId] = useState(null);
  const [messages, setMessages] = useState([]);
  const [text, setText] = useState('');
  const [attachments, setAttachments] = useState([]); // {file_name, mime_type, data}
  const [dragging, setDragging] = useState(false);
  const [pendingDrop, setPendingDrop] = useState(null); // File[] awaiting Attach / Send now / Cancel
  const dragDepth = useRef(0);
  useEffect(() => {
    setPendingDrop(null); setDragging(false); dragDepth.current = 0;
  }, [activeId]);
  // A file dropped outside the thread would make Electron navigate to file:// and lose the app.
  useEffect(() => {
    const block = (e) => { if (Array.from(e.dataTransfer?.types || []).includes('Files')) e.preventDefault(); };
    window.addEventListener('dragover', block);
    window.addEventListener('drop', block);
    return () => { window.removeEventListener('dragover', block); window.removeEventListener('drop', block); };
  }, []);
  const [employees, setEmployees] = useState([]);
  const [departments, setDepartments] = useState([]);
  const [typingIn, setTypingIn] = useState(null);
  const [showNew, setShowNew] = useState(false);
  const [showGroup, setShowGroup] = useState(false);
  const [groupTab, setGroupTab] = useState('department'); // 'department' | 'custom'
  const [groupName, setGroupName] = useState('');
  const [groupSel, setGroupSel] = useState([]); // user ids picked for a new custom group
  const [showMembers, setShowMembers] = useState(false);
  const [addSel, setAddSel] = useState([]); // user ids picked to add to the open custom group
  const [showEmojiPicker, setShowEmojiPicker] = useState(false);
  const [reactionFor, setReactionFor] = useState(null); // message id
  const [hoveredMessage, setHoveredMessage] = useState(null);
  const scrollRef = useRef(null);
  const typingTimer = useRef(null);
  const sendReadRef = useRef(null);
  const inputRef = useRef(null);
  const emojiPickerRef = useRef(null);
  const reactionPickerRef = useRef(null);

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
  const iAmAdmin = isAdminRole;
  const canCreateGroup = iAmAdmin || iAmHr;

  const deptNameOf = useCallback(
    (deptId) => departments.find((d) => d.id === deptId)?.name ?? null,
    [departments],
  );
  const targetIsHr = (u) =>
    u.role === 'hr' || (deptNameOf(u.department_id) || '').trim().toLowerCase() === 'hr';
  const targetIsAdmin = (u) => ADMIN_ROLES.has(u.role);

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
    api.getDepartments().then(({ data }) => setDepartments(data)).catch(() => {});
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
    } else if (evt.type === 'CONVERSATIONS_CHANGED') {
      refreshConversations();
    } else if (evt.type === 'READ_RECEIPT' && evt.conversationId === activeId) {
      const now = new Date();
      setMessages((prev) => prev.map((m) =>
        m.sender_user_id === myId && !m.seen ? { ...m, seen: true, seen_at: now } : m
      ));
      refreshConversations();
    } else if (evt.type === 'REACTION' && evt.conversationId === activeId) {
      setMessages((prev) => prev.map((m) =>
        m.id === evt.messageId ? { ...m, reactions: evt.reactions || [] } : m
      ));
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

  // Grow the composer with its content (Shift+Enter inserts a newline).
  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 120)}px`;
  }, [text]);

  // Dismiss the emoji pickers on outside click or Escape.
  useEffect(() => {
    if (!showEmojiPicker && !reactionFor) return;
    const onDown = (e) => {
      if (emojiPickerRef.current?.contains(e.target)) return;
      if (reactionPickerRef.current?.contains(e.target)) return;
      setShowEmojiPicker(false);
      setReactionFor(null);
    };
    const onKey = (e) => {
      if (e.key === 'Escape') {
        setShowEmojiPicker(false);
        setReactionFor(null);
      }
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [showEmojiPicker, reactionFor]);

  /** Insert an emoji at the caret so the picker doesn't clobber existing text. */
  const insertEmoji = (emoji) => {
    const el = inputRef.current;
    if (!el) {
      setText((prev) => prev + emoji);
      return;
    }
    const start = el.selectionStart ?? text.length;
    const end = el.selectionEnd ?? text.length;
    setText(text.slice(0, start) + emoji + text.slice(end));
    sendTyping(activeId);
    requestAnimationFrame(() => {
      el.focus();
      const pos = start + emoji.length;
      el.setSelectionRange(pos, pos);
    });
  };

  const toggleReaction = async (messageId, emoji) => {
    if (!myId) return;
    setReactionFor(null);
    try {
      const { data } = await api.toggleChatReaction(myId, messageId, emoji);
      setMessages((prev) => prev.map((m) =>
        m.id === messageId ? { ...m, reactions: data.reactions || [] } : m
      ));
    } catch (e) {
      console.error('reaction failed', e);
    }
  };

  // Send
  const send = async (extra = []) => {
    const payloadAtt = [...attachments, ...extra];
    if (!activeId || (!text.trim() && payloadAtt.length === 0)) return;
    const payloadText = text;
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
    e.target.value = '';
    Promise.all(files.map(readAttachment))
      .then((list) => setAttachments((p) => [...p, ...list]))
      .catch(() => alert('Could not read file'));
  };

  // Drag & drop onto the thread: dropped files wait for Attach / Send now / Cancel.
  const hasFiles = (e) => Array.from(e.dataTransfer?.types || []).includes('Files');
  const onDragEnter = (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    dragDepth.current += 1;
    setDragging(true);
  };
  const onDragOver = (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = activeId ? 'copy' : 'none';
  };
  const onDragLeave = (e) => {
    if (!hasFiles(e)) return;
    dragDepth.current = Math.max(0, dragDepth.current - 1);
    if (dragDepth.current === 0) setDragging(false);
  };
  const onDrop = (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    dragDepth.current = 0;
    setDragging(false);
    if (!activeId) return;
    const files = Array.from(e.dataTransfer.items || [])
      .filter((it) => it.kind === 'file' && it.webkitGetAsEntry?.()?.isFile !== false)
      .map((it) => it.getAsFile())
      .filter((f) => f && f.size > 0);
    if (files.length) setPendingDrop(files);
  };
  const readAll = () => {
    const f = pendingDrop;
    setPendingDrop(null);
    return Promise.all(f.map(readAttachment));
  };

  // Who can I DM (client-side mirror of server canOpenDirect)
  const dmCandidates = useMemo(() => employees.filter((u) => {
    if (u.id === myId) return false;
    const sameDept = myDepartmentId != null && u.department_id === myDepartmentId;
    if (sameDept) return true;
    if (iAmHr || iAmAdmin || targetIsHr(u) || targetIsAdmin(u)) return true;
    return false;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [employees, myId, myDepartmentId, iAmHr, iAmAdmin, departments]);

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

  const createCustomGroup = async () => {
    try {
      const { data } = await api.createCustomGroup(groupName.trim(), groupSel);
      setShowGroup(false); setGroupName(''); setGroupSel([]);
      await refreshConversations();
      openConversation(data.id);
    } catch (e) { alert(e?.response?.data?.error || 'Cannot create group'); }
  };

  /** Run a membership change, then reload the inbox. `leaving` also clears the open thread. */
  const changeMembers = async (fn, leaving = false) => {
    try {
      await fn();
      if (leaving) { setShowMembers(false); setActiveId(null); setMessages([]); }
      setAddSel([]);
      await refreshConversations();
    } catch (e) { alert(e?.response?.data?.error || 'Could not update the group'); }
  };

  const titleOf = (c) => {
    if (c.type === 'group') return `# ${c.title || c.department?.name || 'Department'}`;
    const other = c.participants?.find((p) => p.id !== myId);
    return other?.name || 'Direct message';
  };

  const deptsWithoutGroup = departments.filter((d) => !conversations.some((c) => c.type === 'group' && c.department?.id === d.id));

  /** The people in the active conversation, excluding me. */
  const activeOthers = useMemo(() => {
    const conv = conversations.find((c) => c.id === activeId);
    if (!conv) return [];
    return (conv.participants || []).filter((p) => p.id !== myId);
  }, [conversations, activeId, myId]);

  const activeConversation = conversations.find((c) => c.id === activeId);
  const isDirectConversation = activeConversation?.type === 'direct';
  const isCustomGroup = activeConversation?.type === 'group' && !activeConversation?.department;
  const canManageMembers = isCustomGroup && (iAmAdmin || activeConversation.created_by_user_id === myId);
  const activeEmployees = useMemo(
    () => employees.filter((u) => u.id !== myId && (u.status ? u.status === 'active' : true)),
    [employees, myId],
  );

  // The floating Electron chat window owns no call socket, so a 1:1 call from
  // it is delegated to the main window (see the call:start IPC bridge).
  const canDelegateCall =
    !callEnabled &&
    isDirectConversation &&
    typeof window !== 'undefined' &&
    !!window.electronAPI?.call?.start;

  const showCallButton = (callEnabled || canDelegateCall) && activeOthers.length > 0;

  const canCallConversation =
    (callEnabled || canDelegateCall) &&
    activeOthers.length > 0 &&
    activeOthers.length <= MAX_CALL_PARTICIPANTS - 1;

  const callConversation = async () => {
    if (!canCallConversation) return;
    const ids = activeOthers.slice(0, MAX_CALL_PARTICIPANTS - 1).map((p) => p.id);
    if (!callEnabled) {
      window.electronAPI.call.start({ userIds: ids, conversationId: activeId });
      return;
    }
    await startCall(ids, activeId);
  };

  return (
    <div style={fullHeight ? { ...S.wrap, height: '100vh', minHeight: 0, border: 'none', borderRadius: 0 } : S.wrap}>
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
      <div style={{ ...S.thread, position: 'relative' }}
        onDragEnter={onDragEnter} onDragOver={onDragOver} onDragLeave={onDragLeave} onDrop={onDrop}>
        {dragging && activeId && <div style={S.dropOverlay}>Drop to attach</div>}
        {pendingDrop && (
          <div style={S.dropCard}>
            {pendingDrop.map((f, i) => <div key={i} style={{ fontSize: 13, padding: '2px 0' }}>📎 {f.name}</div>)}
            <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
              <button type="button" style={S.btn}
                onClick={() => readAll().then((l) => setAttachments((p) => [...p, ...l])).catch(() => alert('Could not read file'))}>Attach</button>
              <button type="button" style={S.btn}
                onClick={() => readAll().then((l) => send(l)).catch(() => alert('Could not read file'))}>Send now</button>
              <button type="button" style={S.btn} onClick={() => setPendingDrop(null)}>Cancel</button>
            </div>
          </div>
        )}
        {activeId ? (
          <>
            <div style={S.threadHeader}>
              <span style={{ flex: 1 }}>{titleOf(activeConversation || {})}</span>
              {isCustomGroup && (
                <button type="button" style={{ ...S.btn, flex: '0 0 auto' }} onClick={() => setShowMembers(true)}>Members</button>
              )}
              {showCallButton && (
                <button
                  type="button"
                  onClick={callConversation}
                  disabled={!canCallConversation || callStatus !== 'idle'}
                  title={
                    !canCallConversation
                      ? `Group calls are limited to ${MAX_CALL_PARTICIPANTS} people`
                      : callStatus !== 'idle'
                        ? 'You are already in a call'
                        : isDirectConversation
                          ? `Call ${activeOthers[0]?.name || ''}`.trim()
                          : 'Start a call'
                  }
                  style={{
                    ...S.callBtn,
                    opacity: canCallConversation && callStatus === 'idle' ? 1 : 0.45,
                    cursor: canCallConversation && callStatus === 'idle' ? 'pointer' : 'not-allowed',
                  }}
                >
                  <span>📞</span>
                  Call
                </button>
              )}
            </div>
            <div ref={scrollRef} style={S.messages}>
              {(() => {
                return messages.map((m, idx) => {
                  const isMine = m.sender_user_id === myId;
                  const isLastMessage = idx === messages.length - 1;
                  let seenStatus = conversations.find((c) => c.id === activeId)?.last_message_seen;
                  const showSeenStatus = isMine && isLastMessage && seenStatus;

                return (
                  <div key={m.id}
                    style={{ ...S.msgRow, justifyContent: isMine ? 'flex-end' : 'flex-start' }}
                    onMouseEnter={() => setHoveredMessage(m.id)}
                    onMouseLeave={() => setHoveredMessage((id) => (id === m.id ? null : id))}>
                    <div style={{ position: 'relative', maxWidth: '82%' }}>
                      <div style={{ display: 'flex', alignItems: 'flex-end', gap: 4, flexDirection: isMine ? 'row-reverse' : 'row' }}>
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
                        <button
                          type="button"
                          title="Add reaction"
                          aria-label="Add reaction"
                          onMouseDown={(e) => e.stopPropagation()}
                          onClick={() => setReactionFor((cur) => (cur === m.id ? null : m.id))}
                          style={{
                            ...S.reactTrigger,
                            opacity: hoveredMessage === m.id || reactionFor === m.id ? 1 : 0.35,
                          }}
                        >☺</button>
                      </div>
                      {reactionFor === m.id && (
                        <div ref={reactionPickerRef}
                          style={{ marginTop: 6, display: 'flex', justifyContent: isMine ? 'flex-end' : 'flex-start' }}
                          onClick={(e) => e.stopPropagation()}>
                          <EmojiPicker compact onPick={(emoji) => toggleReaction(m.id, emoji)} />
                        </div>
                      )}
                      {(m.reactions || []).length > 0 && (
                        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginTop: 4, justifyContent: isMine ? 'flex-end' : 'flex-start' }}>
                          {m.reactions.map((r) => {
                            const mine = (r.user_ids || []).includes(myId);
                            return (
                              <button key={r.emoji} type="button"
                                onClick={() => toggleReaction(m.id, r.emoji)}
                                title={mine ? 'Remove your reaction' : 'Add your reaction'}
                                style={{ ...S.reactionChip, background: mine ? '#e0e7ff' : '#f8fafc', borderColor: mine ? '#a5b4fc' : '#e2e8f0' }}>
                                <span>{r.emoji}</span>
                                <span style={{ fontSize: 11, fontWeight: 600 }}>{r.count}</span>
                              </button>
                            );
                          })}
                        </div>
                      )}
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
              {showEmojiPicker && (
                <div ref={emojiPickerRef}
                  style={{ position: 'absolute', bottom: 'calc(100% + 8px)', left: 10, zIndex: 30 }}
                  onClick={(e) => e.stopPropagation()}>
                  <EmojiPicker onPick={insertEmoji} />
                </div>
              )}
              <label style={S.attachBtn}>📎<input type="file" multiple style={{ display: 'none' }} onChange={onPickFiles} /></label>
              <button type="button" title="Emoji" aria-label="Emoji"
                onMouseDown={(e) => e.stopPropagation()}
                onClick={() => setShowEmojiPicker((v) => !v)}
                style={S.emojiToggle}>😊</button>
              <textarea ref={inputRef} rows={1} style={S.input} value={text} placeholder="Type a message…"
                onChange={(e) => { setText(e.target.value); sendTyping(activeId); }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
                  if (e.key === 'Escape') setShowEmojiPicker(false);
                }} />
              <button style={S.sendBtn} onClick={() => send()}>Send</button>
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
        <Modal onClose={() => setShowGroup(false)} title="New group">
          <div style={{ display: 'flex', gap: 6, marginBottom: 10 }}>
            {[['department', 'Department group'], ['custom', 'Custom group']].map(([k, label]) => (
              <button key={k} type="button" onClick={() => setGroupTab(k)}
                style={{ ...S.btn, background: groupTab === k ? '#eef2ff' : '#f8fafc', fontWeight: groupTab === k ? 700 : 400 }}>{label}</button>
            ))}
          </div>
          {groupTab === 'department' ? (
            <>
              {deptsWithoutGroup.length === 0 && <div style={{ color: '#94a3b8' }}>Every department already has a group.</div>}
              {deptsWithoutGroup.map((d) => (
                <div key={d.id} style={S.pickRow} onClick={() => createGroup(d.id)}><span># {d.name}</span></div>
              ))}
            </>
          ) : (
            <>
              <input value={groupName} onChange={(e) => setGroupName(e.target.value)} maxLength={80}
                placeholder="Group name" style={{ ...S.input, width: '100%', marginBottom: 8, boxSizing: 'border-box' }} />
              <MemberPicker users={activeEmployees} deptNameOf={deptNameOf} selected={groupSel} onChange={setGroupSel} />
              <button type="button" disabled={!groupName.trim() || groupSel.length === 0} onClick={createCustomGroup}
                style={{ ...S.btn, width: '100%', marginTop: 10, background: '#4f46e5', color: '#fff',
                  opacity: !groupName.trim() || groupSel.length === 0 ? 0.45 : 1 }}>
                Create group ({groupSel.length})
              </button>
            </>
          )}
        </Modal>
      )}

      {/* Custom group members */}
      {showMembers && isCustomGroup && (
        <Modal onClose={() => setShowMembers(false)} title={`Members (${activeConversation.participants?.length || 0})`}>
          {(activeConversation.participants || []).map((p) => (
            <div key={p.id} style={{ ...S.pickRow, cursor: 'default', alignItems: 'center' }}>
              <span>{p.name}{p.id === activeConversation.created_by_user_id ? ' (creator)' : ''}{p.id === myId ? ' (you)' : ''}</span>
              {canManageMembers && p.id !== activeConversation.created_by_user_id && (
                <button type="button" style={{ ...S.btn, flex: '0 0 auto', color: '#dc2626' }}
                  onClick={() => changeMembers(() => api.removeGroupMember(activeId, p.id))}>Remove</button>
              )}
            </div>
          ))}
          {canManageMembers && (
            <div style={{ marginTop: 12 }}>
              <b style={{ fontSize: 13 }}>Add members</b>
              <MemberPicker
                users={activeEmployees.filter((u) => !(activeConversation.participants || []).some((p) => p.id === u.id))}
                deptNameOf={deptNameOf} selected={addSel} onChange={setAddSel} />
              <button type="button" disabled={addSel.length === 0}
                onClick={() => changeMembers(() => api.addGroupMembers(activeId, addSel))}
                style={{ ...S.btn, width: '100%', marginTop: 8, opacity: addSel.length === 0 ? 0.45 : 1 }}>
                Add selected ({addSel.length})
              </button>
            </div>
          )}
          <button type="button"
            onClick={() => window.confirm('Leave this group? You will no longer see its messages.') && changeMembers(() => api.leaveGroup(activeId), true)}
            style={{ ...S.btn, width: '100%', marginTop: 14, color: '#dc2626' }}>Leave group</button>
        </Modal>
      )}
    </div>
  );
}

/** Dependency-free emoji palette used by the composer and the reaction picker. */
function EmojiPicker({ onPick, compact = false }) {
  return (
    <div
      style={{ ...S.picker, width: compact ? 248 : 304 }}
      onMouseDown={(e) => e.stopPropagation()}
    >
      <div style={{ ...S.emojiGrid, gridTemplateColumns: 'repeat(6, 1fr)', marginBottom: 6 }}>
        {QUICK_REACTIONS.map((emoji) => (
          <button key={emoji} type="button" style={S.emojiBtn} onClick={() => onPick(emoji)}>{emoji}</button>
        ))}
      </div>
      <div style={{ borderTop: '1px solid #e2e8f0', paddingTop: 6 }}>
        <div style={{ ...S.emojiGrid, maxHeight: compact ? 128 : 176 }}>
          {EMOJI_SET.map((emoji, i) => (
            <button key={`${emoji}-${i}`} type="button" style={S.emojiBtn} onClick={() => onPick(emoji)}>{emoji}</button>
          ))}
        </div>
      </div>
    </div>
  );
}

/** Searchable checkbox list of users; `selected` is an array of ids. */
function MemberPicker({ users, deptNameOf, selected, onChange }) {
  const [q, setQ] = useState('');
  const shown = users.filter((u) => (u.name || '').toLowerCase().includes(q.trim().toLowerCase()));
  const toggle = (id) => onChange(selected.includes(id) ? selected.filter((x) => x !== id) : [...selected, id]);
  return (
    <div>
      <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search people"
        style={{ ...S.input, width: '100%', margin: '6px 0', boxSizing: 'border-box' }} />
      <div style={{ maxHeight: 200, overflowY: 'auto', border: '1px solid #f1f5f9', borderRadius: 8 }}>
        {shown.length === 0 && <div style={{ padding: 10, color: '#94a3b8', fontSize: 13 }}>No one found.</div>}
        {shown.map((u) => (
          <label key={u.id} style={{ ...S.pickRow, alignItems: 'center' }}>
            <span><input type="checkbox" checked={selected.includes(u.id)} onChange={() => toggle(u.id)} style={{ marginRight: 8 }} />{u.name}</span>
            <span style={{ fontSize: 11, color: '#94a3b8' }}>{deptNameOf(u.department_id) || u.role}</span>
          </label>
        ))}
      </div>
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
  callBtn: { display: 'inline-flex', alignItems: 'center', gap: 6, flex: '0 0 auto', padding: '6px 14px', fontSize: 13, fontWeight: 600, color: '#fff', background: '#16a34a', border: 'none', borderRadius: 999 },
  convItem: { padding: '10px 14px', cursor: 'pointer', borderBottom: '1px solid #f1f5f9' },
  badge: { background: '#ef4444', color: '#fff', borderRadius: 10, fontSize: 11, padding: '0 6px', minWidth: 18, textAlign: 'center' },
  thread: { flex: 1, display: 'flex', flexDirection: 'column' },
  threadHeader: { padding: '12px 16px', borderBottom: '1px solid #e2e8f0',
    fontWeight: 700, display: 'flex', alignItems: 'center', gap: 10 },
  messages: { flex: 1, overflowY: 'auto', padding: 14, display: 'flex', flexDirection: 'column', gap: 8, },
  msgRow: { display: 'flex'},
  bubble: { minWidth: '70%', padding: '8px 12px', borderRadius: 12, fontSize: 14 },
  composer: { position: 'relative', display: 'flex', gap: 8, padding: 10, borderTop: '1px solid #e2e8f0', alignItems: 'center' },
  input: { flex: 1, minHeight: 40, maxHeight: 120, padding: '10px 12px', border: '1px solid #e2e8f0', borderRadius: 8, fontSize: 14, lineHeight: 1.4, fontFamily: 'inherit', resize: 'none', outline: 'none', boxSizing: 'border-box' },
  attachBtn: { cursor: 'pointer', fontSize: 18, padding: '0 4px' },
  emojiToggle: { border: 'none', background: 'transparent', cursor: 'pointer', fontSize: 20, lineHeight: 1, padding: '2px' },
  picker: { background: '#fff', border: '1px solid #e2e8f0', borderRadius: 12, boxShadow: '0 12px 32px rgba(15,23,42,0.16)', padding: 8 },
  dropOverlay: { position: 'absolute', inset: 0, zIndex: 40, pointerEvents: 'none', display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'rgba(79,70,229,0.08)', border: '2px dashed #4f46e5', borderRadius: 8, fontWeight: 700, color: '#4f46e5' },
  dropCard: { position: 'absolute', left: 10, right: 10, bottom: 70, zIndex: 41, background: '#fff', border: '1px solid #e2e8f0', borderRadius: 12, boxShadow: '0 12px 32px rgba(15,23,42,0.16)', padding: 8 },
  emojiGrid: { display: 'grid', gridTemplateColumns: 'repeat(8, 1fr)', gap: 2, overflowY: 'auto' },
  emojiBtn: { border: 'none', background: 'transparent', borderRadius: 6, cursor: 'pointer', fontSize: 19, lineHeight: 1.2, padding: '3px 0' },
  reactTrigger: { flex: '0 0 auto', width: 24, height: 24, padding: 0, border: '1px solid #e2e8f0', borderRadius: 999, background: '#fff', color: '#475569', cursor: 'pointer', fontSize: 14, lineHeight: 1 },
  reactionChip: { display: 'inline-flex', alignItems: 'center', gap: 4, padding: '1px 8px', borderRadius: 999, border: '1px solid #e2e8f0', cursor: 'pointer', fontSize: 13, lineHeight: 1.6 },
  sendBtn: { padding: '10px 18px', background: '#4f46e5', color: '#fff', border: 'none', borderRadius: 8, cursor: 'pointer', fontWeight: 600 },
  chip: { background: '#eef2ff', borderRadius: 8, padding: '2px 8px', marginRight: 6 },
  overlay: { position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 },
  modal: { background: '#fff', borderRadius: 12, padding: 18, width: 360, maxWidth: '90vw' },
  pickRow: { display: 'flex', justifyContent: 'space-between', padding: '10px 8px', borderBottom: '1px solid #f1f5f9', cursor: 'pointer' },
};
