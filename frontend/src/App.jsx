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
import { CallProvider } from './context/CallContext';
import CallOverlay from './components/calls/CallOverlay';
import NotificationSoundBridge from './components/notifications/NotificationSoundBridge';

function App() {
  // Read the stored session once. A session saved before signed tokens were
  // introduced carries no token and therefore cannot authenticate anything
  // that requires a verified identity (voice/video calling). Rather than leave
  // the user half-signed-in, discard it and ask them to sign in again — the
  // token is then issued and stored with the session.
  const [boot] = useState(() => {
    const saved = localStorage.getItem('bio_auth');
    if (!saved) return { auth: null, needsRelogin: false };
    try {
      const parsed = JSON.parse(saved);
      if (!parsed.token) {
        localStorage.removeItem('bio_auth');
        return { auth: null, needsRelogin: true };
      }
      return { auth: parsed, needsRelogin: false };
    } catch {
      localStorage.removeItem('bio_auth');
      return { auth: null, needsRelogin: false };
    }
  });

  const [auth, setAuth] = useState(boot.auth);
  const [needsRelogin] = useState(boot.needsRelogin);
  const [activeTab, setActiveTab] = useState('dashboard');
  const [employees, setEmployees] = useState([]);
  const [report, setReport] = useState([]);
  const [loading, setLoading] = useState(false);
  const [selectedUser, setSelectedUser] = useState(null);

  const fetchData = useCallback(async (month = null) => {
    setLoading(true);
    try {
      const now = new Date();
      console.log(month);
      // Set default to current month
      const start = month ? month.start : formatDateLocal(new Date(now.getFullYear(), now.getMonth(), 1));
      const end = month ? month.end : formatDateLocal(new Date(now.getFullYear(), now.getMonth() + 1, 0));

      const [empRes, repRes] = await Promise.all([
        api.getEmployees(),
        api.getSalaryReport(start, end)
      ]);
      setEmployees(empRes.data);
      setReport(repRes.data);
    } catch {
      console.error("Failed to fetch data");
    }
    setLoading(false);
  }, []);

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
    return (
      <LoginNew
        onLoginSuccess={handleLoginSuccess}
        notice={
          needsRelogin
            ? 'Your session was saved before signed sign-in was introduced. Please sign in again to enable calling.'
            : null
        }
      />
    );
  }

  // 2. Employee View - New Design
  // 3. Admin View - New Design
  //
  // Both are wrapped in <CallProvider> so the calling feature is available
  // over every tab, and <CallOverlay> renders the call UI above them.
  return (
    <CallProvider user={auth}>
      <NotificationSoundBridge userId={auth.user_id} />

      {auth.role === 'employee' && (
        <EmployeeDashboardNew user={auth} onLogout={handleLogout} />
      )}

      {auth.role === 'admin' && (
        <AdminDashboardNew
          employees={employees}
          report={report}
          user={auth}
          onLogout={handleLogout}
          onRefresh={fetchData}
        />
      )}

      <CallOverlay />
    </CallProvider>
  );
}

export default App;
