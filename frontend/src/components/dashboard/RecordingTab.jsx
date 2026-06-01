/**
 * RecordingTab.jsx — Admin Recording Control Panel
 *
 * Phase 2 of the Screen Recording System.
 * Gives admins a full UI to:
 *   • See which employees are online (Electron agent connected)
 *   • Start / stop screen recordings per employee
 *   • Browse session history with status chips
 *   • Download fully assembled WebM recordings
 *
 * Auto-refreshes every 10 seconds.
 */

import React, { useState, useEffect, useCallback, useRef } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  Video,
  VideoOff,
  MonitorPlay,
  MonitorStop,
  Download,
  RefreshCw,
  Wifi,
  WifiOff,
  Clock,
  CheckCircle2,
  AlertCircle,
  Loader2,
  ChevronDown,
  ChevronUp,
  User,
  Eye,
  X,
} from 'lucide-react';
import api from '../../services/api';
import { Card, CardHeader, CardBody } from '../common/Card';
import { Button } from '../common/Button';
import { Badge } from '../common/Badge';
import { SlideUp } from '../animations';

// ─── Status helpers ────────────────────────────────────────────────────────────
const SESSION_STATUS_META = {
  pending:    { label: 'Starting...',  color: '#f59e0b', bg: '#fffbeb' },
  recording:  { label: 'Recording',   color: '#ef4444', bg: '#fef2f2' },
  stopping:   { label: 'Stopping...',  color: '#f97316', bg: '#fff7ed' },
  assembled:  { label: 'Ready',        color: '#10b981', bg: '#ecfdf5' },
  error:      { label: 'Error',        color: '#6b7280', bg: '#f9fafb' },
};

function statusMeta(status) {
  return SESSION_STATUS_META[status] ?? { label: status, color: '#6b7280', bg: '#f9fafb' };
}

function fmtDuration(startedAt, endedAt) {
  if (!startedAt) return '—';
  const end = endedAt ? new Date(endedAt) : new Date();
  const ms = end - new Date(startedAt);
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  if (h > 0) return `${h}h ${m % 60}m`;
  if (m > 0) return `${m}m ${s % 60}s`;
  return `${s}s`;
}

function fmtTime(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('en-PK', {
    month: 'short', day: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });
}

// ─── Main Component ───────────────────────────────────────────────────────────
export default function RecordingTab({ adminId, employees = [] }) {
  const [agents, setAgents] = useState([]);       // connected agent userIds
  const [sessions, setSessions] = useState([]);   // recent session history
  const [statuses, setStatuses] = useState({});   // { userId: { agentConnected, activeSession } }
  const [loading, setLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState({});  // { userId: 'starting'|'stopping' }
  const [expandedSession, setExpandedSession] = useState(null);
  const [liveStreamSession, setLiveStreamSession] = useState(null); // sessionId for live view modal
  const [quality, setQuality] = useState('720p');
  const timerRef = useRef(null);

  // ── Data fetching ──────────────────────────────────────────────────────────
  const refresh = useCallback(async (quiet = false) => {
    if (!quiet) setLoading(true);
    try {
      const [agentsRes, sessionsRes] = await Promise.all([
        api.recordingGetAgents(adminId),
        api.recordingGetSessions(adminId),
      ]);
      const connectedIds = agentsRes.data?.connectedAgents ?? [];
      setAgents(connectedIds);
      setSessions(sessionsRes.data?.sessions ?? []);

      // Fetch per-employee live status for employees who are connected
      const statusEntries = await Promise.all(
        connectedIds.map(async (uid) => {
          try {
            const r = await api.recordingGetStatus(adminId, uid);
            return [uid, r.data];
          } catch {
            return [uid, { agentConnected: true, activeSession: null }];
          }
        })
      );
      setStatuses(Object.fromEntries(statusEntries));
    } catch (err) {
      console.error('[RecordingTab] Refresh failed:', err.message);
    }
    if (!quiet) setLoading(false);
  }, [adminId]);

  useEffect(() => {
    refresh();
    timerRef.current = setInterval(() => refresh(true), 10_000);
    return () => clearInterval(timerRef.current);
  }, [refresh]);

  // ── Actions ────────────────────────────────────────────────────────────────
  const startRecording = async (userId) => {
    setActionLoading((prev) => ({ ...prev, [userId]: 'starting' }));
    try {
      await api.recordingStartSession(adminId, userId, quality);
      await refresh(true);
    } catch (err) {
      alert(`Failed to start recording: ${err.response?.data?.error ?? err.message}`);
    }
    setActionLoading((prev) => ({ ...prev, [userId]: null }));
  };

  const stopRecording = async (userId, sessionId) => {
    setActionLoading((prev) => ({ ...prev, [userId]: 'stopping' }));
    try {
      await api.recordingStopSession(adminId, sessionId);
      await refresh(true);
    } catch (err) {
      alert(`Failed to stop recording: ${err.response?.data?.error ?? err.message}`);
    }
    setActionLoading((prev) => ({ ...prev, [userId]: null }));
  };

  const downloadSession = (sessionId) => {
    const url = api.recordingGetDownloadUrl(sessionId);
    const a = document.createElement('a');
    a.href = url;
    a.download = `recording-${sessionId.substring(0, 8)}.webm`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  };

  // ── Employee enrichment ───────────────────────────────────────────────────
  function getEmployee(userId) {
    return employees.find((e) => String(e.id) === String(userId));
  }

  // ── Summary stats ─────────────────────────────────────────────────────────
  const activeRecordings = sessions.filter((s) => s.status === 'recording' || s.status === 'pending').length;
  const readyToDownload = sessions.filter((s) => s.status === 'assembled').length;

  // ── Render ─────────────────────────────────────────────────────────────────
  return (
    <SlideUp>
      {/* ── Header ──────────────────────────────────────────────────────── */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 24 }}>
        <div>
          <h2 style={{ fontSize: 22, fontWeight: 700, color: '#0f172a', margin: 0 }}>
            Screen Recording Control
          </h2>
          <p style={{ fontSize: 13, color: '#64748b', marginTop: 4 }}>
            {agents.length} agent{agents.length !== 1 ? 's' : ''} online &nbsp;·&nbsp;
            {activeRecordings} active &nbsp;·&nbsp;
            {readyToDownload} ready to download
          </p>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <select
            value={quality}
            onChange={(e) => setQuality(e.target.value)}
            style={{
              padding: '7px 12px', border: '1px solid #e2e8f0',
              borderRadius: 8, fontSize: 13, color: '#374151', background: '#fff',
              cursor: 'pointer',
            }}
          >
            <option value="480p">Quality: 480p</option>
            <option value="720p">Quality: 720p</option>
            <option value="1080p">Quality: 1080p</option>
          </select>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => refresh()}
            disabled={loading}
            style={{ display: 'flex', alignItems: 'center', gap: 6 }}
          >
            <RefreshCw size={15} className={loading ? 'animate-spin' : ''} />
            Refresh
          </Button>
        </div>
      </div>

      {/* ── Live Agents ─────────────────────────────────────────────────── */}
      <div style={{ marginBottom: 28 }}>
        <h3 style={{ fontSize: 14, fontWeight: 600, color: '#475569', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 12 }}>
          Online Employees
        </h3>

        {loading ? (
          <div style={{ display: 'flex', justifyContent: 'center', padding: 40 }}>
            <Loader2 size={28} style={{ color: '#94a3b8', animation: 'spin 1s linear infinite' }} />
          </div>
        ) : employees.length === 0 ? (
          <Card>
            <CardBody style={{ textAlign: 'center', padding: 40, color: '#94a3b8' }}>
              <WifiOff size={40} style={{ margin: '0 auto 12px' }} />
              <p>No employees found. Add employees first.</p>
            </CardBody>
          </Card>
        ) : (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(310px, 1fr))', gap: 14 }}>
            {employees.map((emp) => {
              const isConnected = agents.includes(String(emp.id));
              const liveStatus = statuses[String(emp.id)];
              const activeSession = liveStatus?.activeSession;
              const isRecording = activeSession?.status === 'recording' || activeSession?.status === 'pending';
              const actionState = actionLoading[emp.id];
              const initials = emp.name?.split(' ').map((w) => w[0]).join('').slice(0, 2).toUpperCase() || '??';

              return (
                <motion.div
                  key={emp.id}
                  initial={{ opacity: 0, y: 8 }}
                  animate={{ opacity: 1, y: 0 }}
                  style={{
                    background: '#fff',
                    border: `1.5px solid ${isRecording ? '#fca5a5' : isConnected ? '#e2e8f0' : '#f1f5f9'}`,
                    borderRadius: 14,
                    padding: 18,
                    boxShadow: isRecording
                      ? '0 0 0 3px rgba(239,68,68,0.08), 0 2px 8px rgba(0,0,0,0.06)'
                      : '0 1px 4px rgba(0,0,0,0.05)',
                    transition: 'all 0.2s',
                    opacity: isConnected ? 1 : 0.65,
                  }}
                >
                  {/* Employee header */}
                  <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 14 }}>
                    <div style={{
                      width: 42, height: 42, borderRadius: '50%',
                      background: isConnected ? 'linear-gradient(135deg,#6366f1,#8b5cf6)' : '#e2e8f0',
                      display: 'flex', alignItems: 'center', justifyContent: 'center',
                      color: '#fff', fontWeight: 700, fontSize: 15, flexShrink: 0,
                    }}>
                      {initials}
                    </div>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <p style={{ fontWeight: 700, fontSize: 14, color: '#0f172a', margin: 0, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                        {emp.name}
                      </p>
                      <p style={{ fontSize: 12, color: '#64748b', margin: 0 }}>
                        ID {emp.id} · {emp.department?.name || 'No dept'}
                      </p>
                    </div>
                    {/* Connection indicator */}
                    <div style={{
                      display: 'flex', alignItems: 'center', gap: 5,
                      padding: '3px 9px', borderRadius: 20, fontSize: 11, fontWeight: 600,
                      background: isConnected ? '#ecfdf5' : '#f8fafc',
                      color: isConnected ? '#059669' : '#94a3b8',
                      border: `1px solid ${isConnected ? '#a7f3d0' : '#e2e8f0'}`,
                    }}>
                      {isConnected
                        ? <><Wifi size={10} /> Online</>
                        : <><WifiOff size={10} /> Offline</>
                      }
                    </div>
                  </div>

                  {/* Active session info */}
                  {isRecording && activeSession && (
                    <div style={{
                      background: '#fef2f2', border: '1px solid #fecaca',
                      borderRadius: 8, padding: '8px 12px', marginBottom: 12,
                      display: 'flex', alignItems: 'center', gap: 8,
                    }}>
                      <span style={{
                        width: 8, height: 8, borderRadius: '50%', background: '#ef4444',
                        display: 'inline-block', animation: 'pulse 1.2s ease-in-out infinite',
                        flexShrink: 0,
                      }} />
                      <style>{`@keyframes pulse{0%,100%{opacity:1}50%{opacity:0.3}}`}</style>
                      <span style={{ fontSize: 12, color: '#dc2626', fontWeight: 600 }}>
                        Recording · {fmtDuration(activeSession.started_at)}
                      </span>
                    </div>
                  )}

                  {/* Action button */}
                  {!isConnected ? (
                    <div style={{ fontSize: 12, color: '#94a3b8', textAlign: 'center', padding: '6px 0' }}>
                      Agent offline — employee must open the app
                    </div>
                  ) : isRecording ? (
                    <div style={{ display: 'flex', gap: 8 }}>
                      <button
                        onClick={() => setLiveStreamSession(activeSession.id)}
                        style={{
                          flex: 1, padding: '9px 12px', borderRadius: 10,
                          border: '1px solid #e2e8f0', cursor: 'pointer',
                          background: '#fff', color: '#475569', fontWeight: 600, fontSize: 13,
                          display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 7,
                        }}
                      >
                        <Eye size={15} /> Live Feed
                      </button>
                      <button
                        id={`stop-rec-${emp.id}`}
                        onClick={() => stopRecording(emp.id, activeSession.id)}
                        disabled={!!actionState}
                        style={{
                          flex: 1, padding: '9px 12px', borderRadius: 10,
                          border: 'none', cursor: actionState ? 'not-allowed' : 'pointer',
                          background: actionState ? '#fca5a5' : '#ef4444',
                          color: '#fff', fontWeight: 700, fontSize: 13,
                          display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 7,
                          transition: 'background 0.15s',
                        }}
                      >
                        {actionState === 'stopping'
                          ? <><Loader2 size={14} className="animate-spin" /> Stopping...</>
                          : <><MonitorStop size={15} /> Stop</>
                        }
                      </button>
                    </div>
                  ) : (
                    <button
                      id={`start-rec-${emp.id}`}
                      onClick={() => startRecording(emp.id)}
                      disabled={!!actionState}
                      style={{
                        width: '100%', padding: '9px 16px', borderRadius: 10,
                        border: 'none', cursor: actionState ? 'not-allowed' : 'pointer',
                        background: actionState ? '#a5b4fc' : 'linear-gradient(135deg,#6366f1,#4f46e5)',
                        color: '#fff', fontWeight: 700, fontSize: 13,
                        display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 7,
                        transition: 'all 0.15s', boxShadow: '0 2px 8px rgba(99,102,241,0.3)',
                      }}
                    >
                      {actionState === 'starting'
                        ? <><Loader2 size={14} className="animate-spin" /> Starting...</>
                        : <><MonitorPlay size={15} /> Start Recording</>
                      }
                    </button>
                  )}
                </motion.div>
              );
            })}
          </div>
        )}
      </div>

      {/* ── Session History ──────────────────────────────────────────────── */}
      <div>
        <h3 style={{ fontSize: 14, fontWeight: 600, color: '#475569', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 12 }}>
          Recording Sessions
        </h3>

        {sessions.length === 0 ? (
          <Card>
            <CardBody style={{ textAlign: 'center', padding: 40, color: '#94a3b8' }}>
              <Video size={40} style={{ margin: '0 auto 12px', opacity: 0.4 }} />
              <p>No recording sessions yet. Start a recording above.</p>
            </CardBody>
          </Card>
        ) : (
          <Card>
            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                <thead>
                  <tr style={{ background: '#f8fafc', borderBottom: '1px solid #e2e8f0' }}>
                    {['Employee', 'Started', 'Duration', 'Status', 'Chunks', 'Actions'].map((h) => (
                      <th key={h} style={{ padding: '10px 16px', textAlign: 'left', fontSize: 11, fontWeight: 700, color: '#64748b', textTransform: 'uppercase', letterSpacing: '0.06em', whiteSpace: 'nowrap' }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {sessions.slice(0, 50).map((session) => {
                    const meta = statusMeta(session.status);
                    const emp = getEmployee(session.user_id);
                    const isExpanded = expandedSession === session.id;

                    return (
                      <React.Fragment key={session.id}>
                        <tr
                          onClick={() => setExpandedSession(isExpanded ? null : session.id)}
                          style={{
                            borderBottom: '1px solid #f1f5f9',
                            cursor: 'pointer',
                            background: isExpanded ? '#f8fafc' : 'transparent',
                            transition: 'background 0.15s',
                          }}
                          onMouseEnter={(e) => e.currentTarget.style.background = '#f8fafc'}
                          onMouseLeave={(e) => e.currentTarget.style.background = isExpanded ? '#f8fafc' : 'transparent'}
                        >
                          {/* Employee */}
                          <td style={{ padding: '12px 16px' }}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
                              <div style={{
                                width: 30, height: 30, borderRadius: '50%',
                                background: 'linear-gradient(135deg,#6366f1,#8b5cf6)',
                                display: 'flex', alignItems: 'center', justifyContent: 'center',
                                color: '#fff', fontWeight: 700, fontSize: 11, flexShrink: 0,
                              }}>
                                {emp?.name?.charAt(0) ?? <User size={12} />}
                              </div>
                              <div>
                                <p style={{ fontWeight: 600, fontSize: 13, color: '#0f172a', margin: 0 }}>{emp?.name ?? `User #${session.user_id}`}</p>
                                <p style={{ fontSize: 11, color: '#94a3b8', margin: 0 }}>Session {session.id.substring(0, 8)}</p>
                              </div>
                            </div>
                          </td>

                          {/* Started */}
                          <td style={{ padding: '12px 16px', fontSize: 13, color: '#374151', whiteSpace: 'nowrap' }}>
                            <Clock size={12} style={{ marginRight: 5, verticalAlign: 'middle', color: '#94a3b8' }} />
                            {fmtTime(session.started_at)}
                          </td>

                          {/* Duration */}
                          <td style={{ padding: '12px 16px', fontSize: 13, color: '#374151', whiteSpace: 'nowrap' }}>
                            {fmtDuration(session.started_at, session.ended_at)}
                          </td>

                          {/* Status badge */}
                          <td style={{ padding: '12px 16px' }}>
                            <span style={{
                              display: 'inline-flex', alignItems: 'center', gap: 5,
                              padding: '3px 10px', borderRadius: 20,
                              fontSize: 11, fontWeight: 700,
                              background: meta.bg, color: meta.color,
                              border: `1px solid ${meta.color}33`,
                            }}>
                              {session.status === 'recording' && (
                                <span style={{ width: 6, height: 6, borderRadius: '50%', background: meta.color, animation: 'pulse 1.2s infinite' }} />
                              )}
                              {meta.label}
                            </span>
                          </td>

                          {/* Chunk count */}
                          <td style={{ padding: '12px 16px', fontSize: 13, color: '#374151', textAlign: 'center' }}>
                            {session._count?.chunks ?? '—'}
                          </td>

                          {/* Actions */}
                          <td style={{ padding: '12px 16px' }}>
                            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                              {session.status === 'recording' && (
                                <button
                                  onClick={(e) => { e.stopPropagation(); setLiveStreamSession(session.id); }}
                                  style={{
                                    display: 'flex', alignItems: 'center', gap: 5,
                                    padding: '5px 12px', borderRadius: 8, border: 'none',
                                    background: '#eff6ff', color: '#2563eb', cursor: 'pointer',
                                    fontWeight: 600, fontSize: 12,
                                  }}
                                >
                                  <Eye size={13} /> Live
                                </button>
                              )}
                              {session.status === 'assembled' && (
                                <button
                                  id={`download-${session.id}`}
                                  onClick={(e) => { e.stopPropagation(); downloadSession(session.id); }}
                                  style={{
                                    display: 'flex', alignItems: 'center', gap: 5,
                                    padding: '5px 12px', borderRadius: 8, border: 'none',
                                    background: '#ecfdf5', color: '#059669', cursor: 'pointer',
                                    fontWeight: 600, fontSize: 12,
                                  }}
                                >
                                  <Download size={13} /> Download
                                </button>
                              )}
                              {isExpanded
                                ? <ChevronUp size={15} style={{ color: '#94a3b8', flexShrink: 0 }} />
                                : <ChevronDown size={15} style={{ color: '#94a3b8', flexShrink: 0 }} />
                              }
                            </div>
                          </td>
                        </tr>

                        {/* Expanded detail row */}
                        {isExpanded && (
                          <tr>
                            <td colSpan={6} style={{ padding: 0 }}>
                              <div style={{
                                background: '#f8fafc', borderBottom: '1px solid #e2e8f0',
                                padding: '12px 24px', display: 'flex', gap: 32, flexWrap: 'wrap',
                              }}>
                                <DetailItem label="Session ID" value={session.id} mono />
                                <DetailItem label="Started by" value={session.creator?.name ?? `Admin #${session.created_by}`} />
                                <DetailItem label="Started" value={fmtTime(session.started_at)} />
                                <DetailItem label="Ended" value={fmtTime(session.ended_at)} />
                                <DetailItem label="Chunks received" value={session._count?.chunks ?? 0} />
                                {session.file_path && (
                                  <DetailItem label="File path" value={session.file_path} mono />
                                )}
                              </div>
                            </td>
                          </tr>
                        )}
                      </React.Fragment>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </Card>
        )}
      </div>

      {/* ── Live Stream Modal ───────────────────────────────────────────── */}
      <AnimatePresence>
        {liveStreamSession && (
          <div style={{
            position: 'fixed', top: 0, left: 0, right: 0, bottom: 0,
            background: 'rgba(0,0,0,0.85)', zIndex: 9999,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            padding: 24, backdropFilter: 'blur(8px)',
          }}>
            <motion.div
              initial={{ opacity: 0, scale: 0.95, y: 10 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.95, y: 10 }}
              style={{
                width: '100%', maxWidth: 1000, background: '#0f172a',
                borderRadius: 16, overflow: 'hidden', boxShadow: '0 25px 50px -12px rgba(0,0,0,0.5)',
              }}
            >
              <div style={{
                padding: '16px 24px', borderBottom: '1px solid #1e293b',
                display: 'flex', justifyContent: 'space-between', alignItems: 'center',
              }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  <div style={{ width: 8, height: 8, borderRadius: '50%', background: '#ef4444', animation: 'pulse 1.2s infinite' }} />
                  <h3 style={{ margin: 0, color: '#fff', fontSize: 15, fontWeight: 600 }}>Live Feed (Session: {liveStreamSession.substring(0, 8)})</h3>
                  <span style={{ fontSize: 12, color: '#94a3b8', marginLeft: 8 }}>≈10s latency</span>
                </div>
                <button
                  onClick={() => setLiveStreamSession(null)}
                  style={{ background: 'none', border: 'none', color: '#94a3b8', cursor: 'pointer', padding: 4 }}
                >
                  <X size={20} />
                </button>
              </div>
              <div style={{ position: 'relative', width: '100%', aspectRatio: '16/9', background: '#000' }}>
                <LivePlayer 
                  sessionId={liveStreamSession} 
                  adminId={adminId} 
                  targetUserId={sessions.find(s => s.id === liveStreamSession)?.user_id} 
                />
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

    </SlideUp>
  );
}

function DetailItem({ label, value, mono }) {
  return (
    <div>
      <p style={{ fontSize: 11, color: '#94a3b8', fontWeight: 600, textTransform: 'uppercase', margin: '0 0 2px' }}>{label}</p>
      <p style={{ fontSize: 13, color: '#374151', margin: 0, fontFamily: mono ? 'monospace' : 'inherit' }}>{value ?? '—'}</p>
    </div>
  );
}

// ─── MSE Live Player ──────────────────────────────────────────────────────────

function LivePlayer({ sessionId, adminId, targetUserId }) {
  const videoRef = useRef(null);
  const [error, setError] = useState(null);
  const [isRecording, setIsRecording] = useState(false);
  const mediaRecorderRef = useRef(null);
  const recordedChunksRef = useRef([]);

  useEffect(() => {
    if (!targetUserId) {
      setError('Session target user not found');
      return;
    }

    let destroyed = false;
    const wsBaseUrl = import.meta.env.VITE_API_BASE?.trim().replace(/^http/, 'ws').replace(/\/api\/?$/, '') || 'ws://localhost:5000';
    const wsUrl = `${wsBaseUrl}/admin-recording-ws?adminId=${adminId}`;
    
    let ws = new WebSocket(wsUrl);
    let pc = new RTCPeerConnection({
      iceServers: [{ urls: 'stun:stun.l.google.com:19302' }]
    });

    pc.ontrack = (event) => {
      if (videoRef.current) {
        videoRef.current.srcObject = event.streams[0];
      }
    };

    pc.onicecandidate = (event) => {
      if (event.candidate && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({
          type: 'WEBRTC_ICE_CANDIDATE',
          candidate: event.candidate,
          targetUserId
        }));
      }
    };

    ws.onopen = async () => {
      if (destroyed) { ws.close(); return; }
      try {
        const offer = await pc.createOffer({ offerToReceiveVideo: true });
        await pc.setLocalDescription(offer);
        ws.send(JSON.stringify({
          type: 'WEBRTC_OFFER',
          offer,
          targetUserId
        }));
      } catch (err) {
        setError(`Failed to create offer: ${err.message}`);
      }
    };

    ws.onmessage = async (event) => {
      try {
        const msg = JSON.parse(event.data);
        if (msg.type === 'WEBRTC_ANSWER') {
          await pc.setRemoteDescription(new RTCSessionDescription(msg.answer));
        } else if (msg.type === 'WEBRTC_ICE_CANDIDATE') {
          if (msg.candidate && msg.candidate.candidate) {
            await pc.addIceCandidate(new RTCIceCandidate(msg.candidate));
          }
        } else if (msg.type === 'ERROR') {
          setError(msg.message);
        }
      } catch (err) {
        console.error('[LivePlayer] WS message error:', err);
      }
    };

    ws.onerror = () => {
      setError('WebSocket connection error');
    };

    return () => {
      destroyed = true;
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
        ws.close();
      }
      pc.close();
      if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
        mediaRecorderRef.current.stop();
      }
    };
  }, [sessionId, adminId, targetUserId]);

  const toggleRecording = () => {
    if (isRecording) {
      mediaRecorderRef.current?.stop();
      setIsRecording(false);
    } else {
      if (!videoRef.current?.srcObject) return;
      recordedChunksRef.current = [];
      const mr = new MediaRecorder(videoRef.current.srcObject, { mimeType: 'video/webm' });
      mr.ondataavailable = e => {
        if (e.data.size > 0) recordedChunksRef.current.push(e.data);
      };
      mr.onstop = () => {
        const blob = new Blob(recordedChunksRef.current, { type: 'video/webm' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `snippet-${sessionId.substring(0, 8)}-${Date.now()}.webm`;
        a.click();
        URL.revokeObjectURL(url);
      };
      mr.start();
      mediaRecorderRef.current = mr;
      setIsRecording(true);
    }
  };

  return (
    <div style={{ position: 'relative', width: '100%', height: '100%', display: 'flex', flexDirection: 'column' }}>
      {error && (
        <div style={{ position: 'absolute', top: 0, left: 0, right: 0, background: 'rgba(220,38,38,0.9)', color: '#fff', padding: 12, fontSize: 13, zIndex: 10 }}>
          Error: {error}
        </div>
      )}
      <video
        ref={videoRef}
        autoPlay
        muted
        style={{ width: '100%', flex: 1, objectFit: 'contain' }}
      />
      <div style={{ position: 'absolute', bottom: 16, left: 0, right: 0, display: 'flex', justifyContent: 'center', zIndex: 10 }}>
        <button
          onClick={toggleRecording}
          style={{
            background: isRecording ? '#ef4444' : 'rgba(255,255,255,0.2)',
            color: '#fff', border: '1px solid rgba(255,255,255,0.4)',
            padding: '8px 16px', borderRadius: 20, cursor: 'pointer',
            fontWeight: 600, fontSize: 13, display: 'flex', alignItems: 'center', gap: 6,
            backdropFilter: 'blur(4px)'
          }}
        >
          {isRecording ? <MonitorStop size={14} /> : <Video size={14} />}
          {isRecording ? 'Stop Recording' : 'Record Snippet'}
        </button>
      </div>
    </div>
  );
}
