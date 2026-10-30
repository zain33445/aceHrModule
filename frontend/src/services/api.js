import axios from "axios";
import { API_BASE } from "./endpoints";

/**
 * Attaches the signed session token to every request.
 *
 * The token is issued by POST /api/auth/login and stored alongside the rest
 * of the auth object in localStorage. The legacy per-endpoint headers
 * (X-User-Id, X-Admin-Id) are untouched — this only *adds* a credential for
 * the routes that require a verifiable identity (voice/video calling).
 */
axios.interceptors.request.use((config) => {
  try {
    const auth = JSON.parse(localStorage.getItem('bio_auth') || 'null');
    if (auth?.token) {
      config.headers = config.headers || {};
      config.headers.Authorization = `Bearer ${auth.token}`;
    }
  } catch {
    /* no stored session — leave the request unauthenticated */
  }
  return config;
});

/**
 * Session tokens are short-lived. A request refused with TOKEN_EXPIRED gets
 * one refresh and one retry; concurrent failures share a single refresh. If
 * the refresh itself is refused the session was logged out (here or on the
 * server), so the app is told to sign out via the `auth:expired` event.
 */
let refreshing = null;

function refreshSession(token) {
  if (!refreshing) {
    refreshing = axios
      .post(`${API_BASE}/auth/refresh`, {}, {
        headers: { Authorization: `Bearer ${token}` },
        _skipRefresh: true,
      })
      .then((res) => {
        const auth = JSON.parse(localStorage.getItem('bio_auth') || 'null');
        // Signed out while the refresh was in flight: do not resurrect it.
        if (!auth) throw new Error('signed out');
        auth.token = res.data.token;
        localStorage.setItem('bio_auth', JSON.stringify(auth));
        return res.data.token;
      })
      .finally(() => {
        refreshing = null;
      });
  }
  return refreshing;
}

axios.interceptors.response.use(undefined, async (error) => {
  const { config, response } = error;
  const sent = config?.headers?.Authorization;
  if (
    response?.status !== 401 ||
    response.data?.code !== 'TOKEN_EXPIRED' ||
    !config ||
    config._skipRefresh ||
    config._retried ||
    !sent
  ) {
    throw error;
  }

  try {
    await refreshSession(String(sent).replace(/^Bearer /, ''));
  } catch (refreshError) {
    if (refreshError?.response?.status === 401) {
      window.dispatchEvent(new Event('auth:expired'));
    }
    throw error;
  }

  // The request interceptor attaches the refreshed token from storage.
  config._retried = true;
  return axios(config);
});

const api = {
  // Existing methods...
  getEmployees: () => axios.get(`${API_BASE}/employees`),
  getUsers: () => axios.get(`${API_BASE}/employees`),
  getAttendance: () => axios.get(`${API_BASE}/attendance`),
  getUserAttendance: (userId) => axios.get(`${API_BASE}/attendance/${userId}`),
  getSalaryReport: (start, end) => {
    const params = {};
    if (start) params.start_date = start;
    if (end) params.end_date = end;
    return axios.get(`${API_BASE}/attendance/report/salary-report`, { params });
  },
  updateEmployee: (userId, salary) =>
    axios.post(`${API_BASE}/employees/update-employee`, {
      user_id: userId,
      monthly_salary: parseFloat(salary),
    }),
  updateLeaves: (userId, leaves) =>
    axios.post(`${API_BASE}/employees/update-leaves`, {
      user_id: userId,
      leave_bank: parseInt(leaves),
    }),
  updateUsername: (userId, username) =>
    axios.post(`${API_BASE}/employees/update-username`, {
      user_id: userId,
      username: username,
    }),
  updateEmployeeStatus: (userId, data) =>
    axios.post(`${API_BASE}/employees/update-status`, {
      user_id: userId,
      ...data,
    }),
  createEmployee: (data) => axios.post(`${API_BASE}/employees`, data),
  deleteEmployee: (userId) => axios.delete(`${API_BASE}/employees/${userId}`),
  login: (username, password) => axios.post(`${API_BASE}/auth/login`, { username, password }),
  /** Revokes the session on the server; the token passed is the one to kill. */
  logout: (token) =>
    axios.post(`${API_BASE}/auth/logout`, {}, {
      headers: { Authorization: `Bearer ${token}` },
      _skipRefresh: true,
    }),
  updatePassword: (userId, newPassword) =>
    axios.post(`${API_BASE}/auth/update-password`, {
      user_id: userId,
      new_password: newPassword,
    }),
  changePassword: (data) => axios.post(`${API_BASE}/auth/change-password`, data),

  // Absence Management APIs (uses AttendanceRecord table, not AttendanceLog)
  getAbsences: (startDate, endDate, status, userId, page = 1, limit = 20) => {
    const params = { page, limit };
    if (startDate) params.startDate = startDate;
    if (endDate) params.endDate = endDate;
    if (status && status !== 'all') params.status = status;
    if (userId && userId !== 'all') params.userId = userId;
    return axios.get(`${API_BASE}/absences`, { params });
  },
  getUserAbsences: (userId, startDate, endDate, status, page = 1, limit = 20) => {
    const params = { page, limit };
    if (startDate) params.startDate = startDate;
    if (endDate) params.endDate = endDate;
    if (status && status !== 'all') params.status = status;
    return axios.get(`${API_BASE}/absences/user/${userId}`, { params });
  },
  // Get attendance records (from AttendanceRecord table, not AttendanceLog)
  getUserAttendanceRecords: (userId, startDate, endDate, status, page = 1, limit = 20) => {
    const params = { page, limit };
    if (startDate) params.startDate = startDate;
    if (endDate) params.endDate = endDate;
    if (status && status !== 'all') params.status = status;
    return axios.get(`${API_BASE}/absences/user/${userId}`, { params });
  },
  getUserAbsenceStats: (userId, startDate, endDate) => {
    const params = {};
    if (startDate) params.startDate = startDate;
    if (endDate) params.endDate = endDate;
    return axios.get(`${API_BASE}/absences/user/${userId}/stats`, { params });
  },
  processAbsences: (date) =>
    axios.post(`${API_BASE}/absences/process/${date || ""}`),
  processDailyAbsences: () => axios.post(`${API_BASE}/absences/process-daily`),
  syncAttendanceToday: () => axios.post(`${API_BASE}/absences/sync-today`),

  // Manual Punch (Check-In / Check-Out from the employee dashboard)
  getTodayAttendance: (userId) => axios.get(`${API_BASE}/attendance/today/${userId}`),
  manualPunch: (userId, type) =>
    axios.post(`${API_BASE}/attendance/manual-punch`, { userId, type }),

  // Leave Bank Management APIs
  getAllLeaveBanks: () => axios.get(`${API_BASE}/absences/leave-bank`),
  getUserLeaveBank: (userId, leaveTypeId) => {
    const params = {};
    if (leaveTypeId) params.leaveTypeId = leaveTypeId;
    return axios.get(`${API_BASE}/absences/leave-bank/user/${userId}`, { params });
  },
  updateLeaveBank: (userId, leavesRemaining, leaveTypeId) =>
    axios.put(`${API_BASE}/absences/leave-bank/user/${userId}`, {
      leaves_remaining: parseFloat(leavesRemaining),
      leave_type_id: leaveTypeId || 1,
    }),
  resetLeaveBank: (userId, leaveTypeId) =>
    axios.post(`${API_BASE}/absences/leave-bank/user/${userId}/reset`, {
      leave_type_id: leaveTypeId || 1,
    }),
  deductLeaveBank: (userId, amount, reason, date, leaveTypeId) =>
    axios.post(`${API_BASE}/absences/leave-bank/user/${userId}/deduct`, {
      amount,
      reason,
      date,
      leave_type_id: leaveTypeId || 1,
    }),

  // Dispute Management APIs
  createDispute: (data) => axios.post(`${API_BASE}/disputes`, data),
  getMyDisputes: (userId) => axios.get(`${API_BASE}/disputes/user/${userId}`),
  getAllDisputes: (page = 1, limit = 20) => axios.get(`${API_BASE}/disputes`, { params: { page, limit } }),
  getTeamDisputes: (leadId, page = 1, limit = 20) => 
    axios.get(`${API_BASE}/disputes/team`, { params: { leadId, page, limit } }),
  
  leadApproveDispute: (disputeId, data) =>
    axios.put(`${API_BASE}/disputes/${disputeId}/lead-approval`, data),
    
  adminApproveDispute: (disputeId, data) =>
    axios.put(`${API_BASE}/disputes/${disputeId}/admin-approval`, data),

  hrApproveDispute: (disputeId, data) =>
    axios.put(`${API_BASE}/disputes/${disputeId}/hr-approval`, data),
  
  deleteDispute: (disputeId) => axios.delete(`${API_BASE}/disputes/${disputeId}`),

  // Salary History
  getUserSalaryHistory: (userId, startDate, endDate, page = 1, limit = 20) => {
    const params = { page, limit };
    if (startDate) params.startDate = startDate;
    if (endDate) params.endDate = endDate;
    return axios.get(`${API_BASE}/salaries/user/${userId}`, { params });
  },
  getUserDeductions: (userId, startDate, endDate, type, page = 1, limit = 20) => {
    const params = { page, limit };
    if (startDate) params.startDate = startDate;
    if (endDate) params.endDate = endDate;
    if (type && type !== 'all') params.type = type;
    return axios.get(`${API_BASE}/deductions/user/${userId}`, { params });
  },
  getUserDisputes: (userId, startDate, endDate, category, page = 1, limit = 20) => {
    const params = { page, limit };
    if (startDate) params.startDate = startDate;
    if (endDate) params.endDate = endDate;
    if (category && category !== 'all') params.category = category;
    return axios.get(`${API_BASE}/disputes/user/${userId}`, { params });
  },

  // Notification APIs
  getNotifications: (userId) => axios.get(`${API_BASE}/notifications/user/${userId}`),
  markNotificationRead: (id) => axios.put(`${API_BASE}/notifications/${id}/read`),
  markAllNotificationsRead: (userId) => axios.put(`${API_BASE}/notifications/user/${userId}/read-all`),
  getNotificationPreferences: (userId) => axios.get(`${API_BASE}/notifications/preferences/${userId}`),
  saveNotificationPreferences: (userId, preferences) => axios.put(`${API_BASE}/notifications/preferences`, { user_id: userId, preferences }),

  // Departments
  getDepartments: () => axios.get(`${API_BASE}/departments`),
  createDepartment: (data) => axios.post(`${API_BASE}/departments`, data),
  updateDepartment: (id, data) => axios.put(`${API_BASE}/departments/${id}`, data),
  deleteDepartment: (id) => axios.delete(`${API_BASE}/departments/${id}`),
  assignEmployeeToDept: (deptId, userId) => axios.put(`${API_BASE}/departments/${deptId}/assign-employee`, { user_id: userId }),
  removeEmployeeFromDept: (deptId, userId) => axios.put(`${API_BASE}/departments/${deptId}/remove-employee`, { user_id: userId }),

  // Holidays
  getHolidays: () => axios.get(`${API_BASE}/holidays`),
  createHoliday: (data) => axios.post(`${API_BASE}/holidays`, data),
  createHolidayRange: (data) => axios.post(`${API_BASE}/holidays/bulk`, data),
  deleteHoliday: (id) => axios.delete(`${API_BASE}/holidays/${id}`),
  processHolidays: () => axios.post(`${API_BASE}/holidays/process`),

  // Leave Types
  getLeaveTypes: () => axios.get(`${API_BASE}/leave-types`),

  // Leave Balance Summary (admin report: remaining/used/accrual per type + totals)
  getLeaveSummary: (departmentId) => {
    const params = {};
    if (departmentId && departmentId !== "all") params.department_id = departmentId;
    return axios.get(`${API_BASE}/leave-summary`, { params });
  },

  // Leave Requests
  getLeaveRequests: (userId, status) => {
    const params = {};
    if (userId) params.user_id = userId;
    if (status && status !== 'all') params.status = status;
    return axios.get(`${API_BASE}/leave-requests`, { params });
  },
  createLeaveRequest: (data) => axios.post(`${API_BASE}/leave-requests`, data),
  // Status must now be uppercase enum: 'APPROVED' | 'REJECTED' | 'CANCELLED'
  updateLeaveRequestStatus: (id, status, reviewed_by) =>
    axios.put(`${API_BASE}/leave-requests/${id}/status`, { status, reviewed_by }),

  // Leave Ledger (Balance & History)
  getLeaveBalance: (userId) => axios.get(`${API_BASE}/leave-ledger/balance/${userId}`),
  getLedgerHistory: (userId) => axios.get(`${API_BASE}/leave-ledger/history/${userId}`),
  applyLeaveAdjustment: (data) => axios.post(`${API_BASE}/leave-ledger/adjust`, data),

  // Leave Policies (Employee-specific accrual rules)
  getLeavePolicies: (userId) => axios.get(`${API_BASE}/leave-policies/${userId}`),
  upsertLeavePolicy: (data) => axios.post(`${API_BASE}/leave-policies`, data),
  createLeavePoliciesBulk: (data) => axios.post(`${API_BASE}/leave-policies/bulk`, data),
  applyActivePolicies: () => axios.post(`${API_BASE}/leave-policies/apply-active`),

  // Audit Logs
  getAuditLogs: (page = 1, limit = 100) => 
    axios.get(`${API_BASE}/audit`, { params: { page, limit } }),

  // Bulk Pay
  processBulkSalary: (date) => axios.post(`${API_BASE}/salaries/bulk-pay`, { date }),

  // Monitoring
  getMonitoringLogs: (params) => {
    const query = new URLSearchParams(params).toString();
    return axios.get(`${API_BASE}/monitoring/logs?${query}`);
  },

  // Export URLs (these return files so often handled via window.open instead of axios, but keeping paths here)
  getExportAttendanceUrl: (startDate, endDate) => 
    `${API_BASE}/export/attendance?start_date=${startDate || ''}&end_date=${endDate || ''}`,
  getExportSalaryUrl: (startDate, endDate) => 
    `${API_BASE}/export/salary?start_date=${startDate || ''}&end_date=${endDate || ''}`,

  // ── Recording System APIs ──────────────────────────────────────────────────
  recordingGetAgents: (adminId) =>
    axios.get(`${API_BASE}/recording/agents`, {
      headers: { 'X-Admin-Id': String(adminId) },
    }),
  recordingGetSessions: (adminId, userId) =>
    axios.get(`${API_BASE}/recording/sessions`, {
      headers: { 'X-Admin-Id': String(adminId) },
      params: userId ? { userId } : {},
    }),
  recordingGetStatus: (adminId, userId) =>
    axios.get(`${API_BASE}/recording/status/${userId}`, {
      headers: { 'X-Admin-Id': String(adminId) },
    }),
  recordingStartSession: (adminId, userId, quality = '720p') =>
    axios.post(
      `${API_BASE}/recording/session/start`,
      { user_id: String(userId), quality },
      { headers: { 'X-Admin-Id': String(adminId) } }
    ),
  recordingStopSession: (adminId, sessionId) =>
    axios.post(
      `${API_BASE}/recording/session/stop`,
      { session_id: sessionId },
      { headers: { 'X-Admin-Id': String(adminId) } }
    ),
  recordingGetDownloadUrl: (sessionId) =>
    `${API_BASE}/recording/sessions/${sessionId}/file`,
  recordingGetAdminWsToken: (adminId) =>
    axios.post(`${API_BASE}/recording/admin-ws-token`, {}, {
      headers: { 'X-Admin-Id': String(adminId) },
    }),

  // Tab Access (HR Feature Assignment)
  getHrEmployeesWithTabs: () => axios.get(`${API_BASE}/tab-access/hr-employees`),
  toggleTabAccess: (userId, tabKey, granted) =>
    axios.post(`${API_BASE}/tab-access/toggle`, { user_id: userId, tab_key: tabKey, granted }),
  getMyTabAccess: (userId) => axios.get(`${API_BASE}/tab-access/my-tabs`, { params: { user_id: userId } }),

  // ── Overtime APIs ──────────────────────────────────────────────────────────
  getEligibleOvertimeDates: (month, userId) =>
    axios.get(`${API_BASE}/overtime/eligible-dates`, { params: { month, userId } }),
  createOvertimeRequest: (data) => axios.post(`${API_BASE}/overtime`, data),
  getMyOvertimeRequests: (userId, month) =>
    axios.get(`${API_BASE}/overtime/my`, { params: { userId, month } }),
  cancelOvertimeRequest: (id, userId) =>
    axios.put(`${API_BASE}/overtime/${id}/cancel`, { userId }),
  getAllOvertimeRequests: (params) =>
    axios.get(`${API_BASE}/overtime`, { params }),
  approveOvertimeRequest: (id, approvedBy, multiplier) =>
    axios.put(`${API_BASE}/overtime/${id}/approve`, { approved_by: approvedBy, multiplier }),
  rejectOvertimeRequest: (id, approvedBy, reason) =>
    axios.put(`${API_BASE}/overtime/${id}/reject`, { approved_by: approvedBy, rejection_reason: reason }),
  getOvertimeSummary: (month) =>
    axios.get(`${API_BASE}/overtime/summary`, { params: { month } }),
  getTeamOvertimeRequests: (leadId, month, status) => {
    const params = { leadId };
    if (month) params.month = month;
    if (status && status !== 'all') params.status = status;
    return axios.get(`${API_BASE}/overtime/team`, { params });
  },
  leadApproveOvertime: (id, leadId, multiplier, remarks) =>
    axios.put(`${API_BASE}/overtime/${id}/lead-approve`, { lead_id: leadId, multiplier, remarks }),
  leadRejectOvertime: (id, leadId, remarks) =>
    axios.put(`${API_BASE}/overtime/${id}/lead-reject`, { lead_id: leadId, remarks }),

  // ── Team Leave APIs ───────────────────────────────────────────────────────
  getTeamLeaveRequests: (leadId, status) => {
    const params = { leadId };
    if (status && status !== 'all') params.status = status;
    return axios.get(`${API_BASE}/leave-requests/team`, { params });
  },
  leadApproveLeave: (id, leadId, remarks) =>
    axios.put(`${API_BASE}/leave-requests/${id}/lead-approval`, { lead_id: leadId, action: 'approved', remarks }),
  leadRejectLeave: (id, leadId, remarks) =>
    axios.put(`${API_BASE}/leave-requests/${id}/lead-approval`, { lead_id: leadId, action: 'rejected', remarks }),

  // ── Chat ──────────────────────────────────────────────
  getChatConversations: (userId) =>
    axios.get(`${API_BASE}/chat/conversations`, { headers: { 'X-User-Id': userId } }),
  getChatMessages: (userId, conversationId, before) =>
    axios.get(`${API_BASE}/chat/conversations/${conversationId}/messages`, {
      headers: { 'X-User-Id': userId },
      params: before ? { before } : {},
    }),
  openDirectChat: (userId, otherUserId) =>
    axios.post(`${API_BASE}/chat/direct`, { user_id: userId, other_user_id: otherUserId }),
  createDepartmentGroup: (userId, departmentId) =>
    axios.post(`${API_BASE}/chat/groups`, { user_id: userId, department_id: departmentId }),
  sendChatMessage: (userId, conversationId, text, attachments = []) =>
    axios.post(`${API_BASE}/chat/conversations/${conversationId}/messages`, { user_id: userId, text, attachments }),
  markChatRead: (userId, conversationId) =>
    axios.post(`${API_BASE}/chat/conversations/${conversationId}/read`, { user_id: userId }),
  toggleChatReaction: (userId, messageId, emoji) =>
    axios.post(`${API_BASE}/chat/messages/${messageId}/reactions`, { user_id: userId, emoji }),
  chatAttachmentUrl: (conversationLessAttachmentId, userId) =>
    `${API_BASE}/chat/attachments/${conversationLessAttachmentId}?user_id=${encodeURIComponent(userId)}`,

  // ── Voice & video calls ────────────────────────────────
  // These require the signed session token (sent by the interceptor above).
  getCallWsToken: () => axios.post(`${API_BASE}/call/ws-token`),
  getCallIceServers: () => axios.get(`${API_BASE}/call/ice-servers`),
  startCall: (userId, targetUserIds, conversationId) =>
    axios.post(`${API_BASE}/call/sessions`, {
      user_id: userId,
      target_user_ids: targetUserIds,
      conversation_id: conversationId || null,
    }),
  getCalls: (limit) => axios.get(`${API_BASE}/call/sessions`, { params: limit ? { limit } : {} }),
  getCall: (callId) => axios.get(`${API_BASE}/call/sessions/${callId}`),
  acceptCall: (callId) => axios.post(`${API_BASE}/call/sessions/${callId}/accept`),
  declineCall: (callId) => axios.post(`${API_BASE}/call/sessions/${callId}/decline`),
  leaveCall: (callId) => axios.post(`${API_BASE}/call/sessions/${callId}/leave`),
  endCall: (callId) => axios.post(`${API_BASE}/call/sessions/${callId}/end`),
  getCallHistory: (limit) => axios.get(`${API_BASE}/call/history`, { params: limit ? { limit } : {} }),
  uploadCallChunk: (callId, chunkIndex, buffer) =>
    axios.post(`${API_BASE}/call/recordings/chunk`, buffer, {
      headers: {
        'Content-Type': 'application/octet-stream',
        'X-Call-Id': callId,
        'X-Chunk-Index': String(chunkIndex),
      },
    }),
  getCallRecordings: (callId) => axios.get(`${API_BASE}/call/recordings/call/${callId}`),
  callRecordingUrl: (callId) => `${API_BASE}/call/recordings/call/${callId}/play`,
};


export default api;
