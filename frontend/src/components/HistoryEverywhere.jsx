import React, { useState, useEffect } from 'react';
import {
  Users,
  Calendar,
  DollarSign,
  Activity,
  ShieldCheck,
  TrendingDown,
  Clock,
  ArrowRight,
  TrendingUp,
  XCircle
} from 'lucide-react';
import api from '../services/api';
import { AttendanceFilters } from './common/AttendanceFilters';

function HistoryEverywhere({ report, attendance }) {
  const [selectedUserId, setSelectedUserId] = useState(null);
  const [userAttendanceRecords, setUserAttendanceRecords] = useState([]);
  const [loadingRecords, setLoadingRecords] = useState(false);
  const [filters, setFilters] = useState({ category: 'all', startDate: '', endDate: '' });

  useEffect(() => {
    if (selectedUserId) {
      fetchUserRecords(filters.startDate, filters.endDate, filters.category);
    }
  }, [selectedUserId, filters]);

  const fetchUserRecords = async (start, end, status) => {
    setLoadingRecords(true);
    try {
      const res = await api.getUserAttendanceRecords(selectedUserId, start, end, status);
      setUserAttendanceRecords(res.data);
    } catch (err) {
      console.error('Error fetching user records:', err);
      setUserAttendanceRecords([]);
    }
    setLoadingRecords(false);
  };

  const selectedData = report.find(r => r.id === selectedUserId);

  return (
    <div style={{ display: 'grid', gridTemplateColumns: selectedUserId ? '300px 1fr' : '1fr', gap: '2rem' }}>
      {/* Sidebar: User List */}
      <div className="glass-panel" style={{ height: 'fit-content' }}>
        <h3 style={{ marginBottom: '1.5rem', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
          <Users size={20} color="#38bdf8" /> Select Employee
        </h3>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
          {report.map(emp => (
            <button
              key={emp.id}
              className={`btn ${selectedUserId === emp.id ? 'btn-primary' : ''}`}
              onClick={() => setSelectedUserId(emp.id)}
              style={{ justifyContent: 'space-between', padding: '0.8rem' }}
            >
              <span>{emp.name}</span>
              <ArrowRight size={16} />
            </button>
          ))}
        </div>
      </div>

      {/* Main Analysis View */}
      {selectedUserId ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '2rem' }}>
          {/* Quick Stats Grid */}
          <div className="dashboard-grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))' }}>
            <div className="glass-panel" style={{ borderColor: 'rgba(56, 189, 248, 0.3)' }}>
              <TrendingUp size={20} color="#38bdf8" />
              <div style={{ fontSize: '1.8rem', fontWeight: 800, margin: '0.5rem 0' }}>{selectedData.worked_days}</div>
              <p style={{ color: '#94a3b8', fontSize: '0.9rem' }}>Presents (Days)</p>
            </div>
            <div className="glass-panel" style={{ borderColor: 'rgba(244, 63, 94, 0.3)' }}>
              <XCircle size={20} color="#f43f5e" />
              <div style={{ fontSize: '1.8rem', fontWeight: 800, margin: '0.5rem 0' }}>{selectedData.absent_days}</div>
              <p style={{ color: '#94a3b8', fontSize: '0.9rem' }}>Absents (Total)</p>
            </div>
            <div className="glass-panel" style={{ borderColor: 'rgba(74, 222, 128, 0.3)' }}>
              <ShieldCheck size={20} color="#4ade80" />
              <div style={{ fontSize: '1.8rem', fontWeight: 800, margin: '0.5rem 0' }}>{selectedData.paid_leaves_used}</div>
              <p style={{ color: '#94a3b8', fontSize: '0.9rem' }}>Leaves Used</p>
            </div>
            <div className="glass-panel" style={{ borderColor: 'rgba(129, 140, 248, 0.3)' }}>
              <ShieldCheck size={20} color="#818cf8" />
              <div style={{ fontSize: '1.8rem', fontWeight: 800, margin: '0.5rem 0' }}>{selectedData.remaining_leaves}</div>
              <p style={{ color: '#94a3b8', fontSize: '0.9rem' }}>Leaves Remaining</p>
            </div>
          </div>

          {/* Salary Breakdown Card */}
          <div className="glass-panel" style={{ background: 'linear-gradient(135deg, rgba(15, 23, 42, 0.8), rgba(30, 41, 59, 0.8))' }}>
            <h3 style={{ marginBottom: '1.5rem', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
              <DollarSign size={20} color="#fbbf24" /> Salary Details
            </h3>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(250px, 1fr))', gap: '2rem' }}>
              <div style={{ padding: '1.5rem', borderRadius: '15px', background: 'rgba(255,255,255,0.03)' }}>
                <p style={{ color: '#94a3b8', marginBottom: '0.5rem' }}>Base Monthly Salary</p>
                <div style={{ fontSize: '1.5rem', fontWeight: 600 }}>Rs. {selectedData.monthly_salary.toLocaleString()}</div>
              </div>
              <div style={{ padding: '1.5rem', borderRadius: '15px', background: 'rgba(244, 63, 94, 0.05)' }}>
                <p style={{ color: '#f43f5e', marginBottom: '0.5rem' }}>Total Deductions</p>
                <div style={{ fontSize: '1.5rem', fontWeight: 600, color: '#f43f5e' }}>- Rs. {selectedData.deductions.toLocaleString()}</div>
                <p style={{ fontSize: '0.75rem', color: '#94a3b8', marginTop: '0.5rem' }}>
                  {selectedData.unpaid_absences} Unpaid Absents
                </p>
              </div>
              <div style={{ padding: '1.5rem', borderRadius: '15px', background: 'rgba(56, 189, 248, 0.1)', border: '1px solid rgba(56, 189, 248, 0.2)' }}>
                <p style={{ color: '#38bdf8', marginBottom: '0.5rem' }}>Net Payable Amount</p>
                <div style={{ fontSize: '2rem', fontWeight: 800, color: '#38bdf8' }}>Rs. {selectedData.total_salary.toLocaleString()}</div>
              </div>
            </div>
          </div>

          {/* Detailed Attendance Records for this user */}
          <div className="glass-panel">
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1.5rem' }}>
              <h3 style={{ margin: 0, display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                <Clock size={20} color="#818cf8" /> Attendance Records
              </h3>
            </div>
            
            <AttendanceFilters onFilterChange={setFilters} />

            {loadingRecords ? (
              <div style={{ color: '#94a3b8', textAlign: 'center', padding: '2rem' }}>Loading records...</div>
            ) : userAttendanceRecords.length === 0 ? (
              <div style={{ color: '#94a3b8', textAlign: 'center', padding: '2rem' }}>No attendance records found.</div>
            ) : (
              <table>
                <thead>
                  <tr>
                    <th>Date</th>
                    <th>Check-In</th>
                    <th>Check-Out</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {userAttendanceRecords.slice(0, 15).map((record, i) => (
                    <tr key={i}>
                      <td>{new Date(record.date).toLocaleDateString()}</td>
                      <td>
                        {record.check_in_time ? (
                          <span className={`badge ${record.is_late ? 'badge-warning' : 'badge-success'}`}>
                            {record.check_in_time} {record.is_late && '(Late)'}
                          </span>
                        ) : (
                          <span style={{ color: '#94a3b8' }}>--:--</span>
                        )}
                      </td>
                      <td>
                        {record.check_out_time ? (
                          <span className={`badge ${record.is_halfday ? 'badge-warning' : 'badge-info'}`}>
                            {record.check_out_time} {record.is_halfday && '(Half-day)'}
                          </span>
                        ) : (
                          <span style={{ color: '#94a3b8' }}>--:--</span>
                        )}
                      </td>
                      <td>
                        <span className={`badge ${record.status === 'present' ? 'badge-success' :
                            record.status === 'leave' ? 'badge-success' :
                              'badge-danger'
                          }`}>
                          {record.status.toUpperCase()}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>
      ) : (
        <div className="glass-panel" style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: '5rem', color: '#94a3b8' }}>
          <Activity size={50} style={{ marginBottom: '1rem', opacity: 0.2 }} />
          <h3>Select an employee to see their history</h3>
          <p>Complete breakdown of attendance, leave patterns, and salary deductions.</p>
        </div>
      )}
    </div>
  );
}

export default HistoryEverywhere;
