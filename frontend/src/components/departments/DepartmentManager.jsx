import React, { useState, useEffect } from 'react';
import { motion } from 'framer-motion';
import { Building2, Plus, Edit2, Trash2 } from 'lucide-react';
import { Card, CardHeader, CardBody } from '../common/Card';
import { Button } from '../common/Button';
import { Modal, Input, Badge } from '../common';
import api from '../../services/api';

export const DepartmentManager = () => {
  const [departments, setDepartments] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showModal, setShowModal] = useState(false);
  const [form, setForm] = useState({ name: '', shift_id: '' });
  const [editingId, setEditingId] = useState(null);
  const [selectedDept, setSelectedDept] = useState(null);

  const fetchDepartments = async () => {
    try {
      const res = await api.getDepartments();
      setDepartments(res.data);
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchDepartments();
  }, []);

  const handleSubmit = async (e) => {
    e.preventDefault();
    try {
      if (editingId) {
        await api.updateDepartment(editingId, form);
      } else {
        await api.createDepartment(form);
      }
      setShowModal(false);
      fetchDepartments();
      setForm({ name: '', shift_id: '' });
      setEditingId(null);
    } catch (error) {
      console.error('Failed to save department', error);
    }
  };

  const handleDelete = async (id) => {
    if (window.confirm('Are you sure you want to delete this department?')) {
      try {
        await api.deleteDepartment(id);
        fetchDepartments();
      } catch (error) {
        console.error('Failed to delete', error);
      }
    }
  };

  const openEdit = (dept) => {
    setForm({ name: dept.name, shift_id: dept.shift_id || '' });
    setEditingId(dept.id);
    setShowModal(true);
  };

  return (
    <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} className="space-y-6">
      <div className="flex justify-between items-end">
        <div>
          <h2 className="text-2xl font-bold tracking-tight text-neutral-900">Departments</h2>
          <p className="text-neutral-500 mt-1">Manage company departments and shifts.</p>
        </div>
        <Button onClick={() => { setEditingId(null); setForm({ name: '', shift_id: '' }); setShowModal(true); }} className="flex items-center gap-2">
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
              className="relative group cursor-pointer hover:ring-2 hover:ring-primary-500 transition-all"
              onClick={() => setSelectedDept(dept)}
            >
              <CardBody className="p-6">
                <div className="flex justify-between items-start mb-4">
                  <div className="w-12 h-12 bg-primary-100 rounded-lg flex items-center justify-center">
                    <Building2 className="w-6 h-6 text-primary-600" />
                  </div>
                  <div className="flex gap-2 opacity-0 group-hover:opacity-100 transition-opacity">
                    <button 
                      onClick={(e) => { e.stopPropagation(); openEdit(dept); }} 
                      className="p-1.5 text-neutral-400 hover:text-blue-600 transition-colors"
                    >
                      <Edit2 size={16} />
                    </button>
                    <button 
                      onClick={(e) => { e.stopPropagation(); handleDelete(dept.id); }} 
                      className="p-1.5 text-neutral-400 hover:text-red-600 transition-colors"
                    >
                      <Trash2 size={16} />
                    </button>
                  </div>
                </div>
                <h3 className="text-lg font-bold text-neutral-900">{dept.name}</h3>
                <p className="text-sm text-neutral-500 mt-1">
                  Shift: {dept.shift?.name || 'Unassigned'}
                </p>
                <div className="mt-4 pt-4 border-t border-neutral-100">
                  <p className="text-sm font-medium text-neutral-700">
                    <span className="text-primary-600 font-bold">{dept.users?.length || 0}</span> Employees
                  </p>
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
            <Input
              label="Shift ID"
              type="number"
              value={form.shift_id}
              onChange={(e) => setForm({ ...form, shift_id: e.target.value })}
              placeholder="1 for Day, 2 for Night"
            />
            <div className="flex justify-end gap-3 pt-4">
              <Button type="button" variant="outline" onClick={() => setShowModal(false)}>Cancel</Button>
              <Button type="submit">Save</Button>
            </div>
          </form>
        </Modal>
      )}

      {selectedDept && (
        <Modal
          isOpen={true}
          title={`Employees in ${selectedDept.name}`}
          onClose={() => setSelectedDept(null)}
        >
          <div className="space-y-4">
            {selectedDept.users && selectedDept.users.length > 0 ? (
              <div className="divide-y divide-neutral-100">
                {selectedDept.users.map((user) => (
                  <div key={user.id} className="py-3 flex justify-between items-center">
                    <div>
                      <p className="font-medium text-neutral-900">{user.name}</p>
                      <p className="text-xs text-neutral-500 uppercase tracking-wider">{user.role}</p>
                    </div>
                    <Badge variant={user.role === 'admin' ? 'primary' : 'neutral'}>
                      {user.id}
                    </Badge>
                  </div>
                ))}
              </div>
            ) : (
              <div className="text-center py-8">
                <p className="text-neutral-500">No employees assigned to this department.</p>
              </div>
            )}
            <div className="flex justify-end pt-4">
              <Button variant="outline" onClick={() => setSelectedDept(null)}>Close</Button>
            </div>
          </div>
        </Modal>
      )}
    </motion.div>
  );
};
