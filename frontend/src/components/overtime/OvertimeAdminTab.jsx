import React, { useState, useEffect, useCallback } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Clock, CheckCircle, XCircle } from "lucide-react";
import { SlideUp } from "../animations";
import { Card, CardHeader, CardBody } from "../common/Card";
import { Badge } from "../common/Badge";
import { Button } from "../common/Button";
import { Modal } from "../common/Modal";
import api from "../../services/api";

const STATUS_FILTERS = [
  { value: "all", label: "All" },
  { value: "pending", label: "Pending" },
  { value: "approved", label: "Approved" },
  { value: "paid", label: "Paid" },
  { value: "rejected", label: "Rejected" },
  { value: "cancelled", label: "Cancelled" },
];

const statusBadge = {
  pending: { label: "Pending", variant: "warning" },
  approved: { label: "Approved", variant: "success" },
  paid: { label: "Paid", variant: "success" },
  rejected: { label: "Rejected", variant: "error" },
  cancelled: { label: "Cancelled", variant: "error" },
};

export const OvertimeAdminTab = ({ user }) => {
  const [currentMonth, setCurrentMonth] = useState(() => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
  });
  const [statusFilter, setStatusFilter] = useState("all");
  const [requests, setRequests] = useState([]);
  const [loading, setLoading] = useState(false);
  const [summary, setSummary] = useState(null);
  const [selectedRequest, setSelectedRequest] = useState(null);
  const [showDetail, setShowDetail] = useState(false);
  const [approveMultiplier, setApproveMultiplier] = useState(1.5);
  const [rejectReason, setRejectReason] = useState("");
  const [actionLoading, setActionLoading] = useState(false);

  const fetchData = useCallback(async () => {
    setLoading(true);
    try {
      const [reqRes, sumRes] = await Promise.all([
        api.getAllOvertimeRequests({
          month: currentMonth,
          status: statusFilter !== "all" ? statusFilter : undefined,
        }),
        api.getOvertimeSummary(currentMonth),
      ]);
      setRequests(reqRes.data?.records || []);
      setSummary(sumRes.data?.summary || null);
    } catch (err) {
      console.error("Failed to fetch overtime data:", err);
    } finally {
      setLoading(false);
    }
  }, [currentMonth, statusFilter]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  const handleApprove = async (id) => {
    if (!window.confirm("Approve this overtime request?")) return;
    setActionLoading(true);
    try {
      await api.approveOvertimeRequest(id, user?.user_id, approveMultiplier);
      setShowDetail(false);
      setSelectedRequest(null);
      fetchData();
    } catch (err) {
      console.error("Failed to approve:", err);
    } finally {
      setActionLoading(false);
    }
  };

  const handleReject = async (id) => {
    if (!window.confirm("Reject this overtime request?")) return;
    setActionLoading(true);
    try {
      await api.rejectOvertimeRequest(id, user?.user_id, rejectReason);
      setShowDetail(false);
      setSelectedRequest(null);
      setRejectReason("");
      fetchData();
    } catch (err) {
      console.error("Failed to reject:", err);
    } finally {
      setActionLoading(false);
    }
  };

  const openDetail = (req) => {
    setSelectedRequest(req);
    setApproveMultiplier(req.multiplier || 1.5);
    setRejectReason("");
    setShowDetail(true);
  };

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
      {/* Filters */}
      <div className="flex flex-wrap gap-3 mb-6">
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
        <div className="flex items-center gap-2">
          {STATUS_FILTERS.map((f) => (
            <button
              key={f.value}
              onClick={() => setStatusFilter(f.value)}
              className={`text-xs px-3 py-1.5 rounded-full border transition-colors ${
                statusFilter === f.value
                  ? "bg-primary-50 border-primary-500 text-primary-700"
                  : "bg-white border-neutral-200 text-neutral-600 hover:border-neutral-400"
              }`}
            >
              {f.label}
            </button>
          ))}
        </div>
      </div>

      {/* Summary Cards */}
      {summary && (
        <div className="grid grid-cols-1 md:grid-cols-5 gap-4 mb-6">
          <div className="bg-white border border-neutral-200 rounded-xl p-4">
            <p className="text-xs text-neutral-500">Total Requests</p>
            <p className="text-2xl font-bold text-neutral-900">{summary.totalRequests}</p>
          </div>
          <div className="bg-white border border-neutral-200 rounded-xl p-4">
            <p className="text-xs text-neutral-500">Pending</p>
            <p className="text-2xl font-bold text-yellow-600">{summary.pendingCount}</p>
          </div>
          <div className="bg-white border border-neutral-200 rounded-xl p-4">
            <p className="text-xs text-neutral-500">Approved</p>
            <p className="text-2xl font-bold text-green-600">{summary.approvedCount}</p>
          </div>
          <div className="bg-white border border-neutral-200 rounded-xl p-4">
            <p className="text-xs text-neutral-500">OT Hours</p>
            <p className="text-2xl font-bold text-blue-600">{summary.approvedHours?.toFixed(1)}</p>
          </div>
          <div className="bg-white border border-neutral-200 rounded-xl p-4">
            <p className="text-xs text-neutral-500">Total OT Pay</p>
            <p className="text-2xl font-bold text-green-600">PKR {summary.approvedPay?.toLocaleString()}</p>
          </div>
        </div>
      )}

      {/* Requests Table */}
      <Card>
        <CardHeader>
          <h3 className="text-lg font-semibold text-neutral-900">Overtime Requests</h3>
        </CardHeader>
        <CardBody>
          {loading ? (
            <div className="text-center py-8">Loading...</div>
          ) : requests.length === 0 ? (
            <div className="text-center py-12 text-neutral-400">
              <Clock size={40} className="mx-auto mb-3 opacity-40" />
              <p>No overtime requests found</p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead>
                  <tr>
                    <th>Employee</th>
                    <th>Date</th>
                    <th>Day</th>
                    <th>Type</th>
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
                      <td>
                        <p className="font-medium">{req.user?.name}</p>
                        <p className="text-xs text-neutral-500">ID: {req.user_id}</p>
                      </td>
                      <td>{formatDate(req.date)}</td>
                      <td className="text-xs text-neutral-500">{dayName(req.date)}</td>
                      <td>
                        {req.is_holiday ? (
                          <Badge variant="warning">{req.holiday_name || "Holiday"}</Badge>
                        ) : (
                          <Badge variant="primary">Weekend</Badge>
                        )}
                      </td>
                      <td>{req.hours_worked}h</td>
                      <td>{req.hourly_rate ? `PKR ${req.hourly_rate}` : "-"}</td>
                      <td className="font-medium">
                        {req.overtime_pay ? `PKR ${req.overtime_pay.toLocaleString()}` : "-"}
                      </td>
                      <td>
                        <Badge variant={statusBadge[req.status]?.variant || "warning"}>
                          {statusBadge[req.status]?.label || req.status}
                        </Badge>
                      </td>
                      <td>
                        <button
                          onClick={() => openDetail(req)}
                          className="text-xs text-primary-600 hover:text-primary-800 underline"
                        >
                          {req.status === "pending" ? "Review" : "View"}
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardBody>
      </Card>

      {/* Detail / Approve Modal */}
      <AnimatePresence>
        {showDetail && selectedRequest && (
          <Modal
            isOpen={showDetail}
            onClose={() => setShowDetail(false)}
            title="Overtime Request Detail"
            size="md"
          >
            <div className="space-y-4">
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <p className="text-xs text-neutral-500">Employee</p>
                  <p className="font-medium">{selectedRequest.user?.name}</p>
                </div>
                <div>
                  <p className="text-xs text-neutral-500">Date</p>
                  <p className="font-medium">
                    {formatDate(selectedRequest.date)} ({dayName(selectedRequest.date)})
                  </p>
                </div>
                <div>
                  <p className="text-xs text-neutral-500">Type</p>
                  <p>{selectedRequest.is_holiday ? selectedRequest.holiday_name || "Holiday" : "Weekend"}</p>
                </div>
                <div>
                  <p className="text-xs text-neutral-500">Status</p>
                  <Badge variant={statusBadge[selectedRequest.status]?.variant}>
                    {statusBadge[selectedRequest.status]?.label}
                  </Badge>
                </div>
                <div>
                  <p className="text-xs text-neutral-500">Hours Worked</p>
                  <p className="font-medium">{selectedRequest.hours_worked}h</p>
                </div>
                <div>
                  <p className="text-xs text-neutral-500">Monthly Salary</p>
                  <p className="font-medium">PKR {selectedRequest.user?.monthly_salary?.toLocaleString()}</p>
                </div>
                <div>
                  <p className="text-xs text-neutral-500">Hourly Rate</p>
                  <p className="font-medium">{selectedRequest.hourly_rate ? `PKR ${selectedRequest.hourly_rate}` : "Pending calculation"}</p>
                </div>
                <div>
                  <p className="text-xs text-neutral-500">Estimated OT Pay</p>
                  <p className="font-medium">{selectedRequest.overtime_pay ? `PKR ${selectedRequest.overtime_pay.toLocaleString()}` : "Pending calculation"}</p>
                </div>
              </div>

              {selectedRequest.reason && (
                <div>
                  <p className="text-xs text-neutral-500 mb-1">Reason</p>
                  <p className="text-sm bg-neutral-50 p-3 rounded-lg">{selectedRequest.reason}</p>
                </div>
              )}

              {selectedRequest.rejection_reason && (
                <div>
                  <p className="text-xs text-red-500 mb-1">Rejection Reason</p>
                  <p className="text-sm bg-red-50 p-3 rounded-lg text-red-700">{selectedRequest.rejection_reason}</p>
                </div>
              )}

              {selectedRequest.approver && (
                <div className="text-xs text-neutral-500">
                  {selectedRequest.approved_at && (
                    <p>Reviewed by {selectedRequest.approver.name} on {formatDate(selectedRequest.approved_at)}</p>
                  )}
                </div>
              )}

              {/* Approval actions */}
              {selectedRequest.status === "pending" && (
                <div className="border-t border-neutral-200 pt-4 space-y-4">
                  <div>
                    <label className="block text-sm font-medium text-neutral-700 mb-1">
                      Multiplier (default 1.5x)
                    </label>
                    <input
                      type="number"
                      min="1"
                      max="3"
                      step="0.25"
                      value={approveMultiplier}
                      onChange={(e) => setApproveMultiplier(parseFloat(e.target.value) || 1.5)}
                      className="w-24 px-3 py-2 border border-neutral-300 rounded-lg text-sm"
                    />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-neutral-700 mb-1">
                      Rejection Reason (if rejecting)
                    </label>
                    <textarea
                      value={rejectReason}
                      onChange={(e) => setRejectReason(e.target.value)}
                      placeholder="Optional reason for rejection..."
                      rows={2}
                      className="w-full px-3 py-2 border border-neutral-300 rounded-lg text-sm resize-none"
                    />
                  </div>
                  <div className="flex justify-end gap-3">
                    <Button
                      variant="danger"
                      size="sm"
                      onClick={() => handleReject(selectedRequest.id)}
                      disabled={actionLoading}
                    >
                      <XCircle size={14} className="mr-1" /> Reject
                    </Button>
                    <Button
                      variant="primary"
                      size="sm"
                      onClick={() => handleApprove(selectedRequest.id)}
                      disabled={actionLoading}
                    >
                      <CheckCircle size={14} className="mr-1" /> Approve
                    </Button>
                  </div>
                </div>
              )}
            </div>
          </Modal>
        )}
      </AnimatePresence>
    </SlideUp>
  );
};

export default OvertimeAdminTab;
