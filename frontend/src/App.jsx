import React, { useState, useEffect, useCallback } from 'react';
import { Activity, LayoutDashboard, Users, DollarSign, Clock, LogOut } from 'lucide-react';
import api from './services/api';
import { formatDateLocal } from './utils/formatters';

import StaffManager from './components/StaffManager';
import PayrollExpert from './components/PayrollExpert';
import UserHistory from './components/UserHistory';
import HistoryEverywhere from './components/HistoryEverywhere';
import LoginNew from './components/LoginNew';
import EmployeeDashboardNew from './components/EmployeeDashboardNew';
import AdminDashboardNew from './components/AdminDashboardNew';

function App() {
  const [auth, setAuth] = useState(() => {
    const saved = localStorage.getItem('bio_auth');
    return saved ? JSON.parse(saved) : null;
  });
  const [activeTab, setActiveTab] = useState('dashboard');
  const [employees, setEmployees] = useState([]);
  const [report, setReport] = useState([]);
  const [loading, setLoading] = useState(false);
  const [selectedUser, setSelectedUser] = useState(null);

  const fetchData = useCallback(async () => {
    setLoading(true);
    try {
      let start = null;
      let end = null;
      const now = new Date();

      // Set default to current month
      start = formatDateLocal(new Date(now.getFullYear(), now.getMonth(), 1));
      end = formatDateLocal(new Date(now.getFullYear(), now.getMonth() + 1, 0));

      if (activeTab === 'dashboard' || activeTab === 'history' || activeTab === 'salary') {
        const [empRes, repRes] = await Promise.all([
          api.getEmployees(),
          api.getSalaryReport(start, end)
        ]);
        setEmployees(empRes.data);
        setReport(repRes.data);
      } else if (activeTab === 'employees') {
        const empRes = await api.getEmployees();
        setEmployees(empRes.data);
      }
    } catch {
      console.error("Failed to fetch data");
    }
    setLoading(false);
  }, [activeTab]);

  useEffect(() => {
    if (auth?.role === 'admin') {
      fetchData();
    }
    
    // Pass user ID to Electron Desktop Monitor if available
    if (auth && auth.user_id && window.electronAPI) {
      window.electronAPI.setUserId(auth.user_id);
    }
  }, [auth, fetchData]);

  const handleLoginSuccess = (authData) => {
    setAuth(authData);
    localStorage.setItem('bio_auth', JSON.stringify(authData));
    
    // Pass user ID to Electron Desktop Monitor immediately on login
    if (authData && authData.user_id && window.electronAPI) {
      window.electronAPI.setUserId(authData.user_id);
    }
  };

  const handleLogout = () => {
    setAuth(null);
    localStorage.removeItem('bio_auth');
  };

  const handleUpdateSetting = async (userId, value, key) => {
    try {
      if (key === 'monthly_salary') {
        await api.updateEmployee(userId, value);
      } else if (key === 'leave_bank') {
        await api.updateLeaves(userId, value);
      }
      fetchData();
    } catch {
      alert("Failed to update setting");
    }
  };

  const handleUpdatePassword = async (userId, newPassword) => {
    try {
      await api.updatePassword(userId, newPassword);
      fetchData();
    } catch {
      alert("Failed to update password");
    }
  };

  const showHistory = (user) => {
    setSelectedUser(user);
    setActiveTab('history_drilldown');
  };

  // 1. Login View
  if (!auth) {
    return <LoginNew onLoginSuccess={handleLoginSuccess} />;
  }

  // 2. Employee View - New Design
  if (auth.role === 'employee') {
    return <EmployeeDashboardNew user={auth} onLogout={handleLogout} />;
  }

  // 3. Admin View - New Design
  if (auth.role === 'admin') {
    return <AdminDashboardNew employees={employees} report={report} user={auth} onLogout={handleLogout} onRefresh={fetchData} />;
  }

  return null;
}

export default App;
