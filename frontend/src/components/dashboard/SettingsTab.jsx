import React, { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { 
  Shield, 
  Bell, 
  Lock, 
  CheckCircle2, 
  AlertCircle,
  Eye,
  EyeOff,
  UserCircle,
  Monitor
} from 'lucide-react';
import { Card, CardHeader, CardBody } from '../common/Card';
import { Input } from '../common/Input';
import { Button } from '../common/Button';
import Avatar from '../common/Avatar';
import api from '../../services/api';
import { SlideUp } from '../animations';

const NOTIFICATION_EVENT_TYPES = [
  { id: 'new_dispute', label: 'New Dispute Filed', desc: 'When an employee files a dispute' },
  { id: 'dispute_lead_approved', label: 'Dispute Lead Approval', desc: 'When a lead approves a dispute' },
  { id: 'dispute_approved', label: 'Dispute Fully Approved', desc: 'When admin/HR approves a dispute' },
  { id: 'new_leave_request', label: 'New Leave Request', desc: 'When an employee requests leave' },
  { id: 'lead_leave_decision', label: 'Lead Leave Decision', desc: 'When a lead acts on a leave request' },
  { id: 'admin_leave_decision', label: 'Admin Leave Decision', desc: 'When admin approves/rejects leave' },
  { id: 'new_overtime_request', label: 'New Overtime Request', desc: 'When an employee requests overtime' },
  { id: 'overtime_lead_decision', label: 'Overtime Lead Decision', desc: 'When a lead acts on overtime' },
  { id: 'overtime_admin_decision', label: 'Overtime Admin Decision', desc: 'When admin approves/rejects overtime' },
  { id: 'holiday_created', label: 'Holiday Announcements', desc: 'When a new holiday is created' },
  { id: 'salary_generated', label: 'Salary Processed', desc: 'When your salary is generated' },
  { id: 'new_message', label: 'New Chat Message', desc: 'When you receive a chat message' },
];

export const SettingsTab = ({ user }) => {
  const [activeSection, setActiveSection] = useState('security');
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [showPasswords, setShowPasswords] = useState(false);
  const [loading, setLoading] = useState(false);
  const [successMsg, setSuccessMsg] = useState('');
  const [errorMsg, setErrorMsg] = useState('');

  // Notification preferences — backed by backend
  const [notifSettings, setNotifSettings] = useState(() => {
    const initial = {};
    NOTIFICATION_EVENT_TYPES.forEach((t) => { initial[t.id] = true; });
    return initial;
  });
  const [notifLoading, setNotifLoading] = useState(false);
  const [notifSaving, setNotifSaving] = useState(false);
  const [notifMsg, setNotifMsg] = useState('');

  // Load preferences from backend
  useEffect(() => {
    if (!user?.user_id) return;
    setNotifLoading(true);
    api.getNotificationPreferences(user.user_id)
      .then(({ data }) => {
        if (Array.isArray(data) && data.length > 0) {
          const merged = {};
          NOTIFICATION_EVENT_TYPES.forEach((t) => { merged[t.id] = true; });
          data.forEach((p) => { if (p.type in merged) merged[p.type] = p.enabled; });
          setNotifSettings(merged);
        }
      })
      .catch(() => {})
      .finally(() => setNotifLoading(false));
  }, [user?.user_id]);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setSuccessMsg('');
    setErrorMsg('');

    if (newPassword !== confirmPassword) {
      setErrorMsg('New passwords do not match.');
      return;
    }

    if (newPassword.length < 6) {
      setErrorMsg('New Password must be at least 6 characters.');
      return;
    }

    setLoading(true);
    try {
      await api.changePassword({
        user_id: user.user_id,
        current_password: currentPassword,
        new_password: newPassword
      });
      setSuccessMsg('Password updated successfully!');
      setCurrentPassword('');
      setNewPassword('');
      setConfirmPassword('');
    } catch (err) {
      setErrorMsg(err.response?.data?.detail || 'Failed to update password. Please check your current password.');
    }
    setLoading(false);
  };

  const toggleNotif = (key) => {
    setNotifSettings(prev => ({ ...prev, [key]: !prev[key] }));
  };

  const saveNotifPreferences = async () => {
    setNotifSaving(true);
    setNotifMsg('');
    try {
      const preferences = NOTIFICATION_EVENT_TYPES.map((t) => ({
        type: t.id,
        enabled: !!notifSettings[t.id],
      }));
      await api.saveNotificationPreferences(user.user_id, preferences);
      setNotifMsg('Preferences saved.');
    } catch {
      setNotifMsg('Failed to save preferences.');
    }
    setNotifSaving(false);
  };

  const renderSecurity = () => (
    <SlideUp key="security">
      <Card className="overflow-visible">
        <CardHeader 
          icon={Shield} 
          title="Account Security" 
          subtitle="Update your password and secure your account"
        />
        <CardBody className="p-8">
          <form onSubmit={handleSubmit} className="space-y-8">
            <div className="relative">
              <Input
                label="Current Password"
                type={showPasswords ? "text" : "password"}
                placeholder="••••••••"
                value={currentPassword}
                onChange={(e) => setCurrentPassword(e.target.value)}
                required
                className="bg-neutral-50/50"
              />
              <button
                type="button"
                onClick={() => setShowPasswords(!showPasswords)}
                className="absolute right-3 top-[38px] text-neutral-400 hover:text-neutral-600 transition-colors"
              >
                {showPasswords ? <EyeOff size={18} /> : <Eye size={18} />}
              </button>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              <Input
                label="New Password"
                type={showPasswords ? "text" : "password"}
                placeholder="••••••••"
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                required
                className="bg-neutral-50/50"
              />
              <Input
                label="Confirm Password"
                type={showPasswords ? "text" : "password"}
                placeholder="••••••••"
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                required
                className="bg-neutral-50/50"
              />
            </div>
            
            <AnimatePresence mode="wait">
              {errorMsg && (
                <motion.div 
                  initial={{ opacity: 0, height: 0 }}
                  animate={{ opacity: 1, height: 'auto' }}
                  exit={{ opacity: 0, height: 0 }}
                  className="flex items-center gap-2 p-3 bg-error/5 text-error rounded-xl text-sm font-medium border border-error/10"
                >
                  <AlertCircle size={16} />
                  {errorMsg}
                </motion.div>
              )}
              {successMsg && (
                <motion.div 
                  initial={{ opacity: 0, height: 0 }}
                  animate={{ opacity: 1, height: 'auto' }}
                  exit={{ opacity: 0, height: 0 }}
                  className="flex items-center gap-2 p-3 bg-success/5 text-success rounded-xl text-sm font-medium border border-success/10"
                >
                  <CheckCircle2 size={16} />
                  {successMsg}
                </motion.div>
              )}
            </AnimatePresence>
            
            <div className="flex flex-col md:flex-row items-center justify-between gap-4 pt-4 border-t border-neutral-100">
              <p className="text-xs text-neutral-500 italic text-center md:text-left">
                Use at least 6 characters. We recommend a mix of letters and numbers.
              </p>
              <Button 
                type="submit" 
                variant="primary" 
                disabled={loading}
                className="w-full md:w-auto px-8 shadow-lg shadow-primary-200"
              >
                {loading ? 'Processing...' : 'Update Password'}
              </Button>
            </div>
          </form>
        </CardBody>
      </Card>
    </SlideUp>
  );

  const renderNotifications = () => (
    <SlideUp key="notifications">
      <Card>
        <CardHeader 
          icon={Bell} 
          title="Notification Preferences" 
          subtitle="Control which notifications you receive"
        />
        <CardBody className="p-8">
          <div className="space-y-6">
            <div className="space-y-4">
              <h4 className="text-sm font-bold text-neutral-900 uppercase tracking-wider">Desktop Notifications</h4>
              <div className="flex items-center justify-between p-4 bg-neutral-50/50 rounded-2xl border border-neutral-100">
                <div className="flex items-center gap-4">
                  <div className="p-2.5 bg-white rounded-xl shadow-sm text-neutral-500">
                    <Monitor size={20} />
                  </div>
                  <div>
                    <p className="text-sm font-bold text-neutral-900">Desktop Alerts</p>
                    <p className="text-xs text-neutral-500">Native OS notifications on your desktop</p>
                  </div>
                </div>
                <div className="w-12 h-6 rounded-full bg-primary-500 relative">
                  <div className="absolute top-1 left-[26px] w-4 h-4 bg-white rounded-full shadow-sm" />
                </div>
              </div>
            </div>

            <div className="pt-6 border-t border-neutral-100">
              <h4 className="text-sm font-bold text-neutral-900 uppercase tracking-wider mb-4">Event Types</h4>
              {notifLoading ? (
                <p className="text-sm text-neutral-500">Loading preferences...</p>
              ) : (
                <div className="space-y-3">
                  {NOTIFICATION_EVENT_TYPES.map((item) => (
                    <label key={item.id} className="flex items-center justify-between gap-3 cursor-pointer group p-2 rounded-lg hover:bg-neutral-50 transition-colors">
                      <div className="flex items-center gap-3">
                        <div className="relative flex items-center">
                          <input 
                            type="checkbox" 
                            checked={!!notifSettings[item.id]} 
                            onChange={() => toggleNotif(item.id)}
                            className="peer sr-only"
                          />
                          <div className="w-5 h-5 border-2 border-neutral-300 rounded-md peer-checked:border-primary-500 peer-checked:bg-primary-500 transition-all" />
                          <CheckCircle2 size={12} className="absolute left-1 text-white opacity-0 peer-checked:opacity-100 transition-opacity" />
                        </div>
                        <div>
                          <span className="text-sm text-neutral-700 group-hover:text-neutral-900 transition-colors">{item.label}</span>
                          <p className="text-xs text-neutral-400">{item.desc}</p>
                        </div>
                      </div>
                    </label>
                  ))}
                </div>
              )}
            </div>

            <div className="pt-6 flex items-center gap-3">
              <Button variant="primary" className="w-full md:w-auto" onClick={saveNotifPreferences} disabled={notifSaving}>
                {notifSaving ? 'Saving...' : 'Save Preferences'}
              </Button>
              {notifMsg && <span className="text-sm text-neutral-500">{notifMsg}</span>}
            </div>
          </div>
        </CardBody>
      </Card>
    </SlideUp>
  );

  return (
    <div className="max-w-4xl mx-auto space-y-8">
      {/* Profile Header */}
      <SlideUp>
        <div className="bg-white rounded-3xl p-8 border border-neutral-100 shadow-sm relative overflow-hidden">
          {/* Background Decoration */}
          <div className="absolute top-0 right-0 w-64 h-64 bg-primary-50 rounded-full -mr-32 -mt-32 opacity-50 blur-3xl" />
          
          <div className="relative flex flex-col md:flex-row items-center gap-8">
            <div className="relative">
              <Avatar 
                name={user?.name} 
                size="xl" 
                className="w-24 h-24 text-3xl shadow-lg border-4 border-white ring-1 ring-neutral-100" 
              />
              <div className="absolute bottom-1 right-1 bg-success-500 border-4 border-white w-5 h-5 rounded-full" />
            </div>
            
            <div className="text-center md:text-left flex-1">
              <h2 className="text-3xl font-bold text-neutral-900">{user?.name}</h2>
              <div className="flex flex-wrap items-center justify-center md:justify-start gap-4 mt-2">
                <span className="inline-flex items-center gap-1.5 px-3 py-1 bg-primary-50 text-primary-600 rounded-full text-xs font-bold uppercase tracking-wider">
                  <Shield size={14} />
                  {user?.role || 'Employee'}
                </span>
                <span className="text-neutral-500 text-sm font-medium flex items-center gap-1.5">
                  <UserCircle size={16} />
                  ID: #{user?.user_id?.toString().padStart(5, '0')}
                </span>
              </div>
            </div>
          </div>
        </div>
      </SlideUp>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
        {/* Left Column: Navigation */}
        <div className="lg:col-span-1">
          <nav className="space-y-2">
            {[
              { id: 'security', label: 'Security & Privacy', icon: Lock },
              { id: 'notifications', label: 'Notifications', icon: Bell },
            ].map((item) => (
              <button
                key={item.id}
                onClick={() => setActiveSection(item.id)}
                className={`w-full flex items-center gap-3 px-4 py-3 rounded-xl transition-all border ${
                  activeSection === item.id 
                    ? 'bg-white shadow-sm border-neutral-100 text-primary-600 font-bold' 
                    : 'text-neutral-500 border-transparent hover:bg-neutral-100'
                }`}
              >
                <item.icon size={18} />
                <span className="text-sm">{item.label}</span>
              </button>
            ))}
          </nav>
        </div>

        {/* Right Column: Dynamic Content */}
        <div className="lg:col-span-2">
          <AnimatePresence mode="wait">
            {activeSection === 'security' ? renderSecurity() : renderNotifications()}
          </AnimatePresence>
        </div>
      </div>
    </div>
  );
};

export default SettingsTab;
