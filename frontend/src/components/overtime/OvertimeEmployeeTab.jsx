import React, { useState, useEffect, useCallback } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Clock, Plus, X, AlertCircle, CheckCircle, Ban } from "lucide-react";
import { SlideUp, FadeIn } from "../animations";
import { Card, CardHeader, CardBody } from "../common/Card";
import { Badge } from "../common/Badge";
import { Button } from "../common/Button";
import { Modal } from "../common/Modal";
import api from "../../services/api";

const statusBadge = {
  pending: { label: "Pending", variant: "warning" },
  approved: { label: "Approved", variant: "success" },
  paid: { label: "Paid", variant: "success" },
  rejected: { label: "Rejected", variant: "error" },
  cancelled: { label: "Cancelled", variant: "error" },
};

export const OvertimeEmployeeTab = ({ user }) => {
  const [currentMonth, setCurrentMonth] = useState(() => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
  });
  const [requests, setRequests] = useState([]);
  const [loading, setLoading] = useState(false);
  const [eligibleDates, setEligibleDates] = useState([]);
  const [showForm, setShowForm] = useState(false);
  const [formData, setFormData] = useState({ date: "", hours_worked: "", reason: "" });
  const [formError, setFormError] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const fetchRequests = useCallback(async () => {
    if (!user?.user_id) return;
    setLoading(true);
    try {
      const res = await api.getMyOvertimeRequests(user.user_id, currentMonth);
      setRequests(res.data || []);
    } catch (err) {
      console.error("Failed to fetch overtime requests:", err);
    } finally {
      setLoading(false);
    }
  }, [user, currentMonth]);

  const fetchEligibleDates = useCallback(async () => {
    if (!user?.user_id) return;
    try {
      const res = await api.getEligibleOvertimeDates(currentMonth, user.user_id);
      setEligibleDates(res.data || []);
    } catch (err) {
      console.error("Failed to fetch eligible dates:", err);
    }
  }, [user, currentMonth]);

  useEffect(() => {
    fetchRequests();
    fetchEligibleDates();
  }, [fetchRequests, fetchEligibleDates]);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setFormError("");

    if (!formData.date || !formData.hours_worked) {
      setFormError("Date and hours are required");
      return;
    }

    const hours = parseFloat(formData.hours_worked);
    if (isNaN(hours) || hours <= 0 || hours > 24) {
      setFormError("Hours must be between 1 and 24");
      return;
    }

    setSubmitting(true);
    try {
      await api.createOvertimeRequest({
        user_id: user.user_id,
        date: formData.date,
        hours_worked: hours,
        reason: formData.reason,
      });
      setShowForm(false);
      setFormData({ date: "", hours_worked: "", reason: "" });
      fetchRequests();
      fetchEligibleDates();
    } catch (err) {
      setFormError(err.response?.data?.error || "Failed to create request");
    } finally {
      setSubmitting(false);
    }
  };

  const handleCancel = async (id) => {
    if (!window.confirm("Cancel this overtime request?")) return;
    try {
      await api.cancelOvertimeRequest(id, user.user_id);
      fetchRequests();
      fetchEligibleDates();
    } catch (err) {
      console.error("Failed to cancel:", err);
    }
  };

  const totalPending = requests.filter((r) => r.status === "pending").length;
  const totalApproved = requests.filter((r) => r.status === "approved" || r.status === "paid").length;
  const totalOtHours = requests
    .filter((r) => r.status === "approved" || r.status === "paid")
    .reduce((sum, r) => sum + r.hours_worked, 0);
  const totalOtPay = requests
    .filter((r) => r.status === "approved" || r.status === "paid")
    .reduce((sum, r) => sum + (r.overtime_pay || 0), 0);

  const formatDate = (d) => {
    const date = new Date(d);
    return date.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });
  };

  const dayName = (d) => {
    const date = new Date(d);
    return date.toLocaleDateString("en-US", { weekday: "long" });
  };

  return (
    <SlideUp>
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-3 bg-white border border-gray-400 rounded-lg px-4 py-3">
          <span className="text-xs text-neutral-400 whitespace-nowrap">Month</span>
          <div className="w-px h-6 bg-neutral-100 shrink-0" />
          <input
            type="month"
            value={currentMonth}
            onChange={(e) => setCurrentMonth(e.target.value)}
            className="flex-1 min-w-0 text-sm text-neutral-800 bg-transparent border-none outline-none cursor-pointer"
          />
        </div>
        {eligibleDates.length > 0 && (
          <Button variant="primary" size="sm" onClick={() => setShowForm(true)}>
            <Plus size={16} className="mr-1" /> Request Overtime
          </Button>
        )}
      </div>

      {/* Summary Cards */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4 mb-6">
        <div className="bg-white border border-neutral-200 rounded-xl p-4">
          <p className="text-xs text-neutral-500">Requests</p>
          <p className="text-2xl font-bold text-neutral-900">{requests.length}</p>
        </div>
        <div className="bg-white border border-neutral-200 rounded-xl p-4">
          <p className="text-xs text-neutral-500">Pending</p>
          <p className="text-2xl font-bold text-yellow-600">{totalPending}</p>
        </div>
        <div className="bg-white border border-neutral-200 rounded-xl p-4">
          <p className="text-xs text-neutral-500">OT Hours</p>
          <p className="text-2xl font-bold text-blue-600">{totalOtHours.toFixed(1)}</p>
        </div>
        <div className="bg-white border border-neutral-200 rounded-xl p-4">
          <p className="text-xs text-neutral-500">OT Pay</p>
          <p className="text-2xl font-bold text-green-600">PKR {totalOtPay.toLocaleString()}</p>
        </div>
      </div>

      {/* Requests Table */}
      <Card>
        <CardHeader>
          <h3 className="text-lg font-semibold text-neutral-900">My Overtime Requests</h3>
        </CardHeader>
        <CardBody>
          {loading ? (
            <div className="text-center py-8">Loading...</div>
          ) : requests.length === 0 ? (
            <div className="text-center py-12 text-neutral-400">
              <Clock size={40} className="mx-auto mb-3 opacity-40" />
              <p>No overtime requests for this month</p>
              {eligibleDates.length > 0 && (
                <Button variant="primary" size="sm" className="mt-3" onClick={() => setShowForm(true)}>
                  Request Overtime
                </Button>
              )}
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead>
                  <tr>
                    <th>Date</th>
                    <th>Day</th>
                    <th>Hours</th>
                    <th>Rate</th>
                    <th>Pay</th>
                    <th>Status</th>
                    <th>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {requests.map((req) => (
                    <tr key={req.id}>
                      <td>{formatDate(req.date)}</td>
                      <td className="text-xs text-neutral-500">{dayName(req.date)}</td>
                      <td>{req.hours_worked}h</td>
                      <td>{req.hourly_rate ? `PKR ${req.hourly_rate}` : "-"}</td>
                      <td className="font-medium">{req.overtime_pay ? `PKR ${req.overtime_pay.toLocaleString()}` : "-"}</td>
                      <td>
                        <Badge variant={statusBadge[req.status]?.variant || "warning"}>
                          {statusBadge[req.status]?.label || req.status}
                        </Badge>
                      </td>
                      <td>
                        {req.status === "pending" && (
                          <button
                            onClick={() => handleCancel(req.id)}
                            className="text-xs text-red-500 hover:text-red-700 underline"
                          >
                            Cancel
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardBody>
      </Card>

      {/* Request Form Modal */}
      <AnimatePresence>
        {showForm && (
          <Modal isOpen={showForm} onClose={() => setShowForm(false)} title="Request Overtime" size="md">
            <form onSubmit={handleSubmit} className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-neutral-700 mb-1">Select Date</label>
                <div className="grid grid-cols-2 gap-2 max-h-48 overflow-y-auto">
                  {eligibleDates.map((dateStr) => {
                    const d = new Date(dateStr);
                    const display = d.toLocaleDateString("en-GB", {
                      weekday: "short", day: "2-digit", month: "short"
                    });
                    return (
                      <button
                        type="button"
                        key={dateStr}
                        onClick={() => setFormData({ ...formData, date: dateStr })}
                        className={`text-left px-3 py-2 rounded-lg border text-sm transition-colors ${
                          formData.date === dateStr
                            ? "bg-primary-50 border-primary-500 text-primary-700"
                            : "bg-white border-neutral-200 text-neutral-700 hover:border-neutral-400"
                        }`}
                      >
                        {display}
                      </button>
                    );
                  })}
                </div>
              </div>

              <div>
                <label className="block text-sm font-medium text-neutral-700 mb-1">
                  Hours Worked
                </label>
                <input
                  type="number"
                  min="1"
                  max="24"
                  step="0.5"
                  value={formData.hours_worked}
                  onChange={(e) => setFormData({ ...formData, hours_worked: e.target.value })}
                  placeholder="e.g., 8"
                  className="w-full px-3 py-2 border border-neutral-300 rounded-lg text-sm focus:ring-2 focus:ring-primary-500 focus:border-primary-500 outline-none"
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-neutral-700 mb-1">
                  Reason (optional)
                </label>
                <textarea
                  value={formData.reason}
                  onChange={(e) => setFormData({ ...formData, reason: e.target.value })}
                  placeholder="Why was overtime needed?"
                  rows={3}
                  className="w-full px-3 py-2 border border-neutral-300 rounded-lg text-sm focus:ring-2 focus:ring-primary-500 focus:border-primary-500 outline-none resize-none"
                />
              </div>

              {formError && (
                <div className="flex items-center gap-2 text-red-600 text-sm bg-red-50 px-3 py-2 rounded-lg">
                  <AlertCircle size={14} />
                  {formError}
                </div>
              )}

              <div className="flex justify-end gap-3 pt-2">
                <Button variant="ghost" type="button" onClick={() => setShowForm(false)}>
                  Cancel
                </Button>
                <Button variant="primary" type="submit" disabled={submitting}>
                  {submitting ? "Submitting..." : "Submit Request"}
                </Button>
              </div>
            </form>
          </Modal>
        )}
      </AnimatePresence>
    </SlideUp>
  );
};

export default OvertimeEmployeeTab;
