import React, { useState, useEffect, useMemo, useCallback } from "react";
import { motion, AnimatePresence } from "framer-motion";
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
  RefreshCw,
} from "lucide-react";
import LayoutContainer from "./layout/LayoutContainer";
import StatCard from "./dashboard/StatCard";
import { Button } from "./common/Button";
import { Card, CardHeader, CardBody, CardFooter } from "./common/Card";
import { SlideUp, StaggerChildren } from "./animations";
import api from "../services/api";
import { AttendanceFilters } from "./common/AttendanceFilters";
import { Modal, Input, Select, Textarea, Pagination, Badge } from "./common";
import {
  Send,
  Calendar as CalendarIcon,
  Tag,
  MessageSquare,
  Info,
  AlertOctagon,
  Watch,
  Sunset,
  Home,
  Image as ImageIcon,
} from "lucide-react";

import { AttendanceCalendar } from "./calendar/AttendanceCalendar";
import { HolidayCalendar } from "./calendar/HolidayCalendar";
import { LeaveRequestHub } from "./leaves/LeaveRequestHub";
import { PayslipPDFButton } from "./salary/PayslipPDFButton";
import { SettingsTab } from "./dashboard/SettingsTab";
import { formatTime12h, formatDateLocal } from "../utils/formatters";
import { LeadDisputeDashboard } from "./LeadDisputeDashboard";

function EmployeeDashboard({ user, onLogout }) {
  const [activeTab, setActiveTab] = useState(() => {
    return sessionStorage.getItem("employeeDashboardActiveTab") || "overview";
  });

  useEffect(() => {
    sessionStorage.setItem("employeeDashboardActiveTab", activeTab);
  }, [activeTab]);

  const [stats, setStats] = useState(null);
  const [logs, setLogs] = useState([]);
  const [absences, setAbsences] = useState([]);
  const [leaveBank, setLeaveBank] = useState(null);
  const [disputes, setDisputes] = useState([]);
  const [salaryHistory, setSalaryHistory] = useState([]);
  const [showDisputeModal, setShowDisputeModal] = useState(false);
  const [disputeForm, setDisputeForm] = useState({
    category: "absent",
    dispute_date: "",
    description: "",
  });
  const [loading, setLoading] = useState(true);
  const [attendanceLoading, setAttendanceLoading] = useState(false);
  const [disputeLoading, setDisputeLoading] = useState(false);
  const [salaryLoading, setSalaryLoading] = useState(false);
  const [notifications, setNotifications] = useState([]);
  const [holidays, setHolidays] = useState([]);
  const [filterType, setFilterType] = useState("current");
  const [attendancePagination, setAttendancePagination] = useState({
    currentPage: 1,
    totalPages: 1,
    totalRecords: 0,
  });
  const [salaryPaidPagination, setSalaryPaidPagination] = useState({
    currentPage: 1,
    totalPages: 1,
    totalRecords: 0,
  });
  const [salaryDeductionPagination, setSalaryDeductionPagination] = useState({
    currentPage: 1,
    totalPages: 1,
    totalRecords: 0,
  });
  const [disputePagination, setDisputePagination] = useState({
    currentPage: 1,
    totalPages: 1,
    totalRecords: 0,
  });
  const [attendanceFilters, setAttendanceFilters] = useState({
    startDate: formatDateLocal(
      new Date(new Date().getFullYear(), new Date().getMonth(), 1),
    ),
    endDate: formatDateLocal(
      new Date(new Date().getFullYear(), new Date().getMonth() + 1, 0),
    ),
    status: "all",
  });
  const [salaryPaidFilters, setSalaryPaidFilters] = useState({
    startDate: formatDateLocal(
      new Date(new Date().getFullYear(), new Date().getMonth(), 1),
    ),
    endDate: formatDateLocal(
      new Date(new Date().getFullYear(), new Date().getMonth() + 1, 0),
    ),
    type: "all",
  });
  const [salaryDeductionFilters, setSalaryDeductionFilters] = useState({
    startDate: formatDateLocal(
      new Date(new Date().getFullYear(), new Date().getMonth(), 1),
    ),
    endDate: formatDateLocal(
      new Date(new Date().getFullYear(), new Date().getMonth() + 1, 0),
    ),
    type: "all",
  });
  const [disputeFilters, setDisputeFilters] = useState({
    startDate: formatDateLocal(
      new Date(new Date().getFullYear(), new Date().getMonth(), 1),
    ),
    endDate: formatDateLocal(
      new Date(new Date().getFullYear(), new Date().getMonth() + 1, 0),
    ),
    category: "all",
  });
  const [isSyncing, setIsSyncing] = useState(false);
  const [recordingState, setRecordingState] = useState("idle");
  const [leaveTypes, setLeaveTypes] = useState([]);

  // Subscribe to recording state changes from the Electron main process.
  // Shows an in-app transparency banner whenever the admin has started a recording session.
  useEffect(() => {
    const api = window.electronAPI?.recording;
    if (!api) return; // Not running in Electron — skip
    api.getState().then((s) => setRecordingState(s?.state ?? "idle"));
    api.onStateChange((s) => setRecordingState(s?.state ?? "idle"));
    return () => api.removeStateListeners();
  }, []);

  // Fetch leave types once on mount (for AttendanceTab leave request flow)
  useEffect(() => {
    api
      .getLeaveTypes()
      .then((r) =>
        setLeaveTypes((r.data || []).filter((t) => t.name !== "Legacy")),
      )
      .catch(console.error);
  }, []);

  const handleSyncAttendance = async () => {
    setIsSyncing(true);
    try {
      await api.syncAttendanceToday();
      fetchUserData();
      if (activeTab === "attendance") fetchAbsenceData();
    } catch (err) {
      console.error("Failed to sync", err);
      alert("Failed to sync attendance");
    }
    setIsSyncing(false);
  };
  useEffect(() => {
    fetchUserData();
  }, [filterType]);

  useEffect(() => {
    if (activeTab === "attendance") {
      fetchAbsenceData();
    } else if (activeTab === "disputes") {
      fetchDisputeData();
    } else if (activeTab === "salary") {
      fetchSalaryPaidHistory();
      fetchSalaryDeductionHistory();
    }
  }, [activeTab]);

  const fetchHolidays = async () => {
    try {
      const res = await api.getHolidays();
      setHolidays(res.data || []);
    } catch (err) {
      console.error("Error fetching holidays:", err);
    }
  };

  // Fetch notifications
  const fetchNotifications = async () => {
    try {
      const res = await api.getNotifications(user.user_id);
      setNotifications(
        (res.data || []).map((n) => ({
          id: n.id,
          type: n.type,
          title:
            n.type === "dispute_approved"
              ? "Appeal Approved"
              : n.type === "dispute_rejected"
                ? "Appeal Rejected"
                : n.type === "leave_approved"
                  ? "Leave Approved"
                  : n.type === "leave_rejected"
                    ? "Leave Rejected"
                    : "Notification",
          message: n.message,
          read: n.is_read,
          created_at: n.created_at,
        })),
      );
    } catch (err) {
      console.error("Error fetching notifications:", err);
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
        console.error("Error marking notification as read:", err);
      }
    }

    // Switch tab based on notification type
    if (
      notif.type === "dispute_approved" ||
      notif.type === "dispute_rejected"
    ) {
      setActiveTab("disputes");
    } else if (
      notif.type === "leave_approved" ||
      notif.type === "leave_rejected"
    ) {
      setActiveTab("attendance"); // Or a separate 'leaves' tab if one exists
    }
  };

  const fetchUserData = async () => {
    setLoading(true);
    try {
      const now = new Date();
      const start = formatDateLocal(
        new Date(now.getFullYear(), now.getMonth(), 1),
      );
      const end = formatDateLocal(
        new Date(now.getFullYear(), now.getMonth() + 1, 0),
      );

      const [repRes, attRecordsRes] = await Promise.all([
        api.getSalaryReport(start, end),
        api.getUserAttendanceRecords(user.user_id, start, end),
      ]);

      const myStats = repRes.data.find(
        (r) => String(r.id) === String(user.user_id),
      );
      setStats(myStats);
      setLogs(attRecordsRes.data);
    } catch (err) {
      console.error("Error fetching data:", err);
    }
    setLoading(false);
  };

  const fetchAbsenceData = useCallback(
    async (startDate, endDate, status, page = 1) => {
      setAttendanceLoading(true);
      const sDate =
        startDate !== undefined ? startDate : attendanceFilters.startDate;
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
          totalRecords: total,
        });
        setAttendanceFilters({ startDate: sDate, endDate: eDate, status: st });
        setLeaveBank(leaveBankRes.data);
      } catch (err) {
        console.error("Error fetching absence data:", err);
      }
      setAttendanceLoading(false);
    },
    [attendanceFilters, user.user_id],
  );

  const fetchDisputeData = useCallback(
    async (startDate, endDate, category, page = 1) => {
      setDisputeLoading(true);
      const sDate =
        startDate !== undefined ? startDate : disputeFilters.startDate;
      const eDate = endDate !== undefined ? endDate : disputeFilters.endDate;
      const cat = category !== undefined ? category : disputeFilters.category;

      try {
        const res = await api.getUserDisputes(
          user.user_id,
          sDate,
          eDate,
          cat,
          page,
        );

        // Handle wrapped and unwrapped structures, including direct arrays
        const responseData = res.data?.data || res.data;
        let records = [];
        let total = 0;

        if (Array.isArray(responseData)) {
          records = responseData;
          total = responseData.length;
        } else if (responseData?.records) {
          records = responseData.records;
          total = responseData.total || records.length;
        }

        setDisputes(records);
        setDisputePagination({
          currentPage: page,
          totalPages: Math.ceil(total / 20),
          totalRecords: total,
        });
        setDisputeFilters({ startDate: sDate, endDate: eDate, category: cat });
      } catch (err) {
        console.error("Error fetching disputes:", err);
      }
      setDisputeLoading(false);
    },
    [disputeFilters, user.user_id],
  );

  const fetchSalaryPaidHistory = useCallback(
    async (startDate, endDate, page = 1) => {
      setSalaryLoading(true);
      const sDate =
        startDate !== undefined ? startDate : salaryPaidFilters.startDate;
      const eDate = endDate !== undefined ? endDate : salaryPaidFilters.endDate;

      try {
        const res = await api.getUserSalaryHistory(
          user.user_id,
          sDate,
          eDate,
          page,
        );
        setSalaryHistory((prev) => ({
          ...prev,
          paid: res.data.records || [],
        }));
        setSalaryPaidPagination({
          currentPage: page,
          totalPages: Math.ceil((res.data.total || 0) / 20),
          totalRecords: res.data.total || 0,
        });
        setSalaryPaidFilters({
          ...salaryPaidFilters,
          startDate: sDate,
          endDate: eDate,
        });
      } catch (err) {
        console.error("Error fetching paid salary history:", err);
      }
      setSalaryLoading(false);
    },
    [salaryPaidFilters, user.user_id],
  );

  const fetchSalaryDeductionHistory = useCallback(
    async (startDate, endDate, type, page = 1) => {
      setSalaryLoading(true);
      const sDate =
        startDate !== undefined ? startDate : salaryDeductionFilters.startDate;
      const eDate =
        endDate !== undefined ? endDate : salaryDeductionFilters.endDate;
      const t = type !== undefined ? type : salaryDeductionFilters.type;

      try {
        const res = await api.getUserDeductions(
          user.user_id,
          sDate,
          eDate,
          t,
          page,
        );
        setSalaryHistory((prev) => ({
          ...prev,
          deductions: res.data.records || [],
        }));
        setSalaryDeductionPagination({
          currentPage: page,
          totalPages: Math.ceil((res.data.total || 0) / 20),
          totalRecords: res.data.total || 0,
        });
        setSalaryDeductionFilters({
          startDate: sDate,
          endDate: eDate,
          type: t,
        });
      } catch (err) {
        console.error("Error fetching deduction history:", err);
      }
      setSalaryLoading(false);
    },
    [salaryDeductionFilters, user.user_id],
  );

  const handleDisputeSubmit = async (e) => {
    e.preventDefault();
    if (
      !disputeForm.dispute_date ||
      !disputeForm.category ||
      !disputeForm.description
    ) {
      alert("Please fill all fields");
      return;
    }

    try {
      await api.createDispute({
        req_by: user.user_id, // Prisma schema uses req_by
        category: disputeForm.category,
        dispute_date: disputeForm.dispute_date,
        description: disputeForm.description,
      });
      alert("Appeal submitted successfully!");
      setDisputeForm({ category: "absent", dispute_date: "", description: "" });
      setShowDisputeModal(false);
      fetchDisputeData();
    } catch (error) {
      console.error("Error submitting dispute:", error);
      alert("Failed to submit appeal");
    }
  };

  // Breadcrumb trails
  const breadcrumbs = [
    { label: "Dashboard", active: activeTab === "overview" },
    ...(activeTab !== "overview" &&
    activeTab !== "salary" &&
    activeTab !== "disputes"
      ? [{ label: activeTab.charAt(0).toUpperCase() + activeTab.slice(1) }]
      : []),
  ];

  const tabsConfig = useMemo(() => {
    const baseTabs = [
      {
        id: "overview",
        label: "Dashboard",
        icon: null,
        content: (
          <OverviewTab
            user={user}
            stats={stats}
            logs={logs}
            loading={loading}
            setActiveTab={setActiveTab}
            setShowDisputeModal={setShowDisputeModal}
            setDisputeForm={setDisputeForm}
          />
        ),
      },
      {
        id: "attendance",
        label: "Attendance",
        content: (
          <AttendanceTab
            absences={absences}
            loading={attendanceLoading}
            pagination={attendancePagination}
            leaveBank={leaveBank}
            userId={user.user_id}
            user={user}
            leaveTypes={leaveTypes}
            onFilterChange={(f) =>
              fetchAbsenceData(f.startDate, f.endDate, f.category, 1)
            }
            onPageChange={(page) =>
              fetchAbsenceData(undefined, undefined, undefined, page)
            }
            onRefresh={() => fetchAbsenceData()}
          />
        ),
      },
      {
        id: "salary",
        label: "Salary",
        content: (
          <SalaryTab
            stats={stats}
            loading={salaryLoading}
            salaryHistory={salaryHistory}
            paidPagination={salaryPaidPagination}
            deductionPagination={salaryDeductionPagination}
            onPaidFilterChange={(f) =>
              fetchSalaryPaidHistory(f.startDate, f.endDate, 1)
            }
            onPaidPageChange={(page) =>
              fetchSalaryPaidHistory(undefined, undefined, page)
            }
            onDeductionFilterChange={(f) =>
              fetchSalaryDeductionHistory(f.startDate, f.endDate, f.category, 1)
            }
            onDeductionPageChange={(page) =>
              fetchSalaryDeductionHistory(undefined, undefined, undefined, page)
            }
          />
        ),
      },
      {
        id: "leaves",
        label: "Leave Requests",
        content: <LeaveRequestHub user={user} isAdmin={false} />,
      },
      {
        id: "disputes",
        label: "Appeals",
        content: (
          <DisputesTab
            disputes={disputes}
            loading={disputeLoading}
            pagination={disputePagination}
            onFilterChange={(f) =>
              fetchDisputeData(f.startDate, f.endDate, f.category, 1)
            }
            onPageChange={(page) =>
              fetchDisputeData(undefined, undefined, undefined, page)
            }
            onNewDispute={() => setShowDisputeModal(true)}
          />
        ),
      },
      {
        id: "settings",
        label: "Settings",
        content: <SettingsTab user={user} />,
      },
    ];

    if (user?.is_lead) {
      baseTabs.splice(4, 0, {
        id: "team_disputes",
        label: "Team Appeals",
        content: <LeadDisputeDashboard user={user} />,
      });
    }

    return baseTabs;
  }, [
    stats,
    logs,
    loading,
    absences,
    attendanceLoading,
    attendancePagination,
    leaveBank,
    salaryLoading,
    salaryHistory,
    salaryPaidPagination,
    salaryDeductionPagination,
    disputes,
    disputeLoading,
    disputePagination,
    user,
    fetchAbsenceData,
    fetchSalaryPaidHistory,
    fetchSalaryDeductionHistory,
    fetchDisputeData,
  ]);

  return (
    <>
      {/* ── Recording Transparency Banner ─────────────────────────────────────
          Shown when the admin has started a recording session on this device.
          Legal requirement: employees must know they are being recorded.
      ─────────────────────────────────────────────────────────────────────── */}
      {/* {(recordingState === 'recording' || recordingState === 'starting') && (
        <div
          style={{
            position: 'fixed', top: 0, left: 0, right: 0,
            zIndex: 99999,
            background: 'linear-gradient(90deg, #dc2626, #b91c1c)',
            color: '#fff',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            gap: '10px',
            padding: '6px 16px',
            fontSize: '13px',
            fontWeight: 600,
            letterSpacing: '0.02em',
            boxShadow: '0 2px 12px rgba(220,38,38,0.35)',
            userSelect: 'none',
          }}
        >
          <span style={{
            width: 10, height: 10, borderRadius: '50%',
            background: '#fff',
            display: 'inline-block',
            animation: 'pulse 1.2s ease-in-out infinite',
          }} />
          <style>{`@keyframes pulse { 0%,100%{opacity:1} 50%{opacity:0.3} }`}</style>
          Screen Recording Active — This session is being recorded by your administrator
        </div>
      )} */}

      {/* <Button onClick={() => console.log(window.bp)} id="bp-toggle-chat" className="chatbot-btn">Chat</Button> */}
      <LayoutContainer
        user={user}
        onLogout={onLogout}
        activeTab={activeTab}
        onTabChange={setActiveTab}
        breadcrumbs={breadcrumbs}
        notifications={notifications}
        onNotificationClick={handleNotificationClick}
      >
        <>
          {/* ... existing header and stats ... */}
          {/* Page Header */}
          {/* <motion.div className="mb-8 flex justify-between items-start">
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
          </motion.div> */}
          {/* Quick Stats */}

          {activeTab === "overview" && (
            <div className="flex flex-row justify-center items-center gap-6 mb-8 flex-2">
              <StatCard
                title="Net Salary"
                textAlign="end"
                trendAlign="start"
                value={`Rs. ${stats?.total_salary?.toLocaleString() || "0"}`}
                trend={0}
                variant="primary"
                className="min-w-70"
              />
              <StatCard
                title="Deductions"
                textAlign="start"
                trendAlign="end"
                value={`Rs. ${stats?.deductions?.toLocaleString() || "0"}`}
                trend={0}
                variant="error"
                className="min-w-70"
              />
            </div>
          )}
          {/* Main Content Area */}
          <div className="flex-1">
            {tabsConfig.find((t) => t.id === activeTab)?.content}
          </div>
        </>
      </LayoutContainer>

      <Modal
        className="w-1/2 h-[95%] rounded-2xl"
        isOpen={showDisputeModal}
        onClose={() => setShowDisputeModal(false)}
        title="File New Appeal"
        size="full"
        fullHeight={false}
        footer={
          <div className="flex gap-4 w-[70%]">
            <Button
              variant="ghost"
              className=" px-10 text-md"
              onClick={() => setShowDisputeModal(false)}
            >
              Cancel
            </Button>
            <Button
              variant="primary"
              className="flex-1 py-1 text-md shadow-lg shadow-primary-200"
              onClick={handleDisputeSubmit}
            >
              <Send size={20} />
              Submit Appeal
            </Button>
          </div>
        }
      >
        <div className="space-y-8">
          {/* Info Banner */}
          <motion.div
            initial={{ opacity: 0, y: -10 }}
            animate={{ opacity: 1, y: 0 }}
            className="p-2 bg-gradient-to-r from-primary-50 to-indigo-50 rounded-xl border border-primary-100 flex gap-3 text-sm text-primary-800 shadow-sm"
          >
            <div className="bg-white p-1 rounded-lg shadow-sm h-fit">
              <Info size={20} className="text-primary-600" />
            </div>
            <p className="leading-relaxed">
              <strong>Submitting Request:</strong> File appeals only for{" "}
              <strong>current month</strong>. Ensure description is entered.
            </p>
          </motion.div>

          <form className="space-y-8" onSubmit={handleDisputeSubmit}>
            <StaggerChildren stagger={0.1}>
              {/* Category Selector Cards */}
              <motion.div className="space-y-3" variants={SlideUp}>
                <label className="text-sm font-semibold text-neutral-700 ml-1 mb-1">
                  Select Appeal Category
                </label>
                <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 my-3">
                  {[
                    {
                      id: "absent",
                      label: "Absent",
                      icon: AlertOctagon,
                      color:
                        "hover:border-error-500 hover:bg-error-50 text-error-600",
                    },
                    {
                      id: "late",
                      label: "Late",
                      icon: Watch,
                      color:
                        "hover:border-warning-500 hover:bg-warning-50 text-warning-600",
                    },
                    {
                      id: "half-day",
                      label: "Half-day",
                      icon: Sunset,
                      color:
                        "hover:border-info-500 hover:bg-info-50 text-info-600",
                    },
                    {
                      id: "leave",
                      label: "Leave",
                      icon: Home,
                      color:
                        "hover:border-success-500 hover:bg-success-50 text-success-600",
                    },
                  ].map((cat) => (
                    <motion.button
                      key={cat.id}
                      type="button"
                      whileHover={{ scale: 1.02, y: -2 }}
                      whileTap={{ scale: 0.98 }}
                      onClick={() =>
                        setDisputeForm({ ...disputeForm, category: cat.id })
                      }
                      className={`relative flex flex-col items-center justify-center p-4 rounded-xl border-2 transition-all duration-300 ${
                        disputeForm.category === cat.id
                          ? "border-primary-500 bg-primary-50 ring-4 ring-primary-50"
                          : "border-neutral-100 bg-neutral-50/50 grayscale hover:grayscale-0"
                      } ${cat.color}`}
                    >
                      <cat.icon size={28} className="mb-2" />
                      <span className="text-xs font-bold uppercase tracking-wider">
                        {cat.label}
                      </span>
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
              <motion.div
                className="grid grid-cols-1 md:grid-cols-2 gap-6"
                variants={SlideUp}
              >
                <Input
                  label="Appeal Date"
                  type="date"
                  required
                  icon={CalendarIcon}
                  className="bg-neutral-50/50"
                  value={disputeForm.dispute_date}
                  onChange={(e) =>
                    setDisputeForm({
                      ...disputeForm,
                      dispute_date: e.target.value,
                    })
                  }
                  min={formatDateLocal(
                    new Date(
                      new Date().getFullYear(),
                      new Date().getMonth(),
                      1,
                    ),
                  )}
                  max={formatDateLocal(new Date())}
                />
                <div className="w-full">
                  <label className="block text-sm font-medium text-neutral-700 mb-2">
                    Category Detail
                  </label>
                  <div className="px-4 py-3 bg-neutral-100/50 rounded-md border border-neutral-200 text-neutral-500 text-sm flex items-center gap-2 italic">
                    <Tag size={16} />
                    Auto-selected: {disputeForm.category.toUpperCase()}
                  </div>
                </div>
              </motion.div>

              {/* Rich Textarea Wrapper */}
              <motion.div className="relative mt-3" variants={SlideUp}>
                <Textarea
                  label="Detailed Explanation"
                  placeholder="e.g., 'The facial recognition failed multiple times at 09:05 AM, but I was at the premises...'"
                  required
                  className="bg-neutral-50/50 focus:bg-white transition-colors"
                  rows={5}
                  value={disputeForm.description}
                  onChange={(e) =>
                    setDisputeForm({
                      ...disputeForm,
                      description: e.target.value,
                    })
                  }
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

// OverviewTab Component
function OverviewTab({
  user,
  stats,
  logs,
  loading,
  setActiveTab,
  setShowDisputeModal,
  setDisputeForm,
}) {
  const rows = Array.isArray(logs.records) ? logs.records : [];
  const [todayRecord, setTodayRecord] = useState(null);
  const [punchLoading, setPunchLoading] = useState(false);

  useEffect(() => {
    if (user?.user_id) {
      api
        .getTodayAttendance(user.user_id)
        .then((res) => {
          setTodayRecord(res.data);
        })
        .catch((err) => console.error("Failed to fetch today record", err));
    }
  }, [user?.user_id]);

  const handleManualPunch = async (type) => {
    setPunchLoading(true);
    try {
      await api.manualPunch(user.user_id, type);
      const res = await api.getTodayAttendance(user.user_id);
      setTodayRecord(res.data);
      alert(`Successfully recorded ${type.replace("-", " ")}`);
    } catch (err) {
      alert(
        err.response?.data?.error ||
          `Failed to record ${type.replace("-", " ")}`,
      );
    } finally {
      setPunchLoading(false);
    }
  };

  return (
    <SlideUp>
      <div className="flex flex-row gap-6">
        {/* Recent Activity */}
        <Card className="w-full">
          <CardHeader>
            <h3 className="text-lg font-semibold text-neutral-900">
              Recent Attendance
            </h3>
          </CardHeader>
          <CardBody>
            {loading ? (
              <div className="text-center py-8 text-neutral-500">
                Loading...
              </div>
            ) : rows.filter((row) => row.status !== "weekend").length > 0 ? (
              <div className="space-y-4">
                <span></span>
                {rows
                  .filter((row) => row.status !== "weekend")
                  .slice(0, 5)
                  .map((row, idx) => (
                    <motion.div
                      key={idx}
                      initial={{ opacity: 0, x: -20 }}
                      animate={{ opacity: 1, x: 0 }}
                      transition={{ delay: idx * 0.1 }}
                      className="flex items-center justify-between p-4 bg-neutral-50 rounded-lg border border-neutral-200"
                    >
                      <div>
                        <p className="font-medium text-neutral-900">
                          {new Date(row.date).toLocaleDateString("en-us", {
                            weekday: "long",
                            year: "numeric",
                            month: "long",
                            day: "numeric",
                          })}
                        </p>
                        <p className="text-sm text-neutral-600">
                          {row.check_in_time
                            ? formatTime12h(row.check_in_time)
                            : "Not checked in"}{" "}
                          --{" "}
                          {row.check_out_time
                            ? formatTime12h(row.check_out_time)
                            : "Not checked out"}
                        </p>
                      </div>
                      <div className="text-right">
                        <span className="inline-block px-3 py-1 rounded-full text-xs font-medium bg-success/10 text-success">
                          {row.status || "Present"}
                        </span>
                      </div>
                    </motion.div>
                  ))}
              </div>
            ) : (
              <div className="text-center py-8 text-neutral-500">
                No recent attendance
              </div>
            )}
          </CardBody>
        </Card>

        {/* Quick Actions */}
        <Card className="w-2/4 h-auto">
          <CardHeader>
            <h3 className="text-lg font-semibold text-neutral-900 mb-1">
              Quick Actions
            </h3>
          </CardHeader>
          <CardBody className="space-y-3 mt-4">
            {/* Manual Attendance Buttons */}
            <div className="p-3 bg-neutral-50 border border-neutral-200 rounded-lg space-y-2 mb-4">
              <p className="text-sm font-medium text-neutral-700 mb-2">
                Today's Attendance
              </p>
              {!todayRecord?.check_in_time ? (
                <Button
                  className="w-full bg-success hover:bg-success-600 text-white border-none"
                  onClick={() => handleManualPunch("check-in")}
                  disabled={punchLoading}
                >
                  <Timer size={18} className="mr-2" />
                  {punchLoading ? "Recording..." : "Check In"}
                </Button>
              ) : !todayRecord?.check_out_time ? (
                <Button
                  className="w-full bg-warning hover:bg-warning-600 text-white border-none"
                  onClick={() => handleManualPunch("check-out")}
                  disabled={punchLoading}
                >
                  <Timer size={18} className="mr-2" />
                  {punchLoading ? "Recording..." : "Check Out"}
                </Button>
              ) : (
                <div className="w-full p-2 bg-success/10 text-success-700 rounded text-center text-sm font-medium border border-success/20">
                  <CheckCircle2 size={16} className="inline mr-1" /> Attendance
                  Completed
                </div>
              )}
            </div>

            <Button className="w-full" variant="primary">
              <Download size={18} />
              Download Salary Slip
            </Button>
            <Button
              className="w-full"
              variant="ghost"
              onClick={() => {
                setShowDisputeModal(true);
                setDisputeForm({
                  category: "",
                  dispute_date: "",
                  description: "",
                });
              }}
            >
              <Plus size={18} />
              File Appeal
            </Button>
          </CardBody>
        </Card>
      </div>
    </SlideUp>
  );
}

// Attendance Tab Component
function AttendanceTab({
  absences,
  loading,
  pagination,
  leaveBank,
  userId,
  user,
  leaveTypes = [],
  onRefresh,
  onFilterChange,
  onPageChange,
}) {
  const LEAVE_COSTS = { absent: 1, "half-day": 0.5, halfday: 0.5, late: 0.3 };
  const STATUS_LABELS = {
    absent: "Absent",
    "half-day": "Half Day",
    halfday: "Half Day",
    late: "Late Arrival",
  };

  const [expandedRowIdx, setExpandedRowIdx] = useState(null);

  return (
    <SlideUp>
      <AttendanceFilters onFilterChange={onFilterChange} />
      <Card>
        <CardHeader>
          <h3 className="text-lg font-semibold text-neutral-900">
            Attendance Records
          </h3>
          {leaveBank && (
            <span className="text-sm text-neutral-500">
              Leaves Remaining:{" "}
              <span className="font-semibold text-primary-600">
                {leaveBank.leaves_remaining}
              </span>{" "}
            </span>
          )}
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
                      <th className="px-6 py-3 text-left text-xs font-semibold text-neutral-500 uppercase tracking-wider">
                        Date
                      </th>
                      <th className="px-6 py-3 text-left text-xs font-semibold text-neutral-500 uppercase tracking-wider">
                        Check In
                      </th>
                      <th className="px-6 py-3 text-left text-xs font-semibold text-neutral-500 uppercase tracking-wider">
                        Check Out
                      </th>
                      <th className="px-6 py-3 text-center text-xs font-semibold text-neutral-500 uppercase tracking-wider">
                        Status
                      </th>
                      <th className="px-6 py-3 text-center text-xs font-semibold text-neutral-500 uppercase tracking-wider">
                        Actions
                      </th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-neutral-200">
                    {(Array.isArray(absences) ? absences : [])
                      .filter((log) => log.status !== "weekend")
                      .map((log, idx) => {
                        const statusKey =
                          log.status?.toLowerCase()?.trim() || "";
                        const cost = LEAVE_COSTS[statusKey];
                        const isActionable = !!cost;
                        const isExpanded = expandedRowIdx === idx;

                        return (
                          <React.Fragment key={idx}>
                            <tr
                              onClick={() => {
                                if (isActionable) {
                                  setExpandedRowIdx(isExpanded ? null : idx);
                                }
                              }}
                              className={`transition-colors text-center ${
                                isActionable
                                  ? "cursor-pointer hover:bg-primary-50 hover:shadow-sm"
                                  : "cursor-default hover:bg-neutral-50"
                              } ${isExpanded ? "bg-primary-50/30" : ""}`}
                            >
                              <td className="px-6 py-4 whitespace-nowrap">
                                {new Date(log.date).toLocaleDateString()}
                              </td>
                              <td className="px-6 py-4 whitespace-nowrap font-mono text-sm">
                                {formatTime12h(log.check_in_time)}
                              </td>
                              <td className="px-6 py-4 whitespace-nowrap font-mono text-sm">
                                {formatTime12h(log.check_out_time)}
                              </td>
                              <td className="px-6 py-4 whitespace-nowrap text-center">
                                <span
                                  className={`badge ${
                                    statusKey === "present"
                                      ? "badge-success"
                                      : statusKey === "leave"
                                        ? "badge-not-danger"
                                        : statusKey === "absent"
                                          ? "badge-danger"
                                          : "badge-warning"
                                  }`}
                                >
                                  {log.status.toUpperCase()}
                                </span>
                              </td>
                              <td className="px-6 py-4 whitespace-nowrap relative text-center">
                                {cost ? (
                                  <span className="text-xs font-semibold text-orange-600 px-2 py-1 rounded-full flex items-center justify-center gap-1 w-max mx-auto">
                                    {cost} leave{cost !== 1 ? "s" : ""}
                                    <span
                                      className={`inline-block text-[10px] transition-transform duration-200 ${isExpanded ? "rotate-180" : ""}`}
                                    >
                                      ▼
                                    </span>
                                  </span>
                                ) : (
                                  <span className="text-xs text-neutral-400">
                                    —
                                  </span>
                                )}

                                {/* Expanded Action Panel */}
                                {isExpanded && (
                                  <AttendanceActionPanel
                                    log={log}
                                    statusKey={statusKey}
                                    cost={cost}
                                    userId={userId}
                                    STATUS_LABELS={STATUS_LABELS}
                                    leaveTypes={leaveTypes}
                                    onSuccess={() => {
                                      if (onRefresh) onRefresh();
                                      setTimeout(
                                        () => setExpandedRowIdx(null),
                                        1800,
                                      );
                                    }}
                                    onClose={() => setExpandedRowIdx(null)}
                                  />
                                )}
                              </td>
                            </tr>
                          </React.Fragment>
                        );
                      })}
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

// ─── Attendance Action Panel ─────────────────────────────────────────────────
function AttendanceActionPanel({
  log,
  statusKey,
  cost,
  userId,
  STATUS_LABELS,
  leaveTypes = [],
  onSuccess,
  onClose,
}) {
  const [mode, setMode] = useState(null); // null | 'appeal' | 'leave'
  const [leaveTypeId, setLeaveTypeId] = useState(null);
  const [reason, setReason] = useState("");
  const [loading, setLoading] = useState(false);
  const [feedback, setFeedback] = useState(null);

  const isHalfDay = statusKey === "half-day" || statusKey === "halfday";
  const isLate = statusKey === "late";
  const daysCost = isHalfDay ? 0.5 : isLate ? 0.3 : cost;

  const handleSubmitAppeal = async () => {
    if (!reason.trim()) return;
    setLoading(true);
    try {
      await api.createDispute({
        req_by: userId,
        category: statusKey,
        dispute_date: log.date,
        description: reason.trim(),
      });
      setFeedback({ type: "success", message: "✅ Appeal submitted!" });
      onSuccess();
    } catch (err) {
      setFeedback({
        type: "error",
        message: err?.response?.data?.error || "❌ Failed to submit appeal.",
      });
    }
    setLoading(false);
  };

  const handleSubmitLeaveRequest = async () => {
    if (!reason.trim() || !leaveTypeId) return;
    setLoading(true);
    try {
      const recordDate = log.date?.split("T")[0] ?? log.date;
      await api.createLeaveRequest({
        user_id: userId,
        leave_type_id: parseInt(leaveTypeId),
        start_date: recordDate,
        end_date: recordDate,
        reason: reason.trim(),
        is_half_day: isHalfDay,
        half_day_session: isHalfDay ? "morning" : undefined,
        days_consumed: daysCost,
        idempotency_key: `ATT-LR-${userId}-${recordDate}-${leaveTypeId}-${Date.now()}`,
      });
      setFeedback({
        type: "success",
        message: `✅ Leave request submitted (${daysCost} day${daysCost !== 1 ? "s" : ""}).`,
      });
      onSuccess();
    } catch (err) {
      setFeedback({
        type: "error",
        message: err?.response?.data?.error || "❌ Failed to submit request.",
      });
    }
    setLoading(false);
  };

  return (
    <div
      className="absolute right-0 top-[80%] z-[99] bg-white border border-neutral-200 rounded-2xl shadow-2xl w-[400px] p-5 flex flex-col gap-4 cursor-default text-left"
      onClick={(e) => e.stopPropagation()}
    >
      {/* Header */}
      <div className="flex items-start justify-between">
        <div>
          <p className="text-sm font-bold text-neutral-900">
            {STATUS_LABELS[statusKey] || log.status} &mdash;{" "}
            {new Date(log.date).toLocaleDateString("en-GB", {
              day: "2-digit",
              month: "short",
              year: "numeric",
            })}
          </p>
          <p className="text-xs text-neutral-500 mt-0.5">
            Cost:{" "}
            <strong className="text-orange-600">
              {daysCost} leave{daysCost !== 1 ? "s" : ""}
            </strong>
          </p>
        </div>
        <button
          onClick={onClose}
          className="text-neutral-400 hover:text-neutral-600 text-lg leading-none mt-0.5"
        >
          ✕
        </button>
      </div>

      {/* Feedback banner */}
      {feedback && (
        <div
          className={`px-3 py-2 rounded-lg text-xs font-medium ${
            feedback.type === "success"
              ? "bg-green-50 text-green-700 border border-green-200"
              : "bg-red-50 text-red-700 border border-red-200"
          }`}
        >
          {feedback.message}
        </div>
      )}

      {/* Step 1: Choose action */}
      {!mode && !feedback && (
        <div className="flex gap-3">
          <button
            onClick={() => setMode("appeal")}
            className="flex-1 py-2.5 rounded-xl border-2 border-amber-300 bg-amber-50 text-amber-800 text-sm font-semibold hover:bg-amber-100 transition-colors"
          >
            Appeal
          </button>
          <button
            onClick={() => setMode("leave")}
            className="flex-1 py-2.5 rounded-xl border-2 border-blue-300 bg-blue-50 text-blue-800 text-sm font-semibold hover:bg-blue-100 transition-colors"
          >
            Take Leave
          </button>
        </div>
      )}

      {/* Step 2a: Appeal reason */}
      {mode === "appeal" && !feedback && (
        <div className="flex flex-col gap-3">
          <p className="text-xs text-neutral-500">
            Provide a reason. HR will review your appeal.
          </p>
          <textarea
            autoFocus
            rows={3}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="e.g. I was present but my biometric didn't register…"
            className="w-full px-3 py-2 rounded-xl border border-neutral-200 bg-neutral-50 text-sm focus:outline-none focus:ring-2 focus:ring-amber-400 focus:bg-white resize-none"
          />
          <div className="flex gap-2">
            <button
              onClick={() => {
                setMode(null);
                setReason("");
              }}
              className="flex-1 py-2 rounded-xl border border-neutral-200 text-sm text-neutral-600 hover:bg-neutral-50"
            >
              Back
            </button>
            <button
              onClick={handleSubmitAppeal}
              disabled={!reason.trim() || loading}
              className="flex-1 py-2 rounded-xl bg-amber-500 text-white text-sm font-semibold hover:bg-amber-600 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              {loading ? "Submitting…" : "Submit Appeal"}
            </button>
          </div>
        </div>
      )}

      {/* Step 2b: Choose leave type */}
      {mode === "leave" && !leaveTypeId && !feedback && (
        <div className="flex flex-col gap-3">
          <p className="text-xs text-neutral-500">
            Deduct <strong>{daysCost} day(s)</strong> from:
          </p>
          <div className="flex flex-wrap gap-2">
            {leaveTypes.map((t) => (
              <button
                key={t.id}
                onClick={() => setLeaveTypeId(t.id)}
                className="flex-1 min-w-[110px] py-2.5 rounded-xl border-2 border-blue-200 bg-blue-50 text-blue-800 text-sm font-semibold hover:bg-blue-100 transition-colors"
              >
                {t.name === "Casual"
                  ? "🏖️"
                  : t.name === "Medical"
                    ? "🏥"
                    : "📄"}{" "}
                {t.name}
              </button>
            ))}
          </div>
          <button
            onClick={() => setMode(null)}
            className="py-2 rounded-xl border border-neutral-200 text-sm text-neutral-600 hover:bg-neutral-50"
          >
            Back
          </button>
        </div>
      )}

      {/* Step 2c: Leave reason */}
      {mode === "leave" && leaveTypeId && !feedback && (
        <div className="flex flex-col gap-3">
          <p className="text-xs text-neutral-500">
            Requesting{" "}
            <strong>
              {daysCost} {leaveTypes.find((t) => t.id === leaveTypeId)?.name}
            </strong>{" "}
            leave. Provide a reason:
          </p>
          <textarea
            autoFocus
            rows={3}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="e.g. Feeling unwell / family emergency…"
            className="w-full px-3 py-2 rounded-xl border border-neutral-200 bg-neutral-50 text-sm focus:outline-none focus:ring-2 focus:ring-blue-400 focus:bg-white resize-none"
          />
          <div className="flex gap-2">
            <button
              onClick={() => {
                setLeaveTypeId(null);
                setReason("");
              }}
              className="flex-1 py-2 rounded-xl border border-neutral-200 text-sm text-neutral-600 hover:bg-neutral-50"
            >
              Back
            </button>
            <button
              onClick={handleSubmitLeaveRequest}
              disabled={!reason.trim() || loading}
              className="flex-1 py-2 rounded-xl bg-blue-600 text-white text-sm font-semibold hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              {loading ? "Submitting…" : "Submit Request"}
            </button>
          </div>
        </div>
      )}
    </div>
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
  onDeductionPageChange,
}) {
  const paidHistory = salaryHistory?.paid || [];
  const deductionHistory = salaryHistory?.deductions || [];

  return (
    <SlideUp>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6 mb-8">
        <Card>
          <CardHeader>
            <h3 className="text-lg font-semibold text-neutral-900">
              Salary Breakdown (Current Month)
            </h3>
          </CardHeader>
          <CardBody className="space-y-4">
            <div className="flex justify-between items-center">
              <span className="text-neutral-600">Base Salary</span>
              <span className="font-semibold">
                PKR {stats?.monthly_salary?.toLocaleString()}
              </span>
            </div>
            <div className="flex justify-between items-center text-error">
              <span className="text-neutral-600">Deductions</span>
              <span className="font-semibold">
                PKR{" "}
                {Number(stats?.deductions).toLocaleString("en-PK", {
                  minimumFractionDigits: 0,
                  maximumFractionDigits: 0,
                })}
              </span>
            </div>
            <hr />
            <div className="flex justify-between items-center text-lg font-bold text-primary-600">
              <span>Net Payable</span>
              <span>
                PKR{" "}
                {Number(stats?.total_salary).toLocaleString("en-PK", {
                  minimumFractionDigits: 0,
                  maximumFractionDigits: 0,
                })}
              </span>
            </div>
          </CardBody>
        </Card>

        <Card>
          <CardHeader>
            <h3 className="text-lg font-semibold text-neutral-900">
              Leave Summary
            </h3>
          </CardHeader>
          <CardBody className="space-y-4">
            <div className="flex justify-between items-center">
              <span className="text-neutral-600">Total Leaves</span>
              <span className="font-semibold">
                {stats?.leave_bank || "0"} days
              </span>
            </div>
            <div className="flex justify-between items-center text-success">
              <span className="text-neutral-600">Leaves Used</span>
              <span className="font-semibold">
                {stats?.paid_leaves_used || "0"} days
              </span>
            </div>
            <hr />
            <div className="flex justify-between items-center font-bold text-info">
              <span>Remaining</span>
              <span>{stats?.remaining_leaves || "0"} days</span>
            </div>
          </CardBody>
        </Card>
      </div>

      <div className="space-y-6">
        {/* Paid Salary History */}
        <Card>
          <CardHeader>
            <h3 className="text-lg font-semibold text-neutral-900">
              Paid Salary History
            </h3>
          </CardHeader>
          <CardBody>
            <AttendanceFilters
              onFilterChange={onPaidFilterChange}
              showCategory={false}
            />
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
                        <td className="py-3">
                          {new Date(s.date).toLocaleDateString()}
                        </td>
                        <td className="py-3">
                          PKR {s.payable_salary?.toLocaleString()}
                        </td>
                        <td className="py-3 text-error">
                          -PKR {s.deduction?.toLocaleString()}
                        </td>
                        <td className="py-3 font-semibold text-success">
                          PKR {s.paid_salary?.toLocaleString()}
                        </td>
                        <td className="py-3 text-right">
                          <PayslipPDFButton
                            employeeName="Employee Payslip"
                            salaryData={{
                              monthly_salary: s.payable_salary + s.deduction,
                              deductions: s.deduction,
                              total_salary: s.paid_salary,
                              date: s.date,
                            }}
                          />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <div className="text-center py-8 text-neutral-500">
                No payment history found
              </div>
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
            <h3 className="text-lg font-semibold text-neutral-900">
              Salary Deduction History
            </h3>
          </CardHeader>
          <CardBody>
            <AttendanceFilters
              onFilterChange={onDeductionFilterChange}
              excludeCategories={["present"]}
            />
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
                        <td className="py-3">
                          {new Date(d.date).toLocaleDateString()}
                        </td>
                        <td className="py-3 font-semibold text-error">
                          PKR{" "}
                          {Number(d.amount).toLocaleString("en-PK", {
                            minimumFractionDigits: 0,
                            maximumFractionDigits: 0,
                          })}
                        </td>
                        <td className="py-3 capitalize">{d.type}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <div className="text-center py-8 text-neutral-500">
                No deduction history found
              </div>
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

// Appeals Tab Component
function DisputesTab({
  disputes,
  loading,
  pagination,
  onFilterChange,
  onPageChange,
  onNewDispute,
}) {
  return (
    <SlideUp>
      <AttendanceFilters onFilterChange={onFilterChange} />
      <Card>
        <CardHeader className="flex justify-between items-center">
          <h3 className="text-lg font-semibold text-neutral-900">Appeals</h3>
          <Button size="sm" variant="primary" onClick={onNewDispute}>
            <Plus size={16} />
            File New Appeal
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
                      <p className="font-semibold text-neutral-900 capitalize">
                        {dispute.category}
                      </p>
                      <p className="text-sm text-neutral-600">
                        {dispute.description}
                      </p>
                      <p className="text-xs text-neutral-500 mt-2">
                        {new Date(dispute.dispute_date).toLocaleDateString()}
                      </p>
                    </div>
                    <div className="flex flex-col items-end gap-2">
                      <Badge
                        variant={
                          dispute.status === "approved"
                            ? "success"
                            : dispute.status === "rejected"
                              ? "danger"
                              : "warning"
                        }
                      >
                        {dispute.status}
                      </Badge>
                      <div className="flex gap-1">
                        <div
                          className={`w-4 h-4 rounded-full border border-white flex items-center justify-center text-[8px] font-bold ${
                            dispute.lead_status === "approved"
                              ? "bg-green-500 text-white"
                              : dispute.lead_status === "rejected"
                                ? "bg-red-500 text-white"
                                : "bg-neutral-200 text-neutral-600"
                          }`}
                          title="Lead Approval"
                        >
                          L
                        </div>
                        <div
                          className={`w-4 h-4 rounded-full border border-white flex items-center justify-center text-[8px] font-bold ${
                            dispute.admin_status === "approved"
                              ? "bg-blue-500 text-white"
                              : dispute.admin_status === "rejected"
                                ? "bg-red-500 text-white"
                                : "bg-neutral-200 text-neutral-600"
                          }`}
                          title="Admin Approval"
                        >
                          A
                        </div>
                      </div>
                    </div>
                  </div>
                </motion.div>
              ))}
            </div>
          ) : (
            <div className="text-center py-12">
              <AlertCircle
                size={48}
                className="mx-auto text-neutral-300 mb-4"
              />
              <p className="text-neutral-600">No appeals filed</p>
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

export default EmployeeDashboard;
