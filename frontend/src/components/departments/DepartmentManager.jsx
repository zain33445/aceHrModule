import React, { useState, useEffect } from 'react';
import { motion } from 'framer-motion';
import { Building2, Plus, Edit2, Trash2, UserCheck, Star } from 'lucide-react';
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

  const fetchData = async () => {
    setLoading(true);
    try {
      const [deptRes, userRes] = await Promise.all([
        api.getDepartments(),
        api.getUsers() // Assuming this exists or using a similar endpoint
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
    setForm({ 
      name: dept.name, 
      shift_id: dept.shift_id || '', 
      lead_id: dept.lead_id || '' 
    });
    setEditingId(dept.id);
    setShowModal(true);
  };

  return (
    <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} className="space-y-6">
      <div className="flex justify-between items-end">
        <div>
          <h2 className="text-2xl font-bold tracking-tight text-neutral-900">Departments</h2>
          <p className="text-neutral-500 mt-1">Manage company departments and assign leads.</p>
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
              onClick={() => setSelectedDept(dept)}
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
                  <p className="text-sm text-neutral-500">
                    Shift: {dept.shift?.name || 'Unassigned'}
                  </p>
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

      {showModal && (
        <Modal
          isOpen={true}
          title={editingId ? 'Edit Department' : 'Add Department'}
          onClose={() => setShowModal(false)}
        >
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
              <p className="text-xs text-neutral-500 italic">Leads will be able to approve disputes for this department.</p>
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

      {selectedDept && (
        <Modal
          isOpen={true}
          title={`Department: ${selectedDept.name}`}
          onClose={() => setSelectedDept(null)}
        >
          <div className="space-y-6">
            {/* Lead Section */}
            <div className="p-4 bg-primary-50 rounded-xl border border-primary-100 flex items-center gap-4">
              <div className="w-12 h-12 bg-white rounded-full flex items-center justify-center text-primary-600 shadow-sm">
                <UserCheck size={24} />
              </div>
              <div>
                <p className="text-xs font-bold text-primary-600 uppercase">Department Lead</p>
                <p className="text-lg font-bold text-neutral-900">{selectedDept.lead?.name || 'Not Assigned'}</p>
              </div>
            </div>

            {/* Employees List */}
            <div>
              <h4 className="text-sm font-bold text-neutral-900 mb-3 uppercase tracking-wider">Employee List ({selectedDept.users?.length || 0})</h4>
              {selectedDept.users && selectedDept.users.length > 0 ? (
                <div className="divide-y divide-neutral-100 bg-neutral-50 rounded-xl border border-neutral-200 overflow-hidden">
                  {selectedDept.users.map((user) => (
                    <div key={user.id} className="px-4 py-3 flex justify-between items-center hover:bg-white transition-colors">
                      <div>
                        <p className="font-medium text-neutral-900">{user.name}</p>
                        <p className="text-xs text-neutral-500 uppercase tracking-wider">{user.role}</p>
                      </div>
                      <Badge variant={user.id === selectedDept.lead_id ? 'success' : 'neutral'}>
                        {user.id === selectedDept.lead_id ? 'Lead' : user.id}
                      </Badge>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="text-center py-8">
                  <p className="text-neutral-500">No employees assigned yet.</p>
                </div>
              )}
            </div>

            <div className="flex justify-end pt-2">
              <Button variant="outline" onClick={() => setSelectedDept(null)}>Close</Button>
            </div>
          </div>
        </Modal>
      )}
    </motion.div>
  );
};
