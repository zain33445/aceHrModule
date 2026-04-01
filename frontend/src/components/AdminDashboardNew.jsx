import React, { useState, useEffect } from 'react';
import { motion } from 'framer-motion';
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
} from 'lucide-react';
import LayoutContainer from './layout/LayoutContainer';
import StatCard from './dashboard/StatCard';
import { Tabs } from './common/Tabs';
import { Button } from './common/Button';
import { Card, CardHeader, CardBody, CardFooter } from './common/Card';
import { SlideUp, StaggerChildren } from './animations';
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
import { PayslipPDFButton } from './salary/PayslipPDFButton';
import { formatTime12h } from '../utils/formatters';

function AdminDashboardNew({ employees = [], report = [], user, onLogout, onRefresh }) {
  const [activeTab, setActiveTab] = useState('overview');
  const [absences, setAbsences] = useState([]);
  const [leaveBanks, setLeaveBanks] = useState([]);
  const [loading, setLoading] = useState(true);
  const [disputes, setDisputes] = useState([]);
  const [activeToday, setActiveToday] = useState(0);
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

  // Fetch notifications for admin
  const fetchNotifications = async () => {
    if (!user?.user_id) return;
    try {
      const res = await api.getNotifications(user.user_id);
      setNotifications((res.data || []).map(n => ({
        id: n.id,
        title: n.type === 'new_dispute' ? 'New Dispute' :
               n.type === 'dispute_approved' ? 'Dispute Approved' :
               n.type === 'dispute_rejected' ? 'Dispute Rejected' : 'Notification',
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
  }, []);

  const handleNotificationClick = async (notif) => {
    if (!notif.read) {
      try {
        await api.markNotificationRead(notif.id);
        fetchNotifications();
      } catch (err) {
        console.error('Error marking notification as read:', err);
      }
    }
  };

  const fetchOverviewData = async () => {
    setLoading(true);
    try {
      const lastWeek = new Date();
      lastWeek.setDate(lastWeek.getDate() - 7);
      // Fetch up to 500 records from the last 7 days for the chart
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

      const presentToday = new Set(
        todayRecords.filter((r) => r.status === 'present').map((r) => r.user_id)
      ).size;

      const absentToday = new Set(
        todayRecords.filter((r) => r.status === 'absent').map((r) => r.user_id)
      ).size;

      const onLeaveToday = new Set(
        todayRecords.filter((r) => r.status === 'leave').map((r) => r.user_id)
      ).size;

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
    setLoading(false);
  };

  const fetchAttendanceData = async (startDate, endDate, status, userId, page = 1) => {
    setLoading(true);
    // Use existing filters if not provided
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
    setLoading(false);
  };

  const fetchDisputeData = async () => {
    setLoading(true);
    try {
      const disputesRes = await api.getAllDisputes();
      setDisputes(disputesRes.data || []);
    } catch (err) {
      console.error('Error fetching disputes:', err);
    }
    setLoading(false);
  };

  const handleApproveDispute = async (id) => {
    if (!window.confirm('Are you sure you want to approve this dispute?')) return;
    try {
      await api.approveDispute(id, 'Approved by Admin');
      fetchDisputeData();
    } catch (err) {
      alert('Failed to approve dispute');
    }
  };

  const handleRejectDispute = async (id) => {
    const remarks = window.prompt('Enter rejection remarks:');
    if (remarks === null) return;
    try {
      await api.rejectDispute(id, remarks);
      fetchDisputeData();
    } catch (err) {
      alert('Failed to reject dispute');
    }
  };

  const handleUpdateEmployee = async (userId, value, key) => {
    try {
      if (key === 'monthly_salary') {
        await api.updateEmployee(userId, value);
      } else if (key === 'leave_bank') {
        await api.updateLeaves(userId, value);
      }
      // Assuming parent App.jsx might need to refresh, or we just refresh local state if needed
      // For now, let's just reload or show success
      fetchOverviewData();
    } catch {
      alert("Failed to update setting");
    }
  };

  const handleShowHistory = (user) => {
    console.log("Show history for:", user);
    // You can add logic here to open a modal or navigate to a history page
    alert(`Checking history for ${user.name}`);
  };

  const handleUpdatePassword = async (userId, newPassword) => {
    try {
      await api.updatePassword(userId, newPassword);
    } catch {
      alert("Failed to update password");
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
    ...(activeTab !== 'overview' 
      ? [{ label: getTabLabel(activeTab), active: true }]
      : []),
  ];

  const tabsConfig = [
    {
      id: 'overview',
      label: 'Overview',
      content: <DashboardAnalytics stats={stats} employees={employees} absences={absences} />,
    },
    {
      id: 'departments',
      label: 'Departments',
      content: <DepartmentManager />,
    },
    {
      id: 'attendance',
      label: 'Attendance',
      content: (
        <AttendanceTab 
          absences={absences} 
          employees={employees} 
          loading={loading} 
          pagination={pagination}
          onFilterChange={(f) => fetchAttendanceData(f.startDate, f.endDate, f.category, f.userId, 1)}
          onPageChange={(page) => fetchAttendanceData(undefined, undefined, undefined, undefined, page)} // Note: Need state to keep current filters for page change
        />
      ),
    },
    {
      id: 'payroll',
      label: 'Payroll',
      content: <PayrollTab report={report} loading={loading} />,
    },
    {
      id: 'disputes',
      label: 'Disputes',
      content: <DisputesTab disputes={disputes} onApprove={handleApproveDispute} onReject={handleRejectDispute} />,
    },
    // {
    //   id: 'leaves',
    //   label: 'Leave Requests',
    //   content: <LeaveRequestHub user={user} isAdmin={true} />,
    // },
    {
      id: 'holidays',
      label: 'Holidays',
      content: <HolidayCalendar isAdmin={true} />,
    },
    {
      id: 'export',
      label: 'Data Export',
      content: <DataExportPanel />,
    },
    {
      id: 'audit',
      label: 'Audit Logs',
      content: <AuditLogTab />,
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
  ];

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
      <StaggerChildren stagger={0.1}>
        {/* Page Header */}
        <motion.div className="mb-8 flex justify-between items-start">
          <div>
            <h1 className="text-3xl font-bold text-neutral-900">Administration Dashboard</h1>
            <p className="text-neutral-600 mt-1">
              Manage attendance, staff, and payroll operations
            </p>
          </div>
          <div className="flex gap-3">
            <Button variant="secondary" size="lg" onClick={handleSyncAttendance} disabled={isSyncing}>
              <RefreshCw size={18} className={isSyncing ? 'animate-spin' : ''} />
              {isSyncing ? 'Syncing...' : 'Sync Attendance'}
            </Button>
            <Button variant="primary" size="lg">
              <Download size={18} />
              Export Report
            </Button>
          </div>
        </motion.div>
        {/* Tab Navigation & Content */}
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ delay: 0.3 }}
        >
          <Tabs
            tabs={tabsConfig}
            defaultTab={tabsConfig.findIndex((t) => t.id === activeTab)}
            onChange={(index) => setActiveTab(tabsConfig[index].id)}
            variant="tabs"
          />
        </motion.div>
      </StaggerChildren>
    </LayoutContainer>
  );
}

// Overview Tab
function OverviewTab({ stats, absences, loading }) {
  return (
    <SlideUp>
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Recent Attendance */}
        <Card className="lg:col-span-2">
          <CardHeader>
            <h3 className="text-lg font-semibold text-neutral-900">Recent Activity</h3>
          </CardHeader>
          <CardBody>
            {loading ? (
              <div className="text-center py-8">Loading...</div>
            ) : absences?.length > 0 ? (
              <div className="space-y-3">
                {absences.slice(0, 6).map((record, idx) => (
                  <motion.div
                    key={idx}
                    initial={{ opacity: 0, x: -20 }}
                    animate={{ opacity: 1, x: 0 }}
                    transition={{ delay: idx * 0.05 }}
                    className="flex items-center justify-between p-4 bg-neutral-50 rounded-lg border border-neutral-200 hover:shadow-md transition-all"
                  >
                    <div className="flex-1">
                      <p className="font-medium text-neutral-900">
                        {record.user?.name || `Employee #${record.user_id}`}
                      </p>
                      <p className="text-sm text-neutral-600">
                        {new Date(record.date).toLocaleDateString()}
                      </p>
                    </div>
                    <Badge
                      variant={
                        record.status === 'present'
                          ? 'success'
                          : record.status === 'absent'
                          ? 'error'
                          : 'warning'
                      }
                    >
                      {record.status}
                    </Badge>
                  </motion.div>
                ))}
              </div>
            ) : (
              <div className="text-center py-12 text-neutral-500">
                <Clock size={48} className="mx-auto mb-4 opacity-20" />
                <p>No recent records</p>
              </div>
            )}
          </CardBody>
        </Card>

        {/* Quick Actions */}
        <Card>
          <CardHeader>
            <h3 className="text-lg font-semibold text-neutral-900">Actions</h3>
          </CardHeader>
          <CardBody className="space-y-3">
            <Button className="w-full" variant="primary">
              <Plus size={18} />
              Add Employee
            </Button>
            <Button className="w-full" variant="secondary">
              <Filter size={18} />
              Filter Data
            </Button>
            <Button className="w-full" variant="ghost">
              <Download size={18} />
              Download
            </Button>
          </CardBody>
        </Card>
      </div>
    </SlideUp>
  );
}

// Attendance Tab
function AttendanceTab({ absences, employees, loading, pagination, onFilterChange, onPageChange }) {
  return (
    <SlideUp>
      <AttendanceFilters onFilterChange={onFilterChange} employees={employees} />
      <Card>
        <CardHeader>
          <h3 className="text-lg font-semibold text-neutral-900">Attendance Records</h3>
        </CardHeader>
        <CardBody className="p-0">
          {loading ? (
            <div className="text-center py-8">Loading...</div>
          ) : (
            <>
              <div className="overflow-x-auto">
                <table className="w-full">
                  <thead className="bg-neutral-50 border-b border-neutral-200">
                    <tr>
                      <th className="px-6 py-3 text-left text-xs font-semibold text-neutral-500 uppercase tracking-wider">Employee</th>
                      <th className="px-6 py-3 text-left text-xs font-semibold text-neutral-500 uppercase tracking-wider">Date</th>
                      <th className="px-6 py-3 text-left text-xs font-semibold text-neutral-500 uppercase tracking-wider">Check In</th>
                      <th className="px-6 py-3 text-left text-xs font-semibold text-neutral-500 uppercase tracking-wider">Check Out</th>
                      <th className="px-6 py-3 text-left text-xs font-semibold text-neutral-500 uppercase tracking-wider">Hours</th>
                      <th className="px-6 py-3 text-left text-xs font-semibold text-neutral-500 uppercase tracking-wider">Status</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-neutral-200">
                    {absences?.map((record, idx) => (
                      <tr key={idx} className="hover:bg-neutral-50 transition-colors">
                        <td className="px-6 py-4 whitespace-nowrap">{record.user?.name || `Employee #${record.user_id}`}</td>
                        <td className="px-6 py-4 whitespace-nowrap">{new Date(record.date).toLocaleDateString()}</td>
                        <td className="px-6 py-4 whitespace-nowrap font-mono text-sm">{formatTime12h(record.check_in_time)}</td>
                        <td className="px-6 py-4 whitespace-nowrap font-mono text-sm">{formatTime12h(record.check_out_time)}</td>
                        <td className="px-6 py-4 whitespace-nowrap">{record.total_hours?.toFixed(2) || '-'} hrs</td>
                        <td className="px-6 py-4 whitespace-nowrap">
                          <Badge
                            variant={
                              record.status === 'present'
                                ? 'success'
                                : record.status === 'absent'
                                ? 'error'
                                : 'warning'
                            }
                          >
                            {record.status}
                          </Badge>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <Pagination 
                currentPage={pagination.currentPage}
                totalPages={pagination.totalPages}
                onPageChange={onPageChange}
              />
            </>
          )}
        </CardBody>
      </Card>
    </SlideUp>
  );
}

// Payroll Tab
function PayrollTab({ report, loading }) {
  const [bulkPayDate, setBulkPayDate] = React.useState('');
  const [bulkPayLoading, setBulkPayLoading] = React.useState(false);
  const [bulkPayMessage, setBulkPayMessage] = React.useState('');

  const handleBulkPay = async () => {
    if (!bulkPayDate) {
      alert('Please select a month first');
      return;
    }
    if (!window.confirm(`Process salary payments for ${new Date(bulkPayDate).toLocaleString('default', { month: 'long', year: 'numeric' })}?`)) {
      return;
    }
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
      {/* Bulk Pay Section */}
      <Card className="mb-6">
        <CardHeader className="flex justify-between items-center">
          <h3 className="text-lg font-semibold text-neutral-900">Process Monthly Salaries</h3>
        </CardHeader>
        <CardBody>
          <div className="flex flex-col sm:flex-row items-start sm:items-end gap-4">
            <div>
              <label className="block text-sm font-medium text-neutral-700 mb-1">Select Month</label>
              <input
                type="month"
                value={bulkPayDate}
                onChange={(e) => setBulkPayDate(e.target.value)}
                className="px-3 py-2 border border-neutral-300 rounded-md shadow-sm focus:ring-primary-500 focus:border-primary-500 sm:text-sm"
              />
            </div>
            <Button
              variant="primary"
              onClick={handleBulkPay}
              disabled={bulkPayLoading || !bulkPayDate}
              className="bg-green-600 hover:bg-green-700"
            >
              {bulkPayLoading ? 'Processing...' : 'Process Bulk Pay'}
            </Button>
          </div>
          {bulkPayMessage && (
            <p className={`mt-3 text-sm font-medium ${bulkPayMessage.includes('Failed') ? 'text-red-600' : 'text-green-600'}`}>
              {bulkPayMessage}
            </p>
          )}
        </CardBody>
      </Card>

      {/* Payroll Table */}
      <Card>
        <CardHeader>
          <h3 className="text-lg font-semibold text-neutral-900">Payroll Summary</h3>
        </CardHeader>
        <CardBody>
          {loading ? (
            <div className="text-center py-8">Loading...</div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead>
                  <tr>
                    <th>Employee</th>
                    <th>Base Salary</th>
                    <th>Deductions</th>
                    <th>Leaves Used</th>
                    <th>Net Payable</th>
                    <th>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {report?.slice(0, 20).map((emp) => (
                    <tr key={emp.id}>
                      <td>
                        <div>
                          <p className="font-medium">{emp.name}</p>
                          <p className="text-xs text-neutral-600">ID: {emp.id}</p>
                        </div>
                      </td>
                      <td>PKR {emp.monthly_salary?.toLocaleString()}</td>
                      <td className="text-error">PKR {emp.deductions?.toLocaleString()}</td>
                      <td>{emp.paid_leaves_used} days</td>
                      <td className="font-bold text-primary-600">
                        PKR {emp.total_salary?.toLocaleString()}
                      </td>
                      <td>
                        <PayslipPDFButton 
                          employeeName={emp.name} 
                          salaryData={{
                            userId: emp.id,
                            monthly_salary: emp.monthly_salary,
                            deductions: emp.deductions,
                            paid_leaves_used: emp.paid_leaves_used,
                            total_salary: emp.total_salary,
                            date: new Date()
                          }} 
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

// Disputes Tab
function DisputesTab({ disputes, onApprove, onReject }) {
  return (
    <SlideUp>
      <Card>
        <CardHeader className="flex justify-between items-center">
          <h3 className="text-lg font-semibold text-neutral-900">Dispute Management</h3>
        </CardHeader>
        <CardBody>
          {disputes?.length > 0 ? (
            <div className="space-y-4">
              {disputes.map((dispute) => (
                <motion.div
                  key={dispute.id}
                  initial={{ opacity: 0, y: 10 }}
                  animate={{ opacity: 1, y: 0 }}
                  className="p-4 border border-neutral-200 rounded-lg hover:shadow-md transition-all"
                >
                  <div className="flex justify-between items-start">
                    <div>
                      <p className="font-semibold text-neutral-900 capitalize">
                        {dispute.category}
                      </p>
                      <p className="text-sm text-neutral-600">{dispute.description}</p>
                      <p className="text-xs text-neutral-500 mt-2">
                        {new Date(dispute.dispute_date).toLocaleDateString()}
                      </p>
                    </div>
                    <div className="flex flex-col items-end gap-2">
                      <Badge
                        variant={
                          dispute.status === 'approved' || dispute.status === 'resolved'
                            ? 'success'
                            : dispute.status === 'pending'
                            ? 'warning'
                            : 'error'
                        }
                      >
                        {dispute.status}
                      </Badge>
                      {dispute.status === 'pending' && (
                        <div className="flex gap-2 mt-2">
                          <Button 
                            size="sm" 
                            variant="success" 
                            onClick={() => onApprove(dispute.id)}
                            className="bg-green-600 hover:bg-green-700 text-white border-none"
                          >
                            Approve
                          </Button>
                          <Button 
                            size="sm" 
                            variant="danger" 
                            onClick={() => onReject(dispute.id)}
                            className="bg-red-600 hover:bg-red-700 text-white border-none"
                          >
                            Reject
                          </Button>
                        </div>
                      )}
                    </div>
                  </div>
                </motion.div>
              ))}
            </div>
          ) : (
            <div className="text-center py-12">
              <AlertCircle size={48} className="mx-auto text-neutral-300 mb-4" />
              <p className="text-neutral-600">No disputes</p>
            </div>
          )}
        </CardBody>
      </Card>
    </SlideUp>
  );
}

export default AdminDashboardNew;
