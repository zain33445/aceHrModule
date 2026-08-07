import React, { useState, useEffect, useCallback } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  Users,
  CheckCircle2,
  XCircle,
  Clock,
  Calendar,
  FileText,
} from "lucide-react";
import { Card, CardBody } from "../common/Card";
import { Badge } from "../common/Badge";
import { Button } from "../common/Button";
import { Modal } from "../common/Modal";
import api from "../../services/api";

const leadStatusBadge = {
  pending: { label: "Pending", variant: "warning" },
  approved: { label: "Lead Approved", variant: "success" },
  rejected: { label: "Lead Rejected", variant: "error" },
};

const adminStatusBadge = {
  PENDING: { label: "Pending Admin", variant: "neutral" },
  APPROVED: { label: "Approved", variant: "success" },
  REJECTED: { label: "Rejected", variant: "error" },
  CANCELLED: { label: "Cancelled", variant: "error" },
};

const STATUS_FILTERS = [
  { value: "all", label: "All" },
  { value: "pending", label: "Pending" },
  { value: "approved", label: "Approved" },
  { value: "rejected", label: "Rejected" },
];

export const LeadLeaveTab = ({ user }) => {
  const [requests, setRequests] = useState([]);
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState("all");
  const [selectedRequest, setSelectedRequest] = useState(null);
  const [remarks, setRemarks] = useState("");
  const [actionLoading, setActionLoading] = useState(false);

  const fetchRequests = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.getTeamLeaveRequests(user.user_id, statusFilter);
      setRequests(res.data?.records || []);
    } catch (err) {
      console.error("Failed to fetch team leave requests:", err);
    } finally {
      setLoading(false);
    }
  }, [user.user_id, statusFilter]);

  useEffect(() => {
    fetchRequests();
  }, [fetchRequests]);

  const handleLeadApprove = async (id) => {
    setActionLoading(true);
    try {
      await api.leadApproveLeave(id, user.user_id, remarks);
      setSelectedRequest(null);
      setRemarks("");
      fetchRequests();
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
      await api.leadRejectLeave(id, user.user_id, remarks);
      setSelectedRequest(null);
      setRemarks("");
      fetchRequests();
    } catch (err) {
      alert(err.response?.data?.error || "Failed to reject");
    } finally {
      setActionLoading(false);
    }
  };

  const formatDate = (d) =>
    new Date(d).toLocaleDateString("en-GB", {
      day: "2-digit",
      month: "short",
      year: "numeric",
    });

  const pendingCount = requests.filter((r) => r.lead_status === "pending").length;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center gap-3">
        <Users className="text-primary-600" size={24} />
        <div>
          <h2 className="text-xl font-bold text-neutral-900">Team Leave Requests</h2>
          <p className="text-sm text-neutral-500">Review and approve leave requests from your team.</p>
        </div>
      </div>

      {/* Status Filter */}
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

      {/* Requests List */}
      <div className="space-y-3">
        {loading ? (
          <div className="flex items-center justify-center h-32 text-neutral-400 text-sm">
            Loading requests...
          </div>
        ) : requests.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-40 bg-white border border-dashed border-neutral-200 rounded-xl gap-3">
            <FileText className="w-10 h-10 text-neutral-300" />
            <p className="text-neutral-400 text-sm">No leave requests from your team.</p>
          </div>
        ) : (
          <AnimatePresence mode="popLayout">
            {requests.map((req) => (
              <motion.div
                layout
                key={req.id}
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, scale: 0.95 }}
              >
                <Card
                  className={`cursor-pointer transition-all hover:shadow-md ${
                    req.lead_status === "pending"
                      ? "border-2 border-yellow-200 hover:border-yellow-400"
                      : "border border-neutral-100"
                  }`}
                  onClick={() => {
                    setSelectedRequest(req);
                    setRemarks("");
                  }}
                >
                  <CardBody className="p-4">
                    <div className="flex items-start justify-between">
                      <div className="flex items-center gap-3">
                        <div className="w-10 h-10 bg-neutral-100 rounded-full flex items-center justify-center font-bold text-neutral-700">
                          {req.user?.name?.charAt(0)}
                        </div>
                        <div>
                          <p className="font-semibold text-neutral-900">{req.user?.name}</p>
                          <p className="text-xs text-neutral-500 flex items-center gap-1">
                            <Calendar size={12} />
                            {formatDate(req.start_date)} - {formatDate(req.end_date)}
                            {req.is_half_day && " (Half Day)"}
                          </p>
                        </div>
                      </div>
                      <div className="flex items-center gap-2">
                        <Badge variant={leadStatusBadge[req.lead_status]?.variant || "warning"}>
                          Lead: {leadStatusBadge[req.lead_status]?.label || req.lead_status}
                        </Badge>
                        <Badge variant={adminStatusBadge[req.status]?.variant || "neutral"}>
                          Admin: {adminStatusBadge[req.status]?.label || req.status}
                        </Badge>
                      </div>
                    </div>
                    <div className="mt-3 pl-13">
                      <p className="text-sm text-neutral-600 italic line-clamp-2">
                        "{req.reason}"
                      </p>
                      {req.leave_type && (
                        <p className="text-xs text-neutral-400 mt-1">
                          Type: {req.leave_type.name} | Days: {Number(req.days_consumed)}
                        </p>
                      )}
                    </div>
                  </CardBody>
                </Card>
              </motion.div>
            ))}
          </AnimatePresence>
        )}
      </div>

      {/* Detail Modal */}
      <AnimatePresence>
        {selectedRequest && (
          <Modal
            isOpen={!!selectedRequest}
            onClose={() => setSelectedRequest(null)}
            title="Leave Request Review"
            size="md"
          >
            <div className="space-y-4">
              {/* Employee Info */}
              <div className="flex items-center gap-4 p-4 bg-neutral-50 rounded-xl">
                <div className="w-12 h-12 bg-white rounded-full flex items-center justify-center text-lg font-bold text-primary-600 shadow-sm border-2 border-primary-100">
                  {selectedRequest.user?.name?.charAt(0)}
                </div>
                <div>
                  <h3 className="text-lg font-bold text-neutral-900">{selectedRequest.user?.name}</h3>
                  <p className="text-sm text-neutral-500">{selectedRequest.user?.id}</p>
                </div>
              </div>

              {/* Details */}
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <p className="text-xs text-neutral-500">Leave Type</p>
                  <p className="font-medium">{selectedRequest.leave_type?.name || "N/A"}</p>
                </div>
                <div>
                  <p className="text-xs text-neutral-500">Days</p>
                  <p className="font-medium">{Number(selectedRequest.days_consumed)} day(s)</p>
                </div>
                <div>
                  <p className="text-xs text-neutral-500">Start Date</p>
                  <p className="font-medium">{formatDate(selectedRequest.start_date)}</p>
                </div>
                <div>
                  <p className="text-xs text-neutral-500">End Date</p>
                  <p className="font-medium">{formatDate(selectedRequest.end_date)}</p>
                </div>
                <div>
                  <p className="text-xs text-neutral-500">Half Day</p>
                  <p className="font-medium">
                    {selectedRequest.is_half_day
                      ? `Yes (${selectedRequest.half_day_session})`
                      : "No"}
                  </p>
                </div>
                <div>
                  <p className="text-xs text-neutral-500">Lead Status</p>
                  <Badge variant={leadStatusBadge[selectedRequest.lead_status]?.variant}>
                    {leadStatusBadge[selectedRequest.lead_status]?.label}
                  </Badge>
                </div>
              </div>

              {/* Reason */}
              <div>
                <p className="text-xs text-neutral-500 mb-1">Reason</p>
                <p className="text-sm bg-neutral-50 p-3 rounded-lg">{selectedRequest.reason}</p>
              </div>

              {/* Lead Remarks */}
              {selectedRequest.lead_remarks && (
                <div>
                  <p className="text-xs text-neutral-500 mb-1">Your Remarks</p>
                  <p className="text-sm bg-primary-50 p-3 rounded-lg text-primary-700">
                    {selectedRequest.lead_remarks}
                  </p>
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
                      <CheckCircle2 size={14} className="mr-1" /> Approve
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
    </div>
  );
};

export default LeadLeaveTab;
