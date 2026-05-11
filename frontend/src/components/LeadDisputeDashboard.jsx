import React, { useState, useEffect, useMemo } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { 
  FileText, 
  Search, 
  Filter, 
  MessageSquare, 
  History,
  CheckCircle2,
  XCircle,
  Clock,
  AlertCircle,
  Users
} from 'lucide-react';
import { Card, CardBody } from './common/Card';
import { Button } from './common/Button';
import { Badge, Modal, Select } from './common';
import { Pagination } from './common/Pagination';
import api from '../services/api';
import { DISPUTE_STATUS } from '../constants/dispute.constants';

const StatusBox = ({ title, status, date, remarks, color }) => (
  <div className={`p-4 rounded-xl border-2 ${color} bg-white shadow-sm`}>
    <div className="flex justify-between items-start mb-2">
      <h4 className="font-bold text-sm uppercase tracking-wider">{title}</h4>
      <Badge variant={status === 'approved' ? 'success' : status === 'rejected' ? 'danger' : 'neutral'}>
        {status}
      </Badge>
    </div>
    {date && <p className="text-xs text-neutral-500 mb-2">{new Date(date).toLocaleDateString()}</p>}
    {remarks && (
      <div className="mt-2 p-2 bg-neutral-50 rounded text-sm italic text-neutral-600 border-l-4 border-neutral-200">
        "{remarks}"
      </div>
    )}
  </div>
);

export const LeadDisputeDashboard = ({ user }) => {
  const [disputes, setDisputes] = useState([]);
  const [loading, setLoading] = useState(true);
  const [selectedDispute, setSelectedDispute] = useState(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [filterStatus, setFilterStatus] = useState('all');
  const [remarks, setRemarks] = useState('');
  const [actionLoading, setActionLoading] = useState(false);
  const [pagination, setPagination] = useState({ currentPage: 1, totalPages: 1, totalRecords: 0 });

  const fetchDisputes = async () => {
    setLoading(true);
    try {
      const res = await api.getTeamDisputes(user.user_id, pagination.currentPage);
      
      // Handle both wrapped and unwrapped response structures, 
      // including direct arrays or objects with a 'records' field
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
      setPagination(prev => ({
        ...prev,
        totalPages: Math.ceil(total / 20),
        totalRecords: total
      }));
    } catch (err) {
      console.error('Failed to fetch team disputes:', err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchDisputes();
  }, [pagination.currentPage]);

  const filteredDisputes = useMemo(() => {
    return disputes.filter(d => {
      const matchesSearch = 
        d.requester?.name?.toLowerCase().includes(searchQuery.toLowerCase()) ||
        d.description?.toLowerCase().includes(searchQuery.toLowerCase());
      
      const matchesStatus = 
        filterStatus === 'all' || 
        (filterStatus === 'pending' && d.lead_status === 'pending') ||
        (filterStatus === 'approved' && d.lead_status === 'approved') ||
        (filterStatus === 'rejected' && d.lead_status === 'rejected');

      return matchesSearch && matchesStatus;
    });
  }, [disputes, searchQuery, filterStatus]);

  const handleApproval = async (status) => {
    if (!remarks.trim()) {
      alert('Please provide remarks for this action.');
      return;
    }
    
    setActionLoading(true);
    try {
      await api.leadApproveDispute(selectedDispute.id, { 
        lead_id: user.user_id,
        action: status, 
        remarks 
      });
      setSelectedDispute(null);
      setRemarks('');
      fetchDisputes();
    } catch (err) {
      alert(err.response?.data?.message || 'Failed to update dispute');
    } finally {
      setActionLoading(false);
    }
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <h2 className="text-2xl font-bold text-neutral-900 flex items-center gap-2">
            <Users className="text-primary-600" />
            Team Disputes
          </h2>
          <p className="text-neutral-500">Manage and approve disputes for your department.</p>
        </div>
        
        <div className="flex items-center gap-3">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-neutral-400" size={18} />
            <input 
              type="text"
              placeholder="Search employee or description..."
              className="pl-10 pr-4 py-2 bg-white border border-neutral-200 rounded-xl w-64 focus:ring-2 focus:ring-primary-500 outline-none transition-all"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
            />
          </div>
          <Select 
            className="w-56"
            value={filterStatus}
            onChange={setFilterStatus}
            options={[
              { value: 'all', label: 'All Status' },
              { value: 'pending', label: 'Pending Your Action' },
              { value: 'approved', label: 'Approved by You' },
              { value: 'rejected', label: 'Rejected by You' },
            ]}
          />
        </div>
      </div>

      {/* Stats Grid */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <Card className="bg-blue-50 border-blue-100">
          <CardBody className="p-4 flex items-center gap-4">
            <div className="w-10 h-10 bg-blue-100 rounded-lg flex items-center justify-center text-blue-600">
              <FileText size={20} />
            </div>
            <div>
              <p className="text-xs font-bold text-blue-600 uppercase">Total</p>
              <p className="text-xl font-bold text-neutral-900">{disputes.length}</p>
            </div>
          </CardBody>
        </Card>
        <Card className="bg-yellow-50 border-yellow-100">
          <CardBody className="p-4 flex items-center gap-4">
            <div className="w-10 h-10 bg-yellow-100 rounded-lg flex items-center justify-center text-yellow-600">
              <Clock size={20} />
            </div>
            <div>
              <p className="text-xs font-bold text-yellow-600 uppercase">Pending</p>
              <p className="text-xl font-bold text-neutral-900">{disputes.filter(d => d.lead_status === 'pending').length}</p>
            </div>
          </CardBody>
        </Card>
        <Card className="bg-green-50 border-green-100">
          <CardBody className="p-4 flex items-center gap-4">
            <div className="w-10 h-10 bg-green-100 rounded-lg flex items-center justify-center text-green-600">
              <CheckCircle2 size={20} />
            </div>
            <div>
              <p className="text-xs font-bold text-green-600 uppercase">Approved</p>
              <p className="text-xl font-bold text-neutral-900">{disputes.filter(d => d.lead_status === 'approved').length}</p>
            </div>
          </CardBody>
        </Card>
        <Card className="bg-red-50 border-red-100">
          <CardBody className="p-4 flex items-center gap-4">
            <div className="w-10 h-10 bg-red-100 rounded-lg flex items-center justify-center text-red-600">
              <XCircle size={20} />
            </div>
            <div>
              <p className="text-xs font-bold text-red-600 uppercase">Rejected</p>
              <p className="text-xl font-bold text-neutral-900">{disputes.filter(d => d.lead_status === 'rejected').length}</p>
            </div>
          </CardBody>
        </Card>
      </div>

      {/* Disputes List */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
        {loading ? (
          [1, 2, 3].map(i => <div key={i} className="h-48 bg-neutral-100 animate-pulse rounded-2xl" />)
        ) : filteredDisputes.length === 0 ? (
          <div className="col-span-full py-20 text-center">
            <div className="w-16 h-16 bg-neutral-100 rounded-full flex items-center justify-center mx-auto mb-4 text-neutral-400">
              <FileText size={32} />
            </div>
            <h3 className="text-lg font-bold text-neutral-900">No disputes found</h3>
            <p className="text-neutral-500">Great! No pending disputes in your team.</p>
          </div>
        ) : (
          filteredDisputes.map(dispute => (
            <motion.div
              layout
              key={dispute.id}
              initial={{ opacity: 0, scale: 0.9 }}
              animate={{ opacity: 1, scale: 1 }}
              whileHover={{ y: -5 }}
              onClick={() => setSelectedDispute(dispute)}
              className="cursor-pointer"
            >
              <Card className={`h-full border-2 transition-all ${
                dispute.lead_status === 'pending' ? 'border-yellow-200 hover:border-yellow-400 shadow-yellow-50' : 'border-neutral-100 hover:border-primary-300'
              }`}>
                <CardBody className="p-5 flex flex-col h-full">
                  <div className="flex justify-between items-start mb-4">
                    <div className="flex items-center gap-3">
                      <div className="w-10 h-10 bg-neutral-100 rounded-full flex items-center justify-center font-bold text-neutral-700">
                        {dispute.requester?.name?.charAt(0)}
                      </div>
                      <div>
                        <h4 className="font-bold text-neutral-900">{dispute.requester?.name}</h4>
                        <p className="text-xs text-neutral-500">{dispute.requester?.id}</p>
                      </div>
                    </div>
                    <Badge variant={
                      dispute.lead_status === 'approved' ? 'success' : 
                      dispute.lead_status === 'rejected' ? 'danger' : 'warning'
                    }>
                      {dispute.lead_status}
                    </Badge>
                  </div>

                  <div className="flex-1 space-y-3">
                    <div className="p-3 bg-neutral-50 rounded-xl border border-neutral-100">
                      <p className="text-sm text-neutral-700 line-clamp-2 italic">"{dispute.description}"</p>
                    </div>
                    
                    <div className="flex justify-between items-center text-xs text-neutral-500 px-1">
                      <span className="flex items-center gap-1">
                        <Clock size={12} />
                        {new Date(dispute.date_of_req).toLocaleDateString()}
                      </span>
                      <span className="font-bold text-primary-600">
                        Restoration Requested
                      </span>
                    </div>
                  </div>

                  <div className="mt-4 pt-4 border-t border-neutral-100 flex items-center justify-between">
                    <div className="flex -space-x-2">
                       <div className={`w-6 h-6 rounded-full border-2 border-white flex items-center justify-center text-[10px] font-bold ${
                         dispute.lead_status === 'approved' ? 'bg-green-500 text-white' : 'bg-neutral-200 text-neutral-600'
                       }`} title="Lead Stage">L</div>
                       <div className={`w-6 h-6 rounded-full border-2 border-white flex items-center justify-center text-[10px] font-bold ${
                         dispute.admin_status === 'approved' ? 'bg-blue-500 text-white' : 'bg-neutral-200 text-neutral-600'
                       }`} title="Admin Stage">A</div>
                    </div>
                    <span className="text-xs font-bold text-primary-600 uppercase">View Details</span>
                  </div>
                </CardBody>
              </Card>
            </motion.div>
          ))
        )}
      </div>

      {pagination.totalPages > 1 && (
        <Pagination 
          currentPage={pagination.currentPage} 
          totalPages={pagination.totalPages} 
          onPageChange={(page) => setPagination(prev => ({ ...prev, currentPage: page }))} 
        />
      )}

      {/* Detail Modal */}
      <AnimatePresence>
        {selectedDispute && (
          <Modal
            isOpen={true}
            onClose={() => setSelectedDispute(null)}
            title="Dispute Approval"
            size="lg"
          >
            <div className="space-y-6">
              {/* Employee Info Header */}
              <div className="flex items-center gap-4 p-4 bg-neutral-50 rounded-2xl border border-neutral-200">
                <div className="w-16 h-16 bg-white rounded-full flex items-center justify-center text-2xl font-bold text-primary-600 shadow-sm border-2 border-primary-100">
                  {selectedDispute.requester?.name?.charAt(0)}
                </div>
                <div>
                  <h3 className="text-xl font-bold text-neutral-900">{selectedDispute.requester?.name}</h3>
                  <div className="flex items-center gap-3 mt-1">
                    <span className="text-sm text-neutral-500 flex items-center gap-1">
                      <Badge variant="neutral">{selectedDispute.requester?.id}</Badge>
                    </span>
                    <span className="text-sm text-neutral-400">|</span>
                    <span className="text-sm text-neutral-500 flex items-center gap-1">
                      <Clock size={14} /> Filed {new Date(selectedDispute.date_of_req).toLocaleString()}
                    </span>
                  </div>
                </div>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                {/* Details Section */}
                <div className="space-y-4">
                  <div>
                    <label className="text-xs font-bold text-neutral-500 uppercase tracking-widest block mb-2">Dispute Description</label>
                    <div className="p-4 bg-white rounded-xl border-2 border-neutral-100 shadow-sm min-h-[100px]">
                      <p className="text-neutral-700">{selectedDispute.description}</p>
                    </div>
                  </div>

                  {/* Workflow Visualization */}
                  <div className="space-y-3">
                    <label className="text-xs font-bold text-neutral-500 uppercase tracking-widest block">Approval Workflow</label>
                    <StatusBox 
                      title="Team Lead Approval"
                      status={selectedDispute.lead_status}
                      date={selectedDispute.lead_approved_at}
                      remarks={selectedDispute.lead_remarks}
                      color={selectedDispute.lead_status === 'approved' ? 'border-green-200' : selectedDispute.lead_status === 'rejected' ? 'border-red-200' : 'border-yellow-200'}
                    />
                    <StatusBox 
                      title="Admin Finalization"
                      status={selectedDispute.admin_status}
                      date={selectedDispute.admin_approved_at}
                      remarks={selectedDispute.admin_remarks}
                      color="border-neutral-100"
                    />
                  </div>
                </div>

                {/* Actions Section */}
                <div className="space-y-4">
                  <div className="p-4 bg-primary-50 rounded-2xl border border-primary-100">
                    <h4 className="font-bold text-primary-900 mb-2 flex items-center gap-2 text-sm uppercase">
                      <MessageSquare size={16} /> Lead Feedback
                    </h4>
                    
                    {selectedDispute.lead_status === 'pending' ? (
                      <div className="space-y-4">
                        <textarea
                          placeholder="Provide detailed remarks for your decision..."
                          className="w-full h-32 p-3 bg-white border-2 border-primary-200 rounded-xl focus:ring-4 focus:ring-primary-100 outline-none transition-all text-sm"
                          value={remarks}
                          onChange={(e) => setRemarks(e.target.value)}
                        />
                        <div className="grid grid-cols-2 gap-3">
                          <Button 
                            variant="danger" 
                            className="w-full py-3 flex items-center justify-center gap-2 shadow-lg shadow-red-100"
                            onClick={() => handleApproval('rejected')}
                            loading={actionLoading}
                          >
                            <XCircle size={18} /> Reject
                          </Button>
                          <Button 
                            variant="success" 
                            className="w-full py-3 flex items-center justify-center gap-2 shadow-lg shadow-green-100"
                            onClick={() => handleApproval('approved')}
                            loading={actionLoading}
                          >
                            <CheckCircle2 size={18} /> Approve
                          </Button>
                        </div>
                        <p className="text-[10px] text-primary-600 italic text-center">
                          Approving this will move the dispute to the Admin stage.
                        </p>
                      </div>
                    ) : (
                      <div className="text-center py-6">
                        <div className="w-12 h-12 bg-white rounded-full flex items-center justify-center mx-auto mb-3 text-primary-600 shadow-sm">
                          <CheckCircle2 size={24} />
                        </div>
                        <p className="font-bold text-primary-900">Action Already Taken</p>
                        <p className="text-xs text-primary-600 mt-1">You have already processed this dispute.</p>
                      </div>
                    )}
                  </div>

                  {/* History List */}
                  <div className="space-y-3">
                    <label className="text-xs font-bold text-neutral-500 uppercase tracking-widest block flex items-center gap-2">
                      <History size={14} /> Audit History
                    </label>
                    <div className="max-h-48 overflow-y-auto space-y-2 pr-2 scrollbar-thin">
                      {selectedDispute.history?.map((h, i) => (
                        <div key={i} className="text-xs p-3 bg-neutral-50 rounded-lg border border-neutral-100 flex gap-3">
                          <div className="w-6 h-6 bg-white rounded flex items-center justify-center flex-shrink-0 border border-neutral-200">
                            {i + 1}
                          </div>
                          <div>
                            <p className="font-bold text-neutral-900">{h.action?.replace('_', ' ')}</p>
                            <p className="text-neutral-500 mt-0.5">{h.remarks}</p>
                            <p className="text-[10px] text-neutral-400 mt-1 font-mono uppercase">
                              {new Date(h.created_at).toLocaleString()}
                            </p>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </Modal>
        )}
      </AnimatePresence>
    </div>
  );
};
