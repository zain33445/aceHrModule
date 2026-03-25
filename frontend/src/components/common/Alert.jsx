import React from 'react';
import { AlertCircle, CheckCircle, AlertTriangle, Info, X } from 'lucide-react';

export const Alert = ({
  variant = 'info',
  title,
  message,
  onClose,
  icon,
  className = '',
}) => {
  const variants = {
    info: {
      bg: 'bg-info/10',
      border: 'border-info/30',
      text: 'text-info',
      icon: Info,
    },
    success: {
      bg: 'bg-success/10',
      border: 'border-success/30',
      text: 'text-success',
      icon: CheckCircle,
    },
    warning: {
      bg: 'bg-warning/10',
      border: 'border-warning/30',
      text: 'text-warning',
      icon: AlertTriangle,
    },
    error: {
      bg: 'bg-error/10',
      border: 'border-error/30',
      text: 'text-error',
      icon: AlertCircle,
    },
  };

  const config = variants[variant];
  const IconComponent = icon || config.icon;

  return (
    <div
      className={`flex gap-3 p-4 rounded-lg border ${config.bg} ${config.border} ${className}`}
    >
      <IconComponent size={20} className={`flex-shrink-0 ${config.text}`} />
      <div className="flex-1">
        {title && (
          <h4 className={`font-semibold text-sm ${config.text}`}>{title}</h4>
        )}
        {message && (
          <p className="text-sm text-neutral-700 mt-1">{message}</p>
        )}
      </div>
      {onClose && (
        <button
          onClick={onClose}
          className={`flex-shrink-0 ${config.text} hover:opacity-70`}
        >
          <X size={18} />
        </button>
      )}
    </div>
  );
};

export default Alert;
