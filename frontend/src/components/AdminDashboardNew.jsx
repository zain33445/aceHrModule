import React, { useState, useEffect, useMemo, useCallback } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  Users,
  Clock,
  AlertCircle,
  CheckCircle2,
  TrendingUp,
  Calendar,
  Plus,
  Filter,
  Download,
  RefreshCw,
  Eye,
  MessageSquare,
  History,
  ShieldCheck,
  XCircle,
  ChevronRight,
  UserCheck,
  Shield,
} from 'lucide-react';
import LayoutContainer from './layout/LayoutContainer';
import StatCard from './dashboard/StatCard';
import { Tabs } from './common/Tabs';
import { Button } from './common/Button';
import { Card, CardHeader, CardBody, CardFooter } from './common/Card';
import { SlideUp, FadeIn } from './animations';
import { Badge } from './common/Badge';
import api from '../services/api';
import StaffManager from './StaffManager';
import { AttendanceFilters } from './common/AttendanceFilters';
import { Pagination } from './common/Pagination';

import { DashboardAnalytics } from './analytics/DashboardAnalytics';
import { DepartmentManager } from './departments/DepartmentManager';
import { HolidayCalendar } from './calendar/HolidayCalendar';
import { LeaveRequestHub } from './leaves/LeaveRequestHub';
import { AuditLogTab } from './audit/AuditLogTab';
import { DataExportPanel } from './export/DataExportPanel';
import ScreenshotsTab from './dashboard/ScreenshotsTab';
import { PayslipPDFButton } from './salary/PayslipPDFButton';
import { formatTime12h } from '../utils/formatters';

function AdminDashboardNew({ employees = [], report = [], user, onLogout, onRefresh }) {
  const [activeTab, setActiveTab] = useState('overview');
  const [absences, setAbsences] = useState([]);
  const [overviewLoading, setOverviewLoading] = useState(false);
  const [attendanceLoading, setAttendanceLoading] = useState(false);
  const [disputeLoading, setDisputeLoading] = useState(false);
  const [disputes, setDisputes] = useState([]);
  const [disputePagination, setDisputePagination] = useState({ currentPage: 1, totalPages: 1, totalRecords: 0 });
  const [selectedDispute, setSelectedDispute] = useState(null);
  const [showDisputeDetail, setShowDisputeDetail] = useState(false);
  const [notifications, setNotifications] = useState([]);
  const [pagination, setPagination] = useState({
    currentPage: 1,
    totalPages: 1,
    totalRecords: 0
  });
  const [attendanceFilters, setAttendanceFilters] = useState({
    startDate: undefined,
    endDate: undefined,
    status: 'all',
    userId: 'all'
  });
  const [stats, setStats] = useState({
    total_employees: employees.length || 0,
    present_today: 0,
    absent_today: 0,
    on_leave: 0,
  });
  const [isSyncing, setIsSyncing] = useState(false);
  const [payrollExportMonth, setPayrollExportMonth] = useState('');

  const handleSyncAttendance = async () => {
    setIsSyncing(true);
    try {
      await api.syncAttendanceToday();
      fetchOverviewData();
      if (activeTab === 'attendance') fetchAttendanceData(attendanceFilters.startDate, attendanceFilters.endDate, attendanceFilters.status, attendanceFilters.userId, pagination.currentPage);
    } catch (err) {
      console.error('Failed to sync', err);
      alert('Failed to sync attendance');
    }
    setIsSyncing(false);
  };

  useEffect(() => {
    if (activeTab === 'overview') {
      fetchOverviewData();
    } else if (activeTab === 'attendance') {
      fetchAttendanceData();
    } else if (activeTab === 'disputes') {
      fetchDisputeData();
    }
  }, [activeTab]);

  const fetchNotifications = async () => {
    if (!user?.user_id) return;
    try {
      const res = await api.getNotifications(user.user_id);
      setNotifications((res.data || []).map(n => ({
        id: n.id,
        type: n.type,
        title: n.type === 'new_dispute' ? 'New Dispute' :
               n.type === 'dispute_approved' ? 'Dispute Approved' :
               n.type === 'dispute_rejected' ? 'Dispute Rejected' : 
               n.type === 'new_leave_request' ? 'New Leave Request' :
               n.type === 'leave_approved' ? 'Leave Approved' :
               n.type === 'leave_rejected' ? 'Leave Rejected' : 'Notification',
        message: n.message,
        read: n.is_read,
        created_at: n.created_at
      })));
    } catch (err) {
      console.error('Error fetching notifications:', err);
    }
  };

  useEffect(() => {
    fetchNotifications();
    const interval = setInterval(fetchNotifications, 30000);
    return () => clearInterval(interval);
  }, [user?.user_id]);

  const handleNotificationClick = async (notif) => {
    if (!notif.read) {
      try {
        await api.markNotificationRead(notif.id);
        fetchNotifications();
      } catch (err) {
        console.error('Error marking notification as read:', err);
      }
    }
    
    if (notif.type === 'new_dispute' || notif.type === 'dispute_approved' || notif.type === 'dispute_rejected') {
      setActiveTab('disputes');
    } else if (notif.type === 'new_leave_request' || notif.type === 'leave_approved' || notif.type === 'leave_rejected') {
      setActiveTab('leaves');
    }
  };

  const fetchOverviewData = useCallback(async () => {
    setOverviewLoading(true);
    try {
      const lastWeek = new Date();
      lastWeek.setDate(lastWeek.getDate() - 7);
      const absencesRes = await api.getAbsences(lastWeek.toISOString(), undefined, 'all', 'all', 1, 500);
      const { records: absen = [] } = absencesRes.data || {};
      
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      const todayEnd = new Date(today);
      todayEnd.setHours(23, 59, 59, 999);

      const todayRecords = absen.filter((r) => {
        const rDate = new Date(r.date);
        return rDate >= today && rDate <= todayEnd;
      });

      const presentToday = new Set(todayRecords.filter((r) => r.status === 'present').map((r) => r.user_id)).size;
      const absentToday = new Set(todayRecords.filter((r) => r.status === 'absent').map((r) => r.user_id)).size;
      const onLeaveToday = new Set(todayRecords.filter((r) => r.status === 'leave').map((r) => r.user_id)).size;

      setStats({
        total_employees: employees.length || 0,
        present_today: presentToday,
        absent_today: absentToday,
        on_leave: onLeaveToday,
      });

      setAbsences(absen);
    } catch (err) {
      console.error('Error fetching overview:', err);
    }
    setOverviewLoading(false);
  }, [employees.length]);

  const fetchAttendanceData = useCallback(async (startDate, endDate, status, userId, page = 1) => {
    setAttendanceLoading(true);
    const sDate = startDate !== undefined ? startDate : attendanceFilters.startDate;
    const eDate = endDate !== undefined ? endDate : attendanceFilters.endDate;
    const st = status !== undefined ? status : attendanceFilters.status;
    const uId = userId !== undefined ? userId : attendanceFilters.userId;

    try {
      const absencesRes = await api.getAbsences(sDate, eDate, st, uId, page);
      const { records, total } = absencesRes.data;
      setAbsences(records || []);
      setPagination({
        currentPage: page,
        totalPages: Math.ceil(total / 20),
        totalRecords: total
      });
      setAttendanceFilters({ startDate: sDate, endDate: eDate, status: st, userId: uId });
    } catch (err) {
      console.error('Error fetching attendance:', err);
    }
    setAttendanceLoading(false);
  }, [attendanceFilters]);

  const fetchDisputeData = useCallback(async (page = 1) => {
    setDisputeLoading(true);
    try {
      const res = await api.getAllDisputes(page);
      if (res.data?.success) {
        setDisputes(res.data.data.records || []);
        setDisputePagination({
          currentPage: page,
          totalPages: Math.ceil((res.data.data.total || 0) / 20),
          totalRecords: res.data.data.total || 0
        });
      }
    } catch (err) {
      console.error('Error fetching disputes:', err);
    }
    setDisputeLoading(false);
  }, []);

  const handleAdminApproval = async (disputeId, action, remarks) => {
    try {
      const res = await api.adminApproveDispute(disputeId, { 
        admin_id: user.user_id, 
        action, 
        remarks 
      });
      if (res.data?.success) {
        fetchDisputeData(disputePagination.currentPage);
        setShowDisputeDetail(false);
        // Toast or success message
      }
    } catch (err) {
      alert(err.response?.data?.error || 'Failed to update dispute');
    }
  };

  const handleUpdateEmployee = useCallback(async (userId, value, key) => {
    try {
      if (key === 'monthly_salary') {
        await api.updateEmployee(userId, value);
      } else if (key === 'leave_bank') {
        await api.updateLeaves(userId, value);
      }
      fetchOverviewData();
    } catch {
      alert("Failed to update setting");
    }
  }, [fetchOverviewData]);

  const handleShowHistory = useCallback((user) => {
    alert(`Checking history for ${user.name}`);
  }, []);

  const handleUpdatePassword = useCallback(async (userId, newPassword) => {
    try {
      await api.updatePassword(userId, newPassword);
    } catch {
      alert("Failed to update password");
    }
  }, []);

  const [isExporting, setIsExporting] = useState(false);

  const handleExport = async () => {
    const baseUrl = import.meta.env.VITE_API_BASE || 'http://localhost:5000/api';
    let url = '';
    let filename = 'export.xlsx';

    if (activeTab === 'attendance') {
      const { startDate, endDate, userId } = attendanceFilters;
      const params = new URLSearchParams();
      if (startDate) params.set('start_date', startDate);
      if (endDate) params.set('end_date', endDate);
      if (userId && userId !== 'all') params.set('user_id', userId);
      url = `${baseUrl}/export/attendance?${params.toString()}`;
      filename = `attendance_export.xlsx`;
    } else if (activeTab === 'payroll') {
      let start = '';
      let end = '';
      if (payrollExportMonth) {
        const [year, month] = payrollExportMonth.split('-').map(Number);
        start = new Date(year, month - 1, 1).toISOString();
        end = new Date(year, month, 0, 23, 59, 59, 999).toISOString();
        filename = `payroll_${payrollExportMonth}.xlsx`;
      } else {
        filename = `payroll_current_month.xlsx`;
      }
      url = `${baseUrl}/export/salary?start_date=${start}&end_date=${end}`;
    } else {
      alert('Export is available for the Attendance and Payroll tabs.\nPlease switch to one of those tabs first.');
      return;
    }

    setIsExporting(true);
    try {
      const response = await fetch(url);
      const contentType = response.headers.get('content-type') || '';

      if (!response.ok || contentType.includes('application/json')) {
        // Server returned an error — read the JSON message and show alert
        const errJson = await response.json().catch(() => ({ error: 'Export failed. Please try again.' }));
        alert(`Export failed: ${errJson.error || 'Unknown error'}`);
        return;
      }

      // Valid XLSX blob — trigger download without navigating away
      const blob = await response.blob();
      const objectUrl = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = objectUrl;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(objectUrl);
    } catch (err) {
      console.error('Export error:', err);
      alert('Export failed: Unable to reach the server. Please check your connection.');
    } finally {
      setIsExporting(false);
    }
  };

  const getTabLabel = (id) => {
    const labels = {
      overview: 'Analytics',
      departments: 'Departments',
      employees: 'Staff Management',
      attendance: 'Attendance',
      leaves: 'Leave Requests',
      holidays: 'Holidays',
      payroll: 'Payroll',
      disputes: 'Disputes',
      export: 'Data Export',
      audit: 'Audit Logs',
      settings: 'Settings'
    };
    return labels[id] || id.charAt(0).toUpperCase() + id.slice(1);
  };

  const breadcrumbs = [
    { label: 'Dashboard', active: activeTab === 'overview', href: '#' },
    ...(activeTab !== 'overview' ? [{ label: getTabLabel(activeTab), active: true }] : []),
  ];

  const tabsConfig = useMemo(() => [
    {
      id: 'overview',
      label: 'Overview',
      content: <DashboardAnalytics stats={stats} employees={employees} absences={absences} />,
    },
    {
      id: 'attendance',
      label: 'Attendance',
      content: (
        <AttendanceTab
          absences={absences}
          employees={employees}
          loading={attendanceLoading}
          pagination={pagination}
          onFilterChange={(f) => fetchAttendanceData(f.startDate, f.endDate, f.category, f.userId, 1)}
          onPageChange={(page) => fetchAttendanceData(undefined, undefined, undefined, undefined, page)}
        />
      ),
    },
    {
      id: 'payroll',
      label: 'Payroll',
      content: <PayrollTab report={report} loading={false} onMonthChange={setPayrollExportMonth} />,
    },
    {
      id: 'disputes',
      label: 'Disputes',
      content: (
        <DisputesTab
          disputes={disputes}
          loading={disputeLoading}
          pagination={disputePagination}
          onPageChange={fetchDisputeData}
          onViewDetail={(d) => { setSelectedDispute(d); setShowDisputeDetail(true); }}
        />
      ),
    },
    {
      id: 'departments',
      label: 'Departments',
      content: <DepartmentManager />,
    },
    {
      id: 'screenshots',
      label: 'Screenshots',
      content: <ScreenshotsTab isAdmin={true} employees={employees} />,
    },
    {
      id: 'employees',
      label: 'Staff',
      content: (
        <div className="mt-6">
          <StaffManager
            employees={employees}
            onUpdate={handleUpdateEmployee}
            onShowHistory={handleShowHistory}
            onUpdatePassword={handleUpdatePassword}
            onRefresh={() => { fetchOverviewData(); if (onRefresh) onRefresh(); }}
          />
        </div>
      ),
    },
    {
      id: 'holidays',
      label: 'Holidays',
      content: <HolidayCalendar isAdmin={true} />,
    },
    {
      id: 'export',
      label: 'Export',
      content: <DataExportPanel />,
    },
    {
      id: 'audit',
      label: 'Logs',
      content: <AuditLogTab />,
    },
  ], [stats, employees, absences, attendanceLoading, pagination, report, disputes, disputeLoading, disputePagination, fetchAttendanceData, fetchDisputeData, fetchOverviewData, handleUpdateEmployee, handleShowHistory, handleUpdatePassword, onRefresh, setPayrollExportMonth]);

  return (
    <LayoutContainer
      user={user || { name: 'Admin', role: 'admin' }}
      onLogout={onLogout}
      activeTab={activeTab}
      onTabChange={setActiveTab}
      breadcrumbs={breadcrumbs}
      notifications={notifications}
      onNotificationClick={handleNotificationClick}
    >
      <div className="flex flex-row-reverse w-full mb-4">
        <Button
          variant={activeTab === 'attendance' || activeTab === 'payroll' ? 'primary' : 'secondary'}
          size="medium"
          className='cursor-pointer px-4 py-2 rounded-md hover:bg-indigo-600'
          onClick={handleExport}
          disabled={isExporting}
          title={activeTab !== 'attendance' && activeTab !== 'payroll' ? 'Switch to Attendance or Payroll tab to export' : ''}
        >
          <Download size={18} className={isExporting ? 'animate-bounce' : ''} />
          {isExporting ? 'Generating...' : activeTab === 'attendance' ? 'Export Attendance' : activeTab === 'payroll' ? 'Export Payroll' : 'Export Report'}
        </Button>
      </div>
      <Tabs
        tabs={tabsConfig}
        defaultTab={tabsConfig.findIndex((t) => t.id === activeTab)}
        onChange={(index) => setActiveTab(tabsConfig[index].id)}
        variant="tabs"
      />

      <AnimatePresence>
        {showDisputeDetail && selectedDispute && (
          <DisputeDetailModal 
            dispute={selectedDispute}
            onClose={() => setShowDisputeDetail(false)}
            onAction={handleAdminApproval}
            isAdmin={true}
          />
        )}
      </AnimatePresence>
    </LayoutContainer>
  );
}

// --- Sub-components ---

function AttendanceTab({ absences, employees, loading, pagination, onFilterChange, onPageChange }) {
  return (
    <SlideUp>
      <AttendanceFilters onFilterChange={onFilterChange} employees={employees} />
      <Card>
        <CardHeader><h3 className="text-lg font-semibold text-neutral-900">Attendance Records</h3></CardHeader>
        <CardBody className="p-0">
          {loading ? (
            <div className="text-center py-8">Loading...</div>
          ) : (
            <>
              <div className="overflow-x-auto">
                <table className="w-full">
                  <thead className="bg-neutral-50 border-b border-neutral-200">
                    <tr>
                      <th className="px-6 py-3 text-left text-xs font-semibold text-neutral-500 uppercase">Employee</th>
                      <th className="px-6 py-3 text-left text-xs font-semibold text-neutral-500 uppercase">Date</th>
                      <th className="px-6 py-3 text-left text-xs font-semibold text-neutral-500 uppercase">Check In</th>
                      <th className="px-6 py-3 text-left text-xs font-semibold text-neutral-500 uppercase">Check Out</th>
                      <th className="px-6 py-3 text-left text-xs font-semibold text-neutral-500 uppercase">Hours</th>
                      <th className="px-6 py-3 text-left text-xs font-semibold text-neutral-500 uppercase">Status</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-neutral-200">
                    {absences?.filter(record => record.status !== 'weekend').map((record, idx) => (
                      <tr key={idx} className="hover:bg-neutral-50 transition-colors">
                        <td className="px-6 py-4">{record.user?.name || `Employee #${record.user_id}`}</td>
                        <td className="px-6 py-4">{new Date(record.date).toLocaleDateString()}</td>
                        <td className="px-6 py-4 font-mono text-sm">{formatTime12h(record.check_in_time)}</td>
                        <td className="px-6 py-4 font-mono text-sm">{formatTime12h(record.check_out_time)}</td>
                        <td className="px-6 py-4">{record.total_hours?.toFixed(2) || '-'} hrs</td>
                        <td className="px-6 py-4">
                          <Badge variant={record.status === 'present' ? 'success' : record.status === 'absent' ? 'error' : 'warning'}>
                            {record.status}
                          </Badge>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <Pagination currentPage={pagination.currentPage} totalPages={pagination.totalPages} onPageChange={onPageChange} />
            </>
          )}
        </CardBody>
      </Card>
    </SlideUp>
  );
}

function PayrollTab({ report, loading, onMonthChange }) {
  const [bulkPayDate, setBulkPayDate] = useState('');
  const [bulkPayLoading, setBulkPayLoading] = useState(false);
  const [bulkPayMessage, setBulkPayMessage] = useState('');

  const handleMonthChange = (val) => {
    setBulkPayDate(val);
    if (onMonthChange) onMonthChange(val);
  };

  const handleBulkPay = async () => {
    if (!bulkPayDate) { alert('Please select a month first'); return; }
    if (!window.confirm(`Process salary payments for ${new Date(bulkPayDate).toLocaleString('default', { month: 'long', year: 'numeric' })}?`)) return;
    setBulkPayLoading(true);
    setBulkPayMessage('');
    try {
      const res = await api.processBulkSalary(bulkPayDate);
      setBulkPayMessage(res.data?.message || 'Salaries processed successfully');
    } catch (err) {
      setBulkPayMessage('Failed to process bulk salary');
    } finally {
      setBulkPayLoading(false);
    }
  };

  return (
    <SlideUp>
      <Card className="mb-6">
        <CardHeader><h3 className="text-lg font-semibold text-neutral-900">Process Monthly Salaries</h3></CardHeader>
        <CardBody>
          <div className="flex flex-col sm:flex-row items-start sm:items-end gap-4">
            <div>
              <label className="block text-sm font-medium text-neutral-700 mb-1">Select Month</label>
              <input type="month" value={bulkPayDate} onChange={(e) => handleMonthChange(e.target.value)} className="px-3 py-2 border border-neutral-300 rounded-md shadow-sm" />
            </div>
            <Button variant="primary" onClick={handleBulkPay} disabled={bulkPayLoading || !bulkPayDate} className="bg-green-600 hover:bg-green-700">
              {bulkPayLoading ? 'Processing...' : 'Process Bulk Pay'}
            </Button>
          </div>
          {bulkPayMessage && <p className={`mt-3 text-sm font-medium ${bulkPayMessage.includes('Failed') ? 'text-red-600' : 'text-green-600'}`}>{bulkPayMessage}</p>}
        </CardBody>
      </Card>

      <Card>
        <CardHeader><h3 className="text-lg font-semibold text-neutral-900">Payroll Summary</h3></CardHeader>
        <CardBody>
          {loading ? (
            <div className="text-center py-8">Loading...</div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead>
                  <tr><th>Employee</th><th>Base Salary</th><th>Deductions</th><th>Leaves Used</th><th>Net Payable</th><th>Actions</th></tr>
                </thead>
                <tbody>
                  {report?.slice(0, 20).map((emp) => (
                    <tr key={emp.id}>
                      <td><p className="font-medium">{emp.name}</p><p className="text-xs text-neutral-600">ID: {emp.id}</p></td>
                      <td>PKR {emp.monthly_salary?.toLocaleString()}</td>
                      <td className="text-error">PKR {emp.deductions?.toLocaleString()}</td>
                      <td>{emp.paid_leaves_used} days</td>
                      <td className="font-bold text-primary-600">PKR {emp.total_salary?.toLocaleString()}</td>
                      <td>
                        <PayslipPDFButton 
                          employeeName={emp.name} 
                          salaryData={{ userId: emp.id, monthly_salary: emp.monthly_salary, deductions: emp.deductions, paid_leaves_used: emp.paid_leaves_used, total_salary: emp.total_salary, date: new Date() }} 
                        />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardBody>
      </Card>
    </SlideUp>
  );
}

// --- ENHANCED DISPUTE COMPONENTS ---

function DisputesTab({ disputes, pagination, onPageChange, onViewDetail }) {
  return (
    <SlideUp>
      <div className="grid grid-cols-1 gap-6">
        <div className="flex justify-between items-center mb-4">
          <h3 className="text-lg font-semibold text-neutral-900">Dispute Management</h3>
          <div className="flex gap-2">
            <Button variant="ghost" size="sm"><Filter size={16} /> Filters</Button>
          </div>
        </div>

        {disputes?.length > 0 ? (
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
            {disputes.map((dispute) => (
              <DisputeCard key={dispute.id} dispute={dispute} onClick={() => onViewDetail(dispute)} />
            ))}
          </div>
        ) : (
          <Card className="py-12 text-center">
            <AlertCircle size={48} className="mx-auto text-neutral-300 mb-4" />
            <p className="text-neutral-500">No active disputes found</p>
          </Card>
        )}

        {pagination.totalPages > 1 && (
          <Pagination 
            currentPage={pagination.currentPage} 
            totalPages={pagination.totalPages} 
            onPageChange={onPageChange} 
          />
        )}
      </div>
    </SlideUp>
  );
}

function DisputeCard({ dispute, onClick }) {
  const getStatusColor = (status) => {
    switch (status) {
      case 'approved': return 'success';
      case 'rejected': return 'error';
      case 'partially_approved': return 'warning';
      default: return 'warning';
    }
  };

  return (
    <motion.div
      whileHover={{ y: -4, shadow: '0 10px 25px -5px rgba(0,0,0,0.1)' }}
      className="bg-white rounded-xl border border-neutral-200 p-5 cursor-pointer transition-all hover:border-primary-300 shadow-sm"
      onClick={onClick}
    >
      <div className="flex justify-between items-start mb-4">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-full bg-primary-50 flex items-center justify-center text-primary-600 font-bold">
            {dispute.requester?.name?.charAt(0) || '?'}
          </div>
          <div>
            <h4 className="font-semibold text-neutral-900 leading-none">{dispute.requester?.name}</h4>
            <p className="text-xs text-neutral-500 mt-1">{dispute.requester?.department?.name || 'No Dept'}</p>
          </div>
        </div>
        <Badge variant={getStatusColor(dispute.final_status)}>{dispute.final_status.replace('_', ' ')}</Badge>
      </div>

      <div className="space-y-3 mb-4">
        <div className="flex items-center gap-2 text-sm text-neutral-700">
          <Calendar size={14} className="text-neutral-400" />
          <span>For: {new Date(dispute.dispute_date).toLocaleDateString()}</span>
        </div>
        <div className="flex items-center gap-2 text-sm text-neutral-700">
          <Shield size={14} className="text-neutral-400" />
          <span className="capitalize">{dispute.category}</span>
        </div>
        <p className="text-sm text-neutral-600 line-clamp-2 italic">"{dispute.description}"</p>
      </div>

      <div className="flex items-center justify-between pt-4 border-t border-neutral-100">
        <div className="flex -space-x-2">
          {/* Lead Status Circle */}
          <div className={`w-6 h-6 rounded-full border-2 border-white flex items-center justify-center ${
            dispute.lead_status === 'approved' ? 'bg-green-500' : 
            dispute.lead_status === 'rejected' ? 'bg-red-500' : 'bg-neutral-200'
          }`} title={`Lead: ${dispute.lead_status}`}>
            <UserCheck size={10} className="text-white" />
          </div>
          {/* Admin Status Circle */}
          <div className={`w-6 h-6 rounded-full border-2 border-white flex items-center justify-center ${
            dispute.admin_status === 'approved' ? 'bg-green-500' : 
            dispute.admin_status === 'rejected' ? 'bg-red-500' : 'bg-neutral-200'
          }`} title={`Admin: ${dispute.admin_status}`}>
            <ShieldCheck size={10} className="text-white" />
          </div>
        </div>
        <span className="text-xs text-primary-600 font-medium flex items-center gap-1">
          View Details <ChevronRight size={14} />
        </span>
      </div>
    </motion.div>
  );
}

function DisputeDetailModal({ dispute, onClose, onAction, isAdmin }) {
  const [remarks, setRemarks] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);

  const handleAction = async (action) => {
    if (!remarks && action === 'reject') {
      alert('Remarks are required for rejection');
      return;
    }
    setIsSubmitting(true);
    await onAction(dispute.id, action, remarks);
    setIsSubmitting(false);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50 backdrop-blur-sm">
      <motion.div
        initial={{ opacity: 0, scale: 0.95, y: 20 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={{ opacity: 0, scale: 0.95, y: 20 }}
        style={{ maxWidth: '40rem' }} className="bg-white rounded-2xl shadow-2xl w-full overflow-hidden max-h-[90vh] flex flex-col"
      >
        {/* Header */}
        <div className="p-6 border-b border-neutral-100 flex justify-between items-center bg-neutral-50/50">
          <div className="flex items-center gap-4">
            <div className="p-3 bg-primary-100 text-primary-600 rounded-xl">
              <AlertCircle size={24} />
            </div>
            <div>
              <h3 className="text-xl font-bold text-neutral-900">Dispute Details</h3>
              <p className="text-sm text-neutral-500">ID: DISP-{dispute.id.toString().padStart(5, '0')}</p>
            </div>
          </div>
          <button onClick={onClose} className="p-2 hover:bg-neutral-100 rounded-lg text-neutral-400 hover:text-neutral-600 transition-colors">
            <XCircle size={24} />
          </button>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-6 space-y-8 no-scrollbar">
          {/* Employee Info */}
          <div className="grid grid-cols-2 gap-4">
            <div className="p-4 bg-neutral-50 rounded-xl border border-neutral-100">
              <p className="text-xs font-semibold text-neutral-500 uppercase mb-2">Employee</p>
              <p className="font-bold text-neutral-900">{dispute.requester?.name}</p>
              <p className="text-sm text-neutral-600">{dispute.requester?.department?.name || 'No Department'}</p>
            </div>
            <div className="p-4 bg-neutral-50 rounded-xl border border-neutral-100">
              <p className="text-xs font-semibold text-neutral-500 uppercase mb-2">Date & Category</p>
              <p className="font-bold text-neutral-900">{new Date(dispute.dispute_date).toLocaleDateString()}</p>
              <p className="text-sm text-neutral-600 capitalize">{dispute.category}</p>
            </div>
          </div>

          {/* Description */}
          <div>
            <h4 className="text-sm font-semibold text-neutral-900 mb-2 flex items-center gap-2">
              <MessageSquare size={16} className="text-primary-500" /> Employee Message
            </h4>
            <div className="p-4 bg-primary-50/30 border border-primary-100 rounded-xl italic text-neutral-700">
              "{dispute.description}"
            </div>
          </div>

          {/* Workflow Status */}
          <div>
            <h4 className="text-sm font-semibold text-neutral-900 mb-4 flex items-center gap-2">
              <ShieldCheck size={16} className="text-green-500" /> Approval Status
            </h4>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <StatusBox 
                label="Team Lead Approval" 
                status={dispute.lead_status} 
                approver={dispute.leadApprover?.name}
                date={dispute.lead_approved_at}
                remarks={dispute.lead_remarks}
              />
              <StatusBox 
                label="Admin Final Approval" 
                status={dispute.admin_status} 
                approver={dispute.adminApprover?.name}
                date={dispute.admin_approved_at}
                remarks={dispute.admin_remarks}
              />
            </div>
          </div>

          {/* Audit History */}
          {dispute.history?.length > 0 && (
            <div>
              <h4 className="text-sm font-semibold text-neutral-900 mb-4 flex items-center gap-2">
                <History size={16} className="text-neutral-500" /> Activity History
              </h4>
              <div className="space-y-4 relative before:absolute before:left-3 before:top-2 before:bottom-2 before:w-0.5 before:bg-neutral-100">
                {dispute.history.map((item, idx) => (
                  <div key={idx} className="relative pl-8">
                    <div className={`absolute left-0 top-1 w-6 h-6 rounded-full border-4 border-white shadow-sm flex items-center justify-center ${
                      item.action.includes('APPROVED') ? 'bg-green-500' : 
                      item.action.includes('REJECTED') ? 'bg-red-500' : 'bg-primary-500'
                    }`}>
                    </div>
                    <div className="text-sm">
                      <p className="font-semibold text-neutral-900">{item.action.replace('_', ' ')}</p>
                      <p className="text-neutral-600">{item.remarks}</p>
                      <p className="text-xs text-neutral-400 mt-1">{new Date(item.created_at).toLocaleString()}</p>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Action Form */}
          {isAdmin && dispute.final_status === 'pending' || dispute.final_status === 'partially_approved' && (
            <div className="pt-6 border-t border-neutral-100">
              <label className="block text-sm font-semibold text-neutral-900 mb-2">Internal Remarks</label>
              <textarea 
                value={remarks}
                onChange={(e) => setRemarks(e.target.value)}
                placeholder="Enter remarks for the employee..."
                className="w-full p-4 bg-neutral-50 border border-neutral-200 rounded-xl focus:ring-2 focus:ring-primary-500 focus:bg-white transition-all outline-none h-24 resize-none"
              />
            </div>
          )}
        </div>

        {/* Footer Actions */}
        <div className="p-6 bg-neutral-50 border-t border-neutral-100 flex justify-end gap-3">
          <Button variant="ghost" onClick={onClose}>Close</Button>
          {isAdmin && (dispute.final_status === 'pending' || dispute.final_status === 'partially_approved') && (
            <>
              <Button 
                variant="danger" 
                onClick={() => handleAction('reject')}
                disabled={isSubmitting}
              >
                Reject Dispute
              </Button>
              <Button 
                variant="primary" 
                onClick={() => handleAction('approve')}
                disabled={isSubmitting}
                className="bg-green-600 hover:bg-green-700"
              >
                {isSubmitting ? 'Processing...' : 'Approve & Restore'}
              </Button>
            </>
          )}
        </div>
      </motion.div>
    </div>
  );
}

function StatusBox({ label, status, approver, date, remarks }) {
  const getStatusInfo = (s) => {
    switch(s) {
      case 'approved': return { color: 'bg-green-50 border-green-200', text: 'text-green-700', label: 'Approved' };
      case 'rejected': return { color: 'bg-red-50 border-red-200', text: 'text-red-700', label: 'Rejected' };
      default: return { color: 'bg-neutral-50 border-neutral-200', text: 'text-neutral-500', label: 'Pending' };
    }
  };

  const info = getStatusInfo(status);

  return (
    <div className={`p-4 rounded-xl border ${info.color}`}>
      <p className="text-xs font-bold uppercase text-neutral-500 mb-2">{label}</p>
      <div className="flex items-center gap-2 mb-2">
        <span className={`text-sm font-bold ${info.text}`}>{info.label}</span>
      </div>
      {status !== 'pending' && (
        <div className="space-y-1">
          <p className="text-xs text-neutral-600">By: <span className="font-medium">{approver || 'N/A'}</span></p>
          <p className="text-xs text-neutral-600">On: {date ? new Date(date).toLocaleDateString() : 'N/A'}</p>
          {remarks && <p className="text-xs text-neutral-500 italic mt-2 border-t border-black/5 pt-1">"{remarks}"</p>}
        </div>
      )}
    </div>
  );
}

export default AdminDashboardNew;
