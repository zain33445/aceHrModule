import React from 'react';
import { AlertCircle } from 'lucide-react';

export const Textarea = React.forwardRef(({
  label,
  error,
  disabled = false,
  className = '',
  rows = 4,
  ...props
}, ref) => {
  const baseStyles = 'w-full px-4 py-3 border border-neutral-300 rounded-md bg-white text-neutral-900 placeholder-neutral-500 transition-all duration-200 focus:outline-none focus:ring-2 focus:ring-primary-100 focus:border-primary-500 min-h-[100px] resize-y';
  const errorStyles = error ? 'border-error ring-2 ring-error/20 focus:ring-error/20 focus:border-error' : '';
  const disabledStyles = disabled ? 'bg-neutral-100 text-neutral-500 cursor-not-allowed' : '';

  return (
    <div className="w-full">
      {label && (
        <label className="block text-sm font-medium text-neutral-700 mb-2">
          {label}
        </label>
      )}
      <textarea
        ref={ref}
        disabled={disabled}
        rows={rows}
        className={`${baseStyles} ${errorStyles} ${disabledStyles} ${className}`}
        {...props}
      />
      {error && (
        <div className="flex items-center gap-1 mt-2 text-error text-sm">
          <AlertCircle size={14} />
          {error}
        </div>
      )}
    </div>
  );
});

Textarea.displayName = 'Textarea';

export default Textarea;
