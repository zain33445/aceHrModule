import React, { useState } from 'react';
import { motion } from 'framer-motion';
import { Lock, LogIn, AlertCircle, Hammer } from 'lucide-react';
import { Button } from './common/Button';
import { Input } from './common/Input';
import api from '../services/api';

function LoginNew({ onLoginSuccess }) {
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const handleSubmit = async (e) => {
    e.preventDefault();
    setLoading(true);
    setError('');
    try {
      const res = await api.login(password);
      onLoginSuccess(res.data);
    } catch (err) {
      setError(err.response?.data?.detail || 'Invalid access key');
    }
    setLoading(false);
  };

  return (
    <div className="min-h-screen relative flex items-center justify-center bg-gradient-to-br from-neutral-50 to-neutral-100 overflow-hidden p-4">

      {/* Diagonal Lines Only */}
      <div className="absolute inset-0 z-0 pointer-events-none opacity-20">
        <svg className="w-full h-full" viewBox="0 0 1200 800" preserveAspectRatio="none">
          <defs>
            <pattern id="diagonal-lines" x="0" y="0" width="40" height="40" patternUnits="userSpaceOnUse">
              <line x1="0" y1="0" x2="40" y2="40" stroke="#F97316" strokeWidth="1" />
            </pattern>
          </defs>
          <rect width="1200" height="800" fill="url(#diagonal-lines)" />
        </svg>
      </div>

      {/* Login Card */}
      <motion.div
        initial={{ opacity: 0, scale: 0.95 }}
        animate={{ opacity: 1, scale: 1 }}
        transition={{ duration: 0.4 }}
        className="relative z-10 w-full"
      >
        <div className="bg-white rounded-2xl shadow-2xl overflow-hidden border border-neutral-200">

          {/* Header */}
          <div className="bg-gradient-to-r from-primary-500 to-primary-600 px-8 pt-12 pb-10 text-center">
            <motion.div
              initial={{ scale: 0 }}
              animate={{ scale: 1 }}
              transition={{ delay: 0.2, type: 'spring' }}
              className="w-16 h-16 bg-white/20 rounded-xl flex items-center justify-center mx-auto mb-4 backdrop-blur-sm"
            >
              <Lock size={32} className="text-white" />
            </motion.div>

            <motion.h1
              initial={{ opacity: 0, y: -10 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.3 }}
              className="text-3xl font-bold text-white mb-1"
            >
              ACE HR System
            </motion.h1>

            <motion.p
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={{ delay: 0.4 }}
              className="text-primary-100 text-sm font-medium"
            >
              Building Better Teams
            </motion.p>
          </div>

          {/* Form */}
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.5 }}
            className="px-8 py-10"
          >
            <form onSubmit={handleSubmit} className="space-y-6">
              <Input
                label="Access Key"
                type="password"
                placeholder="Enter your password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                icon={Lock}
                error={error || undefined}
                autoFocus
              />

              {error && (
                <motion.div
                  initial={{ opacity: 0, y: -10 }}
                  animate={{ opacity: 1, y: 0 }}
                  className="p-3 rounded-lg bg-error/10 border border-error/30 flex items-center gap-2 text-error text-sm"
                >
                  <AlertCircle size={16} />
                  <span>{error}</span>
                </motion.div>
              )}

              <Button
                type="submit"
                variant="primary"
                size="lg"
                isLoading={loading}
                className="w-full flex items-center justify-center gap-2"
              >
                <LogIn size={18} />
                Sign In
              </Button>
            </form>

            {/* Footer */}
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={{ delay: 0.6 }}
              className="mt-8 pt-6 border-t border-neutral-200 text-center text-xs text-neutral-600"
            >
              <div className="flex items-center justify-center gap-1 mb-2">
                <Hammer size={14} className="text-primary-500" />
                <span>Construction Company HR Portal</span>
              </div>
              <p>Secure access • Built for teams • 2026</p>
            </motion.div>
          </motion.div>
        </div>

        {/* Demo Hint */}
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ delay: 0.8 }}
          className="mt-6 text-center text-xs text-neutral-600"
        >
          <p>For demo: try any password</p>
        </motion.div>
      </motion.div>
    </div>
  );
}

export default LoginNew;