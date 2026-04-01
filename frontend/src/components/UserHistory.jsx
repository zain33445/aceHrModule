import React, { useState, useEffect } from 'react';
import { ArrowLeft, Clock, Calendar } from 'lucide-react';
import api from '../services/api';
import { formatTime12h } from '../utils/formatters';

function UserHistory({ user, onBack }) {
  const [logs, setLogs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [filterType, setFilterType] = useState('current');
  const [customRange, setCustomRange] = useState({ start: '', end: '' });

  useEffect(() => {
    fetchLogs();
  }, [user, filterType, customRange]);

  const fetchLogs = async () => {
    setLoading(true);
    try {
      let start = null;
      let end = null;

      const now = new Date();
      if (filterType === 'current') {
        start = new Date(now.getFullYear(), now.getMonth(), 1).toISOString().split('T')[0];
        end = new Date(now.getFullYear(), now.getMonth() + 1, 0).toISOString().split('T')[0];
      } else if (filterType === 'previous') {
        start = new Date(now.getFullYear(), now.getMonth() - 1, 1).toISOString().split('T')[0];
        end = new Date(now.getFullYear(), now.getMonth(), 0).toISOString().split('T')[0];
      } else if (filterType === 'custom' && customRange.start && customRange.end) {
        start = customRange.start;
        end = customRange.end;
      }

      // Using attendance records (from AttendanceRecord table, not raw AttendanceLog)
      const res = await api.getUserAttendanceRecords(user.id, start, end);
      setLogs(res.data);
    } catch (err) {
      console.error("Failed to fetch user history", err);
    }
    setLoading(false);
  };

  return (
    <div className="glass-panel">
      <div style={{ display: 'flex', alignItems: 'center', gap: '1rem', marginBottom: '2rem' }}>
        <button className="btn" onClick={onBack} style={{ padding: '0.5rem', borderRadius: '50%', background: 'rgba(255,255,255,0.05)' }}>
          <ArrowLeft size={20} color="#38bdf8" />
        </button>
        <div>
          <h3 style={{ margin: 0 }}>Attendance History: {user.name}</h3>
          <p style={{ color: '#94a3b8', fontSize: '0.8rem', margin: 0 }}>User ID: {user.id}</p>
        </div>
      </div>

      {/* Date Filters */}
      <div style={{ marginBottom: '1.5rem', padding: '1rem', background: 'rgba(0,0,0,0.2)', borderRadius: '10px' }}>
        <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap', alignItems: 'center' }}>
          <button
            className={`btn btn-sm ${filterType === 'current' ? 'btn-primary' : ''}`}
            onClick={() => setFilterType('current')}
          >
            Current Month
          </button>
          <button
            className={`btn btn-sm ${filterType === 'previous' ? 'btn-primary' : ''}`}
            onClick={() => setFilterType('previous')}
          >
            Prev Month
          </button>
          <button
            className={`btn btn-sm ${filterType === 'custom' ? 'btn-primary' : ''}`}
            onClick={() => setFilterType('custom')}
          >
            Custom Date
          </button>

          {filterType === 'custom' && (
            <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
              <input
                type="date"
                className="input-field"
                style={{ padding: '0.5rem', width: 'auto' }}
                value={customRange.start}
                onChange={(e) => setCustomRange({ ...customRange, start: e.target.value })}
              />
              <span style={{ color: '#94a3b8' }}>to</span>
              <input
                type="date"
                className="input-field"
                style={{ padding: '0.5rem', width: 'auto' }}
                value={customRange.end}
                onChange={(e) => setCustomRange({ ...customRange, end: e.target.value })}
              />
            </div>
          )}
        </div>
      </div>

      {loading ? (
        <div style={{ padding: '2rem', textAlign: 'center', color: '#94a3b8' }}>Loading historical logs...</div>
      ) : logs.length === 0 ? (
        <div style={{ padding: '2rem', textAlign: 'center', color: '#94a3b8' }}>No logs found for this user.</div>
      ) : (
        <table>
          <thead>
            <tr>
              <th><Calendar size={14} style={{ verticalAlign: 'middle', marginRight: '4px' }} /> Date</th>
              <th>Check-In</th>
              <th>Check-Out</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {logs.map((record, i) => {
              return (
                <tr key={i}>
                  <td>{new Date(record.date).toLocaleDateString()}</td>
                  <td>
                    {record.check_in_time ? (
                      <span className={`badge ${record.is_late ? 'badge-warning' : 'badge-success'}`}>
                        {formatTime12h(record.check_in_time)} {record.is_late && '(Late)'}
                      </span>
                    ) : (
                      <span style={{ color: '#94a3b8' }}>--:--</span>
                    )}
                  </td>
                  <td>
                    {record.check_out_time ? (
                      <span className={`badge ${record.is_halfday ? 'badge-warning' : 'badge-info'}`}>
                        {formatTime12h(record.check_out_time)} {record.is_halfday && '(Half-day)'}
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
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}

export default UserHistory;
