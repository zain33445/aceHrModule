import React, { useState } from 'react';
import { Trash2, UserPlus, AlertCircle, Eye, EyeOff } from 'lucide-react';
import api from '../services/api';

function StaffManager({ employees, onUpdate, onShowHistory, onUpdatePassword, onRefresh }) {
  const [showAddForm, setShowAddForm] = useState(false);
  const [newEmp, setNewEmp] = useState({ id: '', name: '', monthly_salary: 0, leave_bank: 5, password: '1234' });
  const [showPasswords, setShowPasswords] = useState({});
  const [error, setError] = useState('');

  const togglePassword = (id) => {
    setShowPasswords(prev => ({ ...prev, [id]: !prev[id] }));
  };

  const handleAddSubmit = async (e) => {
    e.preventDefault();
    setError('');
    if (!newEmp.id || !newEmp.name) {
      setError('ID and Name are required');
      return;
    }
    try {
      await api.createEmployee(newEmp);
      setShowAddForm(false);
      setNewEmp({ id: '', name: '', monthly_salary: 0, leave_bank: 5, password: '1234' });
      window.location.reload();
    } catch (err) {
      setError(err.response?.data?.detail || 'Failed to create employee');
    }
  };

  const handleDelete = async (id, name) => {
    if (window.confirm(`Are you sure you want to delete ${name}? This will also delete all their attendance logs.`)) {
      try {
        await api.deleteEmployee(id);
        if (onRefresh) onRefresh();
      } catch (err) {
        alert("Failed to delete employee");
      }
    }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '2rem' }}>
      {/* Add Employee Form Toggle */}
      <div className="glass-panel" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div>
          <h3 style={{ margin: 0 }}>Staff Management</h3>
          <p style={{ color: '#94a3b8', fontSize: '0.8rem', margin: '0.2rem 0 0' }}>Manage workforce records and settings.</p>
        </div>
        <button
          className={`btn ${showAddForm ? 'btn-secondary' : 'btn-primary'}`}
          onClick={() => setShowAddForm(!showAddForm)}
          style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}
        >
          <UserPlus size={18} /> {showAddForm ? 'Cancel' : 'Add New Staff'}
        </button>
      </div>

      {showAddForm && (
        <div className="glass-panel" style={{ border: '1px solid rgba(56, 189, 248, 0.3)' }}>
          <h4 style={{ marginBottom: '1.5rem' }}>Create New Employee Record</h4>
          <form onSubmit={handleAddSubmit} style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '1.5rem' }}>
            <div>
              <label style={{ display: 'block', fontSize: '0.8rem', color: '#94a3b8', marginBottom: '0.5rem' }}>Employee ID (ZK ID)</label>
              <input
                type="text" className="input-field" placeholder="e.g. 101"
                value={newEmp.id} onChange={e => setNewEmp({ ...newEmp, id: e.target.value })}
              />
            </div>
            <div>
              <label style={{ display: 'block', fontSize: '0.8rem', color: '#94a3b8', marginBottom: '0.5rem' }}>Full Name</label>
              <input
                type="text" className="input-field" placeholder="John Doe"
                value={newEmp.name} onChange={e => setNewEmp({ ...newEmp, name: e.target.value })}
              />
            </div>
            <div>
              <label style={{ display: 'block', fontSize: '0.8rem', color: '#94a3b8', marginBottom: '0.5rem' }}>Login Password</label>
              <input
                type="text" className="input-field" placeholder="1234"
                value={newEmp.password} onChange={e => setNewEmp({ ...newEmp, password: e.target.value })}
              />
            </div>
            <div style={{ display: 'flex', alignItems: 'flex-end' }}>
              <button type="submit" className="btn btn-primary" style={{ width: '100%' }}>Create Record</button>
            </div>
          </form>
          {error && <p style={{ color: '#f43f5e', fontSize: '0.8rem', marginTop: '1rem', display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
            <AlertCircle size={14} /> {error}
          </p>}
        </div>
      )}

      <div className="glass-panel">
        <table>
          <thead>
            <tr>
              <th>Name & ID</th>
              <th>Monthly Salary</th>
              <th>Leave Bank</th>
              <th>Access Key</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {employees.map(emp => (
              <tr key={emp.id}>
                <td>
                  <div style={{ fontWeight: 600 }}>{emp.name}</div>
                  <div style={{ fontSize: '0.75rem', color: '#94a3b8' }}>ID: {emp.id}</div>
                </td>
                <td>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                    <span style={{ color: '#94a3b8', fontSize: '0.8rem' }}>Rs.</span>
                    <input
                      type="number"
                      className="input-field"
                      defaultValue={emp.monthly_salary}
                      onBlur={(e) => onUpdate(emp.id, e.target.value, 'monthly_salary')}
                      style={{ width: '100px' }}
                    />
                  </div>
                </td>
                <td>
                  <input
                    type="number"
                    className="input-field"
                    defaultValue={emp.leave_bank}
                    onBlur={(e) => onUpdate(emp.id, e.target.value, 'leave_bank')}
                    style={{ width: '80px' }}
                  />
                </td>
                <td>
                  <div style={{ position: 'relative', display: 'flex', alignItems: 'center' }}>
                    <input
                      type={showPasswords[emp.id] ? "text" : "password"}
                      className="input-field"
                      defaultValue={emp.password_hash || emp.password}
                      onBlur={(e) => onUpdatePassword(emp.id, e.target.value)}
                      style={{ width: '120px', letterSpacing: showPasswords[emp.id] ? 'normal' : '2px', fontWeight: 600, paddingRight: '2rem' }}
                    />
                    <button 
                      type="button"
                      onClick={() => togglePassword(emp.id)}
                      style={{ position: 'absolute', right: '5px', background: 'none', border: 'none', color: '#94a3b8', cursor: 'pointer' }}
                    >
                      {showPasswords[emp.id] ? <EyeOff size={16} /> : <Eye size={16} />}
                    </button>
                  </div>
                </td>
                <td>
                  <div style={{ display: 'flex', gap: '0.5rem' }}>
                    <button
                      className="btn btn-primary"
                      style={{ padding: '0.4rem 0.8rem', fontSize: '0.8rem' }}
                      onClick={() => onShowHistory(emp)}
                    >
                      History
                    </button>
                    <button
                      className="btn"
                      style={{ padding: '0.4rem 0.8rem', fontSize: '0.8rem', background: 'rgba(244, 63, 94, 0.1)', color: '#f43f5e', border: '1px solid rgba(244, 63, 94, 0.2)' }}
                      onClick={() => handleDelete(emp.id, emp.name)}
                    >
                      <Trash2 size={14} />
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export default StaffManager;
