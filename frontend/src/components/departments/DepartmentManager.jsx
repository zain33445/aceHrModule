import React, { useState, useEffect, useMemo } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Building2, Plus, Edit2, Trash2, UserCheck, Star, UserPlus, UserMinus, Search, X } from 'lucide-react';
import { Card, CardHeader, CardBody } from '../common/Card';
import { Button } from '../common/Button';
import { Modal, Input, Badge } from '../common';
import api from '../../services/api';

export const DepartmentManager = () => {
  const [departments, setDepartments] = useState([]);
  const [users, setUsers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showModal, setShowModal] = useState(false);
  const [form, setForm] = useState({ name: '', shift_id: '', lead_id: '' });
  const [editingId, setEditingId] = useState(null);
  const [selectedDept, setSelectedDept] = useState(null);
  const [assignSearch, setAssignSearch] = useState('');
  const [assigning, setAssigning] = useState(null); // userId being processed

  const fetchData = async () => {
    setLoading(true);
    try {
      const [deptRes, userRes] = await Promise.all([
        api.getDepartments(),
        api.getUsers()
      ]);
      setDepartments(deptRes.data);
      setUsers(userRes.data || []);
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchData();
  }, []);

  // Keep selectedDept in sync when departments refresh
  useEffect(() => {
    if (selectedDept) {
      const fresh = departments.find(d => d.id === selectedDept.id);
      if (fresh) setSelectedDept(fresh);
    }
  }, [departments]);

  const handleSubmit = async (e) => {
    e.preventDefault();
    try {
      const payload = {
        ...form,
        shift_id: form.shift_id ? parseInt(form.shift_id) : undefined,
        lead_id: form.lead_id || null
      };
      if (editingId) {
        await api.updateDepartment(editingId, payload);
      } else {
        await api.createDepartment(payload);
      }
      setShowModal(false);
      fetchData();
      setForm({ name: '', shift_id: '', lead_id: '' });
      setEditingId(null);
    } catch (error) {
      console.error('Failed to save department', error);
    }
  };

  const handleDelete = async (id) => {
    if (window.confirm('Are you sure you want to delete this department?')) {
      try {
        await api.deleteDepartment(id);
        fetchData();
      } catch (error) {
        console.error('Failed to delete', error);
      }
    }
  };

  const openEdit = (dept) => {
    setForm({ name: dept.name, shift_id: dept.shift_id || '', lead_id: dept.lead_id || '' });
    setEditingId(dept.id);
    setShowModal(true);
  };

  const handleAssign = async (userId) => {
    if (!selectedDept) return;
    setAssigning(userId);
    try {
      const res = await api.assignEmployeeToDept(selectedDept.id, userId);
      // Update departments list and selectedDept optimistically from response
      const updated = res.data;
      setDepartments(prev => prev.map(d => d.id === updated.id ? updated : d));
      setSelectedDept(updated);
    } catch (err) {
      console.error('Failed to assign', err);
    } finally {
      setAssigning(null);
    }
  };

  const handleRemove = async (userId) => {
    if (!selectedDept) return;
    setAssigning(userId);
    try {
      const res = await api.removeEmployeeFromDept(selectedDept.id, userId);
      const updated = res.data;
      setDepartments(prev => prev.map(d => d.id === updated.id ? updated : d));
      setSelectedDept(updated);
    } catch (err) {
      console.error('Failed to remove', err);
    } finally {
      setAssigning(null);
    }
  };

  // Employees already in this department
  const assignedIds = useMemo(
    () => new Set((selectedDept?.users || []).map(u => u.id)),
    [selectedDept]
  );

  // Employees NOT in any department OR already in this one — shown in the picker
  const availableToAssign = useMemo(() => {
    if (!selectedDept) return [];
    return users.filter(u => {
      const matchesSearch = u.name.toLowerCase().includes(assignSearch.toLowerCase());
      // Show employees who are unassigned or already in this dept
      const inThisDept = assignedIds.has(u.id);
      const unassigned = !departments.some(d => d.id !== selectedDept.id && (d.users || []).some(du => du.id === u.id));
      return matchesSearch && (inThisDept || unassigned);
    });
  }, [users, assignSearch, assignedIds, departments, selectedDept]);

  return (
    <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} className="space-y-6">
      <div className="flex justify-between items-end">
        <div>
          <h2 className="text-2xl font-bold tracking-tight text-neutral-900">Departments</h2>
          <p className="text-neutral-500 mt-1">Manage departments and assign employees.</p>
        </div>
        <Button onClick={() => { setEditingId(null); setForm({ name: '', shift_id: '', lead_id: '' }); setShowModal(true); }} className="flex items-center gap-2">
          <Plus size={16} /> Add Department
        </Button>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
        {loading ? (
          <p>Loading...</p>
        ) : departments.length === 0 ? (
          <p className="text-neutral-500 col-span-3">No departments found.</p>
        ) : (
          departments.map((dept) => (
            <Card
              key={dept.id}
              className="relative group cursor-pointer hover:ring-2 hover:ring-primary-500 transition-all overflow-hidden"
              onClick={() => { setSelectedDept(dept); setAssignSearch(''); }}
            >
              <CardBody className="p-6">
                <div className="flex justify-between items-start mb-4">
                  <div className="w-12 h-12 bg-primary-50 rounded-xl flex items-center justify-center">
                    <Building2 className="w-6 h-6 text-primary-600" />
                  </div>
                  <div className="flex gap-2 opacity-0 group-hover:opacity-100 transition-opacity">
                    <button
                      onClick={(e) => { e.stopPropagation(); openEdit(dept); }}
                      className="p-1.5 bg-white shadow-sm rounded-lg text-neutral-400 hover:text-blue-600 transition-colors border border-neutral-100"
                    >
                      <Edit2 size={16} />
                    </button>
                    <button
                      onClick={(e) => { e.stopPropagation(); handleDelete(dept.id); }}
                      className="p-1.5 bg-white shadow-sm rounded-lg text-neutral-400 hover:text-red-600 transition-colors border border-neutral-100"
                    >
                      <Trash2 size={16} />
                    </button>
                  </div>
                </div>

                <h3 className="text-lg font-bold text-neutral-900">{dept.name}</h3>

                <div className="mt-3 space-y-2">
                  <div className="flex items-center gap-2 text-sm text-neutral-600">
                    <Star size={14} className="text-yellow-500 fill-yellow-500" />
                    <span className="font-medium">Lead: {dept.lead?.name || 'Unassigned'}</span>
                  </div>
                  <p className="text-sm text-neutral-500">Shift: {dept.shift?.name || 'Unassigned'}</p>
                </div>

                <div className="mt-4 pt-4 border-t border-neutral-100 flex justify-between items-center">
                  <p className="text-sm font-medium text-neutral-700">
                    <span className="text-primary-600 font-bold">{dept.users?.length || 0}</span> Employees
                  </p>
                  <Badge variant={dept.lead_id ? 'success' : 'neutral'}>
                    {dept.lead_id ? 'Has Lead' : 'No Lead'}
                  </Badge>
                </div>
              </CardBody>
            </Card>
          ))
        )}
      </div>

      {/* Edit / Create Modal */}
      {showModal && (
        <Modal isOpen={true} title={editingId ? 'Edit Department' : 'Add Department'} onClose={() => setShowModal(false)}>
          <form onSubmit={handleSubmit} className="space-y-4">
            <Input
              label="Department Name"
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              required
            />
            <div className="space-y-1">
              <label className="block text-sm font-medium text-neutral-700">Assign Department Lead</label>
              <select
                value={form.lead_id}
                onChange={(e) => setForm({ ...form, lead_id: e.target.value })}
                className="w-full px-3 py-2 bg-neutral-50 border border-neutral-300 rounded-lg focus:ring-2 focus:ring-primary-500 outline-none transition-all"
              >
                <option value="">Select a Lead (Optional)</option>
                {users.map(u => (
                  <option key={u.id} value={u.id}>{u.name} ({u.role})</option>
                ))}
              </select>
              <p className="text-xs text-neutral-500 italic">Leads can approve disputes for this department.</p>
            </div>
            <Input
              label="Shift ID"
              type="number"
              value={form.shift_id}
              onChange={(e) => setForm({ ...form, shift_id: e.target.value })}
              placeholder="1 for Day, 2 for Night"
            />
            <div className="flex justify-end gap-3 pt-4">
              <Button type="button" variant="outline" onClick={() => setShowModal(false)}>Cancel</Button>
              <Button type="submit">Save Changes</Button>
            </div>
          </form>
        </Modal>
      )}

      {/* Department Detail Modal */}
      <AnimatePresence>
        {selectedDept && (
          <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50 backdrop-blur-sm">
            <motion.div
              initial={{ opacity: 0, scale: 0.95, y: 20 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.95, y: 20 }}
              style={{ maxWidth: '40rem' }} className="bg-white rounded-2xl shadow-2xl w-full max-h-[90vh] flex flex-col overflow-hidden"
            >
              {/* Header */}
              <div className="p-6 border-b border-neutral-100 flex justify-between items-center bg-neutral-50/50">
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 bg-primary-100 rounded-xl flex items-center justify-center">
                    <Building2 className="w-5 h-5 text-primary-600" />
                  </div>
                  <div>
                    <h3 className="text-xl font-bold text-neutral-900">{selectedDept.name}</h3>
                    <p className="text-sm text-neutral-500">{selectedDept.users?.length || 0} employees assigned</p>
                  </div>
                </div>
                <button onClick={() => setSelectedDept(null)} className="p-2 hover:bg-neutral-100 rounded-lg text-neutral-400 hover:text-neutral-600 transition-colors">
                  <X size={20} />
                </button>
              </div>

              <div className="flex-1 overflow-y-auto p-6 space-y-6">
                {/* Lead */}
                <div className="p-4 bg-primary-50 rounded-xl border border-primary-100 flex items-center gap-4">
                  <div className="w-10 h-10 bg-white rounded-full flex items-center justify-center text-primary-600 shadow-sm">
                    <UserCheck size={20} />
                  </div>
                  <div>
                    <p className="text-xs font-bold text-primary-600 uppercase">Department Lead</p>
                    <p className="text-base font-bold text-neutral-900">{selectedDept.lead?.name || 'Not Assigned'}</p>
                  </div>
                </div>

                {/* Current Members */}
                <div>
                  <h4 className="text-sm font-bold text-neutral-700 uppercase tracking-wider mb-3 flex items-center gap-2">
                    <UserCheck size={14} /> Current Members ({selectedDept.users?.length || 0})
                  </h4>
                  {selectedDept.users?.length > 0 ? (
                    <div className="divide-y divide-neutral-100 bg-neutral-50 rounded-xl border border-neutral-200 overflow-hidden">
                      {selectedDept.users.map((user) => (
                        <div key={user.id} className="px-4 py-3 flex justify-between items-center hover:bg-white transition-colors">
                          <div>
                            <p className="font-medium text-neutral-900">{user.name}</p>
                            <p className="text-xs text-neutral-500 capitalize">{user.role}</p>
                          </div>
                          <div className="flex items-center gap-2">
                            {user.id === selectedDept.lead_id && (
                              <Badge variant="success">Lead</Badge>
                            )}
                            <button
                              onClick={() => handleRemove(user.id)}
                              disabled={assigning === user.id}
                              className="p-1.5 rounded-lg text-neutral-400 hover:text-red-600 hover:bg-red-50 transition-colors disabled:opacity-50"
                              title="Remove from department"
                            >
                              {assigning === user.id ? (
                                <span className="text-xs">…</span>
                              ) : (
                                <UserMinus size={15} />
                              )}
                            </button>
                          </div>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div className="text-center py-6 text-neutral-400 bg-neutral-50 rounded-xl border border-dashed border-neutral-200">
                      No employees assigned yet.
                    </div>
                  )}
                </div>

                {/* Add Employees */}
                <div>
                  <h4 className="text-sm font-bold text-neutral-700 uppercase tracking-wider mb-3 flex items-center gap-2">
                    <UserPlus size={14} /> Add Employees
                  </h4>
                  <div className="relative mb-3">
                    <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-neutral-400" />
                    <input
                      type="text"
                      placeholder="Search employees..."
                      value={assignSearch}
                      onChange={(e) => setAssignSearch(e.target.value)}
                      className="w-full pl-9 pr-4 py-2 bg-neutral-50 border border-neutral-200 rounded-lg text-sm focus:ring-2 focus:ring-primary-500 focus:bg-white outline-none transition-all"
                    />
                  </div>
                  <div className="divide-y divide-neutral-100 bg-neutral-50 rounded-xl border border-neutral-200 overflow-hidden max-h-52 overflow-y-auto">
                    {availableToAssign.length === 0 ? (
                      <p className="text-center py-4 text-sm text-neutral-400">No employees found.</p>
                    ) : (
                      availableToAssign.map((user) => {
                        const isAssigned = assignedIds.has(user.id);
                        return (
                          <div key={user.id} className="px-4 py-3 flex justify-between items-center hover:bg-white transition-colors">
                            <div>
                              <p className="font-medium text-neutral-900">{user.name}</p>
                              <p className="text-xs text-neutral-500 capitalize">{user.role}</p>
                            </div>
                            {isAssigned ? (
                              <Badge variant="success">Assigned</Badge>
                            ) : (
                              <button
                                onClick={() => handleAssign(user.id)}
                                disabled={assigning === user.id}
                                className="flex items-center gap-1 px-3 py-1.5 text-xs font-medium bg-primary-600 text-white rounded-lg hover:bg-primary-700 transition-colors disabled:opacity-50"
                              >
                                {assigning === user.id ? '…' : <><UserPlus size={13} /> Add</>}
                              </button>
                            )}
                          </div>
                        );
                      })
                    )}
                  </div>
                </div>
              </div>

              <div className="p-4 border-t border-neutral-100 bg-neutral-50/50 flex justify-end">
                <Button variant="outline" onClick={() => setSelectedDept(null)}>Close</Button>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>
    </motion.div>
  );
};
