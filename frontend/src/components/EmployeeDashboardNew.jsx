import React, { useState, useEffect } from 'react';
import { motion } from 'framer-motion';
import { 
  Clock, 
  DollarSign, 
  AlertCircle, 
  CheckCircle2,
  Calendar,
  TrendingUp,
  Download,
  Plus,
  FileText,
  UserX,
  History,
  Timer,
  RefreshCw
} from 'lucide-react';
import LayoutContainer from './layout/LayoutContainer';
import StatCard from './dashboard/StatCard';
import { Tabs } from './common/Tabs';
import { Button } from './common/Button';
import { Card, CardHeader, CardBody, CardFooter } from './common/Card';
import { SlideUp, StaggerChildren } from './animations';
import api from '../services/api';
import { AttendanceFilters } from './common/AttendanceFilters';
import { Modal, Input, Select, Textarea, Pagination } from './common';
import { Send, Calendar as CalendarIcon, Tag, MessageSquare, Info, AlertOctagon, Watch, Sunset, Home, Image as ImageIcon } from 'lucide-react';

import { AttendanceCalendar } from './calendar/AttendanceCalendar';
import { HolidayCalendar } from './calendar/HolidayCalendar';
import { LeaveRequestHub } from './leaves/LeaveRequestHub';
import { PayslipPDFButton } from './salary/PayslipPDFButton';
import { SettingsTab } from './dashboard/SettingsTab';
import { formatTime12h } from '../utils/formatters';

function EmployeeDashboard({ user, onLogout }) {
  const [activeTab, setActiveTab] = useState('overview');
  const [stats, setStats] = useState(null);
  const [logs, setLogs] = useState([]);
  const [absences, setAbsences] = useState([]);
  const [leaveBank, setLeaveBank] = useState(null);
  const [disputes, setDisputes] = useState([]);
  const [salaryHistory, setSalaryHistory] = useState([]);
  const [showDisputeModal, setShowDisputeModal] = useState(false);
  const [disputeForm, setDisputeForm] = useState({
    category: 'absent',
    dispute_date: '',
    description: ''
  });
  const [loading, setLoading] = useState(true);
  const [notifications, setNotifications] = useState([]);
  const [holidays, setHolidays] = useState([]);
  const [filterType, setFilterType] = useState('current');
  const [attendancePagination, setAttendancePagination] = useState({
    currentPage: 1,
    totalPages: 1,
    totalRecords: 0
  });
  const [salaryPaidPagination, setSalaryPaidPagination] = useState({
    currentPage: 1,
    totalPages: 1,
    totalRecords: 0
  });
  const [salaryDeductionPagination, setSalaryDeductionPagination] = useState({
    currentPage: 1,
    totalPages: 1,
    totalRecords: 0
  });
  const [disputePagination, setDisputePagination] = useState({
    currentPage: 1,
    totalPages: 1,
    totalRecords: 0
  });
  const [attendanceFilters, setAttendanceFilters] = useState({
    startDate: new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString().split('T')[0],
    endDate: new Date(new Date().getFullYear(), new Date().getMonth() + 1, 0).toISOString().split('T')[0],
    status: 'all'
  });
  const [salaryPaidFilters, setSalaryPaidFilters] = useState({
    startDate: new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString().split('T')[0],
    endDate: new Date(new Date().getFullYear(), new Date().getMonth() + 1, 0).toISOString().split('T')[0],
    type: 'all'
  });
  const [salaryDeductionFilters, setSalaryDeductionFilters] = useState({
    startDate: new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString().split('T')[0],
    endDate: new Date(new Date().getFullYear(), new Date().getMonth() + 1, 0).toISOString().split('T')[0],
    type: 'all'
  });
  const [disputeFilters, setDisputeFilters] = useState({
    startDate: new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString().split('T')[0],
    endDate: new Date(new Date().getFullYear(), new Date().getMonth() + 1, 0).toISOString().split('T')[0],
    category: 'all'
  });
  const [isSyncing, setIsSyncing] = useState(false);

  const handleSyncAttendance = async () => {
    setIsSyncing(true);
    try {
      await api.syncAttendanceToday();
      fetchUserData();
      if (activeTab === 'attendance') fetchAbsenceData();
    } catch (err) {
      console.error('Failed to sync', err);
      alert('Failed to sync attendance');
    }
    setIsSyncing(false);
  };
  useEffect(() => {
    fetchUserData();
  }, [filterType]);

  useEffect(() => {
    if (activeTab === 'attendance') {
      fetchAbsenceData();
    } else if (activeTab === 'disputes') {
      fetchDisputeData();
    } else if (activeTab === 'salary') {
      fetchSalaryPaidHistory();
      fetchSalaryDeductionHistory();
    }
  }, [activeTab]);

  const fetchHolidays = async () => {
    try {
      const res = await api.getHolidays();
      setHolidays(res.data || []);
    } catch (err) {
      console.error('Error fetching holidays:', err);
    }
  };

  // Fetch notifications
  const fetchNotifications = async () => {
    try {
      const res = await api.getNotifications(user.user_id);
      setNotifications((res.data || []).map(n => ({
        id: n.id,
        title: n.type === 'dispute_approved' ? 'Dispute Approved' :
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

  const fetchUserData = async () => {
    setLoading(true);
    try {
      const now = new Date();
      const start = new Date(now.getFullYear(), now.getMonth(), 1).toISOString().split('T')[0];
      const end = new Date(now.getFullYear(), now.getMonth() + 1, 0).toISOString().split('T')[0];

      const [repRes, attRecordsRes] = await Promise.all([
        api.getSalaryReport(start, end),
        api.getUserAttendanceRecords(user.user_id, start, end),
      ]);

      const myStats = repRes.data.find(r => String(r.id) === String(user.user_id));
      setStats(myStats);
      setLogs(attRecordsRes.data);
    } catch (err) {
      console.error('Error fetching data:', err);
    }
    setLoading(false);
  };

  const fetchAbsenceData = async (startDate, endDate, status, page = 1) => {
    setLoading(true);
    // Use existing filters if not provided
    const sDate = startDate !== undefined ? startDate : attendanceFilters.startDate;
    const eDate = endDate !== undefined ? endDate : attendanceFilters.endDate;
    const st = status !== undefined ? status : attendanceFilters.status;

    try {
      const [absencesRes, leaveBankRes] = await Promise.all([
        api.getUserAbsences(user.user_id, sDate, eDate, st, page),
        api.getUserLeaveBank(user.user_id),
      ]);

      const { records, total } = absencesRes.data;
      setAbsences(records || []);
      setAttendancePagination({
        currentPage: page,
        totalPages: Math.ceil(total / 20),
        totalRecords: total
      });
      setAttendanceFilters({ startDate: sDate, endDate: eDate, status: st });
      setLeaveBank(leaveBankRes.data);
    } catch (err) {
      console.error('Error fetching absence data:', err);
    }
    setLoading(false);
  };

  const fetchDisputeData = async (startDate, endDate, category, page = 1) => {
    setLoading(true);
    const sDate = startDate !== undefined ? startDate : disputeFilters.startDate;
    const eDate = endDate !== undefined ? endDate : disputeFilters.endDate;
    const cat = category !== undefined ? category : disputeFilters.category;

    try {
      const res = await api.getUserDisputes(user.user_id, sDate, eDate, cat, page);
      const { records, total } = res.data;
      setDisputes(records || []);
      setDisputePagination({
        currentPage: page,
        totalPages: Math.ceil(total / 20),
        totalRecords: total
      });
      setDisputeFilters({ startDate: sDate, endDate: eDate, category: cat });
    } catch (err) {
      console.error('Error fetching disputes:', err);
    }
    setLoading(false);
  };

  const fetchSalaryPaidHistory = async (startDate, endDate, page = 1) => {
    setLoading(true);
    const sDate = startDate !== undefined ? startDate : salaryPaidFilters.startDate;
    const eDate = endDate !== undefined ? endDate : salaryPaidFilters.endDate;

    try {
      const res = await api.getUserSalaryHistory(user.user_id, sDate, eDate, page);
      setSalaryHistory(prev => ({
        ...prev,
        paid: res.data.records || []
      }));
      setSalaryPaidPagination({
        currentPage: page,
        totalPages: Math.ceil((res.data.total || 0) / 20),
        totalRecords: res.data.total || 0
      });
      setSalaryPaidFilters({ ...salaryPaidFilters, startDate: sDate, endDate: eDate });
    } catch (err) {
      console.error('Error fetching paid salary history:', err);
    }
    setLoading(false);
  };

  const fetchSalaryDeductionHistory = async (startDate, endDate, type, page = 1) => {
    setLoading(true);
    const sDate = startDate !== undefined ? startDate : salaryDeductionFilters.startDate;
    const eDate = endDate !== undefined ? endDate : salaryDeductionFilters.endDate;
    const t = type !== undefined ? type : salaryDeductionFilters.type;

    try {
      const res = await api.getUserDeductions(user.user_id, sDate, eDate, t, page);
      setSalaryHistory(prev => ({
        ...prev,
        deductions: res.data.records || []
      }));
      setSalaryDeductionPagination({
        currentPage: page,
        totalPages: Math.ceil((res.data.total || 0) / 20),
        totalRecords: res.data.total || 0
      });
      setSalaryDeductionFilters({ startDate: sDate, endDate: eDate, type: t });
    } catch (err) {
      console.error('Error fetching deduction history:', err);
    }
    setLoading(false);
  };

  const handleDisputeSubmit = async (e) => {
    e.preventDefault();
    if (!disputeForm.dispute_date || !disputeForm.category || !disputeForm.description) {
      alert('Please fill all fields');
      return;
    }

    try {
      await api.createDispute({
        req_by: user.user_id, // Prisma schema uses req_by
        category: disputeForm.category,
        dispute_date: disputeForm.dispute_date,
        description: disputeForm.description
      });
      alert('Dispute submitted successfully!');
      setDisputeForm({ category: 'absent', dispute_date: '', description: '' });
      setShowDisputeModal(false);
      fetchDisputeData();
    } catch (error) {
      console.error('Error submitting dispute:', error);
      alert('Failed to submit dispute');
    }
  };

  // Breadcrumb trails
  const breadcrumbs = [
    { label: 'Dashboard', active: activeTab === 'overview' },
    ...(activeTab !== 'overview' && activeTab !== 'salary' && activeTab !== 'disputes'
      ? [{ label: activeTab.charAt(0).toUpperCase() + activeTab.slice(1) }]
      : []),
  ];

  // Tab configuration
  const tabsConfig = [
    {
      id: 'overview',
      label: 'Dashboard',
      icon: null,
      content: <OverviewTab stats={stats} logs={logs} loading={loading} />,
    },
    {
      id: 'attendance',
      label: 'Attendance',
      content: (
        <AttendanceTab 
          absences={absences} 
          loading={loading} 
          pagination={attendancePagination}
          onFilterChange={(f) => fetchAbsenceData(f.startDate, f.endDate, f.category, 1)} 
          onPageChange={(page) => fetchAbsenceData(undefined, undefined, undefined, page)}
        />
      ),
    },
    {
      id: 'salary',
      label: 'Salary',
      content: (
        <SalaryTab 
          stats={stats} 
          loading={loading} 
          salaryHistory={salaryHistory} 
          paidPagination={salaryPaidPagination}
          deductionPagination={salaryDeductionPagination}
          onPaidFilterChange={(f) => fetchSalaryPaidHistory(f.startDate, f.endDate, 1)}
          onPaidPageChange={(page) => fetchSalaryPaidHistory(undefined, undefined, page)}
          onDeductionFilterChange={(f) => fetchSalaryDeductionHistory(f.startDate, f.endDate, f.category, 1)}
          onDeductionPageChange={(page) => fetchSalaryDeductionHistory(undefined, undefined, undefined, page)}
        />
      ),
    },
    {
      id: 'disputes',
      label: 'Disputes',
      content: (
        <DisputesTab 
          disputes={disputes} 
          loading={loading}
          pagination={disputePagination}
          onFilterChange={(f) => fetchDisputeData(f.startDate, f.endDate, f.category, 1)}
          onPageChange={(page) => fetchDisputeData(undefined, undefined, undefined, page)}
          onNewDispute={() => setShowDisputeModal(true)} 
        />
      ),
    },
    {
      id: 'settings',
      label: 'Settings',
      content: <SettingsTab user={user} />,
    },
    {
      id: 'screenshots',
      label: 'Screenshots',
      content: <ScreenshotsTab user={user} />,
    },
  ];

  return (
    <>
      <LayoutContainer
        user={user}
        onLogout={onLogout}
        activeTab={activeTab}
        onTabChange={setActiveTab}
        breadcrumbs={breadcrumbs}
        notifications={notifications}
        onNotificationClick={handleNotificationClick}
      >
        <StaggerChildren stagger={0.1}>
          {/* ... existing header and stats ... */}
          {/* Page Header */}
          <motion.div className="mb-8 flex justify-between items-start">
            <div>
              <h1 className="text-3xl font-bold text-neutral-900">Dashboard</h1>
              <p className="text-neutral-600 mt-1">
                Welcome back, {user?.name}. Here's your work summary.
              </p>
            </div>
            <Button variant="secondary" size="md" onClick={handleSyncAttendance} disabled={isSyncing}>
              <RefreshCw size={16} className={isSyncing ? 'animate-spin mr-2' : 'mr-2'} />
              {isSyncing ? 'Syncing...' : 'Sync Attendance'}
            </Button>
          </motion.div>

          {/* Quick Stats */}
          {activeTab === 'overview' && (
            <motion.div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6 mb-8">
              <StatCard
                title="Hours This Month"
                value={stats?.total_hours || '0'}
                icon={Clock}
                trend={5}
                trendLabel="vs last month"
                variant="default"
              />
              <StatCard
                title="Leave Balance"
                value={leaveBank?.remaining_leaves || '0'}
                icon={Calendar}
                trend={-2}
                trendLabel="leaves used"
                variant="success"
              />
              <StatCard
                title="Net Salary"
                value={`PKR ${stats?.total_salary?.toLocaleString() || '0'}`}
                icon={DollarSign}
                trend={0}
                variant="primary"
              />
              <StatCard
                title="Status"
                value={stats?.status || 'Active'}
                icon={CheckCircle2}
                variant="warning"
              />
            </motion.div>
          )}

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

      <Modal
        isOpen={showDisputeModal}
        onClose={() => setShowDisputeModal(false)}
        title="File New Dispute"
        size="4xl"
        footer={
          <div className="flex gap-4 w-full">
            <Button variant="ghost" className="flex-1 py-3 text-lg" onClick={() => setShowDisputeModal(false)}>
              Cancel
            </Button>
            <Button variant="primary" className="flex-1 py-3 text-lg shadow-lg shadow-primary-200" onClick={handleDisputeSubmit}>
              <Send size={20} />
              Submit Dispute
            </Button>
          </div>
        }
      >
        <div className="space-y-8">
          {/* Info Banner */}
          <motion.div 
            initial={{ opacity: 0, y: -10 }}
            animate={{ opacity: 1, y: 0 }}
            className="p-4 bg-gradient-to-r from-primary-50 to-indigo-50 rounded-xl border border-primary-100 flex gap-3 text-sm text-primary-800 shadow-sm"
          >
            <div className="bg-white p-2 rounded-lg shadow-sm h-fit">
              <Info size={18} className="text-primary-600" />
            </div>
            <p className="leading-relaxed">
              <strong>Submitting Request:</strong> You can only file disputes for records within the <strong>current month</strong>. Ensure descriptions are clear for faster processing.
            </p>
          </motion.div>

          <form className="space-y-8" onSubmit={handleDisputeSubmit}>
            <StaggerChildren stagger={0.1}>
              {/* Category Selector Cards */}
              <motion.div className="space-y-3" variants={SlideUp}>
                <label className="text-sm font-semibold text-neutral-700 ml-1">Select Dispute Category</label>
                <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
                  {[
                    { id: 'absent', label: 'Absent', icon: AlertOctagon, color: 'hover:border-error-500 hover:bg-error-50 text-error-600' },
                    { id: 'late', label: 'Late', icon: Watch, color: 'hover:border-warning-500 hover:bg-warning-50 text-warning-600' },
                    { id: 'half-day', label: 'Half-day', icon: Sunset, color: 'hover:border-info-500 hover:bg-info-50 text-info-600' },
                    { id: 'leave', label: 'Leave', icon: Home, color: 'hover:border-success-500 hover:bg-success-50 text-success-600' },
                  ].map((cat) => (
                    <motion.button
                      key={cat.id}
                      type="button"
                      whileHover={{ scale: 1.02, y: -2 }}
                      whileTap={{ scale: 0.98 }}
                      onClick={() => setDisputeForm({ ...disputeForm, category: cat.id })}
                      className={`relative flex flex-col items-center justify-center p-4 rounded-xl border-2 transition-all duration-300 ${
                        disputeForm.category === cat.id 
                          ? 'border-primary-500 bg-primary-50 ring-4 ring-primary-50' 
                          : 'border-neutral-100 bg-neutral-50/50 grayscale hover:grayscale-0'
                      } ${cat.color}`}
                    >
                      <cat.icon size={28} className="mb-2" />
                      <span className="text-xs font-bold uppercase tracking-wider">{cat.label}</span>
                      {disputeForm.category === cat.id && (
                        <div className="absolute -top-2 -right-2 bg-primary-500 text-white rounded-full p-1 shadow-lg">
                          <CheckCircle2 size={12} />
                        </div>
                      )}
                    </motion.button>
                  ))}
                </div>
              </motion.div>

              {/* Form Inputs Grid */}
              <motion.div className="grid grid-cols-1 md:grid-cols-2 gap-6" variants={SlideUp}>
                <Input
                  label="Dispute Date"
                  type="date"
                  required
                  icon={CalendarIcon}
                  className="bg-neutral-50/50"
                  value={disputeForm.dispute_date}
                  onChange={(e) => setDisputeForm({ ...disputeForm, dispute_date: e.target.value })}
                  min={new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString().split('T')[0]}
                  max={new Date().toISOString().split('T')[0]}
                />
                <div className="w-full">
                  <label className="block text-sm font-medium text-neutral-700 mb-2">Category Detail</label>
                  <div className="px-4 py-3 bg-neutral-100/50 rounded-md border border-neutral-200 text-neutral-500 text-sm flex items-center gap-2 italic">
                    <Tag size={16} />
                    Auto-selected: {disputeForm.category.toUpperCase()}
                  </div>
                </div>
              </motion.div>

              {/* Rich Textarea Wrapper */}
              <motion.div className="relative" variants={SlideUp}>
                <Textarea
                  label="Detailed Explanation"
                  placeholder="e.g., 'The facial recognition failed multiple times at 09:05 AM, but I was at the premises...'"
                  required
                  className="bg-neutral-50/50 focus:bg-white transition-colors"
                  rows={5}
                  value={disputeForm.description}
                  onChange={(e) => setDisputeForm({ ...disputeForm, description: e.target.value })}
                />
                <div className="absolute right-3 bottom-3 text-neutral-300 pointer-events-none">
                  <MessageSquare size={20} />
                </div>
              </motion.div>
            </StaggerChildren>
          </form>
        </div>
      </Modal>
    </>
  );
}

// Overview Tab Component
function OverviewTab({ stats, logs, loading }) {
  return (
    <SlideUp>
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Recent Activity */}
        <Card className="lg:col-span-2">
          <CardHeader>
            <h3 className="text-lg font-semibold text-neutral-900">Recent Attendance</h3>
          </CardHeader>
          <CardBody>
            {loading ? (
              <div className="text-center py-8 text-neutral-500">Loading...</div>
            ) : logs?.length > 0 ? (
              <div className="space-y-4">
                {logs.slice(0, 5).map((log, idx) => (
                  <motion.div
                    key={idx}
                    initial={{ opacity: 0, x: -20 }}
                    animate={{ opacity: 1, x: 0 }}
                    transition={{ delay: idx * 0.1 }}
                    className="flex items-center justify-between p-4 bg-neutral-50 rounded-lg border border-neutral-200"
                  >
                    <div>
                      <p className="font-medium text-neutral-900">
                        {new Date(log.date).toLocaleDateString()}
                      </p>
                      <p className="text-sm text-neutral-600">
                        {log.check_in_time ? formatTime12h(log.check_in_time) : 'Not checked in'}
                      </p>
                    </div>
                    <div className="text-right">
                      <span className="inline-block px-3 py-1 rounded-full text-xs font-medium bg-success/10 text-success">
                        {log.status || 'Present'}
                      </span>
                    </div>
                  </motion.div>
                ))}
              </div>
            ) : (
              <div className="text-center py-8 text-neutral-500">No recent attendance</div>
            )}
          </CardBody>
        </Card>

        {/* Quick Actions */}
        <Card>
          <CardHeader>
            <h3 className="text-lg font-semibold text-neutral-900">Quick Actions</h3>
          </CardHeader>
          <CardBody className="space-y-3">
            <Button className="w-full" variant="primary">
              <Download size={18} />
              Download Salary Slip
            </Button>
            <Button className="w-full" variant="secondary">
              <FileText size={18} />
              View Full History
            </Button>
            <Button className="w-full" variant="ghost">
              <Plus size={18} />
              File Dispute
            </Button>
          </CardBody>
        </Card>
      </div>
    </SlideUp>
  );
}

// Attendance Tab Component
function AttendanceTab({ absences, loading, pagination, onFilterChange, onPageChange }) {
  return (
    <SlideUp>
      <AttendanceFilters onFilterChange={onFilterChange} />
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
                      <th className="px-6 py-3 text-left text-xs font-semibold text-neutral-500 uppercase tracking-wider">Date</th>
                      <th className="px-6 py-3 text-left text-xs font-semibold text-neutral-500 uppercase tracking-wider">Check In</th>
                      <th className="px-6 py-3 text-left text-xs font-semibold text-neutral-500 uppercase tracking-wider">Check Out</th>
                      <th className="px-6 py-3 text-left text-xs font-semibold text-neutral-500 uppercase tracking-wider">Hours</th>
                      <th className="px-6 py-3 text-left text-xs font-semibold text-neutral-500 uppercase tracking-wider">Status</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-neutral-200">
                    {absences?.map((log, idx) => (
                      <tr key={idx} className="hover:bg-neutral-50 transition-colors">
                        <td className="px-6 py-4 whitespace-nowrap">{new Date(log.date).toLocaleDateString()}</td>
                        <td className="px-6 py-4 whitespace-nowrap font-mono text-sm">{formatTime12h(log.check_in_time)}</td>
                        <td className="px-6 py-4 whitespace-nowrap font-mono text-sm">{formatTime12h(log.check_out_time)}</td>
                        <td className="px-6 py-4 whitespace-nowrap">{log.total_hours?.toFixed(2) || '-'}</td>
                        <td className="px-6 py-4 whitespace-nowrap">
                          <span className={`badge ${
                            log.status === 'present' ? 'badge-success' : 
                            log.status === 'leave' ? 'badge-warning' : 'badge-danger'
                          }`}>
                            {log.status}
                          </span>
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

// Salary Tab Component
function SalaryTab({ 
  stats, 
  loading, 
  salaryHistory, 
  paidPagination, 
  deductionPagination, 
  onPaidFilterChange, 
  onPaidPageChange,
  onDeductionFilterChange,
  onDeductionPageChange
}) {
  const paidHistory = salaryHistory?.paid || [];
  const deductionHistory = salaryHistory?.deductions || [];

  return (
    <SlideUp>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6 mb-8">
        <Card>
          <CardHeader>
            <h3 className="text-lg font-semibold text-neutral-900">Salary Breakdown (Current Month)</h3>
          </CardHeader>
          <CardBody className="space-y-4">
            <div className="flex justify-between items-center">
              <span className="text-neutral-600">Base Salary</span>
              <span className="font-semibold">PKR {stats?.monthly_salary?.toLocaleString()}</span>
            </div>
            <div className="flex justify-between items-center text-error">
              <span className="text-neutral-600">Deductions</span>
              <span className="font-semibold">PKR {stats?.deductions?.toLocaleString()}</span>
            </div>
            <hr />
            <div className="flex justify-between items-center text-lg font-bold text-primary-600">
              <span>Net Payable</span>
              <span>PKR {stats?.total_salary?.toLocaleString()}</span>
            </div>
          </CardBody>
        </Card>

        <Card>
          <CardHeader>
            <h3 className="text-lg font-semibold text-neutral-900">Leave Summary</h3>
          </CardHeader>
          <CardBody className="space-y-4">
            <div className="flex justify-between items-center">
              <span className="text-neutral-600">Total Leaves</span>
              <span className="font-semibold">{stats?.leave_bank || '0'} days</span>
            </div>
            <div className="flex justify-between items-center text-success">
              <span className="text-neutral-600">Leaves Used</span>
              <span className="font-semibold">{stats?.paid_leaves_used || '0'} days</span>
            </div>
            <hr />
            <div className="flex justify-between items-center font-bold text-info">
              <span>Remaining</span>
              <span>{stats?.remaining_leaves || '0'} days</span>
            </div>
          </CardBody>
        </Card>
      </div>

      <div className="space-y-6">
        {/* Paid Salary History */}
        <Card>
          <CardHeader>
            <h3 className="text-lg font-semibold text-neutral-900">Paid Salary History</h3>
          </CardHeader>
          <CardBody>
            <AttendanceFilters onFilterChange={onPaidFilterChange} showCategory={false} />
            {loading ? (
              <div className="text-center py-4">Loading history...</div>
            ) : paidHistory?.length > 0 ? (
              <div className="overflow-x-auto">
                <table className="w-full">
                  <thead>
                    <tr>
                      <th className="text-left py-3">Date</th>
                      <th className="text-left py-3">Payable</th>
                      <th className="text-left py-3">Deduction</th>
                      <th className="text-left py-3">Paid Amount</th>
                      <th className="text-left py-3">Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {paidHistory.map((s, idx) => (
                      <tr key={idx} className="border-t border-neutral-100">
                        <td className="py-3">{new Date(s.date).toLocaleDateString()}</td>
                        <td className="py-3">PKR {s.payable_salary?.toLocaleString()}</td>
                        <td className="py-3 text-error">-PKR {s.deduction?.toLocaleString()}</td>
                        <td className="py-3 font-semibold text-success">PKR {s.paid_salary?.toLocaleString()}</td>
                        <td className="py-3 text-right">
                          <PayslipPDFButton 
                            employeeName="Employee Payslip"
                            salaryData={{
                              monthly_salary: s.payable_salary + s.deduction,
                              deductions: s.deduction,
                              total_salary: s.paid_salary,
                              date: s.date
                            }}
                          />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <div className="text-center py-8 text-neutral-500">No payment history found</div>
            )}
          </CardBody>
          <CardFooter>
            <Pagination 
              currentPage={paidPagination.currentPage}
              totalPages={paidPagination.totalPages}
              onPageChange={onPaidPageChange}
            />
          </CardFooter>
        </Card>

        {/* Salary Deduction History */}
        <Card>
          <CardHeader>
            <h3 className="text-lg font-semibold text-neutral-900">Salary Deduction History</h3>
          </CardHeader>
          <CardBody>
            <AttendanceFilters onFilterChange={onDeductionFilterChange} excludeCategories={['present']} />
            {loading ? (
              <div className="text-center py-4">Loading history...</div>
            ) : deductionHistory?.length > 0 ? (
              <div className="overflow-x-auto">
                <table className="w-full">
                  <thead>
                    <tr>
                      <th className="text-left py-3">Date</th>
                      <th className="text-left py-3">Deduction Amount</th>
                      <th className="text-left py-3">Reason</th>
                    </tr>
                  </thead>
                  <tbody>
                    {deductionHistory.map((d, idx) => (
                      <tr key={idx} className="border-t border-neutral-100">
                        <td className="py-3">{new Date(d.date).toLocaleDateString()}</td>
                        <td className="py-3 font-semibold text-error">PKR {d.amount?.toLocaleString()}</td>
                        <td className="py-3 capitalize">{d.type}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <div className="text-center py-8 text-neutral-500">No deduction history found</div>
            )}
          </CardBody>
          <CardFooter>
            <Pagination 
              currentPage={deductionPagination.currentPage}
              totalPages={deductionPagination.totalPages}
              onPageChange={onDeductionPageChange}
            />
          </CardFooter>
        </Card>
      </div>
    </SlideUp>
  );
}

// Disputes Tab Component
function DisputesTab({ disputes, loading, pagination, onFilterChange, onPageChange, onNewDispute }) {
  return (
    <SlideUp>
      <AttendanceFilters onFilterChange={onFilterChange} />
      <Card>
        <CardHeader className="flex justify-between items-center">
          <h3 className="text-lg font-semibold text-neutral-900">Disputes</h3>
          <Button size="sm" variant="primary" onClick={onNewDispute}>
            <Plus size={16} />
            File New Dispute
          </Button>
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
                      <p className="font-semibold text-neutral-900 capitalize">{dispute.category}</p>
                      <p className="text-sm text-neutral-600">{dispute.description}</p>
                      <p className="text-xs text-neutral-500 mt-2">
                        {new Date(dispute.dispute_date).toLocaleDateString()}
                      </p>
                    </div>
                    <span className={`badge ${
                      dispute.status === 'resolved' ? 'badge-success' : 
                      dispute.status === 'pending' ? 'badge-warning' : 'badge-error'
                    }`}>
                      {dispute.status}
                    </span>
                  </div>
                </motion.div>
              ))}
            </div>
          ) : (
            <div className="text-center py-12">
              <AlertCircle size={48} className="mx-auto text-neutral-300 mb-4" />
              <p className="text-neutral-600">No disputes filed</p>
            </div>
          )}
        </CardBody>
        <CardFooter>
          <Pagination 
            currentPage={pagination.currentPage}
            totalPages={pagination.totalPages}
            onPageChange={onPageChange}
          />
        </CardFooter>
      </Card>
    </SlideUp>
  );
}

// Screenshots Tab Component
function ScreenshotsTab({ user }) {
  const [logs, setLogs] = useState([]);
  const [loading, setLoading] = useState(false);
  const [filter, setFilter] = useState('today');

  useEffect(() => {
    fetchLogs();
  }, [filter]);

  const fetchLogs = async () => {
    setLoading(true);
    try {
      let startDate, endDate;
      const today = new Date();
      today.setHours(0, 0, 0, 0);

      const yesterday = new Date(today);
      yesterday.setDate(yesterday.getDate() - 1);

      const beforeYesterday = new Date(today);
      beforeYesterday.setDate(beforeYesterday.getDate() - 2);

      if (filter === 'today') {
        startDate = today.toISOString();
        endDate = new Date(today.getTime() + 24 * 60 * 60 * 1000 - 1).toISOString();
      } else if (filter === 'yesterday') {
        startDate = yesterday.toISOString();
        endDate = new Date(yesterday.getTime() + 24 * 60 * 60 * 1000 - 1).toISOString();
      } else if (filter === 'beforeYesterday') {
        startDate = beforeYesterday.toISOString();
        endDate = new Date(beforeYesterday.getTime() + 24 * 60 * 60 * 1000 - 1).toISOString();
      }
      
      const res = await api.getMonitoringLogs({ 
        userId: user.user_id, 
        startDate, 
        endDate, 
        includeScreenshot: true,
        limit: 100 
      });
      // Only keep records that actually have a screenshot
      const logsWithImages = (res.data.logs || []).filter(log => log.screenshot_b64);
      setLogs(logsWithImages);
    } catch (err) {
      console.error('Failed to fetch screenshots', err);
    }
    setLoading(false);
  };

  return (
    <SlideUp>
      <Card>
        <CardHeader className="flex flex-col sm:flex-row items-center justify-between gap-4">
          <h3 className="text-lg font-semibold text-neutral-900 flex items-center gap-2">
            <ImageIcon size={20} className="text-primary-600" />
            My Screenshots
          </h3>
          <div className="flex bg-neutral-100 p-1 rounded-lg overflow-x-auto w-full sm:w-auto">
            {[
              { id: 'today', label: 'Today' },
              { id: 'yesterday', label: 'Yesterday' },
              { id: 'beforeYesterday', label: 'Day Before Yesterday' },
              { id: 'all', label: 'All Time' }
            ].map(f => (
              <button
                key={f.id}
                onClick={() => setFilter(f.id)}
                className={`flex-1 sm:flex-none px-4 py-2 text-sm font-medium rounded-md transition-all whitespace-nowrap ${
                  filter === f.id ? 'bg-white text-primary-600 shadow-sm' : 'text-neutral-500 hover:text-neutral-700 hover:bg-neutral-200/50'
                }`}
              >
                {f.label}
              </button>
            ))}
          </div>
        </CardHeader>
        <CardBody>
          {loading ? (
            <div className="text-center py-12 text-neutral-500">Loading screenshots...</div>
          ) : logs.length > 0 ? (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
              {logs.map((log) => (
                <motion.div 
                  key={log.id}
                  initial={{ opacity: 0, scale: 0.95 }}
                  animate={{ opacity: 1, scale: 1 }}
                  className="rounded-lg overflow-hidden border border-neutral-200 bg-white group cursor-pointer shadow-sm hover:shadow-md transition-all"
                  onClick={() => {
                    if (log.screenshot_b64) {
                      const win = window.open();
                      win.document.write(`<body style="margin:0;background:#000;display:flex;justify-content:center;align-items:center;height:100vh;"><img src="data:image/jpeg;base64,${log.screenshot_b64}" style="max-width:100%;max-height:100vh;object-fit:contain;" /></body>`);
                    }
                  }}
                >
                  <div className="aspect-video bg-neutral-100 flex items-center justify-center overflow-hidden relative">
                    {log.screenshot_b64 ? (
                      <img 
                        src={`data:image/jpeg;base64,${log.screenshot_b64}`} 
                        alt="Screenshot" 
                        loading="lazy"
                        className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-500"
                      />
                    ) : (
                      <span className="text-neutral-400">No Image Data</span>
                    )}
                    <div className="absolute top-2 right-2 px-2 py-1 text-xs font-semibold rounded bg-black/60 text-white backdrop-blur-sm">
                      {log.app_name}
                    </div>
                  </div>
                  <div className="p-3 bg-neutral-50 border-t border-neutral-100 flex justify-between items-center">
                    <p className="text-sm font-semibold text-neutral-800">
                      {new Date(log.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                    </p>
                    {filter === 'all' && (
                      <p className="text-xs text-neutral-500">
                        {new Date(log.timestamp).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}
                      </p>
                    )}
                  </div>
                </motion.div>
              ))}
            </div>
          ) : (
            <div className="text-center py-12 text-neutral-500 bg-neutral-50/50 rounded-lg border border-dashed border-neutral-200">
              <ImageIcon size={48} className="mx-auto text-neutral-300 mb-3" />
              <p className="font-medium text-neutral-600">No screenshots found</p>
              <p className="text-sm text-neutral-400 mt-1">There are no monitoring records for the selected period.</p>
            </div>
          )}
        </CardBody>
      </Card>
    </SlideUp>
  );
}

export default EmployeeDashboard;
