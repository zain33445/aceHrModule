import React, { useEffect, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { X, CheckCircle, AlertCircle, AlertTriangle, Info } from 'lucide-react';

export const Toast = ({
  message,
  variant = 'info',
  onClose,
  duration = 4000,
  action,
}) => {
  const variants = {
    success: {
      bg: 'bg-success/10',
      border: 'border-success/30',
      text: 'text-success',
      icon: CheckCircle,
    },
    error: {
      bg: 'bg-error/10',
      border: 'border-error/30',
      text: 'text-error',
      icon: AlertCircle,
    },
    warning: {
      bg: 'bg-warning/10',
      border: 'border-warning/30',
      text: 'text-warning',
      icon: AlertTriangle,
    },
    info: {
      bg: 'bg-info/10',
      border: 'border-info/30',
      text: 'text-info',
      icon: Info,
    },
  };

  const config = variants[variant];
  const Icon = config.icon;

  useEffect(() => {
    if (duration) {
      const timer = setTimeout(onClose, duration);
      return () => clearTimeout(timer);
    }
  }, [duration, onClose]);

  return (
    <motion.div
      initial={{ opacity: 0, y: -20, scale: 0.95 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, y: -20, scale: 0.95 }}
      className={`flex items-center gap-3 px-4 py-3 rounded-lg border ${config.bg} ${config.border}`}
    >
      <Icon size={20} className={`flex-shrink-0 ${config.text}`} />
      <p className="flex-1 text-sm font-medium text-neutral-900">{message}</p>
      {action && (
        <button
          onClick={action.onClick}
          className="text-sm font-medium text-primary-600 hover:text-primary-700"
        >
          {action.label}
        </button>
      )}
      <button
        onClick={onClose}
        className="flex-shrink-0 hover:opacity-70 transition-opacity"
      >
        <X size={18} />
      </button>
    </motion.div>
  );
};

// Toast Container Component
export const ToastContainer = ({ toasts = [] }) => {
  return (
    <div className="fixed top-20 right-4 z-50 space-y-2 max-w-sm pointer-events-auto">
      <AnimatePresence>
        {toasts.map((toast) => (
          <Toast key={toast.id} {...toast} />
        ))}
      </AnimatePresence>
    </div>
  );
};

export default Toast;
