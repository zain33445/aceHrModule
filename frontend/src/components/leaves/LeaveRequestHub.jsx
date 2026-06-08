import React, { useState, useEffect, useCallback } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  PlaneTakeoff,
  Plus,
  Check,
  X,
  Wallet,
  Clock,
  Ban,
  ChevronDown,
  Activity,
  BookOpen,
  Stethoscope,
  HelpCircle,
} from "lucide-react";
import api from "../../services/api";

// ─── Helpers ────────────────────────────────────────────────────────────────
const generateIdempotencyKey = () =>
  `LR-${Date.now()}-${Math.random().toString(36).slice(2, 9).toUpperCase()}`;

const statusConfig = {
  PENDING: {
    label: "Pending",
    bg: "bg-amber-100",
    text: "text-amber-800",
    icon: Clock,
  },
  APPROVED: {
    label: "Approved",
    bg: "bg-green-100",
    text: "text-green-800",
    icon: Check,
  },
  REJECTED: {
    label: "Rejected",
    bg: "bg-red-100",
    text: "text-red-800",
    icon: X,
  },
  CANCELLED: {
    label: "Cancelled",
    bg: "bg-neutral-100",
    text: "text-neutral-500",
    icon: Ban,
  },
};

const leaveTypeIcons = {
  Casual: Activity,
  Medical: Stethoscope,
  Legacy: BookOpen,
};
const LeaveTypeIcon = ({ name }) => {
  const Icon = leaveTypeIcons[name] || HelpCircle;
  return <Icon size={14} />;
};

// ─── Balance Card ────────────────────────────────────────────────────────────
const BalanceCard = ({ name, available_balance, is_paid }) => {
  const balance = parseFloat(available_balance);
  const color =
    balance <= 0
      ? "text-red-500"
      : balance <= 2
        ? "text-amber-500"
        : "text-emerald-500";
  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      className="flex flex-col items-center justify-center gap-1 bg-white border border-neutral-200 rounded-xl p-4 shadow-sm min-w-[110px]"
    >
      <div className="flex items-center gap-1.5 text-neutral-400 text-xs font-medium mb-1">
        <LeaveTypeIcon name={name} />
        <span>{name}</span>
      </div>
      <span className={`text-2xl font-bold tracking-tight ${color}`}>
        {balance.toFixed(1)}
      </span>
      <span className="text-[11px] text-neutral-400">days left</span>
      {is_paid && (
        <span className="text-[10px] px-1.5 py-0.5 bg-green-50 text-green-500 rounded-full mt-1">
          PAID
        </span>
      )}
    </motion.div>
  );
};

// ─── Request Card ────────────────────────────────────────────────────────────
const RequestCard = ({ req, isAdmin, onStatusChange }) => {
  const cfg = statusConfig[req.status] || statusConfig.PENDING;
  const Icon = cfg.icon;
  const daysText =
    parseFloat(req.days_consumed) === 0.5
      ? "½ day"
      : `${parseFloat(req.days_consumed)} day(s)`;

  return (
    <motion.div
      layout
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, scale: 0.97 }}
      className="bg-white border border-neutral-200 rounded-xl p-5 shadow-sm hover:shadow-md transition-shadow"
    >
      <div className="flex flex-col md:flex-row justify-between items-start gap-4">
        <div className="flex-1 space-y-2">
          {/* Header row */}
          <div className="flex flex-wrap items-center gap-2">
            <span
              className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-semibold ${cfg.bg} ${cfg.text}`}
            >
              <Icon size={12} />
              {cfg.label}
            </span>
            {req.leave_type && (
              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs bg-blue-50 text-blue-700 border border-blue-100">
                <LeaveTypeIcon name={req.leave_type.name} />
                {req.leave_type.name}
              </span>
            )}
            <span className="text-xs text-neutral-400">{daysText}</span>
            {req.is_half_day && (
              <span className="px-2 py-0.5 rounded-full text-xs bg-purple-50 text-purple-600 border border-purple-100">
                Half Day · {req.half_day_session || "—"}
              </span>
            )}
          </div>

          {/* Employee name (admin view) */}
          {isAdmin && req.user && (
            <p className="font-semibold text-neutral-800">{req.user.name}</p>
          )}

          {/* Dates */}
          <p className="text-sm text-neutral-500">
            <span className="font-medium text-neutral-700">
              {new Date(req.start_date).toLocaleDateString("en-GB", {
                day: "2-digit",
                month: "short",
                year: "numeric",
              })}
            </span>
            {" → "}
            <span className="font-medium text-neutral-700">
              {new Date(req.end_date).toLocaleDateString("en-GB", {
                day: "2-digit",
                month: "short",
                year: "numeric",
              })}
            </span>
          </p>

          {/* Reason */}
          <p className="text-sm text-neutral-600 bg-neutral-50 rounded-lg px-3 py-2 border border-neutral-100">
            {req.reason}
          </p>

          {/* Reviewed by */}
          {req.reviewer && (
            <p className="text-xs text-neutral-400">
              Reviewed by{" "}
              <span className="font-medium text-neutral-600">
                {req.reviewer.name}
              </span>
            </p>
          )}
        </div>

        {/* Admin action buttons */}
        {isAdmin && req.status === "PENDING" && (
          <div className="flex gap-2 w-full md:w-auto mt-2 md:mt-0 flex-shrink-0">
            <button
              onClick={() => onStatusChange(req.id, "REJECTED")}
              className="flex-1 md:flex-none flex items-center justify-center gap-1.5 px-4 py-2 rounded-lg text-sm font-medium border border-red-200 text-red-600 hover:bg-red-50 transition-colors"
            >
              <X size={14} /> Reject
            </button>
            <button
              onClick={() => onStatusChange(req.id, "APPROVED")}
              className="flex-1 md:flex-none flex items-center justify-center gap-1.5 px-4 py-2 rounded-lg text-sm font-medium bg-emerald-600 text-white hover:bg-emerald-700 transition-colors"
            >
              <Check size={14} /> Approve
            </button>
          </div>
        )}
      </div>
    </motion.div>
  );
};

// ─── Main Component ──────────────────────────────────────────────────────────
export const LeaveRequestHub = ({ user, isAdmin = false }) => {
  const [requests, setRequests] = useState([]);
  const [leaveTypes, setLeaveTypes] = useState([]);
  const [balances, setBalances] = useState([]);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [showModal, setShowModal] = useState(false);
  const [filterStatus, setFilterStatus] = useState("all");
  const [error, setError] = useState("");
  const [successMsg, setSuccessMsg] = useState("");

  const [form, setForm] = useState({
    leave_type_id: "",
    start_date: "",
    end_date: "",
    reason: "",
    is_half_day: false,
    half_day_session: "morning",
  });

  // Fetch leave types once
  useEffect(() => {
    api
      .getLeaveTypes()
      .then((r) => {
        const active = r.data.filter((t) => t.name !== "Legacy");
        setLeaveTypes(active);
        if (active.length > 0)
          setForm((f) => ({ ...f, leave_type_id: String(active[0].id) }));
      })
      .catch(console.error);
  }, []);

  // Fetch balance (employee only)
  const fetchBalance = useCallback(async () => {
    if (!isAdmin && user?.user_id) {
      try {
        const res = await api.getLeaveBalance(user.user_id);
        // Filter out Legacy type from balance display
        setBalances(res.data.filter((b) => b.name !== "Legacy"));
      } catch (e) {
        console.error(e);
      }
    }
  }, [isAdmin, user?.user_id]);

  // Fetch requests
  const fetchRequests = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.getLeaveRequests(
        isAdmin ? undefined : user?.user_id,
        filterStatus === "all" ? undefined : filterStatus,
      );
      setRequests(res.data);
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  }, [filterStatus, isAdmin, user?.user_id]);

  useEffect(() => {
    fetchRequests();
    fetchBalance();
  }, [fetchRequests, fetchBalance]);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError("");
    setSubmitting(true);

    // Validate date order
    if (new Date(form.end_date) < new Date(form.start_date)) {
      setError("End date cannot be before start date.");
      setSubmitting(false);
      return;
    }

    // Check available balance for the selected type
    const selectedBalance = balances.find(
      (b) => String(b.leave_type_id) === String(form.leave_type_id),
    );
    const available = selectedBalance
      ? parseFloat(selectedBalance.available_balance)
      : null;
    const start = new Date(form.start_date);
    const end = new Date(form.end_date);
    const diffDays = form.is_half_day
      ? 0.5
      : Math.ceil((end - start) / (1000 * 60 * 60 * 24)) + 1;

    if (available !== null && available < diffDays) {
      setError(
        `Insufficient balance. You have ${available.toFixed(1)} day(s) available but requested ${diffDays}.`,
      );
      setSubmitting(false);
      return;
    }

    try {
      await api.createLeaveRequest({
        ...form,
        user_id: user.user_id,
        leave_type_id: parseInt(form.leave_type_id),
        idempotency_key: generateIdempotencyKey(),
      });
      setShowModal(false);
      setForm((f) => ({
        ...f,
        start_date: "",
        end_date: "",
        reason: "",
        is_half_day: false,
      }));
      setSuccessMsg("Leave request submitted successfully!");
      setTimeout(() => setSuccessMsg(""), 4000);
      fetchRequests();
      fetchBalance();
    } catch (err) {
      const msg = err?.response?.data?.error || "Failed to submit request.";
      setError(msg);
    } finally {
      setSubmitting(false);
    }
  };

  const handleStatusChange = async (id, status) => {
    try {
      await api.updateLeaveRequestStatus(id, status, user.user_id);
      fetchRequests();
    } catch (err) {
      console.error("Failed to update status", err);
    }
  };

  // Selected type balance for display in form
  const selectedTypeBalance = balances.find(
    (b) => String(b.leave_type_id) === String(form.leave_type_id),
  );

  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      className="space-y-6"
    >
      {/* Header */}
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-end gap-4">
        <div>
          <h2 className="text-2xl font-bold tracking-tight text-neutral-900">
            Leave Requests
          </h2>
          <p className="text-neutral-500 mt-1 text-sm">
            {isAdmin
              ? "Review and manage employee leave requests."
              : "Request leave and track your application status."}
          </p>
        </div>
        <div className="flex items-center gap-3">
          {/* Filter */}
          <div className="relative">
            <select
              value={filterStatus}
              onChange={(e) => setFilterStatus(e.target.value)}
              className="appearance-none pl-3 pr-8 py-2 rounded-lg border border-neutral-200 bg-white text-sm text-neutral-700 focus:outline-none focus:ring-2 focus:ring-blue-500 cursor-pointer"
            >
              <option value="all">All Statuses</option>
              <option value="PENDING">Pending</option>
              <option value="APPROVED">Approved</option>
              <option value="REJECTED">Rejected</option>
              <option value="CANCELLED">Cancelled</option>
            </select>
            <ChevronDown
              size={14}
              className="absolute right-2.5 top-1/2 -translate-y-1/2 text-neutral-400 pointer-events-none"
            />
          </div>
          {!isAdmin && (
            <button
              onClick={() => {
                setShowModal(true);
                setError("");
              }}
              className="flex items-center gap-2 px-4 py-2 bg-blue-600 text-white rounded-lg text-sm font-medium hover:bg-blue-700 transition-colors shadow-sm"
            >
              <Plus size={16} /> Request Leave
            </button>
          )}
        </div>
      </div>

      {/* Balance Cards (employee only) */}
      {!isAdmin && balances.length > 0 && (
        <div className="flex flex-wrap gap-3">
          {balances.map((b) => (
            <BalanceCard key={b.leave_type_id} {...b} />
          ))}
        </div>
      )}

      {/* Success Banner */}
      <AnimatePresence>
        {successMsg && (
          <motion.div
            initial={{ opacity: 0, y: -8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
            className="flex items-center gap-2 px-4 py-3 bg-emerald-50 border border-emerald-200 rounded-xl text-emerald-700 text-sm font-medium"
          >
            <Check size={16} /> {successMsg}
          </motion.div>
        )}
      </AnimatePresence>

      {/* Requests List */}
      <div className="space-y-3">
        {loading ? (
          <div className="flex items-center justify-center h-32 text-neutral-400 text-sm">
            Loading requests…
          </div>
        ) : requests.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-40 bg-white border border-dashed border-neutral-200 rounded-xl gap-3">
            <PlaneTakeoff className="w-10 h-10 text-neutral-300" />
            <p className="text-neutral-400 text-sm">No leave requests found.</p>
          </div>
        ) : (
          <AnimatePresence mode="popLayout">
            {requests.map((req) => (
              <RequestCard
                key={req.id}
                req={req}
                isAdmin={isAdmin}
                onStatusChange={handleStatusChange}
              />
            ))}
          </AnimatePresence>
        )}
      </div>

      {/* Submit Modal */}
      <AnimatePresence>
        {showModal && !isAdmin && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 bg-black/40 backdrop-blur-sm z-50 flex items-center justify-center p-4"
            onClick={(e) => e.target === e.currentTarget && setShowModal(false)}
          >
            <motion.div
              initial={{ scale: 0.95, opacity: 0, y: 20 }}
              animate={{ scale: 1, opacity: 1, y: 0 }}
              exit={{ scale: 0.95, opacity: 0 }}
              className="bg-white rounded-2xl shadow-2xl w-full overflow-hidden"
            >
              {/* Modal Header */}
              <div className="px-6 py-4 border-b border-neutral-100 flex items-center justify-between">
                <div className="flex items-center gap-2.5">
                  <div className="w-8 h-8 rounded-lg bg-blue-100 flex items-center justify-center">
                    <PlaneTakeoff size={16} className="text-blue-600" />
                  </div>
                  <div>
                    <h3 className="font-semibold text-neutral-900">
                      Request Leave
                    </h3>
                    <p className="text-xs text-neutral-400">
                      Submit a new leave application
                    </p>
                  </div>
                </div>
                <button
                  onClick={() => setShowModal(false)}
                  className="w-8 h-8 flex items-center justify-center rounded-lg hover:bg-neutral-100 text-neutral-400 transition-colors"
                >
                  <X size={16} />
                </button>
              </div>

              <form onSubmit={handleSubmit} className="p-6 space-y-5">
                {/* Error */}
                <AnimatePresence>
                  {error && (
                    <motion.div
                      initial={{ opacity: 0, height: 0 }}
                      animate={{ opacity: 1, height: "auto" }}
                      exit={{ opacity: 0, height: 0 }}
                      className="flex items-start gap-2 px-4 py-3 bg-red-50 border border-red-200 rounded-xl text-red-700 text-sm"
                    >
                      <X size={14} className="mt-0.5 flex-shrink-0" />
                      <span>{error}</span>
                    </motion.div>
                  )}
                </AnimatePresence>

                {/* Leave Type */}
                <div>
                  <label className="block text-sm font-medium text-neutral-700 mb-1.5">
                    Leave Type
                  </label>
                  <div className="relative">
                    <select
                      value={form.leave_type_id}
                      onChange={(e) =>
                        setForm({ ...form, leave_type_id: e.target.value })
                      }
                      required
                      className="w-full appearance-none pl-3 pr-8 py-2.5 rounded-xl border border-neutral-200 bg-neutral-50 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:bg-white transition-colors"
                    >
                      {leaveTypes.map((t) => (
                        <option key={t.id} value={t.id}>
                          {t.name}
                        </option>
                      ))}
                    </select>
                    <ChevronDown
                      size={14}
                      className="absolute right-3 top-1/2 -translate-y-1/2 text-neutral-400 pointer-events-none"
                    />
                  </div>
                  {/* Available balance for selected type */}
                  {selectedTypeBalance && (
                    <p className="mt-1.5 text-xs text-neutral-500 flex items-center gap-1">
                      <Wallet size={11} />
                      Available:{" "}
                      <span
                        className={`font-semibold ml-0.5 ${parseFloat(selectedTypeBalance.available_balance) <= 0 ? "text-red-500" : "text-emerald-600"}`}
                      >
                        {parseFloat(
                          selectedTypeBalance.available_balance,
                        ).toFixed(1)}{" "}
                        days
                      </span>
                    </p>
                  )}
                </div>

                {/* Dates */}
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block text-sm font-medium text-neutral-700 mb-1.5">
                      Start Date
                    </label>
                    <input
                      type="date"
                      value={form.start_date}
                      onChange={(e) =>
                        setForm({ ...form, start_date: e.target.value })
                      }
                      required
                      className="w-full px-3 py-2.5 rounded-xl border border-neutral-200 bg-neutral-50 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:bg-white transition-colors"
                    />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-neutral-700 mb-1.5">
                      End Date
                    </label>
                    <input
                      type="date"
                      value={form.end_date}
                      onChange={(e) =>
                        setForm({ ...form, end_date: e.target.value })
                      }
                      required
                      min={form.start_date}
                      className="w-full px-3 py-2.5 rounded-xl border border-neutral-200 bg-neutral-50 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:bg-white transition-colors"
                    />
                  </div>
                </div>

                {/* Half Day Toggle */}
                <div>
                  <label className="flex items-center gap-3 cursor-pointer group">
                    <div
                      onClick={() =>
                        setForm((f) => ({ ...f, is_half_day: !f.is_half_day }))
                      }
                      className={`relative w-10 h-5 rounded-full transition-colors duration-200 ${form.is_half_day ? "bg-blue-600" : "bg-neutral-200"}`}
                    >
                      <span
                        className={`absolute top-0.5 left-0.5 w-4 h-4 bg-white rounded-full shadow transition-transform duration-200 ${form.is_half_day ? "translate-x-5" : ""}`}
                      />
                    </div>
                    <span className="text-sm font-medium text-neutral-700">
                      Half Day
                    </span>
                  </label>

                  <AnimatePresence>
                    {form.is_half_day && (
                      <motion.div
                        initial={{ opacity: 0, height: 0 }}
                        animate={{ opacity: 1, height: "auto" }}
                        exit={{ opacity: 0, height: 0 }}
                        className="mt-3"
                      >
                        <div className="flex gap-2">
                          {["morning", "afternoon"].map((session) => (
                            <button
                              key={session}
                              type="button"
                              onClick={() =>
                                setForm((f) => ({
                                  ...f,
                                  half_day_session: session,
                                }))
                              }
                              className={`flex-1 py-2 rounded-xl text-sm font-medium border transition-colors capitalize
                                ${
                                  form.half_day_session === session
                                    ? "bg-blue-600 text-white border-blue-600"
                                    : "bg-white text-neutral-600 border-neutral-200 hover:bg-neutral-50"
                                }`}
                            >
                              {session}
                            </button>
                          ))}
                        </div>
                      </motion.div>
                    )}
                  </AnimatePresence>
                </div>

                {/* Reason */}
                <div>
                  <label className="block text-sm font-medium text-neutral-700 mb-1.5">
                    Reason
                  </label>
                  <textarea
                    value={form.reason}
                    onChange={(e) =>
                      setForm({ ...form, reason: e.target.value })
                    }
                    required
                    rows={3}
                    placeholder="Briefly describe the reason for your leave request…"
                    className="w-full px-3 py-2.5 rounded-xl border border-neutral-200 bg-neutral-50 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:bg-white transition-colors resize-none"
                  />
                </div>

                {/* Actions */}
                <div className="flex gap-3 pt-2 border-t border-neutral-100">
                  <button
                    type="button"
                    onClick={() => setShowModal(false)}
                    className="flex-1 py-2.5 rounded-xl border border-neutral-200 text-sm font-medium text-neutral-600 hover:bg-neutral-50 transition-colors"
                  >
                    Cancel
                  </button>
                  <button
                    type="submit"
                    disabled={submitting}
                    className="flex-1 py-2.5 rounded-xl bg-blue-600 text-white text-sm font-medium hover:bg-blue-700 transition-colors disabled:opacity-60 disabled:cursor-not-allowed"
                  >
                    {submitting ? "Submitting…" : "Submit Request"}
                  </button>
                </div>
              </form>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  );
};
