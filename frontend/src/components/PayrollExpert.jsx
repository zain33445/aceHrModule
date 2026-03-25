import React from 'react';
import { ShieldCheck, TrendingDown } from 'lucide-react';

function PayrollExpert({ report }) {
  return (
    <div className="glass-panel">
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '2rem' }}>
        <h3>Advanced Payroll Analysis (PKR)</h3>
        <span className="badge badge-info" style={{ padding: '0.5rem 1rem' }}>March 2026</span>
      </div>
      <table>
        <thead>
          <tr>
            <th>Employee</th>
            <th>Base Salary</th>
            <th>Deductions</th>
            <th>Leaves Used</th>
            <th>Bank Rem.</th>
            <th>Net Payable</th>
          </tr>
        </thead>
        <tbody>
          {report.map(row => (
            <tr key={row.id}>
              <td>
                <div style={{ fontWeight: 600 }}>{row.name}</div>
                <div style={{ fontSize: '0.75rem', color: '#94a3b8' }}>ID: {row.id}</div>
              </td>
              <td style={{ color: '#94a3b8' }}>Rs. {row.monthly_salary.toLocaleString()}</td>
              <td style={{ color: row.deductions > 0 ? '#f43f5e' : '#94a3b8' }}>
                Rs. {row.deductions.toLocaleString()}
              </td>
              <td>
                <div className="badge badge-success">{row.paid_leaves_used} d (Paid)</div>
              </td>
              <td>
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.3rem', color: '#4ade80' }}>
                   <ShieldCheck size={14} /> {row.remaining_leaves} d
                </div>
              </td>
              <td style={{ background: 'rgba(56, 189, 248, 0.05)' }}>
                <span style={{ color: '#38bdf8', fontWeight: 700, fontSize: '1.1rem' }}>
                  Rs. {row.total_salary.toLocaleString()}
                </span>
                {row.deductions > 0 && (
                   <div style={{ fontSize: '0.65rem', color: '#f43f5e', display: 'flex', alignItems: 'center' }}>
                     <TrendingDown size={10} /> Deductions Applied
                   </div>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default PayrollExpert;
