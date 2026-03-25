import React, { useState, useEffect } from 'react';
import { motion } from 'framer-motion';
import { PlaneTakeoff, Plus, Check, X } from 'lucide-react';
import { Card, CardHeader, CardBody } from '../common/Card';
import { Button } from '../common/Button';
import { Modal, Input, Textarea, Select } from '../common';
import api from '../../services/api';

export const LeaveRequestHub = ({ user, isAdmin = false }) => {
  const [requests, setRequests] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showModal, setShowModal] = useState(false);
  
  const [form, setForm] = useState({
    start_date: '',
    end_date: '',
    reason: ''
  });

  const [filterStr, setFilterStr] = useState('pending');

  const fetchRequests = async () => {
    try {
      const res = await api.getLeaveRequests(isAdmin ? undefined : user.user_id, filterStr);
      setRequests(res.data);
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    setLoading(true);
    fetchRequests();
  }, [filterStr, isAdmin, user.user_id]);

  const handleSubmit = async (e) => {
    e.preventDefault();
    try {
      await api.createLeaveRequest({ ...form, user_id: user.user_id });
      setShowModal(false);
      setForm({ start_date: '', end_date: '', reason: '' });
      fetchRequests();
    } catch (err) {
      console.error('Failed to submit request', err);
    }
  };

  const handleStatusChange = async (id, status) => {
    try {
      await api.updateLeaveRequestStatus(id, status, user.user_id);
      fetchRequests();
    } catch (error) {
      console.error('Failed to update status', error);
    }
  };

  return (
    <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} className="space-y-6">
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-end gap-4">
        <div>
          <h2 className="text-2xl font-bold tracking-tight text-neutral-900">Leave Requests</h2>
          <p className="text-neutral-500 mt-1">
            {isAdmin ? 'Manage employee leave requests.' : 'Apply for leaves and track request statuses.'}
          </p>
        </div>
        <div className="flex items-center gap-3">
          <Select value={filterStr} onChange={(e) => setFilterStr(e.target.value)} className="w-40">
            <option value="all">All Statuses</option>
            <option value="pending">Pending</option>
            <option value="approved">Approved</option>
            <option value="rejected">Rejected</option>
          </Select>
          {!isAdmin && (
            <Button onClick={() => setShowModal(true)} className="flex items-center gap-2">
              <Plus size={16} /> Request Leave
            </Button>
          )}
        </div>
      </div>

      <div className="grid grid-cols-1 gap-4">
        {loading ? (
          <p>Loading...</p>
        ) : requests.length === 0 ? (
          <Card>
            <CardBody className="py-12 flex flex-col items-center">
              <PlaneTakeoff className="w-12 h-12 text-neutral-300 mb-4" />
              <p className="text-neutral-500">No leave requests found.</p>
            </CardBody>
          </Card>
        ) : (
          requests.map((req) => (
            <Card key={req.id}>
              <CardBody className="p-6">
                <div className="flex flex-col md:flex-row justify-between items-start gap-4">
                  <div>
                    <div className="flex items-center gap-3 mb-2">
                      <span className={`px-2.5 py-1 rounded-full text-xs font-semibold
                        ${req.status === 'approved' ? 'bg-green-100 text-green-800' :
                        req.status === 'rejected' ? 'bg-red-100 text-red-800' :
                        'bg-yellow-100 text-yellow-800'}
                      `}>
                        {req.status.toUpperCase()}
                      </span>
                      {isAdmin && <span className="font-bold text-neutral-900">{req.user.name}</span>}
                    </div>
                    <p className="text-neutral-600 mb-2">{req.reason}</p>
                    <p className="text-sm text-neutral-500">
                      From <span className="font-semibold text-neutral-700">{new Date(req.start_date).toLocaleDateString()}</span> to <span className="font-semibold text-neutral-700">{new Date(req.end_date).toLocaleDateString()}</span>
                    </p>
                    {req.reviewed_by && (
                      <p className="text-xs text-neutral-400 mt-2">
                        Reviewed by {req.reviewer?.name} on {new Date(req.created_at).toLocaleDateString()}
                      </p>
                    )}
                  </div>

                  {isAdmin && req.status === 'pending' && (
                    <div className="flex gap-2 w-full md:w-auto mt-4 md:mt-0">
                      <Button
                        variant="ghost"
                        className="text-red-600 hover:bg-red-50 hover:text-red-700 flex-1 md:flex-none"
                        onClick={() => handleStatusChange(req.id, 'rejected')}
                      >
                        <X size={16} className="mr-2" /> Reject
                      </Button>
                      <Button
                        variant="primary"
                        className="bg-green-600 hover:bg-green-700 focus:ring-green-500 flex-1 md:flex-none"
                        onClick={() => handleStatusChange(req.id, 'approved')}
                      >
                        <Check size={16} className="mr-2" /> Approve
                      </Button>
                    </div>
                  )}
                </div>
              </CardBody>
            </Card>
          ))
        )}
      </div>

      {showModal && !isAdmin && (
        <Modal isOpen={true} title="Request Leave" onClose={() => setShowModal(false)}>
          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="grid grid-cols-2 gap-4">
              <Input
                label="Start Date"
                type="date"
                value={form.start_date}
                onChange={(e) => setForm({ ...form, start_date: e.target.value })}
                required
              />
              <Input
                label="End Date"
                type="date"
                value={form.end_date}
                onChange={(e) => setForm({ ...form, end_date: e.target.value })}
                required
              />
            </div>
            <Textarea
              label="Reason for Leave"
              value={form.reason}
              onChange={(e) => setForm({ ...form, reason: e.target.value })}
              required
              rows={4}
            />
            <div className="flex justify-end gap-3 pt-4 border-t border-neutral-100">
              <Button type="button" variant="outline" onClick={() => setShowModal(false)}>Cancel</Button>
              <Button type="submit">Submit Request</Button>
            </div>
          </form>
        </Modal>
      )}
    </motion.div>
  );
};
