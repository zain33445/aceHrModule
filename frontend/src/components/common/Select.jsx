import React from 'react';
import { ChevronDown } from 'lucide-react';

export const Select = React.forwardRef(({
  label,
  options = [],
  error,
  disabled = false,
  placeholder = 'Select an option...',
  value,
  onChange,
  className = '',
  ...props
}, ref) => {
  const baseStyles = 'w-full px-4 py-3 border border-neutral-300 rounded-md bg-white text-neutral-900 appearance-none transition-all duration-200 focus:outline-none focus:ring-2 focus:ring-primary-100 focus:border-primary-500';
  const errorStyles = error ? 'border-error ring-2 ring-error/20' : '';
  const disabledStyles = disabled ? 'bg-neutral-100 text-neutral-500 cursor-not-allowed' : '';

  return (
    <div className="w-full">
      {label && (
        <label className="block text-sm font-medium text-neutral-700 mb-2">
          {label}
        </label>
      )}
      <div className="relative">
        <select
          ref={ref}
          disabled={disabled}
          value={value}
          onChange={(e) => onChange?.(e.target.value)}
          className={`${baseStyles} ${errorStyles} ${disabledStyles} pr-10 ${className}`}
          {...props}
        >
          <option value="">{placeholder}</option>
          {options.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
        <ChevronDown
          size={20}
          className="absolute right-3 top-1/2 transform -translate-y-1/2 text-neutral-500 pointer-events-none"
        />
      </div>
      {error && (
        <div className="mt-2 text-error text-sm">{error}</div>
      )}
    </div>
  );
});

Select.displayName = 'Select';

export default Select;
