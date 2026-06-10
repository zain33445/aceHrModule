import React, { useState, useEffect, useCallback } from "react";
import { motion } from "framer-motion";
import { AlertCircle, Calendar, Shield, MessageSquare, XCircle, Loader2, UserCheck, ShieldCheck, CheckCircle2, X } from "lucide-react";
import { SlideUp } from "../animations";
import { Card, CardHeader, CardBody, CardFooter } from "../common/Card";
import { Button } from "../common/Button";
import { Modal } from "../common/Modal";
import { Badge } from "../common/Badge";
import { Pagination } from "../common/Pagination";
import api from "../../services/api";

export const HRDisputesTab = ({ user }) => {
  const [disputes, setDisputes] = useState([]);
  const [loading, setLoading] = useState(true);
  const [pagination, setPagination] = useState({ currentPage: 1, totalPages: 1, totalRecords: 0 });
  const [selectedDispute, setSelectedDispute] = useState(null);
  const [showDetail, setShowDetail] = useState(false);

  const fetchDisputes = useCallback(async (page = 1) => {
    setLoading(true);
    try {
      const res = await api.getAllDisputes(page);
      if (res.data?.success) {
        setDisputes(res.data.data.records || []);
        setPagination({
          currentPage: page,
          totalPages: Math.ceil((res.data.data.total || 0) / 20),
          totalRecords: res.data.data.total || 0,
        });
      }
    } catch (err) {
      console.error("Error fetching disputes:", err);
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    fetchDisputes();
  }, [fetchDisputes]);

  const handleHRApproval = async (disputeId, action, remarks) => {
    try {
      const res = await api.hrApproveDispute(disputeId, {
        hr_id: user.user_id,
        action,
        remarks,
      });
      if (res.data?.success) {
        fetchDisputes(pagination.currentPage);
        setShowDetail(false);
      }
    } catch (err) {
      alert(err.response?.data?.error || "Failed to update dispute");
    }
  };

  const getStatusColor = (status) => {
    switch (status) {
      case "approved": return "success";
      case "rejected": return "error";
      case "partially_approved": return "warning";
      default: return "warning";
    }
  };

  return (
    <SlideUp>
      <div className="flex justify-between items-center mb-6">
        <h3 className="text-lg font-semibold text-neutral-900">Appeal Management (HR)</h3>
      </div>

      {loading ? (
        <div className="flex items-center justify-center h-64">
          <Loader2 className="w-8 h-8 animate-spin text-primary-500" />
        </div>
      ) : disputes.length === 0 ? (
        <Card>
          <CardBody>
            <div className="text-center py-12 text-neutral-500">
              <AlertCircle className="w-12 h-12 mx-auto mb-3 text-neutral-300" />
              <p className="font-medium">No appeals found</p>
            </div>
          </CardBody>
        </Card>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
          {disputes.map((dispute) => (
            <motion.div
              key={dispute.id}
              whileHover={{ y: -4 }}
              className="bg-white rounded-xl border border-neutral-200 p-5 cursor-pointer transition-all hover:border-primary-300 shadow-sm"
              onClick={() => { setSelectedDispute(dispute); setShowDetail(true); }}
            >
              <div className="flex justify-between items-start mb-4">
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 rounded-full bg-primary-50 flex items-center justify-center text-primary-600 font-bold">
                    {dispute.requester?.name?.charAt(0) || "?"}
                  </div>
                  <div>
                    <h4 className="font-semibold text-neutral-900 leading-none">{dispute.requester?.name}</h4>
                    <p className="text-xs text-neutral-500 mt-1">{dispute.requester?.department?.name || "No Dept"}</p>
                  </div>
                </div>
                <Badge variant={getStatusColor(dispute.final_status)}>
                  {dispute.final_status.replace("_", " ")}
                </Badge>
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
                  <div className={`w-6 h-6 rounded-full border-2 border-white flex items-center justify-center ${dispute.lead_status === "approved" ? "bg-green-500" : dispute.lead_status === "rejected" ? "bg-red-500" : "bg-neutral-200"}`} title={`Lead: ${dispute.lead_status}`}>
                    <UserCheck size={10} className="text-white" />
                  </div>
                  <div className={`w-6 h-6 rounded-full border-2 border-white flex items-center justify-center ${dispute.admin_status === "approved" ? "bg-green-500" : dispute.admin_status === "rejected" ? "bg-red-500" : "bg-neutral-200"}`} title={`Admin: ${dispute.admin_status}`}>
                    <ShieldCheck size={10} className="text-white" />
                  </div>
                  <div className={`w-6 h-6 rounded-full border-2 border-white flex items-center justify-center ${dispute.hr_status === "approved" ? "bg-green-500" : dispute.hr_status === "rejected" ? "bg-red-500" : "bg-neutral-200"}`} title={`HR: ${dispute.hr_status}`}>
                    <ShieldCheck size={10} className="text-white" />
                  </div>
                </div>
                <span className="text-xs text-primary-600 font-medium flex items-center gap-1">
                  Review <CheckCircle2 size={14} />
                </span>
              </div>
            </motion.div>
          ))}
        </div>
      )}

      <div className="mt-6">
        <Pagination
          currentPage={pagination.currentPage}
          totalPages={pagination.totalPages}
          onPageChange={fetchDisputes}
        />
      </div>

      {showDetail && selectedDispute && (
        <HRDisputeDetailModal
          dispute={selectedDispute}
          user={user}
          onClose={() => setShowDetail(false)}
          onAction={handleHRApproval}
        />
      )}
    </SlideUp>
  );
};

function HRDisputeDetailModal({ dispute, user, onClose, onAction }) {
  const [remarks, setRemarks] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);

  const handleAction = async (action) => {
    if (!remarks && action === "reject") {
      alert("Remarks are required for rejection");
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
        style={{ maxWidth: "40rem" }}
        className="bg-white rounded-2xl shadow-2xl w-full overflow-hidden max-h-[90vh] flex flex-col"
      >
        <div className="p-6 border-b border-neutral-100 flex justify-between items-center bg-neutral-50/50">
          <div className="flex items-center gap-4">
            <div className="p-3 bg-primary-100 text-primary-600 rounded-xl">
              <AlertCircle size={24} />
            </div>
            <div>
              <h3 className="text-xl font-bold text-neutral-900">Appeal Details</h3>
              <p className="text-sm text-neutral-500">ID: DISP-{dispute.id.toString().padStart(5, "0")}</p>
            </div>
          </div>
          <button onClick={onClose} className="p-2 hover:bg-neutral-100 rounded-lg text-neutral-400 hover:text-neutral-600 transition-colors">
            <XCircle size={24} />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-6 space-y-8 no-scrollbar">
          <div className="grid grid-cols-2 gap-4">
            <div className="p-4 bg-neutral-50 rounded-xl border border-neutral-100">
              <p className="text-xs font-semibold text-neutral-500 uppercase mb-2">Employee</p>
              <p className="font-bold text-neutral-900">{dispute.requester?.name}</p>
              <p className="text-sm text-neutral-600">{dispute.requester?.department?.name || "No Department"}</p>
            </div>
            <div className="p-4 bg-neutral-50 rounded-xl border border-neutral-100">
              <p className="text-xs font-semibold text-neutral-500 uppercase mb-2">Date & Category</p>
              <p className="font-bold text-neutral-900">{new Date(dispute.dispute_date).toLocaleDateString()}</p>
              <p className="text-sm text-neutral-600 capitalize">{dispute.category}</p>
            </div>
          </div>

          <div>
            <h4 className="text-sm font-semibold text-neutral-900 mb-2 flex items-center gap-2">
              <MessageSquare size={16} className="text-primary-500" /> Employee Message
            </h4>
            <p className="text-sm text-neutral-700 bg-neutral-50 p-4 rounded-xl border border-neutral-100 leading-relaxed">
              {dispute.description || "No description provided"}
            </p>
          </div>

          <div className="border-t border-neutral-100 pt-6">
            <h4 className="text-sm font-semibold text-neutral-900 mb-4">Approval Status</h4>
            <div className="grid grid-cols-3 gap-3">
              <div className={`p-3 rounded-xl border text-center ${dispute.lead_status === "approved" ? "bg-green-50 border-green-200" : dispute.lead_status === "rejected" ? "bg-red-50 border-red-200" : "bg-neutral-50 border-neutral-200"}`}>
                <p className="text-xs font-semibold text-neutral-500 uppercase mb-1">Lead</p>
                <p className={`text-sm font-bold capitalize ${dispute.lead_status === "approved" ? "text-green-600" : dispute.lead_status === "rejected" ? "text-red-600" : "text-neutral-400"}`}>
                  {dispute.lead_status}
                </p>
              </div>
              <div className={`p-3 rounded-xl border text-center ${dispute.admin_status === "approved" ? "bg-green-50 border-green-200" : dispute.admin_status === "rejected" ? "bg-red-50 border-red-200" : "bg-neutral-50 border-neutral-200"}`}>
                <p className="text-xs font-semibold text-neutral-500 uppercase mb-1">Admin</p>
                <p className={`text-sm font-bold capitalize ${dispute.admin_status === "approved" ? "text-green-600" : dispute.admin_status === "rejected" ? "text-red-600" : "text-neutral-400"}`}>
                  {dispute.admin_status}
                </p>
              </div>
              <div className={`p-3 rounded-xl border text-center ${dispute.hr_status === "approved" ? "bg-green-50 border-green-200" : dispute.hr_status === "rejected" ? "bg-red-50 border-red-200" : "bg-neutral-50 border-neutral-200"}`}>
                <p className="text-xs font-semibold text-neutral-500 uppercase mb-1">HR</p>
                <p className={`text-sm font-bold capitalize ${dispute.hr_status === "approved" ? "text-green-600" : dispute.hr_status === "rejected" ? "text-red-600" : "text-neutral-400"}`}>
                  {dispute.hr_status}
                </p>
              </div>
            </div>
          </div>

          <div>
            <h4 className="text-sm font-semibold text-neutral-900 mb-2">HR Remarks</h4>
            <textarea
              value={remarks}
              onChange={(e) => setRemarks(e.target.value)}
              placeholder="Enter your remarks..."
              className="w-full px-4 py-3 border border-neutral-200 rounded-xl text-sm resize-none focus:outline-none focus:ring-2 focus:ring-primary-500/20 focus:border-primary-500"
              rows={3}
            />
          </div>
        </div>

        <div className="p-6 border-t border-neutral-100 bg-neutral-50/50 flex gap-3 justify-end">
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button
            variant="danger"
            onClick={() => handleAction("reject")}
            disabled={isSubmitting}
          >
            {isSubmitting ? "Processing..." : "Reject"}
          </Button>
          <Button
            variant="primary"
            onClick={() => handleAction("approve")}
            disabled={isSubmitting}
          >
            {isSubmitting ? "Processing..." : "Approve"}
          </Button>
        </div>
      </motion.div>
    </div>
  );
}

export default HRDisputesTab;
