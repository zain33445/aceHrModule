import axios from "axios";

const API_BASE = import.meta.env.VITE_API_BASE || "http://localhost:5000/api";

const api = {
  // Existing methods...
  getEmployees: () => axios.get(`${API_BASE}/employees`),
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
      leaves_remaining: parseInt(leavesRemaining),
    }),
  resetLeaveBank: (userId) =>
    axios.post(`${API_BASE}/absences/leave-bank/user/${userId}/reset`),

  // Dispute Management APIs
  createDispute: (data) => axios.post(`${API_BASE}/disputes`, data),
  getMyDisputes: (userId) => axios.get(`${API_BASE}/disputes/user/${userId}`),
  getPendingDisputes: () => axios.get(`${API_BASE}/disputes/pending`),
  getAdminDisputes: () => axios.get(`${API_BASE}/disputes/pending`),
  getAllDisputes: () => axios.get(`${API_BASE}/disputes`),
  approveDispute: (disputeId, remarks) =>
    axios.put(`${API_BASE}/disputes/${disputeId}/approve`, { remarks }),
  rejectDispute: (disputeId, remarks) =>
    axios.put(`${API_BASE}/disputes/${disputeId}/reject`, { remarks }),

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

  // Holidays
  getHolidays: () => axios.get(`${API_BASE}/holidays`),
  createHoliday: (data) => axios.post(`${API_BASE}/holidays`, data),
  deleteHoliday: (id) => axios.delete(`${API_BASE}/holidays/${id}`),

  // Leave Requests
  getLeaveRequests: (userId, status) => {
    const params = {};
    if (userId) params.user_id = userId;
    if (status) params.status = status;
    return axios.get(`${API_BASE}/leave-requests`, { params });
  },
  createLeaveRequest: (data) => axios.post(`${API_BASE}/leave-requests`, data),
  updateLeaveRequestStatus: (id, status, reviewed_by) => 
    axios.put(`${API_BASE}/leave-requests/${id}/status`, { status, reviewed_by }),

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
};

export default api;
