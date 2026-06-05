import axios from "axios";

const API_BASE = import.meta.env.VITE_API_BASE || "http://localhost:5000/api";

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
  createEmployee: (data) => axios.post(`${API_BASE}/employees`, data),
  deleteEmployee: (userId) => axios.delete(`${API_BASE}/employees/${userId}`),
  login: (username, password) => axios.post(`${API_BASE}/auth/login`, { username, password }),
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

  // Leave Bank Management APIs
  getAllLeaveBanks: () => axios.get(`${API_BASE}/absences/leave-bank`),
  getUserLeaveBank: (userId) =>
    axios.get(`${API_BASE}/absences/leave-bank/user/${userId}`),
  updateLeaveBank: (userId, leavesRemaining) =>
    axios.put(`${API_BASE}/absences/leave-bank/user/${userId}`, {
      leaves_remaining: parseFloat(leavesRemaining),
    }),
  resetLeaveBank: (userId) =>
    axios.post(`${API_BASE}/absences/leave-bank/user/${userId}/reset`),
  deductLeaveBank: (userId, amount, reason, date) =>
    axios.post(`${API_BASE}/absences/leave-bank/user/${userId}/deduct`, { amount, reason, date }),

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
};


export default api;
