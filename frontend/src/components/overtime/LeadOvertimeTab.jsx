import React, { useState, useEffect, useCallback } from "react";
import { AnimatePresence } from "framer-motion";
import { Clock, CheckCircle, XCircle, Users } from "lucide-react";
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
  { value: "rejected", label: "Rejected" },
];

const leadStatusBadge = {
  pending: { label: "Pending", variant: "warning" },
  approved: { label: "Lead Approved", variant: "success" },
  rejected: { label: "Lead Rejected", variant: "error" },
};

const adminStatusBadge = {
  pending: { label: "Pending Admin", variant: "neutral" },
  approved: { label: "Approved", variant: "success" },
  paid: { label: "Paid", variant: "success" },
  rejected: { label: "Rejected", variant: "error" },
  cancelled: { label: "Cancelled", variant: "error" },
};

export const LeadOvertimeTab = ({ user }) => {
  const [currentMonth, setCurrentMonth] = useState(() => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
  });
  const [statusFilter, setStatusFilter] = useState("all");
  const [requests, setRequests] = useState([]);
  const [loading, setLoading] = useState(false);
  const [selectedRequest, setSelectedRequest] = useState(null);
  const [showDetail, setShowDetail] = useState(false);
  const [remarks, setRemarks] = useState("");
  const [actionLoading, setActionLoading] = useState(false);

  const fetchData = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.getTeamOvertimeRequests(user.user_id, currentMonth, statusFilter);
      setRequests(res.data?.records || []);
    } catch (err) {
      console.error("Failed to fetch team overtime requests:", err);
    } finally {
      setLoading(false);
    }
  }, [user.user_id, currentMonth, statusFilter]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  const handleLeadApprove = async (id) => {
    setActionLoading(true);
    try {
      await api.leadApproveOvertime(id, user.user_id, 1, remarks);
      setShowDetail(false);
      setSelectedRequest(null);
      setRemarks("");
      fetchData();
    } catch (err) {
      alert(err.response?.data?.error || "Failed to approve");
    } finally {
      setActionLoading(false);
    }
  };

  const handleLeadReject = async (id) => {
    if (!remarks.trim()) {
      alert("Please provide remarks for rejection.");
      return;
    }
    setActionLoading(true);
    try {
      await api.leadRejectOvertime(id, user.user_id, remarks);
      setShowDetail(false);
      setSelectedRequest(null);
      setRemarks("");
      fetchData();
    } catch (err) {
      alert(err.response?.data?.error || "Failed to reject");
    } finally {
      setActionLoading(false);
    }
  };

  const openDetail = (req) => {
    setSelectedRequest(req);
    setRemarks("");
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

  const pendingCount = requests.filter((r) => r.lead_status === "pending").length;

  return (
    <SlideUp>
      <div className="flex items-center gap-3 mb-6">
        <Users className="text-primary-600" size={24} />
        <div>
          <h2 className="text-xl font-bold text-neutral-900">Team Overtime</h2>
          <p className="text-sm text-neutral-500">Review and approve overtime requests from your team.</p>
        </div>
      </div>

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
              {f.value === "pending" && pendingCount > 0 && (
                <span className="ml-1.5 bg-yellow-500 text-white text-[10px] px-1.5 py-0.5 rounded-full">
                  {pendingCount}
                </span>
              )}
            </button>
          ))}
        </div>
      </div>

      {/* Requests Table */}
      <Card>
        <CardHeader>
          <h3 className="text-lg font-semibold text-neutral-900">Team Overtime Requests</h3>
        </CardHeader>
        <CardBody>
          {loading ? (
            <div className="text-center py-8">Loading...</div>
          ) : requests.length === 0 ? (
            <div className="text-center py-12 text-neutral-400">
              <Clock size={40} className="mx-auto mb-3 opacity-40" />
              <p>No overtime requests from your team</p>
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
                    <th>Lead Status</th>
                    <th>Admin Status</th>
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
                      <td>
                        <Badge variant={leadStatusBadge[req.lead_status]?.variant || "warning"}>
                          {leadStatusBadge[req.lead_status]?.label || req.lead_status}
                        </Badge>
                      </td>
                      <td>
                        <Badge variant={adminStatusBadge[req.status]?.variant || "neutral"}>
                          {adminStatusBadge[req.status]?.label || req.status}
                        </Badge>
                      </td>
                      <td>
                        <button
                          onClick={() => openDetail(req)}
                          className="text-xs text-primary-600 hover:text-primary-800 underline"
                        >
                          {req.lead_status === "pending" ? "Review" : "View"}
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
            title="Overtime Request Review"
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
                  <p className="text-xs text-neutral-500">Hours Worked</p>
                  <p className="font-medium">{selectedRequest.hours_worked}h</p>
                </div>
                <div>
                  <p className="text-xs text-neutral-500">Lead Status</p>
                  <Badge variant={leadStatusBadge[selectedRequest.lead_status]?.variant}>
                    {leadStatusBadge[selectedRequest.lead_status]?.label}
                  </Badge>
                </div>
                <div>
                  <p className="text-xs text-neutral-500">Admin Status</p>
                  <Badge variant={adminStatusBadge[selectedRequest.status]?.variant}>
                    {adminStatusBadge[selectedRequest.status]?.label}
                  </Badge>
                </div>
              </div>

              {selectedRequest.reason && (
                <div>
                  <p className="text-xs text-neutral-500 mb-1">Reason</p>
                  <p className="text-sm bg-neutral-50 p-3 rounded-lg">{selectedRequest.reason}</p>
                </div>
              )}

              {selectedRequest.lead_remarks && (
                <div>
                  <p className="text-xs text-neutral-500 mb-1">Lead Remarks</p>
                  <p className="text-sm bg-primary-50 p-3 rounded-lg text-primary-700">{selectedRequest.lead_remarks}</p>
                </div>
              )}

              {selectedRequest.rejection_reason && (
                <div>
                  <p className="text-xs text-red-500 mb-1">Rejection Reason</p>
                  <p className="text-sm bg-red-50 p-3 rounded-lg text-red-700">{selectedRequest.rejection_reason}</p>
                </div>
              )}

              {/* Lead Approval Actions */}
              {selectedRequest.lead_status === "pending" && (
                <div className="border-t border-neutral-200 pt-4 space-y-4">
                  <div>
                    <label className="block text-sm font-medium text-neutral-700 mb-1">
                      Remarks (required for rejection)
                    </label>
                    <textarea
                      value={remarks}
                      onChange={(e) => setRemarks(e.target.value)}
                      placeholder="Provide remarks for your decision..."
                      rows={3}
                      className="w-full px-3 py-2 border border-neutral-300 rounded-lg text-sm resize-none"
                    />
                  </div>
                  <div className="flex justify-end gap-3">
                    <Button
                      variant="danger"
                      size="sm"
                      onClick={() => handleLeadReject(selectedRequest.id)}
                      disabled={actionLoading}
                    >
                      <XCircle size={14} className="mr-1" /> Reject
                    </Button>
                    <Button
                      variant="primary"
                      size="sm"
                      onClick={() => handleLeadApprove(selectedRequest.id)}
                      disabled={actionLoading}
                    >
                      <CheckCircle size={14} className="mr-1" /> Approve
                    </Button>
                  </div>
                  <p className="text-[10px] text-neutral-500 italic text-center">
                    Lead approval moves this request to admin for final approval.
                  </p>
                </div>
              )}

              {selectedRequest.lead_status !== "pending" && (
                <div className="text-center py-4 border-t border-neutral-200">
                  <p className="text-sm text-neutral-500">
                    {selectedRequest.lead_status === "approved"
                      ? "You have approved this request. Awaiting admin finalization."
                      : "You have rejected this request."}
                  </p>
                </div>
              )}
            </div>
          </Modal>
        )}
      </AnimatePresence>
    </SlideUp>
  );
};

export default LeadOvertimeTab;
