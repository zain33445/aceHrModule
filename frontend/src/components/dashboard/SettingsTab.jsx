import React, { useState } from 'react';
import { Card, CardHeader, CardBody } from '../common/Card';
import { Input } from '../common/Input';
import { Button } from '../common/Button';
import { Key } from 'lucide-react';
import api from '../../services/api';
import { motion } from 'framer-motion';

export const SettingsTab = ({ user }) => {
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [successMsg, setSuccessMsg] = useState('');
  const [errorMsg, setErrorMsg] = useState('');

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
      setSuccessMsg('Password changed successfully!');
      setCurrentPassword('');
      setNewPassword('');
      setConfirmPassword('');
    } catch (err) {
      setErrorMsg(err.response?.data?.detail || 'Failed to change password. Please check your current password.');
    }
    setLoading(false);
  };

  return (
    <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} className=" mx-auto mt-8">
      <Card>
        <CardHeader icon={Key} title="Change Password" />
        <CardBody>
          <form onSubmit={handleSubmit} className="space-y-6">
            <Input
              label="Current Password"
              type="password"
              placeholder="Enter current password..."
              value={currentPassword}
              onChange={(e) => setCurrentPassword(e.target.value)}
              required
            />
            <div className="pt-2"></div>
            <Input
              label="New Password"
              type="password"
              placeholder="Enter new password..."
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              required
            />
            <Input
              label="Confirm New Password"
              type="password"
              placeholder="Confirm new password..."
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              required
            />
            
            {errorMsg && <p className="text-red-500 text-sm font-medium">{errorMsg}</p>}
            {successMsg && <p className="text-emerald-500 text-sm font-medium">{successMsg}</p>}
            
            <div className="flex justify-end pt-4">
              <Button type="submit" variant="primary" disabled={loading}>
                {loading ? 'Updating...' : 'Update Password'}
              </Button>
            </div>
          </form>
        </CardBody>
      </Card>
    </motion.div>
  );
};
