import React from 'react';
import { X } from 'lucide-react';

export const Badge = ({
  children,
  variant = 'default',
  size = 'md',
  onDismiss,
  className = '',
  ...props
}) => {
  const variants = {
    default: 'bg-neutral-100 text-neutral-800',
    success: 'bg-success/10 text-success',
    warning: 'bg-warning/10 text-warning',
    error: 'bg-error/10 text-error',
    info: 'bg-info/10 text-info',
    primary: 'bg-primary-100 text-primary-700',
  };

  const sizes = {
    sm: 'px-2 py-1 text-xs',
    md: 'px-3 py-1 text-sm',
    lg: 'px-4 py-2 text-base',
  };

  return (
    <div
      className={`inline-flex items-center gap-2 rounded-full font-medium ${variants[variant]} ${sizes[size]} ${className}`}
      {...props}
    >
      {children}
      {onDismiss && (
        <button
          onClick={onDismiss}
          className="ml-1 hover:opacity-70 transition-opacity"
          aria-label="Dismiss badge"
        >
          <X size={14} />
        </button>
      )}
    </div>
  );
};

export default Badge;
