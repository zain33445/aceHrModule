import React from 'react';
import { AlertCircle } from 'lucide-react';

export const Input = React.forwardRef(({
  label,
  error,
  icon: Icon,
  size = 'md',
  disabled = false,
  type = 'text',
  className = '',
  ...props
}, ref) => {
  const sizes = {
    sm: 'px-3 py-2 text-sm',
    md: 'px-4 py-3 text-base',
    lg: 'px-4 py-4 text-lg',
  };

  const baseStyles = 'w-full border border-neutral-300 rounded-md bg-white text-neutral-900 placeholder-neutral-500 transition-all duration-200 focus:outline-none focus:ring-2 focus:ring-primary-100 focus:border-primary-500';
  const errorStyles = error ? 'border-error ring-2 ring-error/20 focus:ring-error/20 focus:border-error' : '';
  const disabledStyles = disabled ? 'bg-neutral-100 text-neutral-500 cursor-not-allowed' : '';

  return (
    <div className="w-full">
      {label && (
        <label className="block text-sm font-medium text-neutral-700 mb-2">
          {label}
        </label>
      )}
      <div className="relative">
        {Icon && (
          <div className="absolute left-3 top-1/2 transform -translate-y-1/2 text-neutral-500 pointer-events-none">
            <Icon size={20} />
          </div>
        )}
        <input
          ref={ref}
          type={type}
          disabled={disabled}
          className={`${baseStyles} ${errorStyles} ${disabledStyles} ${Icon ? 'pl-10' : ''} ${className}`}
          {...props}
        />
      </div>
      {error && (
        <div className="flex items-center gap-1 mt-2 text-error text-sm">
          <AlertCircle size={14} />
          {error}
        </div>
      )}
    </div>
  );
});

Input.displayName = 'Input';

export default Input;
