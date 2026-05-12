import React, { useState } from 'react';
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
  Mail,
  Smartphone,
  Monitor
} from 'lucide-react';
import { Card, CardHeader, CardBody } from '../common/Card';
import { Input } from '../common/Input';
import { Button } from '../common/Button';
import Avatar from '../common/Avatar';
import api from '../../services/api';
import { SlideUp } from '../animations';

export const SettingsTab = ({ user }) => {
  const [activeSection, setActiveSection] = useState('security');
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [showPasswords, setShowPasswords] = useState(false);
  const [loading, setLoading] = useState(false);
  const [successMsg, setSuccessMsg] = useState('');
  const [errorMsg, setErrorMsg] = useState('');

  // Notification states (mock)
  const [notifSettings, setNotifSettings] = useState({
    email: true,
    push: true,
    desktop: false,
    disputes: true,
    attendance: true
  });

  const handleSubmit = async (e) => {
    e.preventDefault();
    setSuccessMsg('');
    setErrorMsg('');

    if (newPassword !== confirmPassword) {
      setErrorMsg('New passwords do not match.');
      return;
    }

    if (newPassword.length < 6) {
      setErrorMsg('New password must be at least 6 characters.');
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
          subtitle="Choose how you want to be notified"
        />
        <CardBody className="p-8">
          <div className="space-y-6">
            <div className="space-y-4">
              <h4 className="text-sm font-bold text-neutral-900 uppercase tracking-wider">Channels</h4>
              {[
                { id: 'email', label: 'Email Notifications', icon: Mail, desc: 'Receive updates via your registered email' },
                { id: 'push', label: 'Push Notifications', icon: Smartphone, desc: 'Receive alerts on your mobile device' },
                { id: 'desktop', label: 'Desktop Alerts', icon: Monitor, desc: 'Browser notifications when you are active' },
              ].map((item) => (
                <div key={item.id} className="flex items-center justify-between p-4 bg-neutral-50/50 rounded-2xl border border-neutral-100">
                  <div className="flex items-center gap-4">
                    <div className="p-2.5 bg-white rounded-xl shadow-sm text-neutral-500">
                      <item.icon size={20} />
                    </div>
                    <div>
                      <p className="text-sm font-bold text-neutral-900">{item.label}</p>
                      <p className="text-xs text-neutral-500">{item.desc}</p>
                    </div>
                  </div>
                  <button 
                    onClick={() => toggleNotif(item.id)}
                    className={`w-12 h-6 rounded-full transition-colors relative ${notifSettings[item.id] ? 'bg-primary-500' : 'bg-neutral-300'}`}
                  >
                    <motion.div 
                      animate={{ x: notifSettings[item.id] ? 26 : 4 }}
                      className="absolute top-1 w-4 h-4 bg-white rounded-full shadow-sm"
                    />
                  </button>
                </div>
              ))}
            </div>

            <div className="pt-6 border-t border-neutral-100">
              <h4 className="text-sm font-bold text-neutral-900 uppercase tracking-wider mb-4">Event Types</h4>
              <div className="space-y-3">
                {[
                  { id: 'disputes', label: 'Dispute Status Updates' },
                  { id: 'attendance', label: 'Attendance & Leave Alerts' },
                ].map((item) => (
                  <label key={item.id} className="flex items-center gap-3 cursor-pointer group">
                    <div className="relative flex items-center">
                      <input 
                        type="checkbox" 
                        checked={notifSettings[item.id]} 
                        onChange={() => toggleNotif(item.id)}
                        className="peer sr-only"
                      />
                      <div className="w-5 h-5 border-2 border-neutral-300 rounded-md peer-checked:border-primary-500 peer-checked:bg-primary-500 transition-all" />
                      <CheckCircle2 size={12} className="absolute left-1 text-white opacity-0 peer-checked:opacity-100 transition-opacity" />
                    </div>
                    <span className="text-sm text-neutral-700 group-hover:text-neutral-900 transition-colors">{item.label}</span>
                  </label>
                ))}
              </div>
            </div>

            <div className="pt-6">
              <Button variant="primary" className="w-full md:w-auto">
                Save Preferences
              </Button>
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
